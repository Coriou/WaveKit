/**
 * Band-plan change notices on the `bandplans` WebSocket channel.
 *
 * Main wires the transport (WebSocketEventBroadcaster), the subscribe observer
 * and the service `onCommit` sink. This module does not import the broadcaster:
 * the transport stays structural so the broadcaster is assignable once the
 * channel and message join the events.ts unions. Method syntax is required for
 * that assignability (function properties are checked contravariantly).
 */
import {
	BANDPLANS_CHANGED_EVENT,
	BANDPLANS_WS_CHANNEL,
} from "@wavekit/api-types"
import type {
	BandPlansChangedEventData,
	BandPlansServerMessage,
} from "@wavekit/api-types"
import type {
	BandPlansBroadcastPort,
	CreateBandPlansCommitSink,
	SendBandPlansSnapshot,
} from "../../core/bandplans/contract.js"

/**
 * Structural transport. Method syntax, not function properties, so
 * WebSocketEventBroadcaster is assignable once Main adds `bandplans` to the
 * channel and server-message unions.
 */
export interface BandPlansBroadcastTransport {
	broadcast(channel: "bandplans", message: BandPlansServerMessage): void
	sendToClients(
		channel: "bandplans",
		clientIds: Iterable<string>,
		message: BandPlansServerMessage,
	): number
}

function tokenCopy(data: BandPlansChangedEventData): BandPlansChangedEventData {
	return { storeId: data.storeId, revision: data.revision }
}

function changedMessage(
	data: BandPlansChangedEventData,
): BandPlansServerMessage {
	return {
		type: BANDPLANS_CHANGED_EVENT,
		channel: BANDPLANS_WS_CHANNEL,
		data: tokenCopy(data),
	}
}

/**
 * `publishChanged` broadcasts one fresh envelope. A throwing transport calls
 * `onPublishFailure` and does not propagate, including when that callback throws.
 * `sendSnapshot` is true only when exactly one client accepted.
 */
export function createBandPlansBroadcastPort(
	transport: BandPlansBroadcastTransport,
	onPublishFailure: () => void,
): BandPlansBroadcastPort {
	return {
		publishChanged(data) {
			try {
				transport.broadcast(BANDPLANS_WS_CHANNEL, changedMessage(data))
			} catch {
				try {
					onPublishFailure()
				} catch {
					// Invalidation is best-effort. A failed publish must not escape.
				}
			}
		},
		sendSnapshot(clientId, data) {
			return (
				transport.sendToClients(
					BANDPLANS_WS_CHANNEL,
					[clientId],
					changedMessage(data),
				) === 1
			)
		},
	}
}

/** Service `onCommit`. Copies the token. Port throws reach the service. */
export const createBandPlansCommitSink: CreateBandPlansCommitSink = port => {
	return event => {
		port.publishChanged(tokenCopy(event))
		return undefined
	}
}

/**
 * Subscribe snapshot. `"unavailable"` sends nothing. A throwing `view()` propagates
 * so the owner can invalidate that client. Null `storeId` is a real token.
 */
export const sendBandPlansSnapshot: SendBandPlansSnapshot = (
	service,
	port,
	clientId,
) => {
	if (service === undefined) return "unavailable"
	const store = service.view().store
	if (store.state !== "available") return "unavailable"
	const accepted = port.sendSnapshot(clientId, tokenCopy(store))
	return accepted ? "sent" : "rejected"
}
