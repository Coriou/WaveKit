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

/**
 * A literal unicast address a receiver may list as an endpoint. Loopback,
 * unspecified, link-local, multicast, broadcast and IPv4-mapped addresses are
 * refused, so a receiver's list cannot point core at its own host or at
 * link-local services.
 */
export function isDialableEndpoint(address: string): boolean {
	const family = net.isIP(address)
	if (family === 4) {
		const [a = 0, b = 0] = address.split(".").map(Number)
		return !(a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224)
	}
	if (family === 6) {
		const lower = address.toLowerCase()
		return !(
			lower === "::" ||
			lower === "::1" ||
			/^fe[89ab]/.test(lower) ||
			lower.startsWith("ff") ||
			lower.startsWith("::ffff:")
		)
	}
	return false
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
