import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import {
	EvidenceGate,
	judgeEvidence,
} from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { pcmSampleBytes } from "../../../../src/core/evidence-squelch/contract.js"
import type {
	EvidenceGatePort,
	EvidencePcmFormat,
} from "../../../../src/core/evidence-squelch/contract.js"
import { VoiceFrameMeter } from "../../../../src/core/evidence-squelch/voice-meter.js"
import { classifyAnalogTrial } from "../../../../src/core/scanner/analog-trial.js"
import type { AnalogTrialFrame } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	carrierSilence,
	ctcssMix,
	dcsMix,
	fskBursts,
	mix,
	toPcm,
	voiceLike,
} from "./synthetic.js"

const GATE_RATE = 25_000

function bytesOf(
	ms: number,
	format: EvidencePcmFormat = "s16le",
	rate = GATE_RATE,
): number {
	return Math.round((rate * ms) / 1_000) * pcmSampleBytes(format)
}

interface DriveResult {
	/** Bytes pushed before the latch byte offset (absolute in the stream), or -1. */
	latchByte: number
	/** Gate state after each 10 ms slice. */
	states: ("waiting" | "open")[]
}

/**
 * Push `pcm` in 10 ms slices with stage 1 open, noting one carrier block per slice
 * (`carrier(sliceIndex)`), starting at stream byte `base`.
 */
function driveOpen(
	gate: EvidenceGatePort,
	pcm: Buffer,
	format: EvidencePcmFormat,
	carrier: (slice: number) => boolean,
	rate = GATE_RATE,
	base = 0,
): DriveResult {
	const slice = Math.round(rate / 100) * pcmSampleBytes(format)
	let latchByte = -1
	const states: ("waiting" | "open")[] = []
	let index = 0
	for (let start = 0; start < pcm.length; start += slice) {
		const end = Math.min(pcm.length, start + slice)
		gate.noteBlock(carrier(index))
		const at = gate.push(pcm, format, start, end)
		if (at >= 0 && latchByte < 0) latchByte = base + at
		states.push(gate.state)
		index += 1
	}
	return { latchByte, states }
}

const quiet = (): boolean => true
const noisy = (): boolean => false

function nfm(): EvidenceGate {
	return new EvidenceGate({ rate: GATE_RATE, modulation: "nfm", gain: 2 })
}

/** Deviation-scaled speech (peak 0.8 = full deviation at gain 2). */
function voice(seconds: number, seed = 7): Float32Array {
	return voiceLike({ rate: GATE_RATE, seconds, seed, level: 0.8 })
}

describe("EvidenceGate", () => {
	it("opens on voice within 1.5 s", () => {
		const gate = nfm()
		const run = driveOpen(gate, toPcm(voice(2), "s16le"), "s16le", quiet)
		expect(gate.state).toBe("open")
		expect(gate.evidence).toBe("voice")
		expect(run.latchByte).toBeGreaterThan(0)
		expect(run.latchByte).toBeLessThanOrEqual(bytesOf(1_500))
	})

	it("opens on CTCSS at >= 750 ms", () => {
		const gate = nfm()
		const pcm = toPcm(
			ctcssMix({ rate: GATE_RATE, seconds: 2, hz: 100 }),
			"s16le",
		)
		const run = driveOpen(gate, pcm, "s16le", noisy)
		expect(gate.evidence).toBe("ctcss")
		expect(run.latchByte).toBeGreaterThanOrEqual(bytesOf(750))
	})

	it("opens on DCS at >= 750 ms", () => {
		const gate = nfm()
		const pcm = toPcm(
			dcsMix({ rate: GATE_RATE, seconds: 2, code: 0o23, polarity: "normal" }),
			"s16le",
		)
		const run = driveOpen(gate, pcm, "s16le", noisy)
		expect(gate.evidence).toBe("dcs")
		expect(run.latchByte).toBeGreaterThanOrEqual(bytesOf(750))
	})

	it("AM ignores tones", () => {
		const am = new EvidenceGate({ rate: GATE_RATE, modulation: "am", gain: 2 })
		const tone = mix(
			ctcssMix({ rate: GATE_RATE, seconds: 3, hz: 100 }),
			carrierSilence({ rate: GATE_RATE, seconds: 3 }),
		)
		driveOpen(am, toPcm(tone, "s16le"), "s16le", quiet)
		expect(am.state).toBe("waiting")
		const am2 = new EvidenceGate({ rate: GATE_RATE, modulation: "am", gain: 2 })
		driveOpen(am2, toPcm(voice(2), "s16le"), "s16le", quiet)
		expect(am2.state).toBe("open")
		expect(am2.evidence).toBe("voice")
	})

	it("voice without quieting never opens", () => {
		const gate = nfm()
		driveOpen(gate, toPcm(voice(3), "s16le"), "s16le", noisy)
		expect(gate.state).toBe("waiting")
		expect(gate.evidence).toBeNull()
	})

	it("NaN audio never opens", () => {
		const samples = voice(3)
		// One NaN per 50 ms frame of decimated audio (every 1 250 input samples at 25 kHz).
		for (let i = 600; i < samples.length; i += 1_250) samples[i] = NaN
		const gate = nfm()
		driveOpen(gate, toPcm(samples, "f32le"), "f32le", quiet)
		expect(gate.state).toBe("waiting")
	})

	it("discards evidence on a close before latch", () => {
		const gate = nfm()
		driveOpen(gate, toPcm(voice(0.6), "s16le"), "s16le", quiet)
		gate.reset()
		expect(gate.closed(bytesOf(300), "s16le")).toBe(0)
		const over = toPcm(voice(3, 9), "s16le")
		const head = bytesOf(700)
		driveOpen(gate, over.subarray(0, head), "s16le", quiet)
		expect(gate.state).toBe("waiting")
		const later = driveOpen(
			gate,
			over.subarray(head),
			"s16le",
			quiet,
			GATE_RATE,
			head,
		)
		expect(gate.state).toBe("open")
		// The new over needs a full window of its own: no earlier than a fresh gate on it.
		const fresh = driveOpen(nfm(), over, "s16le", quiet)
		expect(later.latchByte).toBeGreaterThanOrEqual(fresh.latchByte)
		expect(later.latchByte).toBeGreaterThanOrEqual(bytesOf(1_000))
	})

	function latched(): EvidenceGate {
		const gate = nfm()
		const pcm = toPcm(
			ctcssMix({ rate: GATE_RATE, seconds: 1.5, hz: 67 }),
			"s16le",
		)
		driveOpen(gate, pcm, "s16le", noisy)
		expect(gate.state).toBe("open")
		return gate
	}

	it("hang", () => {
		const gate = latched()
		gate.closed(bytesOf(1_499), "s16le")
		expect(gate.state).toBe("open")
		gate.closed(bytesOf(1), "s16le")
		expect(gate.state).toBe("waiting")
		expect(gate.evidence).toBeNull()
	})

	it("close guard", () => {
		const gate = latched()
		expect(gate.closed(bytesOf(300), "s16le")).toBe(bytesOf(200))
		expect(gate.closed(bytesOf(300), "s16le")).toBe(0)
	})

	it("close guard is exact across odd splits", () => {
		const gate = latched()
		let guard = 0
		for (let i = 0; i < 3_000; i++) guard += gate.closed(7, "s16le")
		expect(guard).toBe(bytesOf(200))
	})

	it("reopen within the hang keeps the latch", () => {
		const gate = latched()
		gate.closed(bytesOf(1_000), "s16le")
		const at = gate.push(Buffer.alloc(bytesOf(10)), "s16le", 0, bytesOf(10))
		expect(at).toBe(-1)
		expect(gate.state).toBe("open")
		// The hang restarts from the next closure.
		gate.closed(bytesOf(1_000), "s16le")
		expect(gate.state).toBe("open")
	})

	it("renewal", () => {
		const gate = latched()
		expect(gate.evidence).toBe("ctcss")
		gate.closed(bytesOf(500), "s16le")
		const dcs = toPcm(
			dcsMix({ rate: GATE_RATE, seconds: 2, code: 0o23, polarity: "normal" }),
			"s16le",
		)
		const run = driveOpen(gate, dcs, "s16le", noisy)
		expect(run.latchByte).toBe(-1)
		expect(run.states.every(s => s === "open")).toBe(true)
		expect(gate.evidence).toBe("dcs")
	})

	it("rate below 8 kHz throws", () => {
		for (const rate of [7_999, NaN, Infinity])
			expect(
				() => new EvidenceGate({ rate, modulation: "nfm", gain: 2 }),
			).toThrow(expect.objectContaining({ code: "EVIDENCE_RATE" }))
		expect(
			() => new EvidenceGate({ rate: 8_000, modulation: "nfm", gain: 0 }),
		).toThrow(expect.objectContaining({ code: "EVIDENCE_GAIN" }))
	})

	it("tone opens despite a non-finite voice frame", () => {
		const frames: AnalogTrialFrame[] = Array.from({ length: 20 }, () => ({
			carrierDb: 0,
			hfNoiseDb: 0,
			audioDb: NaN,
			syllabic: 0,
			cluster: 0,
		}))
		expect(
			judgeEvidence({
				modulation: "nfm",
				stats: { mode: "nfm", frames, gapSamples: 0, floorDb: -100 },
				tone: { kind: "ctcss", index: 0, hz: CTCSS_HZ[0] ?? 67 },
				audioMs: 800,
				quietBlocks: 0,
				notedBlocks: 0,
				framesFinite: false,
			}),
		).toBe("ctcss")
	})

	it("judgeEvidence fails closed on malformed input", () => {
		const frames: AnalogTrialFrame[] = Array.from({ length: 20 }, () => ({
			carrierDb: 0,
			hfNoiseDb: 0,
			audioDb: -5,
			syllabic: 1,
			cluster: 0,
		}))
		const good = {
			modulation: "nfm" as const,
			stats: { mode: "nfm" as const, frames, gapSamples: 0, floorDb: -100 },
			tone: null,
			audioMs: 1_000,
			quietBlocks: 100,
			notedBlocks: 100,
			framesFinite: true,
		}
		expect(judgeEvidence(good)).toBe("voice")
		for (const bad of [
			{ quietBlocks: Infinity },
			{ notedBlocks: Infinity, quietBlocks: Infinity },
			{ quietBlocks: NaN },
			{ notedBlocks: NaN },
			{ quietBlocks: 101 },
			{ quietBlocks: -1 },
			{ quietBlocks: 50.5 },
			{ audioMs: NaN },
			{ modulation: "wfm" as unknown as "nfm" },
		])
			expect(judgeEvidence({ ...good, ...bad })).toBeNull()
		const nanCluster = frames.map((f, i) =>
			i === 3 ? { ...f, cluster: NaN } : f,
		)
		expect(
			judgeEvidence({ ...good, stats: { ...good.stats, frames: nanCluster } }),
		).toBeNull()
		expect(
			judgeEvidence({ ...good, stats: { ...good.stats, frames: [] } }),
		).toBeNull()
		// Unknown modulation also blocks a qualified tone.
		expect(
			judgeEvidence({
				...good,
				modulation: "wfm" as unknown as "nfm",
				tone: { kind: "ctcss", index: 0, hz: CTCSS_HZ[0] ?? 67 },
			}),
		).toBeNull()
	})

	it("known limitation (req 1.4 note, 2026-10-23): syllable-timed burst FSK opens as voice", () => {
		// Accepted known limitation: 2FSK bursts at 100 ms on / 100 ms off look syllabic to the
		// pinned analog trial judge (median syllabic about 0.59, audio about -22 dB, cluster about
		// 0.34), and the gate equals that judge. A future stage-2 data test is expected to flip
		// this test deliberately (gate stays waiting, judge no longer "heard").
		const audio = fskBursts({
			rate: GATE_RATE,
			seconds: 4,
			levels: 2,
			baud: 1_200,
			burstMs: 100,
			gapMs: 100,
			seed: 5,
		})
		const gate = nfm()
		const run = driveOpen(gate, toPcm(audio, "f32le"), "f32le", quiet)
		const meter = new VoiceFrameMeter({ gain: 2 })
		const decimated = fskBursts({
			rate: 8_000,
			seconds: 1,
			levels: 2,
			baud: 1_200,
			burstMs: 100,
			gapMs: 100,
			seed: 5,
		})
		const window: AnalogTrialFrame[] = []
		for (const v of decimated)
			if (meter.push(v))
				window.push({ ...meter.frame, carrierDb: -20, hfNoiseDb: -10 })
		const scanner = classifyAnalogTrial(
			{ mode: "nfm", frames: window, gapSamples: 0, floorDb: -100 },
			{ ctcssHz: null, dcs: null, audioSeconds: 1 },
		)
		expect(run.latchByte).toBeGreaterThan(0)
		expect(gate.state).toBe("open")
		expect(gate.evidence).toBe("voice")
		expect(scanner).toBe("heard")
	})

	it("an empty quiet window is not quiet (A11)", () => {
		const frames: AnalogTrialFrame[] = Array.from({ length: 20 }, () => ({
			carrierDb: 0,
			hfNoiseDb: 0,
			audioDb: -5,
			syllabic: 1,
			cluster: 0,
		}))
		const input = {
			modulation: "nfm" as const,
			stats: { mode: "nfm" as const, frames, gapSamples: 0, floorDb: -100 },
			tone: null,
			audioMs: 1_000,
			quietBlocks: 0,
			notedBlocks: 0,
			framesFinite: true,
		}
		expect(judgeEvidence(input)).toBeNull()
		expect(judgeEvidence({ ...input, quietBlocks: 50, notedBlocks: 100 })).toBe(
			"voice",
		)
		expect(
			judgeEvidence({ ...input, quietBlocks: 49, notedBlocks: 100 }),
		).toBeNull()
	})
})
