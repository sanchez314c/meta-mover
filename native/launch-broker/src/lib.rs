use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedHelper {
    pub sha256: String,
    pub protocol: u8,
    pub build: String,
    pub target: String,
    pub release_signer: Option<String>,
}

impl ExpectedHelper {
    pub fn compiled() -> Self {
        let signer = env!("META_MOVER_RELEASE_SIGNER");
        Self {
            sha256: env!("META_MOVER_EXPECTED_HELPER_SHA256").to_owned(),
            protocol: env!("META_MOVER_EXPECTED_HELPER_PROTOCOL")
                .parse()
                .expect("build validates helper protocol"),
            build: env!("META_MOVER_EXPECTED_HELPER_BUILD").to_owned(),
            target: env!("META_MOVER_EXPECTED_HELPER_TARGET").to_owned(),
            release_signer: (!signer.is_empty()).then(|| signer.to_owned()),
        }
    }

    pub fn for_test(sha256: String, release_signer: Option<String>) -> Self {
        Self {
            sha256,
            protocol: 1,
            build: "0.1.0".to_owned(),
            target: env!("META_MOVER_BROKER_PACKAGE_TARGET").to_owned(),
            release_signer,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("compiled helper SHA-256 is invalid".to_owned());
        }
        if self.protocol != 1 || self.build.is_empty() {
            return Err("compiled helper protocol or build is invalid".to_owned());
        }
        if self.target != env!("META_MOVER_BROKER_PACKAGE_TARGET") {
            return Err("compiled helper target does not match the broker target".to_owned());
        }
        Ok(())
    }
}

pub trait SignerVerifier {
    fn verify(&self, helper: &File, policy: &str) -> Result<(), String>;
}

pub struct FailClosedSigner;

impl SignerVerifier for FailClosedSigner {
    fn verify(&self, _helper: &File, _policy: &str) -> Result<(), String> {
        Err("a release signer policy is configured but no verifier was injected".to_owned())
    }
}

pub fn resolve_helper_path(current_executable: &Path, target: &str) -> Result<PathBuf, String> {
    let filename = current_executable
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "broker executable has no valid filename".to_owned())?;
    let expected_broker = if cfg!(windows) {
        "meta-mover-launch-broker.exe"
    } else {
        "meta-mover-launch-broker"
    };
    if filename != expected_broker {
        return Err("broker executable filename is not canonical".to_owned());
    }
    let target_directory = current_executable
        .parent()
        .ok_or_else(|| "broker executable has no target directory".to_owned())?;
    if target_directory
        .file_name()
        .and_then(|value| value.to_str())
        != Some(target)
    {
        return Err("broker executable target directory is not canonical".to_owned());
    }
    let broker_directory = target_directory
        .parent()
        .ok_or_else(|| "broker executable has no launch-broker directory".to_owned())?;
    if broker_directory
        .file_name()
        .and_then(|value| value.to_str())
        != Some("launch-broker")
    {
        return Err("broker executable is outside the launch-broker directory".to_owned());
    }
    let tools_directory = broker_directory
        .parent()
        .ok_or_else(|| "broker executable has no tools directory".to_owned())?;
    if tools_directory.file_name().and_then(|value| value.to_str()) != Some("tools") {
        return Err("broker executable is outside the canonical tools directory".to_owned());
    }
    let helper_filename = if cfg!(windows) {
        "meta-mover-fs-helper.exe"
    } else {
        "meta-mover-fs-helper"
    };
    Ok(tools_directory
        .join("fs-helper")
        .join(target)
        .join(helper_filename))
}

pub fn validate_helper(
    helper_path: &Path,
    expected: &ExpectedHelper,
    signer: &dyn SignerVerifier,
) -> Result<(), String> {
    let _verified = open_verified_helper(helper_path, expected, signer)?;
    Ok(())
}

pub fn launch_stdio(
    current_executable: &Path,
    expected: &ExpectedHelper,
    signer: &dyn SignerVerifier,
) -> Result<i32, String> {
    expected.validate()?;
    let helper_path = resolve_helper_path(current_executable, &expected.target)?;
    let verified = open_verified_helper(&helper_path, expected, signer)?;
    platform::launch(verified)
}

struct VerifiedHelper {
    file: File,
    identity: platform::NativeIdentity,
    context: platform::RetainedContext,
    path: PathBuf,
    sha256: String,
}

fn open_verified_helper(
    helper_path: &Path,
    expected: &ExpectedHelper,
    signer: &dyn SignerVerifier,
) -> Result<VerifiedHelper, String> {
    expected.validate()?;
    let (file, context) = platform::open_helper_nofollow(helper_path)?;
    let before = platform::identity(&file)?;
    if !before.regular {
        return Err("filesystem helper is not a regular native file".to_owned());
    }
    let actual_hash = hash_file(&file)?;
    let after = platform::identity(&file)?;
    if before != after {
        return Err("filesystem helper identity changed while hashing".to_owned());
    }
    if actual_hash != expected.sha256 {
        return Err("filesystem helper SHA-256 does not match the compiled identity".to_owned());
    }
    if let Some(policy) = expected.release_signer.as_deref() {
        signer.verify(&file, policy)?;
        if platform::identity(&file)? != after {
            return Err("filesystem helper identity changed during signer verification".to_owned());
        }
    }
    Ok(VerifiedHelper {
        file,
        identity: after,
        context,
        path: helper_path.to_owned(),
        sha256: actual_hash,
    })
}

pub(crate) fn hash_file(file: &File) -> Result<String, String> {
    let mut reader = file
        .try_clone()
        .map_err(|error| format!("filesystem helper handle cannot be duplicated: {error}"))?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("filesystem helper cannot be rewound: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("filesystem helper cannot be hashed: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrokerIdentity<'a> {
    broker_build: &'static str,
    broker_target: &'static str,
    helper_sha256: &'a str,
    helper_protocol: u8,
    helper_build: &'a str,
    helper_target: &'a str,
    release_signer: Option<&'a str>,
}

pub fn identity_json(expected: &ExpectedHelper) -> Result<String, String> {
    expected.validate()?;
    let identity = BrokerIdentity {
        broker_build: env!("CARGO_PKG_VERSION"),
        broker_target: env!("META_MOVER_BROKER_RUST_TARGET"),
        helper_sha256: &expected.sha256,
        helper_protocol: expected.protocol,
        helper_build: &expected.build,
        helper_target: &expected.target,
        release_signer: expected.release_signer.as_deref(),
    };
    let mut output = serde_json::to_string(&identity)
        .map_err(|error| format!("broker identity cannot be serialized: {error}"))?;
    output.push('\n');
    Ok(output)
}
