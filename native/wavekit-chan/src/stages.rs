//! Per-channel DSP stages: the frequency-translating NCO and the polyphase L/M resampler
//! (plan A5). Both keep their state keyed to absolute sample indices, so any split of the
//! same input yields bit-identical output (Property 4).

use std::f64::consts::TAU;

/// The NCO recomputes its phasor exactly from the absolute sample index this often, so the
/// recursive rotation cannot drift in amplitude or phase.
const NCO_RESYNC: u64 = 4096;

/// Mixes by e^{-j 2π Δf n / fs}. State depends only on the absolute sample index n,
/// plus a cycle bias that keeps the phasor continuous across [`Nco::set_frequency`].
#[derive(Debug, Clone)]
pub struct Nco {
    step: f64,
    /// Added to `n * step` before wrapping, so a frequency change does not move the phasor.
    phase_cycles: f64,
    n: u64,
    re: f64,
    im: f64,
    c: f64,
    s: f64,
}

impl Nco {
    pub fn new(offset_hz: f64, rate_hz: f64) -> Self {
        let step = if rate_hz == 0.0 {
            0.0
        } else {
            offset_hz / rate_hz
        };
        let w = -TAU * step.rem_euclid(1.0);
        Nco {
            step,
            phase_cycles: 0.0,
            n: 0,
            re: 1.0,
            im: 0.0,
            c: w.cos(),
            s: w.sin(),
        }
    }

    /// Change the mixing frequency. The phase accumulator (`re`/`im` and `n`) is kept, so the
    /// next sample continues from the current phasor and then rotates at the new step.
    /// A non-finite offset or rate, or a zero rate, leaves the oscillator untouched.
    pub fn set_frequency(&mut self, offset_hz: f64, rate_hz: f64) {
        if !offset_hz.is_finite() || !rate_hz.is_finite() || rate_hz == 0.0 {
            return;
        }
        let step = offset_hz / rate_hz;
        if !step.is_finite() || step == self.step {
            return;
        }
        let n = self.n as f64;
        self.phase_cycles = (self.phase_cycles + n * (self.step - step)).rem_euclid(1.0);
        self.step = step;
        let w = -TAU * step.rem_euclid(1.0);
        self.c = w.cos();
        self.s = w.sin();
    }

    pub fn reset(&mut self) {
        self.n = 0;
        self.re = 1.0;
        self.im = 0.0;
        self.phase_cycles = 0.0;
    }

    pub fn mix(&mut self, i: &mut [f32], q: &mut [f32]) {
        debug_assert_eq!(i.len(), q.len());
        // The zero-offset fast path is an identity only while the phasor is still 1.
        // After a retune back to 0 Hz the accumulator is kept and must still be applied.
        if self.step == 0.0 && self.phase_cycles == 0.0 && self.re == 1.0 && self.im == 0.0 {
            self.n += i.len() as u64;
            return;
        }
        for (si, sq) in i.iter_mut().zip(q.iter_mut()) {
            if self.n.is_multiple_of(NCO_RESYNC) {
                // `phase_cycles == 0` is the original absolute-index formula, bit for bit.
                let wrapped = if self.phase_cycles == 0.0 {
                    ((self.n as f64) * self.step).rem_euclid(1.0)
                } else {
                    (self.phase_cycles + (self.n as f64) * self.step).rem_euclid(1.0)
                };
                let ph = -TAU * wrapped;
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

/// Joins the 8 lanes in their fixed order, then adds the tail term by term.
#[inline(always)]
fn join_lanes(acc: [f32; 8], ra: &[f32], rb: &[f32]) -> f32 {
    let mut s = ((acc[0] + acc[4]) + (acc[1] + acc[5])) + ((acc[2] + acc[6]) + (acc[3] + acc[7]));
    for (x, y) in ra.iter().zip(rb) {
        s += x * y;
    }
    s
}

/// Dot product of two equal-length slices, accumulated in 8 independent lanes so the compiler
/// can vectorise it; the lane order is fixed, so results do not depend on alignment.
/// This is the reference: every other kernel must produce its bits.
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
    join_lanes(acc, ra, rb)
}

/// `P` outputs at once: the dot of `h[p]` with `i[p]` and with `q[p]`, each with [`dot`]'s bits.
/// All slices must have one length, and `P` must be at least 1.
///
/// One accumulator is limited by the latency of its add, about 4 cycles per 8 taps, whatever the
/// vector width. Each lane's sum has to stay in order to keep its bits, but separate outputs do
/// not depend on one another, so `2 * P` accumulators advance side by side.
/// AVX and not FMA: a fused multiply-add would round once where [`dot`] rounds twice.
///
/// # Safety
/// The CPU must support AVX.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx")]
#[inline]
unsafe fn dots_avx<const P: usize>(
    h: [&[f32]; P],
    i: [&[f32]; P],
    q: [&[f32]; P],
) -> ([f32; P], [f32; P]) {
    use std::arch::x86_64::{
        _mm256_add_ps, _mm256_loadu_ps, _mm256_mul_ps, _mm256_setzero_ps, _mm256_storeu_ps,
    };
    let len = h[0].len();
    for p in 0..P {
        assert!(h[p].len() == len && i[p].len() == len && q[p].len() == len);
    }
    let chunks = len / 8;
    let (mut sum_i, mut sum_q) = ([_mm256_setzero_ps(); P], [_mm256_setzero_ps(); P]);
    for c in 0..chunks {
        for p in 0..P {
            // SAFETY: AVX is the caller's contract. `c * 8 + 8 <= len`, the length of all three
            // slices (asserted above), and each unaligned load reads those 8 floats.
            unsafe {
                let t = _mm256_loadu_ps(h[p].as_ptr().add(c * 8));
                let (x, y) = (
                    _mm256_loadu_ps(i[p].as_ptr().add(c * 8)),
                    _mm256_loadu_ps(q[p].as_ptr().add(c * 8)),
                );
                sum_i[p] = _mm256_add_ps(sum_i[p], _mm256_mul_ps(t, x));
                sum_q[p] = _mm256_add_ps(sum_q[p], _mm256_mul_ps(t, y));
            }
        }
    }
    let at = chunks * 8;
    let (mut out_i, mut out_q) = ([0f32; P], [0f32; P]);
    for p in 0..P {
        let (mut acc_i, mut acc_q) = ([0f32; 8], [0f32; 8]);
        // SAFETY: AVX is the caller's contract, and each store writes the 8 floats of its array.
        unsafe {
            _mm256_storeu_ps(acc_i.as_mut_ptr(), sum_i[p]);
            _mm256_storeu_ps(acc_q.as_mut_ptr(), sum_q[p]);
        }
        out_i[p] = join_lanes(acc_i, &h[p][at..], &i[p][at..]);
        out_q[p] = join_lanes(acc_q, &h[p][at..], &q[p][at..]);
    }
    (out_i, out_q)
}

/// From this many taps per phase, a stage on AVX computes two outputs per kernel call. Below it
/// one output per call is cheaper, because the tail and the reduction outweigh the loop
/// (measured: 53 taps cost more per tap in two, 185 less).
#[cfg(target_arch = "x86_64")]
const TWO_OUTPUT_MIN_TAPS: usize = 128;

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

    /// Appends this block's outputs to `oi`/`oq`. The kernel is chosen once per block and every
    /// kernel gives the same bits, so a host's CPU changes the cost and never the output.
    pub fn process(&mut self, i: &[f32], q: &[f32], oi: &mut Vec<f32>, oq: &mut Vec<f32>) {
        debug_assert_eq!(i.len(), q.len());
        let base = self.consumed;
        let end = base + i.len() as u64;
        self.hist_i.extend_from_slice(i);
        self.hist_q.extend_from_slice(q);
        #[cfg(target_arch = "x86_64")]
        if std::arch::is_x86_feature_detected!("avx") {
            // SAFETY: AVX was just detected on this CPU.
            unsafe { self.outputs_avx(base, end, oi, oq) };
        } else {
            self.outputs(base, end, oi, oq);
        }
        #[cfg(not(target_arch = "x86_64"))]
        self.outputs(base, end, oi, oq);
        self.consumed = end;
        let drop = self.hist_i.len() - (self.t - 1);
        self.hist_i.drain(..drop);
        self.hist_q.drain(..drop);
    }

    /// The output that follows output `(n, p)`.
    #[inline(always)]
    fn after(&self, n: u64, p: usize) -> (u64, usize) {
        let p = p + self.m;
        (n + (p / self.l) as u64, p % self.l)
    }

    /// Emits every output due before absolute input `end`; `base` is the input index at the
    /// start of the history's current block.
    fn outputs(&mut self, base: u64, end: u64, oi: &mut Vec<f32>, oq: &mut Vec<f32>) {
        while self.next_n < end {
            let last = (self.next_n - base) as usize + (self.t - 1);
            let start = last + 1 - self.t;
            let h = &self.phases_rev[self.next_p];
            oi.push(dot(h, &self.hist_i[start..=last]));
            oq.push(dot(h, &self.hist_q[start..=last]));
            (self.next_n, self.next_p) = self.after(self.next_n, self.next_p);
        }
    }

    /// [`Self::outputs`] compiled for AVX, so the kernel inlines into the loop and the switch
    /// back to SSE code happens once per block instead of once per dot.
    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx")]
    unsafe fn outputs_avx(&mut self, base: u64, end: u64, oi: &mut Vec<f32>, oq: &mut Vec<f32>) {
        let t = self.t;
        while self.next_n < end {
            let (n, p) = (self.next_n, self.next_p);
            let at = (n - base) as usize;
            let (n2, p2) = self.after(n, p);
            if t >= TWO_OUTPUT_MIN_TAPS && n2 < end {
                let at2 = (n2 - base) as usize;
                // SAFETY: this function only runs with AVX, its own contract.
                let (x, y) = unsafe {
                    dots_avx::<2>(
                        [&self.phases_rev[p], &self.phases_rev[p2]],
                        [&self.hist_i[at..at + t], &self.hist_i[at2..at2 + t]],
                        [&self.hist_q[at..at + t], &self.hist_q[at2..at2 + t]],
                    )
                };
                oi.extend_from_slice(&x);
                oq.extend_from_slice(&y);
                (self.next_n, self.next_p) = self.after(n2, p2);
            } else {
                // SAFETY: as above.
                let (x, y) = unsafe {
                    dots_avx::<1>(
                        [&self.phases_rev[p]],
                        [&self.hist_i[at..at + t]],
                        [&self.hist_q[at..at + t]],
                    )
                };
                oi.extend_from_slice(&x);
                oq.extend_from_slice(&y);
                (self.next_n, self.next_p) = (n2, p2);
            }
        }
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

    #[cfg(target_arch = "x86_64")]
    type Kernel = fn(&[f32], &[f32]) -> f32;

    /// The AVX kernels by name, each as a dot of `h` with `x`, on hosts that have AVX. The two-output
    /// kernel runs `x` in every position, with a different second output on either side of it.
    #[cfg(target_arch = "x86_64")]
    fn avx_kernels() -> Vec<(&'static str, Kernel)> {
        if !std::arch::is_x86_feature_detected!("avx") {
            return Vec::new();
        }
        // SAFETY: AVX was just detected on this CPU.
        vec![
            ("one, I", |h, x| unsafe {
                dots_avx::<1>([h], [x], [h]).0[0]
            }),
            ("one, Q", |h, x| unsafe {
                dots_avx::<1>([h], [h], [x]).1[0]
            }),
            ("two, first I", |h, x| unsafe {
                dots_avx::<2>([h, x], [x, h], [h, h]).0[0]
            }),
            ("two, first Q", |h, x| unsafe {
                dots_avx::<2>([h, x], [h, h], [x, h]).1[0]
            }),
            ("two, second I", |h, x| unsafe {
                dots_avx::<2>([x, h], [h, x], [h, h]).0[1]
            }),
            ("two, second Q", |h, x| unsafe {
                dots_avx::<2>([x, h], [h, h], [h, x]).1[1]
            }),
        ]
    }

    /// A kernel must round like `dot`; a fused multiply-add would not. Lane 0 holds −(1 + 2⁻¹¹),
    /// then adds (1 + 2⁻¹²)² = 1 + 2⁻¹¹ + 2⁻²⁴. The product rounds to 1 + 2⁻¹¹ first, so the
    /// lane reads 0; fused, the product stays exact and the lane reads 2⁻²⁴.
    #[cfg(target_arch = "x86_64")]
    #[test]
    fn avx_kernels_round_the_product_before_adding() {
        let a = 1.0f32 + (2.0f32).powi(-12);
        let (mut x, mut y) = ([0.0f32; 16], [0.0f32; 16]);
        (x[0], y[0]) = (-(1.0 + (2.0f32).powi(-11)), 1.0);
        (x[8], y[8]) = (a, a);
        assert_eq!(dot(&x, &y).to_bits(), 0.0f32.to_bits());
        for (name, kernel) in avx_kernels() {
            assert_eq!(kernel(&x, &y).to_bits(), 0.0f32.to_bits(), "{name}");
        }
    }

    /// Runs a stage through the reference `outputs` loop, whatever the CPU.
    fn run_reference(
        st: &mut RationalFir,
        i: &[f32],
        q: &[f32],
        oi: &mut Vec<f32>,
        oq: &mut Vec<f32>,
    ) {
        let base = st.consumed;
        let end = base + i.len() as u64;
        st.hist_i.extend_from_slice(i);
        st.hist_q.extend_from_slice(q);
        st.outputs(base, end, oi, oq);
        st.consumed = end;
        let drop = st.hist_i.len() - (st.t - 1);
        st.hist_i.drain(..drop);
        st.hist_q.drain(..drop);
    }

    #[test]
    fn stage_output_is_the_bits_of_the_reference_loop() {
        // Per-phase lengths on both sides of TWO_OUTPUT_MIN_TAPS, ratios with one phase and many,
        // and cuts that leave a last output alone at the end of a block.
        for (l, m, transition) in [
            (1usize, 2usize, 0.05),
            (1, 2, 0.004),
            (3, 4, 0.05),
            (3, 4, 0.004),
            (16, 25, 0.002),
        ] {
            let proto = lowpass(
                0.4 / (l.max(m) as f64),
                transition / (l.max(m) as f64),
                l as f64,
            );
            let i: Vec<f32> = (0..7_001).map(|k| (k as f32 * 0.37).sin()).collect();
            let q: Vec<f32> = (0..7_001).map(|k| (k as f32 * 0.11).cos()).collect();
            let (mut st, mut reference) = (
                RationalFir::new(l, m, &proto),
                RationalFir::new(l, m, &proto),
            );
            let (mut oi, mut oq, mut ri, mut rq) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            let mut last = 0;
            for cut in [1usize, 2, 3, 500, 501, 4_000, 7_001] {
                st.process(&i[last..cut], &q[last..cut], &mut oi, &mut oq);
                run_reference(
                    &mut reference,
                    &i[last..cut],
                    &q[last..cut],
                    &mut ri,
                    &mut rq,
                );
                last = cut;
            }
            let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
            assert!(!oi.is_empty());
            assert_eq!(bits(&oi), bits(&ri), "{l}/{m} I, {} taps", proto.len());
            assert_eq!(bits(&oq), bits(&rq), "{l}/{m} Q, {} taps", proto.len());
        }
    }

    /// Either side of TWO_OUTPUT_MIN_TAPS, exactly: per-phase lengths 127, 128 and 129, with one
    /// phase and with three. The threshold moves cost, so it must not move a bit.
    #[test]
    fn two_output_threshold_does_not_change_the_output() {
        for (l, m) in [(1usize, 2usize), (3, 4)] {
            for per_phase in [127usize, 128, 129] {
                let proto: Vec<f32> = (0..per_phase * l)
                    .map(|k| ((k * 31 % 97) as f32 - 48.0) * 1e-3)
                    .collect();
                let i: Vec<f32> = (0..2_000).map(|k| (k as f32 * 0.37).sin()).collect();
                let q: Vec<f32> = (0..2_000).map(|k| (k as f32 * 0.11).cos()).collect();
                let (mut oi, mut oq, mut ri, mut rq) =
                    (Vec::new(), Vec::new(), Vec::new(), Vec::new());
                RationalFir::new(l, m, &proto).process(&i, &q, &mut oi, &mut oq);
                run_reference(
                    &mut RationalFir::new(l, m, &proto),
                    &i,
                    &q,
                    &mut ri,
                    &mut rq,
                );
                let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
                assert!(!oi.is_empty());
                assert_eq!(bits(&oi), bits(&ri), "{l}/{m} {per_phase} I");
                assert_eq!(bits(&oq), bits(&rq), "{l}/{m} {per_phase} Q");
            }
        }
    }

    #[cfg(target_arch = "x86_64")]
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]
        // Every length from empty through several chunks and tails, with magnitudes far enough
        // apart that a different addition order would round differently.
        #[test]
        fn avx_kernels_match_the_reference_bits(
            pairs in proptest::collection::vec((-1e6f32..1e6, -1e-3f32..1e-3), 0..70),
        ) {
            let (a, b): (Vec<f32>, Vec<f32>) = pairs.into_iter().unzip();
            let want = dot(&a, &b).to_bits();
            for (name, kernel) in avx_kernels() {
                prop_assert_eq!(kernel(&a, &b).to_bits(), want, "{}", name);
            }
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
