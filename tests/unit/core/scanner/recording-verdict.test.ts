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
	DigitalClassLedger,
	fileDecodedOwn,
	finishVerdict,
	notVoiceDecode,
	readPrior,
	STRONG_CLASS_MAX_DISCOVERIES,
	STRONG_CLASS_MIN_OBSERVATIONS,
	STRONG_CLASS_TTL_MS,
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

type Label = {
	protocol: ScannerProtocol
	confidence: ScannerConfidence
	owner: boolean
}

function prior(
	labels: Label[] = [],
	cls: ScannerClass = "unknown",
	analogVoice = false,
): VoicePrior {
	return { labels, class: cls, analogVoice: () => analogVoice }
}

/** A decoded label of the owner (`owner` true) or of a co-channel discovery. */
const decoded = (protocol: ScannerProtocol, owner = true): Label => ({
	protocol,
	confidence: "decoded",
	owner,
})
const weak = (
	protocol: ScannerProtocol,
	confidence: ScannerConfidence,
	owner = true,
): Label => ({ protocol, confidence, owner })

type Finish = "finish" | "hold" | "discarded:not-analog"

describe("recording-verdict table", () => {
	// finish / final: a file a snapshot classed analog-fm (`snapshotClassed`), at its finish and at
	// the end of its grace; byTone / byToneFinal: one classed by its own audio only.
	const rows: {
		name: string
		prior: VoicePrior | null
		strong?: boolean
		ownTone?: boolean
		decodedOwn?: boolean
		reading: "tone-required" | "suspect" | "none"
		admission: "tone-required" | null
		finish: Finish
		final: Finish
		byTone: Finish
		byToneFinal: Finish
	}[] = [
		{
			name: "no prior: kept at once",
			prior: null,
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
		{
			name: "owner decoded POCSAG: tone required; a snapshot-classed file is held, then kept; a tone-only one without a tone is discarded",
			prior: prior([decoded("pocsag")]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "co-channel decoded POCSAG (pager, any discovery): tone required",
			prior: prior([decoded("pocsag", false)]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "co-channel decoded AIS (data): tone required",
			prior: prior([decoded("ais", false)]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "co-channel decoded ISM (an rtl_433 sensor beside LPD voice): suspect only, an untoned voice is kept",
			prior: prior([decoded("ism", false)]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "owner decoded ISM (a sensor and a voice filed in one discovery): suspect only, kept",
			prior: prior([decoded("ism")]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "co-channel decoded LoRa (Meshtastic beside LPD voice): suspect only, kept",
			prior: prior([decoded("lora", false)]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "owner decoded LoRa: suspect only, kept",
			prior: prior([decoded("lora")]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "co-channel decoded FLEX (pager): tone required",
			prior: prior([decoded("flex", false)]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "owner decoded APRS (data on its own channel): tone required",
			prior: prior([decoded("aprs")]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "a co-channel ISM decode beside an owner POCSAG decode: the pager decode wins, tone required",
			prior: prior([decoded("ism", false), decoded("pocsag")]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "owner decoded DMR (a lone discovery holding analog and DMR overs): suspect only, held then kept",
			prior: prior([decoded("dmr")]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "co-channel decoded DMR (PMR446 / DMR446 sharing): suspect only, held then kept",
			prior: prior([weak("unknown", "activity"), decoded("dmr", false)]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "co-channel decoded NXDN, YSF, dPMR: suspect only",
			prior: prior([
				decoded("nxdn96", false),
				decoded("ysf", false),
				decoded("dpmr", false),
			]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "owner-decoded vs co-channel-decoded DMR: read alike (suspect); only pager or data decodes are strong, wherever they are",
			prior: prior([decoded("dmr"), decoded("dmr", false)]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "co-channel DMR with an own decode of this file: discarded",
			prior: prior([decoded("dmr", false)]),
			decodedOwn: true,
			reading: "suspect",
			admission: null,
			finish: "discarded:not-analog",
			final: "discarded:not-analog",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "backed digital class (ledger, two observations): suspect, held then kept",
			prior: prior(),
			strong: true,
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "backed class with no prior read at all: suspect",
			prior: null,
			strong: true,
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "backed class + analog voice heard on the channel: kept at once",
			prior: prior([], "fsk4-12k5", true),
			strong: true,
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
		{
			name: "mixed repeater: owner decoded DMR and analog voice heard: kept at once",
			prior: prior([decoded("dmr")], "fsk4-12k5", true),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
		{
			name: "decoded DMR with an analog-fm label at classified (tone): kept",
			prior: prior([decoded("dmr"), weak("analog-fm", "classified")]),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
		{
			name: "decoded analog label + an unrelated co-channel POCSAG decode: kept",
			prior: prior([decoded("analog-fm"), decoded("pocsag", false)]),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
		{
			name: "spectral fsk2-wide class only: held, kept after the grace (final under suspect keeps)",
			prior: prior([], "fsk2-wide"),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "digital-unknown candidate: held, kept",
			prior: prior([weak("digital-unknown", "candidate")]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "dsd-fme sync hint (DMR at activity): held, kept",
			prior: prior([weak("dmr", "activity")]),
			reading: "suspect",
			admission: null,
			finish: "hold",
			final: "finish",
			byTone: "hold",
			byToneFinal: "finish",
		},
		{
			name: "suspect with analog voice heard: kept at once",
			prior: prior([], "fsk4-12k5", true),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
		{
			name: "strong prior + own CTCSS tone over the file: kept, even with an own decode",
			prior: prior([decoded("pocsag")]),
			ownTone: true,
			decodedOwn: true,
			reading: "tone-required",
			admission: "tone-required",
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
		{
			name: "no prior but an own decode of this file: discarded",
			prior: null,
			decodedOwn: true,
			reading: "none",
			admission: null,
			finish: "discarded:not-analog",
			final: "discarded:not-analog",
			byTone: "discarded:not-analog",
			byToneFinal: "discarded:not-analog",
		},
		{
			name: "carrier or unknown labels: kept",
			prior: prior([weak("carrier", "activity")], "carrier"),
			reading: "none",
			admission: null,
			finish: "finish",
			final: "finish",
			byTone: "finish",
			byToneFinal: "finish",
		},
	]
	for (const r of rows)
		it(r.name, () => {
			const strong = r.strong ?? false
			const at = (snapshotClassed: boolean, final: boolean) =>
				finishVerdict({
					prior: r.prior,
					backedClass: strong,
					ownTone: r.ownTone ?? false,
					snapshotClassed,
					decodedOwn: r.decodedOwn ?? false,
					final,
				})
			expect(readPrior(r.prior, strong)).toBe(r.reading)
			expect(admissionVerdict(r.prior, strong)).toBe(r.admission)
			expect(at(true, false)).toBe(r.finish)
			expect(at(true, true)).toBe(r.final)
			expect(at(false, false)).toBe(r.byTone)
			expect(at(false, true)).toBe(r.byToneFinal)
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
			labels: [weak("analog-fm", "candidate")],
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
	it("a prior with only weak evidence (no decoded pager or dedicated-channel data label; digital voice, ISM and LoRa decodes and backed classes included) never refuses or discards", () => {
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
			owner: fc.boolean(),
		})
		// A digital voice decode, of the owner or a co-channel discovery, is weak evidence too.
		const digitalVoice = fc
			.tuple(
				fc.constantFrom<ScannerProtocol>(
					"dmr",
					"ysf",
					"nxdn48",
					"dpmr",
					"p25p1",
				),
				fc.boolean(),
			)
			.map(([p, owner]) => decoded(p, owner))
		// So is an ISM or LoRa decode: those share channels with untoned analog voice.
		const sharedChannel = fc
			.tuple(fc.constantFrom<ScannerProtocol>("ism", "lora"), fc.boolean())
			.map(([p, owner]) => decoded(p, owner))
		const analogDecoded = fc.constant<Label>(decoded("analog-fm"))
		fc.assert(
			fc.property(
				fc.array(fc.oneof(label, analogDecoded, digitalVoice, sharedChannel), {
					maxLength: 9,
				}),
				fc.constantFrom(...classes),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(labels, cls, analogVoice, final, snapshotClassed, backed) => {
					const p = prior(labels, cls, analogVoice)
					expect(admissionVerdict(p, backed)).toBeNull()
					expect(
						finishVerdict({
							prior: p,
							backedClass: backed,
							ownTone: false,
							snapshotClassed,
							decodedOwn: false,
							final,
						}),
					).not.toBe("discarded:not-analog")
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("fileDecodedOwn: a decode proves a finished file's own signal", () => {
	const d = (at: number | null, observationId: string | null) => ({
		protocol: "pocsag" as const,
		at,
		observationId,
	})
	it("cites the owner at or after the air start: own", () => {
		expect(fileDecodedOwn(d(100, "o"), "o", 100, 200)).toBe(true)
		expect(fileDecodedOwn(d(99, "o"), "o", 100, 200)).toBe(false)
		expect(fileDecodedOwn(d(null, "o"), "o", 100, 200)).toBe(false)
		expect(fileDecodedOwn(null, "o", 100, 200)).toBe(false)
	})
	it("cites no observation: own only from the onset on", () => {
		expect(fileDecodedOwn(d(200, "decode:d_1"), "o", 100, 200)).toBe(true)
		expect(fileDecodedOwn(d(199, null), "o", 100, 200)).toBe(false)
		expect(fileDecodedOwn(d(500, null), "o", 100, 200)).toBe(true)
	})
	it("cites another observation (a DMR over merged into the same discovery): never own", () => {
		expect(fileDecodedOwn(d(500, "dmr-over"), "o", 100, 200)).toBe(false)
	})
})

describe("DigitalClassLedger: a backed digital class counts only when seen twice, recently", () => {
	const T = 1_000_000
	it("one observation, however many snapshots, is never strong", () => {
		const l = new DigitalClassLedger()
		for (let i = 0; i < 50; i++) l.note("d", "o1", T + i)
		expect(STRONG_CLASS_MIN_OBSERVATIONS).toBe(2)
		expect(l.strong("d", T + 50)).toBe(false)
	})
	it("two distinct observations are strong, up to the TTL after the older one and not past it", () => {
		expect(STRONG_CLASS_TTL_MS).toBe(15 * 60 * 1000)
		const l = new DigitalClassLedger()
		l.note("d", "o1", T)
		l.note("d", "o2", T + 1000)
		expect(l.strong("d", T + 1000)).toBe(true)
		expect(l.strong("d", T + STRONG_CLASS_TTL_MS)).toBe(true)
		expect(l.strong("d", T + STRONG_CLASS_TTL_MS + 1)).toBe(false)
		// Seeing o1 again renews it: the window then runs from the older of the two newest.
		l.note("d", "o1", T + STRONG_CLASS_TTL_MS + 1)
		expect(l.strong("d", T + 1000 + STRONG_CLASS_TTL_MS)).toBe(true)
		expect(l.strong("d", T + 1000 + STRONG_CLASS_TTL_MS + 1)).toBe(false)
	})
	it("is per discovery (the caller resolves merge aliases) and bounded", () => {
		const l = new DigitalClassLedger()
		l.note("a", "o1", T)
		l.note("b", "o2", T)
		expect(l.strong("a", T)).toBe(false)
		l.note("a", "o3", T)
		expect(l.strong("a", T)).toBe(true)
		for (let i = 0; i < STRONG_CLASS_MAX_DISCOVERIES; i++)
			l.note(`x${i}`, "o", T)
		// `a` was the oldest noted past STRONG_CLASS_MAX_DISCOVERIES = 1024: forgotten.
		expect(l.strong("a", T)).toBe(false)
	})
})
