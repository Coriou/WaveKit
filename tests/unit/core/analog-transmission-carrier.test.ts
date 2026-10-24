/**
 * WG10 req 3.8: transmissions follow carrier evidence (block log path of the tracker).
 */
import { describe, expect, it } from "vitest"
import {
	ANALOG_TRANSMISSION_CARRIER_RUN_BLOCKS,
	AnalogTransmissionTracker,
	CARRIER_LOG_CAPACITY,
	CARRIER_LOG_GAPS,
	CARRIER_PCM_RING_MS,
	CarrierBlockLog,
} from "../../../src/core/analog-transmission.js"
import {
	CarrierSource,
	T0,
	addBlocks,
	at,
	emptyScript,
	flicker,
	fromArray,
	noise,
	runScript,
	tone,
} from "./analog-transmission-carrier-harness.js"
import type {
	BlockScript,
	Delivery,
} from "./analog-transmission-carrier-harness.js"
import { dcsAudio } from "./audio-tones/dcs-synth.js"

const RATE = 8000

/** A keyed over: every block open and carried, its audio from `audio`. */
function over(
	script: BlockScript,
	ms: number,
	audio: (i: number) => number,
	fade?: { everyMs: number; ms: number },
): void {
	const blocks = ms / 10
	addBlocks(
		script,
		blocks,
		true,
		b =>
			fade === undefined ||
			b % (fade.everyMs / 10) < (fade.everyMs - fade.ms) / 10,
		audio,
	)
}

function ctcssOverAmidFlicker(fade?: { everyMs: number; ms: number }) {
	const s = emptyScript()
	flicker(s, 3000, 1)
	// The interference opens the squelch 300 ms before the key-up and holds it after.
	addBlocks(s, 30, true, false, noise(2, 0.3))
	const start = s.open.length
	over(s, 5000, tone(79.7), fade)
	const end = s.open.length
	addBlocks(s, 100, true, false, noise(3, 0.3))
	flicker(s, 3000, 4)
	addBlocks(s, 200, false, false, noise(5, 0.3))
	return { script: s, start, end }
}

const deliveries: Delivery[] = ["block", "batched", "split"]

describe("WG10 req 3.8 carrier-bounded transmissions", () => {
	it.each(deliveries)(
		"a 5 s CTCSS 79.7 over amid 0.5 s flicker is one 5 s transmission with its tone (%s)",
		delivery => {
			const { script, start, end } = ctcssOverAmidFlicker()
			const { rows, tracker } = runScript(script, { delivery })
			expect(rows).toHaveLength(1)
			const row = rows[0]
			expect(row?.tone?.ctcssHz).toBe(79.7)
			expect(row?.startedAt).toBe(at(start))
			expect(row?.durationMs).toBe((end - start) * 10)
			expect(tracker.discardedRuns()).toBeGreaterThan(0)
		},
	)

	it.each(deliveries)(
		"a DCS D031N over amid flicker is one transmission with that code (%s)",
		delivery => {
			const s = emptyScript()
			flicker(s, 3000, 11)
			addBlocks(s, 30, true, false, noise(12, 0.3))
			const start = s.open.length
			const dcs = dcsAudio({ code: 0o031, seconds: 5, seed: 13, rate: RATE })
			over(s, 5000, fromArray(dcs))
			const end = s.open.length
			addBlocks(s, 100, true, false, noise(14, 0.3))
			flicker(s, 3000, 15)
			addBlocks(s, 200, false, false, noise(16, 0.3))
			const { rows } = runScript(s, { delivery })
			expect(rows).toHaveLength(1)
			expect(rows[0]?.tone?.dcs).toEqual({ code: "031", polarity: "normal" })
			expect(rows[0]?.durationMs).toBe((end - start) * 10)
		},
	)

	it("flicker alone publishes nothing", () => {
		const s = emptyScript()
		flicker(s, 30_000, 21)
		addBlocks(s, 200, false, false, noise(22, 0.3))
		const { rows, tracker } = runScript(s)
		expect(rows).toHaveLength(0)
		expect(tracker.suppressed()).toEqual({ short: 0, noCarrier: 0 })
		expect(tracker.discardedRuns()).toBeGreaterThan(100)
	})

	it("an over with a 1 s unkeyed pause is one transmission", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(31, 0.3))
		const start = s.open.length
		over(s, 2000, tone(79.7))
		flicker(s, 1000, 32)
		over(s, 2000, tone(79.7))
		const end = s.open.length
		addBlocks(s, 200, false, false, noise(33, 0.3))
		const { rows } = runScript(s)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.startedAt).toBe(at(start))
		expect(rows[0]?.durationMs).toBe((end - start) * 10)
		expect(rows[0]?.tone?.ctcssHz).toBe(79.7)
	})

	it("a bare carrier key-up is one transmission without a tone", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(41, 0.3))
		over(s, 3000, noise(42, 0.005))
		addBlocks(s, 200, false, false, noise(43, 0.3))
		const { rows } = runScript(s)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.durationMs).toBe(3000)
		expect(rows[0]?.tone).toEqual({ ctcssHz: null, dtmf: null, dcs: null })
	})

	it.each([
		[ANALOG_TRANSMISSION_CARRIER_RUN_BLOCKS - 1, 0],
		[ANALOG_TRANSMISSION_CARRIER_RUN_BLOCKS, 1],
	])("a run of %i carried blocks gives %i spans", (run, spans) => {
		const s = emptyScript()
		addBlocks(s, 20, false, false, noise(51, 0.3))
		// Repeated runs separated by one uncarried open block; 60 runs ≥ 500 ms of span audio.
		for (let i = 0; i < 60; i++) {
			addBlocks(s, run, true, true, noise(52 + i, 0.01))
			addBlocks(s, 1, true, false, noise(200 + i, 0.3))
		}
		addBlocks(s, 200, false, false, noise(53, 0.3))
		const { rows } = runScript(s)
		expect(rows).toHaveLength(spans)
	})

	it.each([
		[1490, 1],
		[1500, 1],
		[1510, 2],
	])(
		"a span %i ms after the carrier end merges (rows %i), past finalisation while provisional",
		(gapMs, expected) => {
			const s = emptyScript()
			addBlocks(s, 20, false, false, noise(61, 0.3))
			over(s, 1000, tone(79.7))
			// The squelch stays open on interference: no edge marks the gap.
			addBlocks(s, gapMs / 10, true, false, noise(62, 0.3))
			over(s, 1000, tone(79.7))
			addBlocks(s, 200, false, false, noise(63, 0.3))
			const { rows } = runScript(s)
			expect(rows).toHaveLength(expected)
		},
	)

	it.each(["block", "split"] as const)(
		"repeated 50 ms fades every 2 s keep CTCSS and the transmission (%s)",
		delivery => {
			const { script, start, end } = ctcssOverAmidFlicker({
				everyMs: 2000,
				ms: 50,
			})
			const { rows } = runScript(script, { delivery })
			expect(rows).toHaveLength(1)
			expect(rows[0]?.tone?.ctcssHz).toBe(79.7)
			expect(rows[0]?.startedAt).toBe(at(start))
			// The last block of the over is inside the last 2 s period's carried part.
			expect(rows[0]?.durationMs).toBeLessThanOrEqual((end - start) * 10)
		},
	)

	it("repeated fades keep a DCS D031N code", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(71, 0.3))
		const dcs = dcsAudio({ code: 0o031, seconds: 5, seed: 72, rate: RATE })
		over(s, 5000, fromArray(dcs), { everyMs: 2000, ms: 50 })
		addBlocks(s, 200, false, false, noise(73, 0.3))
		const { rows } = runScript(s, { delivery: "split" })
		expect(rows).toHaveLength(1)
		expect(rows[0]?.tone?.dcs).toEqual({ code: "031", polarity: "normal" })
	})

	it("synthetic boundary regression shaped on the live timeline: five overs, five rows", () => {
		const { script, bounds } = liveShapedScript()
		const { rows } = runScript(script)
		expect(rows).toHaveLength(5)
		rows.forEach((row, i) => {
			const [start, end] = bounds[i] ?? [0, 0]
			expect(row.startedAt).toBe(at(start))
			expect(row.durationMs).toBe((end - start) * 10)
			expect(row.tone?.ctcssHz).toBe(79.7)
		})
	})

	it("the same script on the 3.7 path (no block log) is one merged chain without a tone", () => {
		const { script } = liveShapedScript()
		const { rows } = runScript(script, { legacy: true })
		expect(rows).toHaveLength(1)
		expect(rows[0]?.durationMs).toBeGreaterThan(80_000)
		expect(rows[0]?.tone?.ctcssHz ?? null).toBeNull()
	})
})

/** Overs at the live starts and lengths amid interference (see the design's regression). */
function liveShapedScript() {
	const s = emptyScript()
	const overs: Array<[number, number]> = [
		[19.1, 6.9],
		[33.7, 7.3],
		[54.9, 6.7],
		[75.9, 5.1],
		[84.4, 4.4],
	]
	const bounds: Array<[number, number]> = []
	let seed = 100
	for (const [startS, lengthS] of overs) {
		const flickerMs = Math.round(startS * 1000 - 300) - s.open.length * 10
		flicker(s, Math.floor(flickerMs / 10) * 10, seed++)
		addBlocks(s, 30, true, false, noise(seed++, 0.3))
		const start = s.open.length
		over(s, Math.round(lengthS * 1000), tone(79.7))
		bounds.push([start, s.open.length])
		addBlocks(s, 100, true, false, noise(seed++, 0.3))
	}
	flicker(s, 20_000, seed++)
	addBlocks(s, 200, false, false, noise(seed, 0.3))
	return { script: s, bounds }
}

describe("WG10 req 3.8.12 squelch tail elimination", () => {
	it("a 5 s CTCSS 79.7 over with a 0.4 s 55 Hz tail is one transmission ending at the carrier drop", () => {
		const s = emptyScript()
		flicker(s, 2000, 91)
		const start = s.open.length
		over(s, 5000, tone(79.7))
		over(s, 400, tone(55, 0.3))
		const end = s.open.length
		addBlocks(s, 100, true, false, noise(92, 0.3))
		addBlocks(s, 200, false, false, noise(93, 0.3))
		const { rows } = runScript(s, { delivery: "split" })
		expect(rows).toHaveLength(1)
		expect(rows[0]?.startedAt).toBe(at(start))
		expect(rows[0]?.durationMs).toBe((end - start) * 10)
		expect(rows[0]?.tone?.ctcssHz).toBe(79.7)
	})

	it.each([
		[1200, 79.7],
		[950, 79.7],
		[700, null],
	])(
		"a short over: %i ms of CTCSS then a loud 0.4 s 55 Hz tail reports %s (STE is never fed)",
		(ms, expected) => {
			const s = emptyScript()
			addBlocks(s, 50, false, false, noise(401, 0.3))
			const start = s.open.length
			// A tail six times the CTCSS amplitude: fed to the detector it spoils the last votes.
			over(s, ms, tone(79.7, 0.1))
			over(s, 400, tone(55, 0.6))
			const end = s.open.length
			addBlocks(s, 200, false, false, noise(402, 0.3))
			const { rows } = runScript(s, { delivery: "split" })
			expect(rows).toHaveLength(ms + 400 >= 500 ? 1 : 0)
			expect(rows[0]?.durationMs).toBe((end - start) * 10)
			expect(rows[0]?.tone?.ctcssHz ?? null).toBe(expected)
		},
	)

	it.each([57, 55])(
		"200 ms of %i Hz mid-over is skipped alone: the CTCSS after it still counts",
		hz => {
			const s = emptyScript()
			addBlocks(s, 50, false, false, noise(421, 0.3))
			over(s, 200, tone(hz, 0.4))
			over(s, 3000, tone(79.7))
			addBlocks(s, 200, false, false, noise(422, 0.3))
			const { rows } = runScript(s)
			expect(rows.map(r => r.tone?.ctcssHz ?? null)).toEqual([79.7])
		},
	)

	it("a late first-span tail does not suppress the resumed span", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(431, 0.3))
		over(s, 1000, tone(79.7))
		over(s, 400, tone(55, 0.6))
		addBlocks(s, 10, false, false, noise(432, 0.3))
		over(s, 2000, tone(88.5))
		addBlocks(s, 200, false, false, noise(433, 0.3))
		const { rows } = runScript(s, { pcmLagBlocks: 40 })
		expect(rows.map(r => r.tone?.ctcssHz ?? null)).toEqual([79.7, 88.5])
	})

	it.each([3000, 1200])(
		"a genuine 67.0 Hz tone for %i ms is not mistaken for STE",
		ms => {
			const s = emptyScript()
			addBlocks(s, 50, false, false, noise(411, 0.3))
			over(s, ms, tone(67))
			over(s, 400, tone(55, 0.3))
			addBlocks(s, 200, false, false, noise(412, 0.3))
			const { rows } = runScript(s)
			expect(rows[0]?.tone?.ctcssHz).toBe(67)
		},
	)

	it.each([600, 3000])(
		"a carrier with only a 55 Hz tone for %i ms reports no CTCSS",
		ms => {
			const s = emptyScript()
			addBlocks(s, 50, false, false, noise(94, 0.3))
			over(s, ms, tone(55, 0.3))
			addBlocks(s, 200, false, false, noise(95, 0.3))
			const { rows } = runScript(s)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.tone?.ctcssHz ?? null).toBeNull()
		},
	)

	it("a 180 degree CTCSS phase reversal for the last 0.2 s keeps the tone", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(96, 0.3))
		const start = s.open.length
		over(s, 5000, tone(79.7))
		// Continue the same sine with its sign flipped (a phase reversal at PTT release).
		const reversed = (i: number): number => -tone(79.7)(i + 5000 * 8)
		over(s, 200, reversed)
		const end = s.open.length
		addBlocks(s, 200, false, false, noise(97, 0.3))
		const { rows } = runScript(s)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.durationMs).toBe((end - start) * 10)
		expect(rows[0]?.tone?.ctcssHz).toBe(79.7)
	})
})

describe("CarrierBlockLog", () => {
	it("starts a new epoch per run, keeps block length and rounds like ChannelSquelch", () => {
		const log = new CarrierBlockLog()
		const a = {}
		log.note(a, 24_975.6, true, true)
		log.notePcm(a, 24_975.6, 100)
		expect(log.epoch).toBe(1)
		expect(log.blockSamples).toBe(250)
		expect(log.blockMs).toBeCloseTo((250 / 24_975.6) * 1000, 9)
		expect(log.blocks).toBe(1)
		expect(log.pcmBytes).toBe(100)
		log.note({}, 48_000, false, false)
		expect(log.epoch).toBe(2)
		expect(log.blocks).toBe(1)
		expect(log.blockSamples).toBe(480)
		expect(log.flags[0]).toBe(0)
		for (let i = 0; i < CARRIER_LOG_CAPACITY + 3; i++)
			log.note(a, 8000, true, i % 2 === 0)
		expect(log.blocks).toBe(CARRIER_LOG_CAPACITY + 3)
	})
})

describe("WG10 req 3.8 review fixes", () => {
	it("a closing config change mid-span resets the span: carried blocks after it reopen", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(301, 0.3))
		const start = s.open.length
		over(s, 3000, tone(79.7))
		addBlocks(s, 200, false, false, noise(302, 0.3))
		const change = start + 150
		const { rows } = runScript(s, {
			onBlock: (k, source) => {
				if (k === change) source.reconfigure({ modulation: "wfm" })
			},
		})
		expect(rows.map(r => r.closeReason)).toEqual(["config", "squelch"])
		expect(rows[1]?.modulation).toBe("wfm")
		// The new transmission needs a fresh 10-block run after the change.
		expect(Date.parse(rows[1]?.startedAt ?? "")).toBeGreaterThanOrEqual(
			Date.parse(at(change)),
		)
	})

	it("delayed PCM across a span end: the snapshot waits, so a tone split still happens", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(311, 0.3))
		over(s, 1000, tone(79.7))
		addBlocks(s, 50, false, false, noise(312, 0.3))
		over(s, 2000, tone(88.5))
		addBlocks(s, 300, false, false, noise(313, 0.3))
		// PCM 400 ms behind its blocks: at the first span end only 0.6 s of it was fed.
		const { rows } = runScript(s, { pcmLagBlocks: 40 })
		expect(rows.map(r => r.tone?.ctcssHz ?? null)).toEqual([79.7, 88.5])
	})

	it("delayed PCM: a 1 s second over still splits on its own tone", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(331, 0.3))
		over(s, 2000, tone(79.7))
		addBlocks(s, 50, false, false, noise(332, 0.3))
		over(s, 1000, tone(88.5))
		addBlocks(s, 300, false, false, noise(333, 0.3))
		// At the second span end only 600 ms of its PCM reached the detector (< 0.75 s).
		const { rows } = runScript(s, { pcmLagBlocks: 40 })
		expect(rows.map(r => r.tone?.ctcssHz ?? null)).toEqual([79.7, 88.5])
	})

	it("delayed PCM: a span merging 100 ms after a 900 ms over keeps the earlier tone pending", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(341, 0.3))
		over(s, 900, tone(79.7))
		addBlocks(s, 10, false, false, noise(342, 0.3))
		over(s, 2000, tone(88.5))
		addBlocks(s, 300, false, false, noise(343, 0.3))
		const { rows } = runScript(s, { pcmLagBlocks: 40 })
		expect(rows.map(r => r.tone?.ctcssHz ?? null)).toEqual([79.7, 88.5])
	})

	it("delayed PCM is still fed before finalisation", () => {
		const s = emptyScript()
		addBlocks(s, 50, false, false, noise(321, 0.3))
		over(s, 1000, tone(79.7))
		addBlocks(s, 300, false, false, noise(322, 0.3))
		const { rows } = runScript(s, { pcmLagBlocks: 40 })
		expect(rows).toHaveLength(1)
		expect(rows[0]?.tone?.ctcssHz).toBe(79.7)
	})

	it.each([
		["before its blocks", [["event"], ["notes", 300], ["pcm", 24_000]]],
		[
			"after metrics, before its PCM",
			[
				["notes", 100],
				["pcm", 8000],
				["notes", 120],
				["event"],
				["pcm", 24_000],
				["notes", 300],
			],
		],
		[
			"ahead of the PCM cursor",
			[["notes", 300], ["pcm", 6000], ["event"], ["pcm", 24_000]],
		],
	] as const)(
		"a queue-overflow discontinuity announced %s keeps positions and feeds no gap silence",
		(_name, steps) => {
			const pushed = gapRun(steps, 8000, 800, "queue-overflow")
			expect(pushed.filter(x => x === 0)).toHaveLength(0)
			const want: number[] = []
			for (let v = 0; v < 24_000; v++)
				if (v < 8000 || v >= 8800) want.push(v + 1)
			expect(pushed).toEqual(want)
		},
	)

	it("an overflow announced after its PCM arrived (still undecided) masks the misplaced samples", () => {
		const pushed = gapRun(
			[
				["notes", 100],
				["pcm", 9600],
				["event"],
				["notes", 300],
				["pcm", 24_000],
			],
			8000,
			800,
			"queue-overflow",
		)
		// Samples 8801-9600 sat at 8000-8799 when the notice came: masked with the gap.
		const want: number[] = []
		for (let v = 0; v < 24_000; v++) if (v < 8000 || v >= 9600) want.push(v + 1)
		expect(pushed).toEqual(want)
	})

	it("a late notice masks buffered early samples before later metrics drain them", () => {
		const pushed = gapRun(
			[
				["notes", 100],
				["pcm", 10_400],
				["event"],
				["notes", 300],
				["pcm", 24_000],
			],
			8000,
			800,
			"queue-overflow",
		)
		expect(pushed.filter(v => v >= 9601 && v <= 10_400)).toHaveLength(0)
		expect(pushed.filter(x => x === 0)).toHaveLength(0)
	})

	it.each([CARRIER_LOG_GAPS, CARRIER_LOG_GAPS + 1])(
		"%i gaps: masks are kept up to the cap, past it the run fails closed",
		gaps => {
			const log = new CarrierBlockLog()
			const run = {}
			for (let k = 0; k < gaps; k++)
				log.noteDiscontinuity(run, RATE, k * 160, 80, "queue-overflow")
			log.note(run, RATE, true, true, 0)
			log.note(run, RATE, true, true, 1)
			// Block 0 is the first gap; block 1 lies between gaps (open and carried unless failed closed).
			expect(log.flags[0]).toBe(0)
			expect(log.flags[1]).toBe(gaps > CARRIER_LOG_GAPS ? 0 : 3)
			expect(log.desynced).toBe(gaps > CARRIER_LOG_GAPS)
			expect(log.droppedTotal).toBe(gaps * 80)
		},
	)

	it.each([CARRIER_LOG_GAPS, CARRIER_LOG_GAPS + 1])(
		"%i gaps keep the output offset exact; past the cap nothing is fed",
		gaps => {
			const source = new CarrierSource()
			const run = {}
			let now = T0
			const pushed: number[] = []
			const tracker = new AnalogTransmissionTracker({
				source,
				frequencyAt: () => ({ hz: 446_068_750, tuningTrust: "commanded" }),
				now: () => now,
				setTimer: () => () => undefined,
				createToneDetector: () => ({
					push(pcm) {
						for (let i = 0; i + 4 <= pcm.length; i += 4)
							pushed.push(pcm.readFloatLE(i))
					},
					result: () => ({ ctcssHz: null, dtmf: null, dcs: null }),
					reset() {},
				}),
			})
			tracker.start()
			source.gate(true)
			source.log.note(run, RATE, false, false, 0)
			for (let k = 0; k < gaps; k++)
				source.log.noteDiscontinuity(
					run,
					RATE,
					80 + k * 160,
					80,
					"queue-overflow",
				)
			const socket = 1600
			const pcm = Buffer.alloc(socket * 4, 0)
			for (let i = 0; i < socket; i++) pcm.writeFloatLE(1, i * 4)
			source.log.notePcm(run, RATE, pcm.length)
			source.emit("pcm", pcm, { rate: RATE, format: "f32le" })
			for (let k = 1; k < 200; k++) {
				now += 10
				source.log.note(run, RATE, true, true, k)
			}
			const end = (tracker as unknown as { pcmEnd: number }).pcmEnd
			expect(end).toBe((socket + gaps * 80) * 4)
			expect(tracker.desyncedRuns()).toBe(gaps > CARRIER_LOG_GAPS ? 1 : 0)
			tracker.stop()
			if (gaps > CARRIER_LOG_GAPS) expect(pushed).toEqual([])
			else expect(pushed.length).toBeGreaterThan(0)
		},
	)

	it("desync discards the held STE window without feeding it", () => {
		const source = new CarrierSource()
		const run = {}
		let now = T0
		let pushed = 0
		const tracker = new AnalogTransmissionTracker({
			source,
			frequencyAt: () => ({ hz: 446_068_750, tuningTrust: "commanded" }),
			now: () => now,
			setTimer: () => () => undefined,
			createToneDetector: () => ({
				push(pcm) {
					pushed += pcm.length / 4
				},
				result: () => ({ ctcssHz: null, dtmf: null, dcs: null }),
				reset() {},
			}),
		})
		tracker.start()
		source.gate(true)
		for (let k = 0; k < 15; k++) {
			now += 10
			source.log.note(run, RATE, true, true, k)
			const pcm = Buffer.alloc(320)
			for (let i = 0; i < 80; i++) pcm.writeFloatLE(0.2, i * 4)
			source.log.notePcm(run, RATE, pcm.length)
			source.emit("pcm", pcm, { rate: RATE, format: "f32le" })
		}
		// Fed audio still waits in the 200 ms STE window.
		expect(pushed).toBe(0)
		for (let k = 0; k <= CARRIER_LOG_GAPS; k++)
			source.log.noteDiscontinuity(run, RATE, 80_000 + k * 80, 0, "input-gap")
		source.log.note(run, RATE, true, true, 15)
		expect(tracker.desyncedRuns()).toBe(1)
		expect(pushed).toBe(0)
		tracker.stop()
		expect(pushed).toBe(0)
	})

	it("voice-like harmonics from 65 Hz up never look like STE", () => {
		for (const f of [65, 70, 80, 90, 100, 120]) {
			const s = emptyScript()
			addBlocks(
				s,
				200,
				true,
				true,
				i =>
					0.3 * Math.sin((2 * Math.PI * f * i) / RATE) +
					0.15 * Math.sin((4 * Math.PI * f * i) / RATE) +
					0.08 * Math.sin((6 * Math.PI * f * i) / RATE),
			)
			addBlocks(s, 200, false, false, () => 0)
			const { pushed } = runScript(s, { format: "f32le", recordPushes: true })
			expect(pushed.length).toBe(16_000)
		}
	})

	it.each(["input-gap", "some-future-cause"])(
		"a %s discontinuity ends the run without shifting positions",
		cause => {
			const pushed = gapRun(
				[["notes", 100], ["event"], ["notes", 300], ["pcm", 24_000]],
				8040,
				0,
				cause,
			)
			// Block 100 (samples 8000-8079) is closed; everything else keeps its position.
			const want: number[] = []
			for (let v = 0; v < 24_000; v++)
				if (v < 8000 || v >= 8080) want.push(v + 1)
			expect(pushed).toEqual(want)
		},
	)

	it.each([
		["s16le", 0],
		["s16le", 1],
		["f32le", 0],
		["f32le", 1],
	] as const)(
		"PCM ring overflow evicts whole samples (%s, capacity + %i bytes)",
		(format, extra) => {
			const width = format === "s16le" ? 2 : 4
			const source = new CarrierSource()
			const run = {}
			const pushed: number[] = []
			let now = T0
			const tracker = new AnalogTransmissionTracker({
				source,
				frequencyAt: () => ({ hz: 446_068_750, tuningTrust: "commanded" }),
				now: () => now,
				setTimer: () => () => undefined,
				createToneDetector: () => ({
					push(pcm) {
						for (let i = 0; i + width <= pcm.length; i += width)
							pushed.push(width === 2 ? pcm.readInt16LE(i) : pcm.readFloatLE(i))
						expect(pcm.length % width).toBe(0)
					},
					result: () => ({ ctcssHz: null, dtmf: null, dcs: null }),
					reset() {},
				}),
			})
			tracker.start()
			const capSamples = (RATE * CARRIER_PCM_RING_MS) / 1000
			const bytes = capSamples * width + extra
			const pcm = Buffer.alloc(bytes + width)
			for (let i = 0; i * width + width <= pcm.length; i++)
				if (width === 2) pcm.writeInt16LE(i % 32_000, i * 2)
				else pcm.writeFloatLE(i, i * 4)
			// All PCM first (its blocks lag), then the blocks: everything open and carried.
			const chunk = Buffer.from(pcm.subarray(0, bytes))
			source.log.notePcm(run, RATE, chunk.length)
			source.emit("pcm", chunk, { rate: RATE, format })
			const blocks = capSamples / 80 + 1
			source.gate(true)
			for (let k = 0; k < blocks; k++) {
				now += 10
				source.log.note(run, RATE, true, true)
			}
			const dropped = extra === 0 ? 0 : 1
			// The detector hears its audio one STE window late: stop flushes it.
			tracker.stop()
			expect(tracker.droppedPcm()).toBe(dropped * width)
			const want = Array.from(
				{ length: capSamples - dropped },
				(_, i) => i + dropped,
			)
			expect(pushed).toEqual(want)
			tracker.stop()
		},
	)
})

type GapStep =
	| readonly ["notes", number]
	| readonly ["pcm", number]
	| readonly ["event"]

/**
 * Plays 300 live blocks at 8 kHz f32 whose sample `v` carries the value v + 1, in the given
 * order of block notes, socket PCM (up to a true sample position; dropped samples never travel)
 * and the discontinuity event; then closes and stops. Returns what the detector heard.
 */
function gapRun(
	steps: ReadonlyArray<GapStep>,
	at: number,
	dropped: number,
	cause: string,
): number[] {
	const source = new CarrierSource()
	const run = {}
	const pushed: number[] = []
	let now = T0
	const tracker = new AnalogTransmissionTracker({
		source,
		frequencyAt: () => ({ hz: 446_068_750, tuningTrust: "commanded" }),
		now: () => now,
		setTimer: () => () => undefined,
		createToneDetector: () => ({
			push(pcm) {
				for (let i = 0; i + 4 <= pcm.length; i += 4)
					pushed.push(pcm.readFloatLE(i))
			},
			result: () => ({ ctcssHz: null, dtmf: null, dcs: null }),
			reset() {},
		}),
	})
	tracker.start()
	source.gate(true)
	let noted = 0
	let sent = 0
	const overflow = cause === "queue-overflow"
	for (const step of steps) {
		if (step[0] === "event")
			source.log.noteDiscontinuity(run, RATE, at, dropped, cause)
		else if (step[0] === "notes")
			for (; noted < step[1]; noted++) {
				now += 10
				source.log.note(run, RATE, true, true, noted)
			}
		else {
			const values: number[] = []
			for (; sent < step[1]; sent++)
				if (!overflow || sent < at || sent >= at + dropped)
					values.push(sent + 1)
			// 100 ms socket chunks (the PCM ring holds 2 s).
			for (let from = 0; from < values.length; from += 800) {
				const part = values.slice(from, from + 800)
				const chunk = Buffer.alloc(part.length * 4)
				part.forEach((v, i) => chunk.writeFloatLE(v, i * 4))
				source.log.notePcm(run, RATE, chunk.length)
				source.emit("pcm", chunk, { rate: RATE, format: "f32le" })
			}
		}
	}
	source.gate(false)
	for (let k = 300; k < 500; k++) {
		now += 10
		source.log.note(run, RATE, false, false, k)
	}
	tracker.stop()
	return pushed
}
