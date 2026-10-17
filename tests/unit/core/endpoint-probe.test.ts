import { afterEach, describe, expect, it, vi } from "vitest"
import * as net from "node:net"
import { once } from "node:events"
import {
	createEndpointProbe,
	isDialableEndpoint,
	urlAuthority,
} from "../../../src/core/endpoint-probe.js"

const servers: net.Server[] = []
afterEach(async () => {
	for (const s of servers.splice(0))
		await new Promise<void>(resolve => s.close(() => resolve()))
})

async function serve(onConnect: (socket: net.Socket) => void): Promise<number> {
	const server = net.createServer(socket => {
		socket.on("error", () => {})
		onConnect(socket)
	})
	servers.push(server)
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	return (server.address() as net.AddressInfo).port
}

const ID = "0123456789abcdef0123456789abcdef"

describe("endpoint probe", () => {
	it("accepts an RTL0 header, sends nothing and closes", async () => {
		const received: Buffer[] = []
		let closed = false
		const port = await serve(socket => {
			socket.on("data", chunk => received.push(chunk))
			socket.on("close", () => (closed = true))
			// The header may arrive split across segments.
			socket.write(Buffer.from("RTL0\0\0"))
			setTimeout(() => socket.write(Buffer.from([0, 5, 0, 0, 0, 29, 1, 2])), 10)
		})
		const probe = createEndpointProbe({ isAllowed: () => true })
		expect(await probe.rtlTcpHeader("127.0.0.1", port)).toBe(true)
		await vi.waitFor(() => expect(closed).toBe(true))
		expect(Buffer.concat(received).length).toBe(0)
	})

	it("rejects a wrong magic, an early close, silence and hostnames", async () => {
		const probe = createEndpointProbe({
			iqTimeoutMs: 100,
			isAllowed: () => true,
		})
		const wrong = await serve(s => s.end(Buffer.from("HTTP/1.1 200")))
		const early = await serve(s => s.end(Buffer.from("RTL0")))
		const silent = await serve(() => {})
		expect(await probe.rtlTcpHeader("127.0.0.1", wrong)).toBe(false)
		expect(await probe.rtlTcpHeader("127.0.0.1", early)).toBe(false)
		expect(await probe.rtlTcpHeader("127.0.0.1", silent)).toBe(false)
		expect(await probe.rtlTcpHeader("localhost", silent)).toBe(false)
	})

	it("reads the candidate's receiverId and fails closed on anything else", async () => {
		const fetchFn = vi.fn<typeof fetch>()
		const probe = createEndpointProbe({ fetchFn })
		fetchFn.mockResolvedValueOnce(Response.json({ receiverId: ID, extra: 1 }))
		expect(await probe.receiverId("2001:db8::69", 8080)).toBe(ID)
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"http://[2001:db8::69]:8080/api/status",
		)
		fetchFn.mockResolvedValueOnce(Response.json({ receiverId: "short" }))
		expect(await probe.receiverId("192.0.2.69", 8080)).toBeNull()
		fetchFn.mockResolvedValueOnce(new Response("nope", { status: 500 }))
		expect(await probe.receiverId("192.0.2.69", 8080)).toBeNull()
		fetchFn.mockRejectedValueOnce(new Error("timeout"))
		expect(await probe.receiverId("192.0.2.69", 8080)).toBeNull()
		expect(await probe.receiverId("evil.example", 8080)).toBeNull()
		expect(fetchFn).toHaveBeenCalledTimes(4)
		expect(urlAuthority("192.0.2.69", 5555)).toBe("192.0.2.69:5555")
	})

	it("refuses loopback, unspecified, link-local, multicast and mapped addresses by default", async () => {
		for (const address of [
			"127.0.0.1",
			"0.0.0.0",
			"169.254.169.254",
			"224.0.0.251",
			"255.255.255.255",
			"::1",
			"::",
			"fe80::1",
			"ff02::fb",
			"::ffff:192.0.2.1",
			"wavekit-pi.local",
		])
			expect(isDialableEndpoint(address)).toBe(false)
		for (const address of [
			"192.0.2.69",
			"198.51.100.23",
			"10.0.0.2",
			"2001:db8::69",
		])
			expect(isDialableEndpoint(address)).toBe(true)
		const fetchFn = vi.fn<typeof fetch>()
		const probe = createEndpointProbe({ fetchFn })
		expect(await probe.receiverId("169.254.169.254", 80)).toBeNull()
		expect(await probe.rtlTcpHeader("127.0.0.1", 5555)).toBe(false)
		expect(fetchFn).not.toHaveBeenCalled()
	})

	it("refuses an oversized status body", async () => {
		const fetchFn = vi.fn<typeof fetch>(
			async () =>
				new Response(`{"receiverId":"${ID}","pad":"${"x".repeat(300_000)}"}`),
		)
		expect(
			await createEndpointProbe({ fetchFn }).receiverId("192.0.2.69", 8080),
		).toBeNull()
	})
})
