/**
 * The recorder's head trim (onset-trim.ts, WidebandAnalogRecorder.trimHead): a file opens
 * `preRollMs` (300) before its track, and the detector reports the track before the carrier
 * quiets; the open-squelch static before the onset is trimmed to at most 150 ms before it, the
 * first 20 ms written are faded in, `startedAt` is the wall time of the first written sample and
 * `headTrimmedMs` reaches the kept log line only (never the receipt facts). A file with no static
 * head (a data buzz, or a voice already on the air at the file's start) loses nothing and is still
 * faded. The speech measure hears the untrimmed audio: a trimmed file reads exactly as the same
 * audio untrimmed. All signals are modelled (synthetic NFM through the recorder's own chain).
 */
import { Writable } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import type { DecodedLabel } from "../../../../src/core/scanner/channel/voice-veto.js"
import type {
	CopyDetector,
	CopyFingerprint,
} from "../../../../src/core/scanner/channel/copy-detector.js"
import type {
	AnalogFinishFacts,
	AnalogHandle,
	AnalogInput,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { wallIso } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	ONSET_KEEP_SAMPLES,
	onsetTrim,
} from "../../../../src/core/scanner/channel/onset-trim.js"
import type * as OnsetTrimModuleNs from "../../../../src/core/scanner/channel/onset-trim.js"
import {
	HARNESS_T0,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"
import { FskSource } from "./wideband-nfm-fixtures.js"
import {
	DISCOVERY_NOISE_GATE,
	DISCOVERY_NOISE_LATCH_MS,
	NOISE_EVIDENCE_PER_HOUR,
	type DiscoveryNoiseRate,
	type NoiseEvidenceBudget,
} from "../../../../src/core/scanner/channel/noise-evidence.js"
import { DcsDecoder } from "../../../../src/core/audio-tones/dcs.js"

type OnsetTrimModule = typeof OnsetTrimModuleNs

/** The A/B switch of the trim-independence test: true turns the recorder's onset trim off. */
const trimOff = vi.hoisted(() => ({ on: false }))
vi.mock(
	"../../../../src/core/scanner/channel/onset-trim.js",
	async importOriginal => {
		const actual = await importOriginal<OnsetTrimModule>()
		return {
			...actual,
			onsetTrim: (head: Int16Array, search: number) =>
				trimOff.on
					? { cutSamples: 0, onsetSamples: null }
					: actual.onsetTrim(head, search),
		}
	},
)

type Harness = ReturnType<typeof harness>
const LOW = { centreHz: 100_000_000 + LOW_OFFSET }
const analogFm: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => false,
}

interface Written {
	pcm: Int16Array[]
	facts: AnalogFinishFacts | undefined
}

function recorder(
	more: {
		admission?: boolean
		prior?: VoicePrior
		clock?: () => number
		decodedLabel?: () => DecodedLabel | null
		copies?: CopyDetector
		readyHold?: Promise<void>
	} = {},
) {
	const written: Written[] = []
	const lines: Record<string, unknown>[] = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, done) {
			for (const line of chunk.toString().split("\n"))
				if (line.trim() !== "")
					lines.push(JSON.parse(line) as Record<string, unknown>)
			done()
		},
	})
	const h = harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source: { ctcssHz: null, syllables: true },
		decodedLabel: more.decodedLabel ?? (() => null),
		voicePrior: () => more.prior ?? analogFm,
		...(more.copies ? { copies: more.copies } : {}),
		...(more.readyHold ? { readyHold: more.readyHold } : {}),
		liveClock: true,
		...(more.clock ? { clock: more.clock } : {}),
		logger: pino({ level: "info" }, sink),
		...(more.admission !== undefined ? { admission: more.admission } : {}),
		beginWrap:
			begin =>
			(i: AnalogInput): AnalogHandle => {
				const handle = begin(i)
				const w: Written = { pcm: [], facts: undefined }
				written.push(w)
				return {
					...handle,
					push: pcm => {
						w.pcm.push(Int16Array.from(pcm))
						return handle.push(pcm)
					},
					finish: (cut, facts) => {
						w.facts = facts
						return handle.finish(cut, facts)
					},
				}
			},
	})
	return { h, written, lines }
}

const joined = (parts: Int16Array[]): Int16Array => {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

/**
 * One over by "o": the track is reported from `trackStart` (the edge after 1 s of quiet), the
 * carrier keyed `leadS` later (the detector's lead: static on the air in the track) for `voiceS`;
 * `keyedBefore`: the carrier (voice) is already on the air from the start (a voice at the file's
 * start); `buzz`: a modelled 4FSK buzz instead of the voice. `keyed` (seconds since the track's
 * start → carrier on) replaces the lead/voice schedule; `reportFromS` (default 0.1) is when the
 * track is first reported; `skipAtS` leaves a 50 ms input gap (an IQ skip) at that time; `at`
 * runs once at its second; `afterSignal` runs after the over's audio, before its close;
 * `beforeIdle` runs before the final idle (it may feed more).
 */
async function over(
	h: Harness,
	o: {
		leadS: number
		voiceS: number
		keyedBefore?: boolean
		buzz?: boolean
		id?: string
		keyed?: (t: number) => boolean
		reportFromS?: number
		skipAtS?: number
		at?: { s: number; run: (trackStart: number) => void }
		afterSignal?: (trackStart: number) => void
		beforeIdle?: () => Promise<void>
		/** false: no final idle (a held file keeps the recorder busy until its grace ends). */
		idle?: boolean
	},
): Promise<number> {
	const id = o.id ?? "o"
	const fsk = new FskSource({
		fs: h.fs,
		offsetHz: LOW_OFFSET,
		levelsHz: [-1_944, -648, 648, 1_944],
	})
	const chunk = h.fs / 40
	const next = (on: boolean) =>
		o.buzz === true ? fsk.next(chunk, on) : h.src.next(chunk, on)
	for (let i = 0; i < 40; i++) {
		h.engine.write(next(o.keyedBefore === true))
		await h.pump()
	}
	const trackStart = h.engine.liveEdge()
	const end = trackStart + (o.leadS + o.voiceS) * h.fs
	const steps = Math.round((o.leadS + o.voiceS) * 40)
	const skipAt = o.skipAtS === undefined ? -1 : Math.round(o.skipAtS * 40)
	const skip = Math.round(0.05 * h.fs)
	const endAt = end + (skipAt >= 0 ? skip : 0)
	for (let i = 0; i < steps; i++) {
		const on = o.keyed ? o.keyed(i / 40) : i >= o.leadS * 40
		h.engine.write(next(on), i === skipAt ? skip : 0)
		const edge = h.engine.liveEdge()
		if (edge - trackStart >= (o.reportFromS ?? 0.1) * h.fs)
			h.rec.track(
				input(id, snapshot(id, trackStart, Math.min(edge, endAt), LOW)),
			)
		if (o.at && i === Math.round(o.at.s * 40)) o.at.run(trackStart)
		await h.pump()
	}
	o.afterSignal?.(trackStart)
	await h.feed(0.6, false)
	h.rec.closed(id, snapshot(id, trackStart, endAt, LOW), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
	await o.beforeIdle?.()
	if (o.idle !== false) await h.rec.idle()
	return trackStart
}

/** The `headTrimmedMs` of each "Analog file kept" log line, in keep order. */
const keptTrims = (lines: Record<string, unknown>[]): unknown[] =>
	lines
		.filter(l => l["msg"] === "Analog file kept")
		.map(l => l["headTrimmedMs"])

/** The wall ISO time of input sample `sample` under the harness's live clock. */
const wallOf = (sample: number): string | null =>
	wallIso(HARNESS_T0 + (sample * 1000) / LOW_FS)

describe("the recorder's head trim (modelled)", () => {
	it("0.8 s of static in the track before the carrier: at most 150 ms of it kept, faded, startedAt at the first written sample", async () => {
		const { h, written, lines } = recorder()
		const trackStart = await over(h, { leadS: 0.8, voiceS: 4 })
		expect(h.ops.map(op => op.outcome)).toEqual(["finalized"])
		const w = written[0]!
		// The receipt facts never carry the trim (a receipt the base schema reads): the log line does.
		expect(w.facts).not.toHaveProperty("headTrimmedMs")
		const trimmed = keptTrims(lines)[0] as number | undefined
		expect(trimmed).toBeDefined()
		// 300 ms pre-roll + 800 ms lead = 1 100 ms of static; 150 ms kept: about 950 ms cut.
		expect(trimmed!).toBeGreaterThanOrEqual(950 - 60)
		expect(trimmed!).toBeLessThanOrEqual(950 + 40)
		const pcm = joined(w.pcm)
		expect(pcm[0]).toBe(0)
		// What is left of the static ends within 150 ms (+ one block) of the first sample.
		const rest = onsetTrim(pcm, 10_400)
		expect(rest.onsetSamples).not.toBeNull()
		expect(rest.onsetSamples!).toBeLessThanOrEqual(ONSET_KEEP_SAMPLES + 160)
		// startedAt is the first written sample: the file's opening start plus the cut.
		const opened = trackStart - 0.3 * LOW_FS
		expect(w.facts?.startedAt).toBe(wallOf(opened + (trimmed! * LOW_FS) / 1000))
	}, 120_000)

	it("a voice already on the air at the file's start loses nothing (no trim), and is faded", async () => {
		const { h, written, lines } = recorder()
		const trackStart = await over(h, {
			leadS: 0,
			voiceS: 4,
			keyedBefore: true,
		})
		expect(h.ops.map(op => op.outcome)).toEqual(["finalized"])
		const w = written[0]!
		expect(keptTrims(lines)).toEqual([0])
		expect(joined(w.pcm)[0]).toBe(0)
		expect(w.facts?.startedAt).toBe(wallOf(trackStart - 0.3 * LOW_FS))
	}, 120_000)

	it("a data buzz with no static head is not trimmed but faded (admission off: kept)", async () => {
		const { h, written, lines } = recorder({ admission: false })
		const trackStart = await over(h, {
			leadS: 0,
			voiceS: 6,
			keyedBefore: true,
			buzz: true,
		})
		expect(h.ops.map(op => op.outcome)).toEqual(["finalized"])
		const w = written[0]!
		expect(keptTrims(lines)).toEqual([0])
		expect(joined(w.pcm)[0]).toBe(0)
		expect(w.facts?.startedAt).toBe(wallOf(trackStart - 0.3 * LOW_FS))
	}, 120_000)

	it("the verdict never depends on the trim: the same audio with and without a trim reads the same (speechHeard, admission numbers, keptBy)", async () => {
		const run = async (off: boolean) => {
			trimOff.on = off
			try {
				const { h, written, lines } = recorder()
				await over(h, { leadS: 0.8, voiceS: 4 })
				expect(h.ops.map(op => op.outcome)).toEqual(["finalized"])
				return { w: written[0]!, trim: keptTrims(lines)[0] as number }
			} finally {
				trimOff.on = false
			}
		}
		const trimmed = await run(false)
		const untrimmed = await run(true)
		expect(trimmed.trim).toBeGreaterThan(800)
		expect(untrimmed.trim).toBe(0)
		// Different files written (one lost its static head) ...
		expect(joined(untrimmed.w.pcm).length - joined(trimmed.w.pcm).length).toBe(
			(trimmed.trim * 8_000) / 1000,
		)
		// ... the same readings.
		expect(trimmed.w.facts?.admission).toBeDefined()
		expect(trimmed.w.facts?.admission).toEqual(untrimmed.w.facts?.admission)
		expect(trimmed.w.facts?.speechHeard).toBe(untrimmed.w.facts?.speechHeard)
		expect(trimmed.w.facts?.keptBy).toBe(untrimmed.w.facts?.keptBy)
	}, 240_000)
})

describe("the recorder's noise evidence budget on a channel with proven analog voice (modelled)", () => {
	it("data buzz overs: kept while the discovery made under 15 noise reads in the hour; at 15 the 1st and 2nd kept as noise-evidence, the 3rd discarded:noise; the latch holds the gate past the hour and opens it 24 h after it was reached", async () => {
		let clock = 0
		const { h, written } = recorder({
			prior: { ...analogFm, analogVoice: () => true },
			clock: () => clock,
		})
		// 14 earlier noise reads of the discovery at clock 0 (white box: as many earlier buzz overs).
		const rate = (h.rec as unknown as { noiseRate: DiscoveryNoiseRate })
			.noiseRate
		for (let i = 0; i < DISCOVERY_NOISE_GATE - 1; i++) rate.note("d_1", 0)
		clock = 1_000
		// "a": 14 reads before it, kept as before the rule, and counted (15 now).
		for (const id of ["a", "b", "c", "d"])
			await over(h, { leadS: 0, voiceS: 6, keyedBefore: true, buzz: true, id })
		expect(rate.before("d_1", clock)).toBe(DISCOVERY_NOISE_GATE + 1)
		// "a" reached the gate at 1 000 (its note left 15 reads): the latch closes it for 24 h.
		expect(rate.latched("d_1", clock)).toBe(true)
		// The seeded reads leave the hour (3 600 000 ms): 4 reads remain, under the gate, but the
		// latch holds it closed and the evidence budget (b and c, under the hour) has no room.
		clock = 3_600_000
		expect(rate.before("d_1", clock)).toBe(4)
		await over(h, {
			leadS: 0,
			voiceS: 6,
			keyedBefore: true,
			buzz: true,
			id: "e",
		})
		// 24 h after the gate was last reached ("e" left 5 reads: no refresh), it opens.
		clock = 1_000 + DISCOVERY_NOISE_LATCH_MS
		expect(rate.latched("d_1", clock)).toBe(false)
		await over(h, {
			leadS: 0,
			voiceS: 6,
			keyedBefore: true,
			buzz: true,
			id: "f",
		})
		expect(h.ops.map(op => op.outcome)).toEqual([
			"finalized",
			"finalized",
			"finalized",
			"aborted",
			"aborted",
			"finalized",
		])
		expect(written.map(w => w.facts?.keptBy)).toEqual([
			"prior-none",
			"noise-evidence",
			"noise-evidence",
			undefined,
			undefined,
			"prior-none",
		])
		// The discarded ones go to the noise quarantine with their facts.
		expect(h.ops[3]!.noise).toMatchObject({ reason: "noise" })
		expect(h.ops[4]!.noise).toMatchObject({ reason: "noise" })
		expect(h.rec.diagnostics().counts["discarded:noise"]).toBe(2)
	}, 240_000)

	it("a DCS-coded over on a latched discovery with no evidence room is kept and not counted; the same buzz uncoded is discarded:noise; both lines carry the rate", async () => {
		const clock = 1_000
		const { h, written, lines } = recorder({
			prior: { ...analogFm, analogVoice: () => true },
			clock: () => clock,
		})
		const white = h.rec as unknown as {
			noiseRate: DiscoveryNoiseRate
			noiseEvidence: NoiseEvidenceBudget
		}
		// The gate reached at 0 (latched) and the evidence budget spent: a judged file is discarded.
		for (let i = 0; i < DISCOVERY_NOISE_GATE; i++)
			white.noiseRate.note("d_1", 0)
		for (let i = 0; i < NOISE_EVIDENCE_PER_HOUR; i++)
			white.noiseEvidence.spend("d_1", 0)
		expect(white.noiseRate.latched("d_1", clock)).toBe(true)
		// The DCS decoder confirms code 023 over the buzz (injected tone coverage: the modelled
		// 4FSK buzz carries no sub-audible code; its sample count is the real one, 6 s at 8 kHz).
		const dcs = vi
			.spyOn(DcsDecoder.prototype, "result")
			.mockReturnValue({ code: "023", polarity: "normal" })
		try {
			await over(h, {
				leadS: 0,
				voiceS: 6,
				keyedBefore: true,
				buzz: true,
				id: "coded",
			})
		} finally {
			dcs.mockRestore()
		}
		// Not counted: a decoded tone is never a noise read (FinishPath.noiseCounted false).
		expect(white.noiseRate.before("d_1", clock)).toBe(DISCOVERY_NOISE_GATE)
		await over(h, {
			leadS: 0,
			voiceS: 6,
			keyedBefore: true,
			buzz: true,
			id: "uncoded",
		})
		expect(h.ops.map(op => op.outcome)).toEqual(["finalized", "aborted"])
		expect(written[0]!.facts).toMatchObject({
			tone: { kind: "dcs", code: "023", polarity: "normal" },
		})
		expect(written[0]!.facts?.keptBy).not.toMatch(/noise/)
		expect(h.ops[1]!.noise).toMatchObject({ reason: "noise" })
		// The uncoded buzz is judged and counted (16 reads now, capped at gate + 1).
		expect(white.noiseRate.before("d_1", clock)).toBe(DISCOVERY_NOISE_GATE + 1)
		const kept = lines.find(l => l["msg"] === "Analog file kept")
		const gone = lines.find(l => l["msg"] === "Analog file discarded as noise")
		expect(kept).toMatchObject({
			discoveryNoiseReads: DISCOVERY_NOISE_GATE,
			latched: true,
		})
		expect(gone).toMatchObject({
			discoveryNoiseReads: DISCOVERY_NOISE_GATE,
			latched: true,
		})
	}, 240_000)
})

/** The recorder's private session view these tests read (white box). */
interface SessionView {
	file: { startSample: number; headTrimmedMs: number | null } | null
}
const sessionsOf = (h: Harness): SessionView[] => [
	...(
		h.rec as unknown as { sessions: Map<string, SessionView> }
	).sessions.values(),
]
/** Mean absolute sample over [from, to). */
const meanAbs = (pcm: Int16Array, from: number, to: number): number => {
	let sum = 0
	for (let i = from; i < to; i++) sum += Math.abs(pcm[i]!)
	return sum / (to - from)
}

describe("the head trim and where the file opened (modelled)", () => {
	const decodeAt =
		(box: { label: DecodedLabel | null }, afterOpenS: number) =>
		(trackStart: number) => {
			const opened = trackStart - 0.3 * LOW_FS
			box.label = {
				protocol: "pocsag",
				at: HARNESS_T0 + ((opened + afterOpenS * LOW_FS) * 1000) / LOW_FS,
				observationId: "o",
			}
		}

	/** A suspect prior (a DMR sync hint): an untoned voice is held, then kept at its grace's end. */
	const suspect: VoicePrior = {
		labels: [
			{ protocol: "dmr", confidence: "activity", owner: true, at: HARNESS_T0 },
		],
		class: "unknown",
		analogVoice: () => false,
	}
	for (const [name, afterOpenS, outcome] of [
		// 0.2 s after the file opened: inside the ~0.95 s trimmed head and over 0.5 s (the decode
		// skew) before the first written sample, so only the opening start links it.
		["inside the trimmed head links: discarded late-non-voice", 0.2, "aborted"],
		["1 s before the file opened does not link: kept", -1, "finalized"],
	] as const)
		it(`a non-voice decode of the held file's own observation landing in its grace, made ${name}`, async () => {
			const box: { label: DecodedLabel | null } = { label: null }
			const { h, lines } = recorder({
				prior: suspect,
				decodedLabel: () => box.label,
			})
			const trackStart = await over(h, { leadS: 0.8, voiceS: 4, idle: false })
			// Held provisional: the session has ended, only the finish check reads the decode.
			expect(h.ops[0]!.outcome).toBeNull()
			expect(h.timers.length).toBe(1)
			decodeAt(box, afterOpenS)(trackStart)
			await h.fire()
			await h.rec.idle()
			expect(h.ops.map(op => op.outcome)).toEqual([outcome])
			const codes = h.rec.diagnostics().recent.map(d => d.code)
			if (outcome === "aborted") {
				expect(codes).toContain("discarded:late-non-voice")
			} else {
				expect(codes).not.toContain("discarded:late-non-voice")
				expect(keptTrims(lines)[0]).toBeGreaterThan(800)
			}
		}, 120_000)

	it("a file that ended before its first write: the copy span is taken again from its first written sample; the fingerprint starts where the file opened (its meter heard the untrimmed audio)", async () => {
		const kept: CopyFingerprint[] = []
		const copies = {
			kept: (fp: CopyFingerprint) => kept.push(fp),
			forget: () => undefined,
			status: () => ({}),
		} as unknown as CopyDetector
		let release!: () => void
		const readyHold = new Promise<void>(r => {
			release = r
		})
		const { h, lines } = recorder({ copies, readyHold })
		const starts: number[] = []
		const r = h.rec as unknown as {
			captureCopyEnd(s: unknown, f: { startSample: number }, e: number): void
		}
		const orig = r.captureCopyEnd.bind(h.rec)
		r.captureCopyEnd = (s, f, e) => {
			starts.push(f.startSample)
			orig(s, f, e)
		}
		await over(h, {
			leadS: 0.8,
			voiceS: 4,
			beforeIdle: async () => {
				// The file ended while its admission was still pending (nothing written, no trim yet).
				expect(starts).toHaveLength(1)
				release()
				await h.feed(1, false)
			},
		})
		expect(h.ops.map(op => op.outcome)).toEqual(["finalized"])
		const trimmed = keptTrims(lines)[0] as number
		expect(trimmed).toBeGreaterThan(800)
		expect(kept).toHaveLength(1)
		expect(starts).toHaveLength(2)
		// The copy span: from where the file opened, then again from its first written sample.
		expect(starts[1]! - starts[0]!).toBe((trimmed * LOW_FS) / 1000)
		// The fingerprint's envelope is the meter's: from where the file opened.
		expect(kept[0]!.startSample).toBe(starts[0])
	}, 120_000)

	for (const [name, joinedOn, outcome] of [
		[
			"still on the air at the first written sample: dropped as empty",
			true,
			"aborted",
		],
		[
			"ended before the first written sample: judged as usual (kept)",
			false,
			"finalized",
		],
	] as const)
		it(`a join inside the trimmed head, the joined signal ${name}`, async () => {
			const { h } = recorder()
			let trimmedFrom: number | null = null
			await over(h, {
				leadS: 0.8,
				voiceS: 4,
				at: {
					s: 2.5,
					run: trackStart => {
						const s = sessionsOf(h)[0]!
						expect(s.file?.headTrimmedMs).toBeGreaterThan(800)
						trimmedFrom = s.file!.startSample
						const opened = trackStart - 0.3 * LOW_FS
						const joinAt = opened + 0.4 * LOW_FS
						const end = (
							h.rec as unknown as {
								endSession(
									s: SessionView,
									cut: string,
									endAt: number,
									joinedLast: number,
								): void
							}
						).endSession.bind(h.rec)
						end(
							s,
							"cancelled",
							joinAt,
							joinedOn ? Number.POSITIVE_INFINITY : joinAt + 0.2 * LOW_FS,
						)
					},
				},
			})
			expect(trimmedFrom).not.toBeNull()
			expect(h.ops[0]!.outcome).toBe(outcome)
		}, 120_000)
})

describe("files the head trim leaves alone (modelled)", () => {
	it("an input gap filled before the first write: not trimmed", async () => {
		const { h, lines } = recorder()
		await over(h, { leadS: 0.8, voiceS: 4, skipAtS: 0.2 })
		expect(h.ops.map(op => op.outcome)).toEqual(["finalized"])
		expect(h.ops[0]!.gaps).toBeGreaterThanOrEqual(1)
		expect(keptTrims(lines)).toEqual([0])
	}, 120_000)

	it("a head cut (the ring no longer held the planned start): not trimmed, kept as source-lost", async () => {
		const { h, lines } = recorder()
		// First reported 4 s after the track's start (past the 3 s ring); the carrier keys 1.8 s in,
		// so the file's head (from the ring's oldest sample) holds about 0.8 s of static.
		await over(h, { leadS: 1.8, voiceS: 4.2, reportFromS: 4 })
		expect(h.ops.map(op => [op.cut, op.outcome])).toEqual([
			["source-lost", "finalized"],
		])
		expect(keptTrims(lines)).toEqual([0])
	}, 120_000)

	it("a roll-over part opening on static before the voice resumes: neither trimmed nor faded", async () => {
		const { h, written, lines } = recorder()
		// The file opens 0.3 s before the track and rolls over 120 s later (119.7 s into the track):
		// static over [119.1, 120.3) s, so part 2 opens on 0.6 s of static and then the voice.
		await over(h, {
			leadS: 0.8,
			voiceS: 125.2,
			keyed: t => t >= 0.8 && (t < 119.1 || t >= 120.3),
		})
		expect(h.ops.map(op => [op.cut, op.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
		const trims = keptTrims(lines)
		expect(trims[0]).toBeGreaterThan(800)
		expect(trims[1]).toBe(0)
		const part2 = joined(written[1]!.pcm)
		// Static from its first sample: a fade would hold the first 20 ms near 0.
		expect(meanAbs(part2, 0, 40)).toBeGreaterThan(
			0.3 * meanAbs(part2, 160, 1_760),
		)
	}, 600_000)
})
