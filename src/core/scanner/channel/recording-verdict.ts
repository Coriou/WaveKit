/**
 * The analog recorder's (WidebandAnalogRecorder) refusal and discard policy: when a recording is
 * refused, kept, or held provisional until its discovery's verdict settles. Pure: the recorder
 * gathers the evidence (its snapshots, the decode lookup, the discovery's standing prior) and
 * acts on the answer; nothing here reads a store or a clock.
 *
 * Three questions, one table each (docs/SCANNER.md, "Never digital or paging"):
 * - barredSnapshot: does this snapshot bar the recording (encrypted, opted out, unclean)?
 * - decodeDuring: was a non-voice decode of the discovery made while this transmission was on
 *   the air (the transmission's own, or a joined other one's)?
 * - admissionVerdict and finishVerdict: does the discovery's standing prior (a decode or class
 *   of it at any time, readPrior) refuse the recording at admission, discard it at its finish,
 *   hold it provisional for LATE_VERDICT_GRACE_MS, or keep it?
 */
import { familyOf } from "../classify/classifier.js"
import type { ScannerRecorderDecision } from "@wavekit/api-types"
import type {
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "../types.js"
import {
	digitalClass,
	notAnalogVoiceProtocol,
	type DecodedLabel,
} from "./voice-veto.js"

/** Why a snapshot bars a recording (encrypted, opted out, unclean track), or null when it does not. */
export function barredSnapshot(
	encrypted: boolean,
	recordAllowed: boolean,
	clean: boolean,
): ScannerRecorderDecision | null {
	if (encrypted) return "refused:encrypted"
	if (!recordAllowed) return "refused:record-disabled"
	if (!clean) return "refused:unclean"
	return null
}

/**
 * What evidence about a session's air time says (ownerVeto, decodeVeto): null, nothing; `own`,
 * its own signal is no analog voice (discarded); `joined`, a joined other transmission is (the
 * session ends at that join, the voice before it is kept).
 */
export type Veto = null | "own" | { readonly joined: string }

/**
 * What an own veto of a session does (ownVeto), decided on timing, not on class: `refuse`, no
 * joined observation needs sparing, the whole session is discarded; `keep`, a joined observation
 * with voice evidence (a snapshot classed it analog-fm, or the session's own audio did while it
 * was on the air, Session.joinedVoice) overlaps the owner (started at or before its close, or the
 * owner is still open): not separable, the files overlapping [from, until] are kept (+∞: such a
 * voice is still open) and none other; `split`, joined observations started after the owner's
 * track closed: the owner's part (up to `at`, the first such one's start) is discarded and the
 * ones still on the air (`spare`, whatever their class) start their own session (splitAtVoice),
 * from their onset when the session is live, not parked and the ring holds `at` (`restart`).
 * Only a voice that has already closed (`voiced`) with no restart keeps the session, its files
 * ending by `at` discarded (ownVetoEnds).
 */
export type OwnVeto =
	| { readonly kind: "refuse" }
	| { readonly kind: "keep"; readonly from: number; readonly until: number }
	| OwnVetoSplit

/** OwnVeto's `split`. */
export interface OwnVetoSplit {
	readonly kind: "split"
	readonly at: number
	readonly ownerLast: number
	readonly restart: boolean
	readonly voiced: boolean
	readonly spare: readonly string[]
}

/** An own veto `own` ends its session (refuse, or a split that is not a kept closed voice). */
export function ownVetoEnds(own: OwnVeto): boolean {
	return (
		own.kind === "refuse" ||
		(own.kind === "split" && (own.restart || !own.voiced))
	)
}

/** `d` was decoded at or after `from` (wall ms); an unknown time never was. */
export function decodedSince(d: DecodedLabel, from: number): boolean {
	return d.at !== null && Number.isFinite(d.at) && d.at >= from
}

/** A proof that cites no observation of its own (none, or a channel anchor's `decode:` id). */
export function citesNoObservation(observationId: string | null): boolean {
	return observationId === null || observationId.startsWith("decode:")
}

/**
 * `discoveryId`'s (or its merge owner's) decoded label from `lookup` (the recorder's
 * decodedLabel) when it is not analog voice; null otherwise, and when the lookup is absent,
 * throws or the id is null (an unreadable answer proves nothing: today's behaviour).
 */
export function notVoiceDecode(
	lookup: ((discoveryId: string) => DecodedLabel | null) | undefined,
	discoveryId: string | null,
): DecodedLabel | null {
	if (discoveryId === null || lookup === undefined) return null
	try {
		const d = lookup(discoveryId)
		return d !== null && notAnalogVoiceProtocol(d.protocol) ? d : null
	} catch {
		return null
	}
}

/**
 * Whose air time a non-voice decode `d` of the discovery falls in: none when it was made before
 * `airStartMs` (the pre-roll start less the decode skew); the owner's when it cites `owner`, or
 * cites no observation and was stamped at or after `onsetMs` (a decoder's lag can stamp an earlier
 * over's decode just after the next one starts); a joined one's when it cites one of `joins`.
 */
export function decodeDuring(
	d: DecodedLabel | null,
	owner: string,
	airStartMs: number,
	onsetMs: number,
	joins: { has(id: string): boolean },
): Veto {
	if (d === null || !decodedSince(d, airStartMs)) return null
	const by = d.observationId
	if (by === owner) return "own"
	if (citesNoObservation(by)) return decodedSince(d, onsetMs) ? "own" : null
	return by !== null && joins.has(by) ? { joined: by } : null
}

/**
 * A discovery's standing prior (DiscoveryStore.voicePrior): what is known about it at any time,
 * not only during one transmission. `labels` are the published labels of its live owner (merge
 * aliases resolved) and of its co-channel discoveries (same frequency key, at most
 * DQ_CO_CHANNEL_MAX = 8); `class` is the owner's stored class (the majority of its observations'
 * spectral votes: weak). `analogVoice` reads whether analog voice was heard on the channel (an
 * analog tone or analog voice proof of any of those observations, or an analog label at
 * `classified` or more); it walks up to 9 × 256 cached proofs, so it is asked only when a
 * non-voice or suspect prior would otherwise apply.
 */
export interface VoicePrior {
	readonly labels: readonly {
		readonly protocol: ScannerProtocol
		readonly confidence: ScannerConfidence
	}[]
	readonly class: ScannerClass
	analogVoice(): boolean
}

/**
 * How strong a prior is:
 * - `non-voice`: STRONG. A decode (confidence `decoded`) of a protocol that is not analog voice
 *   (voice-veto.ts notAnalogVoiceProtocol: pager, data, digital voice) on the owner or a co-channel
 *   discovery, or `strongClass`: a snapshot of the discovery with a digital class backed by more
 *   than the spectrum (a verified decode of that observation or the channel tier).
 * - `suspect`: WEAK. A digital class read from the spectrum alone (the stored class), a
 *   `digital-unknown` candidate, a dsd-fme sync hint (a digital voice label below `decoded`), or a
 *   non-voice protocol below `decoded`. Never refuses: a weak or low-deviation voice reads as a
 *   digital class for its whole length.
 * - `none`: nothing, or analog voice was heard on the channel (FROZEN: voice wins over any digital
 *   prior, as on a repeater that carries analog FM and DMR on one frequency).
 */
export type PriorStrength = "non-voice" | "suspect" | "none"

function weakDigital(prior: VoicePrior): boolean {
	if (digitalClass(prior.class)) return true
	return prior.labels.some(
		l =>
			l.protocol === "digital-unknown" ||
			(l.confidence !== "decoded" && notAnalogVoiceProtocol(l.protocol)),
	)
}

/** The prior's strength (PriorStrength); a throwing analogVoice reads as voice heard (keeps). */
export function readPrior(
	prior: VoicePrior | null,
	strongClass: boolean,
): PriorStrength {
	const decoded =
		prior?.labels.some(
			l => l.confidence === "decoded" && notAnalogVoiceProtocol(l.protocol),
		) === true
	const strong = decoded || strongClass
	if (!strong && (prior === null || !weakDigital(prior))) return "none"
	if (prior !== null && analogVoiceHeard(prior)) return "none"
	return strong ? "non-voice" : "suspect"
}

function analogVoiceHeard(prior: VoicePrior): boolean {
	try {
		if (
			prior.labels.some(
				l =>
					familyOf(l.protocol) === "analog" &&
					(l.confidence === "classified" || l.confidence === "decoded"),
			)
		)
			return true
		return prior.analogVoice()
	} catch {
		return true
	}
}

/** Admission: a strong non-voice prior refuses the recording (nothing is written). */
export function admissionVerdict(
	prior: VoicePrior | null,
	strongClass: boolean,
): ScannerRecorderDecision | null {
	return readPrior(prior, strongClass) === "non-voice"
		? "refused:not-analog"
		: null
}

/**
 * How long a provisional file waits for its discovery's verdict after its finish (ms). Identify
 * answers a new track within its queue wait (IDENTIFY_QUEUE_WAIT_MS 3 000) + the wait for a probe
 * slot to free (IDENTIFY_SLOT_FREEING_MAX_MS 8 000) + its probe timeout
 * (IDENTIFY_DEFAULT_TIMEOUT_MS 15 000) = 26 000 ms after the track appears; a file finishes no
 * earlier than its onset, so 26 s after the finish covers every decode identify makes of it.
 */
export const LATE_VERDICT_GRACE_MS = 3_000 + 8_000 + 15_000
/**
 * Provisional files held at once per source: the store admits MAX_ACTIVE_ANALOG_PER_SOURCE = 2
 * operations per source and a held file keeps its operation, so 2 − 1 = 1 is held and one stays
 * free for a new recording; a second one to hold finishes the older one now (kept).
 */
export const MAX_PROVISIONAL_PER_SOURCE = 1

/** What finishing a written file does: finish it (kept), hold it provisional, or discard it. */
export type FinishVerdict = "finish" | "hold" | "discarded:not-analog"

/**
 * A written file's fate at its finish (`final` false) or at the end of its grace (`final` true):
 * a file whose own audio carried speech over a CTCSS tone (`ownTone`) is always kept; a strong
 * non-voice prior discards it; a suspect prior holds it for LATE_VERDICT_GRACE_MS, and kept
 * after it when nothing stronger arrived; no prior keeps it at once.
 */
export function finishVerdict(input: {
	readonly prior: VoicePrior | null
	readonly strongClass: boolean
	readonly ownTone: boolean
	readonly final: boolean
}): FinishVerdict {
	if (input.ownTone) return "finish"
	const strength = readPrior(input.prior, input.strongClass)
	if (strength === "non-voice") return "discarded:not-analog"
	return strength === "suspect" && !input.final ? "hold" : "finish"
}
