import { isIP } from "node:net"

/** Canonical host plus effective port, with no DNS lookup or URL heuristics. */
export function normalizeAuthority(
	value: string,
	scheme: "http" | "https",
): string | null {
	if (value.length === 0 || value.length > 300 || /[^\x21-\x7e]/.test(value))
		return null
	let host: string
	let portText: string | undefined
	if (value.startsWith("[")) {
		const match = /^\[([0-9a-fA-F:.]+)\](?::([0-9]+))?$/.exec(value)
		if (!match?.[1] || isIP(match[1]) !== 6) return null
		// WHATWG URL supplies consistent IPv6 compression after strict validation.
		host = new URL(`http://[${match[1]}]`).hostname
		portText = match[2]
	} else {
		const match = /^([a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value)
		if (!match?.[1]) return null
		host = match[1].toLowerCase()
		portText = match[2]
		if (/^[0-9.]+$/.test(host)) {
			if (isIP(host) !== 4) return null
		} else if (
			host.length > 253 ||
			host
				.split(".")
				.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
		) {
			return null
		}
	}
	const port =
		portText === undefined ? (scheme === "https" ? 443 : 80) : Number(portText)
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null
	return `${host}:${port}`
}

/** Serialized HTTP(S) origin only: no userinfo, path, query, fragment or null. */
export function normalizeOrigin(value: string): string | null {
	const match = /^(https?):\/\/([^/]+)$/.exec(value)
	if (!match?.[1] || !match[2]) return null
	const scheme = match[1] as "http" | "https"
	const authority = normalizeAuthority(match[2], scheme)
	if (!authority) return null
	const defaultPort = scheme === "https" ? ":443" : ":80"
	return `${scheme}://${authority.endsWith(defaultPort) ? authority.slice(0, -defaultPort.length) : authority}`
}
