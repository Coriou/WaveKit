import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	compileFrameWasm,
	FRAME_WASM_FILE,
	frameKernelLayout,
	framePathChoice,
	loadFrameWasm,
} from "../../../../src/core/spectrum/frame-wasm.js"
import type { FrameKernelDims } from "../../../../src/core/spectrum/frame-wasm.js"
import { FRAME_KERNEL_MAX_RESTARTS } from "../../../../src/core/spectrum/pipeline.js"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import type { Logger } from "../../../../src/utils/logger.js"
import {
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
	addInto,
} from "../../../mocks/scanner/signals.js"
import { frameWasm, WASM_LABEL } from "./frame-wasm-harness.js"
import { FS, Harness } from "./pipeline-harness.js"

const SIGMA = 0.005

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn()
	const logger = {
		warn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: () => logger,
	} as unknown as Logger
	return { logger, warn }
}

function scene(seconds: number): Uint8Array {
	const total = Math.round(seconds * FS)
	const iq = gaussianNoise(mulberry32(3), total, SIGMA)
	addInto(iq, tone(total, FS, 30_000, 0.01))
	return packCu8(iq.re, iq.im)
}

describe("frame path selection", () => {
	it("reads WAVEKIT_SPECTRUM_FRAME_PATH, anything unknown as auto", () => {
		expect(framePathChoice(undefined)).toBe("auto")
		expect(framePathChoice("js")).toBe("js")
		expect(framePathChoice("wasm")).toBe("wasm")
		expect(framePathChoice("JS")).toBe("auto")
	})

	it("a missing artefact, bytes that do not validate, or a module without the kernel's exports give a reason", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "wk-frame-wasm-"))
		try {
			const missing = loadFrameWasm(path.join(dir, FRAME_WASM_FILE))
			expect(missing).toEqual({
				ok: false,
				reason: `${FRAME_WASM_FILE} not found`,
			})
			const junk = path.join(dir, "junk.wasm")
			writeFileSync(junk, Uint8Array.from([1, 2, 3, 4]))
			const bad = loadFrameWasm(junk)
			expect(bad.ok).toBe(false)
			expect(!bad.ok && bad.reason).toMatch(/does not validate/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
		// the empty module validates and compiles, then fails at instantiation: the JS path, with why
		const empty = compileFrameWasm(
			Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]),
		)
		expect(empty.ok).toBe(true)
		const h = new Harness({}, { frameWasm: empty.ok ? empty.module : null })
		expect(h.pipeline.framePath.path).toBe("js")
		expect(h.pipeline.framePath.reason).toMatch(/exports|instantiate/)
	})

	it("without a kernel the pipeline runs the JS path and says why", () => {
		const h = new Harness({}, {})
		expect(h.pipeline.framePath).toEqual({
			path: "js",
			reason: "no kernel given",
		})
	})
})

describe("frame kernel memory", () => {
	/**
	 * 2.4 Msps, FFT 2048, no overlap, U8: 59 frames per block (round(50 ms · 2.4 Msps / 2048)), so 59
	 * pending slots and a 59-frame batch; T_short = round(5 ms · 2.4 Msps / 2048) = 6 frames; 511 tracks.
	 * Bytes: 10 f64 arrays of N (frame, block, raw, reference, short sum, four brackets, burst peak) and
	 * 2 twiddle tables of N = 12 · 16 KiB; cos/sin 2 · 8 KiB; window, re, im, rev 4 · 8 KiB; LUT 2 KiB;
	 * pending 59 · 16 KiB; ring 6 · 16 KiB; three u8 arrays of N 6 KiB; staging 59 · 4 KiB;
	 * starts 472 B, verdicts 59 B, track bins 4088 B, sums 59 · 511 · 8 = 241 192 B.
	 */
	const dims: FrameKernelDims = {
		format: "U8_IQ",
		fftSize: 2048,
		pendingCap: 59,
		shortFrames: 6,
		batchCap: 59,
		trackCap: 511,
	}
	const KIB = 1024
	const regions =
		12 * 16 * KIB +
		2 * 8 * KIB +
		4 * 8 * KIB +
		2 * KIB +
		59 * 16 * KIB +
		6 * 16 * KIB +
		6 * KIB +
		59 * 4 * KIB +
		472 +
		59 +
		4088 +
		241_192

	it("is the stated arithmetic: 256 KiB reserved, a 384-byte control block, the regions, 16-byte alignment", () => {
		const layout = frameKernelLayout(dims)
		const base = 4 * 65_536 + 384
		expect(layout.ctl).toBe(4 * 65_536)
		// 29 regions, each start rounded up to 16 bytes: at most 15 bytes of padding before each
		expect(layout.end - base).toBeGreaterThanOrEqual(regions)
		expect(layout.end - base).toBeLessThan(regions + 29 * 16)
		expect(layout.pages).toBe(Math.ceil(layout.end / 65_536))
		// 1 806 387 bytes of regions after 262 528 reserved and control: 32 pages, 2 MiB
		expect(regions).toBe(1_806_387)
		expect(layout.pages).toBe(32)
	})

	it("one more pending frame, batch frame or track adds exactly its region's share", () => {
		const base = frameKernelLayout(dims).end
		const grown = (over: Partial<FrameKernelDims>): number =>
			frameKernelLayout({ ...dims, ...over }).end - base
		expect(grown({ pendingCap: 60 })).toBe(8 * 2048)
		// staging 4096, start 8, verdict 1, sums 8 · 511; the 16-byte padding of the regions after the
		// first one that grew moves by under 16 bytes each (4 of them)
		const near = (got: number, share: number): void =>
			expect(Math.abs(got - share)).toBeLessThan(4 * 16)
		near(grown({ batchCap: 60 }), 4096 + 8 + 1 + 8 * 511)
		// track bins 8, sums 8 · 59
		near(grown({ trackCap: 512 }), 8 + 8 * 59)
	})
})

describe.skipIf(!frameWasm)(`frame kernel instance (${WASM_LABEL})`, () => {
	it("has a fixed memory: it cannot grow and stays one size whatever the chunks", () => {
		const h = new Harness(
			{ sampleRateHz: 2_400_000, fftSize: 2048 },
			{ frameWasm },
		)
		const k = h.pipeline.frameKernelForTest()
		expect(k).not.toBeNull()
		const bytes = k!.memoryBytes
		expect(bytes).toBe(k!.layout.pages * 65_536)
		expect(() => k!.memory.grow(1)).toThrow(RangeError)
		h.start()
		const iq = gaussianNoise(mulberry32(9), 2_400_000 / 4, SIGMA)
		const data = packCu8(iq.re, iq.im)
		for (const chunk of [1, 777, 4096, 131_072, 600_000]) {
			h.pushBytes(data.subarray(0, Math.min(data.length, chunk * 2 * 3)), chunk)
			expect(k!.memoryBytes).toBe(bytes)
		}
		expect(k!.memory.buffer.byteLength).toBe(bytes)
	})

	it("refuses a layout past 256 MiB and the pipeline runs JS, saying why", () => {
		// sums = 59 · (maxTracks − 1) · 8 bytes: 600 000 tracks need 283 MB
		const h = new Harness(
			{ sampleRateHz: 2_400_000, fftSize: 2048, maxTracks: 600_000 },
			{ frameWasm },
		)
		expect(h.pipeline.framePath.path).toBe("js")
		expect(h.pipeline.framePath.reason).toMatch(/exceeds/)
	})

	it("a trap restarts the kernel twice, then the worker keeps JS; nothing throws and one line per state", () => {
		const { logger, warn } = fakeLogger()
		const h = new Harness({}, { frameWasm, logger })
		h.start()
		const quarter = FS / 4 // samples
		const data = scene(3)
		const part = (q: number): Uint8Array =>
			data.subarray(q * quarter * 2, (q + 1) * quarter * 2)
		const summaries = (): number =>
			h.events.filter(e => e.kind === "block-summary").length
		h.pushBytes(part(0))
		const before = summaries()
		for (let fault = 1; fault <= FRAME_KERNEL_MAX_RESTARTS + 1; fault++) {
			h.pipeline.frameKernelForTest()!.trapNextRunForTest()
			expect(() => h.pushBytes(part(fault))).not.toThrow()
			if (fault <= FRAME_KERNEL_MAX_RESTARTS) {
				expect(h.pipeline.framePath.path).toBe("wasm")
				expect(h.pipeline.frameKernelForTest()!.restarts).toBe(fault)
			}
		}
		expect(h.pipeline.framePath.path).toBe("js")
		expect(h.pipeline.framePath.reason).toBe(
			`kernel fault (trap) after ${FRAME_KERNEL_MAX_RESTARTS} restarts`,
		)
		// the first fault and the switch to JS: two lines, with safe fields only
		expect(warn).toHaveBeenCalledTimes(2)
		expect(warn.mock.calls[0]![0]).toEqual({
			fault: "trap",
			restarts: 1,
			path: "wasm",
		})
		expect(warn.mock.calls[1]![0]).toEqual({
			fault: "trap",
			restarts: FRAME_KERNEL_MAX_RESTARTS,
			path: "js",
		})
		// blocks kept coming between faults, and the JS path carries on with the stream
		const mid = summaries()
		expect(mid).toBeGreaterThan(before)
		h.pushBytes(data.subarray(4 * quarter * 2))
		expect(summaries()).toBeGreaterThan(mid + 10)
	})

	it("a kernel error code is a fault like a trap", () => {
		const { logger, warn } = fakeLogger()
		const h = new Harness({}, { frameWasm, logger })
		h.start()
		h.pipeline.frameKernelForTest()!.failForTest(4)
		expect(() => h.pushBytes(scene(0.3))).not.toThrow()
		expect(warn.mock.calls[0]![0]).toMatchObject({ fault: "batch" })
	})

	it("pending frames: a first block of exactly its frames is fine; replayed samples past the cap fault, never throw", () => {
		// 50 frames per 50 ms block at 256 kS/s and N 256: the cap is 50 pending frames.
		const { logger, warn } = fakeLogger()
		const h = new Harness({}, { frameWasm, logger })
		h.start()
		const data = scene(0.2)
		h.pushBytes(data.subarray(0, 12_800 * 2))
		expect(warn).not.toHaveBeenCalled()
		// samples 0…40 ms again: the same block would hold 90 frames, 40 past the cap
		const h2 = new Harness({}, { frameWasm, logger })
		h2.start()
		h2.pushBytes(data.subarray(0, 10_240 * 2))
		h2.sample = 0
		expect(() => h2.pushBytes(data.subarray(0, 10_240 * 2))).not.toThrow()
		expect(warn.mock.calls[0]![0]).toMatchObject({ fault: "pending" })
		expect(h2.pipeline.framePath.path).toBe("wasm")
	})
})

describe("Tracker.frameBins", () => {
	it("writes every open track at the cap and refuses one past it", () => {
		const t = new Tracker({
			sourceId: "s1",
			binHz: 1000,
			blockMs: 50,
			hangBlocks: 3,
			maxTracks: 4,
			maxTrackBlocks: 100,
			idPrefix: "t",
		})
		const bins = new Uint32Array(8)
		expect(t.frameBins(bins, 0)).toBe(0)
		const open = (t as unknown as { open: unknown[] }).open
		for (let i = 0; i < 2; i++)
			open.push({ startBin: 10 * i, endBin: 10 * i + 4, frozen: null })
		expect(t.frameBins(bins, 2)).toBe(2)
		expect([...bins.subarray(0, 4)]).toEqual([0, 4, 10, 14])
		expect(t.frameBins(bins, 1)).toBe(-1)
	})
})
