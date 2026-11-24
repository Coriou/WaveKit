/**
 * GET /api/transmissions/:ref: one transmission as the core knows it. `ref` is a transmission id
 * (`tx_<ULID>`) or an alias of one of its artefacts: `rec:<recording key>`, `evt:<Activity event
 * id>`, `obs:<scanner observation id>`. The shape is the web's transmission contract
 * (web/src/features/transmission/contract.ts) plus `privacy`; fields the core cannot fill yet are
 * null (`sameTime`, `channelSummary`, `channel.name`, `signal`). Types only: the route's bounds
 * live with it (src/api/routes/transmissions.ts, src/core/transmissions/dto.ts).
 */
import type {
	RecordingAdmissionFacts,
	RecordingInventoryItem,
} from "./recordings.js"

export type TransmissionErrorCode =
	| "TRANSMISSION_REF_INVALID"
	| "TRANSMISSION_NOT_FOUND"
	| "TRANSMISSIONS_UNAVAILABLE"

export interface TransmissionErrorBody {
	error: string
	code: TransmissionErrorCode
	message: string
}

export type TransmissionKind =
	| "voice-analog"
	| "voice-digital"
	| "data"
	| "unknown"

export interface TransmissionTone {
	state: "heard" | "none" | "not-measured"
	ctcssHz: number | null
	dcs: { code: string; polarity: "normal" | "inverted" | null } | null
	/** DCS was looked for: the live demodulator reported, or a recorder fact is a code or none. */
	dcsChecked: boolean
	from: "recorder" | "live-demod" | null
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
	/** The recording's stable key (the file route takes it). */
	id: string
	/** The catalogue id (Keep and delete take it). */
	inventoryId: string | null
	bytes: number
	durationMs: number | null
	state: string
	kept: boolean | null
	expiresAt: string | null
}

export interface TransmissionMember {
	ref: string
	startedAt: string
	durationMs: number | null
	hasAudio: boolean
	audioId: string | null
}

/**
 * Whether the transmission's audio may be served: `clear` (the serve rules allow it), `encrypted`,
 * `unproven` (a digital call whose clearance was never proven: no audio is listed). Null for analog.
 */
export type TransmissionPrivacy = "clear" | "encrypted" | "unproven"

export interface TransmissionDto {
	/** The transmission id; null for an artefact stored before ids existed. */
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
	recordingKind: RecordingInventoryItem["kind"] | null
	protocol: string | null
	sourceId: string | null
	channel: { hz: number | null; measuredHz: number | null; name: string | null }
	startedAt: string | null
	endedAt: string | null
	durationMs: number | null
	close: { reason: string; complete: boolean } | null
	part: { index: number; of: number } | null
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
	sameTime:
		| { ref: string; hz: number; kind: string; startedAt: string }[]
		| null
	channelSummary: {
		timesHeard: number | null
		since: string | null
		usualCtcssHz: number | null
	} | null
	gone: ("activity" | "observation" | "discovery" | "audio")[]
	raw: {
		recording: unknown
		activity: unknown
		facts: unknown
		observation: unknown
	}
	/** Null for analog transmissions (no encryption to prove). */
	privacy: TransmissionPrivacy | null
}
