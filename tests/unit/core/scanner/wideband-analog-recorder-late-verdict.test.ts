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
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import type { WidebandTrackInput } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { DecodedLabel } from "../../../../src/core/scanner/channel/voice-veto.js"
import type {
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
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
	p: Partial<Omit<VoicePrior, "analogVoice">> & { analogVoice?: boolean },
): VoicePrior {
	return {
		labels: p.labels ?? [],
		class: p.class ?? "unknown",
		analogVoice: () => p.analogVoice ?? false,
	}
}

const label = (
	protocol: ScannerProtocol,
	owner = true,
	confidence: ScannerConfidence = "decoded",
) => ({ protocol, confidence, owner })
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
): Promise<void> {
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
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
		analogFm: true,
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
		expect(codes(h)).toEqual(["shadow", "voiced", "discarded:not-analog"])
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
		expect(codes(h)).toContain("discarded:not-analog")
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
		expect(ends).toEqual(["discarded:not-analog"])
		expect(h.rec.owns("o")).toBe(false)
	}, 120_000)

	it("a second provisional file on the source (past MAX_PROVISIONAL_PER_SOURCE = 1) ends the first one's grace (kept)", async () => {
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

	it("M2: at a cap of 1 recording, a held file gives its slot to a new voice: the voice is recorded, the held file finalized", async () => {
		// cpuBudgetCores 0.3 at 96 kHz: floor(0.25 × 0.3 × 1000 / (50 + 9 × 0.096)) = floor(1.47) = 1.
		const h = low(() => spectral("fsk2-wide"), null, { budget: 0.3 })
		await h.feed(1, false)
		await over(h, "a", 4)
		expect(h.ops.map(o => o.outcome)).toEqual([null])
		expect(h.rec.activeOn("rtl")).toBe(1)
		await over(h, "b", 4)
		expect(h.ops[0]!.outcome).toBe("finalized")
		expect(h.ops).toHaveLength(2)
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "finalized"])
		// Its whole over: 4 s + 0.3 s pre-roll at least (the 3 s ring covered the slot's wait).
		expect(h.ops[1]!.frames / 8000).toBeGreaterThanOrEqual(4.25)
	}, 120_000)

	it("stop ends every grace: a held file is finished, its final verdict applied", async () => {
		const h = low(() => spectral("fsk2-wide"))
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.stop()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)
})
