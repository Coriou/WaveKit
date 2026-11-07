//! The spectrum worker's per-frame kernel (src/core/spectrum/frame-wasm.ts loads it).
//!
//! One `fp_run` call takes a batch of raw IQ frames the worker staged in linear memory and runs, per
//! frame, what `SpectrumPipeline.onFrame` runs in JS: convert and window (frame-source.ts), the
//! radix-2 FFT (fft.ts), the shifted power sum, `ImpulseBlanker.offer`'s numeric part, the block sum,
//! `shortFrame` (the sliding T_short sum and its bracketed threshold compare) and the per-track power
//! sums of `Tracker.frame`. Block stages stay in JS and read the same memory through typed-array views.
//!
//! Equivalence is bit for bit, by construction rather than by tolerance:
//! - every table the JS path computes with `Math.cos` or a division (window, twiddles, bit reversal,
//!   the U8 lookup, the blanker's rise factor, the track floor) is written by JS, not recomputed here;
//! - every expression keeps the JS operand order in f64, stores Float32 where the JS path stores into a
//!   Float32Array (each FFT stage), and uses no fused multiply-add (wasm has none without relaxed SIMD);
//! - SIMD lanes run the same IEEE operations as the scalar code, so lane width does not move a bit;
//! - the one `Math.log10` comparison (a short-path sum inside its threshold bracket) is not taken
//!   here: the import `env.short_db` asks the JS `shortOnInDb` for that bin.
//!
//! Memory is the host's: the module imports a fixed `env.memory` and allocates nothing. The host lays
//! out every region after a control block (`CTL_*`); `fp_init` and `fp_run` check that layout and
//! return an error code instead of touching anything outside it.

#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Bumped on any change to the control block or the region order.
pub const ABI: u32 = 1;

// Control block: CTL_U32 u32 slots, then CTL_F64 f64 slots. Offsets are byte addresses.
pub const C_ABI: usize = 0;
pub const C_N: usize = 1;
pub const C_FORMAT: usize = 2;
pub const C_FRAME_BYTES: usize = 3;
pub const C_PEND_CAP: usize = 4;
pub const C_PEND_COUNT: usize = 5;
pub const C_HAS_REF: usize = 6;
pub const C_BLANK_LO: usize = 7;
pub const C_BLANK_HI: usize = 8;
pub const C_BLANK_NEED: usize = 9;
pub const C_SHORT_FRAMES: usize = 10;
pub const C_SHORT_SLOT: usize = 11;
pub const C_SHORT_FILL: usize = 12;
pub const C_FLOOR_READY: usize = 13;
pub const C_BATCH_CAP: usize = 14;
pub const C_BATCH_COUNT: usize = 15;
pub const C_TRACK_CAP: usize = 16;
pub const C_TRACK_COUNT: usize = 17;
pub const C_CLIPPED: usize = 18;
pub const C_DB_CALLS: usize = 19;
pub const C_END: usize = 20;
/// Region offsets, in `REGIONS` order, from this slot on.
pub const C_REGION: usize = 24;
pub const CTL_U32: usize = 64;

pub const F_SHORT_NEXT: usize = 0;
pub const F_HOP: usize = 1;
pub const F_RISE: usize = 2;
pub const F_TINY: usize = 3;
pub const F_FRAME_SCALE: usize = 4;
pub const F_TRACK_FLOOR: usize = 5;
pub const CTL_F64: usize = 16;
pub const CTL_BYTES: usize = CTL_U32 * 4 + CTL_F64 * 8;

pub const E_OK: u32 = 0;
pub const E_ABI: u32 = 1;
pub const E_LAYOUT: u32 = 2;
pub const E_PENDING: u32 = 3;
pub const E_BATCH: u32 = 4;
pub const E_TRACKS: u32 = 5;
pub const E_FORMAT: u32 = 6;

pub const FORMAT_U8: u32 = 0;
pub const FORMAT_S16: u32 = 1;
pub const FORMAT_F32: u32 = 2;

pub const VERDICT_KEEP: u8 = 0;
pub const VERDICT_BLANK: u8 = 1;
pub const VERDICT_PENDING: u8 = 2;

/// The regions, in layout order. Sizes in bytes follow from the control block (`region_bytes`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum R {
    Window,
    Cos,
    Sin,
    Rev,
    TwRe,
    TwIm,
    Lut,
    Re,
    Im,
    FrameAcc,
    BlockAcc,
    Raw,
    Ref,
    Pending,
    ShortAcc,
    ShortRing,
    OnLo,
    OnHi,
    OffLo,
    OffHi,
    BurstPeak,
    ShortOn,
    BurstCount,
    Mask,
    Staging,
    Starts,
    Verdict,
    TrackBins,
    Sums,
}

pub const REGIONS: [R; 29] = [
    R::Window,
    R::Cos,
    R::Sin,
    R::Rev,
    R::TwRe,
    R::TwIm,
    R::Lut,
    R::Re,
    R::Im,
    R::FrameAcc,
    R::BlockAcc,
    R::Raw,
    R::Ref,
    R::Pending,
    R::ShortAcc,
    R::ShortRing,
    R::OnLo,
    R::OnHi,
    R::OffLo,
    R::OffHi,
    R::BurstPeak,
    R::ShortOn,
    R::BurstCount,
    R::Mask,
    R::Staging,
    R::Starts,
    R::Verdict,
    R::TrackBins,
    R::Sums,
];

/// The numbers a layout is sized from.
#[derive(Clone, Copy, Debug)]
pub struct Dims {
    pub n: usize,
    pub frame_bytes: usize,
    pub pend_cap: usize,
    pub short_frames: usize,
    pub batch_cap: usize,
    pub track_cap: usize,
}

/// Bytes of one region (frame-wasm.ts `regionBytes` states the same arithmetic).
pub fn region_bytes(r: R, d: &Dims) -> usize {
    let n = d.n;
    match r {
        R::Window | R::Re | R::Im | R::Rev => 4 * n,
        R::Cos | R::Sin => 8 * (n / 2),
        R::TwRe | R::TwIm => 8 * n,
        R::Lut => 8 * 256,
        R::FrameAcc
        | R::BlockAcc
        | R::Raw
        | R::Ref
        | R::ShortAcc
        | R::OnLo
        | R::OnHi
        | R::OffLo
        | R::OffHi
        | R::BurstPeak => 8 * n,
        R::Pending => 8 * n * d.pend_cap,
        R::ShortRing => 8 * n * d.short_frames.max(1),
        R::ShortOn | R::BurstCount | R::Mask => n,
        R::Staging => d.frame_bytes * d.batch_cap,
        R::Starts => 8 * d.batch_cap,
        R::Verdict => d.batch_cap,
        R::TrackBins => 8 * d.track_cap,
        R::Sums => 8 * d.batch_cap * d.track_cap,
    }
}

fn bytes_per_sample(format: u32) -> Option<usize> {
    match format {
        FORMAT_U8 => Some(2),
        FORMAT_S16 => Some(4),
        FORMAT_F32 => Some(8),
        _ => None,
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
    /// `off + 4·i` is inside the memory (`check` proved the control block is).
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
    pub format: u32,
    pub off: [usize; 29],
}

/// Checks the control block and the region list: ABI, power-of-two N, frame bytes for the format,
/// regions in order, 8-byte aligned, disjoint, inside `[ctl + CTL_BYTES, end]` with `end` inside
/// the memory. Anything else is `E_LAYOUT` (or `E_ABI`/`E_FORMAT`) and nothing is touched.
///
/// # Safety
/// `mem` describes readable memory of `mem.size` bytes.
pub unsafe fn check(mem: Mem, ctl: usize) -> Result<Layout, u32> {
    if ctl % 8 != 0 || ctl.checked_add(CTL_BYTES).is_none_or(|e| e > mem.size) {
        return Err(E_LAYOUT);
    }
    if mem.u32(ctl, C_ABI) != ABI {
        return Err(E_ABI);
    }
    let n = mem.u32(ctl, C_N) as usize;
    if !(2..=1 << 20).contains(&n) || !n.is_power_of_two() {
        return Err(E_LAYOUT);
    }
    let format = mem.u32(ctl, C_FORMAT);
    let Some(bps) = bytes_per_sample(format) else {
        return Err(E_FORMAT);
    };
    let d = Dims {
        n,
        frame_bytes: mem.u32(ctl, C_FRAME_BYTES) as usize,
        pend_cap: mem.u32(ctl, C_PEND_CAP) as usize,
        short_frames: mem.u32(ctl, C_SHORT_FRAMES) as usize,
        batch_cap: mem.u32(ctl, C_BATCH_CAP) as usize,
        track_cap: mem.u32(ctl, C_TRACK_CAP) as usize,
    };
    if d.frame_bytes != n * bps || d.batch_cap == 0 || d.pend_cap == 0 {
        return Err(E_LAYOUT);
    }
    let end = mem.u32(ctl, C_END) as usize;
    if end > mem.size {
        return Err(E_LAYOUT);
    }
    let mut off = [0usize; 29];
    let mut at = ctl + CTL_BYTES;
    for (k, &r) in REGIONS.iter().enumerate() {
        let o = mem.u32(ctl, C_REGION + k) as usize;
        let Some(e) = o.checked_add(region_bytes(r, &d)) else {
            return Err(E_LAYOUT);
        };
        if o < at || o % 8 != 0 || e > end {
            return Err(E_LAYOUT);
        }
        off[k] = o;
        at = e;
    }
    Ok(Layout { d, format, off })
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

/// Builds the per-stage twiddle tables from the JS cos/sin tables: stage `len` reads `cos[j·N/len]`
/// for j < len/2, laid out contiguously so a stage reads them in order. Values are copied, not computed.
///
/// # Safety
/// `mem` is the module's memory (or a host buffer) of `mem.size` bytes.
pub unsafe fn init(mem: Mem, ctl: usize) -> u32 {
    let l = match check(mem, ctl) {
        Ok(l) => l,
        Err(e) => return e,
    };
    let n = l.d.n;
    let cos: &mut [f64] = l.slice(mem, R::Cos);
    let sin: &mut [f64] = l.slice(mem, R::Sin);
    let tw_re: &mut [f64] = l.slice(mem, R::TwRe);
    let tw_im: &mut [f64] = l.slice(mem, R::TwIm);
    let mut toff = 0;
    let mut len = 2;
    while len <= n {
        let half = len / 2;
        let step = n / len;
        for j in 0..half {
            tw_re[toff + j] = cos[j * step];
            tw_im[toff + j] = sin[j * step];
        }
        toff += half;
        len <<= 1;
    }
    E_OK
}

/// frame-source.ts `convert`: one frame of raw bytes to windowed Float32 re/im; returns the clipped count.
fn convert(
    format: u32,
    bytes: &[u8],
    w: &[f32],
    lut: &[f64],
    re: &mut [f32],
    im: &mut [f32],
) -> u32 {
    let mut clipped = 0u32;
    match format {
        FORMAT_U8 => {
            for (i, iq) in bytes.chunks_exact(2).enumerate() {
                let (iv, qv) = (iq[0], iq[1]);
                clipped += (iv == 0 || iv == 255 || qv == 0 || qv == 255) as u32;
                let wi = w[i] as f64;
                re[i] = (lut[iv as usize] * wi) as f32;
                im[i] = (lut[qv as usize] * wi) as f32;
            }
        }
        FORMAT_S16 => {
            for (i, iq) in bytes.chunks_exact(4).enumerate() {
                let iv = i16::from_le_bytes([iq[0], iq[1]]) as i32;
                let qv = i16::from_le_bytes([iq[2], iq[3]]) as i32;
                clipped += (iv >= 32767 || iv <= -32767 || qv >= 32767 || qv <= -32767) as u32;
                let wi = w[i] as f64;
                re[i] = ((iv as f64 / 32768.0) * wi) as f32;
                im[i] = ((qv as f64 / 32768.0) * wi) as f32;
            }
        }
        _ => {
            for (i, iq) in bytes.chunks_exact(8).enumerate() {
                let iv = f32::from_le_bytes([iq[0], iq[1], iq[2], iq[3]]) as f64;
                let qv = f32::from_le_bytes([iq[4], iq[5], iq[6], iq[7]]) as f64;
                clipped += (iv.abs() >= 1.0 || qv.abs() >= 1.0) as u32;
                let wi = w[i] as f64;
                re[i] = (iv * wi) as f32;
                im[i] = (qv * wi) as f32;
            }
        }
    }
    clipped
}

/// Two f64x2 to one f32x4 [l0 l1 h0 h1]: two demotes, the second moved up by a swizzle. The
/// swizzle's index vector is read from memory so LLVM cannot see which lanes are used: with a
/// constant shuffle it narrows each demote to the lanes kept and scalarises it (4 extracts, 4
/// scalar demotes, 3 replaces per pack). Byte moves and an OR with zero lanes are exact.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
unsafe fn pack(
    l: core::arch::wasm32::v128,
    h: core::arch::wasm32::v128,
    up: core::arch::wasm32::v128,
) -> core::arch::wasm32::v128 {
    use core::arch::wasm32::*;
    v128_or(
        f32x4_demote_f64x2_zero(l),
        i8x16_swizzle(f32x4_demote_f64x2_zero(h), up),
    )
}

/// fft.ts `Fft.transform`: bit reversal, then radix-2 stages with f64 butterflies stored as Float32.
pub fn fft(re: &mut [f32], im: &mut [f32], rev: &[u32], tw_re: &[f64], tw_im: &[f64]) {
    let n = re.len();
    for i in 0..n {
        let j = rev[i] as usize;
        if j > i && j < n {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut toff = 0;
    let mut len = 2;
    while len <= n {
        let half = len / 2;
        let wr = &tw_re[toff..toff + half];
        let wi = &tw_im[toff..toff + half];
        stage(re, im, half, wr, wi);
        toff += half;
        len <<= 1;
    }
}

#[inline(always)]
fn butterfly(re: &mut [f32], im: &mut [f32], a: usize, b: usize, wr: f64, wi: f64) {
    let br = re[b] as f64;
    let bi = im[b] as f64;
    let xr = br * wr - bi * wi;
    let xi = br * wi + bi * wr;
    let ar = re[a] as f64;
    let ai = im[a] as f64;
    re[b] = (ar - xr) as f32;
    im[b] = (ai - xi) as f32;
    re[a] = (ar + xr) as f32;
    im[a] = (ai + xi) as f32;
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn stage(re: &mut [f32], im: &mut [f32], half: usize, wr: &[f64], wi: &[f64]) {
    stage_scalar(re, im, half, wr, wi);
}

fn stage_scalar(re: &mut [f32], im: &mut [f32], half: usize, wr: &[f64], wi: &[f64]) {
    let n = re.len();
    let mut start = 0;
    while start < n {
        for j in 0..half {
            butterfly(re, im, start + j, start + j + half, wr[j], wi[j]);
        }
        start += 2 * half;
    }
}

/// The same butterflies, several at a time: f32 lanes promoted to f64x2, the same products, sums and
/// differences, demoted back. Lane for lane these are the scalar IEEE operations, so the result is
/// the scalar (and JS) result bit for bit. Stages of half ≥ 4 take four j per step with their
/// twiddles loaded once for every block; half 2 takes both j of a block; half 1 (twiddle 1, −0)
/// takes two blocks per step, de-interleaving the (a, b) pairs.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn stage(re: &mut [f32], im: &mut [f32], half: usize, wr: &[f64], wi: &[f64]) {
    use core::arch::wasm32::*;
    let n = re.len();
    if n < 4 || re.len() != im.len() || wr.len() < half || wi.len() < half {
        return stage_scalar(re, im, half, wr, wi);
    }
    let rp = re.as_mut_ptr();
    let ip = im.as_mut_ptr();
    let wrp = wr.as_ptr();
    let wip = wi.as_ptr();
    #[inline(always)]
    unsafe fn lo(v: v128) -> v128 {
        f64x2_promote_low_f32x4(v)
    }
    #[inline(always)]
    unsafe fn hi(v: v128) -> v128 {
        f64x2_promote_low_f32x4(u64x2_shuffle::<1, 1>(v, v))
    }
    // SAFETY: every index is below n: a + 4 ≤ start + half and b + 4 ≤ start + 2·half ≤ n for half ≥ 4,
    // a + 2 and b + 2 within the block of 4 for half 2, four floats from 4·s ≤ n − 4 for half 1;
    // twiddle indices are below half. wasm loads and stores of v128 need no alignment.
    unsafe {
        let up = core::ptr::read_volatile(PACK_UP.as_ptr() as *const v128);
        if half >= 4 {
            let mut j = 0;
            while j < half {
                let wr0 = v128_load(wrp.add(j) as *const v128);
                let wr1 = v128_load(wrp.add(j + 2) as *const v128);
                let wi0 = v128_load(wip.add(j) as *const v128);
                let wi1 = v128_load(wip.add(j + 2) as *const v128);
                let mut start = 0;
                while start < n {
                    let a = start + j;
                    let b = a + half;
                    let brv = v128_load(rp.add(b) as *const v128);
                    let biv = v128_load(ip.add(b) as *const v128);
                    let arv = v128_load(rp.add(a) as *const v128);
                    let aiv = v128_load(ip.add(a) as *const v128);
                    let (br0, br1, bi0, bi1) = (lo(brv), hi(brv), lo(biv), hi(biv));
                    let xr0 = f64x2_sub(f64x2_mul(br0, wr0), f64x2_mul(bi0, wi0));
                    let xr1 = f64x2_sub(f64x2_mul(br1, wr1), f64x2_mul(bi1, wi1));
                    let xi0 = f64x2_add(f64x2_mul(br0, wi0), f64x2_mul(bi0, wr0));
                    let xi1 = f64x2_add(f64x2_mul(br1, wi1), f64x2_mul(bi1, wr1));
                    let (ar0, ar1, ai0, ai1) = (lo(arv), hi(arv), lo(aiv), hi(aiv));
                    v128_store(
                        rp.add(b) as *mut v128,
                        pack(f64x2_sub(ar0, xr0), f64x2_sub(ar1, xr1), up),
                    );
                    v128_store(
                        ip.add(b) as *mut v128,
                        pack(f64x2_sub(ai0, xi0), f64x2_sub(ai1, xi1), up),
                    );
                    v128_store(
                        rp.add(a) as *mut v128,
                        pack(f64x2_add(ar0, xr0), f64x2_add(ar1, xr1), up),
                    );
                    v128_store(
                        ip.add(a) as *mut v128,
                        pack(f64x2_add(ai0, xi0), f64x2_add(ai1, xi1), up),
                    );
                    start += 2 * half;
                }
                j += 4;
            }
        } else if half == 2 {
            // one block of 4 per step: lanes [a0 a1 | b0 b1]
            let w_r = v128_load(wrp as *const v128);
            let w_i = v128_load(wip as *const v128);
            let mut start = 0;
            while start < n {
                let rv = v128_load(rp.add(start) as *const v128);
                let iv = v128_load(ip.add(start) as *const v128);
                let (ar, br, ai, bi) = (lo(rv), hi(rv), lo(iv), hi(iv));
                let xr = f64x2_sub(f64x2_mul(br, w_r), f64x2_mul(bi, w_i));
                let xi = f64x2_add(f64x2_mul(br, w_i), f64x2_mul(bi, w_r));
                v128_store(
                    rp.add(start) as *mut v128,
                    pack(f64x2_add(ar, xr), f64x2_sub(ar, xr), up),
                );
                v128_store(
                    ip.add(start) as *mut v128,
                    pack(f64x2_add(ai, xi), f64x2_sub(ai, xi), up),
                );
                start += 4;
            }
        } else {
            // two blocks of 2 per step: lanes [a0 b0 a1 b1]
            let w_r = f64x2_splat(*wrp);
            let w_i = f64x2_splat(*wip);
            let mut start = 0;
            while start < n {
                let rv = v128_load(rp.add(start) as *const v128);
                let iv = v128_load(ip.add(start) as *const v128);
                let ar = lo(i32x4_shuffle::<0, 2, 0, 2>(rv, rv));
                let br = lo(i32x4_shuffle::<1, 3, 1, 3>(rv, rv));
                let ai = lo(i32x4_shuffle::<0, 2, 0, 2>(iv, iv));
                let bi = lo(i32x4_shuffle::<1, 3, 1, 3>(iv, iv));
                let xr = f64x2_sub(f64x2_mul(br, w_r), f64x2_mul(bi, w_i));
                let xi = f64x2_add(f64x2_mul(br, w_i), f64x2_mul(bi, w_r));
                // [a0' a1'] and [b0' b1'] in f64, regrouped as [a0' b0'] [a1' b1'] before the pack
                let (pa, pb) = (f64x2_add(ar, xr), f64x2_sub(ar, xr));
                let (qa, qb) = (f64x2_add(ai, xi), f64x2_sub(ai, xi));
                v128_store(
                    rp.add(start) as *mut v128,
                    pack(
                        u64x2_shuffle::<0, 2>(pa, pb),
                        u64x2_shuffle::<1, 3>(pa, pb),
                        up,
                    ),
                );
                v128_store(
                    ip.add(start) as *mut v128,
                    pack(
                        u64x2_shuffle::<0, 2>(qa, qb),
                        u64x2_shuffle::<1, 3>(qa, qb),
                        up,
                    ),
                );
                start += 4;
            }
        }
    }
}

/// `pack`'s swizzle: bytes 0..8 of the second demote to 8..16, zeros below (index 16 reads 0).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
static PACK_UP: [u8; 16] = [16, 16, 16, 16, 16, 16, 16, 16, 0, 1, 2, 3, 4, 5, 6, 7];

/// fft.ts `accumulateShiftedPower` into a zeroed accumulator: acc[shift(k)] = 0 + re² + im².
/// The two halves swap places (shift(k) = k ± N/2), as two branch-free loops.
fn shifted_power(re: &[f32], im: &[f32], acc: &mut [f64]) {
    let half = re.len() / 2;
    let (re_lo, re_hi) = re.split_at(half);
    let (im_lo, im_hi) = im.split_at(half);
    let (acc_lo, acc_hi) = acc.split_at_mut(half);
    for ((a, &r), &i) in acc_hi.iter_mut().zip(re_lo).zip(im_lo) {
        let (r, i) = (r as f64, i as f64);
        *a = 0.0 + r * r + i * i;
    }
    for ((a, &r), &i) in acc_lo.iter_mut().zip(re_hi).zip(im_hi) {
        let (r, i) = (r as f64, i as f64);
        *a = 0.0 + r * r + i * i;
    }
}

/// `Math.max(r, tiny)` for tiny > 0: NaN stays NaN, as in JS.
#[inline(always)]
fn js_max_tiny(r: f64, tiny: f64) -> f64 {
    if r.is_nan() || r > tiny {
        r
    } else {
        tiny
    }
}

/// impulse-blanker.ts `rises`: every usable bin counted (no early exit, as in JS).
fn rises(
    power: &[f64],
    reference: &[f64],
    lo: usize,
    hi: usize,
    need: usize,
    rise: f64,
    tiny: f64,
) -> bool {
    let mut rising = 0usize;
    for (&p, &r) in power[lo..hi].iter().zip(&reference[lo..hi]) {
        rising += (p >= rise * js_max_tiny(r, tiny)) as usize;
    }
    rising >= need
}

/// The batch kernel. `db(i, a, was)` decides a short-path sum inside its bracket (JS `shortOnInDb`).
///
/// # Safety
/// `mem` describes writable memory of `mem.size` bytes; the layout is checked before any access.
pub unsafe fn run(mem: Mem, ctl: usize, db: &mut dyn FnMut(u32, f64, bool) -> bool) -> u32 {
    let l = match check(mem, ctl) {
        Ok(l) => l,
        Err(e) => return e,
    };
    let d = l.d;
    let n = d.n;
    let count = mem.u32(ctl, C_BATCH_COUNT) as usize;
    if count > d.batch_cap {
        return E_BATCH;
    }
    let tracks = mem.u32(ctl, C_TRACK_COUNT) as usize;
    if tracks > d.track_cap {
        return E_TRACKS;
    }
    let mut pend = mem.u32(ctl, C_PEND_COUNT) as usize;
    let has_ref = mem.u32(ctl, C_HAS_REF) != 0;
    let lo = mem.u32(ctl, C_BLANK_LO) as usize;
    let hi = mem.u32(ctl, C_BLANK_HI) as usize;
    let need = mem.u32(ctl, C_BLANK_NEED) as usize;
    let frames_short = d.short_frames;
    let mut slot = mem.u32(ctl, C_SHORT_SLOT) as usize;
    let mut fill = mem.u32(ctl, C_SHORT_FILL) as usize;
    let floor_ready = mem.u32(ctl, C_FLOOR_READY) != 0;
    let mut short_next = mem.f64(ctl, F_SHORT_NEXT);
    let hop = mem.f64(ctl, F_HOP);
    let rise = mem.f64(ctl, F_RISE);
    let tiny = mem.f64(ctl, F_TINY);
    let frame_scale = mem.f64(ctl, F_FRAME_SCALE);
    let track_floor = mem.f64(ctl, F_TRACK_FLOOR);
    if lo > hi || hi > n || (frames_short > 0 && slot >= frames_short) {
        return E_LAYOUT;
    }

    let window: &[f32] = l.slice(mem, R::Window);
    let rev: &[u32] = l.slice(mem, R::Rev);
    let tw_re: &[f64] = l.slice(mem, R::TwRe);
    let tw_im: &[f64] = l.slice(mem, R::TwIm);
    let lut: &[f64] = l.slice(mem, R::Lut);
    let re: &mut [f32] = l.slice(mem, R::Re);
    let im: &mut [f32] = l.slice(mem, R::Im);
    let frame_acc: &mut [f64] = l.slice(mem, R::FrameAcc);
    let block_acc: &mut [f64] = l.slice(mem, R::BlockAcc);
    let raw: &mut [f64] = l.slice(mem, R::Raw);
    let reference: &[f64] = l.slice(mem, R::Ref);
    let pending: &mut [f64] = l.slice(mem, R::Pending);
    let short_acc: &mut [f64] = l.slice(mem, R::ShortAcc);
    let short_ring: &mut [f64] = l.slice(mem, R::ShortRing);
    let on_lo: &[f64] = l.slice(mem, R::OnLo);
    let on_hi: &[f64] = l.slice(mem, R::OnHi);
    let off_lo: &[f64] = l.slice(mem, R::OffLo);
    let off_hi: &[f64] = l.slice(mem, R::OffHi);
    let burst_peak: &mut [f64] = l.slice(mem, R::BurstPeak);
    let short_on: &mut [u8] = l.slice(mem, R::ShortOn);
    let burst_count: &mut [u8] = l.slice(mem, R::BurstCount);
    let mask: &[u8] = l.slice(mem, R::Mask);
    let staging: &[u8] = l.slice(mem, R::Staging);
    let starts: &[f64] = l.slice(mem, R::Starts);
    let verdict: &mut [u8] = l.slice(mem, R::Verdict);
    let track_bins: &[u32] = l.slice(mem, R::TrackBins);
    let sums: &mut [f64] = l.slice(mem, R::Sums);
    for t in 0..tracks {
        let (a, e) = (track_bins[2 * t] as usize, track_bins[2 * t + 1] as usize);
        if a > e || e > n {
            return E_TRACKS;
        }
    }

    let fb = d.frame_bytes;
    let mut clipped = mem.u32(ctl, C_CLIPPED);
    let mut db_calls = mem.u32(ctl, C_DB_CALLS);
    let mut status = E_OK;
    for k in 0..count {
        let start = starts[k];
        clipped = clipped.wrapping_add(convert(
            l.format,
            &staging[k * fb..(k + 1) * fb],
            window,
            lut,
            re,
            im,
        ));
        fft(re, im, rev, tw_re, tw_im);
        shifted_power(re, im, frame_acc);
        // ImpulseBlanker.offer: raw sum, then pending (no reference yet), blank or keep
        for i in 0..n {
            raw[i] = raw[i] + frame_acc[i];
        }
        if !has_ref {
            if pend >= d.pend_cap {
                status = E_PENDING;
                break;
            }
            pending[pend * n..(pend + 1) * n].copy_from_slice(frame_acc);
            pend += 1;
            verdict[k] = VERDICT_PENDING;
            continue;
        }
        if rises(frame_acc, reference, lo, hi, need, rise, tiny) {
            verdict[k] = VERDICT_BLANK;
            continue;
        }
        verdict[k] = VERDICT_KEEP;
        for i in 0..n {
            block_acc[i] = block_acc[i] + frame_acc[i];
        }
        if frames_short > 0 {
            // pipeline.ts shortFrame
            if start != short_next {
                short_ring.fill(0.0);
                short_acc.fill(0.0);
                slot = 0;
                fill = 0;
            }
            short_next = start + hop;
            let base = slot * n;
            let ring = &mut short_ring[base..base + n];
            for i in 0..n {
                let p = frame_acc[i];
                short_acc[i] = short_acc[i] + p - ring[i];
                ring[i] = p;
            }
            slot = (slot + 1) % frames_short;
            if slot == 0 {
                short_acc.fill(0.0);
                for s in 0..frames_short {
                    let r = &short_ring[s * n..(s + 1) * n];
                    for i in 0..n {
                        short_acc[i] = short_acc[i] + r[i];
                    }
                }
            }
            if fill < frames_short {
                fill += 1;
            }
            if fill >= frames_short && floor_ready {
                for i in 0..n {
                    let a = short_acc[i];
                    if a > burst_peak[i] {
                        burst_peak[i] = a;
                    }
                    if mask[i] != 1 {
                        short_on[i] = 0;
                        continue;
                    }
                    let was = short_on[i] == 1;
                    let (tlo, thi) = if was {
                        (off_lo[i], off_hi[i])
                    } else {
                        (on_lo[i], on_hi[i])
                    };
                    let on = a > thi
                        || (!(a < tlo) && {
                            db_calls = db_calls.wrapping_add(1);
                            db(i as u32, a, was)
                        });
                    short_on[i] = on as u8;
                    if on && burst_count[i] < 255 {
                        burst_count[i] += 1;
                    }
                }
            }
        }
        // Tracker.frame: one clamped linear power sum per open track
        for t in 0..tracks {
            let (a, e) = (track_bins[2 * t] as usize, track_bins[2 * t + 1] as usize);
            let mut sum = 0.0;
            for &v in &frame_acc[a..e] {
                let p = v * frame_scale;
                sum += if p > track_floor { p } else { track_floor };
            }
            sums[k * d.track_cap + t] = sum;
        }
    }
    mem.set_u32(ctl, C_PEND_COUNT, pend as u32);
    mem.set_u32(ctl, C_SHORT_SLOT, slot as u32);
    mem.set_u32(ctl, C_SHORT_FILL, fill as u32);
    mem.set_u32(ctl, C_CLIPPED, clipped);
    mem.set_u32(ctl, C_DB_CALLS, db_calls);
    mem.set_f64(ctl, F_SHORT_NEXT, short_next);
    status
}

#[cfg(target_arch = "wasm32")]
mod exports {
    use super::*;

    #[link(wasm_import_module = "env")]
    extern "C" {
        /// JS `shortOnInDb(i, a, was)`: 1 = on.
        fn short_db(i: u32, a: f64, was: u32) -> u32;
    }

    fn mem() -> Mem {
        Mem {
            base: 0,
            size: core::arch::wasm32::memory_size(0) * 65536,
        }
    }

    #[no_mangle]
    pub extern "C" fn fp_abi() -> u32 {
        ABI
    }

    #[no_mangle]
    pub extern "C" fn fp_ctl_bytes() -> u32 {
        CTL_BYTES as u32
    }

    #[no_mangle]
    pub extern "C" fn fp_init(ctl: u32) -> u32 {
        // SAFETY: the memory is this module's; `init` checks the layout first.
        unsafe { init(mem(), ctl as usize) }
    }

    /// Fault-isolation test hook: traps (`unreachable`), as a kernel bug would.
    #[no_mangle]
    pub extern "C" fn fp_trap() -> u32 {
        core::arch::wasm32::unreachable()
    }

    #[no_mangle]
    pub extern "C" fn fp_run(ctl: u32) -> u32 {
        let mut db = |i: u32, a: f64, was: bool| -> bool {
            // SAFETY: an imported JS function taking and returning plain numbers.
            unsafe { short_db(i, a, was as u32) != 0 }
        };
        // SAFETY: as fp_init.
        unsafe { run(mem(), ctl as usize, &mut db) }
    }
}

#[cfg(test)]
mod tests;
