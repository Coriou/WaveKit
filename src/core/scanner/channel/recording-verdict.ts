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
 * it is asked only when a digital prior would otherwise apply.
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
 * (trial-memory.ts TrialMemory.analogFmTrials: how often they ran, how often they heard speech or
 * a tone; `decoded` adds those of its linked co-channel discoveries, `partnerIds`, that heard);
 * asked only for a file that measured no speech (noVoiceChannel).
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
}

/** VoicePrior.analogTrials: the owner's analog FM replay trials run, and those that heard. */
export interface AnalogTrials {
	readonly attempts: number
	readonly decoded: number
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
 * A no-voice channel (docs/SCANNER.md, "Channels whose trials never heard voice"): the owner's
 * analog FM replay trials ran NO_VOICE_CHANNEL_MIN_TRIALS times or more and never heard speech
 * or a tone (VoicePrior.analogTrials), and no analog voice was heard on the channel (an analog
 * tone or voice proof, or an analog label at `classified` or more: analogVoiceHeard). Its files
 * are kept only when their own audio shows speech (finishVerdict's `speechHeard`). A throwing
 * read: not one (keeps).
 */
export function noVoiceChannel(prior: VoicePrior | null): boolean {
	if (prior?.analogTrials === undefined) return false
	try {
		const t = prior.analogTrials()
		return (
			t !== null &&
			t.attempts >= NO_VOICE_CHANNEL_MIN_TRIALS &&
			t.decoded === 0 &&
			!analogVoiceHeard(prior)
		)
	} catch {
		return false
	}
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
 * (widebandRecordingCap, 1 or 2: the store's MAX_ACTIVE_ANALOG_PER_SOURCE = 2): a held file keeps
 * its slot, so cap − 1 are held and one slot stays free for a new recording; at cap 1 none is
 * (0: every file is finished at once). A file to hold past it finishes the oldest held one now
 * (kept), and so does any candidate that finds every slot taken and is not known non-voice.
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
	const until = file.endSample ?? Number.POSITIVE_INFINITY
	for (const [id, last] of s.joinedVoice)
		if ((s.joins.get(id) ?? last) <= until && last >= file.startSample)
			return true
	return false
}

/**
 * What finishing a written file does: finish it (kept), hold it provisional, or discard it:
 * `discarded:known-non-voice`, a shadow of a channel with a strong prior its own audio never
 * classed; `discarded:late-non-voice`, a decode of its own signal found at its finish or when
 * its hold ends; `discarded:not-speech`, audio that clearly measures as no speech
 * (speech-content.ts) on a channel whose digital prior is backed (contentChecked).
 */
export type FinishVerdict =
	| "finish"
	| "hold"
	| "discarded:known-non-voice"
	| "discarded:late-non-voice"
	| "discarded:not-speech"

/**
 * A written file's fate at its finish (`final` false) or at the end of its grace (`final` true),
 * in this order: a file whose own audio carried a CTCSS tone, or whose session its tone classed
 * (`ownTone`: a roll-over file of a toned over), is always kept; one whose
 * own signal a decode proves not analog voice (`decodedOwn`, fileDecodedOwn) is discarded
 * (`discarded:late-non-voice`) unless a joined voice was on the air in it (`joinedVoice`,
 * joinedVoiceOverlaps: kept at once, the two cannot be separated); under a `tone-required` prior
 * a file no snapshot classed analog-fm (`snapshotClassed` false: classed by its own audio only,
 * or a file of a transmission that joined while the prior was strong) is discarded
 * (`discarded:known-non-voice`); where the content check applies (contentChecked: a
 * `tone-required` prior from a dedicated-channel decode, a TDMA channel or a verified digital
 * sighting (`checked-digital`), or backed digital evidence of the owner) a file whose audio clearly
 * measures as no speech (`notSpeech`, speech-content.ts clearlyNotSpeech: a steady buzz) and that
 * no joined voice shares is discarded (`discarded:not-speech`) at once; under any other digital
 * prior (`suspect`, or a `tone-required` one from a `digital-unknown` candidate or unchecked DMR
 * hints) only a file that also measures as clear noise (`clearNoise`, absent false: clearlyNoise,
 * the strict bounds, never borderline audio) is; otherwise one a snapshot classed under `tone-required`, or any under `suspect`, is held, then
 * kept; with none it is kept at once (no content check: an analog proof or label on the channel
 * reads `none`). Before those, whatever the prior's strength, a file of a no-voice channel
 * (noVoiceChannel: its analog trials ran NO_VOICE_CHANNEL_MIN_TRIALS times and never heard, no
 * analog proof) whose audio shows no speech (`speechHeard` false: speech-content.ts speechHeard,
 * any length) and that no joined voice shares is discarded (`discarded:not-speech`); `speechHeard`
 * absent: not measured (a file classed by its own tone, a classed session's roll-over), kept.
 * A prior alone (a decode of another transmission, a co-channel discovery's) never
 * discards a file a snapshot classed and whose audio may be speech. `now`: wall ms (readPrior).
 */
export function finishVerdict(input: {
	readonly prior: VoicePrior | null
	readonly backedClass: boolean
	readonly ownTone: boolean
	readonly snapshotClassed: boolean
	readonly decodedOwn: boolean
	readonly joinedVoice: boolean
	readonly notSpeech: boolean
	readonly clearNoise?: boolean
	readonly speechHeard?: boolean
	readonly ownObservationId?: string | null
	readonly final: boolean
	readonly now: number
}): FinishVerdict {
	if (input.ownTone) return "finish"
	if (input.decodedOwn)
		return input.joinedVoice ? "finish" : "discarded:late-non-voice"
	const { strength, source } = priorReading(
		input.prior,
		input.backedClass,
		input.now,
	)
	if (strength === "tone-required" && !input.snapshotClassed)
		return "discarded:known-non-voice"
	if (
		input.speechHeard === false &&
		!input.joinedVoice &&
		noVoiceChannel(input.prior)
	)
		return "discarded:not-speech"
	if (strength === "none") return "finish"
	if (
		input.notSpeech &&
		!input.joinedVoice &&
		(input.clearNoise === true ||
			contentChecked(source, input.prior, input.backedClass, input.now) ||
			ownDmrHint(input.prior, input.ownObservationId ?? null))
	)
		return "discarded:not-speech"
	return input.final ? "finish" : "hold"
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
 * what it discards is the steady buzz of the over its own decoder synced on. A throwing read: no.
 */
export function ownDmrHint(
	prior: VoicePrior | null,
	ownObservationId: string | null,
): boolean {
	if (prior === null || ownObservationId === null) return false
	try {
		const dmr = (prior.digitalProofs?.() ?? []).filter(
			p => p.protocol === "dmr",
		)
		if (!dmr.some(p => p.observationId === ownObservationId)) return false
		const others = new Set(
			dmr
				.filter(p => p.checked || p.colourCode === true)
				.map(p => p.observationId)
				.filter(id => id !== ownObservationId),
		)
		if (others.size < OWN_HINT_OTHER_OBSERVATIONS) return false
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
