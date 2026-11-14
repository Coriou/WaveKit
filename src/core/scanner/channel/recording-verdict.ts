/**
 * The analog recorder's (WidebandAnalogRecorder) refusal and discard policy: when a recording is
 * refused, kept, or held provisional until its discovery's verdict settles. Pure: the recorder
 * gathers the evidence (its snapshots, the decode lookup, the discovery's standing prior) and
 * acts on the answer; nothing here reads a store or a clock (callers pass `now`).
 *
 * Questions, one table each (docs/SCANNER.md, "Never digital or paging"):
 * - barredSnapshot: does this snapshot bar the recording (encrypted, opted out, unclean)?
 * - decodeDuring: was a non-voice decode of the discovery made while this transmission was on
 *   the air (the transmission's own, or a joined other one's)? fileDecodedOwn asks the same of a
 *   finished file.
 * - admissionVerdict and finishVerdict: does the discovery's standing prior (a decode or class
 *   of it at any time, readPrior) admit the recording only as a shadow its own audio must class,
 *   discard it at its finish, hold it provisional for LATE_VERDICT_GRACE_MS, or keep it?
 * - DigitalClassLedger: when has a backed digital class been seen often and recently enough on a
 *   discovery to count as a (suspect) prior?
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
 * A decode `d` of the discovery proves a finished file's own signal is not analog voice
 * (finishVerdict's `decodedOwn`): made at or after `airStartMs` (the file's start less the decode
 * skew) and citing the session's `owner`, or citing no observation and stamped at or after
 * `onsetMs` (the file's first in-track audio). The recorder asks it at the file's finish and when
 * its grace ends, and ends that grace as soon as another transmission is reported on the channel:
 * the discovery shows only its newest decode, so a decode of that later over (a DMR user keying
 * up after an analog one, the next page) would otherwise replace the file's own, or be taken
 * for it when it names no transmission. Null: nothing.
 */
export function fileDecodedOwn(
	d: DecodedLabel | null,
	owner: string,
	airStartMs: number,
	onsetMs: number,
): boolean {
	if (d === null || !decodedSince(d, airStartMs)) return false
	if (d.observationId === owner) return true
	return citesNoObservation(d.observationId) && decodedSince(d, onsetMs)
}

/**
 * A discovery's standing prior (DiscoveryStore.voicePrior): what is known about it at any time,
 * not only during one transmission. `id` is its live owner (merge aliases resolved; absent: the
 * id asked). `labels` are the published labels of that owner (`owner` true) and of its
 * co-channel discoveries (same frequency key, at most DQ_CO_CHANNEL_MAX = 8; `owner` false;
 * informational: readPrior reads both alike, see PriorStrength);
 * `class` is the owner's stored class (the majority of its observations' spectral votes: weak).
 * `analogVoice` reads whether analog voice was heard on the channel (an analog tone or analog
 * voice proof of any of those observations, or an analog label at `classified` or more); it walks
 * up to 9 × 256 cached proofs, so it is asked only when a digital prior would otherwise apply.
 */
export interface VoicePrior {
	readonly id?: string
	readonly labels: readonly {
		readonly protocol: ScannerProtocol
		readonly confidence: ScannerConfidence
		readonly owner: boolean
	}[]
	readonly class: ScannerClass
	analogVoice(): boolean
}

/**
 * How strong a prior is (docs/SCANNER.md, "Known digital or paging channels"):
 * - `tone-required`: STRONG. A decode (confidence `decoded`) of a pager or data protocol
 *   (voice-veto.ts notAnalogVoiceProtocol, any family but digital voice) on the owner or a
 *   co-channel discovery. A new recording starts as a shadow that writes nothing unless its own
 *   audio carries speech over a CTCSS tone (the recorder's classByTone); it is never a
 *   remembered refusal.
 * - `suspect`: WEAK. A digital voice decode (DMR, NXDN, YSF, dPMR, ...) on the owner or a
 *   co-channel discovery: the store keeps analog and digital overs of one channel in one
 *   discovery (a lone merge) as readily as in two, and PMR446 and DMR446, mixed-mode repeaters
 *   and shared business channels carry both on one frequency, so such a decode says nothing
 *   about the next over. Also `backedClass` (DigitalClassLedger.strong: the same evidence as such
 *   a decode), a digital class read from the spectrum alone (the stored class), a
 *   `digital-unknown` candidate, a dsd-fme sync hint (a digital voice label below `decoded`), or
 *   a non-voice protocol below `decoded`. Never refuses: a written file is held for
 *   LATE_VERDICT_GRACE_MS and discarded only by a decode of its own signal.
 * - `none`: nothing, or analog voice was heard on the channel (FROZEN: voice wins over any
 *   digital prior).
 */
export type PriorStrength = "tone-required" | "suspect" | "none"

const decodedNotVoice = (l: VoicePrior["labels"][number]): boolean =>
	l.confidence === "decoded" && notAnalogVoiceProtocol(l.protocol)

/** Strong (PriorStrength): a pager or data decode, of the owner or a co-channel discovery. */
function strongLabel(l: VoicePrior["labels"][number]): boolean {
	return decodedNotVoice(l) && familyOf(l.protocol) !== "digital-voice"
}

function weakDigital(prior: VoicePrior): boolean {
	if (digitalClass(prior.class)) return true
	return prior.labels.some(
		l =>
			l.protocol === "digital-unknown" ||
			(notAnalogVoiceProtocol(l.protocol) && !strongLabel(l)),
	)
}

/** The prior's strength (PriorStrength); a throwing analogVoice reads as voice heard (keeps). */
export function readPrior(
	prior: VoicePrior | null,
	backedClass: boolean,
): PriorStrength {
	const strong = prior?.labels.some(strongLabel) === true
	if (!strong && !backedClass && (prior === null || !weakDigital(prior)))
		return "none"
	if (prior !== null && analogVoiceHeard(prior)) return "none"
	return strong ? "tone-required" : "suspect"
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

/**
 * Admission: a strong prior admits the recording as a shadow that only its own audio can class
 * (`tone-required`: speech over a CTCSS tone, classByTone); null, admitted as usual. Nothing is
 * ever refused outright for a standing prior.
 */
export function admissionVerdict(
	prior: VoicePrior | null,
	backedClass: boolean,
): "tone-required" | null {
	return readPrior(prior, backedClass) === "tone-required"
		? "tone-required"
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
 * free for a new recording; a second one to hold finishes the older one now (kept), and so does a
 * track classed analog-fm that finds every recording slot of the source taken.
 */
export const MAX_PROVISIONAL_PER_SOURCE = 1

/** What finishing a written file does: finish it (kept), hold it provisional, or discard it. */
export type FinishVerdict = "finish" | "hold" | "discarded:not-analog"

/**
 * A written file's fate at its finish (`final` false) or at the end of its grace (`final` true),
 * in this order: a file whose own audio carried a CTCSS tone (`ownTone`) is always kept; one whose
 * own signal a decode proves not analog voice (`decodedOwn`, fileDecodedOwn) is discarded; under a
 * `tone-required` prior a file no snapshot classed analog-fm (`snapshotClassed` false: classed by
 * its own audio only) is discarded and one a snapshot classed is held, then kept; under a
 * `suspect` prior it is held, then kept; with none it is kept at once. A prior alone (a decode of
 * another transmission, a co-channel discovery's) never discards a file a snapshot classed.
 */
export function finishVerdict(input: {
	readonly prior: VoicePrior | null
	readonly backedClass: boolean
	readonly ownTone: boolean
	readonly snapshotClassed: boolean
	readonly decodedOwn: boolean
	readonly final: boolean
}): FinishVerdict {
	if (input.ownTone) return "finish"
	if (input.decodedOwn) return "discarded:not-analog"
	const strength = readPrior(input.prior, input.backedClass)
	if (strength === "tone-required" && !input.snapshotClassed)
		return "discarded:not-analog"
	return strength === "none" || input.final ? "finish" : "hold"
}

/**
 * Distinct observations a digital class backed by more than the spectrum (a verified decode, the
 * channel tier) must be seen on before it is a prior of their discovery (DigitalClassLedger, read
 * as `suspect`): one misread transmission never holds a channel's files.
 */
export const STRONG_CLASS_MIN_OBSERVATIONS = 2
/**
 * How long a backed digital class stays a prior after the older of the last two observations was
 * seen: 15 × 60 000 = 900 000 ms. Past it the channel reads its stored prior again (whose decodes
 * persist on their own), so a channel that turned analog is not held for the process's life.
 */
export const STRONG_CLASS_TTL_MS = 15 * 60_000
/** Discoveries the ledger remembers (the oldest noted goes first past it). */
export const STRONG_CLASS_MAX_DISCOVERIES = 1024

/**
 * Backed digital classes seen per live discovery (merge aliases resolved by the caller,
 * VoicePrior.id): `strong` (readPrior's `backedClass`) once STRONG_CLASS_MIN_OBSERVATIONS distinct observations were seen
 * within STRONG_CLASS_TTL_MS of now. Bounded: 2 observations per discovery, at most
 * STRONG_CLASS_MAX_DISCOVERIES discoveries.
 */
export class DigitalClassLedger {
	private readonly seen = new Map<string, { id: string; at: number }[]>()

	note(discoveryId: string, observationId: string, now: number): void {
		const list = (this.seen.get(discoveryId) ?? []).filter(
			e => e.id !== observationId,
		)
		list.push({ id: observationId, at: now })
		this.seen.delete(discoveryId)
		this.seen.set(discoveryId, list.slice(-STRONG_CLASS_MIN_OBSERVATIONS))
		if (this.seen.size > STRONG_CLASS_MAX_DISCOVERIES) {
			const oldest = this.seen.keys().next()
			if (oldest.done !== true) this.seen.delete(oldest.value)
		}
	}

	strong(discoveryId: string, now: number): boolean {
		const list = this.seen.get(discoveryId) ?? []
		return (
			list.length >= STRONG_CLASS_MIN_OBSERVATIONS &&
			list.every(e => now - e.at <= STRONG_CLASS_TTL_MS)
		)
	}
}

/** A provisional file's grace timer (WidebandAnalogDeps.timer's default): returns a cancel. */
export function graceTimer(ms: number, run: () => void): () => void {
	const t = setTimeout(run, ms)
	t.unref()
	return () => clearTimeout(t)
}
