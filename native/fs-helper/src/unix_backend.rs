use crate::engine::{
    operation_result, reconciliation_error, source_delete_result, SourceDeleteResult,
    SourceDeleteSpec,
};
use crate::protocol::{CapabilityPath, HelperError, NativeIdentity, RootKind};
use cap_std::fs::Dir as CapDir;
use rustix::fs::{
    fstat, fsync, linkat, mkdirat, openat, renameat_with, unlinkat, AtFlags, Mode, OFlags,
    RenameFlags, CWD,
};
use rustix::io::Errno;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};

pub struct BoundRoot {
    directory: File,
    identity: NativeIdentity,
    #[allow(dead_code)]
    kind: RootKind,
}

impl BoundRoot {
    pub fn open(absolute_path: &str, kind: RootKind) -> Result<Self, HelperError> {
        let fd = openat(
            CWD,
            absolute_path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| {
            HelperError::precondition(
                "root-open-failed",
                "bound root is not an accessible real directory",
            )
        })?;
        let directory = File::from(fd);
        let identity = identity_of(&directory)?;
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
            Err(error) if error.raw_os_error() == Some(Errno::NOENT.raw_os_error()) => {
                mkdirat(&current, component, Mode::RWXU).map_err(|errno| {
                    if errno == Errno::EXIST {
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
                fsync(&current).map_err(|_| {
                    HelperError::durability("created directory parent could not be synced")
                })?;
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
    let identity = identity_of(&current)?;
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
    let source = open_regular(&source_parent, source_name)?;
    let before = identity_of(&source)?;
    verify_expected(expected, &before)?;

    let (target_parent, target_name) = open_parent(target_root, target_components)?;
    let target_fd = openat(
        &target_parent,
        target_name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(map_create_error)?;
    let mut target = File::from(target_fd);
    let created_identity = identity_of(&target)?;

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
        let after_source = identity_of(&source)?;
        if after_source != before {
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
        fsync(&target_parent)
            .map_err(|_| HelperError::durability("staging parent could not be synced"))?;
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
            cleanup_created(&target_parent, target_name, &created_identity)?;
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
    let fd = openat(
        &parent,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(map_create_error)?;
    let mut file = File::from(fd);
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
    fsync(&parent).map_err(|_| HelperError::durability("marker parent could not be synced"))?;
    let after = identity_of(&file)?;
    Ok(operation_result(None, Some(after), None, true, 1))
}

pub fn hard_link_no_replace(
    source_root: &BoundRoot,
    source_components: &[String],
    target_root: &BoundRoot,
    target_components: &[String],
    expected: Option<&NativeIdentity>,
) -> Result<Value, HelperError> {
    let (source_parent, source_name) = open_parent(source_root, source_components)?;
    let source = open_regular(&source_parent, source_name)?;
    let before = identity_of(&source)?;
    verify_expected(expected, &before)?;
    let (target_parent, target_name) = open_parent(target_root, target_components)?;
    linkat(
        &source_parent,
        source_name,
        &target_parent,
        target_name,
        AtFlags::empty(),
    )
    .map_err(map_create_error)?;
    let target = open_regular(&target_parent, target_name).map_err(|_| {
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
    fsync(&target_parent)
        .map_err(|_| HelperError::durability("hard-link parent could not be synced"))?;
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
    let source = open_regular(&source_parent, source_name)?;
    let before = identity_of(&source)?;
    verify_expected(expected, &before)?;
    let (target_parent, target_name) = open_parent(target_root, target_components)?;
    renameat_with(
        &source_parent,
        source_name,
        &target_parent,
        target_name,
        RenameFlags::NOREPLACE,
    )
    .map_err(map_rename_error)?;
    let target = open_regular(&target_parent, target_name).map_err(|_| {
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
    fsync(&source_parent)
        .map_err(|_| HelperError::durability("source parent could not be synced after rename"))?;
    fsync(&target_parent)
        .map_err(|_| HelperError::durability("target parent could not be synced after rename"))?;
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
    let source = open_regular(&source_parent, source_name)?;
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
    if let Err(error) = renameat_with(
        &source_parent,
        source_name,
        &quarantine,
        "entry",
        RenameFlags::NOREPLACE,
    ) {
        verify_visible_source(&source_parent, source_name, &before)?;
        drop(quarantine);
        remove_empty_quarantine(&source_parent, &quarantine_name)?;
        return Err(map_rename_error(error));
    }

    let quarantined = open_regular(&quarantine, "entry").map_err(|_| {
        reconciliation_error(
            "quarantined entry could not be reopened",
            source_path,
            receipt_path,
            delete_id,
            "absent",
            "unreadable",
            "absent",
        )
    })?;
    if identity_of(&quarantined)? != before || hash_file(&quarantined)? != expected_sha256 {
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
    unlinkat(&quarantine, "entry", AtFlags::empty()).map_err(|_| {
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
    drop(quarantined);
    fsync(&quarantine).map_err(|_| {
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
    unlinkat(&source_parent, &quarantine_name, AtFlags::REMOVEDIR).map_err(|_| {
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
    fsync(&source_parent).map_err(|_| {
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
                fsync(&source_parent).map_err(|_| {
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
                unlinkat(&source_parent, &quarantine_name, AtFlags::REMOVEDIR).map_err(|_| {
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
                fsync(&source_parent).map_err(|_| {
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
                fsync(&quarantine).map_err(|_| {
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
                unlinkat(&source_parent, &quarantine_name, AtFlags::REMOVEDIR).map_err(|_| {
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
                fsync(&source_parent).map_err(|_| {
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
            unlinkat(&directory, "entry", AtFlags::empty()).map_err(|_| {
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
            drop(entry);
            fsync(&directory).map_err(|_| {
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
            unlinkat(&source_parent, &quarantine_name, AtFlags::REMOVEDIR).map_err(|_| {
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
            fsync(&source_parent).map_err(|_| {
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
    Empty(File),
    EntryExpected { directory: File, entry: File },
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
    parent: &File,
    name: &str,
    expected: &NativeIdentity,
    expected_sha256: &str,
) -> SourceObservation {
    let file = match open_entry_nofollow(parent, name) {
        Ok(file) => file,
        Err(Errno::NOENT) => return SourceObservation::Absent,
        Err(Errno::LOOP) => return SourceObservation::Special,
        Err(_) => return SourceObservation::Unreadable,
    };
    match fstat(&file) {
        Ok(stat) if stat.st_mode & libc::S_IFMT != libc::S_IFREG => SourceObservation::Special,
        Ok(_) => match (identity_of(&file), hash_file(&file)) {
            (Ok(identity), Ok(digest)) if &identity == expected && digest == expected_sha256 => {
                SourceObservation::Expected
            }
            (Ok(_), Ok(_)) => SourceObservation::Other,
            _ => SourceObservation::Unreadable,
        },
        Err(_) => SourceObservation::Unreadable,
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
    let mut file = match open_entry_nofollow(&parent, name) {
        Ok(file) => file,
        Err(Errno::NOENT) => return ReceiptObservation::Absent,
        Err(Errno::LOOP) => return ReceiptObservation::Special,
        Err(_) => return ReceiptObservation::Unreadable,
    };
    let before = match identity_of(&file) {
        Ok(identity) => identity,
        Err(_) => return ReceiptObservation::Unreadable,
    };
    if !matches!(fstat(&file), Ok(stat) if stat.st_mode & libc::S_IFMT == libc::S_IFREG) {
        return ReceiptObservation::Special;
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
    parent: &File,
    name: &str,
    expected: &NativeIdentity,
    expected_sha256: &str,
) -> QuarantineObservation {
    let directory = match open_directory(parent, name) {
        Ok(directory) => directory,
        Err(error) if error.raw_os_error() == Some(Errno::NOENT.raw_os_error()) => {
            return QuarantineObservation::Absent
        }
        Err(error) if error.raw_os_error() == Some(Errno::LOOP.raw_os_error()) => {
            return QuarantineObservation::Special
        }
        Err(error) if error.raw_os_error() == Some(Errno::NOTDIR.raw_os_error()) => {
            return QuarantineObservation::Special
        }
        Err(_) => return QuarantineObservation::Unreadable,
    };
    let listing = match directory.try_clone() {
        Ok(directory) => CapDir::from_std_file(directory),
        Err(_) => return QuarantineObservation::Unreadable,
    };
    let entries = match listing.entries() {
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
    let entry = match open_entry_nofollow(&directory, "entry") {
        Ok(entry) => entry,
        Err(Errno::LOOP) => return QuarantineObservation::EntrySpecial,
        Err(_) => return QuarantineObservation::Unreadable,
    };
    match fstat(&entry) {
        Ok(stat) if stat.st_mode & libc::S_IFMT != libc::S_IFREG => {
            QuarantineObservation::EntrySpecial
        }
        Ok(_) => match (identity_of(&entry), hash_file(&entry)) {
            (Ok(identity), Ok(digest)) if &identity == expected && digest == expected_sha256 => {
                QuarantineObservation::EntryExpected { directory, entry }
            }
            (Ok(_), Ok(_)) => QuarantineObservation::EntryOther,
            _ => QuarantineObservation::Unreadable,
        },
        Err(_) => QuarantineObservation::Unreadable,
    }
}

fn open_entry_nofollow(parent: &File, name: &str) -> Result<File, Errno> {
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
}

fn create_receipt_new(root: &BoundRoot, path: &CapabilityPath, contents: &[u8]) -> Result<(), ()> {
    let (parent, name) = open_parent(root, &path.components).map_err(|_| ())?;
    let fd = openat(
        &parent,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|_| ())?;
    let mut file = File::from(fd);
    file.write_all(contents).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    fsync(&parent).map_err(|_| ())?;
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
        open_entry_nofollow(&source_parent, source_name),
        open_entry_nofollow(&receipt_parent, receipt_name),
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
    let source = open_regular(&source_parent, source_name)?;
    let before = identity_of(&source)?;
    verify_expected(Some(expected), &before)?;
    if let Some(expected_digest) = expected_sha256 {
        let digest = hash_file(&source)?;
        if digest != expected_digest {
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
    if let Err(error) = renameat_with(
        &source_parent,
        source_name,
        &quarantine,
        entry_name,
        RenameFlags::NOREPLACE,
    ) {
        verify_visible_source(&source_parent, source_name, &before)?;
        remove_empty_quarantine(&source_parent, &quarantine_name)?;
        return Err(map_rename_error(error));
    }

    let quarantined = open_regular(&quarantine, entry_name).map_err(|_| {
        HelperError::mutation(
            "quarantine-reopen-failed",
            "unknown",
            "quarantined entry could not be reopened",
        )
    })?;
    let after = identity_of(&quarantined)?;
    if !same_object(&before, &after) {
        return Err(HelperError::mutation(
            "source-race",
            "unknown",
            "quarantined entry does not match the opened source",
        ));
    }
    if let Some(expected_digest) = expected_sha256 {
        let digest = hash_file(&quarantined)?;
        if digest != expected_digest {
            return Err(HelperError::mutation(
                "quarantine-hash-mismatch",
                "unknown",
                "quarantined content does not match the expected digest",
            ));
        }
    }
    unlinkat(&quarantine, entry_name, AtFlags::empty()).map_err(|_| {
        HelperError::mutation(
            "quarantine-unlink-failed",
            "unknown",
            "verified quarantine entry could not be unlinked",
        )
    })?;
    fsync(&quarantine)
        .map_err(|_| HelperError::durability("quarantine directory could not be synced"))?;
    unlinkat(&source_parent, &quarantine_name, AtFlags::REMOVEDIR).map_err(|_| {
        HelperError::mutation(
            "quarantine-remove-failed",
            "unknown",
            "empty quarantine directory could not be removed",
        )
    })?;
    fsync(&source_parent)
        .map_err(|_| HelperError::durability("source parent could not be synced after deletion"))?;
    Ok(operation_result(Some(before), None, None, false, 2))
}

fn open_parent<'a>(
    root: &BoundRoot,
    components: &'a [String],
) -> Result<(File, &'a str), HelperError> {
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

fn open_directory(parent: &File, name: &str) -> std::io::Result<File> {
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(std::io::Error::from)
}

fn open_regular(parent: &File, name: &str) -> Result<File, HelperError> {
    let fd = openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| {
        HelperError::precondition("unsafe-file", "entry is missing, linked, or inaccessible")
    })?;
    let file = File::from(fd);
    let stat = fstat(&file)
        .map_err(|_| HelperError::precondition("stat-failed", "entry identity is unavailable"))?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(HelperError::precondition(
            "not-regular-file",
            "entry is not a regular file",
        ));
    }
    Ok(file)
}

fn identity_of(file: &File) -> Result<NativeIdentity, HelperError> {
    let stat = fstat(file)
        .map_err(|_| HelperError::precondition("stat-failed", "native identity is unavailable"))?;
    let mtime_ns = i128::from(stat.st_mtime) * 1_000_000_000_i128 + i128::from(stat.st_mtime_nsec);
    Ok(NativeIdentity::Unix {
        device: stat.st_dev.to_string(),
        inode: stat.st_ino.to_string(),
        links: stat.st_nlink.to_string(),
        size: stat.st_size.to_string(),
        mtime_ns: mtime_ns.to_string(),
    })
}

fn same_object(left: &NativeIdentity, right: &NativeIdentity) -> bool {
    match (left, right) {
        (
            NativeIdentity::Unix {
                device: left_device,
                inode: left_inode,
                ..
            },
            NativeIdentity::Unix {
                device: right_device,
                inode: right_inode,
                ..
            },
        ) => left_device == right_device && left_inode == right_inode,
        _ => false,
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

fn cleanup_created(parent: &File, name: &str, created: &NativeIdentity) -> Result<(), HelperError> {
    let visible = open_regular(parent, name).map_err(|_| {
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
    unlinkat(parent, name, AtFlags::empty()).map_err(|_| {
        HelperError::mutation(
            "cleanup-unlink-failed",
            "unknown",
            "new entry could not be removed after failure",
        )
    })?;
    fsync(parent).map_err(|_| HelperError::durability("cleanup parent could not be synced"))?;
    Ok(())
}

fn create_private_directory(parent: &File, request_id: &str) -> Result<String, HelperError> {
    let name = format!(".meta-mover-delete-{}", request_id.replace('-', ""));
    match mkdirat(parent, &name, Mode::RWXU) {
        Ok(()) => Ok(name),
        Err(Errno::EXIST) => Err(HelperError::delete_reconciliation(
            "request quarantine already exists and requires reconciliation",
        )),
        Err(_) => Err(HelperError::mutation(
            "quarantine-create-failed",
            "not-applied",
            "private quarantine directory could not be created",
        )),
    }
}

fn remove_empty_quarantine(parent: &File, name: &str) -> Result<(), HelperError> {
    unlinkat(parent, name, AtFlags::REMOVEDIR).map_err(|_| {
        HelperError::mutation(
            "quarantine-cleanup-failed",
            "unknown",
            "empty request quarantine could not be removed",
        )
    })?;
    fsync(parent).map_err(|_| HelperError::durability("quarantine cleanup could not be synced"))
}

fn verify_visible_source(
    parent: &File,
    name: &str,
    expected: &NativeIdentity,
) -> Result<(), HelperError> {
    let visible = open_regular(parent, name).map_err(|_| {
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

fn map_create_error(error: Errno) -> HelperError {
    if error == Errno::EXIST {
        HelperError::precondition("target-exists", "target already exists")
    } else {
        HelperError::mutation(
            "create-failed",
            "not-applied",
            "new entry could not be created",
        )
    }
}

fn map_rename_error(error: Errno) -> HelperError {
    match error {
        Errno::EXIST | Errno::NOTEMPTY => {
            HelperError::precondition("target-exists", "target already exists")
        }
        Errno::XDEV => HelperError::precondition(
            "cross-device",
            "source and target are on different filesystems",
        ),
        _ => HelperError::mutation("rename-failed", "not-applied", "no-replace rename failed"),
    }
}
