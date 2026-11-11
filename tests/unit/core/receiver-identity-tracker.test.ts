/**
 * Receiver identity per connection, on production wiring: a real SourceManager against
 * an in-process fake rtl_tcp on an ephemeral loopback port, and a real SdrHostPoller whose fetch
 * is a fake sdr-host status provider (no request leaves the process).
 */
import * as net from "node:net"
import { once } from "node:events"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { SourceManager } from "../../../src/core/source-manager.js"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import { ReceiverIdentityTracker } from "../../../src/core/receiver-identity-tracker.js"
import type { ReceiverIdentity } from "../../../src/core/receiver-identity.js"

const log = pino({ level: "silent" })
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const ID = "0123456789abcdef0123456789abcdef"

function header(tunerType: number, gainCount: number): Buffer {
	const b = Buffer.alloc(12)
	b.write("RTL0", 0, "ascii")
	b.writeUInt32BE(tunerType, 4)
	b.writeUInt32BE(gainCount, 8)
	return b
}

/** A fake rtl_tcp: the header, then a little payload, then it holds the connection. */
async function fakeRtlTcp(hdr: () => Buffer) {
	const sockets = new Set<net.Socket>()
	const server = net.createServer(socket => {
		sockets.add(socket)
		socket.on("error", () => {})
		socket.on("close", () => sockets.delete(socket))
		socket.write(Buffer.concat([hdr(), Buffer.alloc(1024, 127)]))
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const port = (server.address() as net.AddressInfo).port
	cleanup.push(async () => {
		for (const s of sockets) s.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
	return {
		port,
		drop: () => {
			for (const s of sockets) s.destroy()
		},
	}
}

/** A fake sdr-host /api/status answer, switchable per test. */
function fakeSdrHost() {
	let answer: unknown = null
	let fail = false
	const fetchFn = (async () => {
		if (fail) throw new Error("unreachable")
		return {
			ok: true,
			status: 200,
			redirected: false,
			json: async () => answer,
		} as unknown as Response
	}) as unknown as typeof fetch
	return {
		fetchFn,
		answer: (body: unknown) => {
			answer = body
			fail = false
		},
		fail: () => {
			fail = true
		},
	}
}

async function setup(opts: {
	header?: () => Buffer
	sdrHost?: ReturnType<typeof fakeSdrHost>
	waitMs?: number
}) {
	const rtl = await fakeRtlTcp(opts.header ?? (() => header(5, 29)))
	const manager = new SourceManager(log)
	manager.on("error", () => {})
	let poller: SdrHostPoller | null = null
	if (opts.sdrHost) {
		poller = new SdrHostPoller(
			log,
			[{ sourceId: "rtl", apiUrl: "http://sdr-host.invalid" }],
			{ pollIntervalMs: 40, timeoutMs: 40, fetchFn: opts.sdrHost.fetchFn },
		)
		poller.on("error", () => {})
	}
	const tracker = new ReceiverIdentityTracker({
		sources: manager,
		logger: log,
		sdrHostApplies: () => poller !== null,
		sdrHostWaitMs: opts.waitMs ?? 2_000,
	})
	poller?.on("receiver-identity", (id, facts) =>
		tracker.noteSdrHostFacts(id, facts),
	)
	const events: Array<{ id: ReceiverIdentity; prev?: string }> = []
	tracker.on(
		"identity",
		(_s: string, id: ReceiverIdentity, prev?: ReceiverIdentity) =>
			events.push(prev ? { id, prev: prev.key } : { id }),
	)
	cleanup.push(async () => {
		poller?.stop()
		tracker.stop()
		await manager.disconnectAll()
	})
	return { rtl, manager, poller, tracker, events }
}

const connect = (manager: SourceManager, port: number) =>
	manager.connect({
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: 0,
		caps: {
			kind: "iq",
			sampleRate: 2_048_000,
			format: "U8_IQ",
			exclusive: false,
		},
	})

const waitFor = async (check: () => boolean, ms = 3_000) => {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

describe("ReceiverIdentityTracker", () => {
	it("identifies from the rtl_tcp header alone when no sdr-host describes the receiver", async () => {
		const { rtl, manager, tracker, events } = await setup({})
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id).toMatchObject({
			key: "model:5:29",
			strength: "model",
			tunerType: 5,
		})
		expect(tracker.provisional("rtl")?.key).toBe("model:5:29")
	})

	it("upgrades to the sdr-host's receiverId within the bounded wait: one change, never the model first", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({ receiverId: ID, dongle: { serial: "00000001" } })
		const { rtl, manager, poller, events } = await setup({ sdrHost })
		poller?.start()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id).toMatchObject({
			key: `sdrhost:${ID}`,
			strength: "unit",
			serial: "00000001",
		})
		await new Promise(resolve => setTimeout(resolve, 150))
		expect(events).toHaveLength(1)
	})

	it("settles on the model when the sdr-host does not answer in time, then upgrades once it does", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.fail()
		const { rtl, manager, poller, tracker, events } = await setup({
			sdrHost,
			waitMs: 60,
		})
		poller?.start()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id.key).toBe("model:5:29")
		sdrHost.answer({ receiverId: ID })
		// The poller backs off 2 s after its first failure, then 4 s.
		await waitFor(() => events.length === 2, 10_000)
		expect(events[1]).toMatchObject({
			id: { key: `sdrhost:${ID}` },
			prev: "model:5:29",
		})
		// A failed poll later never downgrades the settled identity within the connection.
		sdrHost.fail()
		await new Promise(resolve => setTimeout(resolve, 200))
		expect(tracker.current("rtl")?.key).toBe(`sdrhost:${ID}`)
		expect(events).toHaveLength(2)
	}, 15_000)

	it("malformed sdr-host fields are dropped: the identity stays at the model", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({
			receiverId: "../../etc/passwd",
			dongle: { vendor: "0bda", product: "2838", serial: "x/../../y" },
		})
		const { rtl, manager, poller, events } = await setup({
			sdrHost,
			waitMs: 150,
		})
		poller?.start()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id).toMatchObject({ key: "model:5:29" })
		expect(events[0]?.id.serial).toBeUndefined()
	})

	it("a header that is not RTL0 is unknown", async () => {
		const { rtl, manager, events } = await setup({
			header: () => Buffer.from("HTTP/1.1 200", "ascii"),
		})
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id).toMatchObject({
			key: "unknown",
			strength: "unknown",
		})
	})

	it("every connection boundary emits connection, and every settle emits settled (the same receiver too)", async () => {
		const { rtl, manager, tracker, events } = await setup({})
		const boundaries: string[] = []
		const settled: string[] = []
		tracker.on("connection", (id: string) => boundaries.push(id))
		tracker.on("settled", (_s: string, id: ReceiverIdentity) =>
			settled.push(id.key),
		)
		await connect(manager, rtl.port)
		await waitFor(() => settled.length === 1)
		rtl.drop()
		await waitFor(() => settled.length === 2, 10_000)
		// connected, disconnected, connected.
		expect(boundaries).toEqual(["rtl", "rtl", "rtl"])
		expect(settled).toEqual(["model:5:29", "model:5:29"])
		// "identity" still fires only on a change.
		expect(events).toHaveLength(1)
	}, 15_000)

	it("recomputes on each connection: another dongle model behind the same endpoint is a change", async () => {
		let model = 5
		const { rtl, manager, events } = await setup({
			header: () => header(model, model === 5 ? 29 : 14),
		})
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		model = 1
		rtl.drop()
		await waitFor(() => events.length === 2, 10_000)
		expect(events[1]).toMatchObject({
			id: { key: "model:1:14" },
			prev: "model:5:29",
		})
	}, 15_000)
})
