/**
 * The digital voice capture harness's logic (tests/integration/dv-capture.ts)
 * without its binaries: the grid and its time budget, the settle-replay
 * variant, the real-time feeder, and one whole point with in-process doubles
 * standing in for wavekit-chan (a carrier detector) and for sox | dsd-fme (a
 * decoder that prints DMR lines from the audio it was fed so far). The run
 * against the real binaries is dv-capture.test.ts (WAVEKIT_DVCAP=1).
 */
import { describe, expect, it } from "vitest"
import { DV_SCENES } from "../../../scripts/fixtures/dv-plan.mjs"
import type { DvScene } from "../../../scripts/fixtures/dv-plan.mjs"
import {
	AUDIO_RATE_HZ,
	DVCAP_CNR_DB,
	DVCAP_ERRORS_HZ,
	DVCAP_PHASES,
	LEAD_MS,
	QUICK_BUDGET_S,
	QUICK_SCENES,
	SETTLE_FRAME_MS,
	SETTLE_REPEAT_MS,
	dvGrid,
	feedRealTime,
	gridSeconds,
	measureDvPoint,
	recordedSeed,
	settleReplay,
	type DvChannelize,
	type DvRunner,
} from "../../integration/dv-capture.js"
import { parseDvSeed } from "../../../scripts/bench/scanner-quality/truth-dv.js"

describe("the grid", () => {
	it("is every scene at every CNR, error and phase; quick is DMR at 20 dB, 0 Hz, phase 0", () => {
		const full = dvGrid()
		expect(full).toHaveLength(
			DV_SCENES.length *
				DVCAP_CNR_DB.length *
				DVCAP_ERRORS_HZ.length *
				DVCAP_PHASES.length,
		)
		expect(DV_SCENES.length * 4 * 3 * 4).toBe(1008)
		const quick = dvGrid({ quick: true })
		expect(quick.map(p => p.scene.name)).toEqual(QUICK_SCENES.map(s => s.name))
		expect(quick).toHaveLength(11)
		for (const p of quick)
			expect([p.scene.protocol, p.cnrDb, p.errorHz, p.phase]).toEqual([
				"dmr",
				20,
				0,
				0,
			])
		expect(
			dvGrid({ scenes: ["ysf-gaps"], cnrDb: [15], phases: [0.5] }),
		).toHaveLength(3)
	})

	it("runs the quick subset inside its budget, and not twice its phases", () => {
		// 11 DMR scenes, 226.6 s of scene, + 11 x (0.1 s lead + 10 s overhead) = 337.7 s.
		const quick = gridSeconds(dvGrid({ quick: true }))
		expect(quick).toBeCloseTo(337.7, 0)
		expect(quick).toBeLessThanOrEqual(QUICK_BUDGET_S)
		// Past the bound: a second phase doubles it (675 s > 600 s).
		expect(
			gridSeconds(dvGrid({ quick: true, phases: [0, 0.5] })),
		).toBeGreaterThan(QUICK_BUDGET_S)
		// The full grid: 520.6 s of scenes and 21 x 10.1 s, 48 points each, about 9.8 h.
		expect(gridSeconds(dvGrid()) / 3600).toBeCloseTo(9.8, 1)
	})
})

describe("settle replay", () => {
	/** s16 audio whose sample k holds k mod 32 768. */
	const ramp = (ms: number) => {
		const n = Math.round((ms / 1000) * AUDIO_RATE_HZ)
		const b = Buffer.alloc(2 * n)
		for (let k = 0; k < n; k++) b.writeInt16LE(k % 32_768, 2 * k)
		return b
	}
	const at = (b: Buffer, ms: number) =>
		b.readInt16LE(2 * Math.round((ms / 1000) * AUDIO_RATE_HZ))

	it("repeats whole frames of each over's head before it and shifts the timeline", () => {
		const pcm = ramp(2000)
		const overs = [
			{ startMs: 100, endMs: 600 },
			{ startMs: 1000, endMs: 1200 },
		]
		const r = settleReplay(pcm, overs, 360, 60)
		// The second over is 200 ms: three whole 60 ms frames (180 ms) fit.
		expect(r.repeatsMs).toEqual([360, 180])
		expect(r.pcm.length).toBe(pcm.length + 2 * 48 * (360 + 180))
		// The copy, then the over itself.
		expect(at(r.pcm, 100)).toBe(at(pcm, 100))
		expect(at(r.pcm, 100 + 360)).toBe(at(pcm, 100))
		expect(r.shift(50)).toBe(50)
		expect(r.shift(100)).toBe(460)
		expect(r.shift(1000)).toBe(1000 + 360 + 180)
		expect(at(r.pcm, r.shift(1100))).toBe(at(pcm, 1100))
	})

	it("keeps TDMA slot parity: the DMR repeat is whole 60 ms frames", () => {
		for (const [protocol, repeat] of Object.entries(SETTLE_REPEAT_MS))
			expect(repeat % SETTLE_FRAME_MS[protocol]!, protocol).toBe(0)
		expect(SETTLE_REPEAT_MS["dmr"]! % 60).toBe(0)
		// Every repeat fits the shortest over of its protocol's scenes.
		for (const s of DV_SCENES)
			for (const o of s.overs)
				expect(o.durationMs).toBeGreaterThanOrEqual(
					SETTLE_REPEAT_MS[s.protocol]!,
				)
	})
})

/**
 * A decoder double: reads s16 audio, keyed where the sample is above 1000;
 * prints a DMR voice sync at key-up, the IDs 360 ms after it (one superframe)
 * and a terminator once keyed off for 50 ms, each as soon as that audio has
 * arrived.
 */
const decoderDouble: DvRunner = async (_command, input, onLine) => {
	let sample = 0
	let keyedAt: number | null = null
	let lastOn = 0
	let idsDue: number | null = null
	const ms = (k: number) => (k / AUDIO_RATE_HZ) * 1000
	for await (const chunk of input)
		for (let i = 0; i + 1 < chunk.length; i += 2, sample++) {
			const on = chunk.readInt16LE(i) > 1000
			if (on) lastOn = sample
			if (on && keyedAt === null) {
				keyedAt = sample
				idsDue = sample + 0.36 * AUDIO_RATE_HZ
				onLine("Sync: +DMR  [slot1]  slot2  | Color Code=01 | VC* ")
			}
			if (on && idsDue !== null && sample >= idsDue) {
				onLine(" SLOT 1 TGT=4321 SRC=1234567 Group Call ")
				idsDue = null
			}
			if (!on && keyedAt !== null && ms(sample - lastOn) > 50) {
				onLine("Sync: +DMR  [slot1]  slot2  | Color Code=01 | TLC ")
				onLine(" SLOT 1 TGT=4321 SRC=1234567 Group Call ")
				keyedAt = null
				idsDue = null
			}
		}
}

/**
 * A channelizer double: the carrier's presence per 48 kHz sample (the mean
 * power of the cu8 samples it spans against the midpoint of the extremes), as
 * a 1 kHz tone where present and silence elsewhere. No group delay.
 */
const channelDouble: DvChannelize = async iq => {
	const ratio = 1_024_000 / AUDIO_RATE_HZ
	const n = Math.floor(iq.length / 2 / ratio)
	const power = new Float64Array(n)
	for (let k = 0; k < n; k++) {
		let p = 0
		const a = Math.floor(k * ratio)
		const b = Math.floor((k + 1) * ratio)
		for (let j = a; j < b; j++) {
			const i = iq[2 * j]! - 127.5
			const q = iq[2 * j + 1]! - 127.5
			p += i * i + q * q
		}
		power[k] = p / (b - a)
	}
	let lo = Infinity
	let hi = 0
	for (const p of power) {
		lo = Math.min(lo, p)
		hi = Math.max(hi, p)
	}
	const cf32 = Buffer.alloc(8 * n)
	for (let k = 0; k < n; k++) {
		if (power[k]! < (lo + hi) / 2) continue
		const phase = (2 * Math.PI * 1000 * k) / AUDIO_RATE_HZ
		cf32.writeFloatLE(Math.cos(phase), 8 * k)
		cf32.writeFloatLE(Math.sin(phase), 8 * k + 4)
	}
	return { cf32, groupDelaySamples: 0 }
}

const SCENE: DvScene = {
	name: "double",
	protocol: "dmr",
	dmrMode: "repeater",
	hangMs: 0,
	tailMs: 1000,
	overs: [
		{ startMs: 600, durationMs: 1200 },
		{ startMs: 3000, durationMs: 1800 },
	],
}

describe("feedRealTime", () => {
	it("stamps each line with the audio time it arrived at", async () => {
		// 1 s of silence, 0.5 s keyed, 0.5 s silence.
		const pcm = Buffer.alloc(2 * AUDIO_RATE_HZ * 2)
		for (let k = AUDIO_RATE_HZ; k < 1.5 * AUDIO_RATE_HZ; k++)
			pcm.writeInt16LE(5000, 2 * k)
		const lines = await feedRealTime("ignored", pcm, {
			run: decoderDouble,
			speed: 10,
		})
		expect(lines.map(l => l.text.trim().slice(-3))).toEqual([
			"VC*",
			"all",
			"TLC",
			"all",
		])
		// Never before its audio was fed; within a few chunks of it.
		expect(lines[0]!.atMs).toBeGreaterThanOrEqual(1000 - 20)
		expect(lines[0]!.atMs).toBeLessThan(1000 + 200)
		expect(lines[2]!.atMs).toBeGreaterThanOrEqual(1500 - 20)
	})
})

describe("measureDvPoint with doubles", () => {
	it("maps the plan onto the audio and scores the adapter's calls", async () => {
		const r = await measureDvPoint(
			{
				scene: SCENE,
				variant: "baseline",
				cnrDb: 30,
				errorHz: 0,
				phase: 0,
				seed: 1,
			},
			{ channelize: channelDouble, run: decoderDouble, speed: 10 },
		)
		// Plan ms + fmCu8's 100 ms lead (+ no group delay) = audio ms.
		expect(r.overs[0]!.startMs).toBeCloseTo(600 + 1.7 + LEAD_MS, 0)
		expect(r.rows.map(x => x.calls)).toEqual([1, 1])
		for (const row of r.rows) {
			// The double prints the IDs one superframe in.
			expect(row.headCutMs!).toBeGreaterThanOrEqual(360 - 25)
			expect(row.headCutMs!).toBeLessThan(360 + 250)
			// And ends at its terminator line, about 50 ms after key-down.
			expect(row.endErrMs!).toBeGreaterThan(0)
			expect(row.endErrMs!).toBeLessThan(400)
			expect(row.framesChecked).toBe(2)
		}
		// The recorded lines are a valid truth scorecard seed.
		const seed = parseDvSeed(
			"recorded.json",
			JSON.stringify(recordedSeed(r, 433_162_500)),
		)
		expect(seed).toMatchObject({ provisional: false, scene: "double" })
		expect(seed.lines.length).toBe(r.lines.length)
	}, 60_000)

	it("shifts the overs past each settle replay copy", async () => {
		const r = await measureDvPoint(
			{
				scene: SCENE,
				variant: "settle-replay",
				cnrDb: 30,
				errorHz: 0,
				phase: 0,
				seed: 1,
			},
			{ channelize: channelDouble, run: decoderDouble, speed: 10 },
		)
		expect(r.overs[0]!.startMs).toBeCloseTo(600 + 1.7 + LEAD_MS + 360, 0)
		expect(r.overs[1]!.startMs).toBeCloseTo(3000 + 1.7 + LEAD_MS + 720, 0)
		// The copy keys the double up 360 ms early: the call starts at key-up.
		for (const row of r.rows) expect(row.headCutMs!).toBeLessThan(250)
	}, 60_000)
})
