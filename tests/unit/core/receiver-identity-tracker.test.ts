/**
 * Receiver identity per connection, on production wiring: a real SourceManager against
 * an in-process fake rtl_tcp on an ephemeral loopback port, and a real SdrHostPoller whose fetch
 * is a fake sdr-host status provider (no request leaves the process).
 */
import * as net from "node:net"
import { EventEmitter, once } from "node:events"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { SourceManager } from "../../../src/core/source-manager.js"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import {
	RECEIVER_SDR_HOST_WAIT_MS,
	ReceiverIdentityTracker,
	receiverSdrHostWaitMs,
} from "../../../src/core/receiver-identity-tracker.js"
import type { ReceiverIdentity } from "../../../src/core/receiver-identity.js"

const log = pino({ level: "silent" })
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const ID = "0123456789abcdef0123456789abcdef"
const UNIT = "fedcba9876543210fedcba9876543210"
const UNIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const WEAK = "source:rtl|model:5:29"

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

/**
 * A fake sdr-host status provider, switchable per test: `/api/status` answers `answer` (or fails),
 * `/api/host` answers at once or, with `hangHost`, only when its request is aborted.
 */
function fakeSdrHost() {
	let answer: unknown = null
	let fail = false
	let hangHost = false
	let statusRequests = 0
	const fetchFn = (async (url: string, init?: { signal?: AbortSignal }) => {
		if (String(url).endsWith("/api/host") && hangHost)
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				),
			)
		if (String(url).endsWith("/api/status")) statusRequests++
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
		hangHost: () => {
			hangHost = true
		},
		statusRequests: () => statusRequests,
	}
}

async function setup(opts: {
	header?: () => Buffer
	sdrHost?: ReturnType<typeof fakeSdrHost>
	waitMs?: number
	pollIntervalMs?: number
	timeoutMs?: number
}) {
	const rtl = await fakeRtlTcp(opts.header ?? (() => header(5, 29)))
	const manager = new SourceManager(log)
	manager.on("error", () => {})
	let poller: SdrHostPoller | null = null
	if (opts.sdrHost) {
		poller = new SdrHostPoller(
			log,
			[{ sourceId: "rtl", apiUrl: "http://sdr-host.invalid" }],
			{
				pollIntervalMs: opts.pollIntervalMs ?? 40,
				timeoutMs: opts.timeoutMs ?? 40,
				fetchFn: opts.sdrHost.fetchFn,
			},
		)
		poller.on("error", () => {})
	}
	// The production wiring (src/index.ts): kick a poll per connection, wait on its result.
	const tracker = new ReceiverIdentityTracker({
		sources: manager,
		logger: log,
		sdrHostApplies: () => poller !== null,
		sdrHostWaitMs: opts.waitMs ?? 2_000,
		kickSdrHostPoll: id => poller?.pollNow(id),
	})
	poller?.on("identity-result", (id, result) =>
		tracker.noteSdrHostResult(id, result),
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
			key: WEAK,
			strength: "model",
			tunerType: 5,
		})
		expect(tracker.provisional("rtl")?.key).toBe(WEAK)
	})

	it("settles on the sdr-host's unit id: one change, never the model first", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({
			unitId: UNIT,
			receiverId: ID,
			dongle: { serial: "00000001" },
		})
		const { rtl, manager, poller, events } = await setup({ sdrHost })
		poller?.start()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id).toMatchObject({
			key: `unit:${UNIT}`,
			strength: "unit",
			serial: "00000001",
			receiverId: ID,
		})
		await new Promise(resolve => setTimeout(resolve, 150))
		expect(events).toHaveLength(1)
	})

	it("an sdr-host restart (new receiverId, same unitId) is the same receiver on the next connection", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({ unitId: UNIT, receiverId: ID })
		const { rtl, manager, poller, tracker, events } = await setup({ sdrHost })
		const settled: string[] = []
		tracker.on("settled", (_s: string, id: ReceiverIdentity) =>
			settled.push(id.key),
		)
		poller?.start()
		await connect(manager, rtl.port)
		await waitFor(() => settled.length === 1)
		sdrHost.answer({ unitId: UNIT, receiverId: "1".repeat(32) })
		rtl.drop()
		await waitFor(() => settled.length === 2, 10_000)
		expect(settled).toEqual([`unit:${UNIT}`, `unit:${UNIT}`])
		expect(tracker.current("rtl")?.receiverId).toBe("1".repeat(32))
		expect(events).toHaveLength(1)
	}, 15_000)

	it("a failed sdr-host poll ends the wait at once (event-driven, not the bound): the source-scoped model", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.fail()
		const { rtl, manager, poller, events } = await setup({
			sdrHost,
			// A bound far beyond the test: only the failure result can settle it in time.
			waitMs: 60_000,
		})
		poller?.start()
		const t0 = Date.now()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(Date.now() - t0).toBeLessThan(2_000)
		expect(events[0]?.id.key).toBe(WEAK)
	})

	it("an old sdr-host without unitId answers: the source-scoped model, at once", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({ receiverId: ID, dongle: { serial: "00000001" } })
		const { rtl, manager, poller, events } = await setup({
			sdrHost,
			waitMs: 60_000,
		})
		poller?.start()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id).toMatchObject({ key: WEAK, receiverId: ID })
	})

	it("a boot poll answered before the connection is not used: the connection kicks a fresh poll", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({ unitId: UNIT })
		const { rtl, manager, poller, events } = await setup({
			sdrHost,
			// No scheduled poll for a minute: only the kick can answer in time.
			pollIntervalMs: 60_000,
			waitMs: 60_000,
		})
		poller?.start()
		await waitFor(() => sdrHost.statusRequests() === 1)
		await new Promise(resolve => setTimeout(resolve, 20))
		// Another unit behind the endpoint since the boot poll.
		sdrHost.answer({ unitId: UNIT_B })
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id.key).toBe(`unit:${UNIT_B}`)
		expect(sdrHost.statusRequests()).toBeGreaterThanOrEqual(2)
	})

	it("the identity is emitted before the poll's /api/host request ends", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({ unitId: UNIT })
		sdrHost.hangHost()
		const { rtl, manager, poller, events } = await setup({
			sdrHost,
			pollIntervalMs: 60_000,
			// /api/host hangs until this timeout aborts it.
			timeoutMs: 5_000,
			waitMs: 60_000,
		})
		poller?.start()
		const t0 = Date.now()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1, 4_000)
		expect(Date.now() - t0).toBeLessThan(4_000)
		expect(events[0]?.id.key).toBe(`unit:${UNIT}`)
	}, 15_000)

	it("settles on the model at the hard bound when no result comes, then upgrades once one does", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.fail()
		const { rtl, manager, poller, tracker, events } = await setup({
			sdrHost,
			waitMs: 60,
		})
		poller?.start()
		await connect(manager, rtl.port)
		await waitFor(() => events.length === 1)
		expect(events[0]?.id.key).toBe(WEAK)
		sdrHost.answer({ unitId: UNIT })
		// The poller backs off 2 s after its first failure, then 4 s.
		await waitFor(() => events.length === 2, 10_000)
		expect(events[1]).toMatchObject({
			id: { key: `unit:${UNIT}` },
			prev: WEAK,
		})
		// A failed poll later never downgrades the settled identity within the connection.
		sdrHost.fail()
		await new Promise(resolve => setTimeout(resolve, 200))
		expect(tracker.current("rtl")?.key).toBe(`unit:${UNIT}`)
		expect(events).toHaveLength(2)
	}, 15_000)

	it("malformed sdr-host fields are dropped: the identity stays at the model", async () => {
		const sdrHost = fakeSdrHost()
		sdrHost.answer({
			unitId: "../../etc/passwd",
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
		expect(events[0]?.id).toMatchObject({ key: WEAK })
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
		expect(settled).toEqual([WEAK, WEAK])
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
			id: { key: "source:rtl|model:1:14" },
			prev: WEAK,
		})
	}, 15_000)
})

describe("ReceiverIdentityTracker: the connection epoch rule", () => {
	function bare() {
		const sources = new EventEmitter()
		let now = 1_000
		const kicks: string[] = []
		const tracker = new ReceiverIdentityTracker({
			sources: sources as never,
			logger: log,
			sdrHostApplies: () => true,
			sdrHostWaitMs: 60_000,
			kickSdrHostPoll: id => kicks.push(id),
			now: () => now,
		})
		const settled: string[] = []
		tracker.on("settled", (_s: string, id: ReceiverIdentity) =>
			settled.push(id.key),
		)
		cleanup.push(() => tracker.stop())
		return {
			sources,
			tracker,
			kicks,
			settled,
			at: (t: number) => {
				now = t
			},
		}
	}
	const HDR = { magic: "RTL0", tunerType: 5, gainCount: 29 }

	it("a result whose poll started before the connection opened is ignored; one at or after it settles", () => {
		const { sources, tracker, kicks, settled, at } = bare()
		at(2_000)
		sources.emit("connected", "rtl")
		expect(kicks).toEqual(["rtl"])
		sources.emit("rtl-tcp-header", "rtl", HDR)
		// Started 1 ms before the connect, answered after it: another connection's epoch.
		tracker.noteSdrHostResult("rtl", {
			startedAt: 1_999,
			ok: true,
			facts: { unitId: UNIT },
		})
		expect(settled).toEqual([])
		// Exactly at the connect: this connection's.
		tracker.noteSdrHostResult("rtl", {
			startedAt: 2_000,
			ok: true,
			facts: { unitId: UNIT_B },
		})
		expect(settled).toEqual([`unit:${UNIT_B}`])
	})

	it("a result before the header waits for it, then settles at the header", () => {
		const { sources, tracker, settled, at } = bare()
		at(5_000)
		sources.emit("connected", "rtl")
		tracker.noteSdrHostResult("rtl", {
			startedAt: 5_001,
			ok: false,
			facts: null,
		})
		expect(settled).toEqual([])
		sources.emit("rtl-tcp-header", "rtl", HDR)
		expect(settled).toEqual([WEAK])
	})

	it("the hard bound is 3 request timeouts plus 1 s", () => {
		expect(receiverSdrHostWaitMs(2_000)).toBe(7_000)
		expect(RECEIVER_SDR_HOST_WAIT_MS).toBe(7_000)
	})
})
