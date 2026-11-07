//! Host tests of the chain and the layout checks. The wasm32 SIMD build is compared with the JS
//! chain itself in tests/unit/core/scanner/channel/wideband-nfm-wasm*.test.ts.

use super::*;

struct Host {
    mem: Vec<u64>,
    ctl: usize,
    off: [usize; 10],
}

const CTL: usize = 64;

fn dims(k: usize, m: usize, max_in: usize) -> Dims {
    let n48 = max_in.div_ceil(k * m) + 2;
    Dims {
        k,
        m,
        t2: 10 * m + 1,
        tc: 63,
        td: 127,
        max_in,
        out_cap: n48.div_ceil(6) + 1,
    }
}

impl Host {
    fn new(d: Dims, rot: (f64, f64), step: f64) -> Host {
        let mut off = [0usize; 10];
        let mut at = CTL + CTL_BYTES;
        for (k, &r) in REGIONS.iter().enumerate() {
            at = at.div_ceil(16) * 16;
            off[k] = at;
            at += region_bytes(r, &d);
        }
        let mut h = Host {
            mem: vec![0u64; at.div_ceil(8) + 8],
            ctl: CTL,
            off,
        };
        for (i, v) in [
            (C_ABI, ABI),
            (C_K, d.k as u32),
            (C_M, d.m as u32),
            (C_T2, d.t2 as u32),
            (C_TC, d.tc as u32),
            (C_TD, d.td as u32),
            (C_EXACT, (step == 1.0) as u32),
            (C_HIGH_PASS, 1),
            (C_MAX_IN, d.max_in as u32),
            (C_OUT_CAP, d.out_cap as u32),
            (C_END, at as u32),
        ] {
            h.set(i, v);
        }
        for (k, &o) in off.iter().enumerate() {
            h.set(C_REGION + k, o as u32);
        }
        h.setf(F_ROT_RE, rot.0);
        h.setf(F_ROT_IM, rot.1);
        h.setf(F_CIC_SCALE, 1.0 / (d.k * d.k) as f64);
        h.setf(F_STEP, step);
        h.setf(F_SCALE, 48_000.0 / (2.0 * core::f64::consts::PI * 5000.0));
        h.setf(F_ALPHA, 0.027);
        h.setf(F_PH_RE, 1.0);
        // biquads: identity (b0 = 1)
        for q in 0..4 {
            h.setf(F_BIQUAD + 5 * q, 1.0);
        }
        let lut = h.f64s(R::Lut, 256);
        for (u, v) in lut.iter_mut().enumerate() {
            *v = ((u as f64 - 127.5) / 127.5) as f32 as f64;
        }
        for (r, t) in [(R::S2Taps, d.t2), (R::ChTaps, d.tc), (R::DmTaps, d.td)] {
            for v in h.f64s(r, t).iter_mut() {
                *v = (1.0 / t as f64) as f32 as f64;
            }
        }
        h
    }

    fn mem(&mut self) -> Mem {
        Mem {
            base: self.mem.as_mut_ptr() as usize,
            size: self.mem.len() * 8,
        }
    }

    fn set(&mut self, i: usize, v: u32) {
        let m = self.mem();
        unsafe { m.set_u32(self.ctl, i, v) }
    }

    fn get(&mut self, i: usize) -> u32 {
        let m = self.mem();
        unsafe { m.u32(self.ctl, i) }
    }

    fn setf(&mut self, i: usize, v: f64) {
        let m = self.mem();
        unsafe { m.set_f64(self.ctl, i, v) }
    }

    fn f64s(&mut self, r: R, len: usize) -> &mut [f64] {
        let o = self.off[Layout::idx(r)];
        let m = self.mem();
        unsafe { core::slice::from_raw_parts_mut(m.at::<f64>(o), len) }
    }

    fn bytes(&mut self, r: R, len: usize) -> &mut [u8] {
        let o = self.off[Layout::idx(r)];
        let m = self.mem();
        unsafe { core::slice::from_raw_parts_mut(m.at::<u8>(o), len) }
    }

    fn i16s(&mut self, r: R, len: usize) -> Vec<i16> {
        let o = self.off[Layout::idx(r)];
        let m = self.mem();
        unsafe { core::slice::from_raw_parts(m.at::<i16>(o), len).to_vec() }
    }

    fn run(&mut self, cu8: &[u8]) -> Result<(Vec<i16>, Vec<i16>), u32> {
        self.bytes(R::Input, cu8.len()).copy_from_slice(cu8);
        self.set(C_N_IN, (cu8.len() / 2) as u32);
        let m = self.mem();
        let status = unsafe { run(m, self.ctl) };
        if status != E_OK {
            return Err(status);
        }
        let n = self.get(C_N_OUT) as usize;
        Ok((self.i16s(R::Pcm, n), self.i16s(R::Tone, n)))
    }
}

/// A deterministic FM-modulated tone around the channel, CU8.
fn fm_signal(n: usize, fs: f64, offset: f64) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 * n);
    let mut phase = 0.0f64;
    let mut seed = 12345u32;
    for i in 0..n {
        let t = i as f64 / fs;
        let dev = 3000.0 * (2.0 * core::f64::consts::PI * 1000.0 * t).sin();
        phase += 2.0 * core::f64::consts::PI * (offset + dev) / fs;
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
        let noise = ((seed >> 16) & 7) as f64 - 3.5;
        out.push((127.5 + 90.0 * phase.cos() + noise).clamp(0.0, 255.0) as u8);
        out.push((127.5 + 90.0 * phase.sin() + noise).clamp(0.0, 255.0) as u8);
    }
    out
}

fn rot(offset: f64, fs: f64) -> (f64, f64) {
    let w = -2.0 * core::f64::consts::PI * offset / fs;
    (w.cos(), w.sin())
}

#[test]
fn round_js_matches_math_round() {
    for (x, want) in [
        (0.5, 1.0),
        (-0.5, -0.0),
        (1.5, 2.0),
        (-1.5, -1.0),
        (2.4999, 2.0),
        (-2.5001, -3.0),
        (0.499_999_999_999_999_94, 0.0),
        (4_503_599_627_370_495.5, 4_503_599_627_370_496.0),
    ] {
        let got = round_js(x);
        assert_eq!(got, want, "round({x})");
        assert_eq!(
            got.is_sign_negative(),
            want.is_sign_negative(),
            "sign of round({x})"
        );
    }
    assert!(round_js(f64::NAN).is_nan());
}

#[test]
fn s16_conversions_clamp_and_zero_nan() {
    assert_eq!(s16_clamped_round(40_000.0), 32767);
    assert_eq!(s16_clamped_round(-40_000.0), -32768);
    assert_eq!(s16_clamped_round(32766.5), 32767);
    assert_eq!(s16_clamped_round(-32768.5), -32768);
    assert_eq!(s16_clamped_round(f64::NAN), 0);
    assert_eq!(s16_round_clamped(32767.2), 32767);
    assert_eq!(s16_round_clamped(-32768.2), -32768);
    assert_eq!(s16_round_clamped(-0.5), 0);
    assert_eq!(s16_round_clamped(f64::NAN), 0);
}

#[test]
fn hypot_js_rules() {
    assert_eq!(hypot_js(3.0, 4.0), 5.0);
    assert_eq!(hypot_js(0.0, -0.0), 0.0);
    assert_eq!(hypot_js(f64::NAN, f64::INFINITY), f64::INFINITY);
    assert!(hypot_js(f64::NAN, 1.0).is_nan());
    assert_eq!(hypot_js(-1.0, 0.0), 1.0);
    let v = hypot_js(0.6, 0.8);
    assert!((v - 1.0).abs() < 1e-15);
}

#[test]
fn layout_checks_reject_bad_blocks() {
    let d = dims(7, 3, 4096);
    let mut h = Host::new(
        d,
        rot(12_500.0, 1_024_000.0),
        48_761.904_761_904_76 / 48_000.0,
    );
    let m = h.mem();
    assert_eq!(unsafe { check_only(m, h.ctl) }, E_OK);
    assert_eq!(
        unsafe { check_only(m, h.ctl + 4) },
        E_LAYOUT,
        "misaligned control block"
    );
    assert_eq!(
        unsafe { check_only(m, m.size) },
        E_LAYOUT,
        "control block past the end"
    );

    h.set(C_ABI, ABI + 1);
    assert_eq!(h.run(&[0, 0]), Err(E_ABI));
    h.set(C_ABI, ABI);

    // overlapping regions
    let s2 = h.get(C_REGION + 1);
    h.set(C_REGION + 2, s2);
    assert_eq!(h.run(&[0, 0]), Err(E_LAYOUT));
    h.set(C_REGION + 2, h.off[2] as u32);

    // end past the memory
    let size = h.mem().size as u32;
    let end = h.get(C_END);
    h.set(C_END, size + 8);
    assert_eq!(h.run(&[0, 0]), Err(E_LAYOUT));
    h.set(C_END, end);

    for (dim, bad) in [
        (C_K, 0),
        (C_M, 0),
        (C_TC, 0),
        (C_TD, MAX_TAPS as u32 + 1),
        (C_MAX_IN, 0),
    ] {
        let was = h.get(dim);
        h.set(dim, bad);
        assert_eq!(h.run(&[0, 0]), Err(E_LAYOUT), "dimension {dim} = {bad}");
        h.set(dim, was);
    }

    // a dimension that makes a region overrun `end`
    let tc = h.get(C_TC);
    h.set(C_TC, tc + 1);
    assert_eq!(h.run(&[0, 0]), Err(E_LAYOUT));
    h.set(C_TC, tc);

    assert!(h.run(&[0, 0]).is_ok());
}

#[test]
fn state_and_input_out_of_range_touch_nothing() {
    let d = dims(7, 3, 4096);
    let mut h = Host::new(d, rot(0.0, 1_024_000.0), 1.0);
    let before = h.mem.clone();
    for (slot, bad) in [
        (C_PHASE, 7),
        (C_S2_PHASE, 3),
        (C_SINCE_RENORM, RENORM_EVERY),
        (C_S2_HEAD, 31),
        (C_CH_HEAD, 63),
        (C_DM_HEAD, 127),
        (C_DM_PHASE, DEMOD_DECIMATION),
    ] {
        h.set(slot, bad);
        let m = h.mem();
        assert_eq!(unsafe { run(m, h.ctl) }, E_STATE, "slot {slot} = {bad}");
        h.set(slot, 0);
    }
    // the last legal values pass
    for (slot, last) in [
        (C_PHASE, 6),
        (C_S2_PHASE, 2),
        (C_SINCE_RENORM, RENORM_EVERY - 1),
        (C_S2_HEAD, 30),
        (C_CH_HEAD, 62),
        (C_DM_HEAD, 126),
        (C_DM_PHASE, 5),
    ] {
        h.set(slot, last);
        let m = h.mem();
        h.set(C_N_IN, 0);
        assert_eq!(unsafe { run(m, h.ctl) }, E_OK, "slot {slot} = {last}");
        h = Host::new(d, rot(0.0, 1_024_000.0), 1.0);
    }
    h.set(C_N_IN, 4097);
    let m = h.mem();
    assert_eq!(unsafe { run(m, h.ctl) }, E_INPUT);
    h.set(C_N_IN, 0);
    assert_eq!(h.mem, before, "rejected runs wrote nothing");
    h.set(C_N_IN, 4096);
    let m = h.mem();
    assert_eq!(unsafe { run(m, h.ctl) }, E_OK, "MAX_IN itself is taken");
}

#[test]
fn output_bound_holds_at_max_input() {
    // k · m = 1 (a 48 to 96 kHz input) is the densest output: one 48 kHz sample per input sample.
    let d = dims(1, 1, 8192);
    let mut h = Host::new(d, rot(1000.0, 48_000.0), 1.0);
    let x = fm_signal(8192, 48_000.0, 1000.0);
    let (pcm, tone) = h.run(&x).expect("run");
    assert_eq!(pcm.len(), 8192 / 6);
    assert_eq!(tone.len(), pcm.len());
    assert!(pcm.len() <= d.out_cap);
}

#[test]
fn chunk_splits_do_not_change_the_output() {
    for (fs, k, m, step) in [
        (1_024_000.0, 7, 3, 1_024_000.0 / 21.0 / 48_000.0),
        (2_400_000.0, 10, 5, 1.0),
    ] {
        let d = dims(k, m, 20_000);
        let x = fm_signal(400_000, fs, 25_000.0);
        let mut whole = Host::new(d, rot(25_000.0, fs), step);
        let mut a = Vec::new();
        let mut at = 0;
        while at < x.len() {
            let e = (at + 2 * 20_000).min(x.len());
            a.extend(whole.run(&x[at..e]).expect("run").0);
            at = e;
        }
        let mut split = Host::new(d, rot(25_000.0, fs), step);
        let mut b = Vec::new();
        let mut at = 0;
        let mut len = 1usize;
        while at < x.len() {
            let e = (at + 2 * len).min(x.len());
            b.extend(split.run(&x[at..e]).expect("run").0);
            at = e;
            len = len * 7 % 19_999 + 1;
        }
        assert!(a.len() > 1000);
        assert_eq!(a, b, "fs {fs}");
    }
}
