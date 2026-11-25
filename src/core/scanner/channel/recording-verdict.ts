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
 *   of it, readPrior) admit the recording only as a shadow its own audio must class, discard it
 *   at its finish, hold it provisional for LATE_VERDICT_GRACE_MS, or keep it?
 * - joinedVoiceOverlaps: does a joined voice share a finished file (never discarded with it)?
 * - provisionalRoom: how many files of a source may be held at once?
 * - DigitalClassLedger: when has a backed digital class been seen often and recently enough on a
 *   discovery to count as a (suspect) prior?
 */
import { CLASS_HYPOTHESES, familyOf } from "../classify/classifier.js"
import type { ScannerRecorderDecision } from "@wavekit/api-types"
import type {
	ProtocolFamily,
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "../types.js"
import {
	digitalClass,
	notAnalogVoiceProtocol,
	type DecodedLabel,
} from "./voice-veto.js"
import {
	ADMISSION_DEFAULTS,
	ADMISSION_PROVEN_VOICE,
	admissionBranch,
	SPEECH_NOISE_MAX_PERIODIC_SHARE,
	type AdmissionThresholds,
	type SpeechContent,
} from "./speech-content.js"
import type { NoiseQuarantineFacts } from "../store/noise-quarantine.js"
import { DISCOVERY_NOISE_GATE } from "./noise-evidence.js"

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
 * A discovery's standing prior (DiscoveryStore.voicePrior): what its kept observations and
 * published labels say about it, not only during one transmission. `id` is its live owner (merge aliases resolved; absent: the
 * id asked). `labels` are the published labels of that owner (`owner` true) and of its
 * co-channel discoveries (same frequency key, at most DQ_CO_CHANNEL_MAX = 8; `owner` false;
 * informational: readPrior reads both alike, see PriorStrength);
 * Each label's `at` is its decode's wall time (ms; null unknown), so a strong one lapses
 * (STRONG_PRIOR_TTL_MS). `class` is the owner's stored class (the majority of its observations' spectral votes: weak).
 * `analogVoice` reads whether analog voice was heard on the channel (an analog tone or analog
 * voice proof of an observation those discoveries, or the channel's other discoveries (same
 * source and frequency key, newest seen first, 64 discoveries in all), still keep: each keeps its
 * last OBSERVATIONS_PER_DISCOVERY = 256, so a proof older than that many transmissions no longer
 * counts; or an analog label at `classified` or more); it walks up to 64 × 256 cached proofs, so
 * it is asked only when a digital prior would otherwise apply, or once at a file's finish when the
 * noise admission measures the file as noise.
 * `classVotes` (absent: none) counts the owner's observations that voted a class (`total`) and
 * how many voted each class (`votes`; a class absent: none); asked only for an owner's digital
 * label. A label's `checkedHint` (absent: false) is true for a dsd-fme sync hint that carries
 * checked content (verified TG/SRC, a talkgroup or encryption: not discovery-store's
 * uncheckedSyncHint); read only for a digital voice label below `decoded`. A label's
 * `verifiedHint` (absent: false) is true for a dsd-fme sync hint with verified TG/SRC only (a
 * talkgroup or an encryption flag alone is checked, not verified: dsd-fme reads those from one
 * header, and only verified content or a decode opens the content check). A label's
 * `observationId` (absent or null: unknown) is the observation its proof cites.
 * `digitalProofs` (absent: none) lists the digital proof of each of the owner's kept observations
 * (at most OBSERVATIONS_PER_DISCOVERY = 256), any rank: the published label shows only the
 * highest-ranked, newest one, so the digital-channel bar reads its freshness, checkedness and
 * distinct observations from these (digitalEvidence); asked only for an owner's digital label.
 * `digitalSeenAt` (absent: the digital proofs' newest time) is the wall time (ms; null: none) of
 * the owner's latest digital evidence: the newest kept observation carrying a digital proof (a
 * decode of a non-analog protocol, a dsd-fme sync hint, `digital-unknown`) or a `tdma-ms` class
 * vote (never a plain fsk4-*, fsk2 or gmsk vote: a weak NFM voice reads those); a digital channel's TTL runs from it (digitalChannel, tdmaChannel). Asked only
 * for an owner's digital label or a stored `tdma-ms` class, like `classVotes`.
 * `tdmaSeenAt` (absent: none) is the wall time (ms; null: none) of the owner's newest kept
 * observation that voted `tdma-ms`: the part of `digitalSeenAt` that is checked by its spectrum
 * (DMR burst structure), so a verified sighting older than the TTL is `checked-digital` only while
 * these or a verified sighting keep the channel fresh (digitalChannel). Asked like `classVotes`.
 * `analogTrials` (absent or null: none remembered) reads the owner's analog FM replay trials
 * (trial-memory.ts TrialMemory.analogFmTrials: how often they ran, how often they heard: speech, a
 * tone, or a failed trial that held a run of speech-like frames; `decoded` adds those of its linked
 * co-channel discoveries, `partnerIds`, that heard: analogTrialsHeard); asked only for a file that
 * measured no speech (noVoiceChannel).
 * `ownAnalogTrials` (absent or null: none remembered) reads the owner's own analog FM replay
 * trials alone: its attempts and its own trials that heard (analogTrialsHeard with no partners),
 * never a co-channel partner's. The positive class by speech (trialsVoiceChannel) reads only
 * these: partners' heard counts measured against the owner's attempts alone would lean a data
 * channel whose twins heard to voice (8 partners of 7 heard each on an owner of 7 of 81 read
 * 63 of 81).
 * `channelObservation` (absent: none is) says a joined observation is one of the owner's or of
 * a linked co-channel discovery's (`partnerIds`): its analog-fm snapshot class is the channel's
 * own spectral reading, not another transmission's voice (finishVerdict's `joinedVoiceIds`).
 * `knownObservation` (absent: every id counts as known) says the store indexes an observation at
 * all: an id it does not (never stored, retracted as a spur or image, trimmed or not yet
 * ingested) names no other discovery, so on a no-voice channel it does not exempt a file
 * (joinedOtherKnownVoice).
 */
export interface VoicePrior {
	readonly id?: string
	/** The owner's linked co-channel discoveries `labels` reads (at most 8; absent: none). */
	readonly partnerIds?: readonly string[]
	readonly labels: readonly {
		readonly protocol: ScannerProtocol
		readonly confidence: ScannerConfidence
		readonly owner: boolean
		readonly at: number | null
		readonly checkedHint?: boolean
		readonly verifiedHint?: boolean
		readonly observationId?: string | null
	}[]
	readonly class: ScannerClass
	analogVoice(): boolean
	classVotes?(): ClassVotes
	digitalProofs?(): readonly DigitalProof[]
	digitalSeenAt?(): number | null
	tdmaSeenAt?(): number | null
	readonly ownerDecode?: OwnerDecode | null
	readonly channelDecodes?: readonly OwnerDecode[]
	analogTrials?(): AnalogTrials | null
	ownAnalogTrials?(): AnalogTrials | null
	channelObservation?(observationId: string): boolean
	knownObservation?(observationId: string): boolean
}

/** VoicePrior.analogTrials: the owner's analog FM replay trials run, and those that heard. */
export interface AnalogTrials {
	readonly attempts: number
	readonly decoded: number
}

/** TrialMemory.analogFmTrials of one discovery (analogTrialsHeard's input). */
export interface AnalogTrialCounts {
	readonly attempts: number
	/** Trials that heard speech or a tone (`heard` or `decoded`). */
	readonly decoded: number
	/**
	 * Failed trials that still held a run of ANALOG_TRIAL_SYLLABIC_RUN_FRAMES (3) consecutive syllabic frames
	 * (analog-trial.ts syllabicHeard; absent: 0).
	 */
	readonly syllabic?: number
}

/**
 * VoicePrior.analogTrials from trial memory: the owner's attempts, and every trial that heard,
 * the owner's and its linked co-channel partners' alike. A trial heard when it decoded (speech or
 * a tone) or, whatever its own outcome (no-sync, carrier-only, low audio), held a run of 3 consecutive
 * syllabic frames (a syllable; scattered noise frames do not count): a weak, distant repeater whose
 * trials keep failing still shows such runs, so it
 * never becomes a no-voice channel by trial count alone. A partner's misses never add (its
 * attempts are not counted). Null owner: null (no trial remembered).
 */
export function analogTrialsHeard(
	owner: AnalogTrialCounts | null,
	partners: readonly (AnalogTrialCounts | null)[] = [],
): AnalogTrials | null {
	if (owner === null) return null
	const heard = (t: AnalogTrialCounts | null): number =>
		t === null ? 0 : t.decoded + (t.syllabic ?? 0)
	let decoded = heard(owner)
	for (const p of partners) decoded += heard(p)
	return { attempts: owner.attempts, decoded }
}

/**
 * Analog FM replay trials of the owner that must have run, none hearing anything, before its
 * channel is a no-voice channel (noVoiceChannel): 10. One trial replays one captured over and
 * hears speech or a CTCSS tone when either is there; a voice channel's trials hear (a
 * measured voice channel: more than half), so ten misses of every over tried is a channel the
 * spectrum calls analog FM but that carries none (measured noise channels: dozens to hundreds
 * of trials, none heard).
 */
export const NO_VOICE_CHANNEL_MIN_TRIALS = 10

/**
 * Heard trials (VoicePrior.analogTrials `decoded`: the owner's and its partners' trials that heard
 * speech, a tone or a syllabic run) a channel needs before its trials count as having heard voice:
 * 2, and more than NO_VOICE_CHANNEL_MIN_HEARD_PERCENT of the owner's attempts. One stray syllabic
 * run (a noise burst that happened to look syllabic) on a channel tried 146 times never clears it.
 */
export const NO_VOICE_CHANNEL_MIN_HEARD = 2
/**
 * The share of the owner's attempts, in percent, its heard trials must exceed (strictly): 2. A
 * measured voice channel's trials hear more than half of its overs; 2 of 146 (1.37 %) is noise,
 * 3 of 146 (2.05 %) or 2 of 50 (4 %) is voice. Compared in integers: heard × 100 > attempts × 2.
 */
export const NO_VOICE_CHANNEL_MIN_HEARD_PERCENT = 2

/**
 * The trials heard voice on the channel: heard trials ≥ NO_VOICE_CHANNEL_MIN_HEARD and more than
 * NO_VOICE_CHANNEL_MIN_HEARD_PERCENT of the owner's attempts (noVoiceChannel).
 */
export function trialsHeardVoice(t: AnalogTrials): boolean {
	return (
		t.decoded >= NO_VOICE_CHANNEL_MIN_HEARD &&
		t.decoded * 100 > t.attempts * NO_VOICE_CHANNEL_MIN_HEARD_PERCENT
	)
}

/**
 * Heard trials (VoicePrior.ownAnalogTrials `decoded`: the owner's own) a channel needs before
 * the recorder's own-audio class may class an untoned voiced shadow by its speech alone (trialsVoiceChannel): 10. Ten
 * heard replays are ten overs the analog trial called speech, a tone or a syllabic run; a stray
 * syllabic run on a data channel is one or two (measured: no pager, DMR, P25 or D-STAR channel
 * reached 10 % of its trials heard).
 */
export const VOICE_CHANNEL_MIN_HEARD = 10
/**
 * The share of the owner's attempts, in percent, its heard trials must reach (at least): 30.
 * Measured: voice channels 70 to 91 %, the highest non-voice channel 9 % (7 of 81), none
 * between; 30 leaves 21 points over the highest non-voice share and 40 under the lowest voice
 * one. Compared in integers: heard × 100 ≥ attempts × 30 (10 of 33 = 30.3 % passes, 10 of 34 =
 * 29.4 % fails).
 */
export const VOICE_CHANNEL_MIN_HEARD_PERCENT = 30

/**
 * The channel's own analog FM replay trials heard voice often (VoicePrior.ownAnalogTrials: at
 * least VOICE_CHANNEL_MIN_HEARD of the owner's own trials heard and
 * VOICE_CHANNEL_MIN_HEARD_PERCENT of its attempts; a co-channel partner's trials never count,
 * unlike the no-voice check's VoicePrior.analogTrials): the trial-memory half of the recorder's
 * class by speech alone (wideband-analog-recorder.ts classBySpeech). No prior, no owner-only
 * trial reader, none remembered or a throwing read: false.
 */
export function trialsVoiceChannel(prior: VoicePrior | null): boolean {
	if (prior?.ownAnalogTrials === undefined) return false
	let t: AnalogTrials | null
	try {
		t = prior.ownAnalogTrials()
	} catch {
		return false
	}
	return (
		t !== null &&
		Number.isFinite(t.decoded) &&
		Number.isFinite(t.attempts) &&
		t.decoded >= VOICE_CHANNEL_MIN_HEARD &&
		t.decoded * 100 >= t.attempts * VOICE_CHANNEL_MIN_HEARD_PERCENT
	)
}

/**
 * A no-voice channel (docs/SCANNER.md, "Channels whose trials never heard voice"): the owner's
 * analog FM replay trials ran NO_VOICE_CHANNEL_MIN_TRIALS times or more and did not hear voice
 * (trialsHeardVoice: fewer than 2 heard trials, or 2 % of the attempts or less; a trial heard
 * speech, a tone or a run of 3 consecutive syllabic frames: VoicePrior.analogTrials,
 * analogTrialsHeard), and no analog voice was heard on the channel (an analog tone or voice
 * proof, or an analog label at `classified` or more: analogVoiceHeard). Its files are kept only
 * when their own audio shows speech (finishVerdict's `speechHeard`). Not one when its trials
 * cannot be read (noVoiceReading null: keeps).
 */
export function noVoiceChannel(prior: VoicePrior | null): boolean {
	return noVoiceReading(prior) === true
}

/**
 * noVoiceChannel as read: true or false when the owner's trials were read (none remembered:
 * false), null when they could not be (no prior, no trial reader, a throwing read).
 */
export function noVoiceReading(prior: VoicePrior | null): boolean | null {
	if (prior?.analogTrials === undefined) return null
	let t: AnalogTrials | null
	try {
		t = prior.analogTrials()
	} catch {
		return null
	}
	return (
		t !== null &&
		t.attempts >= NO_VOICE_CHANNEL_MIN_TRIALS &&
		!trialsHeardVoice(t) &&
		!analogVoiceHeard(prior)
	)
}

/**
 * VoicePrior.ownerDecode: the newest decode with an identity the decode path placed on the owner
 * (DiscoveryStore.applyEvidenceResult accepted it for an observation of the owner), whatever
 * record it then landed on: a page of another capcode lands on a co-channel twin, so the owner's
 * published label can show a proof a day old while its channel pages every hour. `at` its wall
 * time (ms). Read like an owner label decoded as `protocol` (strongLabel).
 * VoicePrior.channelDecodes (absent: none): the same memo per channel (the owner's source and
 * frequency key, which co-channel twins share: the newest decode per protocol) and the entry of
 * each live co-channel discovery (at most DQ_CO_CHANNEL_MAX = 8), read alike: a paging channel
 * holds one discovery per capcode, and a page refreshes only the twin it was placed on, so the
 * prior is the channel's newest dedicated-channel decode, whichever twin holds it (ownerDecoded).
 */
export interface OwnerDecode {
	readonly protocol: ScannerProtocol
	readonly at: number
}

/**
 * VoicePrior.digitalProofs: the digital proof of one kept observation of the owner (a digital
 * voice decode, or a dsd-fme sync hint), whatever its rank: `at` its wall time (ms), `checked`
 * true for a decode or a hint with checked content, `verified` (absent: false) true for a decode
 * or a hint with verified TG/SRC (a talkgroup or an encryption flag alone is checked only),
 * `colourCode` (absent: false) true for a sync hint that read a colour code (unverified CC).
 */
export interface DigitalProof {
	readonly protocol: ScannerProtocol
	readonly at: number
	readonly checked: boolean
	readonly verified?: boolean
	readonly colourCode?: boolean
	readonly observationId: string
}

/** VoicePrior.classVotes: the owner's observations with a class vote, and the count per class. */
export interface ClassVotes {
	readonly total: number
	readonly votes: Readonly<Partial<Record<ScannerClass, number>>>
}

/**
 * How strong a prior is (docs/SCANNER.md, "Known digital or paging channels"):
 * - `tone-required`: STRONG. A dated decode (confidence `decoded`) of a protocol made only on a
 *   channel of its own (DEDICATED_CHANNEL_FAMILIES: a pager, or APRS, AIS, ACARS, VDL2, ADS-B):
 *   the newest of the owner's and its co-channel discoveries' (published labels and the decode
 *   path's memo, VoicePrior.ownerDecode and channelDecodes: a paging channel holds one discovery
 *   per capcode) made within OWNER_DEDICATED_PRIOR_TTL_MS (24 h) of now (each new decode on the
 *   channel refreshes it: a quiet night does not make a pager channel a voice channel; an older or
 *   undated one is only `suspect`). A new recording, and a file of a transmission that joined a
 *   recording while the prior was strong, is a shadow that writes nothing unless its own audio
 *   carries speech over a CTCSS tone (the recorder's classByTone); it is never a remembered
 *   refusal.
 *   Also STRONG (digitalChannel): a digital sighting of the owner itself (its published label or
 *   any kept observation's digital proof: a digital voice decode, a dsd-fme sync hint with
 *   checked content, or `digital-unknown` from data-like audio) dated within STRONG_PRIOR_TTL_MS
 *   of now, while at least DIGITAL_CHANNEL_MIN_SHARE of the owner's class votes
 *   (DIGITAL_CHANNEL_MIN_VOTES or more) read a class that protocol is transmitted as
 *   (digitalChannelClasses): a channel its own spectrum and its own decoder both call digital,
 *   with no analog proof among its kept observations, is not untoned voice. Unchecked DMR sync
 *   hints alone also make one when that share reads `tdma-ms` alone, or when they come from
 *   DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS distinct observations within STRONG_PRIOR_TTL_MS of
 *   now. Checked sightings are those of the owner's kept observations, of any age; the TTL runs
 *   from the owner's latest digital evidence (VoicePrior.digitalSeenAt: a digital proof or a
 *   `tdma-ms` class vote of any kept observation; a plain fsk4-*, fsk2 or gmsk spectral vote never
 *   refreshes it, since a weak NFM voice reads those), so a DMR channel identify no longer probes
 *   stays one while its overs keep reading TDMA. An analog proof or label ends it; so does
 *   STRONG_PRIOR_TTL_MS without any digital evidence. Any other unchecked sync hint, an undated
 *   label, or votes for another protocol's class are only `suspect`. Its source (StrongSource) is
 *   `checked-digital`, which opens the content check, only when a verified sighting (a decode or
 *   a hint with verified TG/SRC) of that protocol is within the TTL, or a verified one of any age
 *   while a `tdma-ms` vote (VoicePrior.tdmaSeenAt) is; a channel kept fresh only by weak
 *   evidence (an unchecked hint, a `digital-unknown` candidate) or barred by a talkgroup or
 *   encryption hint alone reads `unchecked-dmr` (a digital voice sighting is the freshest weak
 *   evidence) or `digital-unknown`: tone-required for admission, its files held, then kept.
 *   Also STRONG (tdmaChannel), whatever its label: a stored class of `tdma-ms` read by
 *   at least TDMA_CHANNEL_MIN_VOTES of the owner's observations and TDMA_CHANNEL_MIN_SHARE of
 *   its votes, its latest digital evidence within the TTL. TDMA burst structure is DMR's; an NFM
 *   voice never reads it (unlike fsk4-12k5, fsk4-6k25 or gmsk-narrow, which a weak or
 *   low-deviation voice reads: those stay `suspect`).
 * - `suspect`: WEAK. A digital voice decode (DMR, NXDN, YSF, dPMR, ...) on the owner or a
 *   co-channel discovery: the store keeps analog and digital overs of one channel in one
 *   discovery (a lone merge) as readily as in two, and PMR446 and DMR446, mixed-mode repeaters
 *   and shared business channels carry both on one frequency, so such a decode says nothing
 *   about the next over. So is an `ism` (rtl_433 sensor) or LoRa decode, owner's or co-channel:
 *   untoned LPD voice shares the 433 and 868 MHz channels with sensors and Meshtastic. Also
 *   `backedClass` (DigitalClassLedger.strong: the same evidence as such
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

/**
 * The families whose decodes are made only on channels of their own (PriorStrength's strong): a
 * pager (POCSAG, FLEX) and the packet protocols (APRS, AIS, ACARS, VDL2, ADS-B) but those in
 * SHARED_CHANNEL_PROTOCOLS. Not here: digital voice and `ism` (rtl_433 sensors), which share
 * channels with untoned analog voice (433 MHz LPD voice beside its sensors).
 */
const DEDICATED_CHANNEL_FAMILIES: ReadonlySet<ProtocolFamily> = new Set([
	"pager",
	"packet",
])
/**
 * Packet protocols decoded on channels analog voice shares: LoRa (Meshtastic) on the 433 and
 * 868 MHz LPD and SRD channels. Suspect even as the owner's own label: the store files a voice
 * and a sensor or mesh burst of one channel in one discovery as readily as in two.
 */
const SHARED_CHANNEL_PROTOCOLS: ReadonlySet<ScannerProtocol> = new Set(["lora"])

/**
 * How long a digital channel stays a strong prior after its latest digital evidence: 30 × 60 000 =
 * 1 800 000 ms. Past it the prior is only `suspect`: its files are held and discarded only by a
 * decode of their own signal or by the content check (contentChecked). A dedicated-channel decode
 * (the owner's or a co-channel discovery's) lasts OWNER_DEDICATED_PRIOR_TTL_MS (strongLabel).
 */
export const STRONG_PRIOR_TTL_MS = 30 * 60_000
/**
 * How long a dedicated-channel decode (a pager, APRS, AIS, ...) on the channel stays a strong prior
 * after it was made: 24 × 3 600 000 = 86 400 000 ms, counted from the newest such decode of the
 * owner or a co-channel discovery (a published label's proof, or the decode path's memo), so each
 * new page on the channel refreshes it, whichever capcode's twin it lands on; a pager channel
 * quiet for a day reads `suspect` again.
 */
export const OWNER_DEDICATED_PRIOR_TTL_MS = 24 * 3_600_000

/**
 * Strong (PriorStrength): a dated decode of a dedicated-channel protocol, the owner's or a
 * co-channel discovery's, made in [now − OWNER_DEDICATED_PRIOR_TTL_MS,
 * now + OWNER_DEDICATED_PRIOR_TTL_MS] (a clock skew either way).
 */
function strongLabel(l: VoicePrior["labels"][number], now: number): boolean {
	return (
		decodedNotVoice(l) &&
		DEDICATED_CHANNEL_FAMILIES.has(familyOf(l.protocol)) &&
		!SHARED_CHANNEL_PROTOCOLS.has(l.protocol) &&
		l.at !== null &&
		Number.isFinite(l.at) &&
		Math.abs(now - l.at) <= OWNER_DEDICATED_PRIOR_TTL_MS
	)
}

/**
 * A fresh dedicated-channel decode the decode path placed on the owner or a co-channel discovery
 * (VoicePrior.ownerDecode, channelDecodes): at most 1 + DQ_CO_CHANNEL_MAX = 9 reads.
 */
function ownerDecoded(prior: VoicePrior, now: number): boolean {
	const fresh = (d: OwnerDecode | null | undefined): boolean =>
		d !== undefined &&
		d !== null &&
		strongLabel(
			{ protocol: d.protocol, confidence: "decoded", owner: true, at: d.at },
			now,
		)
	return fresh(prior.ownerDecode) || (prior.channelDecodes ?? []).some(fresh)
}

/**
 * The FSK classes a digital channel's spectrum reads: 4FSK at either width, TDMA and wide 2FSK.
 * Not GMSK: a weak NFM voice reads gmsk-narrow.
 */
export const FSK_CLASSES: ReadonlySet<ScannerClass> = new Set([
	"fsk4-12k5",
	"fsk4-6k25",
	"tdma-ms",
	"fsk2-wide",
])
/**
 * The classes a `digital-unknown` candidate's channel may read (digitalChannelClasses): FSK_CLASSES
 * but `fsk4-6k25`, which a weak or low-deviation NFM voice reads for its whole length, like
 * gmsk-narrow.
 */
const DIGITAL_UNKNOWN_CLASSES: ReadonlySet<ScannerClass> = new Set(
	[...FSK_CLASSES].filter(c => c !== "fsk4-6k25"),
)
const NO_CLASSES: ReadonlySet<ScannerClass> = new Set()
const protocolClasses = new Map<ScannerProtocol, ReadonlySet<ScannerClass>>()

/**
 * The class votes that make a channel with `protocol`'s label a digital channel: `digital-unknown`,
 * DIGITAL_UNKNOWN_CLASSES; a digital voice protocol, the FSK_CLASSES whose classifier hypotheses
 * (CLASS_HYPOTHESES) name it: dmr tdma-ms and fsk4-12k5; ysf, p25p1 and nxdn96 fsk4-12k5; dpmr and
 * nxdn48 fsk4-6k25; dstar (gmsk-narrow) and p25p2 (no class) none, so they are never a digital
 * channel. Any other protocol: none.
 */
export function digitalChannelClasses(
	protocol: ScannerProtocol,
): ReadonlySet<ScannerClass> {
	if (protocol === "digital-unknown") return DIGITAL_UNKNOWN_CLASSES
	if (familyOf(protocol) !== "digital-voice") return NO_CLASSES
	const hit = protocolClasses.get(protocol)
	if (hit !== undefined) return hit
	const classes = new Set(
		[...FSK_CLASSES].filter(c =>
			CLASS_HYPOTHESES[c].some(h => h.protocol === protocol),
		),
	)
	protocolClasses.set(protocol, classes)
	return classes
}

/** The share of the owner's class votes a digital channel needs (digitalChannel): 1 / 3. */
export const DIGITAL_CHANNEL_MIN_SHARE = 1 / 3
/** Class votes of the owner a digital channel needs (digitalChannel) before its share counts. */
export const DIGITAL_CHANNEL_MIN_VOTES = 4

/**
 * Distinct owner observations an UNCHECKED DMR sync hint needs within the TTL on a channel whose
 * DMR-class votes reach the share without TDMA (digitalChannel, rule b): 2. One spurious sync on
 * an NFM channel that reads fsk4-12k5 must not bar it; syncs across overs are a DMR channel.
 */
export const DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS = 2

/** An owner digital label of any rank, `at` in the TTL window (digitalEvidence's input). */
interface DigitalSighting {
	readonly protocol: ScannerProtocol
	readonly at: number | null
	readonly checked: boolean
	readonly verified: boolean
	readonly observationId: string | null
}

/**
 * Per protocol: a checked sighting (any age), a verified one (any age; `verifiedFresh`: within the
 * TTL), and the distinct unchecked observations within the TTL.
 */
interface DigitalEvidence {
	checked: boolean
	verified: boolean
	verifiedFresh: boolean
	readonly unchecked: Set<string>
}

const inTtl = (at: number | null, now: number): at is number =>
	at !== null &&
	Number.isFinite(at) &&
	Math.abs(now - at) <= STRONG_PRIOR_TTL_MS
const dated = (at: number | null): at is number =>
	at !== null && Number.isFinite(at)

/** A digital voice protocol or `digital-unknown`: the labels digitalChannel reads. */
const digitalProtocol = (p: ScannerProtocol): boolean =>
	p === "digital-unknown" || familyOf(p) === "digital-voice"

/**
 * One pass over the owner's dated digital sightings: checked ones of any age (digitalChannel reads
 * freshness from the latest digital evidence instead), unchecked ones only within
 * STRONG_PRIOR_TTL_MS of `now` (rule b counts recent overs only): its published labels (`digital-unknown` and a decode
 * or checked hint are checked) and, when the store gives them, the digital proofs of its kept
 * observations (VoicePrior.digitalProofs), so a newer unchecked hint never hides a checked one
 * and a decode no longer shown still counts. An unchecked sighting counts by its observation; a
 * published label citing none counts as one only when no observation proofs are given (it is one
 * of them otherwise). `latest`: the newest sighting's time (−∞: none). `weakVoiceFresh`: a
 * digital voice sighting that is not verified (an unchecked hint, or one with a talkgroup or
 * encryption flag only) within the TTL.
 */
function digitalEvidence(
	prior: VoicePrior,
	now: number,
): {
	readonly byProtocol: Map<ScannerProtocol, DigitalEvidence>
	readonly latest: number
	readonly weakVoiceFresh: boolean
} {
	const out = new Map<ScannerProtocol, DigitalEvidence>()
	const proofs = prior.digitalProofs?.()
	let latest = Number.NEGATIVE_INFINITY
	let weakVoiceFresh = false
	const note = (s: DigitalSighting): void => {
		if (!digitalProtocol(s.protocol) || !dated(s.at)) return
		latest = Math.max(latest, s.at)
		const fresh = inTtl(s.at, now)
		const verified = s.verified && s.protocol !== "digital-unknown"
		if (fresh && !verified && s.protocol !== "digital-unknown")
			weakVoiceFresh = true
		if (!s.checked && !fresh) return
		let e = out.get(s.protocol)
		if (e === undefined) {
			e = {
				checked: false,
				verified: false,
				verifiedFresh: false,
				unchecked: new Set(),
			}
			out.set(s.protocol, e)
		}
		if (verified) {
			e.verified = true
			if (fresh) e.verifiedFresh = true
		}
		if (s.checked) e.checked = true
		else if (s.observationId !== null) e.unchecked.add(s.observationId)
		else if (proofs === undefined) e.unchecked.add("label")
	}
	for (const l of prior.labels)
		if (l.owner)
			note({
				protocol: l.protocol,
				at: l.at,
				checked:
					l.protocol === "digital-unknown" ||
					l.confidence === "decoded" ||
					l.checkedHint === true,
				verified: l.confidence === "decoded" || l.verifiedHint === true,
				observationId: l.observationId ?? null,
			})
	for (const p of proofs ?? [])
		note({
			protocol: p.protocol,
			at: p.at,
			checked: p.checked,
			verified: p.verified === true,
			observationId: p.observationId,
		})
	return { byProtocol: out, latest, weakVoiceFresh }
}

/** The owner's latest digital evidence (VoicePrior.digitalSeenAt, else `fallback`) is within the TTL. */
function freshDigital(
	prior: VoicePrior,
	fallback: number,
	now: number,
): boolean {
	const seen = prior.digitalSeenAt?.()
	const at =
		seen === undefined || seen === null ? fallback : Math.max(seen, fallback)
	return Number.isFinite(at) && inTtl(at, now)
}

/** At least DIGITAL_CHANNEL_MIN_SHARE of `v.total` votes (one or more) read one of `classes`. */
function shareOf(v: ClassVotes, classes: ReadonlySet<ScannerClass>): boolean {
	let matched = 0
	for (const c of classes) matched += v.votes[c] ?? 0
	return matched > 0 && matched >= DIGITAL_CHANNEL_MIN_SHARE * v.total
}

const TDMA_CLASSES: ReadonlySet<ScannerClass> = new Set(["tdma-ms"])

/**
 * A digital channel (PriorStrength's strong): DIGITAL_CHANNEL_MIN_VOTES or more owner class votes,
 * the owner's latest digital evidence within the TTL (freshDigital: VoicePrior.digitalSeenAt, or
 * the newest sighting when the store gives none), and for one digital protocol sighted on the
 * owner's kept observations (digitalEvidence):
 * - a checked sighting (a decode, a checked sync hint, `digital-unknown`) and
 *   DIGITAL_CHANNEL_MIN_SHARE of the votes in its classes (digitalChannelClasses); or
 * - DMR with only unchecked sync hints (dsd-fme sync with no verified TG/SRC) and either
 *   (a) that share in `tdma-ms` alone (TDMA burst structure is DMR's; NFM never reads it), or
 *   (b) that share in DMR's classes and hints from DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS
 *   distinct observations within the TTL. An unchecked hint of another protocol (dPMR keeps no checked
 *   content) is never one.
 * Returns how it is one (StrongSource; the strongest when several hold): `checked-digital` (a
 * checked sighting of a digital voice protocol, with a verified sighting of it, a decode or a hint
 * with verified TG/SRC, within the TTL, or of any age while a `tdma-ms` vote is:
 * VoicePrior.tdmaSeenAt), `unchecked-dmr` (rule a or b, or a checked sighting without that while a
 * digital voice sighting that is not verified is within the TTL), `digital-unknown` (a checked
 * `digital-unknown` sighting, or a checked sighting kept fresh by other evidence only); null: not
 * one. A throwing or absent read: not one.
 */
function digitalChannel(
	prior: VoicePrior,
	now: number,
): "checked-digital" | "unchecked-dmr" | "digital-unknown" | null {
	if (!prior.labels.some(l => l.owner && digitalProtocol(l.protocol)))
		return null
	try {
		const { byProtocol, latest, weakVoiceFresh } = digitalEvidence(prior, now)
		if (byProtocol.size === 0) return null
		const v = prior.classVotes?.()
		if (v === undefined || v.total < DIGITAL_CHANNEL_MIN_VOTES) return null
		if (!freshDigital(prior, latest, now)) return null
		const tdmaFresh = inTtl(prior.tdmaSeenAt?.() ?? null, now)
		let weaker: "unchecked-dmr" | "digital-unknown" | null = null
		for (const [protocol, e] of byProtocol) {
			const classes = digitalChannelClasses(protocol)
			if (e.checked && shareOf(v, classes)) {
				if (
					protocol !== "digital-unknown" &&
					(e.verifiedFresh || (e.verified && tdmaFresh))
				)
					return "checked-digital"
				if (protocol !== "digital-unknown" && weakVoiceFresh)
					weaker = "unchecked-dmr"
				else weaker ??= "digital-unknown"
			}
			if (protocol !== "dmr" || e.unchecked.size === 0) continue
			if (
				shareOf(v, TDMA_CLASSES) ||
				(e.unchecked.size >= DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS &&
					shareOf(v, classes))
			)
				weaker = "unchecked-dmr"
		}
		return weaker
	} catch {
		return null
	}
}

/** Owner observations that must vote `tdma-ms` for a TDMA channel with no digital label (tdmaChannel). */
export const TDMA_CHANNEL_MIN_VOTES = 4
/** The share of the owner's class votes that must read `tdma-ms` (tdmaChannel): a majority. */
export const TDMA_CHANNEL_MIN_SHARE = 1 / 2

/**
 * A TDMA channel (PriorStrength's strong) known by its spectrum alone: the owner's stored class is
 * `tdma-ms`, at least TDMA_CHANNEL_MIN_VOTES of its observations voted it and they are at least
 * TDMA_CHANNEL_MIN_SHARE of its votes, and its latest digital evidence (VoicePrior.digitalSeenAt)
 * is within the TTL. A throwing or absent read: not one.
 */
function tdmaChannel(prior: VoicePrior, now: number): boolean {
	if (prior.class !== "tdma-ms") return false
	try {
		const v = prior.classVotes?.()
		const tdma = v?.votes["tdma-ms"] ?? 0
		return (
			v !== undefined &&
			tdma >= TDMA_CHANNEL_MIN_VOTES &&
			tdma >= TDMA_CHANNEL_MIN_SHARE * v.total &&
			prior.digitalSeenAt !== undefined &&
			freshDigital(prior, Number.NEGATIVE_INFINITY, now)
		)
	} catch {
		return false
	}
}

function weakDigital(prior: VoicePrior, now: number): boolean {
	if (digitalClass(prior.class)) return true
	return prior.labels.some(
		l =>
			l.protocol === "digital-unknown" ||
			(notAnalogVoiceProtocol(l.protocol) && !strongLabel(l, now)),
	)
}

/**
 * Where a `tone-required` prior's strength comes from (PriorStrength), strongest first:
 * `dedicated`, a dedicated-channel decode (strongLabel); `tdma`, a TDMA channel (tdmaChannel);
 * `checked-digital`, a digital channel with a verified digital voice sighting fresh, or kept fresh
 * by `tdma-ms` votes (digitalChannel);
 * `unchecked-dmr`, one with unchecked DMR sync hints only (digitalChannel's rule a or b);
 * `digital-unknown`, one with a `digital-unknown` candidate only. The content check
 * (contentChecked) trusts only the first three: identify makes `digital-unknown` whenever every
 * digital trial ends without sync and nothing was heard, and dsd-fme syncs on noise, so a weak NFM
 * voice reading fsk4-12k5 can reach the last two.
 */
export type StrongSource =
	| "dedicated"
	| "tdma"
	| "checked-digital"
	| "unchecked-dmr"
	| "digital-unknown"

/**
 * The prior's strength at `now` (wall ms; PriorStrength) and, when `tone-required`, its source
 * (StrongSource; null otherwise); a throwing analogVoice reads as voice heard (keeps).
 */
export function priorReading(
	prior: VoicePrior | null,
	backedClass: boolean,
	now: number,
): { readonly strength: PriorStrength; readonly source: StrongSource | null } {
	let source: StrongSource | null = null
	if (prior !== null) {
		if (prior.labels.some(l => strongLabel(l, now)) || ownerDecoded(prior, now))
			source = "dedicated"
		else if (tdmaChannel(prior, now)) source = "tdma"
		else source = digitalChannel(prior, now)
	}
	if (
		source === null &&
		!backedClass &&
		(prior === null || !weakDigital(prior, now))
	)
		return { strength: "none", source: null }
	if (prior !== null && analogVoiceHeard(prior))
		return { strength: "none", source: null }
	return source !== null
		? { strength: "tone-required", source }
		: { strength: "suspect", source: null }
}

/** The prior's strength at `now` (priorReading). */
export function readPrior(
	prior: VoicePrior | null,
	backedClass: boolean,
	now: number,
): PriorStrength {
	return priorReading(prior, backedClass, now).strength
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
	now: number,
): "tone-required" | null {
	return readPrior(prior, backedClass, now) === "tone-required"
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
 * Provisional files held at once on a source recording at most `cap` at once
 * (widebandRecordingLimit, 2 to 6: the store's MAX_ACTIVE_ANALOG_PER_SOURCE = 6): a held file keeps
 * its slot, so cap − 1 are held (1 at the floor of 2, 5 at the ceiling) and one slot stays free
 * for a new recording. A limit that shrinks under the running sessions (calm 6, then CPU pressure:
 * 2) can leave more held than cap − 1 for a while: they keep their grace (a candidate over the
 * limit releases none, as releasing them all would still start nothing) and end as usual. The
 * limit is never under 2, so a cap of 1 or less (0 held: every file is
 * finished at once) only guards a malformed input. A file to hold past it finishes the oldest
 * held one now (kept), and so does any candidate that finds every slot taken and is not known non-voice.
 */
export function provisionalRoom(cap: number): number {
	return Number.isFinite(cap) ? Math.max(0, Math.floor(cap) - 1) : 0
}

/**
 * A joined observation with voice evidence (`joinedVoice`: id → the newest sample its track was
 * reported on; `joins`: id → its track's start sample) was on the air in the file's
 * [startSample, endSample] (+∞ while open): that file is not the session owner's alone.
 */
export function joinedVoiceOverlaps(
	s: {
		readonly joins: ReadonlyMap<string, number>
		readonly joinedVoice: ReadonlyMap<string, number>
	},
	file: { readonly startSample: number; readonly endSample: number | null },
): boolean {
	return joinedVoiceOf(s, file).joinedVoice
}

/**
 * finishVerdict's joined-voice inputs of a file: `joinedVoice` (joinedVoiceOverlaps) and the ids
 * of those joined observations (`joinedVoiceIds`, at most WIDEBAND_JOINS_KEPT).
 */
export function joinedVoiceOf(
	s: {
		readonly joins: ReadonlyMap<string, number>
		readonly joinedVoice: ReadonlyMap<string, number>
	},
	file: { readonly startSample: number; readonly endSample: number | null },
): { readonly joinedVoice: boolean; readonly joinedVoiceIds: string[] } {
	const until = file.endSample ?? Number.POSITIVE_INFINITY
	const ids: string[] = []
	for (const [id, last] of s.joinedVoice)
		if ((s.joins.get(id) ?? last) <= until && last >= file.startSample)
			ids.push(id)
	return { joinedVoice: ids.length > 0, joinedVoiceIds: ids }
}

/**
 * The joined voice of a file is another transmission's: some joined observation in
 * `joinedVoiceIds` is not the channel's own (VoicePrior.channelObservation: the owner's or a
 * linked co-channel discovery's). `joinedVoiceIds` absent: `joinedVoice` as given. A joined
 * observation of the channel itself carries only its spectral analog-fm class, which a no-voice
 * channel's trials or a content check already outweigh. A throwing read: another's (keeps).
 */
export function joinedOtherVoice(
	prior: VoicePrior | null,
	joinedVoice: boolean,
	joinedVoiceIds: readonly string[] | undefined,
): boolean {
	if (!joinedVoice || joinedVoiceIds === undefined) return joinedVoice
	const own = prior?.channelObservation
	if (own === undefined) return joinedVoiceIds.length > 0
	try {
		return joinedVoiceIds.some(id => !own(id))
	} catch {
		return true
	}
}

/**
 * joinedOtherVoice counting only joined observations the store indexes
 * (VoicePrior.knownObservation): one it does not know names no other discovery, so it is not
 * another transmission's voice. Read only for a no-voice channel's speech check (finishPath):
 * elsewhere an unknown id still keeps (joinedOtherVoice). `knownObservation` absent:
 * joinedOtherVoice. A throwing read: another's (keeps).
 */
export function joinedOtherKnownVoice(
	prior: VoicePrior | null,
	joinedVoice: boolean,
	joinedVoiceIds: readonly string[] | undefined,
): boolean {
	const other = joinedOtherVoice(prior, joinedVoice, joinedVoiceIds)
	const known = prior?.knownObservation
	if (!other || joinedVoiceIds === undefined || known === undefined)
		return other
	const own = prior?.channelObservation
	try {
		return joinedVoiceIds.some(id => known(id) && !(own?.(id) ?? false))
	} catch {
		return true
	}
}

/**
 * Caps a session's joined voice (`joined`: observation id → its newest sample, oldest first) at
 * `cap` entries (WIDEBAND_JOINS_KEPT): past it the oldest joined observation of the channel itself
 * (VoicePrior.channelObservation of `prior()`, read once per eviction) goes first, the oldest
 * entry only when none is the channel's: another transmission's voice keeps a file
 * (joinedOtherVoice), a busy channel's own bursts only repeat its spectral class, so a voice heard
 * early in a burst-heavy session is never pushed out by them. O(cap) per eviction. A throwing
 * read: the oldest.
 */
export function capJoinedVoice(
	joined: Map<string, number>,
	cap: number,
	prior: () => VoicePrior | null,
): void {
	while (joined.size > cap) {
		let victim: string | undefined
		try {
			const own = prior()?.channelObservation
			if (own !== undefined) victim = [...joined.keys()].find(id => own(id))
		} catch {
			victim = undefined
		}
		victim ??= joined.keys().next().value
		if (victim === undefined) return
		joined.delete(victim)
	}
}

/**
 * Voice evidence of joined `observationId` in a recorder session `s` (Session.joinedVoice; never
 * its owner `s.owner`): a snapshot classed it analog-fm, or the session's own audio classed it
 * (classByTone) while it was on the air; `last`, the newest sample its track was reported on.
 * The map stays at most `cap` entries (capJoinedVoice, which reads `prior` only to evict).
 */
export function noteJoinedVoice(
	s: { readonly owner: string; readonly joinedVoice: Map<string, number> },
	observationId: string,
	last: number,
	cap: number,
	prior: () => VoicePrior | null,
): void {
	if (observationId === s.owner) return
	const before = s.joinedVoice.get(observationId) ?? Number.NEGATIVE_INFINITY
	s.joinedVoice.delete(observationId)
	s.joinedVoice.set(observationId, Math.max(before, last))
	capJoinedVoice(s.joinedVoice, cap, prior)
}

/**
 * What finishing a written file does: finish it (kept), hold it provisional, or discard it:
 * `discarded:known-non-voice`, a shadow of a channel with a strong prior its own audio never
 * classed; `discarded:late-non-voice`, a decode of its own signal found at its finish or when
 * its hold ends; `discarded:not-speech`, audio that clearly measures as no speech
 * (speech-content.ts) on a channel whose digital prior is backed (contentChecked);
 * `discarded:noise`, audio the recording admission rule measures as open-squelch noise or data
 * buzz (speech-content.ts admissionNoise, `FinishInput.admission`).
 */
export type FinishVerdict =
	| "finish"
	| "hold"
	| "discarded:known-non-voice"
	| "discarded:late-non-voice"
	| "discarded:not-speech"
	| "discarded:noise"

/**
 * Why finishVerdict decided what it did (finishPath; the recorder logs it for every file it
 * keeps, so an audit can tell each file's path): `no-voice` (discarded by noVoiceChannel),
 * `own-tone`, `late-non-voice`, `joined-decode` (a decode of its own signal, another
 * transmission's joined voice on the air), `known-non-voice`, `prior-none` (kept at once), `content` (discarded by the content
 * check), `noise` (discarded by the recording admission rule), `noise-evidence` (a noise file of a
 * channel with proven analog voice kept by its discovery's evidence budget, noise-evidence.ts),
 * `held`, `final` (kept at the end of its grace or with no room to hold).
 */
export type FinishReason =
	| "no-voice"
	| "own-tone"
	| "late-non-voice"
	| "joined-decode"
	| "known-non-voice"
	| "prior-none"
	| "content"
	| "noise"
	| "noise-evidence"
	| "held"
	| "final"

/**
 * finishVerdict's decision with what it read: the prior's strength and source (priorReading),
 * whether the channel is a no-voice one (noVoiceReading, read for every file; null: its trials
 * could not be read), whether a joined voice of another
 * transmission shares the file (joinedOtherVoice) and the file's own speech reading
 * (`speechHeard`; null: not measured). Only enumerated values and booleans: safe to log.
 */
export interface FinishPath {
	readonly verdict: FinishVerdict
	readonly reason: FinishReason
	readonly strength: PriorStrength
	readonly source: StrongSource | null
	readonly noVoice: boolean | null
	readonly joinedOther: boolean
	readonly speechHeard: boolean | null
	/**
	 * The file counts in its discovery's noise-read rate (noise-evidence.ts DiscoveryNoiseRate,
	 * noted once per file by the recorder): the proven-channel noise rule judged it (finishPath
	 * reached it: a channel with proven analog voice, admission noise, no joined voice of another
	 * transmission, no decoded tone, noiseRuleJudges), kept or discarded, gated or not, and it
	 * does not read voice-like (noiseRateCounts: no quieted share at or over 0.10, no quieted
	 * run). False for every other path.
	 */
	readonly noiseCounted: boolean
}

/** finishVerdict's input (see there). */
export interface FinishInput {
	readonly prior: VoicePrior | null
	readonly backedClass: boolean
	readonly ownTone: boolean
	readonly snapshotClassed: boolean
	readonly decodedOwn: boolean
	readonly joinedVoice: boolean
	readonly joinedVoiceIds?: readonly string[]
	readonly notSpeech: boolean
	readonly clearNoise?: boolean
	readonly speechHeard?: boolean | null
	readonly rollOver?: boolean
	readonly ownObservationId?: string | null
	/**
	 * The recording admission rule (scanner.admission): `enabled` its setting, `noise` the file's
	 * speech-content.ts admissionNoise (null: not measured, or a file classed by its own tone: kept).
	 * Its own field, not a speech reading: it applies to a classed session's roll-over file too.
	 * `periodicShare`: the file's SpeechContent.periodicShare, read only on a channel with proven
	 * analog voice (absent or null there: the file is kept as before). `partialNoise`: admissionNoise
	 * under ADMISSION_PROVEN_VOICE (its 47-frame partial-window floor), read in place of `noise`
	 * only on a channel with proven analog voice (absent: `noise` is read there too). Absent: not
	 * applied.
	 */
	readonly admission?: {
		readonly enabled: boolean
		readonly noise: boolean | null
		readonly periodicShare?: number | null
		readonly partialNoise?: boolean | null
		/**
		 * The file's carrier quieting (quieting.ts QuietingReading), read only on a channel with
		 * proven analog voice: `quietedPeriodicShare` (null: no quieted frame) is read beside
		 * `periodicShare` there (noiseRuleJudges). `quietedRun` (300 ms quieted) no longer keeps a
		 * file on its own: on a gated discovery it spends the evidence budget like noise (finishPath).
		 * Absent or null: the whole-file `periodicShare` decides.
		 */
		readonly quieting?: {
			readonly quietedPeriodicShare: number | null
			readonly quietedRun: boolean
		} | null
	}
	/**
	 * A CTCSS or DCS tone was decoded over the file (recording-facts.ts toneFactOf: a tone object):
	 * it is never discarded as noise. Absent: none.
	 */
	readonly decodedTone?: boolean
	/**
	 * The file's discovery has room in its noise evidence budget (noise-evidence.ts
	 * NoiseEvidenceBudget.room): a noise file of a channel with proven analog voice is kept as
	 * `noise-evidence` instead of discarded. Absent: no room.
	 */
	readonly noiseEvidence?: boolean
	/**
	 * Noise-read files of the file's discovery in the rolling hour before it (noise-evidence.ts
	 * DiscoveryNoiseRate.before): the proven-channel noise discard applies only at or over
	 * DISCOVERY_NOISE_GATE. Absent: 0 (never gated).
	 */
	readonly discoveryNoiseReads?: number
	/**
	 * The discovery's gate is latched closed (noise-evidence.ts DiscoveryNoiseRate.latched: it
	 * reached DISCOVERY_NOISE_GATE under DISCOVERY_NOISE_LATCH_MS, 24 h, ago): the discard applies
	 * whatever `discoveryNoiseReads`. Absent: false.
	 */
	readonly discoveryNoiseLatched?: boolean
	readonly final: boolean
	readonly now: number
}

/**
 * A written file's fate at its finish (`final` false) or at the end of its grace (`final` true),
 * in this order: a file whose own audio carried a CTCSS tone, or whose session its tone classed
 * (`ownTone`: a roll-over file of a toned over), is always kept; one whose
 * own signal a decode proves not analog voice (`decodedOwn`, fileDecodedOwn) is discarded
 * (`discarded:late-non-voice`) unless a joined voice of another transmission was on the air in
 * it (joinedOtherVoice: kept at once, the two cannot be separated; a joined observation of the
 * channel itself carries only its spectral class and does not keep it); under a `tone-required` prior
 * a file no snapshot classed analog-fm (`snapshotClassed` false: classed by its own audio only,
 * or a file of a transmission that joined while the prior was strong) is discarded
 * (`discarded:known-non-voice`); whatever the prior's strength, a file of a no-voice channel
 * (noVoiceChannel: its analog trials ran NO_VOICE_CHANNEL_MIN_TRIALS times and never heard, no
 * analog proof) whose audio shows no speech (`speechHeard` false: speech-content.ts speechHeard,
 * any length) and that no joined voice of another transmission shares (joinedOtherVoice: a joined
 * observation of the channel itself, `joinedVoiceIds` read through VoicePrior.channelObservation,
 * carries only its own spectral analog-fm class) is discarded (`discarded:not-speech`;
 * `speechHeard` absent or null: not measured, a file classed by its own tone, kept; a joined
 * observation the store does not index, joinedOtherKnownVoice, does not exempt it either);
 * then, whatever the prior's strength (so a weak prior never holds noise), a file the recording
 * admission rule measures as noise (`admission`: enabled, `noise` true; roll-over files included)
 * that no joined voice of another transmission shares (joinedOtherVoice) is discarded
 * (`discarded:noise`), never a file with a decoded CTCSS or DCS tone (`decodedTone`); on a
 * channel with proven analog voice (analogVoiceHeard) only when its discovery made
 * DISCOVERY_NOISE_GATE (15) or more noise-read files in the hour before it
 * (`discoveryNoiseReads`; under it the file is kept as before the rule), or its gate is latched
 * closed (`discoveryNoiseLatched`: it reached the gate under 24 h ago), and its periodic share is
 * under SPEECH_NOISE_MAX_PERIODIC_SHARE (0.10: measured, the spur-like emitter's noise files at
 * most 0.099, real voice at least 0.14) over its quieted frames (`quietedPeriodicShare`, 16 or
 * more quieted) or over the whole file (noiseRuleJudges: a file kept by one share only, or by a
 * quieted run, is judged too on a gated discovery; no share given keeps it as `prior-none`), and
 * then kept as `noise-evidence` while its discovery's
 * evidence budget has room (`noiseEvidence`, at most NOISE_EVIDENCE_PER_HOUR per rolling hour);
 * there only, a file of 47 to 93 level frames is judged too (`partialNoise`, ADMISSION_PROVEN_VOICE),
 * elsewhere it stays unmeasured (kept);
 * a classed session's roll-over file (`rollOver`: it continues a voiced over) gets that speech
 * check only, and only on a no-voice channel (elsewhere its readings are ignored: kept as its
 * session); where the content check applies (contentChecked: a
 * `tone-required` prior from a dedicated-channel decode, a TDMA channel or a verified digital
 * sighting (`checked-digital`), or backed digital evidence of the owner; or ownDmrHint) a file
 * whose audio clearly measures as no speech (`notSpeech`, speech-content.ts clearlyNotSpeech: a
 * steady buzz) and that no joined voice of another transmission shares (joinedOtherVoice) is
 * discarded (`discarded:not-speech`) at once; under any other digital
 * prior (`suspect`, or a `tone-required` one from a `digital-unknown` candidate or unchecked DMR
 * hints) only a file that also measures as clear noise (`clearNoise`, absent false: clearlyNoise,
 * the strict bounds, never borderline audio) is; otherwise one a snapshot classed under `tone-required`, or any under `suspect`, is held, then
 * kept; with none it is kept at once (no content check: an analog proof or label on the channel
 * reads `none`). A prior alone (a decode of another transmission, a co-channel discovery's) never
 * discards a file a snapshot classed and whose audio may be speech. `now`: wall ms (readPrior).
 */
export function finishVerdict(input: FinishInput): FinishVerdict {
	return finishPath(input).verdict
}

/** finishVerdict with the readings behind it (FinishPath). */
export function finishPath(input: FinishInput): FinishPath {
	const { strength, source } = priorReading(
		input.prior,
		input.backedClass,
		input.now,
	)
	// Read for every file, so its kept line says what the channel is (once per finish or release).
	const noVoice = noVoiceReading(input.prior)
	const joinedOther = joinedOtherVoice(
		input.prior,
		input.joinedVoice,
		input.joinedVoiceIds,
	)
	// A classed session's roll-over: only a no-voice channel's speech check reads its audio.
	const rolled = input.rollOver === true
	const speechHeard =
		rolled && noVoice !== true ? null : (input.speechHeard ?? null)
	const notSpeech = !rolled && input.notSpeech
	// Set where the proven-channel noise rule judges the file (noiseCounted); every later path keeps it.
	let noiseCounted = false
	const path = (verdict: FinishVerdict, reason: FinishReason): FinishPath => ({
		verdict,
		reason,
		strength,
		source,
		noVoice,
		joinedOther,
		speechHeard,
		noiseCounted,
	})
	if (input.ownTone) return path("finish", "own-tone")
	if (input.decodedOwn)
		return joinedOther
			? path("finish", "joined-decode")
			: path("discarded:late-non-voice", "late-non-voice")
	if (strength === "tone-required" && !input.snapshotClassed)
		return path("discarded:known-non-voice", "known-non-voice")
	if (
		noVoice === true &&
		speechHeard === false &&
		!joinedOtherKnownVoice(input.prior, input.joinedVoice, input.joinedVoiceIds)
	)
		return path("discarded:not-speech", "no-voice")
	const admission = input.admission
	const partial =
		admission?.partialNoise === undefined
			? (admission?.noise ?? null)
			: admission.partialNoise
	if (
		admission?.enabled === true &&
		(admission.noise === true || partial === true) &&
		!joinedOther &&
		// A decoded CTCSS or DCS tone is a radio keyed on the channel: never noise.
		input.decodedTone !== true
	) {
		// analogVoiceHeard walks cached proofs: asked only for a file read as noise.
		const proven = input.prior !== null && analogVoiceHeard(input.prior)
		if (!proven) {
			// The whole-window floor (94 frames) only: a shorter file is never measured here.
			if (admission.noise === true) return path("discarded:noise", "noise")
		} else if (noiseRuleJudges(admission, false)) {
			// Counted kept or discarded, but a voice-like file (noiseRateCounts) never moves the gate.
			noiseCounted = noiseRateCounts(admission)
			// A channel with proven analog voice: static and a weak over read the same (equal
			// speech readings, the same pitch), so the rule applies only to a discovery that makes
			// noise at an emitter's rate (DISCOVERY_NOISE_GATE, 15 an hour: the busiest voice
			// discovery of the corpus at most 9, the emitter at least 20), or that reached it under
			// 24 h ago (the latch: the warm-up once per process start); otherwise every file is kept
			// as before the rule. There, a file kept only by its quieted share or its quieted run
			// (the emitter read them on a few files: a run on 5 and a share of 0.10 or more on 1 of
			// its 517) spends the evidence budget like any other noise file (unpitched noise goes, a
			// few kept as evidence). Files of 47 to 93 frames are judged on their partial window.
			if (
				(input.discoveryNoiseReads ?? 0) >= DISCOVERY_NOISE_GATE ||
				input.discoveryNoiseLatched === true
			)
				return input.noiseEvidence === true
					? path("finish", "noise-evidence")
					: path("discarded:noise", "noise")
		}
	}
	if (strength === "none") return path("finish", "prior-none")
	if (
		notSpeech &&
		!joinedOther &&
		(input.clearNoise === true ||
			contentChecked(source, input.prior, input.backedClass, input.now) ||
			ownDmrHint(input.prior, input.ownObservationId ?? null, input.now))
	)
		return path("discarded:not-speech", "content")
	return input.final ? path("finish", "final") : path("hold", "held")
}

/**
 * Whether the proven-channel noise rule judges a file (finishPath), whatever its discovery's
 * rate: the admission is enabled and reads noise (its partial-window `partialNoise` when given,
 * else `noise`), no CTCSS or DCS tone was decoded over it (`decodedTone`), and its periodic share
 * is under SPEECH_NOISE_MAX_PERIODIC_SHARE over its quieted frames or over the whole file. Where
 * finishPath reaches the rule (a proven-voice channel, no joined voice of another transmission),
 * such a file counts in its discovery's noise-read rate (noise-evidence.ts DiscoveryNoiseRate),
 * kept or discarded, unless it reads voice-like (noiseRateCounts; FinishPath.noiseCounted).
 */
export function noiseRuleJudges(
	admission: FinishInput["admission"],
	decodedTone: boolean,
): boolean {
	if (admission?.enabled !== true || decodedTone) return false
	const partial =
		admission.partialNoise === undefined
			? admission.noise
			: admission.partialNoise
	if (partial !== true) return false
	const under = (share: number | null | undefined): boolean =>
		share !== null &&
		share !== undefined &&
		share < SPEECH_NOISE_MAX_PERIODIC_SHARE
	return (
		under(admission.quieting?.quietedPeriodicShare) ||
		under(admission.periodicShare)
	)
}

/**
 * Whether a file the proven-channel noise rule judges (noiseRuleJudges) counts in its discovery's
 * noise-read rate (noise-evidence.ts DiscoveryNoiseRate; FinishPath.noiseCounted): not when it
 * reads voice-like, a quieted periodic share at or over SPEECH_NOISE_MAX_PERIODIC_SHARE (0.10) or
 * a quieted run (300 ms quieted, quieting.ts). Such a file is still judged on a gated discovery
 * (by its whole-file share, spending the evidence budget), but a busy voice channel's weak overs
 * never push it to the gate (replay of 2026-11-25: the busiest voice discovery's counted reads
 * 104 → 51 over the day).
 */
export function noiseRateCounts(admission: FinishInput["admission"]): boolean {
	const q = admission?.quieting
	if (q === null || q === undefined) return true
	if (q.quietedRun) return false
	const share = q.quietedPeriodicShare
	return share === null || share < SPEECH_NOISE_MAX_PERIODIC_SHARE
}

/**
 * The noise-rate fields of a file's kept or noise-discard log line: its discovery's noise-read
 * count before it (`discoveryNoiseReads`, DiscoveryNoiseRate.before; null: not read) and whether
 * its gate was latched closed then (`latched`). Numbers and booleans only.
 */
export function noiseRateLog(file: {
	readonly noiseReadsBefore: number | null
	readonly noiseLatchedBefore: boolean
}): { discoveryNoiseReads: number | null; latched: boolean } {
	return {
		discoveryNoiseReads: file.noiseReadsBefore,
		latched: file.noiseLatchedBefore,
	}
}

/**
 * The log fields of a kept file (the recorder logs one line per file it keeps): its operation id
 * (the WAV's name), its session's discovery (the folder's owner; null: none yet) and the centre it
 * demodulates (`frequencyHz`, whole Hz), finishPath's readings and the file's speech measure
 * (speech-content.ts). Ids the core made and numbers it measured only; nothing a decoder read.
 */
export function keptLog(
	path: FinishPath,
	file: {
		readonly speech: { result(): SpeechContent }
		readonly handle: { readonly operationId: string } | null
	},
	session: { readonly discoveryId: string | null; readonly targetHz: number },
): Record<string, string | number | boolean | null> {
	const c = file.speech.result()
	return {
		operationId: file.handle?.operationId ?? null,
		discoveryId: session.discoveryId,
		frequencyHz: Math.round(session.targetHz),
		reason: path.reason,
		strength: path.strength,
		source: path.source,
		noVoice: path.noVoice,
		joinedOther: path.joinedOther,
		speechHeard: path.speechHeard,
		frames: c.frames,
		rangeDb: Math.round(c.maxRangeDb * 100) / 100,
		periodicShare: Math.round(c.periodicShare * 1000) / 1000,
		burstFrames: c.maxBurstFrames,
	}
}

/**
 * The log fields of a file discarded as noise (`discarded:noise`; the recorder logs one line per
 * such file): its operation id, its session's discovery and centre (whole Hz), finishPath's prior
 * reading, the admission branch that fired (speech-content.ts admissionBranch: `noise` or
 * `data-buzz`) and the admission rule's measured numbers (SpeechContent, rounded). Ids the core
 * made and numbers it measured only.
 */
export function noiseLog(
	path: FinishPath,
	c: SpeechContent,
	file: { readonly handle: { readonly operationId: string } | null },
	session: { readonly discoveryId: string | null; readonly targetHz: number },
): Record<string, string | number | boolean | null> {
	return {
		operationId: file.handle?.operationId ?? null,
		discoveryId: session.discoveryId,
		frequencyHz: Math.round(session.targetHz),
		reason: path.reason,
		strength: path.strength,
		branch: admissionBranch(c, branchBounds(path)),
		...admissionNumbers(c),
	}
}

/**
 * The bounds a file's admission branch is read with: ADMISSION_PROVEN_VOICE for a file the noise
 * rule took (`noise`, `noise-evidence`: only a channel with proven analog voice judges a file
 * under 94 frames, and a longer one reads the same under both), ADMISSION_DEFAULTS otherwise.
 */
function branchBounds(path: FinishPath): AdmissionThresholds {
	return path.reason === "noise" || path.reason === "noise-evidence"
		? ADMISSION_PROVEN_VOICE
		: ADMISSION_DEFAULTS
}

/** The admission rule's measured numbers of a noise file, rounded (noiseLog, noiseFacts). */
function admissionNumbers(c: SpeechContent): {
	levelFrames: number
	spreadDb: number
	p10Dbfs: number
	periodicShare: number
	burstFrames: number
	loudPitchShare: number
	topSpreadDb: number
	loudLevelDbfs: number | null
} {
	return {
		levelFrames: c.levelFrames,
		spreadDb: Math.round(c.maxWindowSpreadDb * 100) / 100,
		p10Dbfs: Math.round(c.minWindowP10Dbfs * 100) / 100,
		periodicShare: Math.round(c.periodicShare * 1000) / 1000,
		burstFrames: c.maxBurstFrames,
		loudPitchShare: Math.round(c.maxLoudPitchShare * 1000) / 1000,
		topSpreadDb: Math.round(c.maxTopSpreadDb * 100) / 100,
		// −Infinity (no whole level window) is not JSON: null.
		loudLevelDbfs: Number.isFinite(c.maxLoudLevelDbfs)
			? Math.round(c.maxLoudLevelDbfs * 100) / 100
			: null,
	}
}

/**
 * The noise quarantine sidecar's facts of a file discarded as noise (noise-quarantine.ts): the
 * same measured numbers, closed codes and admission branch as noiseLog, without the ids (the
 * operation adds them).
 */
export function noiseFacts(
	path: FinishPath,
	c: SpeechContent,
	session: { readonly targetHz: number },
): NoiseQuarantineFacts {
	const branch = admissionBranch(c, branchBounds(path))
	return {
		frequencyHz: Number.isFinite(session.targetHz)
			? Math.round(session.targetHz)
			: null,
		reason: path.reason,
		strength: path.strength,
		...(branch === null ? {} : { branch }),
		...admissionNumbers(c),
	}
}

/**
 * Where finishVerdict's content check (`notSpeech`) applies under a digital prior, by where its
 * strength came from (`source`, priorReading's StrongSource): a `tone-required` prior from a
 * dedicated-channel decode, a TDMA channel or a digital channel with a verified digital voice
 * sighting (`dedicated`, `tdma`, `checked-digital`), or digital evidence of the owner more than its
 * spectrum backs: `backedClass` (DigitalClassLedger: a digital class the observation's own
 * verified decode or the channel tier's discriminator features back, never the spectrum alone), or
 * the owner's own digital voice decode or sync hint with verified TG/SRC (a published label or a
 * kept observation's proof; a talkgroup or an encryption flag alone does not count) dated within
 * STRONG_PRIOR_TTL_MS of `now`. Never for a digital channel
 * made only by a `digital-unknown` candidate or unchecked DMR sync hints (`digital-unknown`,
 * `unchecked-dmr`: still `tone-required` for admission, but their files are held, then kept), a
 * `suspect` prior read from a spectral class alone (a weak or low-deviation NFM voice reads
 * fsk4-*, gmsk-narrow), a decode of a shared-channel protocol (`ism`, LoRa) or a digital decode
 * of a co-channel discovery: untoned voice lives on those channels. A co-channel pager (or other
 * dedicated-channel) decode within 24 h is `dedicated`. A throwing read: not applied.
 */
export function contentChecked(
	source: StrongSource | null,
	prior: VoicePrior | null,
	backedClass: boolean,
	now: number,
): boolean {
	if (
		source === "dedicated" ||
		source === "tdma" ||
		source === "checked-digital" ||
		backedClass
	)
		return true
	if (prior === null) return false
	try {
		const backed = (protocol: ScannerProtocol, at: number | null): boolean =>
			familyOf(protocol) === "digital-voice" && inTtl(at, now)
		return (
			prior.labels.some(
				l =>
					l.owner &&
					(l.confidence === "decoded" || l.verifiedHint === true) &&
					backed(l.protocol, l.at),
			) ||
			(prior.digitalProofs?.() ?? []).some(
				p => p.verified === true && backed(p.protocol, p.at),
			)
		)
	} catch {
		return false
	}
}

/**
 * Other observations of the owner, of any age, that a DMR sync hint must also be on before the
 * hint on the session's first transmission opens the content check (ownDmrHint): 2. Only hints
 * with a colour code or checked content (or decodes) count.
 */
export const OWN_HINT_OTHER_OBSERVATIONS = 2

/**
 * Observations of the owner whose DMR sync hints read a colour code or carry checked content (or
 * DMR decodes), each dated within STRONG_PRIOR_TTL_MS (30 min) of now, before the content check
 * applies to a file whose own over carried no hint (ownDmrHint): 3. A DMR beacon or idle channel
 * syncs on only some of its overs, and its hints leave the prior `suspect`; one or two spurious
 * syncs on an analog channel do not reach it, a channel whose hints are older (a DMR user gone,
 * an analog voice back on the frequency) is not checked on them, and the check itself keeps speech.
 */
export const DMR_CHANNEL_HINT_OBSERVATIONS = 3

/**
 * The content check also applies to a file whose session's first transmission (`ownObservationId`,
 * the session's owner; a roll-over or joined file is judged on it too) carries a dsd-fme DMR sync
 * hint, checked or not
 * (VoicePrior.digitalProofs), while DMR hints that read a colour code or carry checked content
 * (verified TG/SRC, a talkgroup; or DMR decodes) are on at least OWN_HINT_OTHER_OBSERVATIONS other
 * kept observations of the owner (any age: a DMR channel heard once in hours syncs over after
 * over, and its syncs read its colour code; a spurious sync on a weak NFM voice reads none, so
 * bare syncs never count however recent) and DIGITAL_CHANNEL_MIN_SHARE of its DIGITAL_CHANNEL_MIN_VOTES or more class votes read
 * DMR's classes. One spurious sync on an analog channel does not open it, and the check itself
 * keeps speech (clearlyNotSpeech: synthetic voice spreads 10.2 dB or more, the bound is 8.5 dB):
 * what it discards is the steady buzz of the over its own decoder synced on. A session whose own
 * over carried no hint (dsd-fme syncs on only some overs of a DMR beacon) gets the check too once
 * such hints are on DMR_CHANNEL_HINT_OBSERVATIONS other observations of the owner, each dated
 * within STRONG_PRIOR_TTL_MS of `now` (wall ms; older hints do not count), with the same vote
 * share. A throwing read: no.
 */
export function ownDmrHint(
	prior: VoicePrior | null,
	ownObservationId: string | null,
	now: number,
): boolean {
	if (prior === null || ownObservationId === null) return false
	try {
		const dmr = (prior.digitalProofs?.() ?? []).filter(
			p => p.protocol === "dmr",
		)
		const own = dmr.some(p => p.observationId === ownObservationId)
		const others = new Set(
			dmr
				.filter(
					p =>
						(p.checked || p.colourCode === true) && (own || inTtl(p.at, now)),
				)
				.map(p => p.observationId)
				.filter(id => id !== ownObservationId),
		)
		if (
			others.size <
			(own ? OWN_HINT_OTHER_OBSERVATIONS : DMR_CHANNEL_HINT_OBSERVATIONS)
		)
			return false
		const v = prior.classVotes?.()
		return (
			v !== undefined &&
			v.total >= DIGITAL_CHANNEL_MIN_VOTES &&
			shareOf(v, digitalChannelClasses("dmr"))
		)
	} catch {
		return false
	}
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
