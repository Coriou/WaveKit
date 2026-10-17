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
	} = {},
): EndpointProbe {
	const fetchFn = options.fetchFn ?? fetch
	const apiTimeoutMs = options.apiTimeoutMs ?? ENDPOINT_PROBE_API_TIMEOUT_MS
	const iqTimeoutMs = options.iqTimeoutMs ?? ENDPOINT_PROBE_IQ_TIMEOUT_MS
	return {
		async receiverId(address, apiPort) {
			if (net.isIP(address) === 0) return null
			try {
				const response = await fetchFn(
					`http://${urlAuthority(address, apiPort)}/api/status`,
					{
						signal: AbortSignal.timeout(apiTimeoutMs),
						headers: { Accept: "application/json" },
						redirect: "error",
					},
				)
				if (!response.ok) return null
				const parsed = ReceiverIdSchema.safeParse(await response.json())
				return parsed.success ? parsed.data.receiverId : null
			} catch {
				return null
			}
		},
		rtlTcpHeader(address, iqPort) {
			if (net.isIP(address) === 0) return Promise.resolve(false)
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
