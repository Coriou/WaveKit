//! Per-channel DSP stages: the frequency-translating NCO and the polyphase L/M resampler
//! (plan A5). Both keep their state keyed to absolute sample indices, so any split of the
//! same input yields bit-identical output (Property 4).

use std::f64::consts::TAU;

/// The NCO recomputes its phasor exactly from the absolute sample index this often, so the
/// recursive rotation cannot drift in amplitude or phase.
const NCO_RESYNC: u64 = 4096;

/// Mixes by e^{-j 2π Δf n / fs}. State depends only on the absolute sample index n.
#[derive(Debug, Clone)]
pub struct Nco {
    step: f64,
    n: u64,
    re: f64,
    im: f64,
    c: f64,
    s: f64,
}

impl Nco {
    pub fn new(offset_hz: f64, rate_hz: f64) -> Self {
        let step = offset_hz / rate_hz;
        let w = -TAU * step.rem_euclid(1.0);
        Nco {
            step,
            n: 0,
            re: 1.0,
            im: 0.0,
            c: w.cos(),
            s: w.sin(),
        }
    }

    pub fn reset(&mut self) {
        self.n = 0;
        self.re = 1.0;
        self.im = 0.0;
    }

    pub fn mix(&mut self, i: &mut [f32], q: &mut [f32]) {
        debug_assert_eq!(i.len(), q.len());
        if self.step == 0.0 {
            self.n += i.len() as u64;
            return;
        }
        for (si, sq) in i.iter_mut().zip(q.iter_mut()) {
            if self.n.is_multiple_of(NCO_RESYNC) {
                let ph = -TAU * ((self.n as f64) * self.step).rem_euclid(1.0);
                self.re = ph.cos();
                self.im = ph.sin();
            }
            let (xi, xq) = (*si as f64, *sq as f64);
            *si = (xi * self.re - xq * self.im) as f32;
            *sq = (xi * self.im + xq * self.re) as f32;
            let re = self.re * self.c - self.im * self.s;
            self.im = self.re * self.s + self.im * self.c;
            self.re = re;
            self.n += 1;
        }
    }
}

/// Dot product of two equal-length slices, accumulated in 8 independent lanes so the compiler
/// can vectorise it; the lane order is fixed, so results do not depend on alignment.
#[inline]
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut acc = [0f32; 8];
    let ((ca, ra), (cb, rb)) = (a.as_chunks::<8>(), b.as_chunks::<8>());
    for (x, y) in ca.iter().zip(cb) {
        for ((s, xv), yv) in acc.iter_mut().zip(x).zip(y) {
            *s += xv * yv;
        }
    }
    let mut s = ((acc[0] + acc[4]) + (acc[1] + acc[5])) + ((acc[2] + acc[6]) + (acc[3] + acc[7]));
    for (x, y) in ra.iter().zip(rb) {
        s += x * y;
    }
    s
}

/// Polyphase L/M resampler. Output k sits at upsampled index kM: n = ⌊kM/L⌋, phase p = kM mod L.
/// Output k is emitted as soon as input n has arrived, so n inputs yield ⌈nL/M⌉ outputs (plan A12).
/// The stage does not try to hit ⌊nL/M⌋; `ChannelDsp` applies one schedule for the whole chain.
/// The prototype is designed at the upsampled rate and carries the gain of L.
#[derive(Debug, Clone)]
pub struct RationalFir {
    l: usize,
    m: usize,
    t: usize,
    proto_len: usize,
    /// `phases_rev[p][j'] = h[p + (t-1-j')·L]`, zero-padded past the prototype's end.
    phases_rev: Vec<Vec<f32>>,
    /// The last t-1 samples, then the current block.
    hist_i: Vec<f32>,
    hist_q: Vec<f32>,
    consumed: u64,
    next_n: u64,
    next_p: usize,
}

impl RationalFir {
    pub fn new(l: usize, m: usize, prototype: &[f32]) -> Self {
        assert!(l > 0 && m > 0, "RationalFir needs L, M >= 1 (got {l}/{m})");
        assert!(!prototype.is_empty(), "RationalFir needs a prototype");
        let t = prototype.len().div_ceil(l);
        let phases_rev = (0..l)
            .map(|p| {
                (0..t)
                    .map(|jr| prototype.get(p + (t - 1 - jr) * l).copied().unwrap_or(0.0))
                    .collect()
            })
            .collect();
        RationalFir {
            l,
            m,
            t,
            proto_len: prototype.len(),
            phases_rev,
            hist_i: vec![0.0; t - 1],
            hist_q: vec![0.0; t - 1],
            consumed: 0,
            next_n: 0,
            next_p: 0,
        }
    }

    pub fn l(&self) -> usize {
        self.l
    }

    pub fn prototype_len(&self) -> usize {
        self.proto_len
    }

    pub fn reset(&mut self) {
        self.hist_i = vec![0.0; self.t - 1];
        self.hist_q = vec![0.0; self.t - 1];
        self.consumed = 0;
        self.next_n = 0;
        self.next_p = 0;
    }

    /// Appends this block's outputs to `oi`/`oq`.
    pub fn process(&mut self, i: &[f32], q: &[f32], oi: &mut Vec<f32>, oq: &mut Vec<f32>) {
        debug_assert_eq!(i.len(), q.len());
        let base = self.consumed;
        self.hist_i.extend_from_slice(i);
        self.hist_q.extend_from_slice(q);
        let end = base + i.len() as u64;
        while self.next_n < end {
            let last = (self.next_n - base) as usize + (self.t - 1);
            let start = last + 1 - self.t;
            let h = &self.phases_rev[self.next_p];
            oi.push(dot(h, &self.hist_i[start..=last]));
            oq.push(dot(h, &self.hist_q[start..=last]));
            self.next_p += self.m;
            self.next_n += (self.next_p / self.l) as u64;
            self.next_p %= self.l;
        }
        self.consumed = end;
        let drop = self.hist_i.len() - (self.t - 1);
        self.hist_i.drain(..drop);
        self.hist_q.drain(..drop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::lowpass;
    use proptest::prelude::*;

    fn run_split(
        st: &mut RationalFir,
        i: &[f32],
        q: &[f32],
        cuts: &[usize],
    ) -> (Vec<f32>, Vec<f32>) {
        let (mut oi, mut oq) = (Vec::new(), Vec::new());
        let mut last = 0;
        for &c in cuts.iter().chain(std::iter::once(&i.len())) {
            let c = c.min(i.len()).max(last);
            st.process(&i[last..c], &q[last..c], &mut oi, &mut oq);
            last = c;
        }
        (oi, oq)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (stage level)
        // Validates: addendum §12.4
        #[test]
        fn rational_stage_is_split_independent(l in 1usize..8, m in 1usize..9, n in 1usize..3000, mut cuts in proptest::collection::vec(0usize..3000, 0..10)) {
            let proto = lowpass(0.4 / (l.max(m) as f64), 0.05 / (l.max(m) as f64), l as f64);
            let i: Vec<f32> = (0..n).map(|k| ((k * 7919) % 255) as f32 / 255.0 - 0.5).collect();
            let q: Vec<f32> = (0..n).map(|k| ((k * 104729) % 255) as f32 / 255.0 - 0.5).collect();
            cuts.sort_unstable();
            let whole = run_split(&mut RationalFir::new(l, m, &proto), &i, &q, &[]);
            let split = run_split(&mut RationalFir::new(l, m, &proto), &i, &q, &cuts);
            prop_assert_eq!(whole, split);
        }
        // Feature: core-channelizer, Property 4: Chunk-split independence (stage level)
        // Validates: addendum §12.4
        #[test]
        fn nco_is_split_independent(n in 1usize..5000, cut in 0usize..5000) {
            let mut a = (vec![1.0f32; n], vec![0.0f32; n]);
            let mut b = a.clone();
            Nco::new(12_345.6, 2_048_000.0).mix(&mut a.0, &mut a.1);
            let mut nco = Nco::new(12_345.6, 2_048_000.0);
            let c = cut.min(n);
            let (bi0, bi1) = b.0.split_at_mut(c);
            let (bq0, bq1) = b.1.split_at_mut(c);
            nco.mix(bi0, bq0);
            nco.mix(bi1, bq1);
            prop_assert_eq!(a, b);
        }
    }

    #[test]
    fn output_count_matches_rational_ratio() {
        let proto = lowpass(0.1, 0.05, 3.0);
        let mut st = RationalFir::new(3, 4, &proto);
        let (mut oi, mut oq) = (Vec::new(), Vec::new());
        st.process(&[0.0; 4000], &[0.0; 4000], &mut oi, &mut oq);
        assert_eq!(oi.len(), 3000);
    }

    #[test]
    fn stage_emits_the_ceiling_of_the_ratio() {
        // plan A12: Task 13's schedule proof relies on exactly this rule
        for &(l, m, n) in &[
            (1usize, 2usize, 33usize),
            (1, 2, 1),
            (3, 4, 2),
            (3, 4, 5),
            (16, 25, 7),
            (125, 256, 3),
        ] {
            let proto = lowpass(0.4 / (l.max(m) as f64), 0.05 / (l.max(m) as f64), l as f64);
            let mut st = RationalFir::new(l, m, &proto);
            let (mut oi, mut oq) = (Vec::new(), Vec::new());
            st.process(&vec![0.0; n], &vec![0.0; n], &mut oi, &mut oq);
            assert_eq!(oi.len(), (n * l).div_ceil(m), "{l}/{m} n={n}");
        }
    }

    /// Zero-stuff by L, convolve with the prototype, keep every M-th sample: the textbook
    /// definition the polyphase stage must reproduce (up to f32 summation order).
    fn reference_resample(l: usize, m: usize, h: &[f32], x: &[f32]) -> Vec<f32> {
        let count = (x.len() * l).div_ceil(m);
        (0..count)
            .map(|k| {
                let mut s = 0.0f64;
                for (j, &hj) in h.iter().enumerate() {
                    let u = (k * m) as i64 - j as i64;
                    if u >= 0 && (u as usize).is_multiple_of(l) {
                        if let Some(&xv) = x.get(u as usize / l) {
                            s += hj as f64 * xv as f64;
                        }
                    }
                }
                s as f32
            })
            .collect()
    }

    #[test]
    fn rational_stage_matches_the_zero_stuff_reference() {
        for &(l, m) in &[(1usize, 1usize), (1, 2), (3, 4), (4, 3), (5, 7), (16, 25)] {
            let proto = lowpass(0.4 / (l.max(m) as f64), 0.05 / (l.max(m) as f64), l as f64);
            let n = 700;
            let i: Vec<f32> = (0..n)
                .map(|k| ((k * 7919) % 255) as f32 / 255.0 - 0.5)
                .collect();
            let q: Vec<f32> = (0..n)
                .map(|k| ((k * 104729) % 255) as f32 / 255.0 - 0.5)
                .collect();
            let (oi, oq) = run_split(&mut RationalFir::new(l, m, &proto), &i, &q, &[13, 250]);
            let (ri, rq) = (
                reference_resample(l, m, &proto, &i),
                reference_resample(l, m, &proto, &q),
            );
            assert_eq!(oi.len(), ri.len(), "{l}/{m}");
            for (k, (a, b)) in oi.iter().zip(&ri).chain(oq.iter().zip(&rq)).enumerate() {
                assert!((a - b).abs() < 1e-4, "{l}/{m} k={k}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn reset_restarts_the_stage_from_scratch() {
        let proto = lowpass(0.1, 0.05, 3.0);
        let x: Vec<f32> = (0..500).map(|k| (k as f32 * 0.37).sin()).collect();
        let mut st = RationalFir::new(3, 4, &proto);
        let first = run_split(&mut st, &x, &x, &[]);
        st.reset();
        assert_eq!(run_split(&mut st, &x, &x, &[]), first);
        assert_eq!((st.l(), st.prototype_len()), (3, proto.len()));
    }

    #[test]
    fn dot_matches_a_plain_sum_for_every_remainder() {
        for len in 0..40 {
            let a: Vec<f32> = (0..len).map(|k| k as f32 * 0.25 - 3.0).collect();
            let b: Vec<f32> = (0..len).map(|k| 1.0 - k as f32 * 0.125).collect();
            let want: f64 = a.iter().zip(&b).map(|(x, y)| *x as f64 * *y as f64).sum();
            assert!((dot(&a, &b) as f64 - want).abs() < 1e-3, "len={len}");
        }
    }

    // Feature: core-channelizer, Property 5: Translation (NCO stage)
    // Validates: addendum §12.5
    #[test]
    fn nco_translates_a_tone_at_the_offset_to_dc_with_continuous_phase() {
        let (fs, off) = (2_048_000.0f64, 12_345.6f64);
        let n = 3 * 4096 + 77; // crosses several resync points
        let (mut i, mut q): (Vec<f32>, Vec<f32>) = (0..n)
            .map(|k| {
                let ph = std::f64::consts::TAU * off * k as f64 / fs + 0.3;
                (ph.cos() as f32, ph.sin() as f32)
            })
            .unzip();
        let mut nco = Nco::new(off, fs);
        nco.mix(&mut i[..1000], &mut q[..1000]);
        nco.mix(&mut i[1000..], &mut q[1000..]);
        for k in 0..n {
            assert!((i[k] - 0.3f32.cos()).abs() < 1e-4, "i[{k}]={}", i[k]);
            assert!((q[k] - 0.3f32.sin()).abs() < 1e-4, "q[{k}]={}", q[k]);
        }
        nco.reset();
        let (mut a, mut b) = (vec![1.0f32; 4], vec![0.0f32; 4]);
        nco.mix(&mut a, &mut b);
        assert_eq!((a[0], b[0]), (1.0, 0.0));
        // Zero offset is an exact pass-through.
        let (mut a, mut b) = (vec![0.5f32; 9], vec![-0.25f32; 9]);
        Nco::new(0.0, fs).mix(&mut a, &mut b);
        assert_eq!((a, b), (vec![0.5f32; 9], vec![-0.25f32; 9]));
    }
}
