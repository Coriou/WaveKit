/**
 * A recording is provisional until its discovery's verdict settles (recording-verdict.ts): a
 * strong prior (a pager or data decode of the discovery or a co-channel one) admits it only as a
 * shadow its own audio must class (speech over a CTCSS tone); a suspect prior (a digital voice
 * decode of the discovery or a co-channel one, a backed digital class seen on two of its
 * observations, a spectral digital class, a digital-unknown candidate) holds a
 * written file for LATE_VERDICT_GRACE_MS, and only a decode of that file's own signal discards
 * it; analog voice heard on the channel, or a CTCSS tone over the file's own audio, always keeps
 * it.
 */
import { describe, expect, it } from "vitest"
import {
	LATE_VERDICT_GRACE_MS,
	STRONG_PRIOR_TTL_MS,
	type ClassVotes,
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	WIDEBAND_MAX_FILE_MS,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { DecodedLabel } from "../../../../src/core/scanner/channel/voice-veto.js"
import type {
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	HARNESS_T0,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

const LOW = { centreHz: 100_000_000 + LOW_OFFSET }

const codes = (h: Harness): string[] =>
	h.rec.diagnostics().recent.map(d => d.code)
const refusals = (h: Harness): string[] =>
	(h.rec.diagnostics().recentRefusals ?? []).map(d => d.code)

function prior(
	p: Partial<Omit<VoicePrior, "analogVoice" | "classVotes">> & {
		analogVoice?: boolean
		votes?: ClassVotes
	},
): VoicePrior {
	const votes = p.votes
	return {
		labels: p.labels ?? [],
		class: p.class ?? "unknown",
		analogVoice: () => p.analogVoice ?? false,
		...(votes ? { classVotes: () => votes } : {}),
	}
}

/** A label decoded at the harness's (fixed) wall clock: a recent decode. */
const label = (
	protocol: ScannerProtocol,
	owner = true,
	confidence: ScannerConfidence = "decoded",
	at: number | null = HARNESS_T0,
) => ({ protocol, confidence, owner, at })
const spectral = (c: ScannerClass): VoicePrior => prior({ class: c })
const pocsagDecoded = prior({ labels: [label("pocsag")] })
const coChannelDmr = prior({
	labels: [label("unknown", true, "activity"), label("dmr", false)],
})

/** A mutable prior (a decode can land while a file is held). */
function priorBox(start: VoicePrior | null) {
	const box = { value: start }
	return { box, voicePrior: () => box.value }
}

const low = (
	voicePrior: ((id: string) => VoicePrior | null) | undefined,
	ctcssHz: number | null = null,
	more: {
		decodedLabel?: (id: string) => DecodedLabel | null
		budget?: number
		syllables?: boolean
	} = {},
): Harness =>
	harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source: { ctcssHz, syllables: more.syllables ?? false },
		decodedLabel: more.decodedLabel ?? (() => null),
		...(more.budget !== undefined ? { budget: more.budget } : {}),
		...(voicePrior ? { voicePrior } : {}),
	})

/** One analog-fm over of `seconds` by observation `id`, closed, then 3.5 s of quiet (no idle). */
async function over(
	h: Harness,
	id: string,
	seconds: number,
	extra: Partial<WidebandTrackInput> = {},
	/** Runs before each 25 ms chunk `i` of the over is written. */
	each?: (i: number) => void,
): Promise<void> {
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
		each?.(i)
		h.engine.write(h.src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(
				input(id, snapshot(id, onset, Math.min(edge, end), LOW), extra),
			)
		await h.pump()
	}
	await h.feed(0.6, false)
	h.rec.closed(id, snapshot(id, onset, end, LOW), null, {
		analogFm: extra.analogFm ?? true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
}

describe("admission: a strong prior admits only a shadow its own audio must class", () => {
	it("a discovery decoded POCSAG at any earlier time: a later analog-fm burst without a tone writes nothing, and is not a remembered refusal", async () => {
		const h = low(() => pocsagDecoded)
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
		expect(codes(h)).toEqual(["shadow", "voiced", "discarded:known-non-voice"])
		expect(refusals(h)).not.toContain("refused:not-analog")
	}, 120_000)

	it("a co-channel discovery decoded POCSAG (pager anywhere): the same shadow, nothing written", async () => {
		const h = low(() => prior({ labels: [label("pocsag", false)] }))
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
	}, 120_000)

	it("FROZEN: speech over a CTCSS tone on a POCSAG-decoded channel is classed by its own audio and kept", async () => {
		const h = low(() => pocsagDecoded, 88.5, { syllables: true })
		await h.feed(1, false)
		await over(h, "o", 6)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
	}, 120_000)

	it("m2: a tone-classed over on a POCSAG-decoded channel rolls over at WIDEBAND_MAX_FILE_MS; its next file, with no tone heard in it, is kept (the session's tone class)", async () => {
		const h = low(() => pocsagDecoded, 88.5, { syllables: true })
		await h.feed(1, false)
		// The tone stops 0.5 s past the roll-over (the first file ends 0.3 s pre-roll earlier).
		const drop = Math.round(((WIDEBAND_MAX_FILE_MS + 500) / 1000) * 40)
		// A shadow no snapshot classes analog-fm (weak NFM read as a narrow digital class).
		const shadow = { analogFm: false, shadowAllowed: true }
		await over(h, "o", WIDEBAND_MAX_FILE_MS / 1000 + 8, shadow, i => {
			if (i === drop) h.src.setCtcss(null)
		})
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
	}, 120_000)

	it("FROZEN: a DMR decode of the discovery itself (a lone merge of analog and DMR overs) never bars a voice with no tone: held, then kept", async () => {
		const h = low(() => prior({ labels: [label("dmr")] }))
		await h.feed(1, false)
		await over(h, "o", 5)
		expect(h.ops).toHaveLength(1)
		expect(h.timers.map(t => t.ms)).toEqual([LATE_VERDICT_GRACE_MS])
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	for (const [n, held] of [
		[1, false],
		[2, true],
	] as const)
		it(`${n} channel-tier digital observation(s) of the discovery: the next analog-fm over is ${held ? "held (a suspect prior), then kept" : "kept at once (no prior)"}`, async () => {
			const h = low(() => prior({}))
			await h.feed(1, false)
			for (let k = 0; k < n; k++)
				h.rec.track(
					input(`o_dig${k}`, snapshot(`o_dig${k}`, 0, 100, LOW), {
						analogFm: false,
						nonAnalog: true,
						digitalClass: true,
					}),
				)
			await over(h, "o", 4)
			expect(h.timers).toHaveLength(held ? 1 : 0)
			await h.fire()
			await h.rec.idle()
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		}, 120_000)

	it("without the prior lookup (base behaviour) the same burst is recorded and finalized", async () => {
		const h = low(undefined)
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)
})

describe("a digital channel: the owner's own recent digital proof, its protocol's class votes, no analog proof", () => {
	// Synthetic: a checked dsd-fme sync hint of the owner (TG/SRC verified) a minute old, most
	// class votes 4FSK 12.5 kHz.
	const recent = HARNESS_T0 - 60_000
	const hoursAgo = HARNESS_T0 - 5 * 60 * 60_000
	const syncHint = {
		...label("dmr", true, "activity", recent),
		checkedHint: true,
	}
	const fsk = (n: number, total: number, c: ScannerClass = "fsk4-12k5") => ({
		total,
		votes: { [c]: n },
	})
	const digital = (more: Parameters<typeof prior>[0] = {}) =>
		prior({
			labels: [syncHint],
			class: "fsk4-12k5",
			votes: fsk(200, 240),
			...more,
		})

	it("A: a recent checked sync hint and a 4FSK channel: a later analog-fm over without a tone is a shadow, discarded as known non-voice", async () => {
		const h = low(() => digital())
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
		expect(codes(h)).toEqual(["shadow", "voiced", "discarded:known-non-voice"])
		expect(refusals(h)).not.toContain("refused:not-analog")
	}, 120_000)

	it("FROZEN: speech over a CTCSS tone on that channel is classed by its own audio and kept", async () => {
		const h = low(() => digital(), 88.5, { syllables: true })
		await h.feed(1, false)
		await over(h, "o", 6)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
	}, 120_000)

	it("FROZEN: an analog proof on the channel (a mixed PMR channel) keeps the untoned voice at once", async () => {
		const h = low(() => digital({ analogVoice: true }))
		await h.feed(1, false)
		await over(h, "o", 5)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.timers).toHaveLength(0)
	}, 120_000)

	it("a decoded DMR label of the owner counts alike", async () => {
		const h = low(() =>
			digital({ labels: [label("dmr", true, "decoded", recent)] }),
		)
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
		expect(codes(h)).toContain("discarded:known-non-voice")
	}, 120_000)

	it("an analog-fm stored class with a third of its votes FSK and the owner's sync hint (analog-read DMR): a shadow, discarded", async () => {
		const h = low(() => digital({ class: "analog-fm", votes: fsk(120, 250) }))
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
		expect(codes(h)).toContain("discarded:known-non-voice")
	}, 120_000)

	// A2: a checked DMR sync hint (digital-undecoded, TG/SRC verified) on a 4FSK channel; A3: a
	// digital-unknown candidate (data-like audio, digital-undecoded) on a wide 2FSK channel; a
	// checked dPMR label on a 4FSK 6.25 kHz channel. None ever had an analog proof.
	for (const [name, base] of [
		["A2: a checked DMR sync hint, class fsk4-12k5", digital()],
		[
			"a checked dPMR sync hint, class fsk4-6k25",
			digital({
				labels: [{ ...syncHint, protocol: "dpmr" }],
				class: "fsk4-6k25",
				votes: fsk(200, 240, "fsk4-6k25"),
			}),
		],
		[
			"A3: a digital-unknown candidate, class fsk2-wide",
			digital({
				labels: [label("digital-unknown", true, "candidate", recent)],
				class: "fsk2-wide",
				votes: fsk(200, 240, "fsk2-wide"),
			}),
		],
	] as const) {
		it(`${name}: an untoned over is a shadow, discarded as known non-voice`, async () => {
			const h = low(() => base)
			await h.feed(1, false)
			await over(h, "o", 4)
			await h.rec.idle()
			expect(h.ops).toHaveLength(0)
			expect(codes(h)).toEqual([
				"shadow",
				"voiced",
				"discarded:known-non-voice",
			])
		}, 120_000)

		it(`FROZEN: ${name}: an analog proof on the channel keeps the untoned voice at once`, async () => {
			const h = low(() => ({ ...base, analogVoice: () => true }))
			await h.feed(1, false)
			await over(h, "o", 5)
			await h.rec.idle()
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(h.timers).toHaveLength(0)
		}, 120_000)

		it(`FROZEN: ${name}: speech over its own CTCSS tone is kept`, async () => {
			const h = low(() => base, 88.5, { syllables: true })
			await h.feed(1, false)
			await over(h, "o", 6)
			await h.rec.idle()
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
		}, 120_000)
	}

	for (const [name, p] of [
		[
			"no digital proof of the owner (a 4FSK class from spectral votes alone)",
			prior({ class: "fsk4-12k5", votes: fsk(170, 256) }),
		],
		[
			"the sync hint on a co-channel discovery only",
			prior({
				labels: [{ ...syncHint, owner: false }],
				class: "fsk4-12k5",
				votes: fsk(200, 240),
			}),
		],
		[
			"under a third of the owner's votes FSK",
			prior({
				labels: [syncHint],
				class: "analog-fm",
				votes: fsk(70, 240),
			}),
		],
		[
			"fewer than DIGITAL_CHANNEL_MIN_VOTES class votes",
			prior({
				labels: [syncHint],
				class: "fsk4-12k5",
				votes: fsk(3, 3),
			}),
		],
		[
			"an unchecked sync hint, only fsk4-6k25 votes",
			prior({
				labels: [label("dpmr", true, "activity", recent)],
				class: "fsk4-6k25",
				votes: fsk(240, 240, "fsk4-6k25"),
			}),
		],
		[
			"an unchecked DMR sync hint on a 4FSK channel",
			prior({
				labels: [label("dmr", true, "activity", recent)],
				class: "fsk4-12k5",
				votes: fsk(240, 240),
			}),
		],
		[
			"a checked DMR sync hint, fsk4-6k25 votes (no DMR class)",
			prior({
				labels: [syncHint],
				class: "fsk4-6k25",
				votes: fsk(240, 240, "fsk4-6k25"),
			}),
		],
		[
			"a digital-unknown candidate, fsk4-6k25 votes only",
			prior({
				labels: [label("digital-unknown", true, "candidate", recent)],
				class: "fsk4-6k25",
				votes: fsk(240, 240, "fsk4-6k25"),
			}),
		],
		[
			"a checked sync hint 1 ms older than STRONG_PRIOR_TTL_MS",
			prior({
				labels: [{ ...syncHint, at: HARNESS_T0 - STRONG_PRIOR_TTL_MS - 1 }],
				class: "fsk4-12k5",
				votes: fsk(240, 240),
			}),
		],
		[
			"a DMR decode five hours old",
			prior({
				labels: [label("dmr", true, "decoded", hoursAgo)],
				class: "fsk4-12k5",
				votes: fsk(240, 240),
			}),
		],
		[
			"an undated checked sync hint",
			prior({
				labels: [{ ...syncHint, at: null }],
				class: "fsk4-12k5",
				votes: fsk(240, 240),
			}),
		],
	] as const)
		it(`FROZEN: ${name}: suspect only, the untoned voice is held, then kept`, async () => {
			const h = low(() => p)
			await h.feed(1, false)
			await over(h, "o", 5)
			expect(h.ops).toHaveLength(1)
			expect(h.timers.map(t => t.ms)).toEqual([LATE_VERDICT_GRACE_MS])
			await h.fire()
			await h.rec.idle()
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		}, 120_000)
})

describe("frozen voice: weak or mixed priors never lose a voice", () => {
	it("a mixed repeater (decoded DMR, analog voice heard on the channel) records and keeps the voice at once", async () => {
		const h = low(() => prior({ labels: [label("dmr")], analogVoice: true }))
		await h.feed(1, false)
		await over(h, "o", 5)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.timers).toHaveLength(0)
	}, 120_000)

	for (const [name, p] of [
		["a co-channel DMR decode (PMR446 / DMR446 sharing)", coChannelDmr],
		["a spectral-only fsk4 class", spectral("fsk4-12k5")],
		[
			"a digital-unknown candidate",
			prior({ labels: [label("digital-unknown", true, "candidate")] }),
		],
		[
			"a dsd-fme sync hint (DMR below decoded)",
			prior({ labels: [label("dmr", true, "activity")] }),
		],
	] as const)
		it(`an NFM voice with no CTCSS on a channel whose prior is only ${name} is held, then kept after the grace`, async () => {
			const h = low(() => p)
			await h.feed(1, false)
			await over(h, "o", 5)
			// Held provisional: its operation is open, no finish asked yet.
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.cut).toBeNull()
			expect(h.timers.map(t => t.ms)).toEqual([LATE_VERDICT_GRACE_MS])
			await h.fire()
			await h.rec.idle()
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(codes(h)).toContain("finalized")
		}, 120_000)

	it("an NFM voice over a CTCSS tone on a suspect channel is kept at once (no hold)", async () => {
		const h = low(() => spectral("fsk4-12k5"), 88.5)
		await h.feed(1, false)
		await over(h, "o", 6)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.timers).toHaveLength(0)
	}, 120_000)

	it("a channel with no prior keeps its voice at once (no hold)", async () => {
		const h = low(() => null)
		await h.feed(1, false)
		await over(h, "o", 5)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.timers).toHaveLength(0)
	}, 120_000)
})

describe("late verdict within the grace", () => {
	it("a POCSAG decode of the file's own observation landing in the grace discards the held file", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		let decode: DecodedLabel | null = null
		const h = low(voicePrior, null, { decodedLabel: () => decode })
		await h.feed(1, false)
		await over(h, "o", 4)
		expect(h.ops[0]!.outcome).toBeNull()
		// The decode lands inside the grace (the timer has not fired yet), citing the burst.
		box.value = prior({ class: "fsk2-wide", labels: [label("pocsag")] })
		decode = { protocol: "pocsag", at: h.now(), observationId: "o" }
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["aborted"])
		expect(codes(h)).toContain("discarded:late-non-voice")
		expect(codes(h)).not.toContain("finalized")
	}, 120_000)

	it("B2: a pager decode on the channel that names no transmission, after another transmission keyed up, keeps a snapshot-classed file", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		let decode: DecodedLabel | null = null
		const h = low(voicePrior, null, { decodedLabel: () => decode })
		await h.feed(1, false)
		await over(h, "o", 4)
		// Another transmission on the same channel during the grace.
		h.rec.track(
			input(
				"other",
				snapshot("other", h.engine.liveEdge(), h.engine.liveEdge() + 10, LOW),
				{
					analogFm: false,
					discoveryId: "d_2",
				},
			),
		)
		box.value = prior({ class: "fsk2-wide", labels: [label("pocsag")] })
		decode = { protocol: "pocsag", at: h.now(), observationId: "decode:d_1" }
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("B2: a DMR user keying after an analog over within the grace (decode of the DMR over) never discards the analog file", async () => {
		const { box, voicePrior } = priorBox(coChannelDmr)
		let decode: DecodedLabel | null = null
		const h = low(voicePrior, null, { decodedLabel: () => decode })
		await h.feed(1, false)
		await over(h, "o", 4)
		expect(h.ops[0]!.outcome).toBeNull()
		// The lone discovery now carries the DMR over's decode (merged: the owner's label).
		box.value = prior({ labels: [label("dmr"), label("dmr", false)] })
		decode = { protocol: "dmr", at: h.now(), observationId: "dmr-over" }
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("a strong prior arriving in the grace with no decode of the file itself keeps a snapshot-classed file", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		const h = low(voicePrior)
		await h.feed(1, false)
		await over(h, "o", 4)
		box.value = pocsagDecoded
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("a decode landing after the grace ended changes nothing: the file stays finalized", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		const h = low(voicePrior)
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.fire()
		await h.rec.idle()
		box.value = pocsagDecoded
		await h.feed(1, false)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("m4: discarding a held file of an ended session notes one decision and reopens nothing", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		let decode: DecodedLabel | null = null
		const h = low(voicePrior, null, { decodedLabel: () => decode })
		await h.feed(1, false)
		await over(h, "o", 4)
		expect(h.rec.owns("o")).toBe(false)
		decode = { protocol: "pocsag", at: h.now(), observationId: "o" }
		box.value = pocsagDecoded
		await h.fire()
		await h.rec.idle()
		// Released twice (a stray second grace end, stop): nothing more happens.
		await h.fire()
		await h.rec.stop()
		await h.feed(1, false)
		expect(h.ops).toHaveLength(1)
		expect(h.ops.map(o => o.outcome)).toEqual(["aborted"])
		const ends = codes(h).filter(
			c => c.startsWith("discarded") || c === "finalized",
		)
		expect(ends).toEqual(["discarded:late-non-voice"])
		expect(h.rec.owns("o")).toBe(false)
	}, 120_000)

	it("a second provisional file on the source (past provisionalRoom(2) = 1) ends the first one's grace (kept)", async () => {
		const h = low(() => spectral("fsk2-wide"))
		await h.feed(1, false)
		await over(h, "a", 4)
		expect(h.ops.map(o => o.outcome)).toEqual([null])
		await h.feed(3, false)
		await over(h, "b", 4)
		await h.feed(0.5, false)
		// At the bound one is held; the second hold released the first.
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", null])
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "finalized"])
	}, 120_000)

	it("M2: at a cap of 1 recording nothing is held (provisionalRoom(1) = 0): a file under a suspect prior is finalized at once and the next voice is recorded whole", async () => {
		// cpuBudgetCores 0.3 at 96 kHz: floor(0.25 × 0.3 × 1000 / (50 + 9 × 0.096)) = floor(1.47) = 1.
		const h = low(() => spectral("fsk2-wide"), null, { budget: 0.3 })
		await h.feed(1, false)
		await over(h, "a", 4)
		expect(h.timers).toHaveLength(0)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.rec.activeOn("rtl")).toBe(0)
		await over(h, "b", 4)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "finalized"])
		expect(h.timers).toHaveLength(0)
		expect(refusals(h)).not.toContain("refused:slots")
		// Its whole over: 4 s + 0.3 s pre-roll at least.
		expect(h.ops[1]!.frames / 8000).toBeGreaterThanOrEqual(4.25)
	}, 120_000)

	/**
	 * At a cap of 2 (budget 1 core at 96 kHz: floor(250 / 50.9) = 4 → 2): a file held on the
	 * channel, a live session on a second channel, then a candidate on a third channel finding
	 * both slots taken.
	 */
	const fullSource = async (
		candidate: Partial<WidebandTrackInput>,
		strong = false,
	) => {
		const h = low(id =>
			strong && id === "d_c" ? pocsagDecoded : spectral("fsk2-wide"),
		)
		await h.feed(1, false)
		await over(h, "a", 4)
		expect(h.ops.map(o => o.outcome)).toEqual([null])
		const on = h.engine.liveEdge()
		const at = (id: string, hz: number, extra: Partial<WidebandTrackInput>) =>
			h.rec.track(
				input(id, snapshot(id, on, h.engine.liveEdge(), { centreHz: hz }), {
					discoveryId: `d_${id}`,
					...extra,
				}),
			)
		await h.feed(0.3, false, () => at("b", 100_000_000 - 20_000, {}))
		expect(h.rec.activeOn("rtl")).toBe(2)
		await h.feed(0.5, false, () => {
			at("b", 100_000_000 - 20_000, {})
			at("c", 100_000_000 - 5_000, candidate)
		})
		return h
	}

	for (const [name, candidate] of [
		[
			"an unclassed shadow (weak NFM read as a narrow digital class)",
			{ analogFm: false, shadowAllowed: true, spectralDigital: true },
		],
		[
			"an unclassed shadow with no spectral class",
			{ analogFm: false, shadowAllowed: true },
		],
		["a track classed analog-fm", {}],
	] as const)
		it(`M2: at a cap of 2, ${name} finding every slot taken ends the held file's grace (kept) and is then recorded`, async () => {
			const h = await fullSource(candidate)
			expect(h.ops[0]!.outcome).toBe("finalized")
			expect(h.rec.owns("c")).toBe(true)
			expect(
				h.rec
					.diagnostics()
					.recent.filter(d => d.observationId === "c")
					.map(d => d.code)[0],
			).toMatch(/^(?:started|shadow)$/)
		}, 120_000)

	it("M2: a candidate known non-voice (a shadow under a strong prior) never ends a hold: it waits for the slot", async () => {
		const h = await fullSource({ analogFm: true }, true)
		// d_c's pager decode makes c a tone-required shadow: the held file stays held.
		expect(h.ops[0]!.outcome).toBeNull()
		expect(h.rec.owns("c")).toBe(false)
		expect(refusals(h)).toContain("refused:slots")
		await h.fire()
		await h.rec.idle()
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 120_000)

	it("stop ends every grace: a held file is finished, its final verdict applied", async () => {
		const h = low(() => spectral("fsk2-wide"))
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.stop()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)
})

/**
 * Two transmissions on one channel: `a` for `aSeconds`, closed at its end, `gap` s of quiet,
 * `beforeB` (a decode landing, the prior changing), then `b` for `bSeconds` (joining `a`'s session
 * within its 2 s hang), closed 600 ms late, then 3.5 s of quiet.
 */
async function twoOvers(
	h: Harness,
	a: string,
	aSeconds: number,
	gap: number,
	b: string,
	bSeconds: number,
	beforeB?: () => void,
): Promise<void> {
	const one = async (id: string, seconds: number) => {
		const on = h.engine.liveEdge()
		await h.feed(seconds, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - on >= 0.1 * h.fs)
				h.rec.track(input(id, snapshot(id, on, edge, LOW)))
		})
		return { on, end: h.engine.liveEdge() }
	}
	const ta = await one(a, aSeconds)
	h.rec.closed(a, snapshot(a, ta.on, ta.end, LOW), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(gap, false)
	beforeB?.()
	const tb = await one(b, bSeconds)
	await h.feed(0.6, false)
	h.rec.closed(b, snapshot(b, tb.on, tb.end, LOW), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
}

describe("joined transmissions and late verdicts", () => {
	it("M1: a pager owner burst (read analog-fm), an analog reply joined in its hang, the owner's decode landing in the grace: the reply's audio survives", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		let decode: DecodedLabel | null = null
		const h = low(voicePrior, null, { decodedLabel: () => decode })
		await h.feed(1, false)
		await twoOvers(h, "o", 3, 0.2, "r", 4)
		// The owner's decode lands (the store's prior turns strong), citing the burst.
		box.value = pocsagDecoded
		decode = { protocol: "pocsag", at: h.now(), observationId: "o" }
		await h.fire()
		await h.rec.idle()
		const kept = h.ops.filter(o => o.outcome === "finalized")
		// The reply's whole 4 s is in a kept file.
		expect(kept.length).toBeGreaterThanOrEqual(1)
		expect(Math.max(...kept.map(o => o.frames)) / 8000).toBeGreaterThanOrEqual(
			4,
		)
		expect(codes(h)).not.toContain("discarded:late-non-voice")
	}, 120_000)

	it("without a joined voice the owner's decode in the grace still discards its file late", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		let decode: DecodedLabel | null = null
		const h = low(voicePrior, null, { decodedLabel: () => decode })
		await h.feed(1, false)
		await over(h, "o", 3)
		box.value = pocsagDecoded
		decode = { protocol: "pocsag", at: h.now(), observationId: "o" }
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["aborted"])
		expect(codes(h)).toContain("discarded:late-non-voice")
	}, 120_000)

	it("item 5: a burst keying up in an earlier burst's hang after the channel's pager decode landed is a shadow: its file is discarded as known non-voice", async () => {
		const { box, voicePrior } = priorBox(null)
		const h = low(voicePrior)
		await h.feed(1, false)
		await twoOvers(h, "p0", 4, 2.1, "p1", 4, () => {
			box.value = pocsagDecoded
		})
		await h.fire()
		await h.rec.idle()
		// p0's file (kept: nothing marked the channel when it ran); p1's discarded.
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "aborted"])
		expect(codes(h)).toContain("discarded:known-non-voice")
		// p1 joined p0's session (no session of its own was started or shadowed).
		expect(codes(h)).not.toContain("shadow")
		expect(codes(h).filter(c => c === "started")).toHaveLength(1)
	}, 120_000)

	it("FROZEN: speech over a CTCSS tone keying up in the hang of a pager-decoded channel's session is kept", async () => {
		const { box, voicePrior } = priorBox(null)
		const h = low(voicePrior, 88.5, { syllables: true })
		await h.feed(1, false)
		await twoOvers(h, "p0", 4, 2.1, "v", 6, () => {
			box.value = pocsagDecoded
		})
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "finalized"])
	}, 120_000)

	it("a joined transmission's files are judged on the prior when it keyed up: a lapsed pager decode (past STRONG_PRIOR_TTL_MS) only holds them, then keeps them", async () => {
		const lapsed = prior({
			labels: [
				label("pocsag", true, "decoded", HARNESS_T0 - STRONG_PRIOR_TTL_MS - 1),
			],
		})
		const { box, voicePrior } = priorBox(null)
		const h = low(voicePrior)
		await h.feed(1, false)
		await twoOvers(h, "p0", 4, 2.1, "p1", 4, () => {
			box.value = lapsed
		})
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "finalized"])
	}, 120_000)
})
