/**
 * The analog recorder's refusal and discard policy (recording-verdict.ts): one row per outcome,
 * refuse and keep rows both, and a property: a prior with only weak evidence never refuses or
 * discards.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	LATE_VERDICT_GRACE_MS,
	MAX_PROVISIONAL_PER_SOURCE,
	admissionVerdict,
	barredSnapshot,
	decodeDuring,
	finishVerdict,
	notVoiceDecode,
	readPrior,
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	IDENTIFY_DEFAULT_TIMEOUT_MS,
	IDENTIFY_QUEUE_WAIT_MS,
	IDENTIFY_SLOT_FREEING_MAX_MS,
} from "../../../../src/core/scanner/identify.js"
import { MAX_ACTIVE_ANALOG_PER_SOURCE } from "../../../../src/core/scanner/store/analog-operations.js"
import type {
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"

type Label = { protocol: ScannerProtocol; confidence: ScannerConfidence }

function prior(
	labels: Label[] = [],
	cls: ScannerClass = "unknown",
	analogVoice = false,
): VoicePrior {
	return { labels, class: cls, analogVoice: () => analogVoice }
}

const decoded = (protocol: ScannerProtocol): Label => ({
	protocol,
	confidence: "decoded",
})

describe("recording-verdict table", () => {
	const rows: {
		name: string
		prior: VoicePrior | null
		strong?: boolean
		ownTone?: boolean
		reading: "non-voice" | "suspect" | "none"
		admission: "refused:not-analog" | null
		finish: "finish" | "hold" | "discarded:not-analog"
		final: "finish" | "discarded:not-analog"
	}[] = [
		{
			name: "no prior: kept at once",
			prior: null,
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
		},
		{
			name: "decoded POCSAG: refused, discarded",
			prior: prior([decoded("pocsag")]),
			reading: "non-voice",
			admission: "refused:not-analog",
			finish: "discarded:not-analog",
			final: "discarded:not-analog",
		},
		{
			name: "decoded DMR on a co-channel discovery: refused",
			prior: prior([
				{ protocol: "unknown", confidence: "activity" },
				decoded("dmr"),
			]),
			reading: "non-voice",
			admission: "refused:not-analog",
			finish: "discarded:not-analog",
			final: "discarded:not-analog",
		},
		{
			name: "strong digital class (decode or channel tier backed): refused",
			prior: prior(),
			strong: true,
			reading: "non-voice",
			admission: "refused:not-analog",
			finish: "discarded:not-analog",
			final: "discarded:not-analog",
		},
		{
			name: "strong class with no prior read at all: refused",
			prior: null,
			strong: true,
			reading: "non-voice",
			admission: "refused:not-analog",
			finish: "discarded:not-analog",
			final: "discarded:not-analog",
		},
		{
			name: "mixed repeater: decoded DMR and analog voice heard: kept",
			prior: prior([decoded("dmr")], "fsk4-12k5", true),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
		},
		{
			name: "decoded DMR with an analog-fm label at classified (tone): kept",
			prior: prior([
				decoded("dmr"),
				{ protocol: "analog-fm", confidence: "classified" },
			]),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
		},
		{
			name: "decoded analog-fm: kept",
			prior: prior([decoded("analog-fm")]),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
		},
		{
			name: "spectral fsk2-wide class only: held, kept after the grace",
			prior: prior([], "fsk2-wide"),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
		},
		{
			name: "digital-unknown candidate: held, kept",
			prior: prior([{ protocol: "digital-unknown", confidence: "candidate" }]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
		},
		{
			name: "dsd-fme sync hint (DMR at activity): held, kept",
			prior: prior([{ protocol: "dmr", confidence: "activity" }]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
		},
		{
			name: "suspect with analog voice heard: kept at once",
			prior: prior([], "fsk4-12k5", true),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
		},
		{
			name: "own CTCSS tone over the file, even with decoded POCSAG: kept",
			prior: prior([decoded("pocsag")]),
			ownTone: true,
			reading: "non-voice",
			admission: "refused:not-analog",
			finish: "finish",
			final: "finish",
		},
		{
			name: "carrier or unknown labels: kept",
			prior: prior(
				[{ protocol: "carrier", confidence: "activity" }],
				"carrier",
			),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
		},
	]
	for (const r of rows)
		it(r.name, () => {
			const strong = r.strong ?? false
			const ownTone = r.ownTone ?? false
			expect(readPrior(r.prior, strong)).toBe(r.reading)
			expect(admissionVerdict(r.prior, strong)).toBe(r.admission)
			expect(
				finishVerdict({
					prior: r.prior,
					strongClass: strong,
					ownTone,
					final: false,
				}),
			).toBe(r.finish)
			expect(
				finishVerdict({
					prior: r.prior,
					strongClass: strong,
					ownTone,
					final: true,
				}),
			).toBe(r.final)
		})

	it("an analog voice read that throws counts as voice heard (keeps)", () => {
		const p: VoicePrior = {
			labels: [decoded("pocsag")],
			class: "unknown",
			analogVoice: () => {
				throw new Error("boom")
			},
		}
		expect(admissionVerdict(p, false)).toBeNull()
	})

	it("the analog voice read is asked only when a prior would refuse or hold", () => {
		let asked = 0
		const p: VoicePrior = {
			labels: [{ protocol: "analog-fm", confidence: "candidate" }],
			class: "analog-fm",
			analogVoice: () => {
				asked++
				return false
			},
		}
		expect(readPrior(p, false)).toBe("none")
		expect(asked).toBe(0)
	})

	it("the grace is identify's longest answer: queue wait + slot freeing + probe timeout = 26 s", () => {
		expect(LATE_VERDICT_GRACE_MS).toBe(
			IDENTIFY_QUEUE_WAIT_MS +
				IDENTIFY_SLOT_FREEING_MAX_MS +
				IDENTIFY_DEFAULT_TIMEOUT_MS,
		)
		expect(LATE_VERDICT_GRACE_MS).toBe(26_000)
		expect(MAX_PROVISIONAL_PER_SOURCE).toBe(MAX_ACTIVE_ANALOG_PER_SOURCE - 1)
	})

	it("barredSnapshot: encrypted, then opted out, then unclean", () => {
		expect(barredSnapshot(true, false, false)).toBe("refused:encrypted")
		expect(barredSnapshot(false, false, false)).toBe("refused:record-disabled")
		expect(barredSnapshot(false, true, false)).toBe("refused:unclean")
		expect(barredSnapshot(false, true, true)).toBeNull()
	})

	it("decodeDuring: before the air start nothing; own, cited-none after the onset, or joined", () => {
		const d = (at: number | null, observationId: string | null) => ({
			protocol: "pocsag" as const,
			at,
			observationId,
		})
		const joins = new Set(["j"])
		expect(decodeDuring(null, "o", 100, 200, joins)).toBeNull()
		expect(decodeDuring(d(99, "o"), "o", 100, 200, joins)).toBeNull()
		expect(decodeDuring(d(100, "o"), "o", 100, 200, joins)).toBe("own")
		expect(decodeDuring(d(null, "o"), "o", 100, 200, joins)).toBeNull()
		expect(decodeDuring(d(199, null), "o", 100, 200, joins)).toBeNull()
		expect(decodeDuring(d(200, "decode:d_1"), "o", 100, 200, joins)).toBe("own")
		expect(decodeDuring(d(150, "j"), "o", 100, 200, joins)).toEqual({
			joined: "j",
		})
		expect(decodeDuring(d(150, "x"), "o", 100, 200, joins)).toBeNull()
	})

	it("notVoiceDecode: a non-voice decode only; absent, throwing or analog lookups read null", () => {
		const pager = { protocol: "pocsag" as const, at: 1, observationId: null }
		expect(notVoiceDecode(() => pager, "d_1")).toBe(pager)
		expect(notVoiceDecode(() => pager, null)).toBeNull()
		expect(notVoiceDecode(undefined, "d_1")).toBeNull()
		expect(
			notVoiceDecode(() => ({ ...pager, protocol: "analog-fm" }), "d_1"),
		).toBeNull()
		expect(
			notVoiceDecode(() => {
				throw new Error("boom")
			}, "d_1"),
		).toBeNull()
	})
})

describe("recording-verdict property", () => {
	// Feature: analog recorder verdict, Property 1: weak evidence never refuses or discards
	it("a prior with only weak evidence (no decoded non-voice label, no strong class) never refuses or discards", () => {
		const classes: ScannerClass[] = [
			"fsk4-12k5",
			"fsk4-6k25",
			"tdma-ms",
			"fsk2-wide",
			"gmsk-narrow",
			"afsk-fm",
			"analog-fm",
			"analog-am",
			"ook-burst",
			"carrier",
			"wideband",
			"unknown",
		]
		const protocols: ScannerProtocol[] = [
			"pocsag",
			"flex",
			"dmr",
			"ysf",
			"p25p1",
			"dstar",
			"aprs",
			"ais",
			"analog-fm",
			"digital-unknown",
			"carrier",
			"unknown",
		]
		const weakConfidence: ScannerConfidence[] = [
			"activity",
			"candidate",
			"classified",
		]
		const label = fc.record({
			protocol: fc.constantFrom(...protocols),
			confidence: fc.constantFrom(...weakConfidence),
		})
		const analogDecoded = fc.constant<Label>(decoded("analog-fm"))
		fc.assert(
			fc.property(
				fc.array(fc.oneof(label, analogDecoded), { maxLength: 9 }),
				fc.constantFrom(...classes),
				fc.boolean(),
				fc.boolean(),
				(labels, cls, analogVoice, final) => {
					const p = prior(labels, cls, analogVoice)
					expect(admissionVerdict(p, false)).toBeNull()
					expect(
						finishVerdict({
							prior: p,
							strongClass: false,
							ownTone: false,
							final,
						}),
					).not.toBe("discarded:not-analog")
				},
			),
			{ numRuns: 200 },
		)
	})
})
