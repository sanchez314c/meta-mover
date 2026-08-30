use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const NIL_ID: &str = "00000000-0000-0000-0000-000000000000";
const MAX_DEPTH: usize = 16;
const MAX_ARRAY_ITEMS: usize = 256;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RootBinding {
    pub name: String,
    pub kind: RootKind,
    pub absolute_path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RootKind {
    Source,
    Destination,
    Control,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityPath {
    pub root: String,
    pub components: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "lowercase")]
pub enum NativeIdentity {
    Unix {
        device: String,
        inode: String,
        links: String,
        size: String,
        #[serde(rename = "mtimeNs")]
        mtime_ns: String,
    },
    Windows {
        #[serde(rename = "volumeSerial")]
        volume_serial: String,
        #[serde(rename = "fileId")]
        file_id: String,
        links: String,
        size: String,
        #[serde(rename = "mtimeNs")]
        mtime_ns: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "hello")]
    Hello { v: u8, id: String },
    #[serde(rename = "bind_roots")]
    BindRoots {
        v: u8,
        id: String,
        roots: Vec<RootBinding>,
    },
    #[serde(rename = "ensure_dir_chain")]
    EnsureDirChain {
        v: u8,
        id: String,
        path: CapabilityPath,
    },
    #[serde(rename = "stage_copy")]
    StageCopy {
        v: u8,
        id: String,
        source: CapabilityPath,
        target: CapabilityPath,
        expected: Option<NativeIdentity>,
        #[serde(rename = "expectedSha256")]
        expected_sha256: Option<String>,
    },
    #[serde(rename = "write_marker_new")]
    WriteMarkerNew {
        v: u8,
        id: String,
        path: CapabilityPath,
        contents: String,
    },
    #[serde(rename = "hard_link_no_replace")]
    HardLinkNoReplace {
        v: u8,
        id: String,
        source: CapabilityPath,
        target: CapabilityPath,
        expected: Option<NativeIdentity>,
    },
    #[serde(rename = "rename_no_replace")]
    RenameNoReplace {
        v: u8,
        id: String,
        source: CapabilityPath,
        target: CapabilityPath,
        expected: Option<NativeIdentity>,
    },
    #[serde(rename = "remove_managed_exact")]
    RemoveManagedExact {
        v: u8,
        id: String,
        path: CapabilityPath,
        expected: NativeIdentity,
    },
    #[serde(rename = "delete_source_exact")]
    DeleteSourceExact {
        v: u8,
        id: String,
        source: CapabilityPath,
        expected: NativeIdentity,
        #[serde(rename = "expectedSha256")]
        expected_sha256: String,
        #[serde(rename = "deleteId")]
        delete_id: String,
        receipt: CapabilityPath,
    },
    #[serde(rename = "reconcile_source_delete")]
    ReconcileSourceDelete {
        v: u8,
        id: String,
        source: CapabilityPath,
        expected: NativeIdentity,
        #[serde(rename = "expectedSha256")]
        expected_sha256: String,
        #[serde(rename = "deleteId")]
        delete_id: String,
        receipt: CapabilityPath,
    },
    #[serde(rename = "close")]
    Close { v: u8, id: String },
}

impl Request {
    pub fn id(&self) -> &str {
        match self {
            Self::Hello { id, .. }
            | Self::BindRoots { id, .. }
            | Self::EnsureDirChain { id, .. }
            | Self::StageCopy { id, .. }
            | Self::WriteMarkerNew { id, .. }
            | Self::HardLinkNoReplace { id, .. }
            | Self::RenameNoReplace { id, .. }
            | Self::RemoveManagedExact { id, .. }
            | Self::DeleteSourceExact { id, .. }
            | Self::ReconcileSourceDelete { id, .. }
            | Self::Close { id, .. } => id,
        }
    }

    pub fn version(&self) -> u8 {
        match self {
            Self::Hello { v, .. }
            | Self::BindRoots { v, .. }
            | Self::EnsureDirChain { v, .. }
            | Self::StageCopy { v, .. }
            | Self::WriteMarkerNew { v, .. }
            | Self::HardLinkNoReplace { v, .. }
            | Self::RenameNoReplace { v, .. }
            | Self::RemoveManagedExact { v, .. }
            | Self::DeleteSourceExact { v, .. }
            | Self::ReconcileSourceDelete { v, .. }
            | Self::Close { v, .. } => *v,
        }
    }

    pub fn validate(&self) -> Result<(), HelperError> {
        if self.version() != 1 {
            return Err(HelperError::validation(
                "unsupported-version",
                "protocol version must be 1",
            ));
        }
        if !is_canonical_uuid(self.id()) {
            return Err(HelperError::validation(
                "invalid-id",
                "id must be a lowercase canonical UUID",
            ));
        }
        match self {
            Self::BindRoots { roots, .. } => validate_roots(roots),
            Self::EnsureDirChain { path, .. } | Self::WriteMarkerNew { path, .. } => {
                validate_capability_path(path)
            }
            Self::StageCopy {
                source,
                target,
                expected,
                expected_sha256,
                ..
            } => {
                validate_capability_path(source)?;
                validate_capability_path(target)?;
                if let Some(expected) = expected {
                    validate_identity(expected)?;
                }
                validate_optional_sha256(expected_sha256.as_deref())
            }
            Self::HardLinkNoReplace {
                source,
                target,
                expected,
                ..
            }
            | Self::RenameNoReplace {
                source,
                target,
                expected,
                ..
            } => {
                validate_capability_path(source)?;
                validate_capability_path(target)?;
                if let Some(expected) = expected {
                    validate_identity(expected)?;
                }
                Ok(())
            }
            Self::RemoveManagedExact { path, expected, .. } => {
                validate_capability_path(path)?;
                validate_identity(expected)
            }
            Self::DeleteSourceExact {
                id,
                source,
                expected,
                expected_sha256,
                delete_id,
                receipt,
                ..
            }
            | Self::ReconcileSourceDelete {
                id,
                source,
                expected,
                expected_sha256,
                delete_id,
                receipt,
                ..
            } => {
                validate_capability_path(source)?;
                validate_capability_path(receipt)?;
                validate_identity(expected)?;
                validate_sha256(expected_sha256)?;
                if !is_canonical_uuid(delete_id) {
                    return Err(HelperError::validation(
                        "invalid-delete-id",
                        "deleteId must be a lowercase canonical UUID v4",
                    ));
                }
                if delete_id == id {
                    return Err(HelperError::validation(
                        "delete-id-reused",
                        "deleteId must differ from the transport id",
                    ));
                }
                Ok(())
            }
            Self::Hello { .. } | Self::Close { .. } => Ok(()),
        }
    }
}

#[derive(Debug)]
pub struct HelperError {
    pub code: &'static str,
    pub phase: &'static str,
    pub outcome: &'static str,
    pub retryable: bool,
    pub message: String,
    pub details: Option<Value>,
}

impl HelperError {
    pub fn validation(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            phase: "validation",
            outcome: "not-applied",
            retryable: false,
            message: message.into(),
            details: None,
        }
    }

    pub fn protocol(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            phase: "protocol",
            outcome: "not-applied",
            retryable: false,
            message: message.into(),
            details: None,
        }
    }

    pub fn precondition(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            phase: "precondition",
            outcome: "not-applied",
            retryable: false,
            message: message.into(),
            details: None,
        }
    }

    pub fn mutation(code: &'static str, outcome: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            phase: "mutation",
            outcome,
            retryable: false,
            message: message.into(),
            details: None,
        }
    }

    pub fn durability(message: impl Into<String>) -> Self {
        Self {
            code: "durability-failed",
            phase: "durability",
            outcome: "unknown",
            retryable: false,
            message: message.into(),
            details: None,
        }
    }

    pub fn reconciliation(message: impl Into<String>, details: Value) -> Self {
        Self {
            code: "reconciliation-required",
            phase: "precondition",
            outcome: "unknown",
            retryable: false,
            message: message.into(),
            details: Some(details),
        }
    }

    pub fn delete_reconciliation(message: impl Into<String>) -> Self {
        Self {
            code: "reconciliation-required",
            phase: "precondition",
            outcome: "unknown",
            retryable: false,
            message: message.into(),
            details: None,
        }
    }
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, (String, HelperError)> {
    let fallback_id = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned))
        .filter(|id| is_canonical_uuid(id))
        .unwrap_or_else(|| NIL_ID.to_owned());
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        (
            fallback_id.clone(),
            HelperError::validation("invalid-json", "request must be valid UTF-8 JSON"),
        )
    })?;
    validate_shape(&value, 0).map_err(|error| (fallback_id.clone(), error))?;
    let request: Request = serde_json::from_slice(bytes).map_err(|_| {
        (
            fallback_id.clone(),
            HelperError::validation(
                "invalid-schema",
                "request does not match the operation schema",
            ),
        )
    })?;
    request.validate().map_err(|error| (fallback_id, error))?;
    Ok(request)
}

pub fn success_value(id: &str, result: Value) -> Value {
    json!({"v": 1, "id": id, "ok": true, "result": result})
}

pub fn failure_value(id: &str, error: HelperError) -> Value {
    let mut response = json!({
        "v": 1,
        "id": id,
        "ok": false,
        "error": {
            "code": error.code,
            "phase": error.phase,
            "outcome": error.outcome,
            "retryable": error.retryable,
            "message": error.message
        }
    });
    if let Some(details) = error.details {
        response["error"]["details"] = details;
    }
    response
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteReceipt<'a> {
    protocol: u8,
    delete_id: &'a str,
    source: &'a CapabilityPath,
    expected: &'a NativeIdentity,
    expected_sha256: &'a str,
}

pub(crate) fn delete_receipt_bytes(
    delete_id: &str,
    source: &CapabilityPath,
    expected: &NativeIdentity,
    expected_sha256: &str,
) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&DeleteReceipt {
        protocol: 1,
        delete_id,
        source,
        expected,
        expected_sha256,
    })
    .expect("delete receipt serializes");
    bytes.push(b'\n');
    bytes
}

pub fn protocol_failure(id: &str, code: &'static str, message: &'static str) -> Value {
    failure_value(id, HelperError::protocol(code, message))
}

fn validate_shape(value: &Value, depth: usize) -> Result<(), HelperError> {
    if depth > MAX_DEPTH {
        return Err(HelperError::validation(
            "json-too-deep",
            "JSON nesting exceeds 16 levels",
        ));
    }
    match value {
        Value::Array(items) => {
            if items.len() > MAX_ARRAY_ITEMS {
                return Err(HelperError::validation(
                    "array-too-large",
                    "array exceeds 256 items",
                ));
            }
            for item in items {
                validate_shape(item, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            for value in fields.values() {
                validate_shape(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_roots(roots: &[RootBinding]) -> Result<(), HelperError> {
    if roots.is_empty() || roots.len() > MAX_ARRAY_ITEMS {
        return Err(HelperError::validation(
            "invalid-roots",
            "roots must contain 1 to 256 bindings",
        ));
    }
    let mut names = HashSet::new();
    for root in roots {
        if !is_root_name(&root.name) || !names.insert(root.name.as_str()) {
            return Err(HelperError::validation(
                "invalid-root-name",
                "root names must be unique safe identifiers",
            ));
        }
        if !std::path::Path::new(&root.absolute_path).is_absolute()
            || root.absolute_path.contains('\0')
        {
            return Err(HelperError::validation(
                "invalid-root-path",
                "bound root path must be absolute",
            ));
        }
    }
    Ok(())
}

pub fn validate_capability_path(path: &CapabilityPath) -> Result<(), HelperError> {
    if !is_root_name(&path.root) {
        return Err(HelperError::validation(
            "invalid-root-name",
            "path root is not a safe identifier",
        ));
    }
    if path.components.is_empty() || path.components.len() > MAX_ARRAY_ITEMS {
        return Err(HelperError::validation(
            "invalid-components",
            "path must have 1 to 256 components",
        ));
    }
    for component in &path.components {
        if !is_safe_component(component) {
            return Err(HelperError::validation(
                "unsafe-component",
                "path component is unsafe",
            ));
        }
    }
    Ok(())
}

fn is_safe_component(component: &str) -> bool {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.contains('\0')
        || component.contains('/')
        || component.contains('\\')
        || component.contains(':')
        || component.ends_with('.')
        || component.ends_with(' ')
    {
        return false;
    }
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches(['.', ' ']);
    let upper = stem.to_ascii_uppercase();
    !matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'))
}

fn is_root_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z'))
        && name.len() <= 64
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes()[14] == b'4'
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn validate_identity(identity: &NativeIdentity) -> Result<(), HelperError> {
    let valid = match identity {
        NativeIdentity::Unix {
            device,
            inode,
            links,
            size,
            mtime_ns,
        } => {
            cfg!(unix)
                && [device, inode, links, size]
                    .into_iter()
                    .all(|value| is_unsigned_decimal(value))
                && is_signed_decimal(mtime_ns)
        }
        NativeIdentity::Windows {
            volume_serial,
            file_id,
            links,
            size,
            mtime_ns,
        } => {
            cfg!(windows)
                && [volume_serial, file_id, links, size]
                    .into_iter()
                    .all(|value| is_unsigned_decimal(value))
                && is_signed_decimal(mtime_ns)
        }
    };
    if valid {
        Ok(())
    } else {
        Err(HelperError::validation(
            "invalid-identity",
            "native identity must match the target platform and decimal field schema",
        ))
    }
}

fn is_unsigned_decimal(value: &str) -> bool {
    value == "0"
        || value
            .strip_prefix(|character: char| matches!(character, '1'..='9'))
            .is_some_and(|tail| tail.bytes().all(|byte| byte.is_ascii_digit()))
}

fn is_signed_decimal(value: &str) -> bool {
    is_unsigned_decimal(value)
        || value
            .strip_prefix('-')
            .is_some_and(|magnitude| magnitude != "0" && is_unsigned_decimal(magnitude))
}

fn validate_optional_sha256(value: Option<&str>) -> Result<(), HelperError> {
    match value {
        Some(value) => validate_sha256(value),
        None => Ok(()),
    }
}

fn validate_sha256(value: &str) -> Result<(), HelperError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(HelperError::validation(
            "invalid-sha256",
            "SHA-256 must be 64 lowercase hexadecimal characters",
        ))
    }
}
