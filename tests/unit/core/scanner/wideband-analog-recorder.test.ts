/**
 * WidebandAnalogRecorder against a fake engine ring and a fake analog operation: fast checks of
 * the file boundaries, the stand-down rules, the cap and the binding liveness.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_HOLDBACK_MS,
	WidebandAnalogRecorder,
	widebandRecordingCap,
	type WidebandEngineView,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type {
	AnalogCut,
	AnalogHandle,
	AnalogInput,
	AnalogReceipt,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { IqRing } from "../../../../src/core/spectrum/iq-ring.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { CTCSS_TEST_HZ, NfmSource } from "./wideband-nfm-fixtures.js"

const FS = 1_024_000
const CENTRE = 100_000_000
const OFFSET = 50_000

class FakeEngine implements WidebandEngineView {
	readonly format = "U8_IQ"
	epoch = {
		stream: 1,
		epoch: 1,
		startSample: 0 as number | null,
		centreHz: CENTRE,
		sampleRateHz: FS,
		tuningTrust: "commanded" as "commanded" | "relay" | "unverified",
	}
	private readonly ring = new IqRing({
		bytesPerSample: 2,
		capacitySamples: 3 * FS,
	})
	private readonly taps = new Set<(s: number, b: Uint8Array) => void>()
	currentEpoch() {
		return { ...this.epoch }
	}
	liveEdge(): number {
		return this.ring.newestSample
	}
	readRing(from: number, to: number) {
		return this.ring.read(from, to)
	}
	tap(listener: (s: number, b: Uint8Array) => void): () => void {
		this.taps.add(listener)
		return () => this.taps.delete(listener)
	}
	write(bytes: Uint8Array): void {
		const at = this.ring.newestSample
		this.ring.write(at, bytes)
		for (const t of this.taps) t(at, bytes)
	}
	get tapCount(): number {
		return this.taps.size
	}
}

interface FakeOp {
	input: AnalogInput
	frames: number
	cut: AnalogCut | null
	cancelled: AnalogCut | null
}

function fakeOps(opts: { refuse?: boolean } = {}) {
	const ops: FakeOp[] = []
	const begin = (input: AnalogInput): AnalogHandle => {
		const op: FakeOp = { input, frames: 0, cut: null, cancelled: null }
		ops.push(op)
		let settle!: (r: AnalogReceipt) => void
		const settled = new Promise<AnalogReceipt>(r => {
			settle = r
		})
		const receipt = (outcome: "finalized" | "aborted") =>
			({ outcome }) as unknown as AnalogReceipt
		const ready = opts.refuse
			? Promise.reject(new Error("storage-cap"))
			: Promise.resolve()
		ready.catch(() => settle(receipt("aborted")))
		return {
			operationId: `op-${ops.length}`,
			ready,
			settled,
			push: pcm => {
				op.frames += pcm.length
				return Promise.resolve()
			},
			addGap: () => undefined,
			finish: (cut = "completed") => {
				op.cut = cut
				const r = receipt("finalized")
				settle(r)
				return Promise.resolve(r)
			},
			cancel: (cut = "cancelled") => {
				op.cancelled = cut
				settle(receipt("aborted"))
			},
		}
	}
	return { ops, begin }
}

function harness(opts: { refuse?: boolean; budget?: number } = {}) {
	const engine = new FakeEngine()
	const { ops, begin } = fakeOps(opts)
	const queue: (() => void)[] = []
	const tones: { observationId: string; hz: number }[] = []
	const warnings: unknown[] = []
	const logger = pino({ level: "silent" })
	const rec = new WidebandAnalogRecorder({
		engine: () => engine,
		settings: () => ({
			preRollMs: 300,
			hangMs: 2000,
			cpuBudgetCores: opts.budget ?? 1,
		}),
		beginAnalog: begin,
		recordTone: (observationId, hz) => tones.push({ observationId, hz }),
		logger,
		now: () => 1_700_000_000_000,
		schedule: run => queue.push(run),
	})
	const origWarn = (rec as unknown as { warn(e: unknown): void }).warn.bind(rec)
	;(rec as unknown as { warn(e: unknown): void }).warn = e => {
		warnings.push(e)
		origWarn(e)
	}
	const src = new NfmSource({ fs: FS, offsetHz: OFFSET })
	const pump = async (): Promise<void> => {
		for (let i = 0; i < 1000 && queue.length > 0; i++) {
			queue.shift()!()
			await Promise.resolve()
			await Promise.resolve()
		}
	}
	/** Feeds seconds of IQ in 25 ms chunks, running the recorder in between. */
	const feed = async (
		seconds: number,
		on: boolean,
		each?: () => void,
	): Promise<void> => {
		const chunk = FS / 40
		for (let i = 0; i < Math.round((seconds * FS) / chunk); i++) {
			engine.write(src.next(chunk, on))
			each?.()
			await pump()
		}
	}
	return { engine, ops, rec, tones, warnings, feed, pump, src }
}

function snapshot(
	id: string,
	start: number,
	last: number,
	extra: Partial<TrackSnapshot> = {},
): TrackSnapshot {
	return {
		trackId: id,
		sourceId: "rtl",
		stream: 1,
		epoch: 1,
		startSample: start,
		lastSample: last,
		centreHz: CENTRE + OFFSET,
		obwHz: 11_000,
		obwMethod: "-20dB",
		peakDbfs: -20,
		meanDbfs: -25,
		snrDb: 30,
		floorDbfs: -60,
		thresholdDb: 10,
		blocks: 10,
		maxBlockSnrDb: 30,
		dutyCycle: 1,
		spectralShape: "peaked",
		flags: {
			overload: false,
			gap: false,
			truncated: false,
			edge: false,
			skirt: false,
			obwBiased: false,
			burst: false,
			iqImage: false,
			spur: false,
		},
		tuningTrust: "commanded",
		...extra,
	}
}

function input(
	observationId: string,
	track: TrackSnapshot,
	extra: Partial<WidebandTrackInput> = {},
): WidebandTrackInput {
	return {
		observationId,
		discoveryId: "d_1",
		sourceId: "rtl",
		track,
		analogFm: true,
		encrypted: false,
		recordAllowed: true,
		channelOwned: false,
		...extra,
	}
}

/** One transmission [onset, onset + seconds), reported 100 ms late, closed 600 ms late. */
async function transmission(
	h: ReturnType<typeof harness>,
	id: string,
	seconds: number,
	extra: Partial<WidebandTrackInput> = {},
): Promise<void> {
	const onset = h.engine.liveEdge()
	const end = onset + seconds * FS
	await h.feed(seconds, true, () => {
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * FS)
			h.rec.track(input(id, snapshot(id, onset, Math.min(edge, end)), extra))
	})
	await h.feed(0.6, false)
	h.rec.closed(id, snapshot(id, onset, end), null)
}

describe("WidebandAnalogRecorder", () => {
	it("writes one file of pre-roll + transmission + hang and reports the CTCSS tone", async () => {
		const h = harness()
		await h.feed(1, false)
		await transmission(h, "o1", 2)
		await h.feed(3, false)
		expect(h.warnings).toEqual([])
		expect(h.ops).toHaveLength(1)
		const op = h.ops[0]!
		expect(op.cut).toBe("completed")
		expect(Math.abs(op.frames - 8 * (300 + 2000 + 2000))).toBeLessThanOrEqual(
			8 * 30,
		)
		expect(op.input.binding).toMatchObject({
			sourceId: "rtl",
			stream: 1,
			epoch: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48_000,
			targetHz: CENTRE + OFFSET,
			captureCentreHz: CENTRE,
			tuningTrust: "commanded",
		})
		expect(h.tones).toEqual([{ observationId: "o1", hz: CTCSS_TEST_HZ }])
		expect(h.engine.tapCount).toBe(0)
		// The binding is no longer live once its operation settled.
		expect(h.rec.bindingLive(op.input.binding)).toBe(false)
	}, 60_000)

	it("a follow-up transmission inside the hang joins the same file; one past it does not", async () => {
		const h = harness()
		await h.feed(0.5, false)
		await transmission(h, "a", 1)
		await h.feed(0.5, false) // gap 0.6 + 0.5 = 1.1 s < 2 s hang
		await transmission(h, "b", 1)
		await h.feed(3, false) // gap ≥ hang: the file ends
		await transmission(h, "c", 1)
		await h.feed(3, false)
		expect(h.ops).toHaveLength(2)
		expect(h.ops[0]!.input.observationId).toBe("a")
		expect(h.ops[1]!.input.observationId).toBe("c")
		// a (1 s) + gap 1.1 s + b (1 s) + pre-roll + hang.
		expect(
			Math.abs(h.ops[0]!.frames - 8 * (300 + 3100 + 2000)),
		).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("stands down for a job opt-out, the channel tier, encryption and unclean tracks", async () => {
		for (const extra of [
			{ recordAllowed: false },
			{ channelOwned: true },
			{ encrypted: true },
			{ analogFm: false },
			{ discoveryId: null },
		] satisfies Partial<WidebandTrackInput>[]) {
			const h = harness()
			await h.feed(0.5, false)
			await transmission(h, "x", 1, extra)
			await h.feed(3, false)
			expect(h.ops).toEqual([])
		}
		for (const flag of ["spur", "edge", "truncated", "iqImage"] as const) {
			const h = harness()
			const t = snapshot("y", 0, 10)
			t.flags[flag] = true
			h.rec.track(input("y", t))
			expect(h.ops).toEqual([])
		}
		const h = harness()
		h.rec.track(input("z", snapshot("z", 0, 10, { obwHz: 16_001 })))
		h.rec.track(input("w", snapshot("w", 0, 10, { tuningTrust: "unverified" })))
		expect(h.ops).toEqual([])
		h.rec.track(input("v", snapshot("v", 0, 10, { obwHz: 16_000 })))
		expect(h.ops).toHaveLength(1)
	}, 60_000)

	it("cancels the file when the owner turns edge or spur", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("o", snapshot("o", onset, onset + 10)))
		await h.feed(0.5, true)
		const bad = snapshot("o", onset, h.engine.liveEdge())
		bad.flags.edge = true
		h.rec.track(input("o", bad))
		await h.pump()
		expect(h.ops[0]!.cancelled).toBe("cancelled")
		expect(h.rec.owns("o")).toBe(false)
	})

	it("drops a refused admission and does not retry that observation", async () => {
		const h = harness({ refuse: true })
		await h.feed(0.5, false)
		await transmission(h, "r", 1)
		await h.feed(3, false)
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.frames).toBe(0)
		expect(h.ops[0]!.cut).toBeNull()
	}, 60_000)

	it("ends the file at a retune with an epoch-changed cut", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("e", snapshot("e", onset, onset + 10)))
		await h.feed(1, true)
		const retune = h.engine.liveEdge()
		h.engine.epoch = { ...h.engine.epoch, epoch: 2, startSample: retune }
		await h.feed(0.5, false)
		expect(h.ops[0]!.cut).toBe("epoch-changed")
		// Pre-roll + 1 s, nothing of the new epoch.
		expect(Math.abs(h.ops[0]!.frames - 8 * 1300)).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("a sweep hop after the hang keeps the whole file as completed", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const end = onset + FS
		await h.feed(1, true, () =>
			h.rec.track(input("p", snapshot("p", onset, h.engine.liveEdge()))),
		)
		await h.feed(0.6, false)
		h.rec.closed("p", snapshot("p", onset, end), "epoch-changed")
		await h.feed(1.6, false)
		h.engine.epoch = {
			...h.engine.epoch,
			epoch: 2,
			startSample: h.engine.liveEdge(),
		}
		await h.feed(0.5, false)
		expect(h.ops[0]!.cut).toBe("completed")
		expect(
			Math.abs(h.ops[0]!.frames - 8 * (300 + 1000 + 2000)),
		).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("a job end cuts the file at the track's last sample", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const end = onset + FS
		await h.feed(1, true, () =>
			h.rec.track(input("j", snapshot("j", onset, h.engine.liveEdge()))),
		)
		await h.feed(0.6, false)
		h.rec.closed("j", snapshot("j", onset, end), "track-ended")
		await h.feed(0.5, false)
		expect(h.ops[0]!.cut).toBe("track-ended")
		expect(Math.abs(h.ops[0]!.frames - 8 * 1300)).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("caps concurrent recordings per source by the CPU budget, at least 1 and at most 2", () => {
		expect(widebandRecordingCap(1_024_000, 1)).toBe(2)
		expect(widebandRecordingCap(2_400_000, 1)).toBe(2)
		// floor(25 / 59.2) = 0 → 1; floor(0.25 · 0.24 · 1000 / 59.2) = 1.
		expect(widebandRecordingCap(1_024_000, 0.1)).toBe(1)
		expect(widebandRecordingCap(1_024_000, 0.48)).toBe(2)
		expect(widebandRecordingCap(1_024_000, 0.47)).toBe(1)
		const h = harness()
		for (let i = 0; i < 3; i++)
			h.rec.track(
				input(
					`c${i}`,
					snapshot(`c${i}`, 0, 10, { centreHz: CENTRE + 20_000 * i }),
				),
			)
		expect(h.ops).toHaveLength(2)
	})

	it("holds back writes for WIDEBAND_HOLDBACK_MS while the track is open", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(2, true, () =>
			h.rec.track(input("h", snapshot("h", onset, h.engine.liveEdge()))),
		)
		// Written: from onset − 300 ms to the edge − holdback.
		const expected = 8 * (300 + 2000 - WIDEBAND_HOLDBACK_MS)
		expect(Math.abs(h.ops[0]!.frames - expected)).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("finishes an open file as a shutdown cut on stop", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("s", snapshot("s", onset, onset + 10)))
		await h.feed(1, true)
		await h.rec.stop()
		expect(h.ops[0]!.cut).toBe("shutdown")
		expect(h.ops[0]!.frames).toBeGreaterThan(8 * 1000)
	})
})
