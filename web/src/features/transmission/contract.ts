// The one adapter between the web and the transmission contract: the facts sidecar of a kept scanner analog
// recording (`RecordingInventoryItem.facts`, RecordingFacts in @wavekit/api-types, read here with Zod because
// older cores lack it), the web's Transmission DTO (the shape GET /api/transmissions/:ref serves, TransmissionDto in
// @wavekit/api-types; the web still composes it itself, load.ts) and the alias refs the route also accepts besides a
// `tx_` id (`rec:` a recording key, `evt:` an Activity event, `obs:` a scanner observation). Everything else in the
// web imports these types from here, so moving the view onto the api-types shapes changes only this file.
import type { RecordingInventoryItem } from "@wavekit/api-types"
import { z } from "zod"

// ---- facts (the kept recording's sidecar)

/**
 * The sub-audible tone a kept analog recording carried: a CTCSS tone or a DCS code (three octal digits) with its
 * polarity when the core stored one ("normal": the stream as demodulated).
 */
export type RecordingTone =
	| { kind: "ctcss"; hz: number }
	| { kind: "dcs"; code: string; polarity?: "normal" | "inverted" }

/** The recording admission's measured numbers and the codes it decided on (expert data: Details only). */
export interface RecordingAdmissionFacts {
	frequencyHz: number | null
	reason: string | null
	strength: string | null
	branch?: "noise" | "data-buzz" | undefined
	levelFrames: number
	spreadDb: number
	p10Dbfs: number
	periodicShare: number
	burstFrames: number
	loudPitchShare?: number | undefined
	topSpreadDb?: number | undefined
	loudLevelDbfs?: number | null | undefined
}

/**
 * Facts of a kept scanner analog recording. `tone`: the value when the recorder settled on one; null when it
 * measured enough audio and no part held any tone; absent when it could not tell. `toneMalformed`: the core sent
 * a tone this web cannot read (it reads as not measured, never as "no tone").
 */
export interface RecordingFacts {
	version: 1
	operationId: string
	discoveryId: string
	observationId: string
	frequencyHz: number | null
	startedAt: string | null
	endedAt: string | null
	keptAt: string
	durationMs: number | null
	finish: {
		cut: string
		keptBy: string | null
		speechHeard: boolean | null
		cutActive: boolean | null
	}
	admission: RecordingAdmissionFacts | null
	tone?: RecordingTone | null | undefined
	toneMalformed?: boolean
}

const finite = z.number().finite()
const code = z.string().min(1).max(64)

/** A CTCSS tone's frequency: 67.0 to 254.1 Hz, a float hair either side. */
const CtcssHz = finite.min(66.95).max(254.15)
/** A DCS code: one to three octal digits. */
const DcsCode = z.string().regex(/^[0-7]{1,3}$/)

/** A CTCSS tone or a DCS code, as the recorder's facts store it. */
const ToneSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("ctcss"), hz: CtcssHz }),
	z.object({
		kind: z.literal("dcs"),
		code: DcsCode,
		polarity: z.enum(["normal", "inverted"]).optional(),
	}),
])

/**
 * The live demodulator's tone reading (an `analog-transmission` record's `tone`): the CTCSS tone or null, and,
 * from cores that check DCS, the DCS code or null. Other keys (the DTMF digits) are not read here.
 */
const LiveToneSchema = z.object({
	ctcssHz: CtcssHz.nullable(),
	dcs: z
		.object({ code: DcsCode, polarity: z.enum(["normal", "inverted"]) })
		.nullable()
		.optional(),
})

/** A live tone reading as read: what it heard, and whether it looked for DCS at all. */
export interface LiveToneReading {
	ctcssHz: number | null
	dcs: { code: string; polarity: "normal" | "inverted" } | null
	dcsChecked: boolean
}

/**
 * Reads a live record's raw tone: the reading, undefined when the record stored none, or "malformed" when it
 * stored one this web cannot read (null included: a stored reading is an object). A DCS code is zero padded.
 */
export function readLiveTone(
	raw: unknown,
): LiveToneReading | undefined | "malformed" {
	if (raw === undefined) return undefined
	const t = LiveToneSchema.safeParse(raw)
	if (!t.success) return "malformed"
	const dcs = t.data.dcs ?? null
	return {
		ctcssHz: t.data.ctcssHz,
		dcs:
			dcs === null
				? null
				: { code: dcs.code.padStart(3, "0"), polarity: dcs.polarity },
		dcsChecked: t.data.dcs !== undefined,
	}
}

const AdmissionSchema = z.object({
	frequencyHz: finite.nullable(),
	reason: code.nullable(),
	strength: code.nullable(),
	branch: z.enum(["noise", "data-buzz"]).optional(),
	levelFrames: finite,
	spreadDb: finite,
	p10Dbfs: finite,
	periodicShare: finite,
	burstFrames: finite,
	loudPitchShare: finite.optional(),
	topSpreadDb: finite.optional(),
	loudLevelDbfs: finite.nullable().optional(),
})

/** The sidecar without its tone: the tone is read on its own, so a bad tone never drops the other facts. */
const FactsSchema = z.object({
	version: z.literal(1),
	operationId: z.string().min(1).max(64),
	discoveryId: z.string().min(1).max(128),
	observationId: z.string().min(1).max(128),
	frequencyHz: finite.nullable(),
	startedAt: z.string().nullable(),
	endedAt: z.string().nullable(),
	keptAt: z.string(),
	durationMs: finite.nonnegative().nullable(),
	finish: z.object({
		cut: code,
		keptBy: code.nullable(),
		speechHeard: z.boolean().nullable(),
		cutActive: z.boolean().nullable(),
	}),
	admission: AdmissionSchema.nullable().catch(null),
})

/**
 * Reads a raw tone: the tone, null (measured, none heard), undefined (not measured) or "malformed" (present but
 * unreadable). A DCS code is zero padded to three digits ("23" → "023").
 */
export function readTone(
	raw: unknown,
): RecordingTone | null | undefined | "malformed" {
	if (raw === undefined) return undefined
	if (raw === null) return null
	const t = ToneSchema.safeParse(raw)
	if (!t.success) return "malformed"
	if (t.data.kind === "ctcss") return { kind: "ctcss", hz: t.data.hz }
	const code = t.data.code.padStart(3, "0")
	return t.data.polarity === undefined
		? { kind: "dcs", code }
		: { kind: "dcs", code, polarity: t.data.polarity }
}

/** Parses a facts sidecar as the core sends it; null when it is missing or not readable. */
export function parseFacts(raw: unknown): RecordingFacts | null {
	if (raw === null || typeof raw !== "object") return null
	const parsed = FactsSchema.safeParse(raw)
	if (!parsed.success) return null
	const facts: RecordingFacts = { ...parsed.data } as RecordingFacts
	if ("tone" in raw) {
		const tone = readTone((raw as { tone?: unknown }).tone)
		if (tone === "malformed") facts.toneMalformed = true
		else if (tone !== undefined) facts.tone = tone
	}
	return facts
}

/** The facts of a catalogue item (scanner analog recordings from a core that writes them); else null. */
export function factsOf(item: RecordingInventoryItem): RecordingFacts | null {
	return parseFacts((item as { facts?: unknown }).facts)
}

// ---- refs

/** What names a transmission until it has its own id: a recording key, an Activity event, an observation. */
export type TransmissionRef =
	| { recording: string }
	| { event: string }
	| { observation: string }

/** "rec:<key>", "evt:<id>", "obs:<id>": the alias forms GET /api/transmissions/:ref accepts. */
export function refText(ref: TransmissionRef): string {
	if ("recording" in ref) return `rec:${ref.recording}`
	if ("event" in ref) return `evt:${ref.event}`
	return `obs:${ref.observation}`
}

/** The ref of an alias text; null for anything else. */
export function parseRef(text: string): TransmissionRef | null {
	const m = /^(rec|evt|obs):(.{1,512})$/.exec(text)
	if (!m?.[1] || !m[2]) return null
	if (m[1] === "rec") return { recording: m[2] }
	if (m[1] === "evt") return { event: m[2] }
	return { observation: m[2] }
}

export function sameRef(a: TransmissionRef, b: TransmissionRef): boolean {
	return refText(a) === refText(b)
}

// ---- the Transmission DTO (the shape GET /api/transmissions/:ref serves; composed by the web, load.ts)

export type TransmissionKind =
	| "voice-analog"
	| "voice-digital"
	| "data"
	| "unknown"

/**
 * The sub-audible tone of one transmission, three honest states: `heard` (ctcssHz or dcs set; or neither, `why`
 * "not-stored": the recorder kept it for its tone and did not store which), `none` (the recorder measured it and
 * heard nothing: only ever from the recorder), `not-measured` (no answer: `why` says which reason a hint can give).
 */
export interface TransmissionTone {
	state: "heard" | "none" | "not-measured"
	ctcssHz: number | null
	dcs: { code: string; polarity: "normal" | "inverted" | null } | null
	/**
	 * Whether a live reading looked for DCS at all. False for the scanner recorder's tone, which says nothing of it:
	 * its stored null already rules DCS out (words.ts toneRow).
	 */
	dcsChecked: boolean
	from: "recorder" | "live-demod" | null
	/**
	 * Why it is not measured: no facts stored, not determined (the facts hold no tone: untoned voice and too little
	 * audio both leave it absent), an unreadable value, a kept recording known only through its Activity row (its
	 * facts not read), a live transmission whose Activity record could not be read, a live transmission whose record
	 * holds no tone (the live demodulator stores the same empty reading for short audio, a failed detector and old
	 * records, so an empty reading is never "none"). For `heard`: "not-stored", a tone heard but not stored.
	 */
	why:
		| "not-stored"
		| "no-facts"
		| "no-record"
		| "undetermined"
		| "malformed"
		| "no-recording"
		| "live-none"
		| null
}

export interface TransmissionArtefact {
	kind: "audio" | "demod" | "iq" | "evidence"
	/** The recording's stable key (the player's id; the file route takes it). */
	id: string
	/** The catalogue id (Keep and delete take it). */
	inventoryId: string | null
	bytes: number
	durationMs: number | null
	state: string
	/** Whether it is kept; null when the source does not say (never claims not kept). */
	kept: boolean | null
	expiresAt: string | null
}

export interface TransmissionMember {
	ref: string
	startedAt: string
	durationMs: number | null
	hasAudio: boolean
	/** The player's id when it has audio. */
	audioId: string | null
}

export interface TransmissionDto {
	/** The transmission id; null until the core assigns one. */
	id: string | null
	refs: {
		recordingKeys: string[]
		eventIds: string[]
		observationId: string | null
		discoveryId: string | null
		ownerDiscoveryId: string | null
		operationId: string | null
	}
	kind: TransmissionKind
	/** The kind of its recording (the catalogue's `kind`), when one is known; the header's icon follows it. */
	recordingKind: RecordingInventoryItem["kind"] | null
	protocol: string | null
	sourceId: string | null
	/** The raster channel, the measured centre and the saved name. */
	channel: { hz: number | null; measuredHz: number | null; name: string | null }
	/** When the audio started; null when nothing says (the view then shows no time, never an epoch date). */
	startedAt: string | null
	endedAt: string | null
	durationMs: number | null
	close: { reason: string; complete: boolean } | null
	part: { index: number; of: number } | null
	/** Null when it is not an analog FM transmission (no Tone row). */
	tone: TransmissionTone | null
	identity: {
		talkgroup: string | null
		radio: string | null
		label: string | null
	} | null
	signal: {
		snrDb: number | null
		peakDbfs: number | null
		flags: string[]
	} | null
	verdict: {
		speech: "heard" | "not-heard" | "unchecked"
		keptBy: string | null
		/** The item's own cut code (RecordingCut), when the facts have no finish. */
		itemCut: string | null
	}
	admission: RecordingAdmissionFacts | null
	artefacts: TransmissionArtefact[]
	noAudioReason: string | null
	group: {
		id: string | null
		heuristic: boolean
		members: TransmissionMember[]
	} | null
	/** Null: not computed (needs the core's ledger). */
	sameTime:
		| { ref: string; hz: number; kind: string; startedAt: string }[]
		| null
	channelSummary: {
		timesHeard: number | null
		since: string | null
		usualCtcssHz: number | null
	} | null
	gone: ("activity" | "observation" | "discovery" | "audio")[]
	/**
	 * Copies (ghosts: the same audio heard again on another frequency) of an analog recording: `of`, the original
	 * this one is a copy of; `copies`, the copies of this one (at most 8, `copiesTotal` all of them). Null or
	 * absent when neither (or not known: an older core).
	 */
	copy?: TransmissionCopyView | null
	/** The stored records as read, for the expert Details (never shown elsewhere). */
	raw: {
		recording: unknown
		activity: unknown
		facts: unknown
		observation: unknown
	}
}

/** TransmissionDto.copy: recording keys open with `{ recording: key }`; hz null when not known. */
export interface TransmissionCopyView {
	of: { recordingKey: string; hz: number | null } | null
	copies: { recordingKey: string; hz: number | null }[]
	copiesTotal: number
}

/** Freezes a DTO deeply: the view renders it and never changes it. */
export function freezeDto<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const v of Object.values(value)) freezeDto(v)
	}
	return value
}
