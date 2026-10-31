/** Explicit allowlist: short ADS-B pulses cannot reliably open spectrum tracks.
 * AIS and rtl_433 remain observation-based: the 5 ms path can track their bursts.
 * ACARS blocks and VDL2 frames are channel anchors (CHANNEL_ANCHOR_PROTOCOLS): they attach
 * to a spectrum observation when one places them and anchor at their channel otherwise. */
import { SCANNER_AMBIENT_TARGET_TOLERANCE_HZ } from "@wavekit/api-types"
import type { TuningTrust } from "../../spectrum/types.js"
import type {
	DecodeEvidence,
	Discovery,
	Observation,
	ScannerProtocol,
} from "../types.js"
import { identityFitsProtocol } from "../classify/label-from-evidence.js"
import { familyOf } from "../classify/classifier.js"
import { isTrusted } from "../probes/ambient-trust.js"
import { plausibleRegistration } from "../probes/confirm/acars.js"
import { ADSB_HZ } from "../probes/confirm/readsb.js"

export const DECODE_ANCHOR_PROTOCOLS: readonly ScannerProtocol[] =
	Object.freeze(["adsb"])
/**
 * Burst data links anchored per channel: an ACARS block (about 0.2-1 s) or a VDL2 frame (tens
 * of ms) rarely opens a spectrum track the decode can be placed on, so a confirmed decode that
 * no observation places anchors at the decoder's own channel frequency.
 */
export const CHANNEL_ANCHOR_PROTOCOLS: readonly ScannerProtocol[] =
	Object.freeze(["acars", "vdl2"])
/**
 * VHF aeronautical mobile band (ICAO Annex 10: 117.975-137.000 MHz), where every ACARS and
 * VDL2 channel lies. A channel anchor outside it is refused (a misread or misplaced decode).
 */
export const AERO_VHF_MIN_HZ = 117_975_000
export const AERO_VHF_MAX_HZ = 137_000_000
export const ANCHOR_AIRCRAFT_WINDOW_MS = 60_000
/** Same ceiling as ambient's accepted identity memory: 4096 latest confirmation times. */
export const ANCHOR_AIRCRAFT_MAX = 4096

/** JSON tuple avoids source-id delimiter collisions; rebuilt from persisted records. */
export function decodeAnchorKey(
	sourceId: string,
	protocol: ScannerProtocol,
	hz: number,
): string {
	return JSON.stringify([sourceId, protocol, hz])
}

/**
 * The frequency an anchor of `protocol` sits at for a decode at `hz`, or undefined when the
 * decode may not anchor there. ADS-B has one anchor at 1090 MHz (within the 1 kHz ambient
 * target tolerance). A channel anchor sits at the decode's channel rounded to whole Hz: the
 * decoders report their configured channel, and an MHz-to-Hz product such as
 * 131.825 × 1e6 = 131 824 999.99999999 must key the same channel as 131 825 000. Channels are
 * at least 8.33 kHz apart, far above the 0.5 Hz rounding.
 */
export function anchorHzOf(
	protocol: ScannerProtocol,
	hz: number,
): number | undefined {
	if (!Number.isFinite(hz)) return undefined
	if (DECODE_ANCHOR_PROTOCOLS.includes(protocol))
		return Math.abs(hz - ADSB_HZ) <= SCANNER_AMBIENT_TARGET_TOLERANCE_HZ
			? ADSB_HZ
			: undefined
	if (!CHANNEL_ANCHOR_PROTOCOLS.includes(protocol)) return undefined
	const channel = Math.round(hz)
	return channel >= AERO_VHF_MIN_HZ && channel <= AERO_VHF_MAX_HZ
		? channel
		: undefined
}

/** The identity format each anchor protocol's interpreter writes (anything else never anchors). */
function anchorIdentityOk(protocol: ScannerProtocol, value: string): boolean {
	if (protocol === "adsb") return /^[0-9a-f]{6}$/i.test(value)
	if (protocol === "vdl2") return /^[0-9A-F]{6}$/.test(value)
	if (protocol === "acars") return plausibleRegistration(value)
	return false
}

/**
 * Only a confirmed, CRC-clean, trusted ambient decode with a well-formed identity anchors. The
 * identity is the confirm interpreters' H2 acceptance: an energy reading, a decoder line without
 * a checked CRC, or one occurrence alone never reaches here with an identity.
 */
export function canAnchor(
	ev: DecodeEvidence,
	hz: number,
	trust: TuningTrust | undefined,
): trust is "commanded" | "relay" {
	return (
		anchorHzOf(ev.protocol, hz) !== undefined &&
		isTrusted(trust) &&
		ev.origin === "ambient" &&
		ev.crcClean === true &&
		Number.isFinite(ev.at) &&
		ev.identity !== undefined &&
		identityFitsProtocol(ev.protocol, ev.identity) &&
		anchorIdentityOk(ev.protocol, ev.identity.value)
	)
}

/** The anchor row key of an identity: ICAO addresses compare case-free, others as written. */
export function anchorRowKey(protocol: ScannerProtocol, value: string): string {
	return protocol === "adsb" ? value.toLowerCase() : value
}

export function newDecodeAnchor(
	id: string,
	sourceId: string,
	hz: number,
	ev: DecodeEvidence,
	tuningTrust: "commanded" | "relay",
): { discovery: Discovery; observation: Observation } {
	const at = new Date(ev.at).toISOString()
	// These are unavailable measurements, not a fabricated spectrum track. The anchor marker
	// distinguishes their zero placeholders; no airtime or RF bandwidth is inferred from decodes.
	const stats = { peakDbfs: 0, meanDbfs: 0, snrDb: 0, floorDbfs: 0 }
	return {
		discovery: {
			id,
			anchor: "decode",
			aircraftCount: 1,
			frequencyHz: hz,
			frequencyKey: `decode:${ev.protocol}:${hz}`,
			measuredOffsetHz: 0,
			bandwidthHz: 0,
			protocol: ev.protocol,
			family: familyOf(ev.protocol),
			class: "unknown",
			confidence: "decoded",
			encrypted: false,
			coChannel: [],
			firstSeenAt: at,
			lastSeenAt: at,
			observationCount: 1,
			airtimeMs: 0,
			signal: { best: stats, last: { ...stats } },
			metadata: {
				talkgroups: [],
				sources: [],
				slots: [],
				callsigns: [],
				capcodes: [],
				ismModels: [],
			},
			sourceIds: [sourceId],
			jobIds: [],
			tuningTrust,
			evidence: { recordings: 0, psd: false, iq: false },
		},
		observation: {
			id: `decode:${id}`,
			discoveryId: id,
			startedAt: at,
			endedAt: at,
			sampleRange: { stream: 0, epoch: ev.epoch, start: 0 },
			centerHz: hz,
			obwHz: 0,
			obwMethod: "on-bins",
			...stats,
			thresholdDb: 0,
			dutyCycle: 0,
			hypotheses: [],
			decode: [],
			recordingIds: [],
			flags: {
				overload: false,
				gap: false,
				offRaster: false,
				obwBiased: false,
				adjacentLeak: false,
				suspectedIntermod: false,
				edge: false,
			},
			sourceId,
			jobIds: [],
			tuningTrust,
		},
	}
}
