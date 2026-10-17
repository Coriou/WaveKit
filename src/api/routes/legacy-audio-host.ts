/**
 * Legacy audio host derivation (pure, no runtime imports beyond node:net).
 *
 * In legacy mode the live-audio and digital-voice status URLs fall back to
 * `http://localhost:<audioPort>/...`, which is useless to a browser on another
 * machine. A route may rewrite that fallback per response with the caller's own
 * `Host` header. The derived value is never stored, logged or broadcast.
 *
 * Fail closed: only an exact localhost fallback and a `Host` that parses as a
 * DNS name (RFC 1123), a dotted-quad IPv4 address or a bracketed IPv6 address
 * (optional numeric port, ignored) produce a new URL; anything else returns
 * `baseUrl` unchanged.
 */

import { isIPv6 } from "node:net"

/** RFC 1123 total name length. */
const MAX_DNS_NAME = 253
/** RFC 1123 label length. */
const MAX_DNS_LABEL = 63
/** Longest bracketed IPv6 (45 chars inside + brackets) plus ":65535". */
const MAX_HOST_HEADER = MAX_DNS_NAME + 6

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/
const HOST_CHARS = /^[A-Za-z0-9.:[\]-]+$/
const PORT = /^\d{1,5}$/
/** Inside of an IPv6 literal: hex, colons and dots (embedded IPv4) only. */
const IPV6_CHARS = /^[0-9a-f:.]+$/

function isIPv4DottedQuad(value: string): boolean {
	const parts = value.split(".")
	if (parts.length !== 4) return false
	return parts.every(part => IPV4_OCTET.test(part) && Number(part) <= 255)
}

function isDnsName(value: string): boolean {
	if (value.length === 0 || value.length > MAX_DNS_NAME) return false
	const labels = value.split(".")
	// An all-numeric dotted name is either a valid quad (handled earlier) or junk.
	if (labels.every(label => /^\d+$/.test(label))) return false
	// WHATWG URL parsing reads a numeric or hex last label as IPv4 (a.1 is
	// rejected, 0x7f.0.0.1 becomes 127.0.0.1): refuse such names.
	const last = labels[labels.length - 1] ?? ""
	if (/^(\d+|0x[0-9a-f]*)$/.test(last)) return false
	return labels.every(
		label => label.length <= MAX_DNS_LABEL && DNS_LABEL.test(label),
	)
}

/**
 * Parse a raw `Host` value into a normalised (lowercase) host for a URL, or
 * `undefined` when it is not exactly one valid host with an optional port.
 */
export function parseLegacyHost(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined
	if (raw.length === 0 || raw.length > MAX_HOST_HEADER) return undefined
	// ASCII host characters only, before lowercasing (U+212A lowercases to "k").
	if (!HOST_CHARS.test(raw)) return undefined
	const value = raw.toLowerCase()
	let host: string
	let port: string | undefined
	if (value.startsWith("[")) {
		const close = value.indexOf("]")
		if (close < 0) return undefined
		host = value.slice(0, close + 1)
		const rest = value.slice(close + 1)
		if (rest.length > 0) {
			if (!rest.startsWith(":")) return undefined
			port = rest.slice(1)
		}
		const inside = host.slice(1, -1)
		if (!IPV6_CHARS.test(inside) || !isIPv6(inside)) return undefined
	} else {
		const colon = value.indexOf(":")
		if (colon >= 0) {
			host = value.slice(0, colon)
			port = value.slice(colon + 1)
		} else {
			host = value
		}
		if (!isIPv4DottedQuad(host) && !isDnsName(host)) return undefined
	}
	if (port !== undefined && (!PORT.test(port) || Number(port) > 65535)) {
		return undefined
	}
	return host
}

function isValidAudioPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * Rewrite the localhost fallback `baseUrl` with the request host. `hostHeader`
 * is the raw `Host` value, or an array when the request carried several
 * (always refused).
 */
export function deriveLegacyAudioUrl(
	baseUrl: string,
	hostHeader: string | readonly string[] | undefined,
	audioPort: number,
): string {
	if (!isValidAudioPort(audioPort)) return baseUrl
	const prefix = `http://localhost:${audioPort}`
	if (!baseUrl.startsWith(`${prefix}/`)) return baseUrl
	if (typeof hostHeader !== "string") return baseUrl
	const host = parseLegacyHost(hostHeader)
	if (host === undefined) return baseUrl
	const derived = `http://${host}:${audioPort}${baseUrl.slice(prefix.length)}`
	// The URL parser must read back exactly the name or IPv4 we validated
	// (a bracketed IPv6 is already checked by isIPv6 and may be re-spelled).
	try {
		const parsed = new URL(derived)
		if (!host.startsWith("[") && parsed.hostname !== host) {
			return baseUrl
		}
	} catch {
		return baseUrl
	}
	return derived
}

interface RequestHostSource {
	headers: { host?: string | undefined }
	raw: { rawHeaders: readonly string[] }
}

/**
 * The request's raw `Host` value, or every value when it carried more than one
 * (Node keeps only the first in `headers.host`). Never `X-Forwarded-*`.
 */
export function requestHostHeader(
	request: RequestHostSource,
): string | readonly string[] | undefined {
	const raw = request.raw.rawHeaders
	const values: string[] = []
	for (let i = 0; i + 1 < raw.length; i += 2) {
		if (raw[i]?.toLowerCase() === "host") values.push(raw[i + 1] ?? "")
	}
	if (values.length > 1) return values
	return request.headers.host
}

const LOCALHOST_AUDIO_URL = /^http:\/\/localhost:(\d{1,5})\//

/**
 * Rewrite a localhost fallback audio URL whose port is read from the URL itself (a route
 * that relays a stored stream URL without knowing which audio listener made it). Same
 * fail-closed rules as `deriveLegacyAudioUrl`.
 */
export function deriveLegacyAudioUrlFromBase(
	baseUrl: string,
	hostHeader: string | readonly string[] | undefined,
): string {
	const port = LOCALHOST_AUDIO_URL.exec(baseUrl)?.[1]
	if (port === undefined) return baseUrl
	return deriveLegacyAudioUrl(baseUrl, hostHeader, Number(port))
}
