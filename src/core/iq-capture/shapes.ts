/**
 * Replay shapes from the probe channel requests (WG11 req 6.7). Kept apart from the service:
 * `channel-transport.ts` pulls in the decoder adapters, so only the scanner service (which already bundles it) imports this.
 */
import { PROBE_CHANNEL_REQUESTS } from "../scanner/probes/channel-transport.js"
import type { IqReplayShapes } from "./service.js"

export function probeReplayShapes(): IqReplayShapes {
	const shape = (t: "dsd-fme" | "multimon-ng" | "direwolf") => ({
		bandwidthHz: PROBE_CHANNEL_REQUESTS[t].bandwidthHz,
		transitionHz: PROBE_CHANNEL_REQUESTS[t].transitionHz,
	})
	return Object.freeze({
		"dsd-fme": shape("dsd-fme"),
		"multimon-ng": shape("multimon-ng"),
		direwolf: shape("direwolf"),
	})
}
