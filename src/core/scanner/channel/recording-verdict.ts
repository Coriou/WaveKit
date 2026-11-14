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
 * voice proof of an observation those discoveries still keep: each keeps its last
 * OBSERVATIONS_PER_DISCOVERY = 256, so a proof older than that many transmissions no longer
 * counts; or an analog label at `classified` or more); it walks up to 9 × 256 cached proofs, so it
 * is asked only when a digital prior would otherwise apply.
 * `classVotes` (absent: none) counts the owner's observations that voted a class (`total`) and
 * how many voted each class (`votes`; a class absent: none); asked only for an owner's digital
 * label. A label's `checkedHint` (absent: false) is true for a dsd-fme sync hint that carries
 * checked content (verified TG/SRC, a talkgroup or encryption: not discovery-store's
 * uncheckedSyncHint); read only for a digital voice label below `decoded`. A label's
 * `observationId` (absent or null: unknown) is the observation its proof cites.
 * `digitalProofs` (absent: none) lists the digital proof of each of the owner's kept observations
 * (at most OBSERVATIONS_PER_DISCOVERY = 256), any rank: the published label shows only the
 * highest-ranked, newest one, so the digital-channel bar reads its freshness, checkedness and
 * distinct observations from these (digitalEvidence); asked only for an owner's digital label.
 */
export interface VoicePrior {
	readonly id?: string
	readonly labels: readonly {
		readonly protocol: ScannerProtocol
		readonly confidence: ScannerConfidence
		readonly owner: boolean
		readonly at: number | null
		readonly checkedHint?: boolean
		readonly observationId?: string | null
	}[]
	readonly class: ScannerClass
	analogVoice(): boolean
	classVotes?(): ClassVotes
	digitalProofs?(): readonly DigitalProof[]
}

/**
 * VoicePrior.digitalProofs: the digital proof of one kept observation of the owner (a digital
 * voice decode, or a dsd-fme sync hint), whatever its rank: `at` its wall time (ms), `checked`
 * true for a decode or a hint with checked content.
 */
export interface DigitalProof {
	readonly protocol: ScannerProtocol
	readonly at: number
	readonly checked: boolean
	readonly observationId: string
}

/** VoicePrior.classVotes: the owner's observations with a class vote, and the count per class. */
export interface ClassVotes {
	readonly total: number
	readonly votes: Readonly<Partial<Record<ScannerClass, number>>>
}

/**
 * How strong a prior is (docs/SCANNER.md, "Known digital or paging channels"):
 * - `tone-required`: STRONG. A decode (confidence `decoded`) of a protocol made only on a
 *   channel of its own (DEDICATED_CHANNEL_FAMILIES: a pager, or APRS, AIS, ACARS, VDL2, ADS-B)
 *   on the owner or a co-channel discovery, made within STRONG_PRIOR_TTL_MS of now (an older or
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
 *   DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS distinct observations within the TTL. An analog
 *   proof or label ends it; so does 30 min without a fresh digital sighting (an active DMR or
 *   dPMR channel refreshes its proof every over). Any other unchecked sync hint, an undated
 *   label, or votes for another protocol's class are only `suspect`.
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
 * How long a dedicated-channel decode stays a strong prior after it was made: 30 × 60 000 =
 * 1 800 000 ms. A discovery shows its newest decode, so a pager channel that pages at least once
 * per 30 min stays strong; past it (a quiet channel, a misattributed or merged decode, a channel
 * now used for voice) the label is only `suspect`: its files are held and discarded only by a
 * decode of their own signal, so at most the first burst after each silence longer than this is
 * kept, and an untoned voice is never locked out for longer.
 */
export const STRONG_PRIOR_TTL_MS = 30 * 60_000

/**
 * Strong (PriorStrength): a decode of a dedicated-channel protocol, of the owner or a co-channel
 * discovery, made in [now − STRONG_PRIOR_TTL_MS, now + STRONG_PRIOR_TTL_MS] (a clock skew either
 * way; an undated one never is).
 */
function strongLabel(l: VoicePrior["labels"][number], now: number): boolean {
	return (
		decodedNotVoice(l) &&
		DEDICATED_CHANNEL_FAMILIES.has(familyOf(l.protocol)) &&
		!SHARED_CHANNEL_PROTOCOLS.has(l.protocol) &&
		l.at !== null &&
		Math.abs(now - l.at) <= STRONG_PRIOR_TTL_MS
	)
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
	readonly observationId: string | null
}

/** Per protocol, within the TTL: a checked sighting, and the distinct unchecked observations. */
interface DigitalEvidence {
	checked: boolean
	readonly unchecked: Set<string>
}

const inTtl = (at: number | null, now: number): at is number =>
	at !== null &&
	Number.isFinite(at) &&
	Math.abs(now - at) <= STRONG_PRIOR_TTL_MS

/** A digital voice protocol or `digital-unknown`: the labels digitalChannel reads. */
const digitalProtocol = (p: ScannerProtocol): boolean =>
	p === "digital-unknown" || familyOf(p) === "digital-voice"

/**
 * One pass over the owner's digital sightings dated within [now − STRONG_PRIOR_TTL_MS,
 * now + STRONG_PRIOR_TTL_MS] (a clock skew either way; undated never): its published labels
 * (`digital-unknown` and a decode or checked hint are checked) and, when the store gives them,
 * the digital proofs of its kept observations (VoicePrior.digitalProofs), so a newer unchecked
 * hint never hides a checked one and a decode no longer shown still counts while it is fresh.
 * An unchecked sighting counts by its observation; a published label citing none counts as one
 * only when no observation proofs are given (it is one of them otherwise).
 */
function digitalEvidence(
	prior: VoicePrior,
	now: number,
): Map<ScannerProtocol, DigitalEvidence> {
	const out = new Map<ScannerProtocol, DigitalEvidence>()
	const proofs = prior.digitalProofs?.()
	const note = (s: DigitalSighting): void => {
		if (!digitalProtocol(s.protocol) || !inTtl(s.at, now)) return
		let e = out.get(s.protocol)
		if (e === undefined) {
			e = { checked: false, unchecked: new Set() }
			out.set(s.protocol, e)
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
				observationId: l.observationId ?? null,
			})
	for (const p of proofs ?? []) note(p)
	return out
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
 * and for one digital protocol seen on the owner within the TTL (digitalEvidence):
 * - a checked sighting (a decode, a checked sync hint, `digital-unknown`) and
 *   DIGITAL_CHANNEL_MIN_SHARE of the votes in its classes (digitalChannelClasses); or
 * - DMR with only unchecked sync hints (dsd-fme sync with no verified TG/SRC) and either
 *   (a) that share in `tdma-ms` alone (TDMA burst structure is DMR's; NFM never reads it), or
 *   (b) that share in DMR's classes and hints from DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS
 *   distinct observations. An unchecked hint of another protocol (dPMR keeps no checked
 *   content) is never one.
 * A throwing or absent read: not one.
 */
function digitalChannel(prior: VoicePrior, now: number): boolean {
	if (!prior.labels.some(l => l.owner && digitalProtocol(l.protocol)))
		return false
	try {
		const evidence = digitalEvidence(prior, now)
		if (evidence.size === 0) return false
		const v = prior.classVotes?.()
		if (v === undefined || v.total < DIGITAL_CHANNEL_MIN_VOTES) return false
		for (const [protocol, e] of evidence) {
			const classes = digitalChannelClasses(protocol)
			if (e.checked && shareOf(v, classes)) return true
			if (protocol !== "dmr" || e.unchecked.size === 0) continue
			if (shareOf(v, TDMA_CLASSES)) return true
			if (
				e.unchecked.size >= DIGITAL_CHANNEL_UNCHECKED_OBSERVATIONS &&
				shareOf(v, classes)
			)
				return true
		}
		return false
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
 * The prior's strength at `now` (wall ms; PriorStrength); a throwing analogVoice reads as voice
 * heard (keeps).
 */
export function readPrior(
	prior: VoicePrior | null,
	backedClass: boolean,
	now: number,
): PriorStrength {
	const strong =
		prior !== null &&
		(prior.labels.some(l => strongLabel(l, now)) || digitalChannel(prior, now))
	if (!strong && !backedClass && (prior === null || !weakDigital(prior, now)))
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
 * its hold ends.
 */
export type FinishVerdict =
	| "finish"
	| "hold"
	| "discarded:known-non-voice"
	| "discarded:late-non-voice"

/**
 * A written file's fate at its finish (`final` false) or at the end of its grace (`final` true),
 * in this order: a file whose own audio carried a CTCSS tone, or whose session its tone classed
 * (`ownTone`: a roll-over file of a toned over), is always kept; one whose
 * own signal a decode proves not analog voice (`decodedOwn`, fileDecodedOwn) is discarded
 * (`discarded:late-non-voice`) unless a joined voice was on the air in it (`joinedVoice`,
 * joinedVoiceOverlaps: kept at once, the two cannot be separated); under a `tone-required` prior
 * a file no snapshot classed analog-fm (`snapshotClassed` false: classed by its own audio only,
 * or a file of a transmission that joined while the prior was strong) is discarded
 * (`discarded:known-non-voice`) and one a snapshot classed is held, then kept; under a `suspect`
 * prior it is held, then kept; with none it is kept at once. A prior alone (a decode of another
 * transmission, a co-channel discovery's) never discards a file a snapshot classed. `now`: wall
 * ms (readPrior).
 */
export function finishVerdict(input: {
	readonly prior: VoicePrior | null
	readonly backedClass: boolean
	readonly ownTone: boolean
	readonly snapshotClassed: boolean
	readonly decodedOwn: boolean
	readonly joinedVoice: boolean
	readonly final: boolean
	readonly now: number
}): FinishVerdict {
	if (input.ownTone) return "finish"
	if (input.decodedOwn)
		return input.joinedVoice ? "finish" : "discarded:late-non-voice"
	const strength = readPrior(input.prior, input.backedClass, input.now)
	if (strength === "tone-required" && !input.snapshotClassed)
		return "discarded:known-non-voice"
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
