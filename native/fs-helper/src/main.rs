use meta_mover_fs_helper::{
    failure_value, parse_request, protocol_failure, Engine, MAX_LINE_BYTES,
};
use std::io::{self, BufRead, BufReader, BufWriter, Write};

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 2 || arguments[1] != "--stdio" {
        eprintln!("usage: meta-mover-fs-helper --stdio");
        std::process::exit(2);
    }
    if let Err(error) = run_stdio() {
        eprintln!("filesystem helper transport failed: {error}");
        std::process::exit(1);
    }
}

fn run_stdio() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = BufReader::new(stdin.lock());
    let mut output = BufWriter::new(stdout.lock());
    let mut engine = Engine::default();

    loop {
        let frame = read_frame(&mut input)?;
        let Some(frame) = frame else {
            break;
        };
        let (response, close) = match frame {
            Frame::Oversize => (
                protocol_failure(
                    "00000000-0000-0000-0000-000000000000",
                    "line-too-large",
                    "request line exceeds 65536 bytes",
                ),
                false,
            ),
            Frame::Bytes(bytes) => match parse_request(&bytes) {
                Ok(request) => engine.handle(request),
                Err((id, error)) => (failure_value(&id, error), false),
            },
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
        if close {
            break;
        }
    }
    Ok(())
}

enum Frame {
    Bytes(Vec<u8>),
    Oversize,
}

fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut bytes = Vec::new();
    let mut oversize = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(None);
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        let content_count = newline.unwrap_or(take);
        if !oversize {
            if bytes.len() + content_count + usize::from(newline.is_some()) > MAX_LINE_BYTES {
                oversize = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&available[..content_count]);
            }
        }
        reader.consume(take);
        if newline.is_some() {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(Some(if oversize {
                Frame::Oversize
            } else {
                Frame::Bytes(bytes)
            }));
        }
    }
}
