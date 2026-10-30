use std::path::PathBuf;

pub const VERSION_LINE: &str = "wavekit-chan 0.2.0 protocol 3";

#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub generation: u64,
    pub input_rate: u64,
    pub input_center: f64,
    pub usable_fraction: f64,
    pub block_samples: usize,
    pub socket_dir: PathBuf,
    pub control_fd: i32,
    /// `--dsp-helpers`: DSP pool helper threads, clamped to `MAX_DSP_HELPERS`; `None` defers to
    /// `WAVEKIT_CHAN_DSP_HELPERS`, then the host default (`dsp_pool::resolve_dsp_helpers`).
    pub dsp_helpers: Option<usize>,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Version,
    Run(Args),
    RunObserved {
        args: Args,
        settlement_socket: PathBuf,
    },
}

pub fn parse(argv: &[String]) -> Result<Command, String> {
    if argv.len() == 1 && argv[0] == "--version" {
        return Ok(Command::Version);
    }
    let mut map = std::collections::HashMap::new();
    let mut it = argv.iter();
    while let Some(k) = it.next() {
        let key = k
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {k}"))?;
        let val = it.next().ok_or_else(|| format!("--{key} needs a value"))?;
        map.insert(key.to_string(), val.clone());
    }
    let get = |k: &str| map.get(k).cloned().ok_or_else(|| format!("missing --{k}"));
    let num = |k: &str| -> Result<f64, String> {
        get(k)?
            .parse::<f64>()
            .map_err(|_| format!("--{k} not a number"))
    };
    let known = [
        "generation",
        "input-format",
        "input-rate",
        "input-center",
        "usable-fraction",
        "block-samples",
        "socket-dir",
        "control-fd",
        "settlement-socket",
        "dsp-helpers",
    ];
    if let Some(bad) = map.keys().find(|k| !known.contains(&k.as_str())) {
        return Err(format!("unknown option --{bad}"));
    }
    if get("input-format")? != "cu8" {
        return Err("only --input-format cu8 is supported".into());
    }
    let input_rate = get("input-rate")?
        .parse::<u64>()
        .map_err(|_| "--input-rate must be an integer".to_string())?;
    if input_rate == 0 {
        return Err("--input-rate must be > 0".into());
    }
    let usable_fraction = num("usable-fraction")?;
    if !(0.5..=0.95).contains(&usable_fraction) {
        return Err("--usable-fraction must be within 0.5..0.95".into());
    }
    let block_samples = get("block-samples")?
        .parse::<usize>()
        .map_err(|_| "--block-samples must be an integer".to_string())?;
    if !(256..=1 << 20).contains(&block_samples) {
        return Err("--block-samples must be within 256..1048576".into());
    }
    let input_center = num("input-center")?;
    if !input_center.is_finite() {
        return Err("--input-center must be finite".into());
    }
    let control_fd: i32 = get("control-fd")?
        .parse()
        .map_err(|_| "--control-fd must be an integer".to_string())?;
    if control_fd < 3 {
        return Err("--control-fd must be >= 3 (0-2 carry IQ, events and logs)".into());
    }
    let dsp_helpers = map
        .get("dsp-helpers")
        .map(|v| crate::dsp_pool::parse_dsp_helpers(v).map_err(|e| format!("--dsp-helpers {e}")))
        .transpose()?;
    let args = Args {
        generation: get("generation")?
            .parse()
            .map_err(|_| "--generation must be an integer".to_string())?,
        input_rate,
        input_center,
        usable_fraction,
        block_samples,
        socket_dir: PathBuf::from(get("socket-dir")?),
        control_fd,
        dsp_helpers,
    };
    match map.get("settlement-socket") {
        None => Ok(Command::Run(args)),
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute()
                || path.as_os_str().as_encoded_bytes().len() > 90
                || path.to_str().is_none()
                || path.as_os_str().as_encoded_bytes().contains(&0)
                || control_fd == 4
            {
                return Err("--settlement-socket requires an absolute UTF-8 path <=90 bytes and private FD4".into());
            }
            Ok(Command::RunObserved {
                args,
                settlement_socket: path,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn parses_the_spawn_line() {
        let cmd = parse(&v("--generation 3 --input-format cu8 --input-rate 2048000 --input-center 162000000 --usable-fraction 0.8 --block-samples 16384 --socket-dir /tmp/s --control-fd 3")).unwrap();
        assert_eq!(
            cmd,
            Command::Run(Args {
                generation: 3,
                input_rate: 2_048_000,
                input_center: 162e6,
                usable_fraction: 0.8,
                block_samples: 16384,
                socket_dir: "/tmp/s".into(),
                control_fd: 3,
                dsp_helpers: None,
            })
        );
    }
    #[test]
    fn dsp_helpers_is_validated_and_clamped() {
        let line = |n: &str| {
            v(&format!("--generation 1 --input-format cu8 --input-rate 2048000 --input-center 1 --usable-fraction 0.8 --block-samples 16384 --socket-dir /t --control-fd 3 --dsp-helpers {n}"))
        };
        let helpers = |n: &str| match parse(&line(n)) {
            Ok(Command::Run(a)) => Ok(a.dsp_helpers),
            Ok(other) => panic!("{other:?}"),
            Err(e) => Err(e),
        };
        assert_eq!(helpers("0"), Ok(Some(0)));
        assert_eq!(helpers("3"), Ok(Some(crate::dsp_pool::MAX_DSP_HELPERS)));
        assert_eq!(helpers("4"), Ok(Some(crate::dsp_pool::MAX_DSP_HELPERS)));
        for bad in ["-1", "x", "1.0"] {
            let e = helpers(bad).unwrap_err();
            assert!(e.starts_with("--dsp-helpers must be"), "{e}");
        }
    }
    #[test]
    fn version() {
        assert_eq!(parse(&v("--version")).unwrap(), Command::Version);
    }
    #[test]
    fn rejects_bad_values() {
        assert!(parse(&v("--generation 1 --input-format cs16 --input-rate 1 --input-center 1 --usable-fraction 0.8 --block-samples 16384 --socket-dir /t --control-fd 3")).is_err());
        assert!(parse(&v("--generation 1 --input-format cu8 --input-rate 2048000 --input-center 1 --usable-fraction 0.99 --block-samples 16384 --socket-dir /t --control-fd 3")).is_err());
        assert!(parse(&v("--generation 1 --input-format cu8 --input-rate 0 --input-center 1 --usable-fraction 0.8 --block-samples 16384 --socket-dir /t --control-fd 3")).is_err());
        assert!(parse(&v("--bogus 1")).is_err());
        assert!(parse(&v("--generation 1 --input-format cu8 --input-rate 2048000 --input-center 1 --usable-fraction 0.8 --block-samples 16384 --socket-dir /t --control-fd -1")).is_err());
        for fd in 0..3 {
            let line = format!("--generation 1 --input-format cu8 --input-rate 2048000 --input-center 1 --usable-fraction 0.8 --block-samples 16384 --socket-dir /t --control-fd {fd}");
            assert!(parse(&v(&line)).is_err(), "fd {fd} would take over stdio");
        }
    }
}
