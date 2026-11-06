//! CPU cost of the IQ channel DSP, per stage, for one channel request. Not a test.
//! Defaults to the fanout-headroom bench's channel: 2.4 Msps cu8 input, 48 kHz out,
//! 12.5 kHz wide with a 5 kHz transition, 10 s of synthetic input.
//!
//! Run: `cargo run --release --locked --offline --example chan_bench --manifest-path native/wavekit-chan/Cargo.toml -- [FS OUT BW TR [SECONDS]]`
//! All of FS, OUT, BW and TR are in Hz, as a decoder's channel request states them.
//!
//! Prints, per channel: the planned stages with their multiplies per second, then ns per input
//! sample for the NCO and each stage, measured on one thread, and the share of a core the
//! channel costs at its real-time input rate. `best block` repeats that from each stage's
//! sum of each stage's fastest block, not one observed block: on a shared host preemption inflates the mean, not a minimum.
//! `output hash` covers every output float's bits, to compare builds on the same request.

use std::hint::black_box;
use std::time::Instant;

use wavekit_chan::convert::{cu8_to_f32, InputAssembler};
use wavekit_chan::plan::plan_chain;
use wavekit_chan::stages::{Nco, RationalFir};

const BLOCK: usize = 32_768;

fn arg<T: std::str::FromStr>(args: &[String], at: usize, default: T) -> T {
    args.get(at)
        .map(|v| v.parse().unwrap_or_else(|_| panic!("bad argument {v}")))
        .unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fs: u64 = arg(&args, 0, 2_400_000);
    let out: u64 = arg(&args, 1, 48_000);
    let bw: f64 = arg(&args, 2, 12_500.0);
    let tr: f64 = arg(&args, 3, 5_000.0);
    let seconds: u64 = arg(&args, 4, 10);
    let n = (fs * seconds) as usize;
    let mut seed = 0x2545_f491u32;
    let bytes: Vec<u8> = (0..BLOCK * 2)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed >> 24) as u8
        })
        .collect();
    let (bi, bq): (Vec<f32>, Vec<f32>) = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[i, q]| (cu8_to_f32(i), cu8_to_f32(q)))
        .unzip();
    let plan = plan_chain(fs, out, bw, tr).expect("plan");
    println!("request fs={fs} out={out} bw={bw} tr={tr}");
    for s in &plan.stages {
        // One output runs a dot of ⌈taps/L⌉ for I and again for Q.
        let per_phase = s.prototype.len().div_ceil(s.spec.l);
        println!(
            "stage L={} M={} taps={} per_phase={} in={} out={} mac_per_s={:.0}M",
            s.spec.l,
            s.spec.m,
            s.prototype.len(),
            per_phase,
            s.spec.in_rate,
            s.spec.out_rate,
            2.0 * per_phase as f64 * s.spec.out_rate / 1e6
        );
    }
    let mut nco = Nco::new(-(fs as f64) / 8.0, fs as f64);
    let mut stages: Vec<RationalFir> = plan
        .stages
        .iter()
        .map(|s| RationalFir::new(s.spec.l, s.spec.m, &s.prototype))
        .collect();
    let mut ns = vec![0u128; stages.len() + 1];
    let mut best = vec![u128::MAX; stages.len() + 1];
    let mut done = 0usize;
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    while done < n {
        let (mut ai, mut aq) = (bi.clone(), bq.clone());
        let t = Instant::now();
        nco.mix(&mut ai, &mut aq);
        let spent = t.elapsed().as_nanos();
        ns[0] += spent;
        best[0] = best[0].min(spent);
        for (k, st) in stages.iter_mut().enumerate() {
            let (mut oi, mut oq) = (Vec::with_capacity(ai.len()), Vec::with_capacity(ai.len()));
            let t = Instant::now();
            st.process(&ai, &aq, &mut oi, &mut oq);
            let spent = t.elapsed().as_nanos();
            ns[k + 1] += spent;
            best[k + 1] = best[k + 1].min(spent);
            ai = oi;
            aq = oq;
        }
        for v in ai.iter().chain(&aq) {
            hash = (hash ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
        black_box((&ai, &aq));
        done += BLOCK;
    }
    let mut asm = InputAssembler::default();
    let (mut ci, mut cq) = (Vec::with_capacity(BLOCK), Vec::with_capacity(BLOCK));
    let t = Instant::now();
    for _ in 0..done / BLOCK {
        ci.clear();
        cq.clear();
        asm.push(&bytes, &mut ci, &mut cq);
        black_box((&ci, &cq));
    }
    println!(
        "cu8 input conversion (once per block, all channels): {:.2} ns/input sample",
        t.elapsed().as_nanos() as f64 / done as f64
    );
    let total: u128 = ns.iter().sum();
    println!("nco: {:.2} ns/input sample", ns[0] as f64 / done as f64);
    for (k, v) in ns.iter().enumerate().skip(1) {
        println!(
            "stage {}: {:.2} ns/input sample",
            k - 1,
            *v as f64 / done as f64
        );
    }
    let per_sample = total as f64 / done as f64;
    println!(
        "total: {:.2} ns/input sample, {:.3} CPU s per Msample per channel, {:.3} core at {} sps",
        per_sample,
        per_sample / 1e3,
        per_sample * fs as f64 / 1e9,
        fs
    );
    println!("output hash: {hash:016x}");
    let fastest = best.iter().sum::<u128>() as f64 / BLOCK as f64;
    println!(
        "best block: {:.2} ns/input sample ({:.2} in the NCO), {:.3} core at {} sps",
        fastest,
        best[0] as f64 / BLOCK as f64,
        fastest * fs as f64 / 1e9,
        fs
    );
}
