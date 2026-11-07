//! The wideband recorder's NFM chain (src/core/scanner/channel/wideband-nfm.ts loads it).
//!
//! One `nfm_run` call takes a CU8 slice the host copied into linear memory and runs what
//! `WidebandNfmChain.process` runs in JS: the NCO mix and the triangular sum-and-dump (stage 1),
//! the stage-2 decimating FIR, the ±8 kHz channel FIR, the linear resampler to 48 kHz, the
//! `FmAudioDemod` discriminator (de-emphasis, 127-tap low-pass, decimation by 6 to 8 kHz s16) and
//! the 300 Hz Butterworth high- and low-pass biquads (written audio and its tone-band twin).
//!
//! Equivalence with the JS chain is stated, not bit for bit: pcm and tone within ±1 LSB.
//! - Every constant (the U8 lookup, the NCO rotation, every tap, the biquad coefficients, the
//!   discriminator scale and de-emphasis factor) is written by JS, not recomputed here.
//! - Stage 1 (f64x2 lanes of (re, im)) keeps the JS operand order lane by lane: a subtraction is
//!   an addition of an exactly negated product, so it matches the JS path bit for bit.
//! - Every value JS stores into a Float32Array (the stage-2 and channel delay lines, the 48 kHz
//!   discriminator input) is rounded to f32 here at the same point.
//! - The three FIRs sum with four partial accumulators instead of one running sum: products are
//!   identical (f32 × f32 is exact in f64 for the complex FIRs), only the summation order moves,
//!   a few f64 ULP before the next f32 rounding. That is the one source of difference.
//! - `Math.hypot` (the NCO renormalisation) is V8's algorithm, `Math.round` is half-up as in JS,
//!   and `atan2` is the fdlibm algorithm V8 uses too.
//!
//! Memory is the host's: the module imports a fixed `env.memory` (one per chain) and allocates
//! nothing. The host lays out every region after a control block (`C_*`, `F_*`); `nfm_check` and
//! `nfm_run` check that layout and the chain state first and return an error code instead of
//! touching anything outside it.

#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ---- the float functions `core` lacks: wasm SIMD lanes, compiler_builtins' libm atan2 ----

#[cfg(target_arch = "wasm32")]
mod float {
    extern "C" {
        /// compiler_builtins' `libm` port (musl, from fdlibm: the algorithm V8 uses too).
        fn atan2(y: f64, x: f64) -> f64;
    }
    use core::arch::wasm32::{f64x2_ceil, f64x2_extract_lane, f64x2_splat, f64x2_sqrt};
    // The scalar f64.sqrt and f64.ceil intrinsics are unstable; the SIMD lane forms are the same
    // IEEE operations (correctly rounded square root, exact ceiling).
    #[inline(always)]
    pub fn sqrt(x: f64) -> f64 {
        f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
    }
    #[inline(always)]
    pub fn ceil(x: f64) -> f64 {
        f64x2_extract_lane::<0>(f64x2_ceil(f64x2_splat(x)))
    }
    #[inline(always)]
    pub fn atan2f(y: f64, x: f64) -> f64 {
        // SAFETY: a pure function of two numbers.
        unsafe { atan2(y, x) }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod float {
    #[inline(always)]
    pub fn sqrt(x: f64) -> f64 {
        x.sqrt()
    }
    #[inline(always)]
    pub fn ceil(x: f64) -> f64 {
        x.ceil()
    }
    #[inline(always)]
    pub fn atan2f(y: f64, x: f64) -> f64 {
        y.atan2(x)
    }
}

/// Bumped on any change to the control block or the region order.
pub const ABI: u32 = 1;

// Control block: CTL_U32 u32 slots, then CTL_F64 f64 slots. Offsets are byte addresses.
pub const C_ABI: usize = 0;
pub const C_K: usize = 1;
pub const C_M: usize = 2;
pub const C_T2: usize = 3;
pub const C_TC: usize = 4;
pub const C_TD: usize = 5;
pub const C_EXACT: usize = 6;
pub const C_HIGH_PASS: usize = 7;
pub const C_MAX_IN: usize = 8;
pub const C_OUT_CAP: usize = 9;
pub const C_N_IN: usize = 10;
pub const C_N_OUT: usize = 11;
pub const C_PHASE: usize = 12;
pub const C_S2_PHASE: usize = 13;
pub const C_SINCE_RENORM: usize = 14;
pub const C_S2_HEAD: usize = 15;
pub const C_CH_HEAD: usize = 16;
pub const C_DM_HEAD: usize = 17;
pub const C_DM_PHASE: usize = 18;
pub const C_END: usize = 19;
/// Region offsets, in `REGIONS` order, from this slot on.
pub const C_REGION: usize = 20;
pub const CTL_U32: usize = 32;

pub const F_ROT_RE: usize = 0;
pub const F_ROT_IM: usize = 1;
pub const F_CIC_SCALE: usize = 2;
pub const F_STEP: usize = 3;
pub const F_SCALE: usize = 4;
pub const F_ALPHA: usize = 5;
/// Biquad coefficients (b0, b1, b2, a1, a2): high-pass 0 and 1, then low-pass 0 and 1.
pub const F_BIQUAD: usize = 6;
pub const F_PH_RE: usize = 26;
pub const F_PH_IM: usize = 27;
pub const F_CUR_RE: usize = 28;
pub const F_CUR_IM: usize = 29;
pub const F_NXT_RE: usize = 30;
pub const F_NXT_IM: usize = 31;
pub const F_FRAC: usize = 32;
pub const F_PREV_RE: usize = 33;
pub const F_PREV_IM: usize = 34;
pub const F_LAST_I: usize = 35;
pub const F_LAST_Q: usize = 36;
pub const F_DEEMPH: usize = 37;
/// Biquad state (x1, x2, y1, y2), in the coefficients' order.
pub const F_BIQUAD_STATE: usize = 38;
pub const CTL_F64: usize = 56;
pub const CTL_BYTES: usize = CTL_U32 * 4 + CTL_F64 * 8;

/// The NCO recurrence is renormalised this often (wideband-nfm.ts RENORM_EVERY).
pub const RENORM_EVERY: u32 = 4096;
/// The discriminator decimates 48 kHz to 8 kHz (fm-audio.ts).
pub const DEMOD_DECIMATION: u32 = 6;

pub const E_OK: u32 = 0;
pub const E_ABI: u32 = 1;
pub const E_LAYOUT: u32 = 2;
pub const E_STATE: u32 = 3;
pub const E_INPUT: u32 = 4;
pub const E_OUTPUT: u32 = 5;

/// Regions, in layout order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum R {
    /// f64[256]: the JS Float32 U8 lookup, widened.
    Lut,
    /// f64[T2]: stage-2 taps, reversed (oldest sample first).
    S2Taps,
    /// f64[4·T2]: stage-2 delay line, (re, im) pairs, doubled (each sample at head and head + T2).
    S2Line,
    /// f64[TC]: channel taps, reversed.
    ChTaps,
    /// f64[4·TC]: channel delay line, as S2Line.
    ChLine,
    /// f64[TD]: discriminator low-pass taps, reversed.
    DmTaps,
    /// f64[2·TD]: discriminator history, doubled.
    DmHist,
    /// u8[2·MAX_IN]: the CU8 slice.
    Input,
    /// i16[OUT_CAP]: written audio.
    Pcm,
    /// i16[OUT_CAP]: tone-band audio.
    Tone,
}

pub const REGIONS: [R; 10] = [
    R::Lut,
    R::S2Taps,
    R::S2Line,
    R::ChTaps,
    R::ChLine,
    R::DmTaps,
    R::DmHist,
    R::Input,
    R::Pcm,
    R::Tone,
];

/// The chain's dimensions, from the control block.
#[derive(Clone, Copy, Debug)]
pub struct Dims {
    pub k: usize,
    pub m: usize,
    pub t2: usize,
    pub tc: usize,
    pub td: usize,
    pub max_in: usize,
    pub out_cap: usize,
}

/// Bytes of one region (the arithmetic wideband-nfm-wasm.ts `nfmRegionBytes` mirrors).
pub fn region_bytes(r: R, d: &Dims) -> usize {
    match r {
        R::Lut => 8 * 256,
        R::S2Taps => 8 * d.t2,
        R::S2Line => 8 * 4 * d.t2,
        R::ChTaps => 8 * d.tc,
        R::ChLine => 8 * 4 * d.tc,
        R::DmTaps => 8 * d.td,
        R::DmHist => 8 * 2 * d.td,
        R::Input => 2 * d.max_in,
        R::Pcm | R::Tone => 2 * d.out_cap,
    }
}

/// Linear memory as the host sees it: `base` is address 0 (0 on wasm32, a Vec in host tests).
#[derive(Clone, Copy)]
pub struct Mem {
    pub base: usize,
    pub size: usize,
}

impl Mem {
    fn at<T>(&self, off: usize) -> *mut T {
        core::ptr::with_exposed_provenance_mut::<T>(self.base + off)
    }

    /// # Safety
    /// The control block at `ctl` is inside the memory (`check` proved it).
    unsafe fn u32(&self, ctl: usize, i: usize) -> u32 {
        self.at::<u32>(ctl + 4 * i).read_unaligned()
    }

    unsafe fn set_u32(&self, ctl: usize, i: usize, v: u32) {
        self.at::<u32>(ctl + 4 * i).write_unaligned(v)
    }

    unsafe fn f64(&self, ctl: usize, i: usize) -> f64 {
        self.at::<f64>(ctl + CTL_U32 * 4 + 8 * i).read_unaligned()
    }

    unsafe fn set_f64(&self, ctl: usize, i: usize, v: f64) {
        self.at::<f64>(ctl + CTL_U32 * 4 + 8 * i).write_unaligned(v)
    }
}

/// A checked layout: the dimensions and the start of every region.
pub struct Layout {
    pub d: Dims,
    pub off: [usize; 10],
}

/// Most taps a FIR may have (the JS chain uses at most 10 · 8 + 1, 63 and 127).
pub const MAX_TAPS: usize = 4096;
/// Most CU8 samples one call may take (wideband-nfm.ts MAX_SLICE_SAMPLES is 131 072).
pub const MAX_INPUT: usize = 1 << 20;

/// Checks the control block and the region list: ABI, dimensions in range, regions in order,
/// 8-byte aligned, disjoint, inside `[ctl + CTL_BYTES, end]` with `end` inside the memory.
/// Anything else is `E_ABI` or `E_LAYOUT` and nothing is touched.
///
/// # Safety
/// `mem` describes readable memory of `mem.size` bytes.
pub unsafe fn check(mem: Mem, ctl: usize) -> Result<Layout, u32> {
    if !ctl.is_multiple_of(8) || ctl.checked_add(CTL_BYTES).is_none_or(|e| e > mem.size) {
        return Err(E_LAYOUT);
    }
    if mem.u32(ctl, C_ABI) != ABI {
        return Err(E_ABI);
    }
    let get = |i: usize| mem.u32(ctl, i) as usize;
    let d = Dims {
        k: get(C_K),
        m: get(C_M),
        t2: get(C_T2),
        tc: get(C_TC),
        td: get(C_TD),
        max_in: get(C_MAX_IN),
        out_cap: get(C_OUT_CAP),
    };
    let taps = 1..=MAX_TAPS;
    if !(1..=MAX_TAPS).contains(&d.k)
        || !(1..=MAX_TAPS).contains(&d.m)
        || !taps.contains(&d.t2)
        || !taps.contains(&d.tc)
        || !taps.contains(&d.td)
        || !(1..=MAX_INPUT).contains(&d.max_in)
        || d.out_cap == 0
        || d.out_cap > MAX_INPUT
    {
        return Err(E_LAYOUT);
    }
    let end = get(C_END);
    if end > mem.size {
        return Err(E_LAYOUT);
    }
    let mut off = [0usize; 10];
    let mut at = ctl + CTL_BYTES;
    for (k, &r) in REGIONS.iter().enumerate() {
        let o = get(C_REGION + k);
        let Some(e) = o.checked_add(region_bytes(r, &d)) else {
            return Err(E_LAYOUT);
        };
        if o < at || !o.is_multiple_of(8) || e > end {
            return Err(E_LAYOUT);
        }
        off[k] = o;
        at = e;
    }
    Ok(Layout { d, off })
}

impl Layout {
    fn idx(r: R) -> usize {
        REGIONS.iter().position(|&x| x == r).unwrap_or(0)
    }

    /// # Safety
    /// `check` passed for this layout on `mem`; regions are disjoint, so the slices do not alias.
    unsafe fn slice<'a, T>(&self, mem: Mem, r: R) -> &'a mut [T] {
        let bytes = region_bytes(r, &self.d);
        core::slice::from_raw_parts_mut(
            mem.at::<T>(self.off[Self::idx(r)]),
            bytes / core::mem::size_of::<T>(),
        )
    }
}

// ---- f64x2 lanes: wasm SIMD on wasm32, the same IEEE operations lane by lane elsewhere ----

#[cfg(target_arch = "wasm32")]
mod lanes {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct V2(v128);

    // Named methods, not operator traits: each call is one lane-wise IEEE operation.
    #[allow(clippy::should_implement_trait)]
    impl V2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> V2 {
            V2(f64x2(a, b))
        }
        #[inline(always)]
        pub fn splat(a: f64) -> V2 {
            V2(f64x2_splat(a))
        }
        #[inline(always)]
        pub fn zero() -> V2 {
            V2(f64x2_splat(0.0))
        }
        /// Lanes `s[i]`, `s[i + 1]`.
        #[inline(always)]
        pub fn load(s: &[f64], i: usize) -> V2 {
            let p = &s[i..i + 2];
            // SAFETY: p holds two f64 (checked above); v128_load takes any alignment.
            V2(unsafe { v128_load(p.as_ptr() as *const v128) })
        }
        #[inline(always)]
        pub fn store(self, s: &mut [f64], i: usize) {
            let p = &mut s[i..i + 2];
            // SAFETY: as load.
            unsafe { v128_store(p.as_mut_ptr() as *mut v128, self.0) }
        }
        #[inline(always)]
        pub fn add(self, o: V2) -> V2 {
            V2(f64x2_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn sub(self, o: V2) -> V2 {
            V2(f64x2_sub(self.0, o.0))
        }
        #[inline(always)]
        pub fn mul(self, o: V2) -> V2 {
            V2(f64x2_mul(self.0, o.0))
        }
        #[inline(always)]
        pub fn lo(self) -> f64 {
            f64x2_extract_lane::<0>(self.0)
        }
        #[inline(always)]
        pub fn hi(self) -> f64 {
            f64x2_extract_lane::<1>(self.0)
        }
        #[inline(always)]
        pub fn dup_lo(self) -> V2 {
            V2(i64x2_shuffle::<0, 0>(self.0, self.0))
        }
        #[inline(always)]
        pub fn dup_hi(self) -> V2 {
            V2(i64x2_shuffle::<1, 1>(self.0, self.0))
        }
        #[inline(always)]
        pub fn swap(self) -> V2 {
            V2(i64x2_shuffle::<1, 0>(self.0, self.0))
        }
        /// Each lane rounded to f32 and widened back (a Float32Array store and load).
        #[inline(always)]
        pub fn round_f32(self) -> V2 {
            V2(f64x2_promote_low_f32x4(f32x4_demote_f64x2_zero(self.0)))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod lanes {
    #[derive(Clone, Copy)]
    pub struct V2(f64, f64);

    // Named methods, not operator traits: each call is one lane-wise IEEE operation.
    #[allow(clippy::should_implement_trait)]
    impl V2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> V2 {
            V2(a, b)
        }
        #[inline(always)]
        pub fn splat(a: f64) -> V2 {
            V2(a, a)
        }
        #[inline(always)]
        pub fn zero() -> V2 {
            V2(0.0, 0.0)
        }
        #[inline(always)]
        pub fn load(s: &[f64], i: usize) -> V2 {
            V2(s[i], s[i + 1])
        }
        #[inline(always)]
        pub fn store(self, s: &mut [f64], i: usize) {
            s[i] = self.0;
            s[i + 1] = self.1;
        }
        #[inline(always)]
        pub fn add(self, o: V2) -> V2 {
            V2(self.0 + o.0, self.1 + o.1)
        }
        #[inline(always)]
        pub fn sub(self, o: V2) -> V2 {
            V2(self.0 - o.0, self.1 - o.1)
        }
        #[inline(always)]
        pub fn mul(self, o: V2) -> V2 {
            V2(self.0 * o.0, self.1 * o.1)
        }
        #[inline(always)]
        pub fn lo(self) -> f64 {
            self.0
        }
        #[inline(always)]
        pub fn hi(self) -> f64 {
            self.1
        }
        #[inline(always)]
        pub fn dup_lo(self) -> V2 {
            V2(self.0, self.0)
        }
        #[inline(always)]
        pub fn dup_hi(self) -> V2 {
            V2(self.1, self.1)
        }
        #[inline(always)]
        pub fn swap(self) -> V2 {
            V2(self.1, self.0)
        }
        #[inline(always)]
        pub fn round_f32(self) -> V2 {
            V2(self.0 as f32 as f64, self.1 as f32 as f64)
        }
    }
}

pub use lanes::V2;

/// V8's `Math.hypot` for two arguments: NaN and infinity rules, then the arguments normalised to
/// the largest and squared with Kahan summation.
pub fn hypot_js(a: f64, b: f64) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    let mut abs = [0.0f64; 2];
    for (k, v) in [a, b].into_iter().enumerate() {
        if v.is_nan() {
            nan = true;
        } else {
            abs[k] = v.abs();
            if abs[k] > max {
                max = abs[k];
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut comp = 0.0f64;
    for v in abs {
        let n = v / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    float::sqrt(sum) * max
}

/// JS `Math.round`: the nearest integer, halves up (-0.5 gives -0).
#[inline(always)]
pub fn round_js(x: f64) -> f64 {
    let c = float::ceil(x);
    if c - 0.5 > x {
        c - 1.0
    } else {
        c
    }
}

/// `Math.max(-32768, Math.min(32767, Math.round(v)))` stored into an Int16Array (NaN gives 0).
#[inline(always)]
fn s16_clamped_round(v: f64) -> i16 {
    let r = round_js(v);
    if r > 32767.0 {
        32767
    } else if r < -32768.0 {
        -32768
    } else {
        r as i16
    }
}

/// `t > 32767 ? 32767 : t < -32768 ? -32768 : Math.round(t)` stored into an Int16Array.
#[inline(always)]
fn s16_round_clamped(t: f64) -> i16 {
    if t > 32767.0 {
        32767
    } else if t < -32768.0 {
        -32768
    } else {
        round_js(t) as i16
    }
}

/// A complex FIR over a doubled (re, im) line: `win` is the T samples oldest first (2·T f64),
/// `taps` reversed to match. Four partial sums, joined as (s0 + s1) + (s2 + s3).
#[inline(always)]
fn cfir(taps: &[f64], win: &[f64]) -> V2 {
    let t = taps.len();
    let win = &win[..2 * t];
    let mut a0 = V2::zero();
    let mut a1 = V2::zero();
    let mut a2 = V2::zero();
    let mut a3 = V2::zero();
    let mut j = 0;
    while j + 4 <= t {
        a0 = a0.add(V2::splat(taps[j]).mul(V2::load(win, 2 * j)));
        a1 = a1.add(V2::splat(taps[j + 1]).mul(V2::load(win, 2 * j + 2)));
        a2 = a2.add(V2::splat(taps[j + 2]).mul(V2::load(win, 2 * j + 4)));
        a3 = a3.add(V2::splat(taps[j + 3]).mul(V2::load(win, 2 * j + 6)));
        j += 4;
    }
    while j < t {
        a0 = a0.add(V2::splat(taps[j]).mul(V2::load(win, 2 * j)));
        j += 1;
    }
    a0.add(a1).add(a2.add(a3))
}

/// A real FIR over a doubled line, `win` oldest first, `taps` reversed: two f64x2 partial sums
/// (four lanes) and a scalar tail.
#[inline(always)]
fn rfir(taps: &[f64], win: &[f64]) -> f64 {
    let t = taps.len();
    let win = &win[..t];
    let mut a0 = V2::zero();
    let mut a1 = V2::zero();
    let mut j = 0;
    while j + 4 <= t {
        a0 = a0.add(V2::load(taps, j).mul(V2::load(win, j)));
        a1 = a1.add(V2::load(taps, j + 2).mul(V2::load(win, j + 2)));
        j += 4;
    }
    let mut tail = 0.0;
    while j < t {
        tail += taps[j] * win[j];
        j += 1;
    }
    (a0.lo() + a0.hi()) + (a1.lo() + a1.hi()) + tail
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    #[inline(always)]
    fn step(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// The discriminator's state (fm-audio.ts `FmAudioDemod`) and its output buffer.
struct Demod<'a> {
    scale: f64,
    alpha: f64,
    last_i: f64,
    last_q: f64,
    deemph: f64,
    head: usize,
    phase: u32,
    taps: &'a [f64],
    hist: &'a mut [f64],
    pcm: &'a mut [i16],
    written: usize,
}

impl Demod<'_> {
    /// One 48 kHz sample (each part already a Float32 value). False: the output is full.
    #[inline(always)]
    fn sample(&mut self, re: f64, im: f64) -> bool {
        let mut x = float::atan2f(
            im * self.last_i - re * self.last_q,
            re * self.last_i + im * self.last_q,
        ) * self.scale;
        self.last_i = re;
        self.last_q = im;
        self.deemph += self.alpha * (x - self.deemph);
        x = self.deemph * 4.0;
        let t = self.taps.len();
        self.hist[self.head] = x;
        self.hist[self.head + t] = x;
        self.phase += 1;
        if self.phase == DEMOD_DECIMATION {
            self.phase = 0;
            let acc = rfir(self.taps, &self.hist[self.head + 1..]);
            if self.written == self.pcm.len() {
                return false;
            }
            self.pcm[self.written] = s16_clamped_round(acc * 32767.0);
            self.written += 1;
        }
        self.head = if self.head + 1 == t { 0 } else { self.head + 1 };
        true
    }
}

/// Checks the layout only (the host calls it once, after writing the constants).
///
/// # Safety
/// `mem` is the module's memory (or a host buffer) of `mem.size` bytes.
pub unsafe fn check_only(mem: Mem, ctl: usize) -> u32 {
    match check(mem, ctl) {
        Ok(_) => E_OK,
        Err(e) => e,
    }
}

/// Runs the chain over the `N_IN` CU8 samples in `Input`; writes `N_OUT` frames to `Pcm` and
/// `Tone` and the state back to the control block. `E_ABI`, `E_LAYOUT`, `E_STATE` and `E_INPUT`
/// are returned before anything is touched; `E_OUTPUT` (more frames than `OUT_CAP`, which the
/// host's sizing rules out) stops mid-run and leaves the chain unusable. The state slots are
/// written only at the end of a successful run, but the delay lines change in place, so the host
/// copies the control block and the lines aside before each call and, after any failure or trap,
/// continues in its JS chain from that copy (wideband-nfm-wasm.ts `NfmKernel.state`).
///
/// # Safety
/// `mem` is the module's memory (or a host buffer) of `mem.size` bytes.
pub unsafe fn run(mem: Mem, ctl: usize) -> u32 {
    let l = match check(mem, ctl) {
        Ok(l) => l,
        Err(e) => return e,
    };
    let d = l.d;
    let n = mem.u32(ctl, C_N_IN) as usize;
    if n > d.max_in {
        return E_INPUT;
    }
    let k = d.k as u32;
    let m = d.m as u32;
    let mut phase = mem.u32(ctl, C_PHASE);
    let mut s2_phase = mem.u32(ctl, C_S2_PHASE);
    let mut since_renorm = mem.u32(ctl, C_SINCE_RENORM);
    let mut s2_head = mem.u32(ctl, C_S2_HEAD) as usize;
    let mut ch_head = mem.u32(ctl, C_CH_HEAD) as usize;
    let dm_head = mem.u32(ctl, C_DM_HEAD) as usize;
    let dm_phase = mem.u32(ctl, C_DM_PHASE);
    if phase >= k
        || s2_phase >= m
        || since_renorm >= RENORM_EVERY
        || s2_head >= d.t2
        || ch_head >= d.tc
        || dm_head >= d.td
        || dm_phase >= DEMOD_DECIMATION
    {
        return E_STATE;
    }
    let exact = mem.u32(ctl, C_EXACT) != 0;
    let high_pass = mem.u32(ctl, C_HIGH_PASS) != 0;
    let f = |i: usize| mem.f64(ctl, i);
    let lut: &[f64] = l.slice(mem, R::Lut);
    let s2_taps: &[f64] = l.slice(mem, R::S2Taps);
    let s2_line: &mut [f64] = l.slice(mem, R::S2Line);
    let ch_taps: &[f64] = l.slice(mem, R::ChTaps);
    let ch_line: &mut [f64] = l.slice(mem, R::ChLine);
    let input: &[u8] = l.slice(mem, R::Input);
    let input = &input[..2 * n];
    let pcm: &mut [i16] = l.slice(mem, R::Pcm);
    let tone: &mut [i16] = l.slice(mem, R::Tone);

    let rot = V2::new(f(F_ROT_RE), f(F_ROT_IM));
    // (-rotIm, rotRe): phIm · this, added, is the JS "− phIm · rotIm" and "+ phIm · rotRe".
    let rot_s = rot.swap().mul(V2::new(-1.0, 1.0));
    let neg_lo = V2::new(-1.0, 1.0);
    let cic = V2::splat(f(F_CIC_SCALE));
    let step = f(F_STEP);
    let mut ph = V2::new(f(F_PH_RE), f(F_PH_IM));
    let mut cur = V2::new(f(F_CUR_RE), f(F_CUR_IM));
    let mut nxt = V2::new(f(F_NXT_RE), f(F_NXT_IM));
    let mut frac = f(F_FRAC);
    let mut prev = V2::new(f(F_PREV_RE), f(F_PREV_IM));
    let mut dm = Demod {
        scale: f(F_SCALE),
        alpha: f(F_ALPHA),
        last_i: f(F_LAST_I),
        last_q: f(F_LAST_Q),
        deemph: f(F_DEEMPH),
        head: dm_head,
        phase: dm_phase,
        taps: l.slice(mem, R::DmTaps),
        hist: l.slice(mem, R::DmHist),
        pcm,
        written: 0,
    };
    let (t2, tc) = (d.t2, d.tc);
    let kf = k as f64;

    for i in 0..n {
        let x = V2::new(lut[input[2 * i] as usize], lut[input[2 * i + 1] as usize]);
        // mr = xr·phRe − xi·phIm, mi = xr·phIm + xi·phRe
        let mix = x
            .dup_lo()
            .mul(ph)
            .add(x.dup_hi().mul(ph.swap().mul(neg_lo)));
        ph = ph.dup_lo().mul(rot).add(ph.dup_hi().mul(rot_s));
        since_renorm += 1;
        if since_renorm == RENORM_EVERY {
            let mag = hypot_js(ph.lo(), ph.hi());
            ph = V2::new(ph.lo() / mag, ph.hi() / mag);
            since_renorm = 0;
        }
        let p = phase as f64;
        cur = cur.add(V2::splat(kf - p).mul(mix));
        nxt = nxt.add(V2::splat(p).mul(mix));
        phase += 1;
        if phase < k {
            continue;
        }
        phase = 0;
        let s1 = cur.mul(cic).round_f32();
        cur = nxt;
        nxt = V2::zero();
        s1.store(s2_line, 2 * s2_head);
        s1.store(s2_line, 2 * (s2_head + t2));
        let s2_win = 2 * (s2_head + 1);
        s2_head = if s2_head + 1 == t2 { 0 } else { s2_head + 1 };
        s2_phase += 1;
        if s2_phase < m {
            continue;
        }
        s2_phase = 0;
        let s2 = cfir(s2_taps, &s2_line[s2_win..]).round_f32();
        s2.store(ch_line, 2 * ch_head);
        s2.store(ch_line, 2 * (ch_head + tc));
        let ch_win = 2 * (ch_head + 1);
        ch_head = if ch_head + 1 == tc { 0 } else { ch_head + 1 };
        let y = cfir(ch_taps, &ch_line[ch_win..]);
        if exact {
            let o = y.round_f32();
            if !dm.sample(o.lo(), o.hi()) {
                return E_OUTPUT;
            }
            continue;
        }
        while frac < 1.0 {
            let o = prev.add(y.sub(prev).mul(V2::splat(frac))).round_f32();
            if !dm.sample(o.lo(), o.hi()) {
                return E_OUTPUT;
            }
            frac += step;
        }
        frac -= 1.0;
        prev = y;
    }

    let written = dm.written;
    let mut bq = [Biquad {
        b0: 0.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
        x1: 0.0,
        x2: 0.0,
        y1: 0.0,
        y2: 0.0,
    }; 4];
    for (q, b) in bq.iter_mut().enumerate() {
        let c = F_BIQUAD + 5 * q;
        let s = F_BIQUAD_STATE + 4 * q;
        *b = Biquad {
            b0: f(c),
            b1: f(c + 1),
            b2: f(c + 2),
            a1: f(c + 3),
            a2: f(c + 4),
            x1: f(s),
            x2: f(s + 1),
            y1: f(s + 2),
            y2: f(s + 3),
        };
    }
    let [mut hp0, mut hp1, mut lp0, mut lp1] = bq;
    let pcm = &mut dm.pcm[..written];
    let tone = &mut tone[..written];
    for (p, t) in pcm.iter_mut().zip(tone.iter_mut()) {
        let x = *p as f64;
        *t = s16_round_clamped(lp1.step(lp0.step(x)));
        if high_pass {
            *p = s16_round_clamped(hp1.step(hp0.step(x)));
        }
    }

    // state back
    mem.set_u32(ctl, C_N_OUT, written as u32);
    mem.set_u32(ctl, C_PHASE, phase);
    mem.set_u32(ctl, C_S2_PHASE, s2_phase);
    mem.set_u32(ctl, C_SINCE_RENORM, since_renorm);
    mem.set_u32(ctl, C_S2_HEAD, s2_head as u32);
    mem.set_u32(ctl, C_CH_HEAD, ch_head as u32);
    mem.set_u32(ctl, C_DM_HEAD, dm.head as u32);
    mem.set_u32(ctl, C_DM_PHASE, dm.phase);
    let set = |i: usize, v: f64| mem.set_f64(ctl, i, v);
    set(F_PH_RE, ph.lo());
    set(F_PH_IM, ph.hi());
    set(F_CUR_RE, cur.lo());
    set(F_CUR_IM, cur.hi());
    set(F_NXT_RE, nxt.lo());
    set(F_NXT_IM, nxt.hi());
    set(F_FRAC, frac);
    set(F_PREV_RE, prev.lo());
    set(F_PREV_IM, prev.hi());
    set(F_LAST_I, dm.last_i);
    set(F_LAST_Q, dm.last_q);
    set(F_DEEMPH, dm.deemph);
    for (q, b) in [hp0, hp1, lp0, lp1].iter().enumerate() {
        let s = F_BIQUAD_STATE + 4 * q;
        set(s, b.x1);
        set(s + 1, b.x2);
        set(s + 2, b.y1);
        set(s + 3, b.y2);
    }
    E_OK
}

#[cfg(target_arch = "wasm32")]
mod exports {
    use super::*;

    fn mem() -> Mem {
        Mem {
            base: 0,
            size: core::arch::wasm32::memory_size(0) * 65536,
        }
    }

    #[no_mangle]
    pub extern "C" fn nfm_abi() -> u32 {
        ABI
    }

    #[no_mangle]
    pub extern "C" fn nfm_ctl_bytes() -> u32 {
        CTL_BYTES as u32
    }

    #[no_mangle]
    pub extern "C" fn nfm_check(ctl: u32) -> u32 {
        // SAFETY: the memory is this module's; `check` reads only inside it.
        unsafe { check_only(mem(), ctl as usize) }
    }

    /// Fault-isolation test hook: traps (`unreachable`), as a chain bug would.
    #[no_mangle]
    pub extern "C" fn nfm_trap() -> u32 {
        core::arch::wasm32::unreachable()
    }

    #[no_mangle]
    pub extern "C" fn nfm_run(ctl: u32) -> u32 {
        // SAFETY: as nfm_check; `run` checks the layout and state before touching a region.
        unsafe { run(mem(), ctl as usize) }
    }
}

#[cfg(test)]
mod tests;
