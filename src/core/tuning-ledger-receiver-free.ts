/**
 * Whether rtlmux serves this core's connection alone (a plain resume's take-back, see
 * TunerController.plainResumeTakesTuningBack), from the sdr-host's client list. Fail closed: no
 * reading, a reading too old, no connection, or a list of zero clients is `clients-unknown`; two
 * or more clients that name this connection's local port are `another-client`, two or more that
 * do not (or a list without ports) `clients-unknown`. Exactly one listed client while this
 * connection is up is free: `port-matched` when it names this connection's local port,
 * `sole-client` when it names another port or none.
 *
 * Why one client is enough without the port (Main decision): rtlmux sees the core's address
 * after any NAT (a container network, a Docker or OrbStack gateway), which may rewrite the port,
 * so a port match is not something the core can rely on. While this connection is up rtlmux
 * lists it, so a list of exactly one client is this connection, provided the reading is newer
 * than the connection: the core only counts a reading whose poll started after the connection's
 * session and the gated fields' last doubt (TunerController plainResumeVerdict, unchanged), so a
 * reading taken before this connection (which could list one other client) never counts.
 * Residual: a reading of one client could only be another client if rtlmux dropped this live
 * connection from its list; that list is rtlmux's own client table, so it does not.
 */
import type { ReceiverClientsVerdict } from "./tuner-controller.js"
import type { ReceiverClientsReading } from "./sdr-host-poller.js"

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
): ReceiverClientsVerdict {
	const unknown: ReceiverClientsVerdict = {
		free: false,
		reason: "clients-unknown",
	}
	// No local port: this connection is not up, so a listed client is not this one.
	if (reading === null || localPort === null) return unknown
	const age = nowMs - reading.startedAt
	if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return unknown
	const readingAt = reading.startedAt
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
	if (reading.ports.length !== reading.clients) return unknown
	if (!reading.ports.includes(localPort)) return unknown
	return { free: false, reason: "another-client", readingAt }
}
