import { sanitize } from "../ui/text.js"

/**
 * The address part of a client remote: `192.0.2.1:5555`, `::ffff:192.0.2.1:5555` (IPv4-mapped)
 * or `[2001:db8::1]:5555`. One parser for the Overview and the Receiver.
 */
export function remoteHost(remote: string): string {
	const r = remote.trim()
	const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(r)
	const host = bracket
		? (bracket[1] ?? r)
		: /:\d+$/.test(r)
			? r.slice(0, r.lastIndexOf(":"))
			: r
	return sanitize(host.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ""))
}
