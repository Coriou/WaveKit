//! Command line: `wavekit-iqhub --control-fd 3 --socket-dir DIR [--ring-ms 4000] [--log-level info|debug]`,
//! or `--version`.

use std::path::PathBuf;

pub const VERSION_LINE: &str = concat!("wavekit-iqhub ", env!("CARGO_PKG_VERSION"), " protocol 1");
pub const MIN_RING_MS: u64 = 500;
pub const MAX_RING_MS: u64 = 30_000;
pub const DEFAULT_RING_MS: u64 = 4_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub control_fd: i32,
    pub socket_dir: PathBuf,
    pub ring_ms: u64,
    pub debug: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Version,
    Run(Args),
}

pub fn parse(argv: &[String]) -> Result<Command, String> {
    if argv.len() == 1 && argv[0] == "--version" {
        return Ok(Command::Version);
    }
    let mut control_fd = None;
    let mut socket_dir = None;
    let mut ring_ms = None;
    let mut debug = None;
    let mut it = argv.iter();
    while let Some(k) = it.next() {
        let v = it.next().ok_or_else(|| format!("{k} needs a value"))?;
        let slot_taken = |o: bool| {
            if o {
                Err(format!("{k} given twice"))
            } else {
                Ok(())
            }
        };
        match k.as_str() {
            "--control-fd" => {
                slot_taken(control_fd.is_some())?;
                let fd: i32 = v
                    .parse()
                    .map_err(|_| "--control-fd must be an integer".to_string())?;
                if fd < 3 {
                    return Err("--control-fd must be >= 3 (0-2 are stdin, events and logs)".into());
                }
                control_fd = Some(fd);
            }
            "--socket-dir" => {
                slot_taken(socket_dir.is_some())?;
                socket_dir = Some(PathBuf::from(v));
            }
            "--ring-ms" => {
                slot_taken(ring_ms.is_some())?;
                let ms: u64 = v
                    .parse()
                    .map_err(|_| "--ring-ms must be an integer".to_string())?;
                if !(MIN_RING_MS..=MAX_RING_MS).contains(&ms) {
                    return Err(format!(
                        "--ring-ms must be within {MIN_RING_MS}..={MAX_RING_MS}"
                    ));
                }
                ring_ms = Some(ms);
            }
            "--log-level" => {
                slot_taken(debug.is_some())?;
                debug = Some(match v.as_str() {
                    "info" => false,
                    "debug" => true,
                    _ => return Err("--log-level must be info or debug".into()),
                });
            }
            _ => return Err(format!("unknown option {k}")),
        }
    }
    Ok(Command::Run(Args {
        control_fd: control_fd.ok_or("missing --control-fd")?,
        socket_dir: socket_dir.ok_or("missing --socket-dir")?,
        ring_ms: ring_ms.unwrap_or(DEFAULT_RING_MS),
        debug: debug.unwrap_or(false),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: &[&str]) -> Result<Command, String> {
        parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn the_command_line_takes_its_bounds_at_and_past_each_end() {
        assert_eq!(p(&["--version"]), Ok(Command::Version));
        let run = p(&["--control-fd", "3", "--socket-dir", "/d"]).unwrap();
        assert_eq!(
            run,
            Command::Run(Args {
                control_fd: 3,
                socket_dir: "/d".into(),
                ring_ms: 4_000,
                debug: false
            })
        );
        for (ms, ok) in [
            ("500", true),
            ("499", false),
            ("30000", true),
            ("30001", false),
        ] {
            let r = p(&["--control-fd", "3", "--socket-dir", "/d", "--ring-ms", ms]);
            assert_eq!(r.is_ok(), ok, "{ms}");
        }
        assert!(p(&["--control-fd", "2", "--socket-dir", "/d"]).is_err());
        assert!(p(&["--socket-dir", "/d"]).is_err());
        assert!(p(&["--control-fd", "3"]).is_err());
        assert!(p(&["--control-fd", "3", "--socket-dir", "/d", "--bogus", "1"]).is_err());
        assert!(p(&[
            "--control-fd",
            "3",
            "--control-fd",
            "4",
            "--socket-dir",
            "/d"
        ])
        .is_err());
        assert!(p(&[
            "--control-fd",
            "3",
            "--socket-dir",
            "/d",
            "--log-level",
            "debug"
        ])
        .is_ok());
        assert!(p(&[
            "--control-fd",
            "3",
            "--socket-dir",
            "/d",
            "--log-level",
            "x"
        ])
        .is_err());
    }
}
