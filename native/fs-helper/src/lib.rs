mod engine;
mod protocol;

#[cfg(unix)]
mod unix_backend;
#[cfg(windows)]
mod windows_backend;

pub use engine::Engine;
pub use protocol::{failure_value, parse_request, protocol_failure, Request};

pub const MAX_LINE_BYTES: usize = 65_536;
