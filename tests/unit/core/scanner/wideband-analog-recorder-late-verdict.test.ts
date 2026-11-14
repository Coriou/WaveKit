/**
 * A recording is provisional until its discovery's verdict settles (recording-verdict.ts): a
 * standing non-voice prior (a decode of the discovery or a co-channel one at any time, or a
 * decode- or channel-tier-backed digital class seen on it) refuses it at admission; a suspect
 * prior (a spectral digital class, a digital-unknown candidate) holds a written file for
 * LATE_VERDICT_GRACE_MS, a non-voice verdict within it discards the file, none keeps it; analog
 * voice heard on the channel, or a CTCSS tone over the file's own audio, always keeps it.
 */
import { describe, expect, it } from "vitest"
import {
	LATE_VERDICT_GRACE_MS,
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import type { WidebandTrackInput } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { ScannerClass } from "../../../../src/core/scanner/types.js"
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

const spectral = (c: ScannerClass): VoicePrior => prior({ class: c })
const pocsagDecoded = prior({
	labels: [{ protocol: "pocsag", confidence: "decoded" }],
})

/** A mutable prior (a decode can land while a file is held). */
function priorBox(start: VoicePrior | null) {
	const box = { value: start }
	return { box, voicePrior: () => box.value }
}

const low = (
	voicePrior: ((id: string) => VoicePrior | null) | undefined,
	ctcssHz: number | null = null,
): Harness =>
	harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source: { ctcssHz },
		decodedProtocol: () => null,
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

describe("admission: a standing non-voice prior refuses", () => {
	it("a discovery decoded POCSAG at any earlier time refuses a later analog-fm burst (nothing written)", async () => {
		const h = low(() => pocsagDecoded)
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
		expect(refusals(h)).toContain("refused:not-analog")
	}, 120_000)

	it("a co-channel discovery decoded DMR refuses it too", async () => {
		const h = low(() =>
			prior({
				labels: [
					{ protocol: "unknown", confidence: "activity" },
					{ protocol: "dmr", confidence: "decoded" },
				],
			}),
		)
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
	}, 120_000)

	it("a channel-tier digital class seen on the discovery refuses its next analog-fm over", async () => {
		const h = low(() => prior({}))
		await h.feed(1, false)
		// An earlier observation of d_1 whose 4FSK class the channel tier backs.
		h.rec.track(
			input("o_dig", snapshot("o_dig", 0, 100, LOW), {
				analogFm: false,
				nonAnalog: true,
				digitalClass: true,
			}),
		)
		await over(h, "o", 4)
		await h.rec.idle()
		expect(h.ops).toHaveLength(0)
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
		const h = low(() =>
			prior({
				labels: [{ protocol: "dmr", confidence: "decoded" }],
				analogVoice: true,
			}),
		)
		await h.feed(1, false)
		await over(h, "o", 5)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.timers).toHaveLength(0)
	}, 120_000)

	for (const [name, p] of [
		["a spectral-only fsk4 class", spectral("fsk4-12k5")],
		[
			"a digital-unknown candidate",
			prior({
				labels: [{ protocol: "digital-unknown", confidence: "candidate" }],
			}),
		],
		[
			"a dsd-fme sync hint (DMR below decoded)",
			prior({ labels: [{ protocol: "dmr", confidence: "activity" }] }),
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
	it("a POCSAG decode landing after the finish, before the grace ends, discards the held file", async () => {
		const { box, voicePrior } = priorBox(spectral("fsk2-wide"))
		const h = low(voicePrior)
		await h.feed(1, false)
		await over(h, "o", 4)
		expect(h.ops[0]!.outcome).toBeNull()
		// The decode lands inside the grace (the timer has not fired yet).
		box.value = prior({
			class: "fsk2-wide",
			labels: [{ protocol: "pocsag", confidence: "decoded" }],
		})
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["aborted"])
		expect(codes(h)).toContain("discarded:not-analog")
		expect(codes(h)).not.toContain("finalized")
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

	it("stop ends every grace: a held file is finished, its final verdict applied", async () => {
		const h = low(() => spectral("fsk2-wide"))
		await h.feed(1, false)
		await over(h, "o", 4)
		await h.rec.stop()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)
})
