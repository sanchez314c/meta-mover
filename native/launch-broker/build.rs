fn main() {
    for name in [
        "META_MOVER_EXPECTED_HELPER_SHA256",
        "META_MOVER_EXPECTED_HELPER_PROTOCOL",
        "META_MOVER_EXPECTED_HELPER_BUILD",
        "META_MOVER_EXPECTED_HELPER_TARGET",
        "META_MOVER_RELEASE_SIGNER",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }

    let rust_target = std::env::var("TARGET").expect("Cargo provides TARGET");
    let profile = std::env::var("PROFILE").expect("Cargo provides PROFILE");
    let package_target = package_target(&rust_target).expect("supported launch-broker target");
    let test_profile = profile != "release";
    let helper_sha256 = required_or_test(
        "META_MOVER_EXPECTED_HELPER_SHA256",
        test_profile,
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
    assert!(
        helper_sha256.len() == 64
            && helper_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "META_MOVER_EXPECTED_HELPER_SHA256 must be 64 lowercase hexadecimal characters"
    );
    let helper_protocol =
        required_or_test("META_MOVER_EXPECTED_HELPER_PROTOCOL", test_profile, "1");
    assert_eq!(helper_protocol, "1", "helper protocol must be 1");
    let helper_build = required_or_test("META_MOVER_EXPECTED_HELPER_BUILD", test_profile, "0.1.0");
    assert!(
        !helper_build.trim().is_empty(),
        "helper build must not be empty"
    );
    let helper_target = required_or_test(
        "META_MOVER_EXPECTED_HELPER_TARGET",
        test_profile,
        package_target,
    );
    assert_eq!(
        helper_target, package_target,
        "helper package target must match broker target"
    );
    let signer = std::env::var("META_MOVER_RELEASE_SIGNER").unwrap_or_default();
    assert!(
        !signer.contains(['\0', '\n', '\r']),
        "release signer contains control characters"
    );

    println!("cargo:rustc-env=META_MOVER_BROKER_RUST_TARGET={rust_target}");
    println!("cargo:rustc-env=META_MOVER_BROKER_PACKAGE_TARGET={package_target}");
    println!("cargo:rustc-env=META_MOVER_EXPECTED_HELPER_SHA256={helper_sha256}");
    println!("cargo:rustc-env=META_MOVER_EXPECTED_HELPER_PROTOCOL={helper_protocol}");
    println!("cargo:rustc-env=META_MOVER_EXPECTED_HELPER_BUILD={helper_build}");
    println!("cargo:rustc-env=META_MOVER_EXPECTED_HELPER_TARGET={helper_target}");
    println!("cargo:rustc-env=META_MOVER_RELEASE_SIGNER={signer}");
}

fn required_or_test(name: &str, test_profile: bool, test_value: &'static str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value,
        _ if test_profile => test_value.to_owned(),
        _ => panic!("{name} is required for release launch-broker builds"),
    }
}

fn package_target(target: &str) -> Option<&'static str> {
    match target {
        "x86_64-unknown-linux-gnu" | "x86_64-unknown-linux-musl" => Some("linux-x64"),
        "aarch64-unknown-linux-gnu" | "aarch64-unknown-linux-musl" => Some("linux-arm64"),
        "x86_64-apple-darwin" => Some("darwin-x64"),
        "aarch64-apple-darwin" => Some("darwin-arm64"),
        "x86_64-pc-windows-msvc" => Some("win32-x64"),
        "aarch64-pc-windows-msvc" => Some("win32-arm64"),
        "i686-pc-windows-msvc" => Some("win32-ia32"),
        _ => None,
    }
}
