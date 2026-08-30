fn main() {
    let target = std::env::var("TARGET").expect("Cargo provides TARGET");
    println!("cargo:rustc-env=META_MOVER_TARGET={target}");
}
