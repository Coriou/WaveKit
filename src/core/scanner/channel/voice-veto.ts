/**
 * What the analog recorder (WidebandAnalogRecorder) must never keep as a voice recording: a
 * transmission whose own track a verified decode or the channel tier classes as a digital class
 * (a spectral reading alone never counts: weak or low-deviation NFM voice can read as one for
 * its whole length), or whose discovery (or the discovery it was merged into) is decoded as a
 * protocol that is not analog voice while that transmission was on the air (a decode of an
 * earlier transmission on a mixed-mode channel proves nothing about this one). Pure tables and
 * predicates; the recorder decides when they apply (admission and retention only).
 *
 * Both tables are total over their key type, so a class or protocol family added later fails to
 * compile until it is decided here. Unknown or malformed input is never digital and never "not
 * voice": the safe answer is today's behaviour (a voice is not lost on missing data).
 */
import { familyOf } from "../classify/classifier.js"
import type {
	ProtocolFamily,
	ScannerConfidence,
	ScannerClass,
	ScannerProtocol,
} from "../types.js"

/**
 * Per spectral class: a digital modulation, never analog voice. The 4FSK classes (DMR, YSF, P25,
 * NXDN, dPMR), the TDMA class, the wide 2FSK pager class and GMSK (D-STAR). Not digital: the
 * analog classes, a carrier, a burst (ISM bursts are never shadowed; a voice can read burst-like
 * first), AFSK (audio tones over FM: its demodulated audio is analog FM's), wideband and unknown.
 */
const CLASS_IS_DIGITAL: Readonly<Record<ScannerClass, boolean>> = {
	"fsk4-12k5": true,
	"fsk4-6k25": true,
	"tdma-ms": true,
	"fsk2-wide": true,
	"gmsk-narrow": true,
	"afsk-fm": false,
	"analog-fm": false,
	"analog-am": false,
	"ook-burst": false,
	carrier: false,
	wideband: false,
	unknown: false,
}

/** The digital classes (CLASS_IS_DIGITAL), derived once from the class table. */
export const DIGITAL_CLASSES: ReadonlySet<ScannerClass> = new Set(
	(Object.keys(CLASS_IS_DIGITAL) as ScannerClass[]).filter(
		c => CLASS_IS_DIGITAL[c],
	),
)

/** True iff `c` is one of DIGITAL_CLASSES; anything else (unknown, malformed) is false. */
export function digitalClass(c: unknown): boolean {
	return typeof c === "string" && DIGITAL_CLASSES.has(c as ScannerClass)
}

/**
 * Per protocol family: a decode of it proves the signal is not analog voice. Digital voice
 * (DMR voice included) is not analog voice either: the analog recorder's 8 kHz FM audio of it is
 * noise. Analog, carrier and unknown (digital-unknown among them) prove nothing.
 */
const FAMILY_NOT_ANALOG_VOICE: Readonly<Record<ProtocolFamily, boolean>> = {
	analog: false,
	"digital-voice": true,
	pager: true,
	packet: true,
	ism: true,
	carrier: false,
	unknown: false,
}

/**
 * True iff `protocol` is a known scanner protocol whose family proves it is not analog voice
 * (pocsag, flex, dmr, ais, aprs, adsb, ...: every protocol the registry maps to such a family).
 * Null, unknown or malformed input: false.
 */
export function notAnalogVoiceProtocol(protocol: unknown): boolean {
	if (typeof protocol !== "string" || protocol.length === 0) return false
	let family: ProtocolFamily | undefined
	try {
		family = familyOf(protocol as ScannerProtocol) as ProtocolFamily | undefined
	} catch {
		return false
	}
	return family !== undefined && Object.hasOwn(FAMILY_NOT_ANALOG_VOICE, family)
		? FAMILY_NOT_ANALOG_VOICE[family]
		: false
}

/** A discovery's decoded protocol and the decode behind it (ownerDecoded). */
export interface DecodedLabel {
	readonly protocol: ScannerProtocol
	/** When it was decoded (ms since the epoch, the newest decode of its proof); null: unknown. */
	readonly at: number | null
	/** The observation that was decoded; null or a synthetic id when no observation is cited. */
	readonly observationId: string | null
}

/** The label DecodedProtocolLookup gives (DiscoveryStore.ownerLabel's OwnerLabel). */
export interface LookupLabel {
	readonly protocol: ScannerProtocol
	readonly confidence: ScannerConfidence
	/** The proof's time (ms since the epoch); absent or null: unknown. */
	readonly proofAt?: number | null
	/** The observation the proof cites; absent or null: none. */
	readonly proofObservationId?: string | null
}

/** The discovery read ownerDecoded needs (DiscoveryStore.ownerLabel). */
export interface DecodedProtocolLookup {
	/**
	 * The published label of the live discovery whose folder `folderId` is (itself, or the owner
	 * of a merge alias), with its proof's time and observation; undefined when there is none.
	 * O(1), no copy of the discovery.
	 */
	ownerLabel(folderId: string): LookupLabel | undefined
}

/**
 * The decoded label of `discoveryId`, or of the live discovery it was merged into (its folder's
 * owner, recording-aliases.ts): the presented protocol while its confidence is `decoded`, with
 * the decode's time and observation, else null. Unknown ids, malformed answers and throwing
 * lookups: null; a malformed time or observation reads null (unknown).
 */
export function ownerDecoded(
	store: DecodedProtocolLookup,
	discoveryId: string,
): DecodedLabel | null {
	if (typeof discoveryId !== "string" || discoveryId.length === 0) return null
	try {
		const label = store.ownerLabel(discoveryId)
		if (label === undefined || label.confidence !== "decoded") return null
		if (typeof label.protocol !== "string" || label.protocol.length === 0)
			return null
		const at = label.proofAt
		const by = label.proofObservationId
		return {
			protocol: label.protocol,
			at: typeof at === "number" && Number.isFinite(at) ? at : null,
			observationId: typeof by === "string" && by.length > 0 ? by : null,
		}
	} catch {
		return null
	}
}
