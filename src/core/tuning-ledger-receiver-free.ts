/**
 * Whether rtlmux serves this core's connection alone (a plain resume's take-back, see
 * TunerController.plainResumeTakesTuningBack), from the sdr-host's client list. Fail closed: no
 * reading, a reading too old, a list without ports, or one that does not name this connection's
 * local port is `clients-unknown` (a reading taken before this connection, or a NAT that rewrites
 * ports, never names it); this connection and any other client is `another-client`.
 *
 * Matched by the local port alone, not the client's host (assumption, by design): rtlmux sees the
 * core's address after any NAT (a container network, a Docker or OrbStack gateway), so the host it
 * lists is not one the core can compare with its own. The port alone cannot make a busy receiver
 * read as free: a free verdict needs exactly one listed client with this port, and the core only
 * counts a reading whose poll started after the connection's session (TunerController
 * plainResumeVerdict), when rtlmux already lists this connection; so a single client with this
 * port on another host would mean this connection is missing from the list, which a connected
 * session's fresh reading never shows. Residual: a NAT that rewrites ports reads as
 * `clients-unknown` (fail closed).
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
	if (reading === null || localPort === null) return unknown
	const age = nowMs - reading.startedAt
	if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return unknown
	if (reading.ports.length !== reading.clients) return unknown
	if (!reading.ports.includes(localPort)) return unknown
	const readingAt = reading.startedAt
	if (reading.clients === 1)
		return { free: true, reason: "receiver-free", readingAt }
	return { free: false, reason: "another-client", readingAt }
}
