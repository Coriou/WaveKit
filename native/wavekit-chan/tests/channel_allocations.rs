//! PERFORMANCE rule 4: an IQ channel does not allocate per block once warm. Its own binary, because
//! it installs a counting allocator.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use wavekit_chan::channel::{ChannelDsp, ChannelSpec, Format};

struct Counting;

thread_local! {
    /// This thread only: the test harness's own threads may allocate at any time.
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

fn count() {
    let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
}

// SAFETY: every call forwards to `System` with the same arguments; counting does not allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[test]
fn a_warm_channel_does_not_allocate_per_block() {
    for (format, block) in [(Format::Cu8, 16_384usize), (Format::Cf32, 2_048)] {
        let mut dsp = ChannelDsp::new(ChannelSpec {
            input_rate: 2_048_000,
            offset_hz: 100_000.0,
            bandwidth_hz: 12_500.0,
            transition_hz: 5_000.0,
            output_rate: 48_000,
            format,
            gain: 1.0,
        })
        .unwrap();
        let i: Vec<f32> = (0..block).map(|n| (n as f32 * 0.1).sin()).collect();
        let q: Vec<f32> = (0..block).map(|n| (n as f32 * 0.1).cos()).collect();
        let mut out = Vec::new();
        // Warm up long enough for the A12 schedule's surplus to have reached its largest.
        for _ in 0..64 {
            out.clear();
            dsp.process(&i, &q, &mut out);
        }
        let before = ALLOCATIONS.with(Cell::get);
        for _ in 0..1000 {
            out.clear();
            dsp.process(&i, &q, &mut out);
        }
        let allocated = ALLOCATIONS.with(Cell::get) - before;
        assert_eq!(allocated, 0, "{} blocks of {block}", format.as_str());
    }
}

// Requests whose longest stage has at least 185 taps per phase, so they take the two-output kernel.
#[test]
fn a_warm_wide_channel_does_not_allocate_per_block() {
    // (input rate, bandwidth, transition, output rate)
    let requests = [
        (1_024_000u64, 300_000.0, 5_000.0, 512_000u64),
        (1_024_000, 300_000.0, 12_800.0, 512_000),
        (1_024_000, 364_800.0, 9_600.0, 384_000),
        (2_400_000, 950_000.0, 25_000.0, 1_000_000),
        (2_400_000, 300_000.0, 26_250.0, 1_050_000),
        (2_400_000, 364_800.0, 9_600.0, 384_000),
    ];
    for (input_rate, bandwidth_hz, transition_hz, output_rate) in requests {
        for block in [16_384usize, 4_099, 2_048] {
            let mut dsp = ChannelDsp::new(ChannelSpec {
                input_rate,
                offset_hz: 10_000.0,
                bandwidth_hz,
                transition_hz,
                output_rate,
                format: Format::Cf32,
                gain: 1.0,
            })
            .unwrap();
            let i: Vec<f32> = (0..block).map(|n| (n as f32 * 0.1).sin()).collect();
            let q: Vec<f32> = (0..block).map(|n| (n as f32 * 0.1).cos()).collect();
            let mut out = Vec::new();
            for _ in 0..64 {
                out.clear();
                dsp.process(&i, &q, &mut out);
            }
            let before = ALLOCATIONS.with(Cell::get);
            for _ in 0..1000 {
                out.clear();
                dsp.process(&i, &q, &mut out);
            }
            let allocated = ALLOCATIONS.with(Cell::get) - before;
            assert_eq!(
                allocated, 0,
                "{output_rate} from {input_rate}, blocks of {block}"
            );
        }
    }
}
