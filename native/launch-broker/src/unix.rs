use crate::hash_file;
use crate::VerifiedHelper;
use std::ffi::CString;
use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NativeIdentity {
    device: u64,
    inode: u64,
    size: u64,
    mtime_seconds: i64,
    mtime_nanoseconds: i64,
    pub regular: bool,
}

pub(crate) struct RetainedContext;

pub(crate) fn open_helper_nofollow(path: &Path) -> Result<(File, RetainedContext), String> {
    if !path.is_absolute() {
        return Err("filesystem helper path is not absolute".to_owned());
    }
    let components: Vec<_> = path.components().collect();
    if !matches!(components.first(), Some(Component::RootDir)) || components.len() < 2 {
        return Err("filesystem helper path has no rooted components".to_owned());
    }
    let root = open_at(
        libc::AT_FDCWD,
        Path::new("/"),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )?;
    let mut current = root;
    for component in &components[1..components.len() - 1] {
        let Component::Normal(name) = component else {
            return Err("filesystem helper path contains a non-literal component".to_owned());
        };
        current = open_at(
            current.as_raw_fd(),
            Path::new(name),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )?;
    }
    let Component::Normal(filename) = components[components.len() - 1] else {
        return Err("filesystem helper path has no literal filename".to_owned());
    };
    let helper = open_at(
        current.as_raw_fd(),
        Path::new(filename),
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )?;
    Ok((helper, RetainedContext))
}

fn open_at(parent: RawFd, path: &Path, flags: i32) -> Result<File, String> {
    let bytes = path.as_os_str().as_bytes();
    let name = CString::new(bytes).map_err(|_| "filesystem path contains NUL".to_owned())?;
    let descriptor = unsafe { libc::openat(parent, name.as_ptr(), flags, 0) };
    if descriptor < 0 {
        return Err(format!(
            "filesystem helper component cannot be opened without following links: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{immutable_snapshot, normalize_exec_descriptor};
    use sha2::{Digest, Sha256};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::fd::AsRawFd;

    #[test]
    fn linux_execution_snapshot_is_sealed_against_in_place_writes() {
        let path =
            std::env::temp_dir().join(format!("meta-mover-broker-seal-{}", std::process::id()));
        fs::write(&path, b"verified helper bytes").unwrap();
        let source = OpenOptions::new().read(true).open(&path).unwrap();
        let expected = format!("{:x}", Sha256::digest(b"verified helper bytes"));
        let snapshot = immutable_snapshot(&source, &expected).unwrap();
        let mut writer = snapshot.try_clone().unwrap();
        assert!(writer.write_all(b"tampered").is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn unix_exec_closes_ambient_descriptors_beyond_the_held_executable() {
        let executable = OpenOptions::new().read(true).open("/dev/null").unwrap();
        let extra = unsafe { libc::fcntl(executable.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        assert!(extra >= 64);
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            let normalized = normalize_exec_descriptor(&executable);
            let descriptor_three_open = unsafe { libc::fcntl(3, libc::F_GETFD) } >= 0;
            let ambient_closed = unsafe { libc::fcntl(extra, libc::F_GETFD) } < 0;
            unsafe {
                libc::_exit(
                    if normalized == Ok(3) && descriptor_three_open && ambient_closed {
                        0
                    } else {
                        3
                    },
                )
            };
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        unsafe { libc::close(extra) };
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod mac_tests {
    use super::{immutable_snapshot, normalize_exec_descriptor};
    use sha2::{Digest, Sha256};
    use std::ffi::CString;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn macos_execution_snapshot_is_unlinked_and_immutable() {
        let path = std::env::temp_dir().join(format!(
            "meta-mover-broker-macos-snapshot-{}",
            std::process::id()
        ));
        fs::copy("/bin/sh", &path).unwrap();
        let source = OpenOptions::new().read(true).open(&path).unwrap();
        let expected = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
        let snapshot = immutable_snapshot(&source, &expected).unwrap();
        assert_eq!(snapshot.metadata().unwrap().nlink(), 0);
        assert_eq!(
            unsafe { libc::fcntl(snapshot.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE,
            libc::O_RDONLY
        );
        let mut writer = snapshot.try_clone().unwrap();
        assert!(writer.write_all(b"tampered").is_err());

        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            if normalize_exec_descriptor(&snapshot) != Ok(3) {
                unsafe { libc::_exit(126) };
            }
            let executable = CString::new("/dev/fd/3").unwrap();
            let argument_zero = CString::new("sh").unwrap();
            let command_flag = CString::new("-c").unwrap();
            let command = CString::new("exit 0").unwrap();
            let arguments = [
                argument_zero.as_ptr(),
                command_flag.as_ptr(),
                command.as_ptr(),
                std::ptr::null(),
            ];
            let environment = [std::ptr::null()];
            unsafe {
                libc::execve(
                    executable.as_ptr(),
                    arguments.as_ptr(),
                    environment.as_ptr(),
                );
                libc::_exit(127);
            }
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
        fs::remove_file(path).unwrap();
    }
}

pub(crate) fn identity(file: &File) -> Result<NativeIdentity, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("filesystem helper identity is unavailable: {error}"))?;
    use std::os::unix::fs::MetadataExt;
    Ok(NativeIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.size(),
        mtime_seconds: metadata.mtime(),
        mtime_nanoseconds: metadata.mtime_nsec(),
        regular: metadata.file_type().is_file(),
    })
}

#[cfg(target_os = "linux")]
fn immutable_snapshot(source: &File, expected_sha256: &str) -> Result<File, String> {
    let name = CString::new("meta-mover-fs-helper").unwrap();
    let descriptor =
        unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) };
    if descriptor < 0 {
        return Err(format!(
            "immutable helper snapshot cannot be created: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut snapshot = unsafe { File::from_raw_fd(descriptor) };
    let mut reader = source
        .try_clone()
        .map_err(|error| format!("filesystem helper descriptor cannot be duplicated: {error}"))?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("filesystem helper snapshot source cannot be rewound: {error}"))?;
    std::io::copy(&mut reader, &mut snapshot)
        .map_err(|error| format!("filesystem helper snapshot copy failed: {error}"))?;
    snapshot
        .sync_all()
        .map_err(|error| format!("filesystem helper snapshot sync failed: {error}"))?;
    if hash_file(&snapshot)? != expected_sha256 {
        return Err("filesystem helper changed while creating its execution snapshot".to_owned());
    }
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    if unsafe { libc::fcntl(snapshot.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
        return Err(format!(
            "filesystem helper execution snapshot cannot be sealed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let actual_seals = unsafe { libc::fcntl(snapshot.as_raw_fd(), libc::F_GET_SEALS) };
    if actual_seals < 0 || actual_seals & seals != seals {
        return Err("filesystem helper execution snapshot seal verification failed".to_owned());
    }
    snapshot.seek(SeekFrom::Start(0)).map_err(|error| {
        format!("filesystem helper execution snapshot cannot be rewound: {error}")
    })?;
    Ok(snapshot)
}

#[cfg(target_os = "macos")]
struct TemporarySnapshotPath {
    pathname: Vec<u8>,
    linked: bool,
}

#[cfg(target_os = "macos")]
impl TemporarySnapshotPath {
    fn unlink(&mut self) -> Result<(), String> {
        if unsafe { libc::unlink(self.pathname.as_ptr().cast()) } < 0 {
            return Err(format!(
                "private helper snapshot cannot be unlinked: {}",
                std::io::Error::last_os_error()
            ));
        }
        self.linked = false;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl Drop for TemporarySnapshotPath {
    fn drop(&mut self) {
        if self.linked {
            unsafe { libc::unlink(self.pathname.as_ptr().cast()) };
        }
    }
}

#[cfg(target_os = "macos")]
fn immutable_snapshot(source: &File, expected_sha256: &str) -> Result<File, String> {
    let mut template = std::env::temp_dir()
        .join(".meta-mover-fs-helper.XXXXXX")
        .as_os_str()
        .as_bytes()
        .to_vec();
    template.push(0);
    let descriptor = unsafe { libc::mkstemp(template.as_mut_ptr().cast()) };
    if descriptor < 0 {
        return Err(format!(
            "private helper snapshot cannot be created: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut snapshot_path = TemporarySnapshotPath {
        pathname: template,
        linked: true,
    };
    let mut writer = unsafe { File::from_raw_fd(descriptor) };
    let mut reader = source
        .try_clone()
        .map_err(|error| format!("filesystem helper descriptor cannot be duplicated: {error}"))?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("filesystem helper snapshot source cannot be rewound: {error}"))?;
    std::io::copy(&mut reader, &mut writer)
        .map_err(|error| format!("filesystem helper snapshot copy failed: {error}"))?;
    if unsafe { libc::fchmod(writer.as_raw_fd(), 0o500) } < 0 {
        return Err(format!(
            "private helper snapshot permissions cannot be restricted: {}",
            std::io::Error::last_os_error()
        ));
    }
    writer
        .sync_all()
        .map_err(|error| format!("filesystem helper snapshot sync failed: {error}"))?;
    if hash_file(&writer)? != expected_sha256 {
        return Err("filesystem helper changed while creating its execution snapshot".to_owned());
    }
    let read_descriptor = unsafe {
        libc::open(
            snapshot_path.pathname.as_ptr().cast(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if read_descriptor < 0 {
        return Err(format!(
            "private helper snapshot cannot be reopened read-only: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut snapshot = unsafe { File::from_raw_fd(read_descriptor) };
    if identity(&writer)? != identity(&snapshot)? {
        return Err("private helper snapshot identity changed while reopening".to_owned());
    }
    snapshot_path.unlink()?;
    drop(writer);
    if unsafe { libc::fchflags(snapshot.as_raw_fd(), libc::UF_IMMUTABLE) } < 0 {
        return Err(format!(
            "private helper snapshot cannot be made immutable: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut status = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(snapshot.as_raw_fd(), status.as_mut_ptr()) } < 0 {
        return Err(format!(
            "private helper snapshot identity cannot be verified: {}",
            std::io::Error::last_os_error()
        ));
    }
    let status = unsafe { status.assume_init() };
    if status.st_nlink != 0 || status.st_flags & libc::UF_IMMUTABLE == 0 {
        return Err("private helper snapshot is linked or mutable".to_owned());
    }
    if hash_file(&snapshot)? != expected_sha256 {
        return Err("read-only helper execution snapshot failed final hashing".to_owned());
    }
    snapshot.seek(SeekFrom::Start(0)).map_err(|error| {
        format!("filesystem helper execution snapshot cannot be rewound: {error}")
    })?;
    Ok(snapshot)
}

fn normalize_exec_descriptor(executable: &File) -> Result<RawFd, String> {
    let original = executable.as_raw_fd();
    if original <= libc::STDERR_FILENO {
        return Err("filesystem helper descriptor overlaps standard streams".to_owned());
    }
    let descriptor = 3;
    if original != descriptor && unsafe { libc::dup2(original, descriptor) } < 0 {
        return Err(format!(
            "filesystem helper descriptor cannot be normalized: {}",
            std::io::Error::last_os_error()
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let closed = unsafe { libc::syscall(libc::SYS_close_range, 4_u32, u32::MAX, 0_u32) };
        if closed < 0 {
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENOSYS) | Some(libc::EINVAL)
            ) {
                return Err(format!("ambient descriptor closure failed: {error}"));
            }
            let maximum = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
            if maximum < 4 {
                return Err("ambient descriptor limit is unavailable".to_owned());
            }
            for candidate in 4..maximum {
                unsafe { libc::close(candidate as i32) };
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let maximum = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
        if maximum < 4 {
            return Err("ambient descriptor limit is unavailable".to_owned());
        }
        for candidate in 4..maximum {
            unsafe { libc::close(candidate as i32) };
        }
    }
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0
    {
        return Err(format!(
            "filesystem helper descriptor cannot cross exec: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(descriptor)
}

pub(crate) fn launch(verified: VerifiedHelper) -> Result<i32, String> {
    let _retained_context = verified.context;
    let _verified_identity = verified.identity;
    let _verified_path = verified.path;
    let executable_file = immutable_snapshot(&verified.file, &verified.sha256)?;
    let descriptor = normalize_exec_descriptor(&executable_file)?;
    #[cfg(target_os = "macos")]
    let descriptor_path = format!("/dev/fd/{descriptor}");
    #[cfg(not(target_os = "macos"))]
    let descriptor_path = format!("/proc/self/fd/{descriptor}");
    let executable = CString::new(descriptor_path).expect("descriptor path contains no NUL");
    let argument_zero = CString::new("meta-mover-fs-helper").unwrap();
    let stdio = CString::new("--stdio").unwrap();
    let arguments = [argument_zero.as_ptr(), stdio.as_ptr(), std::ptr::null()];
    let environment: Vec<CString> = std::env::vars_os()
        .map(|(name, value)| {
            let mut bytes = name.as_os_str().as_bytes().to_vec();
            bytes.push(b'=');
            bytes.extend_from_slice(value.as_os_str().as_bytes());
            CString::new(bytes).map_err(|_| "environment contains NUL".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let mut environment_pointers: Vec<_> = environment.iter().map(|value| value.as_ptr()).collect();
    environment_pointers.push(std::ptr::null());
    let result = unsafe {
        libc::execve(
            executable.as_ptr(),
            arguments.as_ptr(),
            environment_pointers.as_ptr(),
        )
    };
    debug_assert_eq!(result, -1);
    Err(format!(
        "held-descriptor helper exec failed without pathname fallback: {}",
        std::io::Error::last_os_error()
    ))
}
