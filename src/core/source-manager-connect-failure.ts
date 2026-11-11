/**
 * Connect-failure status of a network source (GET /api/sources `connectFailure`): where the
 * last attempt went, a closed error class, failed attempts since the last connect, when the last
 * one failed, and a short fixed hint. Nothing from the error or the peer is echoed: the class
 * comes from a fixed code table, and the target is the attempt's own host and port, shown only
 * when it is a plain host name or address.
 */
import type {
	SourceConnectErrorClass,
	SourceConnectFailure,
} from "@wavekit/api-types"

/** System and core error codes per class; any other code is `other`. */
const CODE_CLASSES: ReadonlyMap<string, SourceConnectErrorClass> = new Map([
	["ECONNREFUSED", "refused"],
	["ETIMEDOUT", "timeout"],
	["SOURCE_CONNECT_TIMEOUT", "timeout"],
	["EHOSTUNREACH", "unreachable"],
	["ENETUNREACH", "unreachable"],
	["EHOSTDOWN", "unreachable"],
	["ENOTFOUND", "not-found"],
	["EAI_AGAIN", "not-found"],
	["ECONNRESET", "reset"],
	["EPIPE", "reset"],
	["SOURCE_STALLED", "stalled"],
	["SOURCE_SILENT", "silent"],
	["SOURCE_PEER_CLOSED", "closed"],
])

/** The class of a connection error; unknown, missing or non-string codes are `other`. */
export function connectErrorClass(err: unknown): SourceConnectErrorClass {
	if (err === null || typeof err !== "object") return "other"
	const code: unknown = Reflect.get(err, "code")
	if (typeof code !== "string") return "other"
	return CODE_CLASSES.get(code) ?? "other"
}

/**
 * Host names (RFC 1123 labels), IPv4 and bracket-free IPv6 literals only, 253 characters at most
 * (the DNS name limit): anything else is never shown.
 */
const PLAIN_HOST =
	/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^[0-9A-Fa-f:.]{2,45}$/

/** `host:port` (`[v6]:port`) when both are plain, else null. */
export function connectTarget(host: unknown, port: unknown): string | null {
	if (typeof host !== "string" || !PLAIN_HOST.test(host)) return null
	if (
		typeof port !== "number" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535
	)
		return null
	return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
}

/** One short, fixed hint per class; `at` is a validated target or a fixed phrase. */
export function connectHint(
	errorClass: SourceConnectErrorClass,
	target: string | null,
): string {
	const at = target ?? "the configured receiver"
	switch (errorClass) {
		case "refused":
			return `Nothing listening at ${at}: is the bridge or rtl_tcp running?`
		case "timeout":
			return `No answer from ${at} in time: is the host up and the port open?`
		case "unreachable":
			return `No route to ${at}: is the host on this network?`
		case "not-found":
			return `The host name of ${at} does not resolve: check the source host.`
		case "reset":
			return `${at} closed the connection: the server restarted or another client holds it.`
		case "closed":
			return `${at} ended the connection: the server stopped or dropped this client.`
		case "stalled":
			return `Connected to ${at} but no samples arrived: is the dongle attached?`
		case "silent":
			return `${at} accepted the connection but sent no samples in time: trying the next endpoint.`
		case "other":
			return `Could not connect to ${at}.`
	}
}

/** A peer's close without a socket error: an attempt of class `closed`. */
export const PEER_CLOSED: { code: "SOURCE_PEER_CLOSED" } = {
	code: "SOURCE_PEER_CLOSED",
}

/**
 * The per-source record SourceManager keeps; cleared by the first payload of a connection (the
 * rtl_tcp header), not by the TCP accept, so an accept-then-reset or a stall keeps counting;
 * also cleared by a pause (a deliberate close is no failure).
 */
export interface ConnectFailureRecord {
	target: string | null
	errorClass: SourceConnectErrorClass
	attempts: number
	lastAttemptAt: number
}

export function noteConnectFailure(
	previous: ConnectFailureRecord | null,
	err: unknown,
	host: unknown,
	port: unknown,
	now: number,
): ConnectFailureRecord {
	return {
		target: connectTarget(host, port),
		errorClass: connectErrorClass(err),
		attempts: (previous?.attempts ?? 0) + 1,
		lastAttemptAt: now,
	}
}

/** The status field for a record (shown only while the source is not connected). */
export function connectFailureStatus(
	record: ConnectFailureRecord,
): SourceConnectFailure {
	return {
		...(record.target !== null ? { target: record.target } : {}),
		errorClass: record.errorClass,
		attempts: record.attempts,
		lastAttemptAt: new Date(record.lastAttemptAt).toISOString(),
		hint: connectHint(record.errorClass, record.target),
	}
}
