/** Explicit allowlist: short ADS-B pulses cannot reliably open spectrum tracks.
 * AIS and rtl_433 remain observation-based: the 5 ms path can track their bursts. */
import { SCANNER_AMBIENT_TARGET_TOLERANCE_HZ } from "@wavekit/api-types"
import type { TuningTrust } from "../../spectrum/types.js"
import type {
	DecodeEvidence,
	Discovery,
	Observation,
	ScannerProtocol,
} from "../types.js"
import { identityFitsProtocol } from "../classify/label-from-evidence.js"
import { isTrusted } from "../probes/ambient-trust.js"
import { ADSB_HZ } from "../probes/confirm/readsb.js"

export const DECODE_ANCHOR_PROTOCOLS: readonly ScannerProtocol[] =
	Object.freeze(["adsb"])
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

export function canAnchor(
	ev: DecodeEvidence,
	hz: number,
	trust: TuningTrust | undefined,
): trust is "commanded" | "relay" {
	return (
		DECODE_ANCHOR_PROTOCOLS.includes(ev.protocol) &&
		Math.abs(hz - ADSB_HZ) <= SCANNER_AMBIENT_TARGET_TOLERANCE_HZ &&
		isTrusted(trust) &&
		ev.origin === "ambient" &&
		ev.crcClean &&
		Number.isFinite(ev.at) &&
		ev.identity !== undefined &&
		identityFitsProtocol(ev.protocol, ev.identity) &&
		/^[0-9a-f]{6}$/i.test(ev.identity.value)
	)
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
			family: "packet",
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
