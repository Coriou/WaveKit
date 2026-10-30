//! CPU cost of the IQ channel DSP at 2.4 Msps cu8, per stage, for the fanout-headroom
//! bench's channel set (12.5 kHz wide, 5 kHz transition, 48 kHz cu8 out). Not a test.
//!
//! Run: `cargo run --release --locked --offline --example chan_bench --manifest-path native/wavekit-chan/Cargo.toml`
//!
//! Prints, per channel: the planned stages, then ns per input sample for the NCO and each
//! stage, measured on one thread over `SECONDS` of synthetic input.

use std::hint::black_box;
use std::time::Instant;

use wavekit_chan::convert::{cu8_to_f32, InputAssembler};
use wavekit_chan::plan::plan_chain;
use wavekit_chan::stages::{Nco, RationalFir};

const FS: u64 = 2_400_000;
const OUT: u64 = 48_000;
const BLOCK: usize = 32_768;
const SECONDS: u64 = 10;

fn main() {
    let n = (FS * SECONDS) as usize;
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
    let plan = plan_chain(FS, OUT, 12_500.0, 5_000.0).expect("plan");
    for s in &plan.stages {
        println!(
            "stage L={} M={} taps={} in={} out={}",
            s.spec.l,
            s.spec.m,
            s.prototype.len(),
            s.spec.in_rate,
            s.spec.out_rate
        );
    }
    let mut nco = Nco::new(-300_000.0, FS as f64);
    let mut stages: Vec<RationalFir> = plan
        .stages
        .iter()
        .map(|s| RationalFir::new(s.spec.l, s.spec.m, &s.prototype))
        .collect();
    let mut ns = vec![0u128; stages.len() + 1];
    let mut done = 0usize;
    while done < n {
        let (mut ai, mut aq) = (bi.clone(), bq.clone());
        let t = Instant::now();
        nco.mix(&mut ai, &mut aq);
        ns[0] += t.elapsed().as_nanos();
        for (k, st) in stages.iter_mut().enumerate() {
            let (mut oi, mut oq) = (Vec::with_capacity(ai.len()), Vec::with_capacity(ai.len()));
            let t = Instant::now();
            st.process(&ai, &aq, &mut oi, &mut oq);
            ns[k + 1] += t.elapsed().as_nanos();
            ai = oi;
            aq = oq;
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
    println!(
        "total: {:.2} ns/input sample, {:.3} CPU s per Msample per channel",
        total as f64 / done as f64,
        total as f64 / done as f64 / 1e3
    );
}
