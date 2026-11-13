/**
 * Whether rtlmux serves this core's connection alone (a plain resume's take-back, see
 * TunerController.plainResumeTakesTuningBack), from the sdr-host's client list. Fail closed: no
 * reading, a reading too old, no connection, or a list of zero clients is `clients-unknown`; two
 * or more clients with a complete list (one entry per client) are `another-client` (at most one
 * of them is this connection), a list that does not name every client `clients-unknown`.
 * Exactly one listed client while this connection is up is free: `port-matched` when it names
 * this connection's local port, `sole-client` when it names another port or none.
 *
 * Why one client is enough without the port (Main decision): rtlmux sees the core's address
 * after any NAT (a container network, a Docker or OrbStack gateway), which may rewrite the port,
 * so a port match is not something the core can rely on. While this connection is up rtlmux
 * lists it, so a list of exactly one client is this connection, provided the list itself is
 * newer than the connection. The sdr-host does not ask rtlmux at each request: it serves the
 * client list of its last stats poll, which may be older than the request (see
 * receiverClientsListedAfter). So the verdict's `readingAt` is not when the core's poll started
 * but the earliest instant the listed state can be from, and the core only counts a free verdict
 * whose list is newer than the connection's session and the gated fields' last doubt
 * (TunerController plainResumeVerdict): a list taken before this connection (one that names only
 * another client, SDR++ say) never counts, whatever the core's poll time.
 * Residual: a list of one client taken after this connection could only be another client if
 * rtlmux dropped this live connection from its list; that list is rtlmux's own client table, so
 * it does not.
 */
import type { ReceiverClientsVerdict } from "./tuner-controller.js"
import type { ReceiverClientsReading } from "./sdr-host-poller.js"

/**
 * The longest the sdr-host serves a client list after its last stats observation when the
 * answer does not say how old it is: the sdr-host's STATS_EXPIRE_MS (packages/sdr-host
 * telemetry/sampling.ts), 30 s. Past it the sdr-host lists no clients at all.
 */
export const SDR_HOST_LIST_MAX_AGE_MS = 30_000

/**
 * How long before its observation stamp rtlmux may have answered the sdr-host's stats request:
 * the sdr-host stamps the observation once the request returned, and aborts it after its stats
 * timeout (1500 ms by default); doubled for an abort timer that fires late on a busy Pi. 3 s.
 */
export const SDR_HOST_LIST_FETCH_MS = 3_000

export interface ReceiverClientsListBounds {
	/** The list's age when the answer names none (SDR_HOST_LIST_MAX_AGE_MS). */
	maxListAgeMs: number
	/** The sdr-host's stats request's longest duration (SDR_HOST_LIST_FETCH_MS). */
	fetchMs: number
}

export const DEFAULT_LIST_BOUNDS: Readonly<ReceiverClientsListBounds> =
	Object.freeze({
		maxListAgeMs: SDR_HOST_LIST_MAX_AGE_MS,
		fetchMs: SDR_HOST_LIST_FETCH_MS,
	})

/**
 * performance.now() at or after which rtlmux's listed state was read (a lower bound), or null.
 * The sdr-host built its answer after the core's poll started (startedAt) and reports how old
 * its last stats observation was then (`sampling.stats.ageMs`, ReceiverClientsReading.listAgeMs),
 * and rtlmux answered that observation's request at most `fetchMs` before it: so the list is from
 * no earlier than startedAt - listAgeMs - fetchMs. Both terms are elapsed times on the sdr-host's
 * own monotonic clock, so a clock offset between the hosts plays no part. Without an age the
 * longest the sdr-host serves a list stands in: startedAt - 30 s - 3 s with the defaults, so such
 * a reading counts only when its poll started 33 s after the session start or the last doubt.
 */
export function receiverClientsListedAfter(
	reading: ReceiverClientsReading,
	bounds: Readonly<ReceiverClientsListBounds> = DEFAULT_LIST_BOUNDS,
): number | null {
	const age = reading.listAgeMs
	const listAge =
		typeof age === "number" && Number.isFinite(age) && age >= 0
			? age
			: bounds.maxListAgeMs
	const at = reading.startedAt - listAge - bounds.fetchMs
	return Number.isFinite(at) ? at : null
}

/**
 * The oldest client reading that still counts: two poll intervals and the request timeout (one
 * poll may fail or be late; the next answer is due within an interval and a timeout of it). With
 * the defaults (3000 ms, 2000 ms) 8 s: a client that joined since is seen within that, and until
 * then the free verdict stands at most that long (rtlmux has no event to tell us sooner).
 */
export function receiverClientsMaxAgeMs(
	pollIntervalMs: number,
	timeoutMs: number,
): number {
	return 2 * pollIntervalMs + timeoutMs
}

export function receiverClientsVerdict(
	reading: ReceiverClientsReading | null,
	localPort: number | null,
	nowMs: number,
	maxAgeMs: number,
	bounds: Readonly<ReceiverClientsListBounds> = DEFAULT_LIST_BOUNDS,
): ReceiverClientsVerdict {
	const unknown: ReceiverClientsVerdict = {
		free: false,
		reason: "clients-unknown",
	}
	// No local port: this connection is not up, so a listed client is not this one.
	if (reading === null || localPort === null) return unknown
	const age = nowMs - reading.startedAt
	if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return unknown
	const readingAt = receiverClientsListedAfter(reading, bounds)
	if (readingAt === null) return unknown
	if (reading.clients === 1) {
		// More ports than clients: a malformed list, not one client.
		if (reading.ports.length > 1) return unknown
		const matched = reading.ports.length === 1 && reading.ports[0] === localPort
		return {
			free: true,
			reason: matched ? "port-matched" : "sole-client",
			readingAt,
		}
	}
	if (!Number.isInteger(reading.clients) || reading.clients < 2) return unknown
	// Only a list that names every client says who they are; at most one of them is this one.
	if (reading.ports.length !== reading.clients) return unknown
	return { free: false, reason: "another-client", readingAt }
}
