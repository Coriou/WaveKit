import { readFileSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	CHANNEL_GATE_MIN_DURATION_MS,
	type ChannelPlan,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { createChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import type { GateTrace } from "../../../../src/core/spectrum/emissions/tracker.js"
import { SpectrumPipeline } from "../../../../src/core/spectrum/pipeline.js"
import type {
	EngineState,
	PipelineEvent,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import type { WorkerPipelineInput } from "../../../../src/core/spectrum/worker-protocol.js"
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	packF32,
	sigmaForSnr,
	tone,
	type Rng,
} from "../../../mocks/scanner/signals.js"
import {
	BLOCK,
	CENTRE,
	FS,
	Harness,
	N,
	pipelineConfig,
	yieldToRpc,
} from "./pipeline-harness.js"

const HALF = (N / 2) * (FS / N)
const WIDTH = 12_500

/** The pre-change track stream. Recorded once from the base pipeline, then compared. */
function noPlanTracks(): unknown[] {
	const h = new Harness()
	h.start()
	const rng = mulberry32(20261018)
	const noise = (n: number) => gaussianNoise(rng, n, 0.05)
	const withTone = (n: number) => addInto(noise(n), tone(n, FS, 20_000, 0.3))
	h.push(noise(2 * BLOCK))
	h.push(withTone(8 * BLOCK))
	h.push(noise(16 * BLOCK))
	return h.events.filter(
		e =>
			e.kind === "track-open" ||
			e.kind === "track-update" ||
			e.kind === "track-close",
	)
}

/** One raster slot centred on `centreHz`, covering the tuned window. */
function planAt(centreHz: number, widthHz = WIDTH): ChannelPlan {
	return {
		sourceId: "s1",
		defaultWidthHz: WIDTH,
		entries: [
			{
				startHz: CENTRE - HALF,
				endHz: CENTRE + HALF,
				widthHz,
				rasterHz: HALF * 2,
				firstChannelHz: centreHz,
				burst: false,
				rangeKey: "nfm",
			},
		],
	}
}

function trackEvents(events: PipelineEvent[]): PipelineEvent[] {
	return events.filter(
		e =>
			e.kind === "track-open" ||
			e.kind === "track-update" ||
			e.kind === "track-close",
	)
}

const BLOCK_MS = 50
const STRONG_AMP = 0.2
const STRONG_SNR_DB = 18
const WEAK_SNR_DB = 2.6
const TONE_SIGMA = sigmaForSnr(
	STRONG_AMP * STRONG_AMP,
	STRONG_SNR_DB,
	FS,
	WIDTH,
)
const WEAK_AMP = STRONG_AMP * 10 ** ((WEAK_SNR_DB - STRONG_SNR_DB) / 20)
const BENCH_N = 2048
const BENCH_FS = 2_048_000
const BENCH_BLOCK = 50 * BENCH_N

function noiseIq(rng: Rng, n: number) {
	return gaussianNoise(rng, n, TONE_SIGMA)
}

function toneIq(rng: Rng, n: number, offsetHz: number, amp: number) {
	return addInto(noiseIq(rng, n), tone(n, FS, offsetHz, amp))
}

function nearHz(centreHz: number, offsetHz: number): boolean {
	return Math.abs(centreHz - (CENTRE + offsetHz)) <= 1_500
}

/** Warm the floor, then leave the caller to push the tone. One 12.5 kHz slot at +20 kHz. */
function armed(
	seed: number,
	trackHangMs?: number,
): {
	h: Harness
	rng: Rng
} {
	const h = new Harness(trackHangMs === undefined ? {} : { trackHangMs })
	h.start()
	h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
	const rng = mulberry32(seed)
	h.push(noiseIq(rng, 12 * BLOCK))
	return { h, rng }
}

function assertOwned(
	tracks: TrackSnapshot[],
	detail: string,
	blockSamples = BLOCK,
): void {
	for (const track of tracks) {
		if (track.gate !== "passed") continue
		const sample = track.gatePassedSample
		expect(typeof sample, detail).toBe("number")
		if (typeof sample !== "number") continue
		expect(sample, detail).toBeGreaterThanOrEqual(track.startSample)
		// A pass can land on the one tolerated off, one block after the last
		// observation, when the track then closes without being seen again.
		expect(sample, detail).toBeLessThanOrEqual(track.lastSample + blockSamples)
		expect(track.blocks * BLOCK_MS, detail).toBeGreaterThanOrEqual(
			CHANNEL_GATE_MIN_DURATION_MS - BLOCK_MS,
		)
	}
}

interface GateProfile {
	blocks: number
	busyMs: number
	gate: number
}

function gateProfile(pipeline: SpectrumPipeline): GateProfile {
	const state = pipeline.exportEngineState()
	if (!Object.hasOwn(state, "profile"))
		throw new Error("profile missing from export")
	const profile = (
		state as EngineState & {
			profile: {
				blocks: number
				busyMs: number
				stages: { gate: number }
			}
		}
	).profile
	return {
		blocks: profile.blocks,
		busyMs: profile.busyMs,
		gate: profile.stages.gate,
	}
}

function assertFiniteChannelSnr(events: PipelineEvent[]): void {
	for (const e of events) {
		if (
			e.kind !== "track-open" &&
			e.kind !== "track-update" &&
			e.kind !== "track-close"
		)
			continue
		if ("channelSnrDb" in e.track)
			expect(Number.isFinite(e.track.channelSnrDb)).toBe(true)
	}
}

describe("pipeline channel gate", () => {
	it("matches the no-plan track golden with no gate fields (R 2.4)", () => {
		const golden = JSON.parse(
			readFileSync(
				new URL("./fixtures/pipeline-tracks-no-plan.json", import.meta.url),
				"utf8",
			),
		) as unknown
		expect(noPlanTracks()).toEqual(golden)
	})

	it("passes a 7 dB NFM signal held for 400 ms and stays passed after the run ends", () => {
		const h = new Harness()
		h.start()
		const signalHz = CENTRE + 20_000
		h.send({ kind: "channel-plan", plan: planAt(signalHz) })
		const amp = 0.2
		const sigma = sigmaForSnr(amp * amp, 7, FS, WIDTH)
		const rng = mulberry32(20261019)
		const noise = (n: number) => gaussianNoise(rng, n, sigma)
		h.push(noise(20 * BLOCK))
		h.push(
			addInto(
				noise(8 * BLOCK),
				analogFm(rng, 8 * BLOCK, FS, 20_000, amp, {
					ctcssHz: null,
					rmsDeviationHz: 2500,
				}),
			),
		)
		h.push(noise(16 * BLOCK))
		const tracks = trackEvents(h.events)
		assertFiniteChannelSnr(tracks)
		const passed = tracks.find(
			e => e.kind === "track-update" && e.track.gate === "passed",
		)
		expect(passed?.kind).toBe("track-update")
		if (passed?.kind !== "track-update") return
		expect(Number.isFinite(passed.track.gatePassedSample)).toBe(true)
		const close = tracks.find(
			e => e.kind === "track-close" && e.track.trackId === passed.track.trackId,
		)
		expect(close?.kind).toBe("track-close")
		if (close?.kind !== "track-close") return
		expect(close.track.gate).toBe("passed")
		expect(close.track.gatePassedSample).toBe(passed.track.gatePassedSample)
	})

	it("closes a 2-block 3.5 dB blip below, never passed", () => {
		const h = new Harness()
		h.start()
		const signalHz = CENTRE + 20_000
		h.send({ kind: "channel-plan", plan: planAt(signalHz) })
		const amp = 0.2
		const sigma = sigmaForSnr(amp * amp, 3.5, FS, WIDTH)
		const rng = mulberry32(20261020)
		const noise = (n: number) => gaussianNoise(rng, n, sigma)
		h.push(noise(20 * BLOCK))
		h.push(addInto(noise(2 * BLOCK), tone(2 * BLOCK, FS, 20_000, amp)))
		h.push(noise(16 * BLOCK))
		const tracks = trackEvents(h.events)
		assertFiniteChannelSnr(tracks)
		expect(
			tracks.some(
				e =>
					(e.kind === "track-open" ||
						e.kind === "track-update" ||
						e.kind === "track-close") &&
					e.track.gate === "passed",
			),
		).toBe(false)
		const close = tracks.find(e => e.kind === "track-close")
		expect(close?.kind).toBe("track-close")
		if (close?.kind !== "track-close") return
		expect(close.track.gate).toBe("below")
	})

	it("never passes a spur-masked channel", () => {
		const h = new Harness()
		const toneHz = CENTRE + 30_000
		// Bins 152–157 and 159–164 of the 13-bin slot; bin 158 (the tone) stays open.
		h.start({
			exclusions: [
				{ startHz: CENTRE + 24_000, endHz: CENTRE + 29_999 },
				{ startHz: CENTRE + 31_000, endHz: CENTRE + 36_999 },
			],
		})
		h.send({ kind: "channel-plan", plan: planAt(toneHz) })
		const rng = mulberry32(20261021)
		const noise = (n: number) => gaussianNoise(rng, n, 0.05)
		h.push(noise(8 * BLOCK))
		h.push(addInto(noise(12 * BLOCK), tone(12 * BLOCK, FS, 30_000, 0.3)))
		h.push(noise(16 * BLOCK))
		const tracks = trackEvents(h.events)
		assertFiniteChannelSnr(tracks)
		expect(tracks.length).toBeGreaterThan(0)
		expect(
			tracks.some(
				e =>
					(e.kind === "track-open" ||
						e.kind === "track-update" ||
						e.kind === "track-close") &&
					e.track.gate === "passed",
			),
		).toBe(false)
		const close = tracks.find(e => e.kind === "track-close")
		expect(close?.kind).toBe("track-close")
		if (close?.kind !== "track-close") return
		expect(close.track.gate).toBe("below")
		expect("channelSnrDb" in close.track).toBe(false)
	})

	it("passes a tone held across 300 ms in its own slot", () => {
		const { h, rng } = armed(20261022)
		h.push(toneIq(rng, 6 * BLOCK, 20_000, STRONG_AMP))
		// The block that reaches the end of the push finalizes on the next frame.
		h.push(noiseIq(rng, BLOCK))
		const passed = h.tracks().filter(t => t.gate === "passed")
		expect(passed.length).toBeGreaterThan(0)
		expect(passed.every(t => nearHz(t.centreHz, 20_000))).toBe(true)
		assertOwned(h.tracks(), "continuous")
	})

	it("does not let a new weak tone inherit an earlier pass in the same slot", () => {
		const { h, rng } = armed(20261023)
		h.push(toneIq(rng, 8 * BLOCK, 20_000, STRONG_AMP))
		h.push(toneIq(rng, 4 * BLOCK, 24_000, WEAK_AMP))
		const opens = h
			.of("track-open")
			.map(e => Math.round(e.track.centreHz - CENTRE))
		const weak = h
			.of("track-open")
			.filter(e => nearHz(e.track.centreHz, 24_000))
		expect(weak.length, `opens at ${opens.join(",")}`).toBeGreaterThan(0)
		for (const e of weak) {
			expect(e.track.blocks).toBe(1)
			expect(e.track.gate).not.toBe("passed")
			expect("gatePassedSample" in e.track).toBe(false)
			expect(e.track.channelSnrDb).toBeLessThan(6)
		}
		const weakIds = new Set(weak.map(e => e.track.trackId))
		expect(
			h.tracks().some(t => weakIds.has(t.trackId) && t.gate === "passed"),
		).toBe(false)
		expect(
			h.tracks().some(t => nearHz(t.centreHz, 20_000) && t.gate === "passed"),
		).toBe(true)
		assertOwned(h.tracks(), "strong-then-weak")
	})

	it("a 1 s gap resets the run so two 150 ms bursts do not combine", () => {
		// Hang longer than the 1 s gap, so one track stays open across it.
		const { h, rng } = armed(20261024, 1_100)
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		h.gap(FS)
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 24 * BLOCK))
		const toneTracks = h.tracks().filter(t => nearHz(t.centreHz, 20_000))
		expect(toneTracks.some(t => t.blocks >= 6)).toBe(true)
		expect(toneTracks.some(t => t.gate === "passed")).toBe(false)
		assertOwned(h.tracks(), "gap")
	})

	it("a skipped block resets the run so two 150 ms bursts do not combine", () => {
		const { h, rng } = armed(20261025)
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		h.sample += BLOCK
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 12 * BLOCK))
		const toneTracks = h.tracks().filter(t => nearHz(t.centreHz, 20_000))
		expect(toneTracks.some(t => t.blocks >= 6)).toBe(true)
		expect(toneTracks.some(t => t.gate === "passed")).toBe(false)
		assertOwned(h.tracks(), "skip")
	})

	it("an epoch change starts a new run that passes on its own 300 ms", () => {
		const { h, rng } = armed(20261026)
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		h.pending({
			centreHz: CENTRE,
			centreChanged: false,
			gainKey: "m:400",
		})
		h.push(toneIq(rng, 10 * BLOCK, 20_000, STRONG_AMP))
		const passed = h
			.tracks()
			.filter(
				t => t.epoch === 2 && t.gate === "passed" && nearHz(t.centreHz, 20_000),
			)
		expect(passed.length).toBeGreaterThan(0)
		for (const track of passed) {
			expect(track.gatePassedSample).toBeGreaterThanOrEqual(
				track.startSample + 5 * BLOCK,
			)
		}
		expect(h.tracks().some(t => t.epoch === 1 && t.gate === "passed")).toBe(
			false,
		)
		assertOwned(h.tracks(), "epoch")
	})

	// Feature: scanner-redesign, Property 1: Noise never passes the gate
	// Validates: Requirements 2.2, 2.3, 2.4
	it("a passed track's sample and duration belong to its own emission", async () => {
		// Keep 1 kHz bins and 50 ms blocks with one quarter of the IQ work.
		const BLOCK = 3_200
		const propertyFs = FS / 4
		const noiseIq = (rng: Rng, n: number) =>
			gaussianNoise(rng, n, TONE_SIGMA / 2)
		const toneIq = (rng: Rng, n: number, offset: number, amp: number) =>
			addInto(noiseIq(rng, n), tone(n, propertyFs, offset, amp))
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.boolean(),
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 200, max: 300 }),
				async (
					seed,
					strongAtLow,
					strongBlocks,
					weakBlocks,
					gapBlocks,
					hangMs,
				) => {
					const strongOffset = strongAtLow ? 20_000 : 24_000
					const weakOffset = strongAtLow ? 24_000 : 20_000
					const h = new Harness({
						sampleRateHz: propertyFs,
						fftSize: 64,
						trackHangMs: hangMs,
					})
					h.start()
					h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
					const rng = mulberry32(seed)
					h.push(noiseIq(rng, 6 * BLOCK))
					h.push(toneIq(rng, strongBlocks * BLOCK, strongOffset, STRONG_AMP))
					if (gapBlocks > 0) h.gap(gapBlocks * BLOCK)
					h.push(toneIq(rng, weakBlocks * BLOCK, weakOffset, WEAK_AMP))
					const hangBlocks = Math.max(1, Math.round(hangMs / BLOCK_MS))
					h.push(noiseIq(rng, (hangBlocks + 2) * BLOCK))
					const detail = `seed=${seed} strongAtLow=${strongAtLow} strong=${strongBlocks} weak=${weakBlocks} gap=${gapBlocks} hang=${hangMs}`
					assertOwned(h.tracks(), detail, BLOCK)
					await yieldToRpc()
				},
			),
			// Regression: a 2-block strong burst then a 3-block weak one in the same slot
			// passed the weak track on a run it joined one block late (200 ms of its own).
			{ numRuns: 100, examples: [[1, false, 2, 3, 0, 200]] },
		)
	}, 120_000)

	it("keeps raised channel CFAR across pipeline retune and gain epochs", () => {
		let now = 0
		const h = new Harness({ shortIntegrationMs: null }, { now: () => now })
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		const rng = mulberry32(20261020)
		h.push(noiseIq(rng, 8 * BLOCK))
		const k = (): number => {
			const gate = (
				h.pipeline as unknown as {
					gate: ReturnType<typeof createChannelGate>
				}
			).gate
			return gate.kFor("nfm")
		}
		const initial = k()
		// Short strong runs end unpassed. Inject six observed minutes without
		// processing minutes of IQ; the pipeline still owns every measurement.
		for (let minute = 0; minute < 7; minute++) {
			h.push(toneIq(rng, BLOCK, 20_000, STRONG_AMP))
			h.push(noiseIq(rng, 3 * BLOCK))
			now += 60_000
			h.push(noiseIq(rng, BLOCK))
		}
		const raised = k()
		expect(raised).toBeGreaterThan(initial)
		for (const change of [
			{ centreHz: CENTRE + 1_000_000 },
			{ centreHz: CENTRE },
			{ centreHz: CENTRE, centreChanged: false, gainKey: "m:400" },
		]) {
			h.pending(change)
			h.push(noiseIq(rng, 2 * BLOCK))
			expect(k()).toBe(raised)
		}
	})

	it("charges the linear-power copy to the gate stage", () => {
		let t = 0
		const step = 10
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
				profile: { sampleEvery: 1 },
				profileNow: () => {
					t += step
					return t
				},
			},
		)
		const send = (input: WorkerPipelineInput): void => {
			pipeline.handle(input)
		}
		send({
			kind: "masks",
			exclusions: [],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
		})
		send({ kind: "spectrum-feed", enabled: true })
		send({
			kind: "new-stream",
			stream: 1,
			centreHz: CENTRE,
			sampleRateHz: FS,
			gainKey: "m:496",
			tuningTrust: "commanded",
		})
		const rng = mulberry32(20261027)
		const push = (start: number): void => {
			const iq = gaussianNoise(rng, BLOCK, 0.05)
			send({
				kind: "bytes",
				startSample: start,
				bytes: packF32(iq.re, iq.im),
			})
		}
		push(0)
		expect(gateProfile(pipeline).gate).toBe(0)
		send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		push(BLOCK)
		// The copy and blockLinear/publish are one clock step each.
		expect(gateProfile(pipeline).gate).toBe(2 * step)
	})

	it("does not let an excluded block complete a pass", () => {
		const { h, rng } = armedGate(20261047)
		// Five blocks finalize during this push; the sixth finalizes on the
		// next one, after the channel is excluded.
		h.push(toneIq(rng, 6 * BLOCK, 20_000, STRONG_AMP))
		h.send({
			kind: "masks",
			exclusions: [{ startHz: CENTRE + 10_000, endHz: CENTRE + 30_000 }],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
		})
		h.push(toneIq(rng, 16 * BLOCK, 20_000, STRONG_AMP))
		const tone = h.tracks().filter(t => nearHz(t.centreHz, 20_000))
		expect(tone.length).toBeGreaterThan(0)
		expect(tone.some(t => t.gate === "passed")).toBe(false)
		const closes = h
			.of("track-close")
			.filter(e => nearHz(e.track.centreHz, 20_000))
		expect(closes.length).toBeGreaterThan(0)
		for (const e of closes) {
			expect(e.track.gate).toBe("below")
			expect("gatePassedSample" in e.track).toBe(false)
			expect(e.track.blocks).toBeLessThan(6)
		}
	})

	it("passes a strong tone that drops out for one tolerated block", () => {
		const h = new Harness({ shortIntegrationMs: null })
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		const rng = mulberry32(20261029)
		h.push(noiseIq(rng, 12 * BLOCK))
		h.push(toneIq(rng, 5 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, BLOCK))
		h.push(toneIq(rng, 8 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const closes = h
			.of("track-close")
			.filter(e => nearHz(e.track.centreHz, 20_000))
		expect(closes.length).toBeGreaterThan(0)
		const main = closes.find(e => e.track.blocks >= 13)
		expect(main?.track.blocks).toBe(13)
		expect(main?.track.gate).toBe("passed")
		const sample = main?.track.gatePassedSample
		expect(typeof sample).toBe("number")
		if (typeof sample !== "number" || main === undefined) return
		expect(sample).toBeGreaterThanOrEqual(main.track.startSample)
		expect(sample).toBeLessThanOrEqual(main.track.lastSample)
		// Five on-blocks are 250 ms. The noise block is the tolerated off: it keeps
		// the run but does not count (DQ 1.8), so the sixth strong block passes.
		expect(sample).toBe(main.track.startSample + 7 * BLOCK)
	})

	it("keeps a passed gate on the successor of a max-duration rollover", () => {
		const h = new Harness({ shortIntegrationMs: null, maxTrackMs: 400 })
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		const rng = mulberry32(20261030)
		h.push(noiseIq(rng, 12 * BLOCK))
		h.push(toneIq(rng, 14 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const closes = h
			.of("track-close")
			.filter(e => nearHz(e.track.centreHz, 20_000))
		expect(closes.length).toBeGreaterThanOrEqual(2)
		expect(closes.every(e => e.track.gate === "passed")).toBe(true)
		const first = closes.find(e => e.endReason === "max-duration")
		expect(first?.track.gate).toBe("passed")
		const successor = closes.find(
			e => e.track.startSample === (first?.track.lastSample ?? -1) - BLOCK,
		)
		expect(successor?.track.gate).toBe("passed")
		expect(successor?.track.gatePassedSample).toBe(successor?.track.startSample)
		expect(successor?.track.blocks).toBeGreaterThanOrEqual(6)
	})

	it("inherits a living run across the one tolerated dropout at rollover", () => {
		const h = new Harness({ shortIntegrationMs: null, maxTrackMs: 200 })
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		const rng = mulberry32(20261048)
		h.push(noiseIq(rng, 12 * BLOCK))
		// on, on, off, on, on, on, on. The fourth block rolls a 200 ms track over.
		// DQ 1.8: the off does not count, so six strong blocks need a fourth after it.
		h.push(toneIq(rng, 2 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, BLOCK))
		h.push(toneIq(rng, 4 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const closes = h
			.of("track-close")
			.filter(e => nearHz(e.track.centreHz, 20_000))
		expect(closes.length).toBeGreaterThanOrEqual(2)
		const later = closes.reduce((a, b) =>
			a.track.startSample >= b.track.startSample ? a : b,
		)
		expect(later.track.gate).toBe("passed")
		expect(later.track.gatePassedSample).toBeGreaterThanOrEqual(
			later.track.startSample,
		)
	})

	it("does not backdate a successor behind the block that passed", () => {
		const h = new Harness({ shortIntegrationMs: null, maxTrackMs: 300 })
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		const rng = mulberry32(20261049)
		h.push(noiseIq(rng, 12 * BLOCK))
		h.push(toneIq(rng, 6 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const pred = h
			.of("track-close")
			.find(
				e => e.endReason === "max-duration" && nearHz(e.track.centreHz, 20_000),
			)
		expect(pred?.track.gate).toBe("passed")
		const successor = h
			.of("track-close")
			.find(
				e =>
					e.track.startSample === (pred?.track.lastSample ?? -1) - BLOCK &&
					nearHz(e.track.centreHz, 20_000),
			)
		expect(successor?.track.gate).toBe("passed")
		expect(successor?.track.gatePassedSample).toBe(pred?.track.gatePassedSample)
		expect(successor?.track.gatePassedSample).toBeGreaterThan(
			successor?.track.startSample ?? Number.POSITIVE_INFINITY,
		)
	})

	it("does not pass a weak successor once two offs have ended the run", () => {
		const widthHz = 50_000
		// Measured on this FFT: amplitude 0.0273 is about 0.9 dB in the 50 kHz
		// slot, below k − 1.5, so each weak block is an off. The per-bin peak
		// still clears the detector, so the track stays observed through rollover.
		const weakAmp = 0.0273
		const h = new Harness({
			shortIntegrationMs: null,
			maxTrackMs: 500,
			trackHangMs: 1000,
		})
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000, widthHz) })
		const rng = mulberry32(20261050)
		h.push(noiseIq(rng, 12 * BLOCK))
		h.push(toneIq(rng, 6 * BLOCK, 20_000, STRONG_AMP))
		h.push(toneIq(rng, 4 * BLOCK, 20_000, weakAmp))
		h.push(noiseIq(rng, 16 * BLOCK))
		const pred = h
			.of("track-close")
			.find(
				e => e.endReason === "max-duration" && nearHz(e.track.centreHz, 20_000),
			)
		expect(pred?.track.gate).toBe("passed")
		const successor = h
			.of("track-open")
			.find(
				e =>
					e.track.startSample === (pred?.track.lastSample ?? -1) - BLOCK &&
					nearHz(e.track.centreHz, 20_000),
			)
		expect(successor?.track.gate, `snr ${successor?.track.channelSnrDb}`).toBe(
			"pending",
		)
		// The rollover block is an off (~0.9 dB), under k − 1.5.
		const snr = successor?.track.channelSnrDb
		expect(snr).toBeGreaterThan(0.7)
		expect(snr).toBeLessThan(1.15)
		expect(successor?.track.gatePassedSample).toBeUndefined()
		const later = h
			.tracks()
			.filter(
				t => t.trackId === successor?.track.trackId && t.gate === "passed",
			)
		expect(later).toHaveLength(0)
	})

	it("opens the successor pending when the rollover block is masked", () => {
		const h = new Harness({
			shortIntegrationMs: null,
			maxTrackMs: 400,
			trackHangMs: 1500,
		})
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		const rng = mulberry32(20261051)
		h.push(noiseIq(rng, 12 * BLOCK))
		// Seven blocks settle unmasked. The eighth, the rollover, finalizes
		// on the next push, after the slot is more than half masked.
		h.push(toneIq(rng, 8 * BLOCK, 20_000, STRONG_AMP))
		h.send({
			kind: "masks",
			exclusions: [
				{ startHz: CENTRE + 14_000, endHz: CENTRE + 19_000 },
				{ startHz: CENTRE + 21_000, endHz: CENTRE + 26_000 },
			],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
		})
		h.push(toneIq(rng, BLOCK, 20_000, STRONG_AMP))
		const pred = h
			.of("track-close")
			.find(
				e => e.endReason === "max-duration" && nearHz(e.track.centreHz, 20_000),
			)
		expect(pred?.track.blocks).toBe(8)
		expect(pred?.track.gate).toBe("passed")
		const successor = h
			.of("track-open")
			.find(
				e =>
					e.track.startSample === (pred?.track.lastSample ?? -1) - BLOCK &&
					nearHz(e.track.centreHz, 20_000),
			)
		expect(successor?.track.gate).toBe("pending")
		expect(successor?.track.gatePassedSample).toBeUndefined()
		expect(
			h
				.tracks()
				.some(
					t => t.trackId === successor?.track.trackId && t.gate === "passed",
				),
		).toBe(false)
		h.send({
			kind: "masks",
			exclusions: [],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
		})
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		expect(
			h
				.tracks()
				.some(
					t => t.trackId === successor?.track.trackId && t.gate === "passed",
				),
		).toBe(false)
		h.push(toneIq(rng, 6 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const passed = h
			.tracks()
			.find(t => t.trackId === successor?.track.trackId && t.gate === "passed")
		expect(passed?.gate).toBe("passed")
		expect(passed?.gatePassedSample).toBeGreaterThan(passed?.startSample ?? 0)
		expect(passed?.gatePassedSample).not.toBe(pred?.track.gatePassedSample)
	})

	it("records a pass on the block a track closes", () => {
		const h = new Harness({ shortIntegrationMs: null, maxTrackMs: 300 })
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
		const rng = mulberry32(20261031)
		h.push(noiseIq(rng, 12 * BLOCK))
		h.push(toneIq(rng, 6 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const rolled = h
			.of("track-close")
			.find(
				e => e.endReason === "max-duration" && nearHz(e.track.centreHz, 20_000),
			)
		expect(rolled?.track.blocks).toBe(6)
		expect(rolled?.track.gate).toBe("passed")
		expect(rolled?.track.gatePassedSample).toBe(rolled?.track.lastSample)
	})

	// Feature: scanner-redesign, Property 1: Noise never passes the gate
	// Validates: Requirements 2.2, 2.3, 2.4
	it("a continuous emission stays passed across one dropout and rollover", async () => {
		// Keep 1 kHz bins and 50 ms blocks with one quarter of the IQ work.
		const BLOCK = 3_200
		const propertyFs = FS / 4
		const noiseIq = (rng: Rng, n: number) =>
			gaussianNoise(rng, n, TONE_SIGMA / 2)
		const toneIq = (rng: Rng, n: number, offset: number, amp: number) =>
			addInto(noiseIq(rng, n), tone(n, propertyFs, offset, amp))
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.integer({ min: 6, max: 14 }),
				fc.integer({ min: 150, max: 1000 }),
				fc.boolean(),
				fc.integer({ min: 0, max: 14 }),
				async (seed, blocks, maxTrackMs, hasDropout, dropoutRaw) => {
					const h = new Harness({
						sampleRateHz: propertyFs,
						fftSize: 64,
						shortIntegrationMs: null,
						maxTrackMs,
					})
					const traces: GateTrace[] = []
					h.pipeline.setGateTrace(e => {
						traces.push(e)
					})
					h.start()
					h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
					const rng = mulberry32(seed)
					const dropoutAt =
						hasDropout && blocks >= 3 ? 1 + (dropoutRaw % (blocks - 2)) : -1
					h.push(noiseIq(rng, 6 * BLOCK))
					h.push(toneIq(rng, 2 * BLOCK, -16_000, STRONG_AMP))
					h.push(noiseIq(rng, 6 * BLOCK))
					for (let i = 0; i < blocks; i++) {
						if (i === dropoutAt) h.push(noiseIq(rng, BLOCK))
						else h.push(toneIq(rng, BLOCK, 20_000, STRONG_AMP))
					}
					h.push(noiseIq(rng, 6 * BLOCK))
					h.push(toneIq(rng, 2 * BLOCK, -16_000, STRONG_AMP))
					h.push(noiseIq(rng, 6 * BLOCK))
					const detail = `seed=${seed} blocks=${blocks} maxTrackMs=${maxTrackMs} dropout=${dropoutAt}`
					const strongIds = new Set(
						h
							.of("track-open")
							.filter(e => nearHz(e.track.centreHz, 20_000))
							.map(e => e.track.trackId),
					)
					expect(strongIds.size, detail).toBeGreaterThan(0)
					const strongCloses = h
						.of("track-close")
						.filter(e => strongIds.has(e.track.trackId))
					expect(strongCloses, detail).toHaveLength(strongIds.size)
					const folded = foldGate(traces.filter(e => strongIds.has(e.trackId)))
					for (const e of strongCloses) {
						const o = folded.get(e.track.trackId)
						expect(o, detail).toBeDefined()
						if (o === undefined) continue
						const passed = e.track.gate === "passed"
						expect(passed, detail).toBe(o.passed)
						// Margin is the run's best, including a predecessor's blocks.
						if (passed && o.qualifiedSnr < 6) expect(passed, detail).toBe(false)
						if (!passed) {
							expect(e.track.gate, detail).toBe("below")
							continue
						}
						const sample = e.track.gatePassedSample
						expect(sample, detail).toBe(o.passedSample)
						expect(typeof sample, detail).toBe("number")
						if (typeof sample !== "number") continue
						expect(sample, detail).toBeGreaterThanOrEqual(e.track.startSample)
						expect(sample, detail).toBeLessThanOrEqual(
							e.track.lastSample + BLOCK,
						)
					}
					// `blocks` blocks are one run; the one tolerated dropout keeps it alive
					// but adds no duration (DQ 1.8). It meets 300 ms at the end of the
					// sixth strong block. A track still open then passes; one that closed
					// earlier stays below.
					const minPassBlocks = CHANNEL_GATE_MIN_DURATION_MS / BLOCK_MS
					const strongBlocks = dropoutAt >= 0 ? blocks - 1 : blocks
					const passBlocks =
						dropoutAt >= 0 && dropoutAt < minPassBlocks
							? minPassBlocks + 1
							: minPassBlocks
					if (
						strongBlocks >= minPassBlocks &&
						Number.isFinite(emissionStart(h))
					) {
						const passSample = emissionStart(h) + passBlocks * BLOCK
						for (const e of strongCloses) {
							if (e.track.lastSample >= passSample)
								expect(e.track.gate, detail).toBe("passed")
							else expect(e.track.gate, detail).toBe("below")
						}
					}
					// A successor whose copied run is qualified passes on that block.
					// A sticky pass does not cross a run that has ended.
					for (const e of traces) {
						if (e.kind !== "inherit" || !strongIds.has(e.trackId)) continue
						const prev =
							e.fromTrackId === null ? undefined : folded.get(e.fromTrackId)
						if (!prev?.qualified) continue
						const close = strongCloses.find(c => c.track.trackId === e.trackId)
						expect(close?.track.gate, detail).toBe("passed")
					}
					const otherIds = new Set(
						h
							.of("track-open")
							.filter(e => nearHz(e.track.centreHz, -16_000))
							.map(e => e.track.trackId),
					)
					expect(otherIds.size, detail).toBeGreaterThanOrEqual(2)
					for (const track of h.tracks()) {
						if (!otherIds.has(track.trackId)) continue
						expect(track.gate, detail).not.toBe("passed")
					}
					await yieldToRpc()
				},
			),
			{
				numRuns: 100,
				examples: [
					[1, 14, 1000, true, 4],
					[1, 14, 400, false, 0],
					[1, 6, 300, false, 0],
					// on, on, off, on, on, on at maxTrackMs 200. Dropout index 2.
					[1, 6, 200, true, 1],
				],
			},
		)
	}, 116_000)

	it("does not let two strong blocks pass a later weak tone in the same slot", () => {
		const { h, rng } = armedGate(20261041)
		h.push(toneIq(rng, 2 * BLOCK, 20_000, STRONG_AMP))
		h.push(toneIq(rng, 8 * BLOCK, 24_000, WEAK_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const weak = h.tracks().filter(t => nearHz(t.centreHz, 24_000))
		expect(weak.length).toBeGreaterThan(0)
		expect(weak.some(t => t.gate === "passed")).toBe(false)
	})

	it("does not let a weak successor pass after a strong burst and a gap", () => {
		const { h, rng } = armedGate(20261042, {
			maxTrackMs: 400,
			trackHangMs: 1000,
		})
		h.push(toneIq(rng, 7 * BLOCK, 20_000, STRONG_AMP))
		h.gap(2 * BLOCK)
		h.push(toneIq(rng, 3 * BLOCK, 20_000, WEAK_AMP))
		h.push(noiseIq(rng, 24 * BLOCK))
		expectNoLaterPass(h)
	})

	it("does not let a weak successor pass after a strong burst and two quiet blocks", () => {
		const { h, rng } = armedGate(20261043, {
			maxTrackMs: 400,
			trackHangMs: 1000,
		})
		h.push(toneIq(rng, 7 * BLOCK, 20_000, STRONG_AMP))
		h.push(noiseIq(rng, 2 * BLOCK))
		h.push(toneIq(rng, 3 * BLOCK, 20_000, WEAK_AMP))
		h.push(noiseIq(rng, 24 * BLOCK))
		expectNoLaterPass(h)
	})

	it("passes a second strong tone in the same slot on its own run", () => {
		const { h, rng } = armedGate(20261044)
		h.push(toneIq(rng, 8 * BLOCK, 20_000, STRONG_AMP))
		h.push(toneIq(rng, 16 * BLOCK, 24_000, STRONG_AMP))
		h.push(noiseIq(rng, 16 * BLOCK))
		const second = h
			.tracks()
			.filter(t => nearHz(t.centreHz, 24_000) && t.gate === "passed")
		expect(second.length).toBeGreaterThan(0)
	})

	it("closes a 150 ms tone below after a 1 s gap", () => {
		const { h, rng } = armedGate(20261045)
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		h.gap(FS)
		const closes = h
			.of("track-close")
			.filter(e => nearHz(e.track.centreHz, 20_000))
		expect(closes.length).toBeGreaterThan(0)
		for (const e of closes) {
			expect(e.track.gate).toBe("below")
			expect("gatePassedSample" in e.track).toBe(false)
		}
	})

	it("closes a 150 ms tone below on a pending retune", () => {
		const { h, rng } = armedGate(20261046)
		h.push(toneIq(rng, 3 * BLOCK, 20_000, STRONG_AMP))
		h.pending({
			centreHz: CENTRE,
			centreChanged: false,
			gainKey: "m:400",
		})
		const closes = h
			.of("track-close")
			.filter(e => e.track.epoch === 1 && nearHz(e.track.centreHz, 20_000))
		expect(closes.length).toBeGreaterThan(0)
		for (const e of closes) {
			expect(e.track.gate).toBe("below")
			expect("gatePassedSample" in e.track).toBe(false)
		}
	})

	// Feature: scanner-redesign, Property 1: Noise never passes the gate
	// Validates: Requirements 2.2, 2.3, 2.4
	it("a track passes only on its own measurements", async () => {
		// Keep 1 kHz bins and 50 ms blocks with one quarter of the IQ work.
		const BLOCK = 3_200
		const propertyFs = FS / 4
		const noiseIq = (rng: Rng, n: number) =>
			gaussianNoise(rng, n, TONE_SIGMA / 2)
		const toneIq = (rng: Rng, n: number, offset: number, amp: number) =>
			addInto(noiseIq(rng, n), tone(n, propertyFs, offset, amp))
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.boolean(),
				fc.boolean(),
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 100, max: 400 }),
				fc.integer({ min: 200, max: 400 }),
				async (
					seed,
					firstStrong,
					secondStrong,
					len1,
					len2,
					gapBlocks,
					hangMs,
					maxTrackMs,
				) => {
					const h = new Harness({
						sampleRateHz: propertyFs,
						fftSize: 64,
						shortIntegrationMs: null,
						trackHangMs: hangMs,
						maxTrackMs,
					})
					const traces: GateTrace[] = []
					h.pipeline.setGateTrace(e => {
						traces.push(e)
					})
					h.start()
					h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
					const rng = mulberry32(seed)
					h.push(noiseIq(rng, 6 * BLOCK))
					h.push(
						toneIq(
							rng,
							len1 * BLOCK,
							20_000,
							firstStrong ? STRONG_AMP : WEAK_AMP,
						),
					)
					if (gapBlocks > 0) h.gap(gapBlocks * BLOCK)
					h.push(
						toneIq(
							rng,
							len2 * BLOCK,
							24_000,
							secondStrong ? STRONG_AMP : WEAK_AMP,
						),
					)
					const hangBlocks = Math.max(1, Math.round(hangMs / BLOCK_MS))
					h.push(noiseIq(rng, (hangBlocks + 4) * BLOCK))
					const detail = `seed=${seed} a=${firstStrong} b=${secondStrong} n=${len1}+${len2} gap=${gapBlocks} hang=${hangMs} max=${maxTrackMs}`
					const ids = new Set(
						h
							.of("track-open")
							.filter(
								e =>
									nearHz(e.track.centreHz, 20_000) ||
									nearHz(e.track.centreHz, 24_000),
							)
							.map(e => e.track.trackId),
					)
					expect(ids.size, detail).toBeGreaterThan(0)
					const folded = foldGate(traces.filter(ev => ids.has(ev.trackId)))
					const closes = h
						.of("track-close")
						.filter(e => ids.has(e.track.trackId))
					expect(closes, detail).toHaveLength(ids.size)
					for (const e of closes) {
						const o = folded.get(e.track.trackId)
						expect(o, detail).toBeDefined()
						if (o === undefined) continue
						const passed = e.track.gate === "passed"
						expect(passed, detail).toBe(o.passed)
						// Margin is the run's best, including a predecessor's blocks.
						if (passed && o.qualifiedSnr < 6) expect(passed, detail).toBe(false)
						if (!passed) {
							expect(e.track.gate, detail).toBe("below")
							continue
						}
						expect(e.track.gatePassedSample, detail).toBe(o.passedSample)
						const sample = e.track.gatePassedSample
						if (typeof sample !== "number") continue
						expect(sample, detail).toBeGreaterThanOrEqual(e.track.startSample)
						expect(sample, detail).toBeLessThanOrEqual(
							e.track.lastSample + BLOCK,
						)
					}
					await yieldToRpc()
				},
			),
			{ numRuns: 100 },
		)
	}, 116_000)

	// Opt-in measurement only: WAVEKIT_GATE_BENCH=1 keeps this benchmark out of CI.
	it.skipIf(process.env["WAVEKIT_GATE_BENCH"] !== "1")(
		"benchmarks the gated path at 2048 bins",
		async () => {
			const plan: ChannelPlan = {
				sourceId: "s1",
				defaultWidthHz: WIDTH,
				entries: [
					{
						startHz: CENTRE - BENCH_FS / 2,
						endHz: CENTRE + BENCH_FS / 2,
						widthHz: WIDTH,
						rasterHz: null,
						firstChannelHz: null,
						burst: false,
						rangeKey: "bench",
					},
				],
			}
			const probe = createChannelGate({
				binHz: BENCH_FS / BENCH_N,
				blockMs: BLOCK_MS,
				centreHz: CENTRE,
				bins: BENCH_N,
			})
			probe.setPlan(plan)
			const slots = probe.stats().slots
			expect(slots).toBe(328)
			const tones = [-600_000, -300_000, 150_000, 400_000, 700_000]
			const quietOff = await benchGate(null, [])
			const busyOff = await benchGate(null, tones)
			const quiet = await benchGate(plan, [])
			const busy = await benchGate(plan, tones)
			const line = (row: Awaited<ReturnType<typeof benchGate>>): string =>
				`gate ${row.gateUs.toFixed(1)} µs/block, busy ${row.busyUs.toFixed(1)} µs/block, uptime ${row.uptimeUs.toFixed(1)} µs/block`
			console.info(
				`gate bench plan off, 0 tracks: ${line(quietOff)} (300 blocks after 100 warm-up)`,
			)
			console.info(`gate bench plan off, 5 tracks: ${line(busyOff)}`)
			console.info(
				`gate bench plan on, 0 tracks: ${line(quiet)} (${slots} slots, 300 blocks after 100 warm-up)`,
			)
			console.info(`gate bench plan on, 5 tracks: ${line(busy)}`)
			expect(quietOff.opened).toBe(0)
			expect(busyOff.opened).toBe(tones.length)
			expect(quietOff.gateUs).toBe(0)
			expect(busyOff.gateUs).toBe(0)
			expect(quiet.opened).toBe(0)
			expect(busy.opened).toBe(tones.length)
			for (const row of [quietOff, busyOff, quiet, busy]) {
				expect(Number.isFinite(row.gateUs)).toBe(true)
				expect(Number.isFinite(row.busyUs)).toBe(true)
				expect(Number.isFinite(row.uptimeUs)).toBe(true)
			}
		},
		180_000,
	)
})

/** Warm the floor with the short path off. One 12.5 kHz slot at +20 kHz. */
function armedGate(
	seed: number,
	over: ConstructorParameters<typeof Harness>[0] = {},
): { h: Harness; rng: Rng } {
	const h = new Harness({ shortIntegrationMs: null, ...over })
	h.start()
	h.send({ kind: "channel-plan", plan: planAt(CENTRE + 20_000) })
	const rng = mulberry32(seed)
	h.push(noiseIq(rng, 12 * BLOCK))
	return { h, rng }
}

/** Tracks that open after the first burst at +20 kHz must not pass. */
function emissionStart(h: Harness): number {
	let start = Number.POSITIVE_INFINITY
	for (const e of h.of("track-open")) {
		if (!nearHz(e.track.centreHz, 20_000)) continue
		if (e.track.startSample < start) start = e.track.startSample
	}
	return start
}

function expectNoLaterPass(h: Harness): void {
	const opens = h.of("track-open").filter(e => nearHz(e.track.centreHz, 20_000))
	expect(opens.length).toBeGreaterThan(1)
	const first = opens[0]?.track.startSample ?? 0
	for (const e of opens) {
		if (e.track.startSample <= first) continue
		const passed = h
			.tracks()
			.some(t => t.trackId === e.track.trackId && t.gate === "passed")
		expect(passed, e.track.trackId).toBe(false)
	}
}

interface OracleRun {
	passed: boolean
	passedSample: number | null
	on: boolean
	/** The run is alive. Independent of the sticky `passed` verdict. */
	run: boolean
	off: boolean
	/** Strong blocks (snr >= k) of the run: the tracker's `gateStrongBlocks` (DQ 1.8). */
	onBlocks: number
	best: number
	k: number
	margin: number
	minMs: number
	/** Latched while the run meets duration and margin. Cleared when it ends. */
	qualified: boolean
	qualifiedSample: number | null
	/** Best SNR of the run at the moment it first qualified. */
	qualifiedSnr: number
	maxSnr: number
	sawSnr: boolean
}

const GATE_HYST_DB = 1.5
const GATE_MARGIN_SLACK_DB = 1e-6

/**
 * Independent of the tracker. Steps the run on every block, keeps the
 * verdict sticky, and on inherit copies the run only — a successor passes
 * when that run is qualified, not because the predecessor already passed.
 */
function foldGate(events: GateTrace[]): Map<string, OracleRun> {
	const runs = new Map<string, OracleRun>()
	const get = (id: string): OracleRun => {
		const found = runs.get(id)
		if (found !== undefined) return found
		const created: OracleRun = {
			passed: false,
			passedSample: null,
			on: false,
			run: false,
			off: false,
			onBlocks: 0,
			best: Number.NEGATIVE_INFINITY,
			k: 0,
			margin: 0,
			minMs: 0,
			qualified: false,
			qualifiedSample: null,
			qualifiedSnr: Number.NEGATIVE_INFINITY,
			maxSnr: Number.NEGATIVE_INFINITY,
			sawSnr: false,
		}
		runs.set(id, created)
		return created
	}
	const endRun = (r: OracleRun): void => {
		r.on = false
		r.run = false
		r.off = false
		r.onBlocks = 0
		r.best = Number.NEGATIVE_INFINITY
		r.qualified = false
		r.qualifiedSample = null
	}
	const noteQualified = (r: OracleRun, end: number): void => {
		if (!r.run || r.qualified) return
		if (r.onBlocks * BLOCK_MS < r.minMs) return
		if (r.best + GATE_MARGIN_SLACK_DB < r.k + r.margin) return
		r.qualified = true
		r.qualifiedSample = end
		if (r.passed) return
		r.passed = true
		r.passedSample = end
		r.qualifiedSnr = r.best
	}
	const copyRun = (prev: OracleRun, r: OracleRun): void => {
		r.on = prev.on
		r.run = prev.run
		r.off = prev.off
		r.onBlocks = prev.onBlocks
		r.best = prev.best
		r.k = prev.k
		r.margin = prev.margin
		r.minMs = prev.minMs
		r.qualified = prev.qualified
		r.qualifiedSample = prev.qualifiedSample
	}
	for (const e of events) {
		const r = get(e.trackId)
		if (e.kind === "reset" || e.kind === "invalid") {
			endRun(r)
			continue
		}
		if (e.kind === "inherit") {
			if (e.fromTrackId === null)
				throw new Error("inherit without a predecessor")
			const prev = runs.get(e.fromTrackId)
			if (prev === undefined)
				throw new Error(`missing predecessor ${e.fromTrackId}`)
			if (!prev.run)
				throw new Error(`inherited a dead run from ${e.fromTrackId}`)
			copyRun(prev, r)
			if (r.qualified && r.qualifiedSample !== null && !r.passed) {
				r.passed = true
				r.passedSample = Math.max(e.endSample, r.qualifiedSample)
				r.qualifiedSnr = Number.isFinite(prev.qualifiedSnr)
					? prev.qualifiedSnr
					: r.best
			}
			continue
		}
		if (e.kind === "off") {
			if (r.run && !r.off) {
				r.off = true
				r.on = false
				// DQ 1.8: the tolerated off keeps the run but adds no duration.
				noteQualified(r, e.endSample)
			} else endRun(r)
			continue
		}
		if (!Number.isFinite(e.snr)) {
			endRun(r)
			continue
		}
		r.sawSnr = true
		if (e.snr > r.maxSnr) r.maxSnr = e.snr
		const on = e.snr >= e.kDb || (r.run && e.snr >= e.kDb - GATE_HYST_DB)
		r.on = on
		if (on) {
			if (!r.run) {
				r.run = true
				r.off = false
				r.onBlocks = 0
				r.best = Number.NEGATIVE_INFINITY
				r.qualified = false
				r.qualifiedSample = null
			}
			// DQ 1.8: only strong blocks (snr >= k) count toward the duration.
			if (e.snr >= e.kDb) r.onBlocks++
			if (e.snr > r.best) r.best = e.snr
			r.k = e.kDb
			r.margin = e.marginDb
			r.minMs = e.minMs
		} else if (r.run && !r.off) {
			r.off = true
			r.on = false
		} else {
			endRun(r)
			continue
		}
		noteQualified(r, e.endSample)
	}
	return runs
}

async function benchGate(
	plan: ChannelPlan | null,
	tones: number[],
): Promise<{
	gateUs: number
	busyUs: number
	uptimeUs: number
	opened: number
}> {
	const pipeline = new SpectrumPipeline(
		pipelineConfig({
			format: "FLOAT32LE",
			sampleRateHz: BENCH_FS,
			fftSize: BENCH_N,
			spectrumBins: 512,
		}),
		{ now: () => 0, profile: { sampleEvery: 1 } },
	)
	const events: PipelineEvent[] = []
	const send = (input: WorkerPipelineInput): void => {
		events.push(...pipeline.handle(input))
	}
	send({
		kind: "masks",
		exclusions: [],
		cfarRanges: [],
		burstRanges: [],
		rasters: [],
		obwHz: [],
		inWindow: true,
	})
	send({ kind: "spectrum-feed", enabled: true })
	send({
		kind: "new-stream",
		stream: 1,
		centreHz: CENTRE,
		sampleRateHz: BENCH_FS,
		gainKey: "m:496",
		tuningTrust: "commanded",
	})
	if (plan) send({ kind: "channel-plan", plan })
	const rng = mulberry32(20261028 + tones.length)
	let sample = 0
	const push = async (count: number, time = false): Promise<number> => {
		let elapsedS = 0
		for (let i = 0; i < count; i++) {
			const t0 = time ? process.uptime() : 0
			const iq = gaussianNoise(rng, BENCH_BLOCK, 0.02)
			for (const offsetHz of tones)
				addInto(iq, tone(BENCH_BLOCK, BENCH_FS, offsetHz, 0.4))
			send({
				kind: "bytes",
				startSample: sample,
				bytes: packF32(iq.re, iq.im),
			})
			sample += BENCH_BLOCK
			if (time) elapsedS += process.uptime() - t0
			// A long synchronous run starves vitest's worker RPC.
			if (i % 25 === 24) await yieldToRpc()
		}
		return elapsedS
	}
	await push(100)
	const before = gateProfile(pipeline)
	const elapsedS = await push(300, true)
	const after = gateProfile(pipeline)
	const blocks = after.blocks - before.blocks
	expect(blocks).toBe(300)
	const opened = events.filter(e => e.kind === "track-open").length
	return {
		gateUs: ((after.gate - before.gate) / blocks) * 1_000,
		busyUs: ((after.busyMs - before.busyMs) / blocks) * 1_000,
		uptimeUs: (elapsedS / blocks) * 1e6,
		opened,
	}
}
