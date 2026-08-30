use crate::engine::{
    operation_result, reconciliation_error, source_delete_result, SourceDeleteResult,
    SourceDeleteSpec,
};
use crate::protocol::{CapabilityPath, HelperError, NativeIdentity, RootKind};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions, OpenOptionsExt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::File as StdFile;
use std::io::{Read, Seek, SeekFrom, Write};
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileAttributeTagInfo, FileBasicInfo, FileIdInfo, FileRenameInfo, FileStandardInfo,
    FlushFileBuffers, GetFileInformationByHandleEx, SetFileInformationByHandle, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
    FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO, OPEN_EXISTING, SYNCHRONIZE,
};

pub struct BoundRoot {
    directory: Dir,
    identity: NativeIdentity,
    #[allow(dead_code)]
    kind: RootKind,
}

impl BoundRoot {
    pub fn open(absolute_path: &str, kind: RootKind) -> Result<Self, HelperError> {
        let directory = open_root_nofollow(absolute_path)?;
        let identity = identity_of_dir(&directory)?;
        Ok(Self {
            directory,
            identity,
            kind,
        })
    }

    pub fn identity(&self) -> NativeIdentity {
        self.identity.clone()
    }

    pub fn kind(&self) -> RootKind {
        self.kind
    }
}

pub fn ensure_dir_chain(root: &BoundRoot, components: &[String]) -> Result<Value, HelperError> {
    let mut current = root.directory.try_clone().map_err(|_| {
        HelperError::precondition("root-unavailable", "root capability cannot be duplicated")
    })?;
    let mut synced = 0;
    for component in components {
        match open_directory(&current, component) {
            Ok(next) => current = next,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                current.create_dir(component).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        partial_chain_error(
                            synced,
                            HelperError::precondition(
                                "unsafe-existing-entry",
                                "directory component changed during creation",
                            ),
                        )
                    } else {
                        partial_chain_error(
                            synced,
                            HelperError::mutation(
                                "mkdir-failed",
                                "not-applied",
                                "could not create directory component",
                            ),
                        )
                    }
                })?;
                sync_dir(&current)?;
                synced += 1;
                current = open_directory(&current, component).map_err(|_| {
                    HelperError::mutation(
                        "directory-open-failed",
                        "unknown",
                        "created directory could not be reopened safely",
                    )
                })?;
            }
            Err(_) => {
                return Err(partial_chain_error(
                    synced,
                    HelperError::precondition(
                        "unsafe-directory-component",
                        "directory component is missing, linked, or not a directory",
                    ),
                ))
            }
        }
    }
    let identity = identity_of_dir(&current)?;
    Ok(operation_result(None, Some(identity), None, false, synced))
}

pub fn stage_copy(
    source_root: &BoundRoot,
    source_components: &[String],
    target_root: &BoundRoot,
    target_components: &[String],
    expected: Option<&NativeIdentity>,
    expected_sha256: Option<&str>,
) -> Result<Value, HelperError> {
    let (source_parent, source_name) = open_parent(source_root, source_components)?;
    let source = open_regular(&source_parent, source_name, false)?;
    let before = identity_of(&source)?;
    verify_expected(expected, &before)?;
    let (target_parent, target_name) = open_parent(target_root, target_components)?;
    let mut target_options = OpenOptions::new();
    target_options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut target = target_parent
        .open_with(target_name, &target_options)
        .map_err(map_create_error)?;
    let created = identity_of(&target)?;

    let copy_result = (|| {
        let mut source_reader = source.try_clone().map_err(|_| {
            HelperError::precondition("source-open-failed", "source handle cannot be duplicated")
        })?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let count = source_reader.read(&mut buffer).map_err(|_| {
                HelperError::mutation(
                    "source-read-failed",
                    "not-applied",
                    "source could not be read",
                )
            })?;
            if count == 0 {
                break;
            }
            target.write_all(&buffer[..count]).map_err(|_| {
                HelperError::mutation(
                    "target-write-failed",
                    "unknown",
                    "staging file write failed",
                )
            })?;
            digest.update(&buffer[..count]);
        }
        if identity_of(&source)? != before {
            return Err(HelperError::precondition(
                "source-drift",
                "source identity changed while copying",
            ));
        }
        let sha256 = format!("{:x}", digest.finalize());
        if expected_sha256.is_some_and(|expected| expected != sha256) {
            return Err(HelperError::precondition(
                "hash-mismatch",
                "source SHA-256 does not match the expected digest",
            ));
        }
        target
            .sync_all()
            .map_err(|_| HelperError::durability("staging file could not be synced"))?;
        sync_dir(&target_parent)?;
        let after = identity_of(&target)?;
        Ok(operation_result(
            Some(before.clone()),
            Some(after),
            Some(sha256),
            true,
            1,
        ))
    })();
    match copy_result {
        Ok(result) => Ok(result),
        Err(error) => {
            cleanup_created(&target_parent, target_name, &created)?;
            Err(error)
        }
    }
}

pub fn write_marker_new(
    root: &BoundRoot,
    components: &[String],
    contents: &[u8],
) -> Result<Value, HelperError> {
    let (parent, name) = open_parent(root, components)?;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = parent.open_with(name, &options).map_err(map_create_error)?;
    let created = identity_of(&file)?;
    if file.write_all(contents).is_err() {
        cleanup_created(&parent, name, &created)?;
        return Err(HelperError::mutation(
            "marker-write-failed",
            "not-applied",
            "marker contents could not be written",
        ));
    }
    file.sync_all()
        .map_err(|_| HelperError::durability("marker file could not be synced"))?;
    sync_dir(&parent)?;
    Ok(operation_result(
        None,
        Some(identity_of(&file)?),
        None,
        true,
        1,
    ))
}

pub fn hard_link_no_replace(
    source_root: &BoundRoot,
    source_components: &[String],
    target_root: &BoundRoot,
    target_components: &[String],
    expected: Option<&NativeIdentity>,
) -> Result<Value, HelperError> {
    let (source_parent, source_name) = open_parent(source_root, source_components)?;
    let source = open_regular(&source_parent, source_name, false)?;
    let before = identity_of(&source)?;
    verify_expected(expected, &before)?;
    let (target_parent, target_name) = open_parent(target_root, target_components)?;
    source_parent
        .hard_link(source_name, &target_parent, target_name)
        .map_err(map_create_error)?;
    let target = open_regular(&target_parent, target_name, false).map_err(|_| {
        HelperError::mutation(
            "linked-target-open-failed",
            "unknown",
            "new hard link could not be reopened",
        )
    })?;
    let after = identity_of(&target)?;
    if !same_object(&before, &after) {
        return Err(HelperError::mutation(
            "source-race",
            "unknown",
            "linked entry does not match the opened source",
        ));
    }
    sync_dir(&target_parent)?;
    Ok(operation_result(Some(before), Some(after), None, false, 1))
}

pub fn rename_no_replace(
    source_root: &BoundRoot,
    source_components: &[String],
    target_root: &BoundRoot,
    target_components: &[String],
    expected: Option<&NativeIdentity>,
) -> Result<Value, HelperError> {
    let (source_parent, source_name) = open_parent(source_root, source_components)?;
    let source = open_regular(&source_parent, source_name, true)?;
    let before = identity_of(&source)?;
    verify_expected(expected, &before)?;
    let (target_parent, target_name) = open_parent(target_root, target_components)?;
    rename_handle_no_replace(&source, &target_parent, target_name)?;
    let target = open_regular(&target_parent, target_name, false).map_err(|_| {
        HelperError::mutation(
            "renamed-target-open-failed",
            "unknown",
            "renamed target could not be reopened",
        )
    })?;
    let after = identity_of(&target)?;
    if !same_object(&before, &after) {
        return Err(HelperError::mutation(
            "source-race",
            "unknown",
            "renamed entry does not match the opened source",
        ));
    }
    sync_dir(&source_parent)?;
    sync_dir(&target_parent)?;
    Ok(operation_result(Some(before), Some(after), None, false, 2))
}

pub fn remove_managed_exact(
    root: &BoundRoot,
    components: &[String],
    expected: &NativeIdentity,
    request_id: &str,
) -> Result<Value, HelperError> {
    quarantine_delete(root, components, expected, None, request_id)
}

pub fn delete_source_exact(
    source_root: &BoundRoot,
    receipt_root: &BoundRoot,
    spec: &SourceDeleteSpec<'_>,
) -> Result<Value, HelperError> {
    let source_path = spec.source_path;
    let receipt_path = spec.receipt_path;
    let expected = spec.expected;
    let expected_sha256 = spec.expected_sha256;
    let delete_id = spec.delete_id;
    let receipt_bytes = spec.receipt_bytes;
    reject_source_receipt_alias(source_root, source_path, receipt_root, receipt_path)?;
    let (source_parent, source_name) = open_parent(source_root, &source_path.components)?;
    let source = open_regular(&source_parent, source_name, true)?;
    let before = identity_of(&source)?;
    verify_expected(Some(expected), &before)?;
    if hash_file(&source)? != expected_sha256 {
        return Err(HelperError::precondition(
            "hash-mismatch",
            "source SHA-256 does not match the expected digest",
        ));
    }

    let quarantine_name = create_private_directory(&source_parent, delete_id)?;
    let quarantine = open_directory(&source_parent, &quarantine_name).map_err(|_| {
        HelperError::mutation(
            "quarantine-open-failed",
            "unknown",
            "private quarantine could not be opened",
        )
    })?;
    if let Err(error) = rename_handle_no_replace(&source, &quarantine, "entry") {
        verify_visible_source(&source_parent, source_name, &before)?;
        drop(quarantine);
        remove_empty_quarantine(&source_parent, &quarantine_name)?;
        return Err(error);
    }
    if identity_of(&source)? != before || hash_file(&source)? != expected_sha256 {
        return Err(reconciliation_error(
            "quarantined entry does not match expected deletion evidence",
            source_path,
            receipt_path,
            delete_id,
            "absent",
            "entry-other",
            "absent",
        ));
    }
    if create_receipt_new(receipt_root, receipt_path, receipt_bytes).is_err() {
        return Err(HelperError::delete_reconciliation(
            "delete receipt could not be created exclusively",
        ));
    }
    drop(source);
    quarantine.remove_file("entry").map_err(|_| {
        reconciliation_error(
            "verified quarantine entry could not be unlinked",
            source_path,
            receipt_path,
            delete_id,
            "absent",
            "entry-expected",
            "exact",
        )
    })?;
    sync_dir(&quarantine).map_err(|_| {
        reconciliation_error(
            "quarantine directory could not be synced",
            source_path,
            receipt_path,
            delete_id,
            "absent",
            "empty",
            "exact",
        )
    })?;
    drop(quarantine);
    source_parent.remove_dir(&quarantine_name).map_err(|_| {
        reconciliation_error(
            "empty quarantine directory could not be removed",
            source_path,
            receipt_path,
            delete_id,
            "absent",
            "empty",
            "exact",
        )
    })?;
    sync_dir(&source_parent).map_err(|_| {
        reconciliation_error(
            "source parent could not be synced after deletion",
            source_path,
            receipt_path,
            delete_id,
            "absent",
            "absent",
            "exact",
        )
    })?;
    Ok(source_delete_result(SourceDeleteResult {
        outcome: "applied",
        state: "deleted",
        source_state: "absent",
        quarantine_state: "entry-deleted",
        receipt_state: "created",
        delete_id,
        file_synced: true,
        parent_syncs: 3,
    }))
}

pub fn reconcile_source_delete(
    source_root: &BoundRoot,
    receipt_root: &BoundRoot,
    spec: &SourceDeleteSpec<'_>,
) -> Result<Value, HelperError> {
    let source_path = spec.source_path;
    let receipt_path = spec.receipt_path;
    let expected = spec.expected;
    let expected_sha256 = spec.expected_sha256;
    let delete_id = spec.delete_id;
    let receipt_bytes = spec.receipt_bytes;
    reject_source_receipt_alias(source_root, source_path, receipt_root, receipt_path)?;
    let (source_parent, source_name) = open_parent(source_root, &source_path.components)?;
    let source_state = observe_source(&source_parent, source_name, expected, expected_sha256);
    let receipt_state = observe_receipt(receipt_root, receipt_path, receipt_bytes);
    let quarantine_name = format!(".meta-mover-delete-{}", delete_id.replace('-', ""));
    let quarantine_state =
        observe_quarantine(&source_parent, &quarantine_name, expected, expected_sha256);

    if matches!(
        receipt_state,
        ReceiptObservation::Other | ReceiptObservation::Special | ReceiptObservation::Unreadable
    ) {
        return Err(reconciliation_error(
            "delete receipt does not match the expected immutable marker",
            source_path,
            receipt_path,
            delete_id,
            source_state.label(),
            quarantine_state.label(),
            receipt_state.label(),
        ));
    }

    match quarantine_state {
        QuarantineObservation::Absent => match (source_state, receipt_state) {
            (SourceObservation::Expected, ReceiptObservation::Absent) => {
                Ok(source_delete_result(SourceDeleteResult {
                    outcome: "not-applied",
                    state: "source-retained",
                    source_state: "expected",
                    quarantine_state: "absent",
                    receipt_state: "absent",
                    delete_id,
                    file_synced: false,
                    parent_syncs: 0,
                }))
            }
            (
                SourceObservation::Absent | SourceObservation::Other | SourceObservation::Special,
                ReceiptObservation::Exact,
            ) => {
                sync_dir(&source_parent).map_err(|_| {
                    reconciliation_error(
                        "source parent could not be synced during reconciliation",
                        source_path,
                        receipt_path,
                        delete_id,
                        source_state.label(),
                        "absent",
                        "exact",
                    )
                })?;
                Ok(source_delete_result(SourceDeleteResult {
                    outcome: "applied",
                    state: "deleted",
                    source_state: source_state.deleted_label(),
                    quarantine_state: "absent",
                    receipt_state: "exact",
                    delete_id,
                    file_synced: false,
                    parent_syncs: 1,
                }))
            }
            _ => Err(reconciliation_error(
                "source deletion state is ambiguous without matching quarantine evidence",
                source_path,
                receipt_path,
                delete_id,
                source_state.label(),
                "absent",
                receipt_state.label(),
            )),
        },
        QuarantineObservation::Empty(quarantine) => match (source_state, receipt_state) {
            (SourceObservation::Expected, ReceiptObservation::Absent) => {
                drop(quarantine);
                source_parent.remove_dir(&quarantine_name).map_err(|_| {
                    reconciliation_error(
                        "empty pre-intent quarantine could not be removed",
                        source_path,
                        receipt_path,
                        delete_id,
                        "expected",
                        "empty",
                        "absent",
                    )
                })?;
                sync_dir(&source_parent).map_err(|_| {
                    reconciliation_error(
                        "source parent could not be synced after quarantine cleanup",
                        source_path,
                        receipt_path,
                        delete_id,
                        "expected",
                        "absent",
                        "absent",
                    )
                })?;
                Ok(source_delete_result(SourceDeleteResult {
                    outcome: "not-applied",
                    state: "source-retained",
                    source_state: "expected",
                    quarantine_state: "empty-removed",
                    receipt_state: "absent",
                    delete_id,
                    file_synced: false,
                    parent_syncs: 1,
                }))
            }
            (
                SourceObservation::Absent | SourceObservation::Other | SourceObservation::Special,
                ReceiptObservation::Exact,
            ) => {
                sync_dir(&quarantine).map_err(|_| {
                    reconciliation_error(
                        "empty quarantine could not be synced during reconciliation",
                        source_path,
                        receipt_path,
                        delete_id,
                        source_state.label(),
                        "empty",
                        "exact",
                    )
                })?;
                drop(quarantine);
                source_parent.remove_dir(&quarantine_name).map_err(|_| {
                    reconciliation_error(
                        "empty quarantine could not be removed during reconciliation",
                        source_path,
                        receipt_path,
                        delete_id,
                        source_state.label(),
                        "empty",
                        "exact",
                    )
                })?;
                sync_dir(&source_parent).map_err(|_| {
                    reconciliation_error(
                        "source parent could not be synced during reconciliation",
                        source_path,
                        receipt_path,
                        delete_id,
                        source_state.label(),
                        "absent",
                        "exact",
                    )
                })?;
                Ok(source_delete_result(SourceDeleteResult {
                    outcome: "applied",
                    state: "deleted",
                    source_state: source_state.deleted_label(),
                    quarantine_state: "empty-removed",
                    receipt_state: "exact",
                    delete_id,
                    file_synced: false,
                    parent_syncs: 2,
                }))
            }
            _ => Err(reconciliation_error(
                "empty quarantine does not prove a terminal source deletion state",
                source_path,
                receipt_path,
                delete_id,
                source_state.label(),
                "empty",
                receipt_state.label(),
            )),
        },
        QuarantineObservation::EntryExpected { directory, entry } => {
            if matches!(
                source_state,
                SourceObservation::Expected | SourceObservation::Unreadable
            ) {
                return Err(reconciliation_error(
                    "simultaneous or unreadable source state prevents exact reconciliation",
                    source_path,
                    receipt_path,
                    delete_id,
                    source_state.label(),
                    "entry-expected",
                    receipt_state.label(),
                ));
            }
            let (receipt_label, created_receipt) = match receipt_state {
                ReceiptObservation::Exact => ("exact", false),
                ReceiptObservation::Absent => {
                    if create_receipt_new(receipt_root, receipt_path, receipt_bytes).is_err() {
                        let observed = observe_receipt(receipt_root, receipt_path, receipt_bytes);
                        return Err(reconciliation_error(
                            "delete receipt could not be created exclusively",
                            source_path,
                            receipt_path,
                            delete_id,
                            source_state.label(),
                            "entry-expected",
                            observed.label(),
                        ));
                    }
                    ("created", true)
                }
                _ => unreachable!("non-exact receipt states returned above"),
            };
            if identity_of(&entry)? != *expected || hash_file(&entry)? != expected_sha256 {
                return Err(reconciliation_error(
                    "quarantine entry changed during reconciliation",
                    source_path,
                    receipt_path,
                    delete_id,
                    source_state.label(),
                    "entry-other",
                    receipt_label,
                ));
            }
            drop(entry);
            directory.remove_file("entry").map_err(|_| {
                reconciliation_error(
                    "verified quarantine entry could not be unlinked",
                    source_path,
                    receipt_path,
                    delete_id,
                    source_state.label(),
                    "entry-expected",
                    receipt_label,
                )
            })?;
            sync_dir(&directory).map_err(|_| {
                reconciliation_error(
                    "quarantine directory could not be synced",
                    source_path,
                    receipt_path,
                    delete_id,
                    source_state.label(),
                    "empty",
                    receipt_label,
                )
            })?;
            drop(directory);
            source_parent.remove_dir(&quarantine_name).map_err(|_| {
                reconciliation_error(
                    "empty quarantine directory could not be removed",
                    source_path,
                    receipt_path,
                    delete_id,
                    source_state.label(),
                    "empty",
                    receipt_label,
                )
            })?;
            sync_dir(&source_parent).map_err(|_| {
                reconciliation_error(
                    "source parent could not be synced after deletion",
                    source_path,
                    receipt_path,
                    delete_id,
                    source_state.label(),
                    "absent",
                    receipt_label,
                )
            })?;
            Ok(source_delete_result(SourceDeleteResult {
                outcome: "applied",
                state: "deleted",
                source_state: source_state.deleted_label(),
                quarantine_state: "entry-deleted",
                receipt_state: receipt_label,
                delete_id,
                file_synced: created_receipt,
                parent_syncs: if created_receipt { 3 } else { 2 },
            }))
        }
        other => Err(reconciliation_error(
            "quarantine state does not match exact deletion evidence",
            source_path,
            receipt_path,
            delete_id,
            source_state.label(),
            other.label(),
            receipt_state.label(),
        )),
    }
}

#[derive(Clone, Copy)]
enum SourceObservation {
    Expected,
    Absent,
    Other,
    Special,
    Unreadable,
}

impl SourceObservation {
    fn label(self) -> &'static str {
        match self {
            Self::Expected => "expected",
            Self::Absent => "absent",
            Self::Other => "other",
            Self::Special => "special",
            Self::Unreadable => "unreadable",
        }
    }

    fn deleted_label(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Other | Self::Special => "replacement-preserved",
            Self::Expected | Self::Unreadable => unreachable!("ambiguous source is not deleted"),
        }
    }
}

#[derive(Clone, Copy)]
enum ReceiptObservation {
    Absent,
    Exact,
    Other,
    Special,
    Unreadable,
}

impl ReceiptObservation {
    fn label(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Exact => "exact",
            Self::Other => "other",
            Self::Special => "special",
            Self::Unreadable => "unreadable",
        }
    }
}

enum QuarantineObservation {
    Absent,
    Empty(Dir),
    EntryExpected { directory: Dir, entry: File },
    EntryOther,
    EntrySpecial,
    UnexpectedEntries,
    Special,
    Unreadable,
}

impl QuarantineObservation {
    fn label(&self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Empty(_) => "empty",
            Self::EntryExpected { .. } => "entry-expected",
            Self::EntryOther => "entry-other",
            Self::EntrySpecial => "entry-special",
            Self::UnexpectedEntries => "unexpected-entries",
            Self::Special => "special",
            Self::Unreadable => "unreadable",
        }
    }
}

fn observe_source(
    parent: &Dir,
    name: &str,
    expected: &NativeIdentity,
    expected_sha256: &str,
) -> SourceObservation {
    match open_regular(parent, name, false) {
        Ok(file) => match (identity_of(&file), hash_file(&file)) {
            (Ok(identity), Ok(digest)) if &identity == expected && digest == expected_sha256 => {
                SourceObservation::Expected
            }
            (Ok(_), Ok(_)) => SourceObservation::Other,
            _ => SourceObservation::Unreadable,
        },
        Err(_) => classify_missing_or_special(parent, name),
    }
}

fn classify_missing_or_special(parent: &Dir, name: &str) -> SourceObservation {
    match parent.symlink_metadata(name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SourceObservation::Absent,
        Ok(metadata) if !metadata.is_file() => SourceObservation::Special,
        Ok(_) | Err(_) => SourceObservation::Unreadable,
    }
}

fn observe_receipt(
    root: &BoundRoot,
    path: &CapabilityPath,
    expected_bytes: &[u8],
) -> ReceiptObservation {
    let (parent, name) = match open_parent(root, &path.components) {
        Ok(value) => value,
        Err(_) => return ReceiptObservation::Unreadable,
    };
    let mut file = match open_regular(&parent, name, false) {
        Ok(file) => file,
        Err(_) => {
            return match parent.symlink_metadata(name) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ReceiptObservation::Absent
                }
                Ok(metadata) if !metadata.is_file() => ReceiptObservation::Special,
                Ok(_) | Err(_) => ReceiptObservation::Unreadable,
            }
        }
    };
    let before = match identity_of(&file) {
        Ok(identity) => identity,
        Err(_) => return ReceiptObservation::Unreadable,
    };
    if file.seek(SeekFrom::Start(0)).is_err() {
        return ReceiptObservation::Unreadable;
    }
    let mut bytes = Vec::with_capacity(expected_bytes.len() + 1);
    if Read::by_ref(&mut file)
        .take((expected_bytes.len() + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || identity_of(&file).ok().as_ref() != Some(&before)
    {
        return ReceiptObservation::Unreadable;
    }
    if bytes == expected_bytes {
        ReceiptObservation::Exact
    } else {
        ReceiptObservation::Other
    }
}

fn observe_quarantine(
    parent: &Dir,
    name: &str,
    expected: &NativeIdentity,
    expected_sha256: &str,
) -> QuarantineObservation {
    let directory = match open_directory(parent, name) {
        Ok(directory) => directory,
        Err(_) => {
            return match parent.symlink_metadata(name) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    QuarantineObservation::Absent
                }
                Ok(metadata) if !metadata.is_dir() => QuarantineObservation::Special,
                Ok(_) | Err(_) => QuarantineObservation::Unreadable,
            }
        }
    };
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(_) => return QuarantineObservation::Unreadable,
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return QuarantineObservation::Unreadable,
        };
        names.push(entry.file_name());
        if names.len() > 1 {
            return QuarantineObservation::UnexpectedEntries;
        }
    }
    if names.is_empty() {
        return QuarantineObservation::Empty(directory);
    }
    if names[0].as_os_str() != OsStr::new("entry") {
        return QuarantineObservation::UnexpectedEntries;
    }
    let entry = match open_regular(&directory, "entry", true) {
        Ok(entry) => entry,
        Err(_) => {
            return match directory.symlink_metadata("entry") {
                Ok(metadata) if !metadata.is_file() => QuarantineObservation::EntrySpecial,
                Ok(_) | Err(_) => QuarantineObservation::Unreadable,
            }
        }
    };
    match (identity_of(&entry), hash_file(&entry)) {
        (Ok(identity), Ok(digest)) if &identity == expected && digest == expected_sha256 => {
            QuarantineObservation::EntryExpected { directory, entry }
        }
        (Ok(_), Ok(_)) => QuarantineObservation::EntryOther,
        _ => QuarantineObservation::Unreadable,
    }
}

fn create_receipt_new(root: &BoundRoot, path: &CapabilityPath, contents: &[u8]) -> Result<(), ()> {
    let (parent, name) = open_parent(root, &path.components).map_err(|_| ())?;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = parent.open_with(name, &options).map_err(|_| ())?;
    file.write_all(contents).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    sync_dir(&parent).map_err(|_| ())?;
    Ok(())
}

fn reject_source_receipt_alias(
    source_root: &BoundRoot,
    source_path: &CapabilityPath,
    receipt_root: &BoundRoot,
    receipt_path: &CapabilityPath,
) -> Result<(), HelperError> {
    let (source_parent, source_name) = open_parent(source_root, &source_path.components)?;
    let (receipt_parent, receipt_name) = open_parent(receipt_root, &receipt_path.components)?;
    if let (Ok(source), Ok(receipt)) = (
        open_regular(&source_parent, source_name, false),
        open_regular(&receipt_parent, receipt_name, false),
    ) {
        if same_object(&identity_of(&source)?, &identity_of(&receipt)?) {
            return Err(HelperError::precondition(
                "source-receipt-alias",
                "source and delete receipt resolve to the same directory entry",
            ));
        }
    }
    Ok(())
}

fn quarantine_delete(
    root: &BoundRoot,
    components: &[String],
    expected: &NativeIdentity,
    expected_sha256: Option<&str>,
    request_id: &str,
) -> Result<Value, HelperError> {
    let (source_parent, source_name) = open_parent(root, components)?;
    let source = open_regular(&source_parent, source_name, true)?;
    let before = identity_of(&source)?;
    verify_expected(Some(expected), &before)?;
    if let Some(expected_digest) = expected_sha256 {
        if hash_file(&source)? != expected_digest {
            return Err(HelperError::precondition(
                "hash-mismatch",
                "source SHA-256 does not match the expected digest",
            ));
        }
    }
    let quarantine_name = create_private_directory(&source_parent, request_id)?;
    let quarantine = open_directory(&source_parent, &quarantine_name).map_err(|_| {
        HelperError::mutation(
            "quarantine-open-failed",
            "unknown",
            "private quarantine could not be opened",
        )
    })?;
    let entry_name = "entry";
    if let Err(error) = rename_handle_no_replace(&source, &quarantine, entry_name) {
        verify_visible_source(&source_parent, source_name, &before)?;
        drop(quarantine);
        remove_empty_quarantine(&source_parent, &quarantine_name)?;
        return Err(error);
    }
    let after = identity_of(&source)?;
    if !same_object(&before, &after) {
        return Err(HelperError::mutation(
            "source-race",
            "unknown",
            "quarantined entry does not match the opened source",
        ));
    }
    if let Some(expected_digest) = expected_sha256 {
        if hash_file(&source)? != expected_digest {
            return Err(HelperError::mutation(
                "quarantine-hash-mismatch",
                "unknown",
                "quarantined content does not match the expected digest",
            ));
        }
    }
    drop(source);
    quarantine.remove_file(entry_name).map_err(|_| {
        HelperError::mutation(
            "quarantine-unlink-failed",
            "unknown",
            "verified quarantine entry could not be unlinked",
        )
    })?;
    sync_dir(&quarantine)?;
    drop(quarantine);
    source_parent.remove_dir(&quarantine_name).map_err(|_| {
        HelperError::mutation(
            "quarantine-remove-failed",
            "unknown",
            "empty quarantine directory could not be removed",
        )
    })?;
    sync_dir(&source_parent)?;
    Ok(operation_result(Some(before), None, None, false, 2))
}

fn open_root_nofollow(absolute_path: &str) -> Result<Dir, HelperError> {
    let mut wide: Vec<u16> = Path::new(absolute_path).as_os_str().encode_wide().collect();
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(HelperError::precondition(
            "root-open-failed",
            "bound root is not an accessible real directory",
        ));
    }
    let file = unsafe { StdFile::from_raw_handle(handle) };
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    let queried = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if queried == 0
        || tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(HelperError::precondition(
            "root-open-failed",
            "bound root is not an accessible real directory",
        ));
    }
    Ok(Dir::from_std_file(file))
}

fn open_parent<'a>(
    root: &BoundRoot,
    components: &'a [String],
) -> Result<(Dir, &'a str), HelperError> {
    let (name, parents) = components.split_last().ok_or_else(|| {
        HelperError::validation("invalid-components", "path has no final component")
    })?;
    let mut current = root.directory.try_clone().map_err(|_| {
        HelperError::precondition("root-unavailable", "root capability cannot be duplicated")
    })?;
    for component in parents {
        current = open_directory(&current, component).map_err(|_| {
            HelperError::precondition(
                "unsafe-directory-component",
                "parent component is missing, linked, or not a directory",
            )
        })?;
    }
    Ok((current, name))
}

fn open_directory(parent: &Dir, name: &str) -> Result<Dir, std::io::Error> {
    let mut options = OpenOptions::new();
    options
        .access_mode(GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .follow(FollowSymlinks::No);
    let file = parent.open_with(name, &options)?;
    let tag = query_file_info::<FILE_ATTRIBUTE_TAG_INFO>(
        file.as_raw_handle() as HANDLE,
        FileAttributeTagInfo,
    )
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "directory stat failed"))?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "entry is not a real directory",
        ));
    }
    Ok(Dir::from_std_file(file.into_std()))
}

fn open_regular(parent: &Dir, name: &str, delete_access: bool) -> Result<File, HelperError> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    if delete_access {
        options
            .access_mode(GENERIC_READ | DELETE | SYNCHRONIZE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    let file = parent.open_with(name, &options).map_err(|_| {
        HelperError::precondition("unsafe-file", "entry is missing, linked, or inaccessible")
    })?;
    if !file
        .metadata()
        .map_err(|_| HelperError::precondition("stat-failed", "entry identity is unavailable"))?
        .is_file()
    {
        return Err(HelperError::precondition(
            "not-regular-file",
            "entry is not a regular file",
        ));
    }
    Ok(file)
}

fn rename_handle_no_replace(
    source: &File,
    target_parent: &Dir,
    target_name: &str,
) -> Result<(), HelperError> {
    let name: Vec<u16> = std::ffi::OsStr::new(target_name).encode_wide().collect();
    let byte_count = name
        .len()
        .checked_mul(2)
        .ok_or_else(|| HelperError::validation("invalid-components", "target name is too long"))?;
    let header = offset_of!(FILE_RENAME_INFO, FileName);
    let total = header
        .checked_add(byte_count)
        .ok_or_else(|| HelperError::validation("invalid-components", "target name is too long"))?;
    let word_size = size_of::<usize>();
    let mut storage = vec![0_usize; total.div_ceil(word_size)];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = target_parent.as_raw_handle() as HANDLE;
        (*info).FileNameLength = byte_count as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
    }
    let renamed = unsafe {
        SetFileInformationByHandle(
            source.as_raw_handle() as HANDLE,
            FileRenameInfo,
            storage.as_ptr().cast(),
            total as u32,
        )
    };
    if renamed == 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Err(HelperError::precondition(
                "target-exists",
                "target already exists",
            ))
        } else {
            Err(HelperError::mutation(
                "rename-failed",
                "not-applied",
                "no-replace handle rename failed",
            ))
        }
    } else {
        Ok(())
    }
}

fn identity_of(file: &File) -> Result<NativeIdentity, HelperError> {
    identity_from_handle(file.as_raw_handle() as HANDLE)
}

fn identity_of_dir(directory: &Dir) -> Result<NativeIdentity, HelperError> {
    identity_from_handle(directory.as_raw_handle() as HANDLE)
}

fn identity_from_handle(handle: HANDLE) -> Result<NativeIdentity, HelperError> {
    let id = query_file_info::<FILE_ID_INFO>(handle, FileIdInfo)?;
    let standard = query_file_info::<FILE_STANDARD_INFO>(handle, FileStandardInfo)?;
    let basic = query_file_info::<FILE_BASIC_INFO>(handle, FileBasicInfo)?;
    if standard.EndOfFile < 0 {
        return Err(HelperError::precondition(
            "stat-failed",
            "native file size is invalid",
        ));
    }
    let windows_ticks = basic.LastWriteTime;
    let unix_ns = i128::from(windows_ticks) * 100_i128 - 11_644_473_600_000_000_000_i128;
    Ok(NativeIdentity::Windows {
        volume_serial: id.VolumeSerialNumber.to_string(),
        file_id: u128::from_le_bytes(id.FileId.Identifier).to_string(),
        links: standard.NumberOfLinks.to_string(),
        size: (standard.EndOfFile as u64).to_string(),
        mtime_ns: unix_ns.to_string(),
    })
}

fn query_file_info<T: Default>(handle: HANDLE, class: i32) -> Result<T, HelperError> {
    let mut info = T::default();
    let queried = unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut info as *mut T).cast(),
            size_of::<T>() as u32,
        )
    };
    if queried == 0 {
        Err(HelperError::precondition(
            "stat-failed",
            "native identity is unavailable",
        ))
    } else {
        Ok(info)
    }
}

fn verify_expected(
    expected: Option<&NativeIdentity>,
    actual: &NativeIdentity,
) -> Result<(), HelperError> {
    if expected.is_some_and(|expected| expected != actual) {
        Err(HelperError::precondition(
            "identity-mismatch",
            "entry identity does not match the expected identity",
        ))
    } else {
        Ok(())
    }
}

fn same_object(left: &NativeIdentity, right: &NativeIdentity) -> bool {
    match (left, right) {
        (
            NativeIdentity::Windows {
                volume_serial: left_volume,
                file_id: left_id,
                ..
            },
            NativeIdentity::Windows {
                volume_serial: right_volume,
                file_id: right_id,
                ..
            },
        ) => left_volume == right_volume && left_id == right_id,
        _ => false,
    }
}

fn hash_file(file: &File) -> Result<String, HelperError> {
    let before = identity_of(file)?;
    let mut reader = file.try_clone().map_err(|_| {
        HelperError::precondition("source-open-failed", "source handle cannot be duplicated")
    })?;
    reader.seek(SeekFrom::Start(0)).map_err(|_| {
        HelperError::precondition(
            "source-read-failed",
            "source could not be rewound for hashing",
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|_| {
            HelperError::precondition("source-read-failed", "source could not be hashed")
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if identity_of(file)? != before {
        return Err(HelperError::precondition(
            "source-drift",
            "source identity changed while hashing",
        ));
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn cleanup_created(parent: &Dir, name: &str, created: &NativeIdentity) -> Result<(), HelperError> {
    let visible = open_regular(parent, name, false).map_err(|_| {
        HelperError::mutation(
            "cleanup-precondition-failed",
            "unknown",
            "new entry cannot be reopened for cleanup",
        )
    })?;
    if !same_object(&identity_of(&visible)?, created) {
        return Err(HelperError::mutation(
            "cleanup-identity-mismatch",
            "unknown",
            "new entry changed before cleanup",
        ));
    }
    parent.remove_file(name).map_err(|_| {
        HelperError::mutation(
            "cleanup-unlink-failed",
            "unknown",
            "new entry could not be removed after failure",
        )
    })?;
    sync_dir(parent)
}

fn create_private_directory(parent: &Dir, request_id: &str) -> Result<String, HelperError> {
    let name = format!(".meta-mover-delete-{}", request_id.replace('-', ""));
    match parent.create_dir(&name) {
        Ok(()) => Ok(name),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(HelperError::delete_reconciliation(
                "request quarantine already exists and requires reconciliation",
            ))
        }
        Err(_) => Err(HelperError::mutation(
            "quarantine-create-failed",
            "not-applied",
            "private quarantine directory could not be created",
        )),
    }
}

fn remove_empty_quarantine(parent: &Dir, name: &str) -> Result<(), HelperError> {
    parent.remove_dir(name).map_err(|_| {
        HelperError::mutation(
            "quarantine-cleanup-failed",
            "unknown",
            "empty request quarantine could not be removed",
        )
    })?;
    sync_dir(parent)
}

fn verify_visible_source(
    parent: &Dir,
    name: &str,
    expected: &NativeIdentity,
) -> Result<(), HelperError> {
    let visible = open_regular(parent, name, false).map_err(|_| {
        HelperError::mutation(
            "source-reconciliation-required",
            "unknown",
            "source visibility changed during failed quarantine rename",
        )
    })?;
    if same_object(&identity_of(&visible)?, expected) {
        Ok(())
    } else {
        Err(HelperError::mutation(
            "source-reconciliation-required",
            "unknown",
            "source identity changed during failed quarantine rename",
        ))
    }
}

fn partial_chain_error(created: usize, original: HelperError) -> HelperError {
    if created == 0 {
        original
    } else {
        HelperError::mutation(
            "partial-directory-chain",
            "unknown",
            "directory-chain creation failed after a durable prefix was created",
        )
    }
}

fn sync_dir(directory: &Dir) -> Result<(), HelperError> {
    let synced = unsafe { FlushFileBuffers(directory.as_raw_handle() as HANDLE) };
    if synced == 0 {
        Err(HelperError::durability(
            "directory handle could not be synced",
        ))
    } else {
        Ok(())
    }
}

fn map_create_error(error: std::io::Error) -> HelperError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        HelperError::precondition("target-exists", "target already exists")
    } else {
        HelperError::mutation(
            "create-failed",
            "not-applied",
            "new entry could not be created",
        )
    }
}
