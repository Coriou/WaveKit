use serde_json::Value;
use std::io::Read;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wavekit_chan::args::{parse, Args, Command, VERSION_LINE};
use wavekit_chan::protocol::{parse_observed_request, parse_request, ObservedRequest, Request};
use wavekit_chan::runtime::Runtime;

fn line(id: &str, format: &str, gain: &str) -> String {
    format!(
        r#"{{"v":1,"type":"open","id":"{id}","centerHz":162010000,"bandwidthHz":45600,"transitionHz":1200,"outputRateHz":48000,"format":"{format}","queueBytes":1048576{gain}}}"#
    )
}
fn observed(line: &str, token: &str) -> String {
    line.replacen(
        "\"type\":\"open\"",
        &format!("\"type\":\"open-observed\",\"token\":\"{token}\""),
        1,
    )
}

#[test]
fn opt_in_args_preserve_default_struct_version_and_private_fd3() {
    let args: Vec<String> = "--generation 3 --input-format cu8 --input-rate 2048000 --input-center 162000000 --usable-fraction 0.8 --block-samples 16384 --socket-dir /tmp/s --control-fd 3"
        .split_whitespace().map(String::from).collect();
    let Command::Run(default) = parse(&args).unwrap() else {
        panic!("default run");
    };
    assert_eq!(default.control_fd, 3);
    assert_eq!(VERSION_LINE, "wavekit-chan 0.1.0 protocol 1");
    let mut opt = args.clone();
    opt.extend(["--settlement-socket".into(), "/tmp/private/ack.sock".into()]);
    let Command::RunObserved {
        args: enabled,
        settlement_socket,
    } = parse(&opt).unwrap()
    else {
        panic!("observed run");
    };
    assert_eq!(enabled, default);
    assert_eq!(settlement_socket, PathBuf::from("/tmp/private/ack.sock"));
    for path in [
        "relative.sock".into(),
        format!("/{}", "a".repeat(90)),
        "\0".into(),
    ] {
        *opt.last_mut().unwrap() = path;
        assert!(parse(&opt).is_err());
    }
    *opt.last_mut().unwrap() = "/tmp/ok.sock".into();
    let i = opt.iter().position(|s| s == "--control-fd").unwrap();
    opt[i + 1] = "4".into();
    assert!(
        parse(&opt).is_err(),
        "observed cannot alias FD4 bootstrap with control"
    );
    assert!(parse(&["--settlement-socket".into()]).is_err());
}

#[test]
fn ordinary_strict_v1_and_observed_field_gain_queue_token_parity() {
    for (format, gain) in [
        ("cf32", ""),
        ("cu8", ""),
        ("cu8", ",\"gain\":0.000001"),
        ("cu8", ",\"gain\":1000000"),
    ] {
        let ordinary = line("id", format, gain);
        let expected = parse_request(&ordinary).unwrap();
        assert_eq!(
            parse_observed_request(&ordinary).unwrap(),
            ObservedRequest::Ordinary(expected.clone())
        );
        let private = observed(&ordinary, "18446744073709551615");
        assert!(
            parse_request(&private).is_err(),
            "default parser cannot silently enable observation"
        );
        let ObservedRequest::Open { token, request } = parse_observed_request(&private).unwrap()
        else {
            panic!("private open");
        };
        assert_eq!(token, u64::MAX);
        assert_eq!(Request::Open(request), expected);
    }
    let duplicate_ordinary =
        line("id", "cf32", "").replace("\"id\":\"id\"", "\"id\":\"first\",\"id\":\"id\"");
    assert_eq!(
        parse_observed_request(&duplicate_ordinary).unwrap(),
        ObservedRequest::Ordinary(parse_request(&duplicate_ordinary).unwrap())
    );
    let private = observed(&line("id", "cf32", ""), "1");
    for token in [
        "",
        "0",
        "01",
        "+1",
        "-1",
        "1.0",
        "1e0",
        "18446744073709551616",
        "١",
    ] {
        assert!(
            parse_observed_request(
                &private.replace("\"token\":\"1\"", &format!("\"token\":\"{token}\""))
            )
            .is_err(),
            "{token}"
        );
    }
    for invalid in [
        private.replace("\"token\":\"1\"", "\"token\":1"),
        private.replace("\"token\":\"1\"", "\"token\":\"1\",\"token\":\"2\""),
        private.replace("\"id\":\"id\"", "\"id\":\"id\",\"id\":\"other\""),
        private.replace("\"id\":\"id\"", "\"id\":\"\\u0069d\""),
        private.replace("\"v\":1", "\"v\":1,\"extra\":1"),
    ] {
        assert!(parse_observed_request(&invalid).is_err(), "{invalid}");
    }
    for ordinary in [
        line("id", "cf32", ",\"gain\":1"),
        line("id", "cu8", ",\"gain\":0"),
        line("id", "bad", ""),
        line("id", "cu8", "").replace("1048576", "67108865"),
    ] {
        assert!(parse_request(&ordinary).is_err());
        assert!(matches!(
            parse_observed_request(&observed(&ordinary, "2")),
            Ok(ObservedRequest::InvalidOpen { token: 2, .. })
        ));
    }
    for ordinary in [
        r#"{"v":1,"type":"close","id":"x"}"#,
        r#"{"v":1,"type":"shutdown"}"#,
        r#"{"v":1,"type":"mark-gap","atInputByte":0,"droppedInputBytes":512}"#,
    ] {
        assert_eq!(
            parse_observed_request(ordinary).unwrap(),
            ObservedRequest::Ordinary(parse_request(ordinary).unwrap())
        );
    }
}

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = PathBuf::from(format!(
            "/tmp/wkp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn output(private: bool, format: &str, gain: &str) -> (Vec<u8>, Vec<Value>) {
    let dir = Directory::new();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = events.clone();
    let sink = Box::new(move |value| captured.lock().unwrap().push(value));
    let args = Args {
        generation: 1,
        input_rate: 2_048_000,
        input_center: 162e6,
        usable_fraction: 0.8,
        block_samples: 16384,
        socket_dir: dir.0.clone(),
        control_fd: 3,
    };
    let (stream, _proof_peer) = UnixStream::pair().unwrap();
    let mut runtime = if private {
        Runtime::with_settlement(args, sink, stream).unwrap()
    } else {
        Runtime::new(args, sink)
    };
    let open = line("dsp", format, gain);
    if private {
        runtime.on_observed_request(parse_observed_request(&observed(&open, "1")).unwrap());
    } else {
        runtime.on_request(parse_request(&open).unwrap());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let installed = loop {
        runtime.poll_prepared();
        if let Some(event) = events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "opened")
            .cloned()
        {
            break event;
        }
        assert!(Instant::now() < deadline, "open did not install");
        std::thread::sleep(Duration::from_millis(1));
    };
    let client = UnixStream::connect(installed["socket"].as_str().unwrap()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let reader = std::thread::spawn(move || {
        let mut client = client;
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let iq: Vec<u8> = (0..160_001u32)
        .map(|n| (n.wrapping_mul(31) % 256) as u8)
        .collect();
    runtime.on_request(Request::MarkGap {
        at_input_byte: Some(40_001),
        dropped_input_bytes: Some(512),
    });
    for block in iq.chunks(333) {
        runtime.on_input(block);
        runtime.poll_disposal();
    }
    runtime.on_eof();
    let bytes = reader.join().unwrap();
    let mut values = events.lock().unwrap().clone();
    for value in &mut values {
        if let Some(object) = value.as_object_mut() {
            object.remove("socket");
        }
    }
    (bytes, values)
}

#[test]
fn opt_in_preserves_exact_dsp_bytes_taps_delay_gap_samples_gain_and_odd_eof() {
    for (format, gain) in [("cf32", ""), ("cu8", ",\"gain\":2.5")] {
        let ordinary = output(false, format, gain);
        let observed = output(true, format, gain);
        assert!(!ordinary.0.is_empty());
        assert_eq!(
            observed, ordinary,
            "exact output bytes and all ordinary event fields"
        );
        assert_eq!(ordinary.1.last().unwrap()["discardedBytes"], 1);
    }
}
