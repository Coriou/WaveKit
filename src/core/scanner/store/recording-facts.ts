/**
 * Facts sidecar of a kept scanner analog recording: why the file ended, the recording
 * admission's measured numbers (speech-content.ts, the same numbers the noise quarantine keeps
 * for a discarded file), the owner it was kept for and the frequency and times it covers.
 * Before it these facts lived only in the recorder's "Analog file kept" log line.
 *
 * Where: `<scanner storage>/.analog-operations/<operationId>/facts.json`, the operation folder
 * beside the file's `intent.json` and `receipt.json` (the same folder the catalogue reads the
 * receipt from, recording-cut.ts). Not in the WAV's own folder: every walker of
 * `recordings/` (the listing, the legacy retention pool, the delete sweep, the alias scans)
 * would count a foreign file there as a recording or as residue. The operation folder is the
 * file's metadata unit: the store's one removal path (AnalogOperations.cleanupOwned) removes it
 * with the WAV, for retention, eviction, discovery deletion and recovery alike, so a sidecar is
 * never orphaned and never listed. Only a finalized (kept) file gets one: a noise cancel moves
 * its audio to the noise quarantine with that quarantine's own sidecar, any other cancel
 * deletes it, so neither leaves a facts file behind.
 *
 * Written after the keep decision (tmp + fsync + rename), best effort: a failed or skipped
 * write leaves the recording served as before, without facts. A reader treats a missing,
 * oversized or malformed sidecar, or one of another operation, as no facts (null).
 *
 * Size bound (arithmetic): the JSON's longest values are the ids (operation 36, discovery and
 * observation at most 128 each: 292 B), three ISO times (24 B each: 72 B), at most 14 finite
 * numbers (at most 24 B each as JSON: 336 B) and the closed codes (keptBy 32, cut 32, reason and
 * strength 64 each, branch 9: 201 B), plus about 520 B of member names and punctuation: about
 * 1 421 B. The tone member adds at most 57 B: the CTCSS form `,"tone":{"kind":"ctcss","hz":` and
 * `}` take 30 B and the bounded hz at most 18 (a double in 67..254.1 prints in at most 18
 * characters, e.g. 254.09999999999997): 48 B; the DCS form
 * `,"tone":{"kind":"dcs","code":"754","polarity":"inverted"}` takes 57 B. About 1 478 B in all.
 * RECORDING_FACTS_MAX_BYTES (2 048 B) holds that with room, and a writer refuses anything
 * larger.
 *
 * Tone: what the recorder's own per-file CTCSS bank and DCS decoder measured over the file's
 * activity, frozen when the file finished (their own analysed counts, never a span estimate: the
 * session runs on after the file and its later activity was never fed to them; a roll-over part's
 * carried-in tail is not fed to the new part's detectors either). Both hear the same tone audio
 * (the demodulated 8 kHz audio low-passed at 300 Hz). `{kind:"ctcss",hz}` when the bank settled on
 * a tone and no DCS code was confirmed; `{kind:"dcs",code,polarity}` when the DCS decoder confirmed a code (its three words) over
 * at least DCS_MIN_AUDIO_SECONDS, of the standard set when DCS_CODE_SET is "standard" (the live
 * transmission path's gate), the polarity as that path reports it: "normal" is the stream as
 * demodulated, "inverted" its complement. null ("No tone heard") only when both detectors analysed
 * enough audio and neither heard anything tone-like; absent ("not determined") otherwise. The
 * decision table is at toneFactOf. A tone that does not validate is dropped (the member absent),
 * never the whole sidecar, like the admission block. The store's operation folder budget
 * (MAX_OPERATION_METADATA_BYTES, 16 KiB) covers intent + receipt + sidecar: the sidecar is
 * skipped when the three would exceed it.
 */
import { z } from "zod"
import {
	DCS_CODE_SET,
	DCS_MIN_AUDIO_SECONDS,
	DCS_MIN_WORDS,
	DCS_STANDARD_CODES,
} from "@wavekit/api-types"
import type { RecordingFacts, RecordingTone } from "@wavekit/api-types"
import { CTCSS_HZ } from "../../audio-tones/ctcss.js"
import { NoiseQuarantineFactsSchema } from "./noise-quarantine.js"
import { MAX_OPERATION_METADATA_BYTES } from "./recording-operation.js"

export const RECORDING_FACTS_FILE = "facts.json"
export const RECORDING_FACTS_TEMP = "facts.tmp"
/** See the module comment for the arithmetic. */
export const RECORDING_FACTS_MAX_BYTES = 2048

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/
const CODE = /^[a-z][a-z-]{0,31}$/
const iso = z.string().datetime()
const finite = z.number().finite()

/** The tone audio's rate (8 kHz), the rate both the CTCSS bank and the DCS decoder run at. */
const TONE_RATE_HZ = 8000

/**
 * CTCSS analysis blocks the file's bank must have run before its "no tone" counts: 3, i.e. 1 s of
 * analysed audio (the first 500 ms block at 4 000 samples, then one per 250 ms hop of 2 000:
 * 4 000 + 2 × 2 000 = 8 000 samples), one block past the two the bank needs to answer at all
 * (ctcss.ts MIN_SAMPLES, 750 ms).
 */
export const TONE_MEASURED_MIN_BLOCKS = 3

/**
 * Samples the file's DCS decoder must have analysed before its code, or its "no code", counts:
 * DCS_MIN_AUDIO_SECONDS (0.75 s) at 8 kHz = 6 000, the live transmission path's DCS gate.
 */
export const DCS_MEASURED_MIN_SAMPLES = DCS_MIN_AUDIO_SECONDS * TONE_RATE_HZ

/**
 * A DCS word chain this long that never confirmed (DCS_MIN_WORDS, 3) is a partial code: 2 words,
 * the same 23-bit register exactly 23 bits apart; a second matching word after a chance hit has
 * p = 2^-23 more.
 */
export const DCS_PARTIAL_WORDS = DCS_MIN_WORDS - 1

/**
 * Seconds of noise or voice per chance DCS word hit (a chain started, DcsDecoder.loneHitCount):
 * a random register is a rotation of one of the 104 standard words or of their complements with
 * p ≈ 104 × 23 × 2 / 2^23 ≈ 5.7e-4 per bit, at 134.4 bit/s 0.077 hits/s, one per 13 s.
 * Modelled 60 s runs hit less: white or low-passed noise 1-3 times, random NRZ once, voice-like
 * audio never (its sliced bits come in long runs).
 */
export const DCS_CHANCE_HIT_SECONDS = 13

/**
 * Lone DCS word hits that make a file tone-like (absent, never "No tone heard"): at least
 * DCS_LONE_HITS_MIN and at least one per DCS_LONE_HIT_SECONDS analysed, four times the chance
 * rate. A code too broken to chain two words still hits many times a second (modelled: DCS 023
 * with one bit in 20 flipped, never 46 clean bits in a row, hits 13 times in 6 s). By chance
 * (Poisson, λ = seconds / 13): a 1 s file needs 2 hits (p ≈ 0.3%), a 6 s file 2 (λ = 0.46,
 * p ≈ 7.8%), a 30 s file 10 (λ = 2.3, p ≈ 1e-4), a 120 s file 40 (λ = 9.2, p < 1e-12): a chance
 * hit only ever turns a null into absent, the safe answer.
 */
export const DCS_LONE_HITS_MIN = 2
export const DCS_LONE_HIT_SECONDS = 3

/** What a file's tone detectors analysed when the file finished (their counters). */
export interface ToneCoverage {
	/** CTCSS analysis blocks run (CtcssBank.blockCount). */
	readonly ctcssBlocks: number
	/** Blocks some tone won (CtcssBank.votedBlockCount). */
	readonly votedBlocks: number
	/** Blocks no tone won whose best tone still dominated (CtcssBank.partialBlockCount). */
	readonly partialBlocks: number
	/** Samples the DCS decoder analysed (DcsDecoder.sampleCount, 8 kHz). */
	readonly dcsSamples: number
	/** Longest DCS word chain, confirmed or not (DcsDecoder.longestChain). */
	readonly dcsChain: number
	/** DCS word chains started, one per lone hit (DcsDecoder.loneHitCount). */
	readonly dcsLoneHits: number
	/** The DCS decoder's confirmed code (DcsDecoder.result()), before the gate. */
	readonly dcs: unknown
	/**
	 * The file was kept for its own tone: classed by it (ToneClassEvidence) or a roll-over part
	 * carrying that class. Never "No tone heard".
	 */
	readonly ownTone: boolean
}

/** Lowest and highest standard CTCSS tones (67.0 and 254.1 Hz): the bounds of `hz`. */
const CTCSS_MIN_HZ = CTCSS_HZ[0]
const CTCSS_MAX_HZ = CTCSS_HZ[CTCSS_HZ.length - 1]!

export const RecordingToneSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("ctcss"),
			hz: finite.min(CTCSS_MIN_HZ).max(CTCSS_MAX_HZ),
		})
		.strict(),
	/**
	 * A DCS code as three octal digits ("023") and its polarity as the live transmission path
	 * reports it ("normal": the stream as demodulated). The recorder always writes the polarity;
	 * a reader accepts a sidecar without one.
	 */
	z
		.object({
			kind: z.literal("dcs"),
			code: z.string().regex(/^[0-7]{3}$/),
			polarity: z.enum(["normal", "inverted"]).optional(),
		})
		.strict(),
])

/**
 * The DCS decoder's code `value` as the live transmission path gates it (analog-transmission.ts
 * gateTone and copyDcs): none before DCS_MEASURED_MIN_SAMPLES (exactly at it counts), none for a
 * malformed code or polarity, none outside DCS_STANDARD_CODES when DCS_CODE_SET is "standard".
 */
function gatedDcs(
	value: unknown,
	samples: number,
): { code: string; polarity: "normal" | "inverted" } | null {
	if (!(samples >= DCS_MEASURED_MIN_SAMPLES)) return null
	if (typeof value !== "object" || value === null) return null
	const { code, polarity } = value as { code?: unknown; polarity?: unknown }
	if (typeof code !== "string" || !/^[0-7]{3}$/.test(code)) return null
	if (DCS_CODE_SET === "standard" && !DCS_STANDARD_CODES.includes(code))
		return null
	if (polarity !== "normal" && polarity !== "inverted") return null
	return { code, polarity }
}

/** A finite count at or above `min`. */
const atLeast = (n: number, min: number): boolean =>
	Number.isFinite(n) && n >= min

/**
 * Lone DCS word hits above chance (DCS_LONE_HITS_MIN and one per DCS_LONE_HIT_SECONDS of the
 * `samples` analysed); a count that is not a finite number counts as above.
 */
function dcsHitsAboveChance(hits: number, samples: number): boolean {
	if (!Number.isFinite(hits) || !Number.isFinite(samples)) return true
	return (
		hits >= DCS_LONE_HITS_MIN &&
		hits * DCS_LONE_HIT_SECONDS * TONE_RATE_HZ >= samples
	)
}

/**
 * The tone fact of a file whose CTCSS bank answered `toneHz` with `coverage` at the file's
 * finish, as AnalogFinishFacts members. Decision table, first matching row wins ("analysed" is
 * what the detector processed for this file, never what the session was fed):
 *
 * | CTCSS         | DCS (gated)             | CTCSS blocks | DCS samples | own-tone keep | tone     |
 * | ------------- | ----------------------- | ------------ | ----------- | ------------- | -------- |
 * | any           | confirmed code          | any          | ≥ 6 000     | any           | dcs code |
 * | settled (hz)  | no code                 | any          | any         | any           | ctcss hz |
 * | no coverage   | -                       | -            | -           | -             | absent   |
 * | any           | any                     | any          | any         | yes           | absent   |
 * | any           | any                     | < 3          | any         | no            | absent   |
 * | any           | any                     | any          | < 6 000     | no            | absent   |
 * | voted, unset  | any                     | ≥ 3          | ≥ 6 000     | no            | absent   |
 * | leaned block  | any                     | ≥ 3          | ≥ 6 000     | no            | absent   |
 * | none          | partial (2 words)       | ≥ 3          | ≥ 6 000     | no            | absent   |
 * | none          | lone hits above chance  | ≥ 3          | ≥ 6 000     | no            | absent   |
 * | none          | none (chance hits only) | ≥ 3          | ≥ 6 000     | no            | null     |
 *
 * Both settled: DCS wins. A confirmed standard code is three identical 23-bit words exactly
 * 23 bits apart, one of 4 784 registers (104 codes × 23 rotations × 2 polarities) and then twice
 * the same register: about 5.7e-4 × 2^-46 per bit by chance; a CTCSS answer is a line that held
 * 0.65 of the band in 60% of the blocks, and a DCS word repeats every 23 bits, so its spectrum
 * is lines 134.4 / 23 ≈ 5.84 Hz apart, one of which can sit on a CTCSS tone's bin. "voted, unset": some block voted for a tone the bank did
 * not settle on (under 60% of the blocks: hang noise, gaps and untoned turnarounds dilute a toned
 * voice). "leaned block" (CtcssBank.partialBlockCount): a block no tone won still leaned on one
 * (a tone keyed on and off, or too weak under noise to vote). "lone hits above chance": a DCS code
 * too broken to chain two words. Voice and receiver noise put energy in the sub-audible band
 * without any of these: an untoned voice reads null. A count that is not a finite number is not
 * analysed.
 */
export function toneFactOf(
	toneHz: number | null,
	coverage: ToneCoverage | null,
): { readonly tone?: RecordingTone | null } {
	const dcs =
		coverage === null ? null : gatedDcs(coverage.dcs, coverage.dcsSamples)
	if (dcs !== null) return { tone: { kind: "dcs", ...dcs } }
	if (toneHz !== null) return { tone: { kind: "ctcss", hz: toneHz } }
	if (coverage === null) return {}
	if (coverage.ownTone) return {}
	if (!atLeast(coverage.ctcssBlocks, TONE_MEASURED_MIN_BLOCKS)) return {}
	if (!atLeast(coverage.dcsSamples, DCS_MEASURED_MIN_SAMPLES)) return {}
	if (coverage.votedBlocks !== 0 || coverage.partialBlocks !== 0) return {}
	if (!Number.isFinite(coverage.dcsChain)) return {}
	if (coverage.dcsChain >= DCS_PARTIAL_WORDS) return {}
	if (dcsHitsAboveChance(coverage.dcsLoneHits, coverage.dcsSamples)) return {}
	return { tone: null }
}

export const RecordingFactsSchema = z
	.object({
		version: z.literal(1),
		operationId: z.string().regex(UUID),
		/** The discovery whose folder the file was kept in (the session's owner at the keep). */
		discoveryId: z.string().regex(IDENTITY),
		observationId: z.string().regex(IDENTITY),
		/** The centre the recorder demodulated (binding targetHz), whole Hz; null when unknown. */
		frequencyHz: finite.nonnegative().nullable(),
		startedAt: iso.nullable(),
		endedAt: iso.nullable(),
		keptAt: iso,
		durationMs: finite.nonnegative().nullable(),
		finish: z
			.object({
				cut: z.string().regex(CODE),
				keptBy: z.string().regex(CODE).nullable(),
				speechHeard: z.boolean().nullable(),
				cutActive: z.boolean().nullable(),
			})
			.strict(),
		/** The recording admission's measured numbers; null when the recorder gave none. */
		admission: NoiseQuarantineFactsSchema.nullable(),
		/** The tone heard over the file; null: both detectors analysed enough and heard none; absent: not determined. */
		tone: RecordingToneSchema.nullable().optional(),
	})
	.strict()

/** The sidecar the schema reads is the API's shape, member for member. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const shapeCheck: Same<
	z.infer<typeof RecordingFactsSchema>,
	RecordingFacts
> = true
void shapeCheck

export interface RecordingFactsInput {
	operationId: string
	discoveryId: string
	observationId: string
	targetHz: number | null
	startedAt: string | undefined
	durationMs: number | null
	keptAt: number
	cut: string
	keptBy: string | undefined
	speechHeard: boolean | null | undefined
	cutActive: boolean | null
	admission: unknown
	/** The recorder's tone fact (toneFactOf); undefined: none, the member is left out. */
	tone?: unknown
}

/**
 * The sidecar's bytes for a kept file, or null when the facts do not validate or exceed
 * RECORDING_FACTS_MAX_BYTES. An admission block that does not validate is dropped (null), never
 * the whole sidecar: the recorder's numbers are a read-only pass-through. So is a tone that does
 * not validate: the member is left out.
 */
export function recordingFactsBytes(input: RecordingFactsInput): Buffer | null {
	const admission = NoiseQuarantineFactsSchema.safeParse(input.admission)
	const tone =
		input.tone === undefined
			? null
			: RecordingToneSchema.nullable().safeParse(input.tone)
	const startMs =
		input.startedAt === undefined ? Number.NaN : Date.parse(input.startedAt)
	const started = Number.isFinite(startMs)
		? new Date(startMs).toISOString()
		: null
	const endedAt =
		started !== null && input.durationMs !== null
			? new Date(startMs + input.durationMs).toISOString()
			: null
	const parsed = RecordingFactsSchema.safeParse({
		version: 1,
		operationId: input.operationId,
		discoveryId: input.discoveryId,
		observationId: input.observationId,
		frequencyHz:
			input.targetHz !== null && Number.isFinite(input.targetHz)
				? Math.round(input.targetHz)
				: null,
		startedAt: started,
		endedAt,
		keptAt: new Date(input.keptAt).toISOString(),
		durationMs: input.durationMs,
		finish: {
			cut: input.cut,
			keptBy: input.keptBy ?? null,
			speechHeard: input.speechHeard ?? null,
			cutActive: input.cutActive,
		},
		admission: admission.success ? admission.data : null,
		...(tone?.success === true ? { tone: tone.data } : {}),
	})
	if (!parsed.success) return null
	return withinFactsBound(Buffer.from(JSON.stringify(parsed.data)))
}

/** `bytes` when at most RECORDING_FACTS_MAX_BYTES (exactly at it is within), else null. */
export function withinFactsBound(bytes: Buffer): Buffer | null {
	return bytes.length > RECORDING_FACTS_MAX_BYTES ? null : bytes
}

/**
 * Whether a sidecar of `factsBytes` may join an operation folder whose intent and receipt take
 * `metadataBytes`: the sidecar within its own bound and the three within
 * MAX_OPERATION_METADATA_BYTES (exactly at either bound is within it).
 */
export function factsFitFolder(
	metadataBytes: number,
	factsBytes: number,
): boolean {
	return (
		factsBytes <= RECORDING_FACTS_MAX_BYTES &&
		metadataBytes + factsBytes <= MAX_OPERATION_METADATA_BYTES
	)
}

/** Parsed sidecar JSON of `operationId`, or null when it is not one (fail closed). */
export function recordingFactsOf(
	json: unknown,
	operationId: string,
): RecordingFacts | null {
	const parsed = RecordingFactsSchema.safeParse(json)
	if (!parsed.success) return null
	if (parsed.data.operationId.toLowerCase() !== operationId.toLowerCase())
		return null
	return parsed.data
}
