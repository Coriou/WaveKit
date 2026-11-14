/**
 * The analog recorder's refusal and discard policy (recording-verdict.ts): one row per outcome,
 * refuse and keep rows both, and a property: a prior with only weak evidence never refuses or
 * discards.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	LATE_VERDICT_GRACE_MS,
	admissionVerdict,
	barredSnapshot,
	DIGITAL_CHANNEL_MIN_SHARE,
	DIGITAL_CHANNEL_MIN_VOTES,
	DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS,
	decodeDuring,
	digitalChannelClasses,
	DigitalClassLedger,
	fileDecodedOwn,
	finishVerdict,
	joinedVoiceOverlaps,
	notVoiceDecode,
	provisionalRoom,
	priorReading,
	readPrior,
	STRONG_CLASS_MAX_DISCOVERIES,
	STRONG_CLASS_MIN_OBSERVATIONS,
	STRONG_CLASS_TTL_MS,
	STRONG_PRIOR_TTL_MS,
	OWNER_DEDICATED_PRIOR_TTL_MS,
	contentChecked,
	TDMA_CHANNEL_MIN_SHARE,
	TDMA_CHANNEL_MIN_VOTES,
	type DigitalProof,
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	IDENTIFY_DEFAULT_TIMEOUT_MS,
	IDENTIFY_QUEUE_WAIT_MS,
	IDENTIFY_SLOT_FREEING_MAX_MS,
} from "../../../../src/core/scanner/identify.js"
import {
	clearlyNoise,
	clearlyNotSpeech,
	SPEECH_FRAME_SAMPLES,
	SPEECH_NOISE_MAX_BURST_FRAMES,
	SPEECH_NOISE_MAX_PERIODIC_SHARE,
	SPEECH_NOISE_MAX_RANGE_DB,
	SPEECH_NOISE_MIN_FRAMES,
	SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE,
	SPEECH_STEADY_MAX_RANGE_DB,
	SPEECH_WINDOW_FRAMES,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"
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
	at: number | null
	checkedHint?: boolean
	verifiedHint?: boolean
	observationId?: string | null
}

/** The verdicts' wall clock (ms); every label is decoded at it unless a row says otherwise. */
const NOW = 1_700_000_000_000

function prior(
	labels: Label[] = [],
	cls: ScannerClass = "unknown",
	analogVoice = false,
): VoicePrior {
	return { labels, class: cls, analogVoice: () => analogVoice }
}

/** A decoded label of the owner (`owner` true) or of a co-channel discovery. */
const decoded = (
	protocol: ScannerProtocol,
	owner = true,
	at: number | null = NOW,
): Label => ({
	protocol,
	confidence: "decoded",
	owner,
	at,
})
const weak = (
	protocol: ScannerProtocol,
	confidence: ScannerConfidence,
	owner = true,
): Label => ({ protocol, confidence, owner, at: NOW })

type Finish =
	| "finish"
	| "hold"
	| "discarded:known-non-voice"
	| "discarded:late-non-voice"

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
			byTone: "discarded:known-non-voice",
			byToneFinal: "discarded:known-non-voice",
		},
		{
			name: "co-channel decoded POCSAG (pager, any discovery): tone required",
			prior: prior([decoded("pocsag", false)]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:known-non-voice",
			byToneFinal: "discarded:known-non-voice",
		},
		{
			name: "co-channel decoded AIS (data): tone required",
			prior: prior([decoded("ais", false)]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:known-non-voice",
			byToneFinal: "discarded:known-non-voice",
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
			byTone: "discarded:known-non-voice",
			byToneFinal: "discarded:known-non-voice",
		},
		{
			name: "owner decoded APRS (data on its own channel): tone required",
			prior: prior([decoded("aprs")]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:known-non-voice",
			byToneFinal: "discarded:known-non-voice",
		},
		{
			name: "a co-channel ISM decode beside an owner POCSAG decode: the pager decode wins, tone required",
			prior: prior([decoded("ism", false), decoded("pocsag")]),
			reading: "tone-required",
			admission: "tone-required",
			finish: "hold",
			final: "finish",
			byTone: "discarded:known-non-voice",
			byToneFinal: "discarded:known-non-voice",
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
			finish: "discarded:late-non-voice",
			final: "discarded:late-non-voice",
			byTone: "discarded:late-non-voice",
			byToneFinal: "discarded:late-non-voice",
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
			finish: "discarded:late-non-voice",
			final: "discarded:late-non-voice",
			byTone: "discarded:late-non-voice",
			byToneFinal: "discarded:late-non-voice",
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
					joinedVoice: false,
					notSpeech: false,
					final,
					now: NOW,
				})
			expect(readPrior(r.prior, strong, NOW)).toBe(r.reading)
			expect(admissionVerdict(r.prior, strong, NOW)).toBe(r.admission)
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
		expect(admissionVerdict(p, false, NOW)).toBeNull()
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
		expect(readPrior(p, false, NOW)).toBe("none")
		expect(asked).toBe(0)
	})

	it("the grace is identify's longest answer: queue wait + slot freeing + probe timeout = 26 s", () => {
		expect(LATE_VERDICT_GRACE_MS).toBe(
			IDENTIFY_QUEUE_WAIT_MS +
				IDENTIFY_SLOT_FREEING_MAX_MS +
				IDENTIFY_DEFAULT_TIMEOUT_MS,
		)
		expect(LATE_VERDICT_GRACE_MS).toBe(26_000)
	})

	it("provisionalRoom: cap − 1 held files (at cap 1 none is held; at the store's 2, one)", () => {
		expect(provisionalRoom(MAX_ACTIVE_ANALOG_PER_SOURCE)).toBe(1)
		for (const [cap, room] of [
			[1, 0],
			[2, 1],
			[3, 2],
			[0, 0],
			[-1, 0],
			[Number.NaN, 0],
			[Number.POSITIVE_INFINITY, 0],
		] as const)
			expect(provisionalRoom(cap)).toBe(room)
	})

	describe("STRONG_PRIOR_TTL_MS: a co-channel dedicated-channel decode is strong for 30 × 60 000 = 1 800 000 ms; the owner's for OWNER_DEDICATED_PRIOR_TTL_MS (24 h)", () => {
		const pager = (at: number | null) => prior([decoded("pocsag", true, at)])
		const coPager = (at: number | null) => prior([decoded("pocsag", false, at)])
		it("the bounds", () => {
			expect(STRONG_PRIOR_TTL_MS).toBe(1_800_000)
			expect(OWNER_DEDICATED_PRIOR_TTL_MS).toBe(86_400_000)
		})
		for (const [name, at, reading] of [
			["decoded now", NOW, "tone-required"],
			[
				"decoded exactly the TTL ago",
				NOW - STRONG_PRIOR_TTL_MS,
				"tone-required",
			],
			["decoded 1 ms past the TTL", NOW - STRONG_PRIOR_TTL_MS - 1, "suspect"],
			[
				"stamped the TTL ahead (clock skew)",
				NOW + STRONG_PRIOR_TTL_MS,
				"tone-required",
			],
			[
				"stamped 1 ms past the TTL ahead",
				NOW + STRONG_PRIOR_TTL_MS + 1,
				"suspect",
			],
			["undated", null, "suspect"],
		] as const)
			it(`a co-channel POCSAG decode ${name}: ${reading}; the owner's: ${at === null ? "suspect" : "tone required"}`, () => {
				expect(readPrior(coPager(at), false, NOW)).toBe(reading)
				expect(admissionVerdict(coPager(at), false, NOW)).toBe(
					reading === "tone-required" ? "tone-required" : null,
				)
				expect(readPrior(pager(at), false, NOW)).toBe(
					at === null ? "suspect" : "tone-required",
				)
			})
		// Live audit: a pager channel's POCSAG decode about 24 h old, no analog proof ever.
		it("the owner's POCSAG decode 23 h 59 min old: tone required; exactly 24 h: tone required; 24 h + 1 ms: suspect; with an analog proof: none", () => {
			const old = NOW - 24 * 60 * 60_000
			expect(readPrior(pager(NOW - (24 * 60 - 1) * 60_000), false, NOW)).toBe(
				"tone-required",
			)
			expect(readPrior(pager(old), false, NOW)).toBe("tone-required")
			expect(readPrior(pager(old - 1), false, NOW)).toBe("suspect")
			expect(
				readPrior(pager(NOW + OWNER_DEDICATED_PRIOR_TTL_MS + 1), false, NOW),
			).toBe("suspect")
			expect(admissionVerdict(pager(old - 1), false, NOW)).toBeNull()
			expect(
				readPrior(
					prior([decoded("pocsag", true, old)], "fsk2-wide", true),
					false,
					NOW,
				),
			).toBe("none")
		})
		it("an expired co-channel pager decode is suspect: a shadow file is held and kept, never discarded for it", () => {
			const verdict = (final: boolean) =>
				finishVerdict({
					prior: coPager(NOW - STRONG_PRIOR_TTL_MS - 1),
					backedClass: false,
					ownTone: false,
					snapshotClassed: false,
					decodedOwn: false,
					joinedVoice: false,
					notSpeech: false,
					final,
					now: NOW,
				})
			expect(verdict(false)).toBe("hold")
			expect(verdict(true)).toBe("finish")
		})
	})

	describe("a decode of the owner never discards a file a joined voice shares (joinedVoice)", () => {
		const verdict = (
			joinedVoice: boolean,
			final: boolean,
			p: VoicePrior | null,
		) =>
			finishVerdict({
				prior: p,
				backedClass: false,
				ownTone: false,
				snapshotClassed: true,
				decodedOwn: true,
				joinedVoice,
				notSpeech: false,
				final,
				now: NOW,
			})
		for (const [name, p] of [
			["no prior", null],
			["a suspect prior", prior([], "fsk2-wide")],
			["a strong prior", prior([decoded("pocsag")])],
		] as const)
			it(`${name}: kept at once with a joined voice, discarded late without`, () => {
				expect(verdict(true, false, p)).toBe("finish")
				expect(verdict(true, true, p)).toBe("finish")
				expect(verdict(false, false, p)).toBe("discarded:late-non-voice")
				expect(verdict(false, true, p)).toBe("discarded:late-non-voice")
			})
		it("joinedVoiceOverlaps: a joined voice on the air within [start, end] of the file; an open file reaches +∞", () => {
			const s = (start: number, last: number, joined = true) => ({
				joins: new Map(joined ? [["r", start]] : []),
				joinedVoice: new Map([["r", last]]),
			})
			const file = (startSample: number, endSample: number | null) => ({
				startSample,
				endSample,
			})
			for (const [name, sess, f, overlaps] of [
				["inside", s(200, 300), file(100, 400), true],
				["ends at the file's start", s(50, 100), file(100, 400), true],
				["ends 1 sample before", s(50, 99), file(100, 400), false],
				["starts at the file's end", s(400, 500), file(100, 400), true],
				["starts 1 sample after", s(401, 500), file(100, 400), false],
				["an open file", s(10_000, 20_000), file(100, null), true],
				[
					"no join start: its last report alone",
					s(250, 250, false),
					file(100, 400),
					true,
				],
			] as const)
				expect(joinedVoiceOverlaps(sess, f), name).toBe(overlaps)
			expect(
				joinedVoiceOverlaps(
					{ joins: new Map([["r", 0]]), joinedVoice: new Map() },
					file(0, null),
				),
			).toBe(false)
		})
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

describe("a digital channel (owner digital label within the TTL + its protocol's class votes): strong", () => {
	const recent = NOW - 60_000
	/** A dsd-fme sync hint of the owner with checked content (TG/SRC, talkgroup or encryption). */
	const hint: Label = {
		protocol: "dmr",
		confidence: "activity",
		owner: true,
		at: recent,
		checkedHint: true,
	}
	const voted = (
		labels: Label[],
		votes: Partial<Record<ScannerClass, number>>,
		total: number,
		cls: ScannerClass = "fsk4-12k5",
		analogVoice = false,
	): VoicePrior => ({
		labels,
		class: cls,
		analogVoice: () => analogVoice,
		classVotes: () => ({ total, votes }),
	})
	const unknownCandidate: Label = {
		protocol: "digital-unknown",
		confidence: "candidate",
		owner: true,
		at: recent,
	}
	const rows: { name: string; prior: VoicePrior; reading: string }[] = [
		{
			name: "A2: a checked owner DMR sync hint, 4FSK 12.5 kHz votes: tone required",
			prior: voted([hint], { "fsk4-12k5": 200 }, 240),
			reading: "tone-required",
		},
		{
			name: "a checked owner DMR sync hint, TDMA votes: tone required",
			prior: voted([hint], { "tdma-ms": 200 }, 240, "tdma-ms"),
			reading: "tone-required",
		},
		{
			name: "A: an owner digital-unknown candidate, 4FSK 12.5 kHz votes: tone required",
			prior: voted([unknownCandidate], { "fsk4-12k5": 200 }, 240),
			reading: "tone-required",
		},
		{
			name: "A3: an owner digital-unknown candidate on a wide 2FSK channel: tone required",
			prior: voted([unknownCandidate], { "fsk2-wide": 200 }, 240, "fsk2-wide"),
			reading: "tone-required",
		},
		{
			name: "a recent owner DMR decode: tone required",
			prior: voted(
				[{ ...hint, confidence: "decoded", checkedHint: false }],
				{ "fsk4-12k5": 200 },
				240,
			),
			reading: "tone-required",
		},
		{
			name: "a checked owner dPMR sync hint, 4FSK 6.25 kHz votes: tone required",
			prior: voted(
				[{ ...hint, protocol: "dpmr" }],
				{ "fsk4-6k25": 200 },
				240,
				"fsk4-6k25",
			),
			reading: "tone-required",
		},
		{
			name: "an unchecked owner sync hint, 4FSK 6.25 kHz votes only: suspect",
			prior: voted(
				[{ ...hint, protocol: "dpmr", checkedHint: false }],
				{ "fsk4-6k25": 240 },
				240,
				"fsk4-6k25",
			),
			reading: "suspect",
		},
		{
			name: "an owner sync hint with no checkedHint flag: suspect",
			prior: voted(
				[{ protocol: "dmr", confidence: "activity", owner: true, at: recent }],
				{ "fsk4-12k5": 240 },
				240,
			),
			reading: "suspect",
		},
		{
			name: "a checked DMR sync hint, 4FSK 6.25 kHz votes (not a DMR class): suspect",
			prior: voted([hint], { "fsk4-6k25": 240 }, 240, "fsk4-6k25"),
			reading: "suspect",
		},
		{
			name: "a decoded dPMR label, 4FSK 12.5 kHz votes (not a dPMR class): suspect",
			prior: voted(
				[{ ...hint, protocol: "dpmr", confidence: "decoded" }],
				{ "fsk4-12k5": 240 },
				240,
			),
			reading: "suspect",
		},
		{
			name: "a digital-unknown candidate, 4FSK 6.25 kHz votes only: suspect",
			prior: voted([unknownCandidate], { "fsk4-6k25": 240 }, 240, "fsk4-6k25"),
			reading: "suspect",
		},
		{
			name: "a decoded D-STAR label, GMSK votes: suspect (no FSK class names it)",
			prior: voted(
				[{ ...hint, protocol: "dstar", confidence: "decoded" }],
				{ "gmsk-narrow": 240 },
				240,
				"gmsk-narrow",
			),
			reading: "suspect",
		},
		{
			name: "an analog-fm stored class with exactly a third DMR-class votes: tone required",
			prior: voted(
				[hint],
				{ "fsk4-12k5": 40, "tdma-ms": 40 },
				240,
				"analog-fm",
			),
			reading: "tone-required",
		},
		{
			name: "just under a third: suspect",
			prior: voted(
				[hint],
				{ "fsk4-12k5": 40, "tdma-ms": 39 },
				240,
				"analog-fm",
			),
			reading: "suspect",
		},
		{
			name: "a third of all votes FSK but only DMR-foreign classes among them: suspect",
			prior: voted(
				[hint],
				{ "fsk4-12k5": 79, "fsk4-6k25": 1, "fsk2-wide": 0 },
				240,
				"analog-fm",
			),
			reading: "suspect",
		},
		{
			name: "fewer than DIGITAL_CHANNEL_MIN_VOTES votes: suspect",
			prior: voted(
				[hint],
				{ "fsk4-12k5": DIGITAL_CHANNEL_MIN_VOTES - 1 },
				DIGITAL_CHANNEL_MIN_VOTES - 1,
			),
			reading: "suspect",
		},
		{
			name: "exactly DIGITAL_CHANNEL_MIN_VOTES votes: tone required",
			prior: voted(
				[hint],
				{ "fsk4-12k5": DIGITAL_CHANNEL_MIN_VOTES },
				DIGITAL_CHANNEL_MIN_VOTES,
			),
			reading: "tone-required",
		},
		{
			name: "a co-channel sync hint only: suspect",
			prior: voted([{ ...hint, owner: false }], { "fsk4-12k5": 200 }, 240),
			reading: "suspect",
		},
		{
			name: "no digital label (a spectral 4FSK class only): suspect",
			prior: voted([], { "fsk4-12k5": 200 }, 240),
			reading: "suspect",
		},
		{
			name: "an owner ISM decode: suspect (LPD voice shares it)",
			prior: voted(
				[{ ...hint, protocol: "ism", confidence: "decoded" }],
				{ "fsk4-12k5": 200 },
				240,
			),
			reading: "suspect",
		},
		{
			name: "FROZEN: analog voice heard on the channel: none",
			prior: voted([hint], { "fsk4-12k5": 200 }, 240, "fsk4-12k5", true),
			reading: "none",
		},
		{
			name: "FROZEN: an owner analog label at classified: none",
			prior: voted(
				[
					hint,
					{
						protocol: "analog-fm",
						confidence: "classified",
						owner: true,
						at: NOW,
					},
				],
				{ "fsk4-12k5": 200 },
				240,
			),
			reading: "none",
		},
	]
	for (const r of rows)
		it(r.name, () => {
			expect(readPrior(r.prior, false, NOW)).toBe(r.reading)
		})

	describe("TTL: the owner's digital label holds the bar for STRONG_PRIOR_TTL_MS (30 × 60 000 = 1 800 000 ms)", () => {
		const at = (t: number | null, l: Label = hint): VoicePrior =>
			voted([{ ...l, at: t }], { "fsk4-12k5": 200 }, 240)
		for (const [name, l] of [
			["checked sync hint", hint],
			["decode", { ...hint, confidence: "decoded" as const }],
			["digital-unknown candidate", unknownCandidate],
		] as const) {
			it(`${name}: exactly STRONG_PRIOR_TTL_MS old, tone required; 1 ms older, suspect`, () => {
				expect(readPrior(at(NOW - STRONG_PRIOR_TTL_MS, l), false, NOW)).toBe(
					"tone-required",
				)
				expect(
					readPrior(at(NOW - STRONG_PRIOR_TTL_MS - 1, l), false, NOW),
				).toBe("suspect")
			})
			it(`${name}: a skew of STRONG_PRIOR_TTL_MS ahead holds; 1 ms past, suspect`, () => {
				expect(readPrior(at(NOW + STRONG_PRIOR_TTL_MS, l), false, NOW)).toBe(
					"tone-required",
				)
				expect(
					readPrior(at(NOW + STRONG_PRIOR_TTL_MS + 1, l), false, NOW),
				).toBe("suspect")
			})
			it(`${name}: undated, or hours old: suspect`, () => {
				expect(readPrior(at(null, l), false, NOW)).toBe("suspect")
				expect(readPrior(at(Number.NaN, l), false, NOW)).toBe("suspect")
				expect(readPrior(at(NOW - 5 * 60 * 60_000, l), false, NOW)).toBe(
					"suspect",
				)
			})
		}
	})

	it("digitalChannelClasses is derived from the classifier's hypotheses", () => {
		const of = (p: ScannerProtocol) => [...digitalChannelClasses(p)].sort()
		expect(of("dmr")).toEqual(["fsk4-12k5", "tdma-ms"])
		expect(of("ysf")).toEqual(["fsk4-12k5"])
		expect(of("p25p1")).toEqual(["fsk4-12k5"])
		expect(of("nxdn96")).toEqual(["fsk4-12k5"])
		expect(of("dpmr")).toEqual(["fsk4-6k25"])
		expect(of("nxdn48")).toEqual(["fsk4-6k25"])
		expect(of("dstar")).toEqual([])
		expect(of("p25p2")).toEqual([])
		expect(of("digital-unknown")).toEqual(["fsk2-wide", "fsk4-12k5", "tdma-ms"])
		expect(of("pocsag")).toEqual([])
		expect(of("analog-fm")).toEqual([])
	})

	it("a throwing vote read is no digital channel", () => {
		const p: VoicePrior = {
			labels: [hint],
			class: "fsk4-12k5",
			analogVoice: () => false,
			classVotes: () => {
				throw new Error("boom")
			},
		}
		expect(readPrior(p, false, NOW)).toBe("suspect")
	})

	it("a shadow of a digital channel never classed is discarded; its own CTCSS tone keeps it", () => {
		const base = {
			prior: voted([hint], { "fsk4-12k5": 200 }, 240),
			backedClass: false,
			decodedOwn: false,
			joinedVoice: false,
			notSpeech: false,
			final: false,
			now: NOW,
		}
		expect(
			finishVerdict({ ...base, ownTone: false, snapshotClassed: false }),
		).toBe("discarded:known-non-voice")
		expect(
			finishVerdict({ ...base, ownTone: true, snapshotClassed: false }),
		).toBe("finish")
	})

	describe("unchecked DMR sync hints (dsd-fme sync, no verified TG/SRC) and the owner's observation proofs", () => {
		const unchecked: Label = { ...hint, checkedHint: false }
		const withProofs = (
			labels: Label[],
			proofs: DigitalProof[],
			votes: Partial<Record<ScannerClass, number>>,
			total = 240,
			analogVoice = false,
		): VoicePrior => ({
			...voted(labels, votes, total, "fsk4-12k5", analogVoice),
			digitalProofs: () => proofs,
		})
		const sync = (
			observationId: string,
			at: number,
			checked = false,
			protocol: ScannerProtocol = "dmr",
		): DigitalProof => ({ protocol, at, checked, observationId })
		const fsk = { "fsk4-12k5": 200 }
		const rows: { name: string; prior: VoicePrior; reading: string }[] = [
			{
				name: "live shape: an unchecked DMR hint, TDMA votes, no analog proof: tone required",
				prior: withProofs([unchecked], [sync("o1", recent)], {
					"tdma-ms": 120,
					"fsk4-12k5": 60,
				}),
				reading: "tone-required",
			},
			{
				name: "unchecked DMR hints from 2 observations in the TTL, 4FSK 12.5 kHz votes: tone required",
				prior: withProofs(
					[unchecked],
					[sync("o1", NOW - 10 * 60_000), sync("o2", recent)],
					fsk,
				),
				reading: "tone-required",
			},
			{
				name: "the same with 1 observation: suspect",
				prior: withProofs([unchecked], [sync("o1", recent)], fsk),
				reading: "suspect",
			},
			{
				name: "the same observation twice (its label and its proof): suspect",
				prior: withProofs(
					[{ ...unchecked, observationId: "o1" }],
					[sync("o1", recent)],
					fsk,
				),
				reading: "suspect",
			},
			{
				name: "2 observations, one older than STRONG_PRIOR_TTL_MS (rule b counts only sightings within the TTL): suspect",
				prior: withProofs(
					[unchecked],
					[sync("o1", NOW - STRONG_PRIOR_TTL_MS - 1), sync("o2", recent)],
					fsk,
				),
				reading: "suspect",
			},
			{
				name: "2 observations both within the TTL, one exactly STRONG_PRIOR_TTL_MS old: tone required",
				prior: withProofs(
					[unchecked],
					[sync("o1", NOW - STRONG_PRIOR_TTL_MS), sync("o2", recent)],
					fsk,
				),
				reading: "tone-required",
			},
			{
				name: "2 observations, both older than STRONG_PRIOR_TTL_MS, no newer digital evidence: suspect",
				prior: withProofs(
					[{ ...unchecked, at: NOW - STRONG_PRIOR_TTL_MS - 1 }],
					[
						sync("o1", NOW - STRONG_PRIOR_TTL_MS - 2),
						sync("o2", NOW - STRONG_PRIOR_TTL_MS - 1),
					],
					fsk,
				),
				reading: "suspect",
			},
			{
				name: "FROZEN: 2 observations' hints but analog voice heard (a CTCSS tone): none",
				prior: withProofs(
					[unchecked],
					[sync("o1", NOW - 10 * 60_000), sync("o2", recent)],
					fsk,
					240,
					true,
				),
				reading: "none",
			},
			{
				name: "FROZEN: TDMA votes but analog voice heard: none",
				prior: withProofs(
					[unchecked],
					[sync("o1", recent)],
					{ "tdma-ms": 200 },
					240,
					true,
				),
				reading: "none",
			},
			{
				name: "unchecked dPMR hints from 2 observations, 4FSK 6.25 kHz votes: suspect",
				prior: withProofs(
					[{ ...unchecked, protocol: "dpmr" }],
					[
						sync("o1", NOW - 10 * 60_000, false, "dpmr"),
						sync("o2", recent, false, "dpmr"),
					],
					{ "fsk4-6k25": 240 },
				),
				reading: "suspect",
			},
			{
				name: "unchecked DMR hints from 2 observations, 4FSK 6.25 kHz votes (no DMR class): suspect",
				prior: withProofs(
					[unchecked],
					[sync("o1", NOW - 10 * 60_000), sync("o2", recent)],
					{ "fsk4-6k25": 240 },
				),
				reading: "suspect",
			},
			{
				name: "a checked hint followed by a newer unchecked one (the published label): tone required",
				prior: withProofs(
					[unchecked],
					[sync("o1", NOW - 5 * 60_000, true), sync("o2", recent)],
					fsk,
				),
				reading: "tone-required",
			},
			{
				name: "a decode 40 min ago (the published label) and unchecked hints every minute: tone required",
				prior: withProofs(
					[{ ...hint, confidence: "decoded", at: NOW - 40 * 60_000 }],
					[
						sync("o0", NOW - 40 * 60_000, true),
						...Array.from({ length: 30 }, (_, k) =>
							sync(`o${k + 1}`, NOW - k * 60_000),
						),
					],
					fsk,
				),
				reading: "tone-required",
			},
			{
				name: "a decode 40 min ago and nothing since: suspect",
				prior: withProofs(
					[{ ...hint, confidence: "decoded", at: NOW - 40 * 60_000 }],
					[sync("o0", NOW - 40 * 60_000, true)],
					fsk,
				),
				reading: "suspect",
			},
			{
				name: "observation proofs but no owner digital label: suspect",
				prior: withProofs(
					[],
					[sync("o1", NOW - 10 * 60_000), sync("o2", recent)],
					fsk,
				),
				reading: "suspect",
			},
		]
		for (const r of rows)
			it(r.name, () => {
				expect(readPrior(r.prior, false, NOW)).toBe(r.reading)
			})
		it("DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS is 2", () => {
			expect(DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS).toBe(2)
		})
	})

	// Feature: analog recorder verdict, Property 2: a digital channel needs the owner's recent decoded, checked or digital-unknown label and a third of the votes in its protocol's classes (an unchecked DMR hint: a third in tdma-ms), and no analog proof
	it("strong exactly when the owner has a recent decoded, checked-hint or digital-unknown label, at least a third of DIGITAL_CHANNEL_MIN_VOTES or more votes are in its protocol's classes, and no analog voice was heard", () => {
		const classes: ScannerClass[] = [
			"fsk4-12k5",
			"fsk4-6k25",
			"tdma-ms",
			"fsk2-wide",
			"gmsk-narrow",
			"analog-fm",
		]
		fc.assert(
			fc.property(
				fc.constantFrom<ScannerProtocol>(
					"dmr",
					"ysf",
					"dpmr",
					"nxdn48",
					"dstar",
					"digital-unknown",
					"unknown",
					"carrier",
				),
				fc.constantFrom<ScannerConfidence>("activity", "candidate", "decoded"),
				fc.boolean(),
				fc.boolean(),
				fc.integer({ min: 0, max: 2 * STRONG_PRIOR_TTL_MS }),
				fc.array(fc.constantFrom(...classes), { maxLength: 256 }),
				fc.boolean(),
				(protocol, confidence, owner, checkedHint, age, cast, analogVoice) => {
					const votes: Partial<Record<ScannerClass, number>> = {}
					for (const c of cast) votes[c] = (votes[c] ?? 0) + 1
					const p = voted(
						[{ protocol, confidence, owner, at: NOW - age, checkedHint }],
						votes,
						cast.length,
						"unknown",
						analogVoice,
					)
					const digitalLabel =
						owner &&
						age <= STRONG_PRIOR_TTL_MS &&
						(protocol === "digital-unknown" ||
							(protocol !== "unknown" &&
								protocol !== "carrier" &&
								(confidence === "decoded" || checkedHint)))
					const matched = cast.filter(c =>
						protocol === "digital-unknown"
							? c === "fsk4-12k5" || c === "tdma-ms" || c === "fsk2-wide"
							: protocol === "dmr"
								? c === "fsk4-12k5" || c === "tdma-ms"
								: protocol === "ysf"
									? c === "fsk4-12k5"
									: protocol === "dpmr" || protocol === "nxdn48"
										? c === "fsk4-6k25"
										: false,
					).length
					const tdma = cast.filter(c => c === "tdma-ms").length
					// An unchecked DMR hint (one published label: one observation) bars by TDMA alone.
					const uncheckedDmr =
						owner &&
						age <= STRONG_PRIOR_TTL_MS &&
						protocol === "dmr" &&
						confidence !== "decoded" &&
						!checkedHint &&
						tdma > 0 &&
						tdma >= DIGITAL_CHANNEL_MIN_SHARE * cast.length
					const strong =
						((digitalLabel &&
							matched > 0 &&
							matched >= DIGITAL_CHANNEL_MIN_SHARE * cast.length) ||
							uncheckedDmr) &&
						cast.length >= DIGITAL_CHANNEL_MIN_VOTES &&
						!analogVoice
					expect(readPrior(p, false, NOW) === "tone-required").toBe(strong)
					expect(admissionVerdict(p, false, NOW)).toBe(
						strong ? "tone-required" : null,
					)
				},
			),
			{ numRuns: 300 },
		)
	})
})

describe("recording-verdict property", () => {
	// Feature: analog recorder verdict, Property 1: weak evidence never refuses or discards
	it("a prior with only weak evidence (no recent decoded pager or dedicated-channel data label; digital voice, ISM and LoRa decodes, lapsed co-channel or undated pager decodes and backed classes included) never refuses or discards", () => {
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
			at: fc.constant(NOW),
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
		// So is a co-channel pager or data decode older than STRONG_PRIOR_TTL_MS, or an undated one
		// (the owner's dated one never lapses).
		const lapsed = fc
			.tuple(
				fc.constantFrom<ScannerProtocol>("pocsag", "flex", "aprs", "ais"),
				fc.boolean(),
				fc.option(
					fc.integer({
						min: STRONG_PRIOR_TTL_MS + 1,
						max: 10 * STRONG_PRIOR_TTL_MS,
					}),
				),
			)
			.map(([p, owner, ago]) =>
				decoded(p, owner && ago === null, ago === null ? null : NOW - ago),
			)
		const analogDecoded = fc.constant<Label>(decoded("analog-fm"))
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(label, analogDecoded, digitalVoice, sharedChannel, lapsed),
					{
						maxLength: 9,
					},
				),
				fc.constantFrom(...classes),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(labels, cls, analogVoice, final, snapshotClassed, backed) => {
					const p = prior(labels, cls, analogVoice)
					expect(admissionVerdict(p, backed, NOW)).toBeNull()
					expect(
						finishVerdict({
							prior: p,
							backedClass: backed,
							ownTone: false,
							snapshotClassed,
							decodedOwn: false,
							joinedVoice: false,
							notSpeech: false,
							final,
							now: NOW,
						}),
					).not.toMatch(/^discarded:/)
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

describe("a digital channel's TTL runs from its latest digital evidence (VoicePrior.digitalSeenAt)", () => {
	// Feature: recording-verdict, live audit of a DMR channel identify no longer probes.
	const min = 60_000
	const dmrHint: Label = {
		protocol: "dmr",
		confidence: "activity",
		owner: true,
		at: NOW - 57 * min,
		checkedHint: false,
	}
	const channel = (
		seenAgo: number | null,
		analogVoice = false,
		proofs: DigitalProof[] = [
			{
				protocol: "dmr",
				at: NOW - 57 * min,
				checked: false,
				observationId: "o1",
			},
			{
				protocol: "dmr",
				at: NOW - 62 * min,
				checked: false,
				observationId: "o2",
			},
		],
	): VoicePrior => ({
		labels: [dmrHint],
		class: "fsk4-12k5",
		analogVoice: () => analogVoice,
		classVotes: () => ({
			total: 40,
			votes: { "fsk4-12k5": 30, "analog-fm": 10 },
		}),
		digitalProofs: () => proofs,
		digitalSeenAt: () => (seenAgo === null ? null : NOW - seenAgo),
	})
	for (const [name, p, reading] of [
		[
			"DMR hints 57 and 62 min ago (outside the TTL: rule b does not count them), fresh evidence 1 min ago",
			channel(min),
			"suspect",
		],
		[
			"DMR hints 5 and 10 min ago, the latest digital evidence 5 min ago",
			channel(5 * min, false, [
				{
					protocol: "dmr",
					at: NOW - 5 * min,
					checked: false,
					observationId: "o1",
				},
				{
					protocol: "dmr",
					at: NOW - 10 * min,
					checked: false,
					observationId: "o2",
				},
			]),
			"tone-required",
		],
		[
			"a checked DMR decode 2 h ago, the latest digital evidence (a tdma-ms vote) exactly the TTL ago",
			channel(STRONG_PRIOR_TTL_MS, false, [
				{
					protocol: "dmr",
					at: NOW - 120 * min,
					checked: true,
					observationId: "o1",
				},
			]),
			"tone-required",
		],
		[
			"the same, the latest digital evidence 31 min ago",
			channel(31 * min),
			"suspect",
		],
		[
			"the same, no digital evidence time (null): the hints' own times (57 min): suspect",
			channel(null),
			"suspect",
		],
		["FROZEN: the same with an analog proof", channel(min, true), "none"],
		[
			"a checked DMR decode 2 h ago, a tdma-ms vote 1 min ago (digitalSeenAt)",
			channel(min, false, [
				{
					protocol: "dmr",
					at: NOW - 120 * min,
					checked: true,
					observationId: "o1",
				},
			]),
			"tone-required",
		],
		[
			"one unchecked hint 57 min ago (one observation, no TDMA share), a vote 1 min ago",
			channel(min, false, [
				{
					protocol: "dmr",
					at: NOW - 57 * min,
					checked: false,
					observationId: "o1",
				},
			]),
			"suspect",
		],
	] as const)
		it(`${name}: ${reading}`, () => {
			expect(readPrior(p, false, NOW)).toBe(reading)
		})
	it("a throwing digitalSeenAt read is no digital channel (suspect)", () => {
		const p: VoicePrior = {
			...channel(min),
			digitalSeenAt: () => {
				throw new Error("read failed")
			},
		}
		expect(readPrior(p, false, NOW)).toBe("suspect")
	})
})

describe("a TDMA channel known by its class alone (tdmaChannel): strong", () => {
	// Feature: recording-verdict, class-only tdma-ms discoveries (live audit: 7 files kept).
	const min = 60_000
	const tdma = (
		tdmaVotes: number,
		total: number,
		seenAgo: number | null = min,
		cls: ScannerClass = "tdma-ms",
		analogVoice = false,
	): VoicePrior => ({
		labels: [],
		class: cls,
		analogVoice: () => analogVoice,
		classVotes: () => ({
			total,
			votes: { "tdma-ms": tdmaVotes, "analog-fm": total - tdmaVotes },
		}),
		digitalSeenAt: () => (seenAgo === null ? null : NOW - seenAgo),
	})
	it("the bounds: at least 4 tdma-ms votes, at least half of the votes", () => {
		expect(TDMA_CHANNEL_MIN_VOTES).toBe(4)
		expect(TDMA_CHANNEL_MIN_SHARE).toBe(0.5)
	})
	for (const [name, p, reading] of [
		["7 of 8 votes tdma-ms, a vote 1 min ago", tdma(7, 8), "tone-required"],
		["4 of 8 (half)", tdma(4, 8), "tone-required"],
		["3 of 4 (under 4 votes)", tdma(3, 4), "suspect"],
		["4 of 9 (under half)", tdma(4, 9), "suspect"],
		[
			"7 of 8, the latest digital evidence 31 min ago",
			tdma(7, 8, 31 * min),
			"suspect",
		],
		["7 of 8, no digital evidence time", tdma(7, 8, null), "suspect"],
		[
			"7 of 8 but the stored class is analog-fm",
			tdma(7, 8, min, "analog-fm"),
			"none",
		],
		[
			"FROZEN: 7 of 8 with an analog proof",
			tdma(7, 8, min, "tdma-ms", true),
			"none",
		],
		[
			"fsk4-12k5 class-only stays suspect (an NFM misread)",
			{
				...tdma(0, 8),
				class: "fsk4-12k5" as ScannerClass,
				classVotes: () => ({ total: 8, votes: { "fsk4-12k5": 8 } }),
			},
			"suspect",
		],
		[
			"gmsk-narrow class-only stays suspect (an NFM misread)",
			{
				...tdma(0, 8),
				class: "gmsk-narrow" as ScannerClass,
				classVotes: () => ({ total: 8, votes: { "gmsk-narrow": 8 } }),
			},
			"suspect",
		],
	] as const)
		it(`${name}: ${reading}`, () => {
			expect(readPrior(p, false, NOW)).toBe(reading)
		})
})

describe("finishVerdict: a file whose audio clearly measures as no speech (notSpeech)", () => {
	// Feature: recording-verdict, the content check (speech-content.ts).
	// A spectral class alone (a weak NFM voice reads fsk4-*): suspect, no content check.
	const suspect = prior([], "fsk4-12k5")
	const strong = prior([decoded("pocsag")])
	// The owner's own checked DMR decode (a lone merge: suspect), dated now: backed.
	const ownDecode = prior([decoded("dmr")])
	const ownCheckedProof: VoicePrior = {
		...prior([weak("dmr", "activity")], "fsk4-12k5"),
		digitalProofs: () => [
			{
				protocol: "dmr",
				at: NOW - 60_000,
				checked: true,
				verified: true,
				observationId: "o1",
			},
		],
	}
	// m1: a talkgroup or encryption flag alone (checked, not verified) never opens the content check.
	const ownTalkgroupProof: VoicePrior = {
		...prior([weak("dmr", "activity")], "fsk4-12k5"),
		digitalProofs: () => [
			{ protocol: "dmr", at: NOW - 60_000, checked: true, observationId: "o1" },
		],
	}
	const verdict = (
		p: VoicePrior | null,
		over: Partial<Parameters<typeof finishVerdict>[0]> = {},
	) =>
		finishVerdict({
			prior: p,
			backedClass: false,
			ownTone: false,
			snapshotClassed: true,
			decodedOwn: false,
			joinedVoice: false,
			notSpeech: true,
			final: false,
			now: NOW,
			...over,
		})
	for (const [name, p, over, out] of [
		[
			"spectral-only suspect prior (fsk4-12k5): held, no content check",
			suspect,
			{},
			"hold",
		],
		[
			"spectral-only suspect prior, at the end of its grace: kept",
			suspect,
			{ final: true },
			"finish",
		],
		[
			"spectral-only gmsk-narrow suspect prior: held",
			prior([], "gmsk-narrow"),
			{},
			"hold",
		],
		[
			"backedClass (a decode- or channel-tier-backed digital class): discarded",
			suspect,
			{ backedClass: true },
			"discarded:not-speech",
		],
		[
			"the owner's DMR decode now (suspect lone merge): discarded",
			ownDecode,
			{},
			"discarded:not-speech",
		],
		[
			"the owner's DMR decode now, at the end of its grace: discarded",
			ownDecode,
			{ final: true },
			"discarded:not-speech",
		],
		[
			"the owner's DMR decode 1 ms past STRONG_PRIOR_TTL_MS: held",
			prior([decoded("dmr", true, NOW - STRONG_PRIOR_TTL_MS - 1)]),
			{},
			"hold",
		],
		[
			"the owner's verified (TG/SRC) sync hint label: discarded",
			prior([
				{ ...weak("dmr", "activity"), checkedHint: true, verifiedHint: true },
			]),
			{},
			"discarded:not-speech",
		],
		[
			"the owner's checked sync hint label, a talkgroup or encryption flag only: held",
			prior([{ ...weak("dmr", "activity"), checkedHint: true }]),
			{},
			"hold",
		],
		[
			"a kept observation's checked DMR proof, a talkgroup or encryption flag only: held",
			ownTalkgroupProof,
			{},
			"hold",
		],
		[
			"the owner's unchecked sync hint label: held",
			prior([{ ...weak("dmr", "activity"), checkedHint: false }]),
			{},
			"hold",
		],
		[
			"a kept observation's verified DMR proof: discarded",
			ownCheckedProof,
			{},
			"discarded:not-speech",
		],
		[
			"a co-channel DMR decode only: held",
			prior([decoded("dmr", false)], "fsk4-12k5"),
			{},
			"hold",
		],
		["the owner's ism decode: held", prior([decoded("ism")]), {}, "hold"],
		["the owner's LoRa decode: held", prior([decoded("lora")]), {}, "hold"],
		[
			"a digital-unknown candidate: held",
			prior([weak("digital-unknown", "activity")]),
			{},
			"hold",
		],
		[
			"strong prior, a snapshot-classed file: discarded",
			strong,
			{},
			"discarded:not-speech",
		],
		[
			"strong prior, never classed: known non-voice first",
			strong,
			{ snapshotClassed: false },
			"discarded:known-non-voice",
		],
		[
			"suspect prior, speech-like audio: held",
			suspect,
			{ notSpeech: false },
			"hold",
		],
		["FROZEN: its own CTCSS tone: kept", suspect, { ownTone: true }, "finish"],
		[
			"FROZEN: an analog proof on the channel: kept",
			prior([], "fsk4-12k5", true),
			{},
			"finish",
		],
		["FROZEN: no prior: kept", null, {}, "finish"],
		[
			"a joined voice shares the file: held, then kept",
			suspect,
			{ joinedVoice: true },
			"hold",
		],
		[
			"a decode of its own signal: late non-voice",
			suspect,
			{ decodedOwn: true },
			"discarded:late-non-voice",
		],
	] as const)
		it(`${name}`, () => {
			expect(verdict(p, over)).toBe(out)
		})
	it("contentChecked: by source; a throwing proofs read is not applied", () => {
		expect(contentChecked("dedicated", null, false, NOW)).toBe(true)
		expect(contentChecked("tdma", null, false, NOW)).toBe(true)
		expect(contentChecked("checked-digital", null, false, NOW)).toBe(true)
		expect(contentChecked("unchecked-dmr", null, false, NOW)).toBe(false)
		expect(contentChecked("digital-unknown", null, false, NOW)).toBe(false)
		expect(contentChecked("digital-unknown", null, true, NOW)).toBe(true)
		expect(contentChecked(null, null, true, NOW)).toBe(true)
		expect(contentChecked(null, null, false, NOW)).toBe(false)
		const throwing: VoicePrior = {
			...suspect,
			digitalProofs: () => {
				throw new Error("read failed")
			},
		}
		expect(contentChecked(null, throwing, false, NOW)).toBe(false)
	})
})

describe("finishVerdict: the content check follows where a strong prior's strength came from", () => {
	// Feature: recording-verdict, the content check under a tone-required prior (StrongSource).
	// Validates: docs/SCANNER.md, "Known digital or paging channels" (the content check).
	const recent = NOW - 60_000
	const old = NOW - 2 * 3_600_000
	const channel = (
		labels: Label[],
		votes: Partial<Record<ScannerClass, number>>,
		total: number,
		extra: Partial<VoicePrior> = {},
		cls: ScannerClass = "fsk4-12k5",
	): VoicePrior => ({
		labels,
		class: cls,
		analogVoice: () => false,
		classVotes: () => ({ total, votes }),
		...extra,
	})
	const unknownCandidate: Label = {
		protocol: "digital-unknown",
		confidence: "candidate",
		owner: true,
		at: recent,
	}
	const uncheckedHint: Label = {
		protocol: "dmr",
		confidence: "activity",
		owner: true,
		at: recent,
		checkedHint: false,
		observationId: "o2",
	}
	const sync = (id: string, at: number, checked = false): DigitalProof => ({
		protocol: "dmr",
		at,
		checked,
		observationId: id,
	})
	const rows: {
		name: string
		prior: VoicePrior
		source: string | null
		out: "hold" | "discarded:not-speech"
	}[] = [
		{
			name: "a digital-unknown candidate, fsk4-12k5 votes",
			prior: channel([unknownCandidate], { "fsk4-12k5": 200 }, 240),
			source: "digital-unknown",
			out: "hold",
		},
		{
			name: "rule (b): unchecked DMR hints from 2 observations, fsk4-12k5 votes",
			prior: channel([uncheckedHint], { "fsk4-12k5": 200 }, 240, {
				digitalProofs: () => [sync("o1", recent), sync("o2", recent)],
			}),
			source: "unchecked-dmr",
			out: "hold",
		},
		{
			name: "rule (a): an unchecked DMR hint, a third of the votes tdma-ms (no TDMA channel)",
			prior: channel(
				[uncheckedHint],
				{ "tdma-ms": 100 },
				240,
				{ digitalProofs: () => [sync("o2", recent)] },
				"analog-fm",
			),
			source: "unchecked-dmr",
			out: "hold",
		},
		{
			name: "a verified DMR hint 2 h old, the channel's TTL kept by a fresh tdma-ms vote",
			prior: channel(
				[{ ...uncheckedHint, at: old, checkedHint: true, verifiedHint: true }],
				{ "fsk4-12k5": 200 },
				240,
				{ digitalSeenAt: () => recent, tdmaSeenAt: () => recent },
			),
			source: "checked-digital",
			out: "discarded:not-speech",
		},
		{
			name: "a checked DMR hint (talkgroup only) 2 h old, a fresh tdma-ms vote",
			prior: channel(
				[{ ...uncheckedHint, at: old, checkedHint: true }],
				{ "fsk4-12k5": 200 },
				240,
				{ digitalSeenAt: () => recent, tdmaSeenAt: () => recent },
			),
			source: "digital-unknown",
			out: "hold",
		},
		{
			name: "a fresh verified DMR hint",
			prior: channel(
				[{ ...uncheckedHint, checkedHint: true, verifiedHint: true }],
				{ "fsk4-12k5": 200 },
				240,
			),
			source: "checked-digital",
			out: "discarded:not-speech",
		},
		{
			name: "a fresh DMR decode",
			prior: channel(
				[{ ...uncheckedHint, confidence: "decoded" }],
				{ "fsk4-12k5": 200 },
				240,
			),
			source: "checked-digital",
			out: "discarded:not-speech",
		},
		{
			name: "M1: a verified DMR proof 2 h old, the TTL kept by a fresh unchecked hint only",
			prior: channel([uncheckedHint], { "fsk4-12k5": 200 }, 240, {
				digitalProofs: () => [
					{ ...sync("o1", old, true), verified: true },
					sync("o2", recent),
				],
				digitalSeenAt: () => recent,
			}),
			source: "unchecked-dmr",
			out: "hold",
		},
		{
			name: "M1: a verified DMR proof 2 h old, the TTL kept by a fresh digital-unknown candidate only",
			prior: channel(
				[{ ...unknownCandidate, confidence: "activity" }],
				{ "fsk4-12k5": 200 },
				240,
				{
					digitalProofs: () => [{ ...sync("o1", old, true), verified: true }],
					digitalSeenAt: () => recent,
				},
			),
			source: "digital-unknown",
			out: "hold",
		},
		{
			name: "a digital-unknown candidate beside unchecked DMR hints from 2 observations",
			prior: channel(
				[unknownCandidate, uncheckedHint],
				{ "fsk4-12k5": 200 },
				240,
				{
					digitalProofs: () => [sync("o1", recent), sync("o2", recent)],
				},
			),
			source: "unchecked-dmr",
			out: "hold",
		},
		{
			name: "a digital-unknown candidate beside the owner's recent DMR decode (backed as today)",
			prior: channel(
				[unknownCandidate, { ...uncheckedHint, confidence: "decoded" }],
				{ "fsk2-wide": 200 },
				240,
			),
			source: "digital-unknown",
			out: "discarded:not-speech",
		},
		{
			name: "the owner's POCSAG decode",
			prior: prior([decoded("pocsag")]),
			source: "dedicated",
			out: "discarded:not-speech",
		},
		{
			name: "a TDMA channel on its spectrum alone",
			prior: channel(
				[],
				{ "tdma-ms": 8 },
				8,
				{ digitalSeenAt: () => recent },
				"tdma-ms",
			),
			source: "tdma",
			out: "discarded:not-speech",
		},
	]
	for (const r of rows) {
		it(`${r.name}: ${String(r.source)}, ${r.out}`, () => {
			expect(priorReading(r.prior, false, NOW)).toEqual({
				strength: "tone-required",
				source: r.source,
			})
			const verdict = (final: boolean, snapshotClassed = true) =>
				finishVerdict({
					prior: r.prior,
					backedClass: false,
					ownTone: false,
					snapshotClassed,
					decodedOwn: false,
					joinedVoice: false,
					notSpeech: true,
					final,
					now: NOW,
				})
			expect(verdict(false)).toBe(r.out)
			expect(verdict(true)).toBe(r.out === "hold" ? "finish" : r.out)
			// Still tone-required for admission: a file no snapshot classed is a shadow's.
			expect(verdict(false, false)).toBe("discarded:known-non-voice")
		})
	}
	it("a weak or no prior has no source", () => {
		expect(priorReading(prior([], "fsk4-12k5"), false, NOW)).toEqual({
			strength: "suspect",
			source: null,
		})
		expect(priorReading(null, false, NOW)).toEqual({
			strength: "none",
			source: null,
		})
		expect(
			priorReading(prior([decoded("pocsag")], "unknown", true), false, NOW),
		).toEqual({ strength: "none", source: null })
	})
})

describe("finishVerdict: the strict clear-noise check under a weak prior", () => {
	// Feature: recording-verdict, the content check under a weak prior (speech-content.ts clearlyNoise).
	// Validates: docs/SCANNER.md, "Analog voice recordings" (the content check).
	/** The hardest synthetic speech at a CNR of 6 dB or more (HARD_SPEECH_CASES, 12 s). */
	const HARDEST_VOICE_DB = 10.16
	/** The largest range of the 120 s open-squelch noise files a listener confirmed (private). */
	const CONFIRMED_NOISE_DB = 5.61
	/**
	 * The smallest per-cut range of every voice case at a CNR of 5 dB or more at 250 frames (8 s;
	 * the shallow 50 % talker at 5 dB) and at 188 frames (6 s), from the bench's short-file table.
	 */
	const SHORT_VOICE_DB_AT_FLOOR = 8.99
	const SHORT_VOICE_DB_AT_6_S = 8.09
	// These guard the CONSTANTS against the measured figures above, copied from the bench
	// (scripts/bench/scanner-quality/speech-content.ts: the synthetic table and `--short`); they do
	// not measure audio. Re-run the bench and update the figures when the measure changes.
	it("the strict bound leaves at least 4 dB to the hardest synthetic voice and sits over confirmed noise", () => {
		expect(HARDEST_VOICE_DB - SPEECH_NOISE_MAX_RANGE_DB).toBeGreaterThanOrEqual(
			4,
		)
		expect(SPEECH_NOISE_MAX_RANGE_DB - CONFIRMED_NOISE_DB).toBeGreaterThan(0.35)
		expect(SPEECH_NOISE_MAX_RANGE_DB).toBeLessThan(SPEECH_STEADY_MAX_RANGE_DB)
		expect(SPEECH_NOISE_MAX_PERIODIC_SHARE).toBeLessThan(
			SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE,
		)
	})
	it("the strict bound's length floor is 8 s: 6 s falls short of 3 dB to short-file voice, 8 s keeps 2.99 dB", () => {
		expect(SPEECH_NOISE_MIN_FRAMES).toBe(250)
		expect((SPEECH_NOISE_MIN_FRAMES * SPEECH_FRAME_SAMPLES) / 8_000).toBe(8)
		// Never under two non-overlapping windows (188 frames, 6 s).
		expect(SPEECH_NOISE_MIN_FRAMES).toBeGreaterThanOrEqual(
			2 * SPEECH_WINDOW_FRAMES,
		)
		// 6 s falls short of 3 dB; 8 s, the longest floor tried, keeps 2.99 dB.
		expect(SHORT_VOICE_DB_AT_6_S - SPEECH_NOISE_MAX_RANGE_DB).toBeLessThan(3)
		expect(SHORT_VOICE_DB_AT_FLOOR - SPEECH_NOISE_MAX_RANGE_DB).toBeGreaterThan(
			2.95,
		)
	})
	const c = (
		maxRangeDb: number,
		periodicShare: number,
		frames = SPEECH_NOISE_MIN_FRAMES,
		maxBurstFrames = 0,
	): SpeechContent => ({ frames, maxRangeDb, periodicShare, maxBurstFrames })
	for (const [name, content, notSpeech, noise] of [
		["confirmed open-squelch noise (4.9 dB, 0.044)", c(4.9, 0.044), true, true],
		["just under both strict bounds", c(5.99, 0.099), true, true],
		["at the strict range bound", c(6, 0.01), true, false],
		["at the strict periodic bound", c(3, 0.1), true, false],
		["borderline: 7 dB (strong priors only)", c(7, 0.01), true, false],
		["at the steady bound", c(8.5, 0.01), false, false],
		["the hardest synthetic voice (10.16 dB)", c(10.16, 0.427), false, false],
		[
			"shorter than 3 s, however steady",
			c(1, 0, SPEECH_WINDOW_FRAMES - 1),
			false,
			false,
		],
		["steady but pitched (2FSK 1 200 Bd, 0.15)", c(3.36, 0.152), true, false],
		[
			"clear noise at the 8 s floor",
			c(4.9, 0.044, SPEECH_NOISE_MIN_FRAMES),
			true,
			true,
		],
		["clear noise past the floor (12 s)", c(4.9, 0.044, 375), true, true],
		[
			"clear noise one frame under the 8 s floor: not speech only",
			c(4.9, 0.044, SPEECH_NOISE_MIN_FRAMES - 1),
			true,
			false,
		],
		[
			"clear noise at 3 s (one window): not speech only",
			c(3.2, 0.01, SPEECH_WINDOW_FRAMES),
			true,
			false,
		],
		[
			"a burst one frame under the veto: clear noise",
			c(4.9, 0.044, SPEECH_NOISE_MIN_FRAMES, SPEECH_NOISE_MAX_BURST_FRAMES - 1),
			true,
			true,
		],
		[
			"a burst at the veto (96 ms): not speech only",
			c(4.9, 0.044, SPEECH_NOISE_MIN_FRAMES, SPEECH_NOISE_MAX_BURST_FRAMES),
			true,
			false,
		],
		[
			"a 0.3 s word on a quiet carrier (4 frames, the shortest synthetic burst): not speech only",
			c(3.3, 0.02, SPEECH_NOISE_MIN_FRAMES, 4),
			true,
			false,
		],
		[
			"a long burst leaves clearlyNotSpeech alone (the strong path): steady 4.9 dB",
			c(4.9, 0.044, SPEECH_NOISE_MIN_FRAMES, 40),
			true,
			false,
		],
	] as const)
		it(`${name}: not speech ${notSpeech}, clear noise ${noise}`, () => {
			expect(clearlyNotSpeech(content)).toBe(notSpeech)
			expect(clearlyNoise(content)).toBe(noise)
		})

	const recent = NOW - 60_000
	const fsk = (
		labels: Label[],
		extra: Partial<VoicePrior> = {},
	): VoicePrior => ({
		labels,
		class: "fsk4-12k5",
		analogVoice: () => false,
		classVotes: () => ({ total: 240, votes: { "fsk4-12k5": 200 } }),
		...extra,
	})
	const hint: Label = {
		protocol: "dmr",
		confidence: "activity",
		owner: true,
		at: recent,
		checkedHint: false,
		observationId: "o2",
	}
	const sync = (id: string): DigitalProof => ({
		protocol: "dmr",
		at: recent,
		checked: false,
		observationId: id,
	})
	const verdict = (
		p: VoicePrior | null,
		over: Partial<Parameters<typeof finishVerdict>[0]> = {},
	) =>
		finishVerdict({
			prior: p,
			backedClass: false,
			ownTone: false,
			snapshotClassed: true,
			decodedOwn: false,
			joinedVoice: false,
			notSpeech: true,
			clearNoise: true,
			final: false,
			now: NOW,
			...over,
		})
	// The live shape: one unchecked DMR sync hint on a channel mostly read analog-fm (suspect).
	const liveShape: VoicePrior = {
		labels: [hint],
		class: "analog-fm",
		analogVoice: () => false,
		classVotes: () => ({
			total: 256,
			votes: {
				"analog-fm": 150,
				"fsk4-12k5": 48,
				"fsk2-wide": 39,
				"fsk4-6k25": 19,
			},
		}),
	}
	for (const [name, p, over, out] of [
		[
			"suspect (one unchecked DMR hint, mostly analog-fm votes): clear noise discarded",
			liveShape,
			{},
			"discarded:not-speech",
		],
		[
			"suspect: borderline audio (not clear noise) held, then kept",
			liveShape,
			{ clearNoise: false },
			"hold",
		],
		[
			"suspect from a spectral class alone: clear noise discarded",
			prior([], "fsk4-12k5"),
			{},
			"discarded:not-speech",
		],
		[
			"digital-unknown-only channel: clear noise discarded",
			fsk([
				{
					protocol: "digital-unknown",
					confidence: "candidate",
					owner: true,
					at: recent,
				},
			]),
			{},
			"discarded:not-speech",
		],
		[
			"unchecked-dmr-only channel: clear noise discarded",
			fsk([hint], { digitalProofs: () => [sync("o1"), sync("o2")] }),
			{},
			"discarded:not-speech",
		],
		[
			"unchecked-dmr-only channel: borderline audio held",
			fsk([hint], { digitalProofs: () => [sync("o1"), sync("o2")] }),
			{ clearNoise: false },
			"hold",
		],
		[
			"FROZEN: its own CTCSS tone keeps",
			liveShape,
			{ ownTone: true },
			"finish",
		],
		[
			"FROZEN: an analog proof on the channel keeps",
			{ ...liveShape, analogVoice: () => true },
			{},
			"finish",
		],
		[
			"FROZEN: a joined voice keeps (held)",
			liveShape,
			{ joinedVoice: true },
			"hold",
		],
		["FROZEN: no prior keeps", null, {}, "finish"],
		[
			"FROZEN: a `none` prior (analog-fm class, no digital labels) keeps clear noise",
			prior([], "analog-fm"),
			{},
			"finish",
		],
		[
			"FROZEN: a `none` prior keeps clear noise at its final verdict too",
			prior([], "analog-fm"),
			{ final: true },
			"finish",
		],
		[
			"clear noise never without notSpeech (a toned or roll-over file)",
			liveShape,
			{ notSpeech: false },
			"hold",
		],
	] as const)
		it(name, () => {
			expect(verdict(p, over)).toBe(out)
		})

	it("the FROZEN no-prior and `none`-prior rows are `none` priors", () => {
		expect(priorReading(null, false, NOW).strength).toBe("none")
		expect(priorReading(prior([], "analog-fm"), false, NOW).strength).toBe(
			"none",
		)
		expect(priorReading(liveShape, false, NOW).strength).toBe("suspect")
	})
})
