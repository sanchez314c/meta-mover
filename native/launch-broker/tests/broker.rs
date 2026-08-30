use meta_mover_launch_broker::{
    identity_json, resolve_helper_path, validate_helper, ExpectedHelper, SignerVerifier,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "meta-mover-launch-broker-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn digest(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

struct RecordingSigner {
    calls: AtomicUsize,
    accept: bool,
}

fn package_target() -> &'static str {
    env!("META_MOVER_BROKER_PACKAGE_TARGET")
}

fn broker_filename() -> &'static str {
    if cfg!(windows) {
        "meta-mover-launch-broker.exe"
    } else {
        "meta-mover-launch-broker"
    }
}

fn helper_filename() -> &'static str {
    if cfg!(windows) {
        "meta-mover-fs-helper.exe"
    } else {
        "meta-mover-fs-helper"
    }
}

impl SignerVerifier for RecordingSigner {
    fn verify(&self, _helper: &std::fs::File, _policy: &str) -> Result<(), String> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if self.accept {
            Ok(())
        } else {
            Err("signer rejected".to_owned())
        }
    }
}

#[test]
fn resolves_only_the_exact_staged_sibling_layout() {
    let root = temp_root("layout");
    let broker = root
        .join("tools/launch-broker")
        .join(package_target())
        .join(broker_filename());
    let expected = root
        .join("tools/fs-helper")
        .join(package_target())
        .join(helper_filename());
    assert_eq!(
        resolve_helper_path(&broker, package_target()).unwrap(),
        expected
    );
    assert!(resolve_helper_path(
        &root
            .join("tools/other")
            .join(package_target())
            .join(broker_filename()),
        package_target()
    )
    .is_err());
    assert!(resolve_helper_path(
        &root
            .join("not-tools/launch-broker")
            .join(package_target())
            .join(broker_filename()),
        package_target()
    )
    .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn validates_the_opened_regular_helper_hash_and_rejects_tampering() {
    let root = temp_root("hash");
    let helper = root.join("meta-mover-fs-helper");
    fs::write(&helper, b"verified helper bytes").unwrap();
    let expected = ExpectedHelper::for_test(digest(b"verified helper bytes"), None);
    let signer = RecordingSigner {
        calls: AtomicUsize::new(0),
        accept: true,
    };
    validate_helper(&helper, &expected, &signer).unwrap();
    fs::write(&helper, b"tampered helper bytes").unwrap();
    assert!(validate_helper(&helper, &expected, &signer).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invokes_signer_verification_only_when_a_policy_is_compiled() {
    let root = temp_root("signer");
    let helper = root.join("meta-mover-fs-helper");
    fs::write(&helper, b"signed helper bytes").unwrap();
    let hash = digest(b"signed helper bytes");
    let signer = RecordingSigner {
        calls: AtomicUsize::new(0),
        accept: false,
    };
    validate_helper(
        &helper,
        &ExpectedHelper::for_test(hash.clone(), None),
        &signer,
    )
    .unwrap();
    assert_eq!(signer.calls.load(Ordering::Relaxed), 0);
    assert!(validate_helper(
        &helper,
        &ExpectedHelper::for_test(hash, Some("release-policy".to_owned())),
        &signer,
    )
    .is_err());
    assert_eq!(signer.calls.load(Ordering::Relaxed), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn identity_output_is_exact_newline_terminated_json() {
    let value = identity_json(&ExpectedHelper::compiled()).unwrap();
    assert!(value.ends_with('\n'));
    let parsed: serde_json::Value = serde_json::from_str(value.trim_end()).unwrap();
    assert_eq!(
        parsed
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "brokerBuild",
            "brokerTarget",
            "helperBuild",
            "helperProtocol",
            "helperSha256",
            "helperTarget",
            "releaseSigner",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    assert_eq!(parsed["helperProtocol"], 1);
}

#[cfg(unix)]
#[test]
fn rejects_a_symbolic_link_helper_without_following_it() {
    use std::os::unix::fs::symlink;
    let root = temp_root("symlink");
    let target = root.join("real-helper");
    let helper = root.join("meta-mover-fs-helper");
    fs::write(&target, b"verified helper bytes").unwrap();
    symlink(&target, &helper).unwrap();
    let signer = RecordingSigner {
        calls: AtomicUsize::new(0),
        accept: true,
    };
    assert!(validate_helper(
        &helper,
        &ExpectedHelper::for_test(digest(b"verified helper bytes"), None),
        &signer,
    )
    .is_err());
    fs::remove_dir_all(root).unwrap();
}
