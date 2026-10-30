//! Reproduce: cargo run --manifest-path native/wavekit-chan/Cargo.toml --release --offline -j1 --example open_latency
//! Twelve observations per rate; no warmup is discarded. Destruction is outside each timer.
//! `fir_state` isolates accessible RationalFir construction; it is not a complete ChannelDsp.
//! Cold requests use fresh runtimes; warm identical/offset/format/gain requests reuse their cache.
//! `opened` is send-to-observed-event latency with 1 ms polling resolution, including enqueue.
use serde_json::Value;
use std::hint::black_box;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wavekit_chan::{
    args::Args,
    channel::{ChannelDsp, ChannelSpec, Format},
    plan::plan_chain,
    protocol::{OpenReq, Request},
    runtime::Runtime,
    stages::RationalFir,
};

fn report(rate: u64, name: &str, times: &[f64]) {
    let mut sorted = times.to_vec();
    sorted.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"rate": rate, "measurement": name,
        "samples_ms": times, "min_ms": sorted[0], "median_ms": (sorted[5]+sorted[6])/2.0,
        "p95_ms": sorted[11], "max_ms": sorted[11],
        "mean_ms": times.iter().sum::<f64>()/times.len() as f64})
    );
}

/// Enqueue and send-to-observed-opened are distinct. Poll resolution is 1 ms.
fn runtime_open(
    runtime: &mut Runtime,
    events: &Arc<Mutex<Vec<Value>>>,
    request: OpenReq,
) -> (f64, f64) {
    let first = events.lock().unwrap().len();
    let id = request.id.clone();
    let start = Instant::now();
    runtime.on_request(Request::Open(request));
    let enqueue_ms = start.elapsed().as_secs_f64() * 1000.0;
    loop {
        runtime.poll_prepared();
        let done = {
            let events = events.lock().unwrap();
            assert!(
                !events[first..].iter().any(|e| e["type"] == "rejected"),
                "{:?}",
                &events[first..]
            );
            events[first..]
                .iter()
                .any(|e| e["type"] == "opened" && e["id"] == id)
        };
        if done {
            let opened_ms = start.elapsed().as_secs_f64() * 1000.0;
            runtime.on_request(Request::Close { id });
            return (enqueue_ms, opened_ms);
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "open deadline exceeded"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn main() {
    let dir = std::env::temp_dir().join(format!("wk-open-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    for rate in [48_000, 384_000, 1_000_000, 1_050_000] {
        let bw = rate as f64 * 0.95;
        let tr = rate as f64 * 0.025;
        let spec = ChannelSpec {
            input_rate: 2_048_000,
            offset_hz: 0.0,
            bandwidth_hz: bw,
            transition_hz: tr,
            output_rate: rate,
            format: Format::Cu8,
            gain: 1.0,
        };
        let (mut plans, mut states, mut dsps) = (vec![], vec![], vec![]);
        let mut runtime_times: Vec<(&str, Vec<f64>, Vec<f64>)> = [
            "cold",
            "warm_identical",
            "warm_offset",
            "warm_format",
            "warm_gain",
        ]
        .into_iter()
        .map(|name| (name, vec![], vec![]))
        .collect();
        for sample in 0..12 {
            let start = Instant::now();
            let plan = black_box(plan_chain(2_048_000, rate, bw, tr).unwrap());
            plans.push(start.elapsed().as_secs_f64() * 1000.0);
            if sample == 0 {
                println!(
                    "{}",
                    serde_json::json!({"rate": rate, "taps": plan.stages.iter().map(|s| s.prototype.len()).collect::<Vec<_>>(),
                    "ratios": plan.stages.iter().map(|s| [s.spec.l, s.spec.m]).collect::<Vec<_>>()})
                );
            }
            let start = Instant::now();
            let firs = black_box(
                plan.stages
                    .iter()
                    .map(|s| RationalFir::new(s.spec.l, s.spec.m, &s.prototype))
                    .collect::<Vec<_>>(),
            );
            states.push(start.elapsed().as_secs_f64() * 1000.0);
            drop(firs);
            let start = Instant::now();
            let dsp = black_box(ChannelDsp::new(spec.clone()).unwrap());
            dsps.push(start.elapsed().as_secs_f64() * 1000.0);
            drop(dsp);
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let mut runtime = Runtime::new(
                Args {
                    generation: 1,
                    input_rate: 2_048_000,
                    input_center: 162e6,
                    usable_fraction: 0.8,
                    block_samples: 16384,
                    socket_dir: dir.clone(),
                    control_fd: 3,
                    dsp_helpers: None,
                },
                Box::new(move |e| sink.lock().unwrap().push(e)),
            );
            for (name, enqueue, opened) in &mut runtime_times {
                let request = OpenReq {
                    id: "bench".into(),
                    center_hz: if *name == "warm_offset" {
                        162e6 + 10_000.0
                    } else {
                        162e6
                    },
                    bandwidth_hz: bw,
                    transition_hz: tr,
                    output_rate_hz: rate,
                    format: if *name == "warm_format" {
                        Format::Cf32
                    } else {
                        Format::Cu8
                    },
                    gain: if *name == "warm_gain" { 2.0 } else { 1.0 },
                    queue_bytes: 1 << 20,
                };
                let (queued_ms, opened_ms) = runtime_open(&mut runtime, &events, request);
                enqueue.push(queued_ms);
                opened.push(opened_ms);
            }
        }
        report(rate, "plan_chain", &plans);
        report(rate, "fir_state", &states);
        report(rate, "ChannelDsp_new", &dsps);
        for (name, enqueue, opened) in &runtime_times {
            report(rate, &format!("Runtime_{name}_enqueue"), enqueue);
            report(rate, &format!("Runtime_{name}_opened"), opened);
        }
    }
    std::fs::remove_dir(dir).unwrap();
}
