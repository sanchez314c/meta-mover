use crate::protocol::{
    delete_receipt_bytes, failure_value, success_value, CapabilityPath, HelperError,
    NativeIdentity, Request, RootBinding, RootKind,
};
use serde_json::{json, Value};
use std::collections::HashMap;

#[cfg(unix)]
use crate::unix_backend::{self as backend, BoundRoot};
#[cfg(windows)]
use crate::windows_backend::{self as backend, BoundRoot};

enum Lifecycle {
    NeedHello,
    NeedBind,
    Ready,
    Closed,
}

pub struct Engine {
    lifecycle: Lifecycle,
    roots: HashMap<String, BoundRoot>,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            lifecycle: Lifecycle::NeedHello,
            roots: HashMap::new(),
        }
    }
}

impl Engine {
    pub fn handle(&mut self, request: Request) -> (Value, bool) {
        let id = request.id().to_owned();
        let result = self.dispatch(request);
        let close = matches!(self.lifecycle, Lifecycle::Closed);
        let response = match result {
            Ok(value) => success_value(&id, value),
            Err(error) => failure_value(&id, error),
        };
        (response, close)
    }

    fn dispatch(&mut self, request: Request) -> Result<Value, HelperError> {
        match self.lifecycle {
            Lifecycle::NeedHello => match request {
                Request::Hello { .. } => {
                    self.lifecycle = Lifecycle::NeedBind;
                    Ok(json!({
                        "outcome": "applied",
                        "protocol": 1,
                        "build": env!("CARGO_PKG_VERSION"),
                        "target": env!("META_MOVER_TARGET"),
                        "features": ["capability-relative", "no-follow", "no-replace", "sha256", "durable-sync"]
                    }))
                }
                _ => Err(HelperError::protocol(
                    "hello-required",
                    "hello must be the first accepted operation",
                )),
            },
            Lifecycle::NeedBind => match request {
                Request::BindRoots { roots, .. } => self.bind_roots(roots),
                _ => Err(HelperError::protocol(
                    "bind-roots-required",
                    "bind_roots must follow hello",
                )),
            },
            Lifecycle::Ready => self.dispatch_ready(request),
            Lifecycle::Closed => Err(HelperError::protocol("closed", "protocol is closed")),
        }
    }

    fn bind_roots(&mut self, bindings: Vec<RootBinding>) -> Result<Value, HelperError> {
        let mut opened = HashMap::new();
        let mut response_roots = Vec::with_capacity(bindings.len());
        for binding in bindings {
            let root = BoundRoot::open(&binding.absolute_path, binding.kind)?;
            response_roots.push(json!({
                "name": binding.name,
                "kind": binding.kind,
                "identity": root.identity()
            }));
            opened.insert(binding.name, root);
        }
        self.roots = opened;
        self.lifecycle = Lifecycle::Ready;
        Ok(json!({
            "outcome": "applied",
            "roots": response_roots,
            "durability": {"file": "not-applicable", "parents": []}
        }))
    }

    fn dispatch_ready(&mut self, request: Request) -> Result<Value, HelperError> {
        match request {
            Request::EnsureDirChain { path, .. } => {
                backend::ensure_dir_chain(self.root(&path.root)?, &path.components)
            }
            Request::StageCopy {
                source,
                target,
                expected,
                expected_sha256,
                ..
            } => backend::stage_copy(
                self.root(&source.root)?,
                &source.components,
                self.root(&target.root)?,
                &target.components,
                expected.as_ref(),
                expected_sha256.as_deref(),
            ),
            Request::WriteMarkerNew { path, contents, .. } => backend::write_marker_new(
                self.root(&path.root)?,
                &path.components,
                contents.as_bytes(),
            ),
            Request::HardLinkNoReplace {
                source,
                target,
                expected,
                ..
            } => backend::hard_link_no_replace(
                self.root(&source.root)?,
                &source.components,
                self.root(&target.root)?,
                &target.components,
                expected.as_ref(),
            ),
            Request::RenameNoReplace {
                source,
                target,
                expected,
                ..
            } => backend::rename_no_replace(
                self.root(&source.root)?,
                &source.components,
                self.root(&target.root)?,
                &target.components,
                expected.as_ref(),
            ),
            Request::RemoveManagedExact {
                id, path, expected, ..
            } => backend::remove_managed_exact(
                self.root(&path.root)?,
                &path.components,
                &expected,
                &id,
            ),
            Request::DeleteSourceExact {
                source,
                expected,
                expected_sha256,
                delete_id,
                receipt,
                ..
            } => {
                let receipt_root = self.control_root(&receipt.root)?;
                let receipt_bytes =
                    delete_receipt_bytes(&delete_id, &source, &expected, &expected_sha256);
                let spec = SourceDeleteSpec {
                    source_path: &source,
                    receipt_path: &receipt,
                    expected: &expected,
                    expected_sha256: &expected_sha256,
                    delete_id: &delete_id,
                    receipt_bytes: &receipt_bytes,
                };
                backend::delete_source_exact(self.root(&source.root)?, receipt_root, &spec)
            }
            Request::ReconcileSourceDelete {
                source,
                expected,
                expected_sha256,
                delete_id,
                receipt,
                ..
            } => {
                let receipt_root = self.control_root(&receipt.root)?;
                let receipt_bytes =
                    delete_receipt_bytes(&delete_id, &source, &expected, &expected_sha256);
                let spec = SourceDeleteSpec {
                    source_path: &source,
                    receipt_path: &receipt,
                    expected: &expected,
                    expected_sha256: &expected_sha256,
                    delete_id: &delete_id,
                    receipt_bytes: &receipt_bytes,
                };
                backend::reconcile_source_delete(self.root(&source.root)?, receipt_root, &spec)
            }
            Request::Close { .. } => {
                self.roots.clear();
                self.lifecycle = Lifecycle::Closed;
                Ok(json!({
                    "outcome": "applied",
                    "durability": {"file": "not-applicable", "parents": []}
                }))
            }
            Request::Hello { .. } | Request::BindRoots { .. } => Err(HelperError::protocol(
                "lifecycle-violation",
                "operation is not valid after root binding",
            )),
        }
    }

    fn root(&self, name: &str) -> Result<&BoundRoot, HelperError> {
        self.roots.get(name).ok_or_else(|| {
            HelperError::precondition("unknown-root", "path names an unbound root capability")
        })
    }

    fn control_root(&self, name: &str) -> Result<&BoundRoot, HelperError> {
        let root = self.root(name)?;
        if root.kind() != RootKind::Control {
            return Err(HelperError::precondition(
                "receipt-root-kind",
                "receipt root must be bound as control",
            ));
        }
        Ok(root)
    }
}

pub(crate) fn operation_result(
    before: Option<NativeIdentity>,
    after: Option<NativeIdentity>,
    sha256: Option<String>,
    file_synced: bool,
    parent_syncs: usize,
) -> Value {
    let mut result = serde_json::Map::new();
    result.insert("outcome".to_owned(), Value::String("applied".to_owned()));
    if let Some(before) = before {
        result.insert(
            "before".to_owned(),
            serde_json::to_value(before).expect("identity serializes"),
        );
    }
    if let Some(after) = after {
        result.insert(
            "after".to_owned(),
            serde_json::to_value(after).expect("identity serializes"),
        );
    }
    if let Some(sha256) = sha256 {
        result.insert("sha256".to_owned(), Value::String(sha256));
    }
    result.insert(
        "durability".to_owned(),
        json!({
            "file": if file_synced { "synced" } else { "not-applicable" },
            "parents": vec!["synced"; parent_syncs]
        }),
    );
    Value::Object(result)
}

pub(crate) struct SourceDeleteSpec<'a> {
    pub source_path: &'a CapabilityPath,
    pub receipt_path: &'a CapabilityPath,
    pub expected: &'a NativeIdentity,
    pub expected_sha256: &'a str,
    pub delete_id: &'a str,
    pub receipt_bytes: &'a [u8],
}

pub(crate) struct SourceDeleteResult<'a> {
    pub outcome: &'static str,
    pub state: &'static str,
    pub source_state: &'static str,
    pub quarantine_state: &'static str,
    pub receipt_state: &'static str,
    pub delete_id: &'a str,
    pub file_synced: bool,
    pub parent_syncs: usize,
}

pub(crate) fn source_delete_result(result: SourceDeleteResult<'_>) -> Value {
    json!({
        "outcome": result.outcome,
        "state": result.state,
        "sourceState": result.source_state,
        "quarantineState": result.quarantine_state,
        "receiptState": result.receipt_state,
        "deleteId": result.delete_id,
        "durability": {
            "file": if result.file_synced { "synced" } else { "not-applicable" },
            "parents": vec!["synced"; result.parent_syncs]
        }
    })
}

pub(crate) fn reconciliation_error(
    message: &'static str,
    source: &CapabilityPath,
    receipt: &CapabilityPath,
    delete_id: &str,
    source_state: &'static str,
    quarantine_state: &'static str,
    receipt_state: &'static str,
) -> HelperError {
    let mut quarantine_components = source.components[..source.components.len() - 1].to_vec();
    quarantine_components.push(format!(".meta-mover-delete-{}", delete_id.replace('-', "")));
    let mut entry_components = quarantine_components.clone();
    entry_components.push("entry".to_owned());
    HelperError::reconciliation(
        message,
        json!({
            "deleteId": delete_id,
            "sourceState": source_state,
            "quarantineState": quarantine_state,
            "receiptState": receipt_state,
            "relativeResidue": {
                "source": source,
                "quarantine": {
                    "root": source.root,
                    "components": quarantine_components
                },
                "entry": {
                    "root": source.root,
                    "components": entry_components
                },
                "receipt": receipt
            }
        }),
    )
}
