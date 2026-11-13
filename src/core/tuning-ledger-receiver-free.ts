/**
 * Whether rtlmux serves this core's connection alone (a plain resume's take-back, see
 * TunerController.plainResumeTakesTuningBack), from the sdr-host's client list. Fail closed: no
 * reading, a reading too old, a list without ports, or one that does not name this connection's
 * local port is `clients-unknown` (a reading taken before this connection, or a NAT that rewrites
 * ports, never names it); this connection and any other client is `another-client`.
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
	if (reading.clients === 1) return { free: true, reason: "receiver-free" }
	return { free: false, reason: "another-client" }
}
