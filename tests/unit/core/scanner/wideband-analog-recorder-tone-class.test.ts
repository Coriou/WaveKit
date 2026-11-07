/**
 * WidebandAnalogRecorder's class by a shadow's own audio (classByTone, tone-class.ts): digital
 * audio never self-promotes, the class stays the recorder's (no tone evidence), a later verified
 * digital class still vetoes it, and shadows of spectrally digital tracks have the lowest slot
 * priority with a bounded time to be classed.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_DIGITAL_CLASS_FRAMES,
	WIDEBAND_DIGITAL_CLASS_MS,
	WIDEBAND_DIGITAL_QUALIFY_FRAMES,
	WIDEBAND_DIGITAL_QUALIFY_MS,
	WIDEBAND_TONE_ONLY_HOLD_FRAMES,
	WIDEBAND_TONE_ONLY_ON_AIR_FRAMES,
	digitalExpiry,
	toneOnlyYields,
	type WidebandCloseInfo,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { PITCH_MIN_SHARE } from "../../../../src/core/scanner/channel/tone-class.js"
import {
	FskSource,
	NfmSource,
	type FskSourceOptions,
} from "./wideband-nfm-fixtures.js"
import {
	CENTRE,
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

interface Source {
	next(n: number, on: boolean): Uint8Array
}

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
}
/** A weak voice or a data signal the spectrum reads as a narrow digital class. */
const DIGITAL: Partial<WidebandTrackInput> = {
	...SHADOW,
	spectralDigital: true,
}
const NOT_ANALOG: WidebandCloseInfo = { analogFm: false, discoveryId: "d_1" }

const lowHarness = (
	source: Partial<ConstructorParameters<typeof NfmSource>[0]> = {},
): Harness => harness({ fs: LOW_FS, offset: LOW_OFFSET, source })

/** Speech-like voice over a CTCSS tone (the default 67 Hz unless `ctcssHz`). */
const SPEECH = { syllables: true } as const

const fskAt = (opts: Partial<FskSourceOptions>): Source =>
	new FskSource({ fs: LOW_FS, offsetHz: LOW_OFFSET, seed: 4, ...opts })

const codes = (h: Harness): string[] =>
	h.rec.diagnostics().recent.map(d => d.code)

/**
 * One over of `seconds` from `src` (the harness's own voice source when omitted), a clean
 * snapshot every 25 ms chunk (`extra` per snapshot, `at` seconds after the onset), then the close
 * (`close`, default not analog-fm) 600 ms after it and 3.5 s of noise.
 */
async function over(
	h: Harness,
	seconds: number,
	opts: {
		src?: Source
		extra?: (at: number) => Partial<WidebandTrackInput>
		close?: WidebandCloseInfo
		id?: string
	} = {},
): Promise<void> {
	const id = opts.id ?? "o"
	const src = opts.src ?? h.src
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
		h.engine.write(src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(
				input(id, snapshot(id, onset, Math.min(edge, end), LOW), {
					...SHADOW,
					...opts.extra?.((edge - onset) / h.fs),
				}),
			)
		await h.pump()
	}
	await quiet(h, 0.6, src)
	h.rec.closed(
		id,
		snapshot(id, onset, end, LOW),
		null,
		opts.close ?? NOT_ANALOG,
	)
	await quiet(h, 3.5, src)
	await h.rec.idle()
}

async function quiet(h: Harness, seconds: number, src: Source): Promise<void> {
	const chunk = h.fs / 40
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
		h.engine.write(src.next(chunk, false))
		await h.pump()
	}
}

describe("classByTone: digital audio never self-promotes", () => {
	// Feature: wideband analog recorder, own-audio class.
	const DATA: [string, Partial<FskSourceOptions>][] = [
		// Alternating 2FSK, 200 baud, ±2400 Hz (a 100 Hz fundamental).
		[
			"alternating 2FSK 200 baud ±2400 Hz",
			{ baud: 200, levelsHz: [-2400, 2400], alternate: true },
		],
		// The same at a deviation whose fundamental is CTCSS-level (764 Hz): only speech rejects it.
		[
			"alternating 2FSK 200 baud ±600 Hz",
			{ baud: 200, levelsHz: [-600, 600], alternate: true },
		],
		[
			"alternating 2FSK 134 baud ±2400 Hz (a 67 Hz fundamental)",
			{ baud: 134, levelsHz: [-2400, 2400], alternate: true },
		],
		["random 4FSK 4800 baud", { baud: 4800 }],
		[
			"POCSAG-like 512 baud ±4500 Hz after a 576-bit preamble",
			{ baud: 512, levelsHz: [-4500, 4500], preambleSymbols: 576 },
		],
		[
			"POCSAG-like 1200 baud ±4500 Hz after a 576-bit preamble",
			{ baud: 1200, levelsHz: [-4500, 4500], preambleSymbols: 576 },
		],
	]
	for (const [name, opts] of DATA)
		it(`${name}: never classed, never finalized, no tone evidence`, async () => {
			const h = lowHarness()
			const src = fskAt(opts)
			await quiet(h, 1, src)
			await over(h, 8, { src })
			expect(h.ops).toEqual([])
			expect(h.tones).toEqual([])
			expect(codes(h)).not.toContain("classed")
			expect(codes(h)).not.toContain("finalized")
		}, 120_000)

	it("speech over a stable standard tone classes the shadow and keeps the whole over", async () => {
		for (const ctcssHz of [67, 100, 254.1]) {
			const h = lowHarness({ ...SPEECH, ctcssHz })
			await h.feed(1, false)
			await over(h, 5)
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(h.ops[0]!.cut).toBe("completed")
			expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
		}
	}, 120_000)

	it("the same speech without a tone, and the steady (non-syllabic) test voice over a tone, are not classed", async () => {
		for (const source of [{ ...SPEECH, ctcssHz: null }, { syllables: false }]) {
			const h = lowHarness(source)
			await h.feed(1, false)
			await over(h, 5)
			expect(h.ops).toEqual([])
			expect(codes(h)).toEqual(["shadow", "voiced", "discarded:unclassed"])
		}
	}, 120_000)
})

describe("classByTone is the recorder's class only", () => {
	it("a tone-classed file publishes no tone evidence; a snapshot classed analog-fm does", async () => {
		const own = lowHarness(SPEECH)
		await own.feed(1, false)
		await over(own, 5)
		expect(own.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(own.tones).toEqual([])

		const spectral = lowHarness(SPEECH)
		await spectral.feed(1, false)
		// Tone-classed first (about 3.6 s in), then a snapshot classes it analog-fm (from 5 s): the
		// tone is evidence again.
		let toneFirst = false
		await over(spectral, 6, {
			extra: at => {
				if (at < 5 && codes(spectral).includes("classed")) toneFirst = true
				return { analogFm: at >= 5 }
			},
		})
		expect(toneFirst).toBe(true)
		expect(spectral.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(codes(spectral)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"finalized",
		])
		expect(spectral.tones).toEqual([{ observationId: "o", hz: 67 }])
	}, 120_000)
})

describe("a verified digital class still vetoes a tone-classed recording", () => {
	// nonAnalog (a verified decode, the channel tier) after classByTone.
	it("on a later snapshot: the file being written is cancelled, nothing finalized", async () => {
		const h = lowHarness(SPEECH)
		await h.feed(1, false)
		let classedAt: number | null = null
		await over(h, 6, {
			extra: at => {
				if (classedAt === null && codes(h).includes("classed")) classedAt = at
				return { nonAnalog: classedAt !== null && at >= classedAt + 0.5 }
			},
		})
		expect(classedAt).not.toBeNull()
		expect(codes(h)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"discarded:not-analog",
		])
		expect(h.ops.every(o => o.outcome !== "finalized")).toBe(true)
		expect(h.tones).toEqual([])
	}, 120_000)

	it("after a kept wide reading: discarded the same, nothing finalized", async () => {
		const h = lowHarness(SPEECH)
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		let classedAt: number | null = null
		await over(h, 6, {
			extra: at => {
				if (classedAt === null && codes(h).includes("classed")) classedAt = at
				if (classedAt === null || at < classedAt + 0.25) return {}
				return {
					nonAnalog: at >= classedAt + 0.5,
					track: snapshot("o", onset, h.engine.liveEdge(), {
						...LOW,
						obwHz: 20_000,
					}),
				}
			},
		})
		expect(classedAt).not.toBeNull()
		expect(codes(h)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"discarded:not-analog",
		])
		expect(h.ops.every(o => o.outcome !== "finalized")).toBe(true)
		expect(h.rec.diagnostics().recent.at(-1)!.unclean).toMatchObject({
			flag: "wide",
			kept: true,
		})
	}, 120_000)

	it("on the close: discarded, nothing finalized", async () => {
		const h = lowHarness(SPEECH)
		await h.feed(1, false)
		await over(h, 5, {
			close: { analogFm: false, nonAnalog: true, discoveryId: "d_1" },
		})
		expect(codes(h)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"discarded:not-analog",
		])
		expect(h.ops.every(o => o.outcome !== "finalized")).toBe(true)
	}, 120_000)

	it("after a retune ended its session, a verified digital class still ends a late spur waiver", async () => {
		for (const verified of [false, true]) {
			const h = lowHarness(SPEECH)
			await h.feed(1, false)
			const chunk = h.fs / 40
			const onset = h.engine.liveEdge()
			for (let i = 0; i < 6 * 40 && !codes(h).includes("classed"); i++) {
				h.engine.write(h.src.next(chunk, true))
				const edge = h.engine.liveEdge()
				if (edge - onset >= 0.1 * h.fs)
					h.rec.track(input("o", snapshot("o", onset, edge, LOW), SHADOW))
				await h.pump()
			}
			expect(codes(h)).toContain("classed")
			const spur = snapshot("o", onset, h.engine.liveEdge(), LOW)
			spur.flags.spur = true
			expect(h.rec.keepsOverArtefact("o", spur, input("o", spur, SHADOW))).toBe(
				true,
			)
			h.rec.track(input("o", spur, SHADOW))
			// The tuner moves on before the track's close: the session ends with its file.
			h.engine.epoch = {
				...h.engine.epoch,
				epoch: h.engine.epoch.epoch + 1,
				startSample: h.engine.liveEdge(),
			}
			await quiet(h, 0.5, h.src)
			expect(h.rec.owns("o")).toBe(false)
			const later = snapshot("o", onset, h.engine.liveEdge(), LOW)
			later.flags.spur = true
			const info = input("o", later, {
				...SHADOW,
				...(verified ? { nonAnalog: true } : {}),
			})
			expect(h.rec.keepsOverArtefact("o", later, info)).toBe(!verified)
			h.rec.closed("o", later, "epoch-changed", NOT_ANALOG)
			await h.rec.idle()
		}
	}, 120_000)

	it("a session a snapshot classed analog-fm keeps its parent behaviour (the class is sticky)", async () => {
		const h = lowHarness(SPEECH)
		await h.feed(1, false)
		await over(h, 5, {
			extra: at => ({ analogFm: at < 1, nonAnalog: at >= 3 }),
		})
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)
})

interface Keyed {
	src: Source
	on: boolean
}

/** Writes `seconds` of the sum of `sources` (each keyed by its own flag), running the recorder. */
async function feedMix(
	h: Harness,
	sources: Keyed[],
	seconds: number,
	each: () => void,
): Promise<void> {
	const chunk = h.fs / 40
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
		const out = new Uint8Array(2 * chunk)
		const parts = sources.map(x => x.src.next(chunk, x.on))
		for (let k = 0; k < out.length; k++) {
			let v = 127.5
			for (const p of parts) v += p[k]! - 127.5
			out[k] = Math.max(0, Math.min(255, Math.round(v)))
		}
		h.engine.write(out)
		each()
		await h.pump()
	}
}

const owner = (h: Harness): string[] =>
	[
		...(
			h.rec as unknown as { sessions: Map<string, { owner: string }> }
		).sessions.values(),
	].map(s => s.owner)

describe("shadows of spectrally digital tracks: lowest slot priority, bounded window", () => {
	// Two data shadows hold both slots, then a weak voice read as digital arrives.
	it(`two voiced data shadows free their slots within ${WIDEBAND_DIGITAL_CLASS_MS / 1000} s of in-track audio, one for a waiting voice read as digital once its file can no longer pass the tone test; the voice records whole`, async () => {
		const h = lowHarness({ amp: 0 })
		const a: Keyed = {
			src: new FskSource({
				fs: LOW_FS,
				offsetHz: -20_000,
				amp: 0.25,
				noiseSigma: 0,
				seed: 1,
			}),
			on: true,
		}
		const b: Keyed = {
			src: new FskSource({
				fs: LOW_FS,
				offsetHz: 0,
				amp: 0.25,
				noiseSigma: 0,
				seed: 2,
			}),
			on: true,
		}
		const v: Keyed = {
			src: new NfmSource({
				fs: LOW_FS,
				offsetHz: LOW_OFFSET,
				amp: 0.25,
				seed: 3,
				...SPEECH,
			}),
			on: false,
		}
		const mix = [a, b, v]
		await feedMix(h, mix, 0.5, () => undefined)
		const onset = h.engine.liveEdge()
		let voiceAt = 0
		let voiceEnd: number | null = null
		const report = () => {
			const edge = h.engine.liveEdge()
			for (const [id, hz] of [
				["a", CENTRE - 20_000],
				["b", CENTRE],
			] as const)
				h.rec.track(
					input(id, snapshot(id, onset, edge, { centreHz: hz }), DIGITAL),
				)
			if (!v.on || edge - voiceAt < 0.1 * LOW_FS) return
			h.rec.track(
				input("v", snapshot("v", voiceAt, voiceEnd ?? edge, LOW), DIGITAL),
			)
		}
		await feedMix(h, mix, 1, report)
		expect(owner(h)).toEqual(["a", "b"])
		v.on = true
		voiceAt = h.engine.liveEdge()
		await feedMix(h, mix, 1, report)
		// Digital itself: the voice takes no digital shadow's slot.
		expect(h.rec.owns("v")).toBe(false)
		expect(
			(h.rec.diagnostics().recentRefusals ?? []).map(r => r.code),
		).toContain("refused:slots")
		// The data shadows pass the voice gate but are never classed. With no standard tone in
		// their files, one gives its slot to the waiting voice once the tone test can no longer
		// pass (2.5 s of in-track audio, judged 1 s late); the other is gone by 12 s of in-track
		// audio (13 s after its onset). Neither starts a new shadow.
		await feedMix(h, mix, 11.5, report)
		expect(h.rec.owns("a")).toBe(false)
		expect(h.rec.owns("b")).toBe(false)
		expect(h.rec.owns("v")).toBe(true)
		await feedMix(h, mix, 10, report)
		voiceEnd = h.engine.liveEdge()
		v.on = false
		await feedMix(h, mix, 0.6, report)
		h.rec.closed("v", snapshot("v", voiceAt, voiceEnd, LOW), null, NOT_ANALOG)
		await feedMix(h, mix, 3.5, () => undefined)
		await h.rec.idle()
		const voice = h.ops.filter(o => o.input.observationId === "v")
		expect(voice.map(o => o.outcome)).toEqual(["finalized"])
		// The whole 22.5 s over: it started within the 3 s ring, from its pre-roll.
		expect(voice[0]!.frames).toBeGreaterThan(22 * 8000)
		expect(h.ops).toHaveLength(1)
		const decided = h.rec.diagnostics().recent
		const ends = ["a", "b"].map(id =>
			decided.filter(d => d.observationId === id).map(d => d.code),
		)
		expect(ends).toContainEqual(["shadow", "voiced", "evicted"])
		expect(ends).toContainEqual(["shadow", "voiced", "discarded:unclassed"])
	}, 300_000)

	it(`an unvoiced data shadow is discarded after ${WIDEBAND_DIGITAL_QUALIFY_MS / 1000} s of in-track audio: owned at 3.5 s, gone by 4.5 s (judged 1 s late)`, async () => {
		const h = lowHarness()
		// ±250 Hz alternating: too quiet for the voice gate.
		const src = fskAt({ baud: 200, levelsHz: [-250, 250], alternate: true })
		await quiet(h, 1, src)
		const onset = h.engine.liveEdge()
		const chunk = h.fs / 40
		const run = async (seconds: number) => {
			for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
				h.engine.write(src.next(chunk, true))
				h.rec.track(
					input("d", snapshot("d", onset, h.engine.liveEdge(), LOW), DIGITAL),
				)
				await h.pump()
			}
		}
		await run(3.5)
		expect(h.rec.owns("d")).toBe(true)
		await run(1)
		expect(h.rec.owns("d")).toBe(false)
		expect(codes(h)).toEqual(["shadow", "discarded:unvoiced"])
		// Its observation starts no other shadow; an analog-fm snapshot still starts a recording.
		await run(0.1)
		expect(h.rec.owns("d")).toBe(false)
		h.rec.track(input("d", snapshot("d", onset, h.engine.liveEdge(), LOW)))
		expect(h.rec.owns("d")).toBe(true)
	}, 120_000)

	it(`a voiced, unclassed data shadow is discarded after ${WIDEBAND_DIGITAL_CLASS_MS / 1000} s: owned at ${WIDEBAND_DIGITAL_CLASS_MS / 1000 + 0.5} s, gone by ${WIDEBAND_DIGITAL_CLASS_MS / 1000 + 1.5} s; a later visit may shadow it again`, async () => {
		const h = lowHarness()
		const src = fskAt({ baud: 4800 })
		await quiet(h, 1, src)
		const onset = h.engine.liveEdge()
		const chunk = h.fs / 40
		const run = async (seconds: number) => {
			for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
				h.engine.write(src.next(chunk, true))
				h.rec.track(
					input("d", snapshot("d", onset, h.engine.liveEdge(), LOW), DIGITAL),
				)
				await h.pump()
			}
		}
		await run(WIDEBAND_DIGITAL_CLASS_MS / 1000 + 0.5)
		expect(h.rec.owns("d")).toBe(true)
		await run(1)
		expect(h.rec.owns("d")).toBe(false)
		expect(codes(h)).toEqual(["shadow", "voiced", "discarded:unclassed"])
		// The same visit (stream 1, epoch 1): no other shadow for it.
		await run(0.1)
		expect(h.rec.owns("d")).toBe(false)
		// A later visit (a sweep back on the channel, epoch 2): a new shadow, a new window.
		h.engine.epoch.epoch = 2
		const back = h.engine.liveEdge()
		h.rec.track(
			input("d", snapshot("d", back, back + 0.2 * h.fs, { ...LOW, epoch: 2 }), {
				...DIGITAL,
			}),
		)
		expect(h.rec.owns("d")).toBe(true)
		expect(codes(h)).toEqual([
			"shadow",
			"voiced",
			"discarded:unclassed",
			"shadow",
		])
	}, 120_000)

	it("a candidate classed analog-fm evicts a digital shadow before an older non-digital one; a non-digital shadow evicts only a digital one", async () => {
		const h = lowHarness()
		const at = 1_000
		const hz = (k: number) => ({ centreHz: CENTRE - 30_000 + k * 15_000 })
		h.rec.track(input("u", snapshot("u", at, at + 10, hz(0)), SHADOW))
		h.rec.track(input("d", snapshot("d", at, at + 10, hz(1)), DIGITAL))
		expect(owner(h)).toEqual(["u", "d"])
		// A digital candidate takes nothing.
		h.rec.track(input("e", snapshot("e", at, at + 10, hz(2)), DIGITAL))
		expect(owner(h)).toEqual(["u", "d"])
		// A non-digital shadow takes the digital shadow's slot, not the older unclassed one's.
		h.rec.track(input("s", snapshot("s", at, at + 10, hz(3)), SHADOW))
		expect(owner(h)).toEqual(["u", "s"])
		// A second non-digital shadow finds no digital shadow: refused for slots.
		h.rec.track(input("t", snapshot("t", at, at + 10, hz(4)), SHADOW))
		expect(owner(h)).toEqual(["u", "s"])
		// Classed analog-fm: evicts the oldest unclassed session (no digital one left).
		h.rec.track(input("e2", snapshot("e2", at, at + 10, hz(2))))
		expect(owner(h)).toEqual(["s", "e2"])

		const g = lowHarness()
		g.rec.track(input("u", snapshot("u", at, at + 10, hz(0)), SHADOW))
		g.rec.track(input("d", snapshot("d", at, at + 10, hz(1)), DIGITAL))
		g.rec.track(input("c", snapshot("c", at, at + 10, hz(2))))
		// The digital shadow goes first, though the non-digital one is older.
		expect(owner(g)).toEqual(["u", "c"])
	})
})

describe("close-only analog-fm observations", () => {
	it("an observation classed analog-fm only by its closing snapshot, with no recording, gets refused:close-only bound to its discovery", () => {
		const h = lowHarness()
		const at = 1_000
		h.rec.closed("x", snapshot("x", at, at + 10, LOW), null, {
			analogFm: true,
			discoveryId: "d_x",
		})
		expect(h.rec.discoveryDecisions("d_x")).toMatchObject({
			last: { code: "refused:close-only" },
			counts: { "refused:close-only": 1 },
		})
		// Refused earlier for another class, then classed analog-fm at its close: noted too.
		h.rec.track(
			input("y", snapshot("y", at, at + 10, LOW), {
				analogFm: false,
				discoveryId: "d_y",
			}),
		)
		h.rec.closed("y", snapshot("y", at, at + 10, LOW), null, {
			analogFm: true,
			discoveryId: "d_y",
		})
		expect(h.rec.discoveryDecisions("d_y")).toMatchObject({
			last: { code: "refused:close-only" },
			counts: { "refused:not-analog": 1, "refused:close-only": 1 },
		})
		// A close that is not analog-fm notes nothing new.
		h.rec.closed("z", snapshot("z", at, at + 10, LOW), null, {
			analogFm: false,
			discoveryId: "d_z",
		})
		expect(h.rec.discoveryDecisions("d_z")).toBeNull()
	})
})

/**
 * Synthetic FM signals without speech (data and noise scenes): phase-continuous
 * FM at `offsetHz` with a 67 Hz CTCSS tone at 350 Hz deviation and uniform IQ noise of ±0.035 per
 * component; E(t) = (1 − cos 2π·4t) / 2 is a 4 Hz syllable-rate envelope.
 * - `fade`: only the tone; the RF amplitude fades, amp · (0.15 + 0.85 · E(t)).
 * - `noise`: amplitude 0.4, plus 5000 · E(t) · U(t) Hz of uniform noise deviation.
 * - `keyed`: amplitude `amp`, plus 2400 · E(t) Hz of a square wave switching every 1 / 1600 s
 *   (a periodic waveform keyed at a syllabic rate: the disclosed limit of the speech test).
 * Deterministic LCG (seed 1729, x ← 1664525 · x + 1013904223 mod 2³²), three draws a sample.
 */
class NoSpeechSource implements Source {
	private state = 1729
	private phase = 0
	private sample = 0
	constructor(
		private readonly kind: "fade" | "noise" | "keyed",
		private readonly amp: number,
		private readonly offsetHz = LOW_OFFSET,
	) {}

	next(n: number, on: boolean): Uint8Array {
		const out = new Uint8Array(2 * n)
		for (let i = 0; i < n; i++) {
			const t = this.sample++ / LOW_FS
			const u = 2 * this.draw() - 1
			let re = 0.035 * (2 * this.draw() - 1)
			let im = 0.035 * (2 * this.draw() - 1)
			if (on) {
				const e = (1 - Math.cos(2 * Math.PI * 4 * t)) / 2
				let dev = 350 * Math.sin(2 * Math.PI * 67 * t)
				let a = this.amp
				if (this.kind === "fade") a = this.amp * (0.15 + 0.85 * e)
				else if (this.kind === "noise") dev += 5000 * e * u
				else dev += 2400 * e * (Math.floor(t * 1600) % 2 === 0 ? 1 : -1)
				this.phase =
					(this.phase + (2 * Math.PI * (this.offsetHz + dev)) / LOW_FS) %
					(2 * Math.PI)
				re += a * Math.cos(this.phase)
				im += a * Math.sin(this.phase)
			}
			out[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * re)))
			out[2 * i + 1] = Math.max(
				0,
				Math.min(255, Math.round(127.5 + 127.5 * im)),
			)
		}
		return out
	}

	private draw(): number {
		this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0
		return this.state / 2 ** 32
	}
}

/**
 * A weak voice's mix of frames (synthetic): phase-continuous FM at `offsetHz`, amplitude `amp`
 * (0.04: a carrier-to-noise ratio of 0.04² / (2 · 0.0202² · 12.5 / 96) = 15.4, 11.9 dB in a
 * 12.5 kHz channel, against the uniform IQ noise of ±0.035 per component, σ = 0.035 / √3), with
 * a 67 Hz CTCSS tone at 350 Hz deviation and 4 Hz syllables E(t) = (1 − cos 2π·4t) / 2. One
 * syllable in `every` is pitched (harmonics 3 to 20 of 125 Hz, each 1 / k, 2400 · E(t) Hz); the
 * others are fricative-like noise (2000 · E(t) · U(t) Hz). Measured through the recorder: one in
 * six puts 20 % of its first 40 counted frames over the syllabic index and periodic (classed
 * 3.6 s after its onset) and 15.9 % of 208 by 12 s; one in twenty 4.8 % of 208 (never classed).
 * Deterministic LCG as NoSpeechSource.
 */
class WeakSpeechSource implements Source {
	private state = 4242
	private phase = 0
	private sample = 0
	constructor(
		private readonly every: number,
		private readonly amp = 0.04,
		private readonly offsetHz = LOW_OFFSET,
	) {}

	next(n: number, on: boolean): Uint8Array {
		const out = new Uint8Array(2 * n)
		for (let i = 0; i < n; i++) {
			const t = this.sample++ / LOW_FS
			const u = 2 * this.draw() - 1
			let re = 0.035 * (2 * this.draw() - 1)
			let im = 0.035 * (2 * this.draw() - 1)
			if (on) {
				const e = (1 - Math.cos(2 * Math.PI * 4 * t)) / 2
				let dev = 350 * Math.sin(2 * Math.PI * 67 * t)
				if (Math.floor(t * 4) % this.every === 0) {
					let v = 0
					for (let k = 3; k <= 20; k++)
						v += Math.sin(2 * Math.PI * 125 * k * t) / k
					dev += 2400 * e * v
				} else dev += 2000 * e * u
				this.phase =
					(this.phase + (2 * Math.PI * (this.offsetHz + dev)) / LOW_FS) %
					(2 * Math.PI)
				re += this.amp * Math.cos(this.phase)
				im += this.amp * Math.sin(this.phase)
			}
			out[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * re)))
			out[2 * i + 1] = Math.max(
				0,
				Math.min(255, Math.round(127.5 + 127.5 * im)),
			)
		}
		return out
	}

	private draw(): number {
		this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0
		return this.state / 2 ** 32
	}
}

describe("a weak voice read as digital is classed by its own audio", () => {
	// Feature: wideband analog recorder, own-audio class.
	it(`one pitched syllable in six over CTCSS at 11.9 dB (16 to 20 % periodic frames, over ${PITCH_MIN_SHARE * 100} %) is classed and finalized in one file`, async () => {
		const h = lowHarness()
		await over(h, 15, {
			src: new WeakSpeechSource(6),
			extra: () => ({ spectralDigital: true }),
		})
		expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.ops[0]!.frames).toBeGreaterThan(15 * 8000)
		expect(h.tones).toEqual([])
	}, 120_000)

	it(`one pitched syllable in twenty (5 % periodic frames, under ${PITCH_MIN_SHARE * 100} %) is never classed`, async () => {
		const h = lowHarness()
		await over(h, 15, {
			src: new WeakSpeechSource(20),
			extra: () => ({ spectralDigital: true }),
		})
		expect(codes(h)).toEqual(["shadow", "voiced", "discarded:unclassed"])
		expect(h.ops).toEqual([])
	}, 120_000)
})

describe("a voice classed by its own audio keeps its slot while it is on air and shielded", () => {
	// Feature: wideband analog recorder, own-audio class.
	// Two slots: a voice classed analog-fm in one, a 28 s voice read as digital (classed by its
	// own audio) in the other; a third track arrives 12 s into it.
	for (const [name, third, extra] of [
		[
			"a 4FSK data shadow",
			() =>
				new FskSource({
					fs: LOW_FS,
					offsetHz: 0,
					amp: 0.25,
					seed: 2,
				}),
			DIGITAL,
		],
		[
			"a bare carrier",
			() =>
				new NfmSource({
					fs: LOW_FS,
					offsetHz: 0,
					amp: 0.25,
					voice: false,
					ctcssHz: null,
					seed: 9,
				}),
			SHADOW,
		],
	] as const)
		it(`${name} arriving 12 s in: the shielded 28 s voice (the only one on its source) records to its end`, async () => {
			const h = lowHarness({ amp: 0 })
			const tracks = [
				{
					id: "b",
					hz: CENTRE - 20_000,
					src: new NfmSource({
						fs: LOW_FS,
						offsetHz: -20_000,
						amp: 0.25,
						seed: 5,
						...SPEECH,
						ctcssHz: 100,
					}),
					extra: {} as Partial<WidebandTrackInput>,
				},
				{
					id: "v",
					hz: CENTRE + LOW_OFFSET,
					src: new NfmSource({
						fs: LOW_FS,
						offsetHz: LOW_OFFSET,
						amp: 0.25,
						seed: 3,
						...SPEECH,
					}),
					extra: DIGITAL,
				},
				{ id: "c", hz: CENTRE, src: third(), extra },
			].map(t => ({ ...t, on: false, at: 0 }))
			const [b, v, c] = tracks as [
				(typeof tracks)[0],
				(typeof tracks)[0],
				(typeof tracks)[0],
			]
			const report = () => {
				const edge = h.engine.liveEdge()
				for (const t of tracks)
					if (t.on && edge - t.at >= 0.1 * LOW_FS)
						h.rec.track(
							input(
								t.id,
								snapshot(t.id, t.at, edge, { centreHz: t.hz }),
								t.extra,
							),
						)
			}
			const key = (t: (typeof tracks)[0]) => {
				t.on = true
				t.at = h.engine.liveEdge()
			}
			await feedMix(h, tracks, 0.5, report)
			key(b)
			await feedMix(h, tracks, 0.5, report)
			key(v)
			await feedMix(h, tracks, 12, report)
			key(c)
			await feedMix(h, tracks, 16, report)
			// The third track never took the voice's slot while it was on air.
			expect(h.rec.owns("c")).toBe(false)
			expect(h.rec.owns("v")).toBe(true)
			const end = h.engine.liveEdge()
			for (const t of tracks) t.on = false
			await feedMix(h, tracks, 0.6, () => undefined)
			for (const t of tracks)
				h.rec.closed(
					t.id,
					snapshot(t.id, t.at, end, { centreHz: t.hz }),
					null,
					t === b ? { analogFm: true, discoveryId: "d_1" } : NOT_ANALOG,
				)
			await feedMix(h, tracks, 3.5, () => undefined)
			await h.rec.idle()
			const voice = h.ops.filter(o => o.input.observationId === "v")
			expect(voice.map(o => o.outcome)).toEqual(["finalized"])
			// 28 s over plus the 300 ms pre-roll.
			expect(voice[0]!.frames).toBeGreaterThan(28 * 8000)
			const of = (id: string) =>
				h.rec
					.diagnostics()
					.recent.filter(d => d.observationId === id)
					.map(d => d.code)
			expect(of("v").slice(0, 3)).toEqual(["shadow", "voiced", "classed"])
			expect(of("b")).toEqual(["started", "voiced", "finalized"])
			expect(h.ops.filter(o => o.input.observationId === "c")).toEqual([])
		}, 300_000)
})

describe("classByTone: envelope modulation without speech never self-promotes", () => {
	// Feature: wideband analog recorder, own-audio class.
	const CASES: [string, () => Source][] = [
		[
			"a CTCSS-only carrier fading at 4 Hz, amplitude 0.08",
			() => new NoSpeechSource("fade", 0.08),
		],
		[
			"a CTCSS-only carrier fading at 4 Hz, amplitude 0.16",
			() => new NoSpeechSource("fade", 0.16),
		],
		[
			"syllabically modulated noise over a steady tone",
			() => new NoSpeechSource("noise", 0.4),
		],
	]
	for (const [name, make] of CASES)
		it(`${name}: never classed, never finalized, no tone evidence`, async () => {
			const h = lowHarness({ amp: 0 })
			const src = make()
			await quiet(h, 1, src)
			await over(h, 8, { src, extra: () => DIGITAL })
			expect(h.ops).toEqual([])
			expect(h.tones).toEqual([])
			expect(codes(h)).not.toContain("classed")
			expect(codes(h)).not.toContain("finalized")
		}, 120_000)
})

describe("tone-only files are checked again over the whole file", () => {
	// Feature: wideband analog recorder, own-audio class.
	it("5 s of speech then 11 s of a bare carrier (no tone, no voice) in one over: discarded at its finish, nothing finalized", async () => {
		const h = lowHarness(SPEECH)
		await h.feed(1, false)
		let classedAt: number | null = null
		await over(h, 16, {
			extra: at => {
				if (classedAt === null && codes(h).includes("classed")) classedAt = at
				if (at >= 5) {
					h.src.setVoice(false)
					h.src.setCtcss(null)
				}
				return DIGITAL
			},
		})
		// Classed on its prefix, as before; the whole file fails the tone and speech tests.
		expect(classedAt).not.toBeNull()
		expect(classedAt!).toBeLessThan(5)
		expect(codes(h)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"discarded:unclassed",
		])
		expect(h.ops.every(o => o.outcome !== "finalized")).toBe(true)
		expect(h.tones).toEqual([])
	}, 120_000)

	it("16 s of speech over the tone passes the whole-file check and is finalized", async () => {
		const h = lowHarness(SPEECH)
		await h.feed(1, false)
		await over(h, 16, { extra: () => DIGITAL })
		expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.ops[0]!.frames).toBeGreaterThan(16 * 8000)
	}, 120_000)
})

describe("tone-only sessions keep the lowest slot priority, with a bounded hold", () => {
	// Feature: wideband analog recorder, own-audio class.
	it(`the digital windows end exactly at ${WIDEBAND_DIGITAL_QUALIFY_FRAMES} and ${WIDEBAND_DIGITAL_CLASS_FRAMES} in-track frames`, () => {
		expect(WIDEBAND_DIGITAL_QUALIFY_FRAMES).toBe(24_000)
		// 3 s and 12 s of 8 kHz in-track audio.
		expect(WIDEBAND_DIGITAL_CLASS_FRAMES).toBe(96_000)
		expect(digitalExpiry(false, WIDEBAND_DIGITAL_QUALIFY_FRAMES - 1)).toBeNull()
		expect(digitalExpiry(false, WIDEBAND_DIGITAL_QUALIFY_FRAMES)).toBe(
			"discarded:unvoiced",
		)
		expect(digitalExpiry(true, WIDEBAND_DIGITAL_QUALIFY_FRAMES)).toBeNull()
		expect(digitalExpiry(true, WIDEBAND_DIGITAL_CLASS_FRAMES - 1)).toBeNull()
		expect(digitalExpiry(true, WIDEBAND_DIGITAL_CLASS_FRAMES)).toBe(
			"discarded:unclassed",
		)
	})

	it(`a tone-only session yields to an analog-fm candidate at any age, to any other once it heard ${WIDEBAND_TONE_ONLY_HOLD_FRAMES} frames, or ${WIDEBAND_TONE_ONLY_ON_AIR_FRAMES} while shielded (voice on air, one of the cap − 1 oldest)`, () => {
		// 8 s and 60 s of 8 kHz in-track audio.
		expect(WIDEBAND_TONE_ONLY_HOLD_FRAMES).toBe(64_000)
		expect(WIDEBAND_TONE_ONLY_ON_AIR_FRAMES).toBe(480_000)
		for (const shielded of [false, true]) {
			expect(toneOnlyYields("analog", 0, shielded)).toBe(true)
			const bound = shielded
				? WIDEBAND_TONE_ONLY_ON_AIR_FRAMES
				: WIDEBAND_TONE_ONLY_HOLD_FRAMES
			for (const by of ["shadow", "none"] as const) {
				expect(toneOnlyYields(by, bound - 1, shielded)).toBe(false)
				expect(toneOnlyYields(by, bound, shielded)).toBe(true)
			}
		}
		// Shielded, the 8 s bound does not apply.
		expect(toneOnlyYields("none", WIDEBAND_TONE_ONLY_HOLD_FRAMES, true)).toBe(
			false,
		)
	})

	// Two keyed-data sessions classed by their audio read as voice on air; only one is shielded.
	it("two keyed-data sessions classed by their audio hold both slots; a 5 s voice read as digital arriving 10 s in takes the unshielded one's slot and records", async () => {
		const h = lowHarness({ amp: 0 })
		const a: Keyed = {
			src: new NoSpeechSource("keyed", 0.2, -20_000),
			on: true,
		}
		const b: Keyed = { src: new NoSpeechSource("keyed", 0.2, 0), on: true }
		const v: Keyed = {
			src: new NfmSource({
				fs: LOW_FS,
				offsetHz: LOW_OFFSET,
				amp: 0.25,
				seed: 3,
				...SPEECH,
			}),
			on: false,
		}
		const mix = [a, b, v]
		await feedMix(h, mix, 1, () => undefined)
		const onset = h.engine.liveEdge()
		let voiceAt = 0
		let voiceEnd: number | null = null
		const report = () => {
			const edge = h.engine.liveEdge()
			for (const [id, hz] of [
				["a", CENTRE - 20_000],
				["b", CENTRE],
			] as const)
				h.rec.track(
					input(id, snapshot(id, onset, edge, { centreHz: hz }), DIGITAL),
				)
			if (!v.on || edge - voiceAt < 0.1 * LOW_FS) return
			h.rec.track(
				input("v", snapshot("v", voiceAt, voiceEnd ?? edge, LOW), DIGITAL),
			)
		}
		await feedMix(h, mix, 10, report)
		// The disclosed limit: keyed periodic data over a tone is classed by its audio.
		expect(owner(h)).toEqual(["a", "b"])
		expect(codes(h).filter(c => c === "classed")).toHaveLength(2)
		v.on = true
		voiceAt = h.engine.liveEdge()
		await feedMix(h, mix, 5, report)
		voiceEnd = h.engine.liveEdge()
		v.on = false
		// The voice took a slot while it was on air: the older data session kept the other.
		expect(h.rec.owns("v")).toBe(true)
		expect(h.rec.owns("a")).toBe(true)
		await feedMix(h, mix, 0.6, report)
		h.rec.closed("v", snapshot("v", voiceAt, voiceEnd, LOW), null, NOT_ANALOG)
		a.on = false
		b.on = false
		const end = h.engine.liveEdge()
		await feedMix(h, mix, 0.6, () => undefined)
		for (const [id, hz] of [
			["a", CENTRE - 20_000],
			["b", CENTRE],
		] as const)
			h.rec.closed(
				id,
				snapshot(id, onset, end, { centreHz: hz }),
				null,
				NOT_ANALOG,
			)
		await feedMix(h, mix, 3.5, () => undefined)
		await h.rec.idle()
		const voice = h.ops.filter(o => o.input.observationId === "v")
		expect(voice.map(o => o.outcome)).toEqual(["finalized"])
		// The whole 5 s over (and its 300 ms pre-roll).
		expect(voice[0]!.frames).toBeGreaterThan(5 * 8000)
		const decided = h.rec.diagnostics().recent
		const of = (id: string) =>
			decided.filter(d => d.observationId === id).map(d => d.code)
		// The newer data session (not shielded, past its 8 s hold) yielded, keeping its file.
		expect(of("b").slice(0, 5)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"evicted",
			"finalized",
		])
		expect(of("a").slice(0, 3)).toEqual(["shadow", "voiced", "classed"])
		expect(of("a")).not.toContain("evicted")
		expect(of("v")).toEqual(["shadow", "voiced", "classed", "finalized"])
	}, 300_000)

	// Two data shadows (4FSK, no CTCSS tone) take both slots at the start of each visit of the
	// same channel; a 5 s voice read as digital comes 2 s into each visit.
	it("two unclassed data shadows give their slots to a waiting 5 s voice on every visit: once their file can no longer pass the tone test, and at once when they expired unclassed before", async () => {
		const h = lowHarness({ amp: 0 })
		const data = (offsetHz: number, seed: number): Keyed => ({
			src: new FskSource({
				fs: LOW_FS,
				offsetHz,
				amp: 0.25,
				noiseSigma: 0,
				seed,
			}),
			on: false,
		})
		const a = data(-20_000, 1)
		const b = data(0, 2)
		const v: Keyed = {
			src: new NfmSource({
				fs: LOW_FS,
				offsetHz: LOW_OFFSET,
				amp: 0.25,
				seed: 3,
				...SPEECH,
			}),
			on: false,
		}
		const mix = [a, b, v]
		const ownedAt: { visit: number; at: number }[] = []
		const visit = async (epoch: number, voiceId: string): Promise<void> => {
			h.engine.epoch.epoch = epoch
			const at = { ...LOW, epoch }
			a.on = true
			b.on = true
			const onset = h.engine.liveEdge()
			let voiceAt = 0
			let voiceEnd: number | null = null
			let seen = false
			const report = () => {
				const edge = h.engine.liveEdge()
				for (const [id, hz] of [
					["a", CENTRE - 20_000],
					["b", CENTRE],
				] as const)
					if (edge - onset >= 0.1 * LOW_FS)
						h.rec.track(
							input(
								id,
								snapshot(id, onset, edge, { centreHz: hz, epoch }),
								DIGITAL,
							),
						)
				if (!v.on || edge - voiceAt < 0.1 * LOW_FS) return
				h.rec.track(
					input(
						voiceId,
						snapshot(voiceId, voiceAt, voiceEnd ?? edge, at),
						DIGITAL,
					),
				)
				if (!seen && h.rec.owns(voiceId)) {
					seen = true
					ownedAt.push({ visit: epoch, at: (edge - voiceAt) / LOW_FS })
				}
			}
			await feedMix(h, mix, 2, report)
			expect(owner(h).sort()).toEqual(["a", "b"])
			v.on = true
			voiceAt = h.engine.liveEdge()
			await feedMix(h, mix, 5, report)
			voiceEnd = h.engine.liveEdge()
			v.on = false
			await feedMix(h, mix, 0.6, report)
			h.rec.closed(
				voiceId,
				snapshot(voiceId, voiceAt, voiceEnd, at),
				null,
				NOT_ANALOG,
			)
			// The data stays on to its 13 s window, then the visit ends.
			await feedMix(h, mix, 6.4, report)
			a.on = false
			b.on = false
			const end = h.engine.liveEdge()
			for (const [id, hz] of [
				["a", CENTRE - 20_000],
				["b", CENTRE],
			] as const)
				h.rec.closed(
					id,
					snapshot(id, onset, end, { centreHz: hz, epoch }),
					null,
					NOT_ANALOG,
				)
			await feedMix(h, mix, 3.5, () => undefined)
			await h.rec.idle()
		}
		await visit(1, "v1")
		await visit(2, "v2")
		for (const id of ["v1", "v2"]) {
			const voice = h.ops.filter(o => o.input.observationId === id)
			expect(voice.map(o => o.outcome)).toEqual(["finalized"])
			expect(voice[0]!.frames).toBeGreaterThan(5 * 8000)
		}
		// Visit 1: the 4FSK file holds no standard tone, so it cannot be classed by its audio past
		// 2.5 s of in-track audio (judged 1 s late); visit 2: stale, its slot goes at once.
		expect(ownedAt.map(o => o.visit)).toEqual([1, 2])
		expect(ownedAt[0]!.at).toBeLessThan(2.5)
		expect(ownedAt[1]!.at).toBeLessThan(0.2)
		const decided = h.rec.diagnostics().recent
		const of = (id: string) =>
			decided.filter(d => d.observationId === id).map(d => d.code)
		// One data shadow yields each visit (an expiry of that visit), the other runs its window.
		expect([...of("a"), ...of("b")].filter(c => c === "evicted")).toHaveLength(
			2,
		)
		expect(h.ops.filter(o => !o.input.observationId.startsWith("v"))).toEqual(
			[],
		)
	}, 300_000)
})
