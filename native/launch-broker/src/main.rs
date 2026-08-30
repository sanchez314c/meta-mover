use meta_mover_launch_broker::{identity_json, launch_stdio, ExpectedHelper, FailClosedSigner};
use std::io::Write;

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let expected = ExpectedHelper::compiled();
    let result = match arguments.as_slice() {
        [_, command] if command == "--identity" => identity_json(&expected).and_then(|output| {
            std::io::stdout()
                .write_all(output.as_bytes())
                .map_err(|error| format!("broker identity output failed: {error}"))?;
            Ok(0)
        }),
        [_, command] if command == "--stdio" => std::env::current_exe()
            .map_err(|error| format!("broker executable path is unavailable: {error}"))
            .and_then(|path| launch_stdio(&path, &expected, &FailClosedSigner)),
        _ => Err("usage: meta-mover-launch-broker --identity|--stdio".to_owned()),
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("launch broker failed: {error}");
            std::process::exit(1);
        }
    }
}
