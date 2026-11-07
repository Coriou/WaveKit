//! Spike, not production: the wasm32 build of the frame path, with the boundary a worker would use.
//! One call per chunk on bytes the host copied into linear memory; each finished block comes back as
//! flat arrays the host copies out. No wasm-bindgen: plain exports, plain numbers.

#![allow(clippy::missing_safety_doc)]

#[path = "../../frame_path/fp.rs"]
#[allow(dead_code)]
mod fp;

use std::cell::UnsafeCell;

use fp::{Params, Prec, Stream};

enum Any {
    F32(Stream<f32>),
    F64(Stream<f64>),
}

macro_rules! both {
    ($s:expr, $v:ident => $e:expr) => {
        match $s {
            Any::F32($v) => $e,
            Any::F64($v) => $e,
        }
    };
}

struct State {
    stream: Any,
    input: Vec<u8>,
    frame: Vec<u8>,
    table: [u32; 9],
}

struct Holder(UnsafeCell<Option<State>>);
// SAFETY: wasm32-unknown-unknown without threads has one thread.
unsafe impl Sync for Holder {}
static STATE: Holder = Holder(UnsafeCell::new(None));

fn state() -> &'static mut State {
    // SAFETY: one thread, and no export keeps this reference past its return.
    unsafe { (*STATE.0.get()).as_mut().expect("fp_new first") }
}

#[no_mangle]
pub extern "C" fn fp_new(
    prec: u32,
    rate: f64,
    half_overlap: u32,
    tracks: u32,
    track_bins: u32,
    chunk_bytes: u32,
) {
    let params = Params::new(
        rate,
        half_overlap != 0,
        tracks as usize,
        track_bins as usize,
    );
    let stream = if prec == 32 {
        Any::F32(Stream::<f32>::new(params))
    } else {
        Any::F64(Stream::<f64>::new(params))
    };
    let state = State {
        stream,
        input: vec![0; chunk_bytes as usize],
        frame: vec![0; params.n * 2],
        table: [0; 9],
    };
    // SAFETY: one thread; nothing else holds the state.
    unsafe { *STATE.0.get() = Some(state) };
}

#[no_mangle]
pub extern "C" fn fp_input() -> *mut u8 {
    state().input.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn fp_frame_input() -> *mut u8 {
    state().frame.as_mut_ptr()
}

/// One chunk of `len` bytes already in `fp_input`. Returns how many blocks finished.
#[no_mangle]
pub extern "C" fn fp_chunk(len: u32, staged: u32) -> u32 {
    let s = state();
    let chunk = &s.input[..len as usize];
    both!(&mut s.stream, v => {
        v.push(chunk, staged != 0);
        v.blocks().len() as u32
    })
}

fn table_of(out: &fp::BlockOut, env_capacity: usize) -> [u32; 9] {
    [
        out.acc.as_ptr() as u32,
        out.floor_db.as_ptr() as u32,
        out.peak_db.as_ptr() as u32,
        out.count.as_ptr() as u32,
        out.env.as_ptr() as u32,
        env_capacity as u32,
        out.frames,
        out.integrated,
        out.clipped,
    ]
}

/// A pointer to 9 u32: acc f64*, floor f32*, peak f64*, count u8*, env f64*, env capacity, frames,
/// integrated, clipped. Valid until the next chunk.
#[no_mangle]
pub extern "C" fn fp_block(index: u32) -> *const u32 {
    let s = state();
    let table = both!(&s.stream, v => table_of(&v.blocks()[index as usize], v.env_capacity()));
    s.table = table;
    s.table.as_ptr()
}

/// Raw stage time in ns: 0 scan, 1 convert, 2 fft, 3 power, 4 short, 5 tracks, 6 finish.
#[no_mangle]
pub extern "C" fn fp_stage(i: u32) -> f64 {
    let st = both!(&state().stream, v => v.stages());
    let ns = [
        st.scan, st.convert, st.fft, st.power, st.short, st.tracks, st.finish,
    ];
    ns[i as usize] as f64
}

/// 0 chunks, 1 frames offered, 2 blocks, 3 blanked, 4 straddled, 5 short restarts.
#[no_mangle]
pub extern "C" fn fp_counter(i: u32) -> f64 {
    let c = both!(&state().stream, v => v.counters());
    let n = [
        c.chunks,
        c.offered,
        c.blocks,
        c.blanked,
        c.straddled,
        c.short_restarts,
    ];
    n[i as usize] as f64
}

#[no_mangle]
pub extern "C" fn fp_reset_stats() {
    both!(&mut state().stream, v => v.reset_stats());
}

#[no_mangle]
pub extern "C" fn fp_clock_read_ns(reads: u32) -> f64 {
    fp::clock_read_ns(reads)
}

/// Shifted |X|² of the frame in `fp_frame_input`, for the JS comparison. N f64 values.
#[no_mangle]
pub extern "C" fn fp_frame_power() -> *const f64 {
    let s = state();
    let frame = &s.frame;
    both!(&mut s.stream, v => power_of(v, frame))
}

fn power_of<T: Prec>(v: &mut Stream<T>, frame: &[u8]) -> *const f64 {
    v.frame_power(frame).as_ptr()
}
