/**
 * Endpoint probe (docs/specs/receiver-endpoints 3.2): checks that a candidate
 * address of a receiver answers as the same sdr-host process and serves rtl_tcp.
 * Read-only: one GET of `/api/status` and one TCP connection that reads the
 * 12-byte rtl_tcp header and closes. It never sends rtl_tcp commands.
 */

import * as net from "node:net"
import { z } from "zod"

export const ENDPOINT_PROBE_API_TIMEOUT_MS = 2000
export const ENDPOINT_PROBE_IQ_TIMEOUT_MS = 3000
const RTL_TCP_HEADER_BYTES = 12
/** sdr-host's /api/status is a few KB; anything far larger is not one. */
const STATUS_BODY_MAX_BYTES = 256 * 1024

let blocked: { v4: net.BlockList; v6: net.BlockList } | null = null

/**
 * Non-unicast, loopback, link-local and mapped ranges. net.BlockList parses
 * every IPv6 spelling (expanded, compressed, upper case, dotted tail) into the
 * same binary form and checks IPv4-mapped IPv6 input against IPv4 rules. IPv6
 * rules are kept in their own list because a `::ffff:0:0/96` rule would also
 * match every plain IPv4 input. Built on first use.
 */
function blockedRanges(): { v4: net.BlockList; v6: net.BlockList } {
	if (blocked) return blocked
	const v4 = new net.BlockList()
	v4.addSubnet("0.0.0.0", 8, "ipv4") // "this network", unspecified
	v4.addSubnet("127.0.0.0", 8, "ipv4") // loopback
	v4.addSubnet("169.254.0.0", 16, "ipv4") // link-local
	v4.addSubnet("224.0.0.0", 4, "ipv4") // multicast
	v4.addSubnet("240.0.0.0", 4, "ipv4") // reserved, includes 255.255.255.255
	const v6 = new net.BlockList()
	v6.addSubnet("::", 96, "ipv6") // unspecified, loopback, IPv4-compatible
	v6.addSubnet("::ffff:0:0", 96, "ipv6") // IPv4-mapped, whatever it carries
	v6.addSubnet("fe80::", 10, "ipv6") // link-local
	v6.addSubnet("ff00::", 8, "ipv6") // multicast
	blocked = { v4, v6 }
	return blocked
}

/**
 * A literal unicast address a receiver may list as an endpoint (receiver-endpoints
 * 3.6). Refuses hostnames, zone ids (`%`), and every spelling of the ranges
 * above, so a receiver's list cannot point core at its own loopback (for example
 * a relay on the same port), at link-local services or at multicast.
 */
export function isDialableEndpoint(address: string): boolean {
	if (address.includes("%")) return false
	const family = net.isIP(address)
	if (family === 0) return false
	const { v4, v6 } = blockedRanges()
	if (family === 4) return !v4.check(address, "ipv4")
	return !v6.check(address, "ipv6") && !v4.check(address, "ipv6")
}

async function readCappedJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) return null
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > STATUS_BODY_MAX_BYTES) {
			await reader.cancel()
			return null
		}
		chunks.push(value)
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

export interface EndpointProbe {
	/** The candidate's receiverId, or null on any failure. */
	receiverId(address: string, apiPort: number): Promise<string | null>
	/** True when the candidate's IQ port answers with an `RTL0` header. */
	rtlTcpHeader(address: string, iqPort: number): Promise<boolean>
}

const ReceiverIdSchema = z.object({
	receiverId: z.string().regex(/^[0-9a-f]{32}$/),
})

/**
 * The port of a source's configured sdr-host API: the port in `sdrHost.apiUrl`
 * (the scheme default when the URL has none), else 8080, the port core polls
 * when no URL is configured.
 */
export function configuredApiPort(apiUrl: string | undefined): number {
	if (!apiUrl) return 8080
	const url = new URL(apiUrl)
	if (url.port) return Number(url.port)
	return url.protocol === "https:" ? 443 : 80
}

/**
 * Probes dial `http://<addr>:<port>/api/status`, so selection supports only an
 * absent or plain `http://host[:port]` sdr-host URL; https or a path prefix
 * (a proxy) would make every probe miss.
 */
export function plainHttpApiUrl(apiUrl: string | undefined): boolean {
	if (!apiUrl) return true
	const url = new URL(apiUrl)
	return (
		url.protocol === "http:" &&
		(url.pathname === "/" || url.pathname === "") &&
		!url.search &&
		!url.username &&
		!url.password
	)
}

/** `host:port` authority for a literal IP; IPv6 needs brackets in a URL. */
export function urlAuthority(address: string, port: number): string {
	return net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`
}

export function createEndpointProbe(
	options: {
		fetchFn?: typeof fetch
		apiTimeoutMs?: number
		iqTimeoutMs?: number
		/** Address filter; tests widen it to loopback. */
		isAllowed?: (address: string) => boolean
	} = {},
): EndpointProbe {
	const fetchFn = options.fetchFn ?? fetch
	const apiTimeoutMs = options.apiTimeoutMs ?? ENDPOINT_PROBE_API_TIMEOUT_MS
	const iqTimeoutMs = options.iqTimeoutMs ?? ENDPOINT_PROBE_IQ_TIMEOUT_MS
	const isAllowed = options.isAllowed ?? isDialableEndpoint
	return {
		async receiverId(address, apiPort) {
			if (net.isIP(address) === 0 || !isAllowed(address)) return null
			try {
				const response = await fetchFn(
					`http://${urlAuthority(address, apiPort)}/api/status`,
					{
						signal: AbortSignal.timeout(apiTimeoutMs),
						headers: { Accept: "application/json" },
						redirect: "error",
					},
				)
				if (!response.ok) {
					await response.body?.cancel()
					return null
				}
				const parsed = ReceiverIdSchema.safeParse(
					await readCappedJson(response),
				)
				return parsed.success ? parsed.data.receiverId : null
			} catch {
				return null
			}
		},
		rtlTcpHeader(address, iqPort) {
			if (net.isIP(address) === 0 || !isAllowed(address))
				return Promise.resolve(false)
			return new Promise<boolean>(resolve => {
				let received = Buffer.alloc(0)
				let done = false
				const socket = net.createConnection({ host: address, port: iqPort })
				const finish = (ok: boolean): void => {
					if (done) return
					done = true
					clearTimeout(timer)
					socket.destroy()
					resolve(ok)
				}
				const timer = setTimeout(() => finish(false), iqTimeoutMs)
				timer.unref()
				socket.on("data", (chunk: Buffer) => {
					received = Buffer.concat([received, chunk])
					if (received.length >= RTL_TCP_HEADER_BYTES)
						finish(received.toString("ascii", 0, 4) === "RTL0")
				})
				socket.on("error", () => finish(false))
				socket.on("close", () => finish(false))
			})
		},
	}
}
