/** Explicit allowlist: short ADS-B pulses cannot reliably open spectrum tracks.
 * AIS and rtl_433 remain observation-based: the 5 ms path can track their bursts. */
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
/** Same ceiling as ambient's accepted identity memory: 4096 x one latest decode.
 * A single anchor observation replaces entries in place, never banks message history. */
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
		hz === ADSB_HZ &&
		isTrusted(trust) &&
		ev.origin === "ambient" &&
		ev.crcClean &&
		Number.isFinite(ev.at) &&
		ev.identity !== undefined &&
		identityFitsProtocol(ev.protocol, ev.identity) &&
		/^[0-9a-f]{6}$/i.test(ev.identity.value)
	)
}

export function anchorDecodes(
	rows: readonly DecodeEvidence[],
	ev: DecodeEvidence,
): DecodeEvidence[] {
	const next = rows.filter(
		row =>
			row.at >= ev.at - ANCHOR_AIRCRAFT_WINDOW_MS &&
			row.identity?.value !== ev.identity?.value,
	)
	next.push(structuredClone(ev))
	next.sort(
		(a, b) => a.at - b.at || (a.identity!.value < b.identity!.value ? -1 : 1),
	)
	return next.slice(-ANCHOR_AIRCRAFT_MAX)
}

export function aircraftCount(
	rows: readonly DecodeEvidence[],
	now: number,
): number {
	return rows.filter(
		row => row.at >= now - ANCHOR_AIRCRAFT_WINDOW_MS && row.at <= now,
	).length
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
			identity: structuredClone(ev.identity!),
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
			decode: [structuredClone(ev)],
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
