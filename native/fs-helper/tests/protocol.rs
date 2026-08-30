use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct TempTree(PathBuf);

impl TempTree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "meta-mover-fs-helper-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create isolated test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Helper {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_meta-mover-fs-helper"))
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn helper");
        let stdin = child.stdin.take().expect("helper stdin");
        let stdout = BufReader::new(child.stdout.take().expect("helper stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
        }
    }

    fn raw(&mut self, line: &[u8]) -> Value {
        let stdin = self.stdin.as_mut().expect("helper input remains open");
        stdin.write_all(line).expect("write request");
        stdin.write_all(b"\n").expect("terminate request");
        stdin.flush().expect("flush request");
        let mut response = String::new();
        self.stdout.read_line(&mut response).expect("read response");
        assert!(!response.is_empty(), "helper closed without responding");
        serde_json::from_str(&response).expect("response JSON")
    }

    fn request(&mut self, request: Value) -> Value {
        self.raw(serde_json::to_string(&request).unwrap().as_bytes())
    }

    fn send_without_wait(&mut self, request: Value) {
        let stdin = self.stdin.as_mut().expect("helper input remains open");
        stdin
            .write_all(serde_json::to_string(&request).unwrap().as_bytes())
            .expect("write request");
        stdin.write_all(b"\n").expect("terminate request");
        stdin.flush().expect("flush request");
    }

    fn send_eof_without_newline(&mut self, request: Value) -> usize {
        let mut stdin = self.stdin.take().expect("helper input remains open");
        stdin
            .write_all(serde_json::to_string(&request).unwrap().as_bytes())
            .expect("write unterminated request");
        stdin.flush().expect("flush unterminated request");
        drop(stdin);
        let mut response = String::new();
        let bytes = self.stdout.read_line(&mut response).expect("read EOF");
        self.child.wait().expect("helper exits on EOF");
        bytes
    }

    fn terminate_exact_child(&mut self) {
        self.child
            .kill()
            .expect("terminate exact test-owned helper child");
        self.child
            .wait()
            .expect("reap exact test-owned helper child");
        self.stdin.take();
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(
                b"{\"v\":1,\"id\":\"00000000-0000-4000-8000-ffffffffffff\",\"op\":\"close\"}\n",
            );
            let _ = stdin.flush();
            drop(stdin);
        }
        let _ = self.child.wait();
    }
}

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn hello(helper: &mut Helper) {
    let response = helper.request(json!({"v": 1, "id": id(1), "op": "hello"}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["protocol"], 1);
}

fn bind(helper: &mut Helper, tree: &TempTree) -> Value {
    fs::create_dir_all(tree.path().join("receipts")).expect("create receipt parent");
    helper.request(json!({
        "v": 1,
        "id": id(2),
        "op": "bind_roots",
        "roots": [
            {"name": "source", "kind": "source", "absolutePath": tree.path()},
            {"name": "destination", "kind": "destination", "absolutePath": tree.path()},
            {"name": "control", "kind": "control", "absolutePath": tree.path()}
        ]
    }))
}

fn quarantine_path(tree: &TempTree, delete_id: &str) -> PathBuf {
    tree.path()
        .join("incoming")
        .join(format!(".meta-mover-delete-{}", delete_id.replace('-', "")))
}

fn receipt(n: u32) -> Value {
    json!({"root": "control", "components": ["receipts", format!("{n}.json")]})
}

fn receipt_path(tree: &TempTree, n: u32) -> PathBuf {
    tree.path().join("receipts").join(format!("{n}.json"))
}

fn receipt_bytes(delete_id: &str, expected: &Value, expected_sha256: &Value) -> Vec<u8> {
    let expected_json = if expected["kind"] == "unix" {
        format!(
            "{{\"kind\":\"unix\",\"device\":{},\"inode\":{},\"links\":{},\"size\":{},\"mtimeNs\":{}}}",
            expected["device"],
            expected["inode"],
            expected["links"],
            expected["size"],
            expected["mtimeNs"]
        )
    } else {
        format!(
            "{{\"kind\":\"windows\",\"volumeSerial\":{},\"fileId\":{},\"links\":{},\"size\":{},\"mtimeNs\":{}}}",
            expected["volumeSerial"],
            expected["fileId"],
            expected["links"],
            expected["size"],
            expected["mtimeNs"]
        )
    };
    format!(
        "{{\"protocol\":1,\"deleteId\":{},\"source\":{{\"root\":\"source\",\"components\":[\"incoming\",\"photo.jpg\"]}},\"expected\":{},\"expectedSha256\":{}}}\n",
        serde_json::to_string(delete_id).unwrap(),
        expected_json,
        expected_sha256
    )
    .into_bytes()
}

#[test]
fn strict_protocol_rejects_oversize_duplicate_unknown_and_bad_lifecycle() {
    let mut helper = Helper::spawn();
    let out_of_order = helper.request(json!({"v": 1, "id": id(1), "op": "close"}));
    assert_eq!(out_of_order["ok"], false);
    assert_eq!(out_of_order["error"]["phase"], "protocol");

    let duplicate = helper.raw(
        format!(
            "{{\"v\":1,\"id\":\"{}\",\"op\":\"hello\",\"op\":\"close\"}}",
            id(2)
        )
        .as_bytes(),
    );
    assert_eq!(duplicate["ok"], false);
    assert_eq!(duplicate["error"]["phase"], "validation");

    let unknown = helper.request(json!({"v": 1, "id": id(3), "op": "hello", "extra": 1}));
    assert_eq!(unknown["ok"], false);
    assert_eq!(unknown["error"]["phase"], "validation");

    let non_random_id = helper.request(json!({
        "v": 1,
        "id": "00000000-0000-1000-0000-000000000004",
        "op": "hello"
    }));
    assert_eq!(non_random_id["ok"], false);
    assert_eq!(non_random_id["error"]["code"], "invalid-id");

    let oversize = helper.raw(&vec![b'x'; 65_536]);
    assert_eq!(oversize["ok"], false);
    assert_eq!(oversize["error"]["code"], "line-too-large");
}

#[test]
fn eof_discards_an_unterminated_request_without_executing_it() {
    let mut helper = Helper::spawn();
    assert_eq!(
        helper.send_eof_without_newline(json!({"v": 1, "id": id(1), "op": "hello"})),
        0
    );
}

#[test]
fn bind_roots_is_single_use_and_never_echoes_absolute_paths() {
    let tree = TempTree::new();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    let first = bind(&mut helper, &tree);
    assert_eq!(first["ok"], true);
    assert_eq!(first["result"]["roots"].as_array().unwrap().len(), 3);
    assert!(!first.to_string().contains(tree.path().to_str().unwrap()));
    let second = bind(&mut helper, &tree);
    assert_eq!(second["ok"], false);
    assert_eq!(second["error"]["phase"], "protocol");
}

#[test]
fn hostile_components_and_symlink_traversal_are_rejected() {
    let tree = TempTree::new();
    #[cfg(unix)]
    let outside = TempTree::new();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), tree.path().join("escape")).unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);

    for component in [
        "", ".", "..", "a/b", "a\\b", "CON", "file:ads", "name.", "name ",
    ] {
        let response = helper.request(json!({
            "v": 1,
            "id": id(10),
            "op": "ensure_dir_chain",
            "path": {"root": "destination", "components": [component]}
        }));
        assert_eq!(response["ok"], false, "component {component:?}");
        assert_eq!(response["error"]["phase"], "validation");
    }

    #[cfg(unix)]
    {
        let response = helper.request(json!({
            "v": 1,
            "id": id(11),
            "op": "ensure_dir_chain",
            "path": {"root": "destination", "components": ["escape", "owned"]}
        }));
        assert_eq!(response["ok"], false);
        assert!(!outside.path().join("owned").exists());
    }
}

#[test]
fn partial_directory_chain_failure_reports_unknown_when_created_prefix_remains() {
    let tree = TempTree::new();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);

    let response = helper.request(json!({
        "v": 1,
        "id": id(13),
        "op": "ensure_dir_chain",
        "path": {
            "root": "destination",
            "components": ["created-prefix", "x".repeat(300)]
        }
    }));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["outcome"], "unknown");
    assert!(tree.path().join("created-prefix").is_dir());
}

#[test]
fn malformed_native_identity_is_rejected_at_the_schema_boundary() {
    let tree = TempTree::new();
    fs::write(tree.path().join("owned.bin"), b"owned").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);

    let response = helper.request(json!({
        "v": 1,
        "id": id(12),
        "op": "remove_managed_exact",
        "path": {"root": "destination", "components": ["owned.bin"]},
        "expected": {
            "kind": "unix",
            "device": "not-decimal",
            "inode": "2",
            "links": "1",
            "size": "5",
            "mtimeNs": "0"
        }
    }));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["phase"], "validation");
    assert_eq!(response["error"]["code"], "invalid-identity");
    assert_eq!(fs::read(tree.path().join("owned.bin")).unwrap(), b"owned");
}

#[test]
fn delete_id_is_required_canonical_and_distinct_from_transport_id() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/item.bin"), b"owned bytes").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);

    let staged = helper.request(json!({
        "v": 1,
        "id": id(14),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "item.bin"]},
        "target": {"root": "destination", "components": ["incoming", "validation-copy.bin"]}
    }));
    assert_eq!(staged["ok"], true);

    for (transport_id, delete_id) in [
        (id(15), None),
        (id(16), Some("not-a-uuid".to_owned())),
        (id(17), Some(id(17))),
    ] {
        let mut request = json!({
            "v": 1,
            "id": transport_id,
            "op": "delete_source_exact",
            "source": {"root": "source", "components": ["incoming", "item.bin"]},
            "expected": staged["result"]["before"],
            "expectedSha256": staged["result"]["sha256"],
            "receipt": receipt(15)
        });
        if let Some(delete_id) = delete_id {
            request["deleteId"] = Value::String(delete_id);
        }
        let rejected = helper.request(request);
        assert_eq!(rejected["ok"], false);
        assert_eq!(rejected["error"]["phase"], "validation");
        assert!(tree.path().join("incoming/item.bin").exists());
    }

    let wrong_root = helper.request(json!({
        "v": 1,
        "id": id(18),
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "item.bin"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": id(118),
        "receipt": {"root": "source", "components": ["receipts", "wrong-root.json"]}
    }));
    assert_eq!(wrong_root["ok"], false);
    assert_eq!(wrong_root["error"]["phase"], "precondition");
    assert_eq!(wrong_root["error"]["code"], "receipt-root-kind");
    assert!(tree.path().join("incoming/item.bin").exists());
}

#[test]
fn delete_and_reconcile_reject_receipt_alias_of_source_before_mutation() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    fs::write(&source, b"source bytes must survive").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(190),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-190.jpg"]}
    }));
    let delete_id = id(191);
    for (request_id, operation) in [
        (192, "delete_source_exact"),
        (193, "reconcile_source_delete"),
    ] {
        let rejected = helper.request(json!({
            "v": 1,
            "id": id(request_id),
            "op": operation,
            "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
            "expected": staged["result"]["before"],
            "expectedSha256": staged["result"]["sha256"],
            "deleteId": delete_id,
            "receipt": {"root": "control", "components": ["incoming", "photo.jpg"]}
        }));
        assert_eq!(rejected["ok"], false, "{rejected}");
        assert_eq!(rejected["error"]["code"], "source-receipt-alias");
        assert_eq!(rejected["error"]["phase"], "precondition");
        assert_eq!(rejected["error"]["outcome"], "not-applied");
        assert_eq!(fs::read(&source).unwrap(), b"source bytes must survive");
        assert!(!quarantine_path(&tree, &delete_id).exists());
    }
}

#[cfg(unix)]
#[test]
fn unix_delete_rejects_native_file_alias_before_mutation() {
    use std::os::unix::fs::MetadataExt;

    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    let alternate = tree.path().join("incoming/PHOTO.JPG");
    fs::write(&source, b"unix source bytes must survive").unwrap();
    let alternate_already_aliases = fs::metadata(&alternate).ok().is_some_and(|metadata| {
        let source_metadata = fs::metadata(&source).unwrap();
        metadata.dev() == source_metadata.dev() && metadata.ino() == source_metadata.ino()
    });
    if !alternate_already_aliases {
        fs::hard_link(&source, &alternate).unwrap();
    }

    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(197),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-197.jpg"]}
    }));
    let delete_id = id(198);
    let rejected = helper.request(json!({
        "v": 1,
        "id": id(199),
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": {"root": "control", "components": ["incoming", "PHOTO.JPG"]}
    }));
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert_eq!(rejected["error"]["code"], "source-receipt-alias");
    assert_eq!(rejected["error"]["outcome"], "not-applied");
    assert_eq!(
        fs::read(&source).unwrap(),
        b"unix source bytes must survive"
    );
    assert!(!quarantine_path(&tree, &delete_id).exists());
}

#[cfg(windows)]
#[test]
fn windows_delete_rejects_case_insensitive_receipt_alias_before_mutation() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    fs::write(&source, b"windows source bytes must survive").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(194),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-194.jpg"]}
    }));
    let delete_id = id(195);
    let rejected = helper.request(json!({
        "v": 1,
        "id": id(196),
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": {"root": "control", "components": ["incoming", "PHOTO.JPG"]}
    }));
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert_eq!(rejected["error"]["code"], "source-receipt-alias");
    assert_eq!(rejected["error"]["outcome"], "not-applied");
    assert_eq!(
        fs::read(&source).unwrap(),
        b"windows source bytes must survive"
    );
    assert!(!quarantine_path(&tree, &delete_id).exists());
}

#[test]
fn copy_marker_link_rename_and_remove_never_clobber() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("source-dir")).unwrap();
    fs::create_dir(tree.path().join("dest-dir")).unwrap();
    fs::write(tree.path().join("source-dir/input.bin"), b"ground truth").unwrap();
    fs::write(tree.path().join("dest-dir/existing.bin"), b"preserve me").unwrap();

    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);

    let copied = helper.request(json!({
        "v": 1,
        "id": id(20),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["source-dir", "input.bin"]},
        "target": {"root": "destination", "components": ["dest-dir", "staged.bin"]}
    }));
    assert_eq!(copied["ok"], true);
    assert_eq!(copied["result"]["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(
        fs::read(tree.path().join("dest-dir/staged.bin")).unwrap(),
        b"ground truth"
    );

    let collision = helper.request(json!({
        "v": 1,
        "id": id(21),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["source-dir", "input.bin"]},
        "target": {"root": "destination", "components": ["dest-dir", "existing.bin"]}
    }));
    assert_eq!(collision["ok"], false);
    assert_eq!(collision["error"]["code"], "target-exists");
    assert_eq!(
        fs::read(tree.path().join("dest-dir/existing.bin")).unwrap(),
        b"preserve me"
    );

    let marker = helper.request(json!({
        "v": 1,
        "id": id(22),
        "op": "write_marker_new",
        "path": {"root": "control", "components": ["dest-dir", "marker.json"]},
        "contents": "{\"committed\":true}\n"
    }));
    assert_eq!(marker["ok"], true);

    let linked = helper.request(json!({
        "v": 1,
        "id": id(23),
        "op": "hard_link_no_replace",
        "source": {"root": "destination", "components": ["dest-dir", "staged.bin"]},
        "target": {"root": "destination", "components": ["dest-dir", "linked.bin"]}
    }));
    assert_eq!(linked["ok"], true);

    let renamed = helper.request(json!({
        "v": 1,
        "id": id(24),
        "op": "rename_no_replace",
        "source": {"root": "destination", "components": ["dest-dir", "linked.bin"]},
        "target": {"root": "destination", "components": ["dest-dir", "renamed.bin"]}
    }));
    assert_eq!(renamed["ok"], true);

    let after = renamed["result"]["after"].clone();
    let removed = helper.request(json!({
        "v": 1,
        "id": id(25),
        "op": "remove_managed_exact",
        "path": {"root": "destination", "components": ["dest-dir", "renamed.bin"]},
        "expected": after
    }));
    assert_eq!(removed["ok"], true);
    assert!(!tree.path().join("dest-dir/renamed.bin").exists());
}

#[test]
fn delete_source_exact_quarantines_verifies_and_removes_only_expected_file() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/photo.jpg"), b"verified bytes").unwrap();

    let mut helper = Helper::spawn();
    hello(&mut helper);
    let bound = bind(&mut helper, &tree);
    assert_eq!(bound["ok"], true);

    let staged = helper.request(json!({
        "v": 1,
        "id": id(30),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy.jpg"]}
    }));
    assert_eq!(staged["ok"], true);
    let expected = staged["result"]["before"].clone();
    let digest = staged["result"]["sha256"].clone();

    let deleted = helper.request(json!({
        "v": 1,
        "id": id(31),
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": expected,
        "expectedSha256": digest,
        "deleteId": id(131),
        "receipt": receipt(131)
    }));
    assert_eq!(deleted["ok"], true);
    assert_eq!(deleted["result"]["receiptState"], "created");
    assert!(!tree.path().join("incoming/photo.jpg").exists());
    assert!(receipt_path(&tree, 131).is_file());
    let residues: Vec<_> = fs::read_dir(tree.path().join("incoming"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".meta-mover-delete-")
        })
        .collect();
    assert!(
        residues.is_empty(),
        "successful deletion left quarantine residue"
    );
}

#[cfg(windows)]
#[test]
fn windows_delete_finalizes_quarantine_namespace_before_success() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/photo.jpg"), b"verified bytes").unwrap();

    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);

    let staged = helper.request(json!({
        "v": 1,
        "id": id(34),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-for-windows.jpg"]}
    }));
    assert_eq!(staged["ok"], true);

    let delete_id = id(35);
    let deleted = helper.request(json!({
        "v": 1,
        "id": delete_id,
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": id(135),
        "receipt": receipt(135)
    }));
    assert_eq!(deleted["ok"], true);

    let quarantine = quarantine_path(&tree, &id(135));
    fs::create_dir(&quarantine)
        .expect("successful response means the quarantine name is immediately reusable");
}

#[test]
fn delete_quarantine_is_request_bound_and_never_reuses_existing_residue() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/photo.jpg"), b"preserve bytes").unwrap();

    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(32),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy.jpg"]}
    }));
    assert_eq!(staged["ok"], true);

    let delete_id = id(133);
    fs::create_dir(quarantine_path(&tree, &delete_id)).unwrap();
    let rejected = helper.request(json!({
        "v": 1,
        "id": id(33),
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": receipt(133)
    }));
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "reconciliation-required");
    assert_eq!(rejected["error"]["phase"], "precondition");
    assert_eq!(rejected["error"]["outcome"], "unknown");
    assert!(rejected["error"].get("details").is_none(), "{rejected}");
    assert_eq!(
        fs::read(tree.path().join("incoming/photo.jpg")).unwrap(),
        b"preserve bytes"
    );
}

#[test]
fn delete_receipt_collision_preserves_quarantine_and_marker() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/photo.jpg"), b"verified bytes").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(68),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-68.jpg"]}
    }));
    fs::write(receipt_path(&tree, 168), b"foreign marker\n").unwrap();

    let rejected = helper.request(json!({
        "v": 1,
        "id": id(69),
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": id(168),
        "receipt": receipt(168)
    }));
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "reconciliation-required");
    assert_eq!(rejected["error"]["phase"], "precondition");
    assert_eq!(rejected["error"]["outcome"], "unknown");
    assert!(rejected["error"].get("details").is_none(), "{rejected}");
    assert_eq!(
        fs::read(receipt_path(&tree, 168)).unwrap(),
        b"foreign marker\n"
    );
    assert_eq!(
        fs::read(quarantine_path(&tree, &id(168)).join("entry")).unwrap(),
        b"verified bytes"
    );
}

#[test]
fn reconcile_reports_source_retained_when_quarantine_is_absent() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/photo.jpg"), b"verified bytes").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(70),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-70.jpg"]}
    }));

    let reconciled = helper.request(json!({
        "v": 1,
        "id": id(71),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": id(170),
        "receipt": receipt(170)
    }));
    assert_eq!(reconciled["ok"], true, "{reconciled}");
    assert_eq!(reconciled["result"]["outcome"], "not-applied");
    assert_eq!(reconciled["result"]["state"], "source-retained");
    assert_eq!(reconciled["result"]["sourceState"], "expected");
    assert_eq!(reconciled["result"]["quarantineState"], "absent");
    assert_eq!(reconciled["result"]["receiptState"], "absent");
    assert_eq!(reconciled["result"]["durability"]["parents"], json!([]));
    assert!(tree.path().join("incoming/photo.jpg").exists());
}

#[test]
fn reconcile_removes_only_an_empty_quarantine_when_source_is_exact() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/photo.jpg"), b"verified bytes").unwrap();
    let delete_id = id(172);
    fs::create_dir(quarantine_path(&tree, &delete_id)).unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(72),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-72.jpg"]}
    }));

    let reconciled = helper.request(json!({
        "v": 1,
        "id": id(73),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": receipt(172)
    }));
    assert_eq!(reconciled["ok"], true, "{reconciled}");
    assert_eq!(reconciled["result"]["state"], "source-retained");
    assert_eq!(reconciled["result"]["quarantineState"], "empty-removed");
    assert_eq!(reconciled["result"]["receiptState"], "absent");
    assert_eq!(
        reconciled["result"]["durability"]["parents"],
        json!(["synced"])
    );
    assert!(tree.path().join("incoming/photo.jpg").exists());
    assert!(!quarantine_path(&tree, &id(172)).exists());
}

#[test]
fn reconcile_deletes_exact_quarantine_entry_and_preserves_source_replacement() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    fs::write(&source, b"verified bytes").unwrap();
    let delete_id = id(174);
    let quarantine = quarantine_path(&tree, &delete_id);
    fs::create_dir(&quarantine).unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(74),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-74.jpg"]}
    }));
    fs::rename(&source, quarantine.join("entry")).unwrap();
    fs::write(&source, b"replacement must survive").unwrap();

    let reconciled = helper.request(json!({
        "v": 1,
        "id": id(75),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": receipt(174)
    }));
    assert_eq!(reconciled["ok"], true);
    assert_eq!(reconciled["result"]["outcome"], "applied");
    assert_eq!(reconciled["result"]["state"], "deleted");
    assert_eq!(reconciled["result"]["sourceState"], "replacement-preserved");
    assert_eq!(reconciled["result"]["quarantineState"], "entry-deleted");
    assert_eq!(reconciled["result"]["receiptState"], "created");
    assert_eq!(fs::read(&source).unwrap(), b"replacement must survive");
    assert!(!quarantine.exists());
    assert_eq!(
        fs::read(receipt_path(&tree, 174)).unwrap(),
        receipt_bytes(
            &id(174),
            &staged["result"]["before"],
            &staged["result"]["sha256"]
        )
    );
}

#[test]
fn reconcile_keeps_source_absent_without_quarantine_explicitly_unknown() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    fs::write(&source, b"verified bytes").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(76),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-76.jpg"]}
    }));
    fs::remove_file(&source).unwrap();

    let reconciled = helper.request(json!({
        "v": 1,
        "id": id(77),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": id(176),
        "receipt": receipt(176)
    }));
    assert_eq!(reconciled["ok"], false);
    assert_eq!(reconciled["error"]["code"], "reconciliation-required");
    assert_eq!(reconciled["error"]["outcome"], "unknown");
    assert_eq!(reconciled["error"]["details"]["sourceState"], "absent");
    assert_eq!(reconciled["error"]["details"]["quarantineState"], "absent");
    assert_eq!(reconciled["error"]["details"]["receiptState"], "absent");
    assert!(!reconciled
        .to_string()
        .contains(tree.path().to_str().unwrap()));

    fs::write(
        receipt_path(&tree, 176),
        receipt_bytes(
            &id(176),
            &staged["result"]["before"],
            &staged["result"]["sha256"],
        ),
    )
    .unwrap();
    let completed = helper.request(json!({
        "v": 1,
        "id": id(177),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": id(176),
        "receipt": receipt(176)
    }));
    assert_eq!(completed["ok"], true, "{completed}");
    assert_eq!(completed["result"]["state"], "deleted");
    assert_eq!(completed["result"]["sourceState"], "absent");
    assert_eq!(completed["result"]["quarantineState"], "absent");
    assert_eq!(completed["result"]["receiptState"], "exact");
}

#[test]
fn reconcile_completes_exact_entry_with_preexisting_exact_receipt() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    fs::write(&source, b"verified bytes").unwrap();
    let delete_id = id(182);
    let quarantine = quarantine_path(&tree, &delete_id);
    fs::create_dir(&quarantine).unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(84),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-84.jpg"]}
    }));
    fs::rename(&source, quarantine.join("entry")).unwrap();
    fs::write(
        receipt_path(&tree, 182),
        receipt_bytes(
            &delete_id,
            &staged["result"]["before"],
            &staged["result"]["sha256"],
        ),
    )
    .unwrap();

    let completed = helper.request(json!({
        "v": 1,
        "id": id(85),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": receipt(182)
    }));
    assert_eq!(completed["ok"], true, "{completed}");
    assert_eq!(completed["result"]["state"], "deleted");
    assert_eq!(completed["result"]["quarantineState"], "entry-deleted");
    assert_eq!(completed["result"]["receiptState"], "exact");
    assert!(!quarantine.exists());
}

#[test]
fn reconcile_completes_empty_quarantine_with_exact_receipt() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    fs::write(&source, b"verified bytes").unwrap();
    let delete_id = id(184);
    let quarantine = quarantine_path(&tree, &delete_id);
    fs::create_dir(&quarantine).unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(86),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-86.jpg"]}
    }));
    fs::rename(&source, quarantine.join("entry")).unwrap();
    fs::remove_file(quarantine.join("entry")).unwrap();
    fs::write(
        receipt_path(&tree, 184),
        receipt_bytes(
            &delete_id,
            &staged["result"]["before"],
            &staged["result"]["sha256"],
        ),
    )
    .unwrap();

    let completed = helper.request(json!({
        "v": 1,
        "id": id(87),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": receipt(184)
    }));
    assert_eq!(completed["ok"], true);
    assert_eq!(completed["result"]["state"], "deleted");
    assert_eq!(completed["result"]["quarantineState"], "empty-removed");
    assert_eq!(completed["result"]["receiptState"], "exact");
    assert_eq!(
        completed["result"]["durability"]["parents"],
        json!(["synced", "synced"])
    );
    assert!(!quarantine.exists());
}

#[test]
fn reconcile_preserves_mismatched_quarantine_and_exact_source() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::write(tree.path().join("incoming/photo.jpg"), b"verified bytes").unwrap();
    let delete_id = id(178);
    let quarantine = quarantine_path(&tree, &delete_id);
    fs::create_dir(&quarantine).unwrap();
    fs::write(quarantine.join("entry"), b"foreign residue").unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(78),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-78.jpg"]}
    }));

    let reconciled = helper.request(json!({
        "v": 1,
        "id": id(79),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": receipt(178)
    }));
    assert_eq!(reconciled["ok"], false);
    assert_eq!(reconciled["error"]["details"]["sourceState"], "expected");
    assert_eq!(
        reconciled["error"]["details"]["quarantineState"],
        "entry-other"
    );
    assert!(tree.path().join("incoming/photo.jpg").exists());
    assert_eq!(
        fs::read(quarantine.join("entry")).unwrap(),
        b"foreign residue"
    );
}

#[test]
fn reconcile_preserves_exact_entry_when_receipt_mismatches() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    let source = tree.path().join("incoming/photo.jpg");
    fs::write(&source, b"verified bytes").unwrap();
    let delete_id = id(186);
    let quarantine = quarantine_path(&tree, &delete_id);
    fs::create_dir(&quarantine).unwrap();
    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let staged = helper.request(json!({
        "v": 1,
        "id": id(88),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "target": {"root": "destination", "components": ["incoming", "copy-88.jpg"]}
    }));
    fs::rename(&source, quarantine.join("entry")).unwrap();
    fs::write(receipt_path(&tree, 186), b"mismatched receipt\n").unwrap();

    let rejected = helper.request(json!({
        "v": 1,
        "id": id(89),
        "op": "reconcile_source_delete",
        "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
        "expected": staged["result"]["before"],
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": delete_id,
        "receipt": receipt(186)
    }));
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["details"]["sourceState"], "absent");
    assert_eq!(
        rejected["error"]["details"]["quarantineState"],
        "entry-expected"
    );
    assert_eq!(rejected["error"]["details"]["receiptState"], "other");
    assert_eq!(
        fs::read(quarantine.join("entry")).unwrap(),
        b"verified bytes"
    );
    assert_eq!(
        fs::read(receipt_path(&tree, 186)).unwrap(),
        b"mismatched receipt\n"
    );
}

#[test]
fn reconcile_preserves_special_or_unexpected_quarantine_entries() {
    for (case, add_entry) in [("special", false), ("unexpected", true)] {
        let tree = TempTree::new();
        fs::create_dir(tree.path().join("incoming")).unwrap();
        fs::write(tree.path().join("incoming/photo.jpg"), b"verified bytes").unwrap();
        let delete_id = if add_entry { id(181) } else { id(180) };
        let quarantine = quarantine_path(&tree, &delete_id);
        fs::create_dir(&quarantine).unwrap();
        fs::create_dir(quarantine.join("entry")).unwrap();
        if add_entry {
            fs::write(quarantine.join("extra"), b"extra").unwrap();
        }
        let mut helper = Helper::spawn();
        hello(&mut helper);
        assert_eq!(bind(&mut helper, &tree)["ok"], true);
        let staged = helper.request(json!({
            "v": 1,
            "id": if add_entry { id(81) } else { id(80) },
            "op": "stage_copy",
            "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
            "target": {"root": "destination", "components": ["incoming", format!("copy-{case}.jpg")]}
        }));
        let reconciled = helper.request(json!({
            "v": 1,
            "id": if add_entry { id(83) } else { id(82) },
            "op": "reconcile_source_delete",
            "source": {"root": "source", "components": ["incoming", "photo.jpg"]},
            "expected": staged["result"]["before"],
            "expectedSha256": staged["result"]["sha256"],
            "deleteId": delete_id,
            "receipt": receipt(if add_entry { 181 } else { 180 })
        }));
        assert_eq!(reconciled["ok"], false);
        assert_eq!(
            reconciled["error"]["details"]["quarantineState"],
            if add_entry {
                "unexpected-entries"
            } else {
                "entry-special"
            }
        );
        assert!(quarantine.join("entry").is_dir());
        assert!(tree.path().join("incoming/photo.jpg").exists());
    }
}

#[cfg(unix)]
#[test]
fn retained_root_capability_ignores_ambient_root_replacement() {
    let container = TempTree::new();
    let bound = container.path().join("bound");
    let detached = container.path().join("detached");
    let outside = TempTree::new();
    fs::create_dir(&bound).unwrap();

    let mut helper = Helper::spawn();
    hello(&mut helper);
    let response = helper.request(json!({
        "v": 1,
        "id": id(40),
        "op": "bind_roots",
        "roots": [{"name": "destination", "kind": "destination", "absolutePath": bound}]
    }));
    assert_eq!(response["ok"], true);

    fs::rename(&bound, &detached).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &bound).unwrap();
    let created = helper.request(json!({
        "v": 1,
        "id": id(41),
        "op": "ensure_dir_chain",
        "path": {"root": "destination", "components": ["inside-capability"]}
    }));
    assert_eq!(created["ok"], true);
    assert!(detached.join("inside-capability").is_dir());
    assert!(!outside.path().join("inside-capability").exists());
}

#[test]
fn hash_and_identity_faults_preserve_source_and_remove_only_owned_staging() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::create_dir(tree.path().join("staging")).unwrap();
    fs::write(tree.path().join("incoming/item.bin"), b"original bytes").unwrap();

    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    let mismatch = helper.request(json!({
        "v": 1,
        "id": id(50),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "item.bin"]},
        "target": {"root": "destination", "components": ["staging", "failed.bin"]},
        "expectedSha256": "0000000000000000000000000000000000000000000000000000000000000000"
    }));
    assert_eq!(mismatch["ok"], false);
    assert_eq!(mismatch["error"]["code"], "hash-mismatch");
    assert_eq!(
        fs::read(tree.path().join("incoming/item.bin")).unwrap(),
        b"original bytes"
    );
    assert!(!tree.path().join("staging/failed.bin").exists());

    let staged = helper.request(json!({
        "v": 1,
        "id": id(51),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "item.bin"]},
        "target": {"root": "destination", "components": ["staging", "good.bin"]}
    }));
    assert_eq!(staged["ok"], true);
    let stale = staged["result"]["before"].clone();
    fs::write(
        tree.path().join("incoming/item.bin"),
        b"different size and bytes",
    )
    .unwrap();
    let rejected = helper.request(json!({
        "v": 1,
        "id": id(52),
        "op": "delete_source_exact",
        "source": {"root": "source", "components": ["incoming", "item.bin"]},
        "expected": stale,
        "expectedSha256": staged["result"]["sha256"],
        "deleteId": id(152),
        "receipt": receipt(152)
    }));
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "identity-mismatch");
    assert_eq!(
        fs::read(tree.path().join("incoming/item.bin")).unwrap(),
        b"different size and bytes"
    );
}

#[test]
fn abrupt_helper_termination_never_deletes_source_or_clobbers_existing_entry() {
    let tree = TempTree::new();
    fs::create_dir(tree.path().join("incoming")).unwrap();
    fs::create_dir(tree.path().join("staging")).unwrap();
    let source = tree.path().join("incoming/large.bin");
    let source_file = fs::File::create(&source).unwrap();
    source_file.set_len(512 * 1024 * 1024).unwrap();
    fs::write(tree.path().join("staging/sentinel.bin"), b"never replace").unwrap();

    let mut helper = Helper::spawn();
    hello(&mut helper);
    assert_eq!(bind(&mut helper, &tree)["ok"], true);
    helper.send_without_wait(json!({
        "v": 1,
        "id": id(60),
        "op": "stage_copy",
        "source": {"root": "source", "components": ["incoming", "large.bin"]},
        "target": {"root": "destination", "components": ["staging", "interrupted.bin"]}
    }));
    helper.terminate_exact_child();

    assert_eq!(fs::metadata(&source).unwrap().len(), 512 * 1024 * 1024);
    assert_eq!(
        fs::read(tree.path().join("staging/sentinel.bin")).unwrap(),
        b"never replace"
    );
}
