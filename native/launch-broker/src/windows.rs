use crate::VerifiedHelper;
use std::ffi::OsStr;
use std::fs::File;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, GENERIC_READ, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileAttributeTagInfo, FileBasicInfo, FileIdInfo, FileStandardInfo,
    GetFileInformationByHandleEx, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, FILE_STANDARD_INFO, OPEN_EXISTING, SYNCHRONIZE,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NativeIdentity {
    volume_serial: u64,
    file_id: [u8; 16],
    links: u32,
    size: i64,
    write_time: i64,
    pub regular: bool,
}

pub(crate) struct RetainedContext {
    _ancestors: Vec<File>,
}

pub(crate) fn open_helper_nofollow(path: &Path) -> Result<(File, RetainedContext), String> {
    if !path.is_absolute() {
        return Err("filesystem helper path is not absolute".to_owned());
    }
    let mut ancestor_paths: Vec<_> = path
        .ancestors()
        .skip(1)
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect();
    if ancestor_paths.len() < 3 {
        return Err("filesystem helper has no tools ancestors".to_owned());
    }
    ancestor_paths.reverse();
    let mut ancestors = Vec::with_capacity(ancestor_paths.len());
    for ancestor in ancestor_paths {
        let directory = open_path(
            &ancestor,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        )?;
        let tag: FILE_ATTRIBUTE_TAG_INFO =
            query(directory.as_raw_handle() as HANDLE, FileAttributeTagInfo)?;
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(
                "filesystem helper ancestor is a reparse point or not a directory".to_owned(),
            );
        }
        ancestors.push(directory);
    }
    let helper = open_path(
        path,
        GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_FLAG_OPEN_REPARSE_POINT,
    )?;
    let tag: FILE_ATTRIBUTE_TAG_INFO =
        query(helper.as_raw_handle() as HANDLE, FileAttributeTagInfo)?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return Err("filesystem helper is a reparse point or directory".to_owned());
    }
    Ok((
        helper,
        RetainedContext {
            _ancestors: ancestors,
        },
    ))
}

fn open_path(path: &Path, access: u32, flags: u32) -> Result<File, String> {
    let wide = wide_null(path.as_os_str());
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            access,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "filesystem helper path cannot be retained without write/delete sharing: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { File::from_raw_handle(handle as _) })
}

pub(crate) fn identity(file: &File) -> Result<NativeIdentity, String> {
    let handle = file.as_raw_handle() as HANDLE;
    let id: FILE_ID_INFO = query(handle, FileIdInfo)?;
    let standard: FILE_STANDARD_INFO = query(handle, FileStandardInfo)?;
    let basic: FILE_BASIC_INFO = query(handle, FileBasicInfo)?;
    let tag: FILE_ATTRIBUTE_TAG_INFO = query(handle, FileAttributeTagInfo)?;
    Ok(NativeIdentity {
        volume_serial: id.VolumeSerialNumber,
        file_id: id.FileId.Identifier,
        links: standard.NumberOfLinks,
        size: standard.EndOfFile,
        write_time: basic.LastWriteTime,
        regular: tag.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)
            == 0,
    })
}

fn query<T>(handle: HANDLE, class: i32) -> Result<T, String> {
    let mut value = MaybeUninit::<T>::zeroed();
    let success = unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            value.as_mut_ptr().cast(),
            size_of::<T>() as u32,
        )
    };
    if success == 0 {
        return Err(format!(
            "filesystem helper native identity query failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { value.assume_init() })
}

pub(crate) fn launch(verified: VerifiedHelper) -> Result<i32, String> {
    let _retained_context = verified.context;
    let _verified_sha256 = verified.sha256;
    let standard_handles = duplicate_standard_handles()?;
    let inherited = [
        standard_handles.0.raw(),
        standard_handles.1.raw(),
        standard_handles.2.raw(),
    ];
    let command_text = format!("\"{}\" --stdio", verified.path.display());
    let child = create_suspended_process(&verified.path, OsStr::new(&command_text), &inherited)?;
    let job = create_kill_on_close_job()?;
    if unsafe { AssignProcessToJobObject(job.raw(), child.process()) } == 0 {
        return Err(child.fail("Windows helper could not be assigned to kill-on-close job"));
    }
    if identity(&verified.file)? != verified.identity {
        return Err(child.fail("filesystem helper identity changed before resume"));
    }
    if unsafe { ResumeThread(child.thread()) } == u32::MAX {
        return Err(child.fail("Windows helper primary thread could not be resumed"));
    }
    child.wait()
}

fn create_suspended_process(
    application_path: &Path,
    command_line: &OsStr,
    inherited: &[HANDLE; 3],
) -> Result<SuspendedChild, String> {
    let mut attribute_bytes = 0_usize;
    unsafe {
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attribute_bytes);
    }
    if attribute_bytes == 0 {
        return Err("Windows process attribute list size is unavailable".to_owned());
    }
    let mut attribute_storage = vec![0_usize; attribute_bytes.div_ceil(size_of::<usize>())];
    let attribute_list = attribute_storage.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) } == 0
    {
        return Err(format!(
            "Windows process attribute list initialization failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let attributes = AttributeList(attribute_list);
    if unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_ptr().cast(),
            size_of::<[HANDLE; 3]>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(format!(
            "Windows inherited-handle allowlist creation failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let application = wide_null(application_path.as_os_str());
    let mut command = wide_null(command_line);
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes.0;
    let mut process = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
            std::ptr::null(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if created == 0 {
        return Err(format!(
            "Windows suspended helper creation failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(SuspendedChild::new(process))
}

fn duplicate_standard_handles() -> Result<(OwnedHandle, OwnedHandle, OwnedHandle), String> {
    Ok((
        duplicate_standard(STD_INPUT_HANDLE)?,
        duplicate_standard(STD_OUTPUT_HANDLE)?,
        duplicate_standard(STD_ERROR_HANDLE)?,
    ))
}

fn duplicate_standard(kind: u32) -> Result<OwnedHandle, String> {
    let source = unsafe { GetStdHandle(kind) };
    if source.is_null() || source == INVALID_HANDLE_VALUE {
        return Err("Windows broker standard handle is unavailable".to_owned());
    }
    let process = unsafe { GetCurrentProcess() };
    let mut duplicate = std::ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            process,
            source,
            process,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(format!(
            "Windows broker standard handle cannot be duplicated: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(OwnedHandle(duplicate))
}

fn create_kill_on_close_job() -> Result<OwnedHandle, String> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(format!(
            "Windows kill-on-close job cannot be created: {}",
            std::io::Error::last_os_error()
        ));
    }
    let job = OwnedHandle(handle);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(format!(
            "Windows kill-on-close job cannot be configured: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(job)
}

struct AttributeList(*mut std::ffi::c_void);

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct SuspendedChild {
    process: OwnedHandle,
    thread: OwnedHandle,
    resumed: bool,
}

impl SuspendedChild {
    fn new(info: PROCESS_INFORMATION) -> Self {
        Self {
            process: OwnedHandle(info.hProcess),
            thread: OwnedHandle(info.hThread),
            resumed: false,
        }
    }

    fn process(&self) -> HANDLE {
        self.process.raw()
    }

    fn thread(&self) -> HANDLE {
        self.thread.raw()
    }

    fn fail(mut self, message: &str) -> String {
        unsafe { TerminateProcess(self.process(), 1) };
        unsafe { WaitForSingleObject(self.process(), INFINITE) };
        self.resumed = true;
        format!("{message}: {}", std::io::Error::last_os_error())
    }

    fn wait(mut self) -> Result<i32, String> {
        self.resumed = true;
        if unsafe { WaitForSingleObject(self.process(), INFINITE) } != WAIT_OBJECT_0 {
            return Err("Windows helper wait failed".to_owned());
        }
        let mut exit_code = 0_u32;
        if unsafe { GetExitCodeProcess(self.process(), &mut exit_code) } == 0 {
            return Err(format!(
                "Windows helper exit code is unavailable: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(exit_code as i32)
    }
}

impl Drop for SuspendedChild {
    fn drop(&mut self) {
        if !self.resumed {
            unsafe { TerminateProcess(self.process(), 1) };
            unsafe { WaitForSingleObject(self.process(), INFINITE) };
        }
    }
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, OpenProcess, SetEvent, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const AMBIENT_HANDLE_ENV: &str = "META_MOVER_BROKER_TEST_AMBIENT_HANDLE";
    const TREE_PID_FILE_ENV: &str = "META_MOVER_BROKER_TEST_TREE_PID_FILE";

    #[test]
    #[ignore]
    fn windows_ambient_handle_is_not_inherited_child() {
        let raw = std::env::var(AMBIENT_HANDLE_ENV)
            .unwrap()
            .parse::<usize>()
            .unwrap() as HANDLE;
        assert_eq!(unsafe { SetEvent(raw) }, 0);
    }

    #[test]
    #[ignore]
    fn windows_job_tree_child() {
        let command_interpreter = PathBuf::from(std::env::var_os("COMSPEC").unwrap());
        let mut child = Command::new(command_interpreter)
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        fs::write(
            std::env::var_os(TREE_PID_FILE_ENV).unwrap(),
            child.id().to_string(),
        )
        .unwrap();
        thread::sleep(Duration::from_secs(30));
        let _ = child.wait();
    }

    #[test]
    fn windows_process_handle_list_excludes_ambient_inheritable_handles() {
        let event = OwnedHandle(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) });
        assert!(!event.raw().is_null());
        let process = unsafe { GetCurrentProcess() };
        let mut inherited_event = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    process,
                    event.raw(),
                    process,
                    &mut inherited_event,
                    0,
                    1,
                    DUPLICATE_SAME_ACCESS,
                )
            },
            0
        );
        let inherited_event = OwnedHandle(inherited_event);
        std::env::set_var(
            AMBIENT_HANDLE_ENV,
            (inherited_event.raw() as usize).to_string(),
        );
        let executable = std::env::current_exe().unwrap();
        let command_text = format!(
            "\"{}\" --exact windows::tests::windows_ambient_handle_is_not_inherited_child --ignored --nocapture",
            executable.display()
        );
        let standard = duplicate_standard_handles().unwrap();
        let inherited = [standard.0.raw(), standard.1.raw(), standard.2.raw()];
        let child_result =
            create_suspended_process(&executable, OsStr::new(&command_text), &inherited);
        std::env::remove_var(AMBIENT_HANDLE_ENV);
        let child = child_result.unwrap();
        assert_ne!(unsafe { ResumeThread(child.thread()) }, u32::MAX);
        assert_eq!(child.wait().unwrap(), 0);
        assert_eq!(unsafe { WaitForSingleObject(event.raw(), 0) }, WAIT_TIMEOUT);
    }

    #[test]
    fn windows_kill_on_close_job_terminates_the_launched_process_tree() {
        let executable = std::env::current_exe().unwrap();
        let pid_file =
            std::env::temp_dir().join(format!("meta-mover-broker-tree-pid-{}", std::process::id()));
        std::env::set_var(TREE_PID_FILE_ENV, &pid_file);
        let command = format!(
            "\"{}\" --exact windows::tests::windows_job_tree_child --ignored --nocapture",
            executable.display()
        );
        let standard = duplicate_standard_handles().unwrap();
        let inherited = [standard.0.raw(), standard.1.raw(), standard.2.raw()];
        let mut child =
            create_suspended_process(&executable, OsStr::new(&command), &inherited).unwrap();
        std::env::remove_var(TREE_PID_FILE_ENV);
        let job = create_kill_on_close_job().unwrap();
        assert_ne!(
            unsafe { AssignProcessToJobObject(job.raw(), child.process()) },
            0
        );
        assert_ne!(unsafe { ResumeThread(child.thread()) }, u32::MAX);
        child.resumed = true;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !pid_file.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        let descendant_pid: u32 = fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        let descendant = OwnedHandle(unsafe {
            OpenProcess(
                SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                descendant_pid,
            )
        });
        assert!(!descendant.raw().is_null());
        drop(job);
        let wait = unsafe { WaitForSingleObject(child.process(), 10_000) };
        assert_ne!(wait, WAIT_FAILED);
        assert_eq!(wait, WAIT_OBJECT_0);
        let mut exit_code = 259_u32;
        assert_ne!(
            unsafe { GetExitCodeProcess(child.process(), &mut exit_code) },
            0
        );
        assert_ne!(exit_code, 259);
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.raw(), 10_000) },
            WAIT_OBJECT_0
        );
        fs::remove_file(pid_file).unwrap();
    }

    #[test]
    fn windows_pre_resume_failure_terminates_the_exact_suspended_child() {
        let command_interpreter = PathBuf::from(std::env::var_os("COMSPEC").unwrap());
        let command = format!(
            "\"{}\" /d /c ping -n 30 127.0.0.1 >nul",
            command_interpreter.display()
        );
        let standard = duplicate_standard_handles().unwrap();
        let inherited = [standard.0.raw(), standard.1.raw(), standard.2.raw()];
        let child =
            create_suspended_process(&command_interpreter, OsStr::new(&command), &inherited)
                .unwrap();
        let process = unsafe { GetCurrentProcess() };
        let mut observation = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    process,
                    child.process(),
                    process,
                    &mut observation,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            },
            0
        );
        let observation = OwnedHandle(observation);
        let _message = child.fail("injected pre-resume failure");
        assert_eq!(
            unsafe { WaitForSingleObject(observation.raw(), 0) },
            WAIT_OBJECT_0
        );
    }
}
