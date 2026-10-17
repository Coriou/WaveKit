// Endpoint choice for `pi-lan-bridge.mjs --auto` (docs/specs/receiver-endpoints 4.1).
// Same checks as core: a candidate is a literal IP from the receiver's own
// /api/status `endpoints`, answers with the same receiverId and serves an RTL0
// header. Read-only; sends no rtl_tcp commands. Falls back to the given host.
import net from "node:net"

const ID = /^[0-9a-f]{32}$/
// Same filter as core's isDialableEndpoint (src/core/endpoint-probe.ts): a
// literal unicast IP in any spelling, never loopback, link-local, multicast,
// mapped or with a zone id.
// IPv6 rules sit in their own list: `::ffff:0:0/96` would also match IPv4 input.
const blockedV4 = new net.BlockList()
blockedV4.addSubnet("0.0.0.0", 8, "ipv4")
blockedV4.addSubnet("127.0.0.0", 8, "ipv4")
blockedV4.addSubnet("169.254.0.0", 16, "ipv4")
blockedV4.addSubnet("224.0.0.0", 4, "ipv4")
blockedV4.addSubnet("240.0.0.0", 4, "ipv4")
const blockedV6 = new net.BlockList()
blockedV6.addSubnet("::", 96, "ipv6")
blockedV6.addSubnet("::ffff:0:0", 96, "ipv6")
blockedV6.addSubnet("fe80::", 10, "ipv6")
blockedV6.addSubnet("ff00::", 8, "ipv6")

export function isDialableEndpoint(address) {
	if (typeof address !== "string" || address.includes("%")) return false
	const family = net.isIP(address)
	if (family === 0) return false
	if (family === 4) return !blockedV4.check(address, "ipv4")
	return !blockedV6.check(address, "ipv6") && !blockedV4.check(address, "ipv6")
}

const authority = (host, port) =>
	net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`

async function receiverId(fetchFn, host, port) {
	try {
		const response = await fetchFn(
			`http://${authority(host, port)}/api/status`,
			{
				signal: AbortSignal.timeout(2000),
				redirect: "error",
			},
		)
		if (!response.ok) return null
		const body = await response.json()
		return typeof body?.receiverId === "string" && ID.test(body.receiverId)
			? { id: body.receiverId, endpoints: body.endpoints }
			: null
	} catch {
		return null
	}
}

export function rtlTcpHeader(host, port, timeoutMs = 3000) {
	return new Promise(resolve => {
		let received = Buffer.alloc(0)
		const socket = net.createConnection({ host, port })
		const finish = ok => {
			clearTimeout(timer)
			socket.destroy()
			resolve(ok)
		}
		const timer = setTimeout(() => finish(false), timeoutMs)
		socket.on("data", chunk => {
			received = Buffer.concat([received, chunk])
			if (received.length >= 12)
				finish(received.toString("ascii", 0, 4) === "RTL0")
		})
		socket.on("error", () => finish(false))
		socket.on("close", () => finish(false))
	})
}

/** Returns { host, reason }: the best verified address, else the given host. */
export async function chooseEndpoint(
	host,
	{
		apiPort = 8080,
		iqPort = 5555,
		fetchFn = fetch,
		header = rtlTcpHeader,
	} = {},
) {
	const self = await receiverId(fetchFn, host, apiPort)
	const list = self?.endpoints
	if (
		!self ||
		!list ||
		list.iqPort !== iqPort ||
		list.apiPort !== apiPort ||
		!Array.isArray(list.addresses)
	)
		return { host, reason: "no endpoint list; using the given host" }
	for (const entry of list.addresses) {
		const address = entry?.address
		if (typeof address !== "string" || !isDialableEndpoint(address)) continue
		if (address === host)
			return { host, reason: "given host is the best endpoint" }
		const other = await receiverId(fetchFn, address, apiPort)
		if (other?.id === self.id && (await header(address, iqPort)))
			return {
				host: address,
				reason: `verified ${entry.kind ?? "other"} endpoint`,
			}
	}
	return { host, reason: "no better endpoint verified; using the given host" }
}
