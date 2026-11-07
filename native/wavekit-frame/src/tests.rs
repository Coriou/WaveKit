//! Host tests of the scalar kernel and the layout checks. The wasm32 SIMD build is compared with the
//! JS path itself in tests/unit/core/spectrum/frame-wasm-*.test.ts.

use super::*;

struct Host {
    mem: Vec<u8>,
    ctl: usize,
    off: [usize; 29],
    d: Dims,
}

const CTL: usize = 64;

impl Host {
    fn new(d: Dims, format: u32) -> Host {
        let mut off = [0usize; 29];
        let mut at = CTL + CTL_BYTES;
        for (k, &r) in REGIONS.iter().enumerate() {
            at = at.div_ceil(16) * 16;
            off[k] = at;
            at += region_bytes(r, &d);
        }
        let mut h = Host {
            mem: vec![0u8; at + 64],
            ctl: CTL,
            off,
            d,
        };
        h.set(C_ABI, ABI);
        h.set(C_N, d.n as u32);
        h.set(C_FORMAT, format);
        h.set(C_FRAME_BYTES, d.frame_bytes as u32);
        h.set(C_PEND_CAP, d.pend_cap as u32);
        h.set(C_SHORT_FRAMES, d.short_frames as u32);
        h.set(C_BATCH_CAP, d.batch_cap as u32);
        h.set(C_TRACK_CAP, d.track_cap as u32);
        h.set(C_END, at as u32);
        for k in 0..29 {
            h.set(C_REGION + k, off[k] as u32);
        }
        h.setf(F_SHORT_NEXT, -1.0);
        h.setf(F_HOP, d.n as f64);
        h.setf(F_RISE, 10f64.powf(0.6));
        h.setf(F_TINY, 1e-30);
        h.setf(
            F_FRAME_SCALE,
            1.0 / ((d.n as f64 / 2.0) * (d.n as f64 / 2.0)),
        );
        h.setf(F_TRACK_FLOOR, 1e-20);
        // tables the JS side writes
        let n = d.n;
        let bits = n.trailing_zeros();
        for i in 0..n {
            let w = (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()) as f32;
            h.wf32(R::Window, i, w);
            let r = (i as u32).reverse_bits() >> (32 - bits);
            h.wu32(R::Rev, i, r);
        }
        for k in 0..n / 2 {
            let a = 2.0 * std::f64::consts::PI * k as f64 / n as f64;
            h.wf64(R::Cos, k, a.cos());
            h.wf64(R::Sin, k, -a.sin());
        }
        for u in 0..256 {
            h.wf64(R::Lut, u, u as f64 / 127.5 - 1.0);
        }
        h
    }

    fn mem(&mut self) -> Mem {
        Mem {
            base: self.mem.as_mut_ptr().expose_provenance(),
            size: self.mem.len(),
        }
    }

    fn set(&mut self, i: usize, v: u32) {
        let o = self.ctl + 4 * i;
        self.mem[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn get(&self, i: usize) -> u32 {
        let o = self.ctl + 4 * i;
        u32::from_le_bytes(self.mem[o..o + 4].try_into().unwrap())
    }

    fn setf(&mut self, i: usize, v: f64) {
        let o = self.ctl + CTL_U32 * 4 + 8 * i;
        self.mem[o..o + 8].copy_from_slice(&v.to_le_bytes());
    }

    fn region(&self, r: R) -> usize {
        self.off[REGIONS.iter().position(|&x| x == r).unwrap()]
    }

    fn wf32(&mut self, r: R, i: usize, v: f32) {
        let o = self.region(r) + 4 * i;
        self.mem[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn wu32(&mut self, r: R, i: usize, v: u32) {
        let o = self.region(r) + 4 * i;
        self.mem[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn wf64(&mut self, r: R, i: usize, v: f64) {
        let o = self.region(r) + 8 * i;
        self.mem[o..o + 8].copy_from_slice(&v.to_le_bytes());
    }

    fn rf64(&self, r: R, i: usize) -> f64 {
        let o = self.region(r) + 8 * i;
        f64::from_le_bytes(self.mem[o..o + 8].try_into().unwrap())
    }

    fn wu8(&mut self, r: R, i: usize, v: u8) {
        let o = self.region(r) + i;
        self.mem[o] = v;
    }

    fn ru8(&self, r: R, i: usize) -> u8 {
        self.mem[self.region(r) + i]
    }

    fn init(&mut self) -> u32 {
        let m = self.mem();
        unsafe { init(m, self.ctl) }
    }

    fn run(&mut self) -> u32 {
        let m = self.mem();
        let mut db = |_: u32, _: f64, _: bool| false;
        unsafe { run(m, self.ctl, &mut db) }
    }

    /// Stages frame k as U8 IQ from (re, im) in [-1, 1].
    fn stage_u8(&mut self, k: usize, f: impl Fn(usize) -> (f64, f64)) {
        let base = self.region(R::Staging) + k * self.d.frame_bytes;
        for i in 0..self.d.n {
            let (a, b) = f(i);
            self.mem[base + 2 * i] = ((a + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
            self.mem[base + 2 * i + 1] = ((b + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
        }
        self.wf64(R::Starts, k, (k * self.d.n) as f64);
    }
}

fn dims(n: usize) -> Dims {
    Dims {
        n,
        frame_bytes: 2 * n,
        pend_cap: 4,
        short_frames: 2,
        batch_cap: 4,
        track_cap: 2,
    }
}

#[test]
fn a_valid_layout_initialises() {
    let mut h = Host::new(dims(64), FORMAT_U8);
    assert_eq!(h.init(), E_OK);
    assert_eq!(h.run(), E_OK);
}

#[test]
fn layout_faults_are_error_codes() {
    // wrong ABI
    let mut h = Host::new(dims(64), FORMAT_U8);
    h.set(C_ABI, ABI + 1);
    assert_eq!(h.init(), E_ABI);
    // N not a power of two
    let mut h = Host::new(dims(64), FORMAT_U8);
    h.set(C_N, 48);
    assert_eq!(h.run(), E_LAYOUT);
    // unknown format
    let mut h = Host::new(dims(64), FORMAT_U8);
    h.set(C_FORMAT, 7);
    assert_eq!(h.run(), E_FORMAT);
    // frame bytes that do not match the format
    let mut h = Host::new(dims(64), FORMAT_S16);
    assert_eq!(h.run(), E_LAYOUT);
    // two regions overlapping: the second starts inside the first
    let mut h = Host::new(dims(64), FORMAT_U8);
    let first = h.get(C_REGION);
    h.set(C_REGION + 1, first + 8);
    assert_eq!(h.run(), E_LAYOUT);
    // a misaligned region
    let mut h = Host::new(dims(64), FORMAT_U8);
    let last = h.get(C_REGION + 28);
    h.set(C_REGION + 28, last + 4);
    assert_eq!(h.run(), E_LAYOUT);
    // a layout end past the memory
    let mut h = Host::new(dims(64), FORMAT_U8);
    let size = h.mem.len() as u32;
    h.set(C_END, size + 1);
    assert_eq!(h.run(), E_LAYOUT);
    // a control block past the memory
    let mut h = Host::new(dims(64), FORMAT_U8);
    let m = Mem {
        base: h.mem.as_mut_ptr().expose_provenance(),
        size: CTL + CTL_BYTES - 1,
    };
    assert_eq!(unsafe { check(m, CTL) }.err(), Some(E_LAYOUT));
}

#[test]
fn fft_matches_a_direct_dft() {
    let n = 64;
    let mut h = Host::new(dims(n), FORMAT_U8);
    assert_eq!(h.init(), E_OK);
    let mut re: Vec<f32> = (0..n)
        .map(|i| ((i * 7919) % 13) as f32 / 13.0 - 0.5)
        .collect();
    let mut im: Vec<f32> = (0..n)
        .map(|i| ((i * 104729) % 11) as f32 / 11.0 - 0.5)
        .collect();
    let (r0, i0) = (re.clone(), im.clone());
    let rev: Vec<u32> = (0..n)
        .map(|i| (i as u32).reverse_bits() >> (32 - n.trailing_zeros()))
        .collect();
    let tw_re: Vec<f64> = (0..n).map(|k| h.rf64(R::TwRe, k)).collect();
    let tw_im: Vec<f64> = (0..n).map(|k| h.rf64(R::TwIm, k)).collect();
    fft(&mut re, &mut im, &rev, &tw_re, &tw_im);
    for k in 0..n {
        let (mut sr, mut si) = (0.0f64, 0.0f64);
        for t in 0..n {
            let a = -2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
            sr += r0[t] as f64 * a.cos() - i0[t] as f64 * a.sin();
            si += r0[t] as f64 * a.sin() + i0[t] as f64 * a.cos();
        }
        assert!(
            (re[k] as f64 - sr).abs() < 1e-4,
            "re[{k}] {} vs {sr}",
            re[k]
        );
        assert!(
            (im[k] as f64 - si).abs() < 1e-4,
            "im[{k}] {} vs {si}",
            im[k]
        );
    }
}

#[test]
fn a_tone_lands_in_its_shifted_bin() {
    let n = 64;
    let mut h = Host::new(dims(n), FORMAT_U8);
    h.set(C_TRACK_COUNT, 0);
    h.set(C_HAS_REF, 1);
    h.set(C_BLANK_LO, 0);
    h.set(C_BLANK_HI, n as u32);
    h.set(C_BLANK_NEED, n as u32 + 1); // never blanks
    assert_eq!(h.init(), E_OK);
    let bin = 5usize;
    h.stage_u8(0, |i| {
        let a = 2.0 * std::f64::consts::PI * (bin * i) as f64 / n as f64;
        (0.9 * a.cos(), 0.9 * a.sin())
    });
    h.set(C_BATCH_COUNT, 1);
    assert_eq!(h.run(), E_OK);
    assert_eq!(h.ru8(R::Verdict, 0), VERDICT_KEEP);
    let peak = (0..n)
        .max_by(|&a, &b| h.rf64(R::FrameAcc, a).total_cmp(&h.rf64(R::FrameAcc, b)))
        .unwrap();
    assert_eq!(peak, n / 2 + bin);
    // the kept frame is in the block sum
    assert_eq!(h.rf64(R::BlockAcc, peak), h.rf64(R::FrameAcc, peak));
}

/// Pending holds at most `pend_cap` frames: a batch reaching the cap is fine, one past it fails.
#[test]
fn pending_frames_stop_at_the_cap() {
    let n = 64;
    let mut h = Host::new(dims(n), FORMAT_U8);
    assert_eq!(h.init(), E_OK);
    for k in 0..4 {
        h.stage_u8(k, |i| (0.01 * i as f64 / n as f64, 0.0));
    }
    h.set(C_BATCH_COUNT, 4);
    assert_eq!(h.run(), E_OK);
    assert_eq!(h.get(C_PEND_COUNT), 4);
    for k in 0..4 {
        assert_eq!(h.ru8(R::Verdict, k), VERDICT_PENDING);
    }
    h.set(C_BATCH_COUNT, 1);
    assert_eq!(h.run(), E_PENDING);
    assert_eq!(h.get(C_PEND_COUNT), 4);
}

#[test]
fn batch_and_track_counts_past_their_caps_fail() {
    let n = 64;
    let mut h = Host::new(dims(n), FORMAT_U8);
    h.set(C_BATCH_COUNT, 4);
    assert_eq!(h.run(), E_OK);
    h.set(C_PEND_COUNT, 0);
    h.set(C_BATCH_COUNT, 5);
    assert_eq!(h.run(), E_BATCH);
    h.set(C_BATCH_COUNT, 0);
    h.set(C_TRACK_COUNT, 2);
    assert_eq!(h.run(), E_OK);
    h.set(C_TRACK_COUNT, 3);
    assert_eq!(h.run(), E_TRACKS);
    // a track span past N
    h.set(C_TRACK_COUNT, 1);
    h.wu32(R::TrackBins, 0, 10);
    h.wu32(R::TrackBins, 1, n as u32 + 1);
    assert_eq!(h.run(), E_TRACKS);
}

#[test]
fn the_short_window_restarts_on_a_seam_and_counts_bursts() {
    let n = 64;
    let mut h = Host::new(dims(n), FORMAT_U8);
    h.set(C_HAS_REF, 1);
    h.set(C_BLANK_LO, 0);
    h.set(C_BLANK_HI, n as u32);
    h.set(C_BLANK_NEED, n as u32 + 1);
    h.set(C_FLOOR_READY, 1);
    assert_eq!(h.init(), E_OK);
    for i in 0..n {
        h.wu8(R::Mask, i, 1);
        // everything is above the on threshold: a > hi
        h.wf64(R::OnLo, i, -2.0);
        h.wf64(R::OnHi, i, -1.0);
        h.wf64(R::OffLo, i, -2.0);
        h.wf64(R::OffHi, i, -1.0);
    }
    for k in 0..3 {
        h.stage_u8(k, |i| (0.2 * ((i % 3) as f64 - 1.0), 0.1));
    }
    // frame 2 does not follow frame 1: the window restarts and needs 2 frames again
    h.wf64(R::Starts, 2, (10 * n) as f64);
    h.set(C_BATCH_COUNT, 3);
    assert_eq!(h.run(), E_OK);
    assert_eq!(h.get(C_SHORT_FILL), 1);
    assert_eq!(h.ru8(R::BurstCount, 0), 1);
    assert_eq!(h.ru8(R::ShortOn, 0), 1);
}
