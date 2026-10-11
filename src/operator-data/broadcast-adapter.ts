import type {
	OperatorDataReadDto,
	OperatorDataSnapshot,
} from "@wavekit/api-types"
import { OperatorDataError } from "./schema.js"
import type { OperatorDataService } from "./service.js"
import { toOperatorDataReadDto } from "./transport.js"

export interface OperatorDataBroadcastPort {
	/** Owner catches/logs transport failures and invalidates affected streams for refetch. */
	publishUpdated(data: OperatorDataReadDto): void
	/** True means bounded acceptance for a currently authorized registered client, not delivery. */
	sendSnapshot(clientId: string, data: OperatorDataReadDto): boolean
}

/** Supply at service construction; never replaces a sink or registers an observer.
 * Mapping/publication throws propagate to the service's internal delivery-failed outcome.
 */
export function createOperatorDataCommitSink(
	port: OperatorDataBroadcastPort,
): (snapshot: OperatorDataSnapshot) => undefined {
	return snapshot => {
		port.publishUpdated(toOperatorDataReadDto(snapshot))
		return undefined
	}
}

/** Owner registers the authorized channel, then captures/maps/enqueues in one turn.
 * Owner gates enqueue AND flush with current leases and discards revoked queues.
 * Existing aggregate 1 MiB/256-message limits apply: two near-quota snapshots can
 * overflow, disconnect and require a reconnect snapshot. No coalescer is implied.
 * Capture/map failures propagate for owner subscription handling; never fake empty state.
 */
export function sendOperatorDataSnapshot(
	service: OperatorDataService | undefined,
	port: OperatorDataBroadcastPort,
	clientId: string,
): boolean {
	if (!service) throw new OperatorDataError("OPERATOR_DATA_UNAVAILABLE")
	return port.sendSnapshot(clientId, toOperatorDataReadDto(service.snapshot()))
}
