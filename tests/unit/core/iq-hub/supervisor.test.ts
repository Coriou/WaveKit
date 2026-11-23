import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SourceConfig } from "../../../../src/config.js"
import { HUB_FRONT_TAG } from "../../../../src/core/iq-hub/intake.js"
import { isHubHello } from "../../../../src/core/iq-hub/protocol.js"
import {
	HUB_CONNECT_TIMEOUT_MS,
	HubSourceIntake,
	IQHUB_EXITED,
	IQHUB_FRONT_CLOSED,
	IQHUB_HUNG,
	IQHUB_REJECTED,
	IQHUB_UNAVAILABLE,
	Supervisor,
} from "../../../../src/core/iq-hub/supervisor.js"
import type { SupervisorOptions } from "../../../../src/core/iq-hub/supervisor.js"
import {
	connectErrorClass,
	isIntakeFault,
} from "../../../../src/core/source-manager-connect-failure.js"
import { FakeHub, closeOf, collect, until } from "./fake-hub.js"

const log = pino({ level: "silent" })
const config: SourceConfig = {
	id: "rx",
	type: "rtl_tcp",
	host: "127.0.0.1",
	port: 5555,
	loop: false,
	playbackSpeed: 1,
	caps: {
		kind: "iq",
		format: "U8_IQ",
		sampleRate: 1_024_000,
		exclusive: false,
	},
} as SourceConfig

let fake: FakeHub
let supervisors: Supervisor[] = []
const sockets: net.Socket[] = []

function makeSupervisor(
	overrides: Partial<SupervisorOptions> = {},
): Supervisor {
	const supervisor = new Supervisor({
		sourceId: "rx",
		logger: log,
		factory: fake.factory,
		...overrides,
	})
	supervisors.push(supervisor)
	return supervisor
}

function hubSocket(): net.Socket {
	const socket = new net.Socket({ allowHalfOpen: true })
	sockets.push(socket)
	return socket
}

async function dialActive(supervisor: Supervisor, socket = hubSocket()) {
	const connected = new Promise<void>(resolve =>
		socket.once("connect", resolve),
	)
	const received = collect(socket)
	const closed = closeOf(socket)
	const hubReady = fake.whenSpawned(1)
	supervisor.dial(socket, config, "127.0.0.1", 5555)
	const hub = await hubReady
	const front = await hub.whenFront()
	await front.whenStarted()
	await connected
	return { socket, hub, front, received, closed }
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy()
	await Promise.all(supervisors.map(s => s.dispose()))
	supervisors = []
	await fake.cleanup()
	vi.restoreAllMocks()
})

function newFake(): FakeHub {
	fake = new FakeHub()
	return fake
}

describe("hub supervisor rows (fake hub)", () => {
	it("S1, S3, S4, S6, S9, S10: spawns, configures, connects, binds the front and replays header and payload", async () => {
		newFake()
		const supervisor = makeSupervisor()
		const { socket, hub, front, received } = await dialActive(supervisor)
		const configure = hub.requestsOf("configure")
		expect(configure).toHaveLength(1)
		expect(configure[0]).toMatchObject({
			v: 1,
			byteRate: 2_048_000,
			frameBytes: 2,
			levelFormat: null,
			progressMs: 100,
			linkGapMs: 200,
		})
		const connect = hub.requestsOf("connect")[0]
		expect(connect).toMatchObject({
			attempt: 1,
			host: "127.0.0.1",
			port: 5555,
			timeoutMs: HUB_CONNECT_TIMEOUT_MS,
			headerBytes: 12,
			keepAliveMs: 5000,
			rcvBufBytes: 5 * 1024 * 1024,
		})
		expect(hub.requestsOf("sink-open")[0]).toMatchObject({
			sink: "front-1",
			kind: "front",
			attempt: 1,
			maxLagMs: 6000,
			resumeMs: 250,
		})
		expect(supervisor.localPortOf(socket)).toBe(40_001)
		const payload = Buffer.from([1, 2, 3, 4, 5, 6])
		front.send(payload)
		await until(() => received.bytes().length === 18)
		expect(received.bytes()).toEqual(
			Buffer.concat([fake.defaultHeader, payload]),
		)
		expect(supervisor.accountingOf(socket)?.startSourcePos).toBe(0)
		expect(supervisor.pid).toBe(hub.pid)
	})

	it("S6 and m6: the hello goes first on the front and a prototype write spy can filter it", async () => {
		newFake()
		const spy = vi.spyOn(net.Socket.prototype, "write")
		const supervisor = makeSupervisor()
		const { socket, front } = await dialActive(supervisor)
		const writes = spy.mock.calls.filter(
			call => spy.mock.contexts[spy.mock.calls.indexOf(call)] === socket,
		)
		expect(writes).toHaveLength(1)
		expect(isHubHello(writes[0]?.[0])).toBe(true)
		socket.write(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x2a]))
		const commands = await front.whenCommandBytes(5)
		expect(commands).toEqual(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x2a]))
		expect(isHubHello(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x2a]))).toBe(false)
	})

	it("a hub without a required feature is refused IQHUB_UNAVAILABLE", async () => {
		newFake()
		fake.features = ["tcp-connected", "errno"]
		const supervisor = makeSupervisor()
		const socket = hubSocket()
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		const { error } = await closed
		expect(error?.code).toBe(IQHUB_UNAVAILABLE)
		expect(fake.last.signals).toContain("SIGKILL")
		expect(fake.last.requestsOf("connect")).toHaveLength(0)
	})

	it("no ready in time, and a spawn failure, are IQHUB_UNAVAILABLE", async () => {
		newFake()
		fake.noReady = true
		const supervisor = makeSupervisor({ readyTimeoutMs: 100 })
		const socket = hubSocket()
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		expect((await closed).error?.code).toBe(IQHUB_UNAVAILABLE)

		const failing = newFake()
		failing.spawnFails = true
		const other = makeSupervisor()
		const second = hubSocket()
		const secondClosed = closeOf(second)
		other.dial(second, config, "127.0.0.1", 5555)
		expect((await secondClosed).error?.code).toBe(IQHUB_UNAVAILABLE)
	})

	it("a refused configure is IQHUB_REJECTED; a second dial at another rate reconfigures", async () => {
		newFake()
		fake.configureAnswer = "reject"
		const supervisor = makeSupervisor()
		const socket = hubSocket()
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		expect((await closed).error?.code).toBe(IQHUB_REJECTED)

		newFake()
		const again = makeSupervisor({ configureWaitMs: 50 })
		const first = await dialActive(again)
		first.socket.destroy()
		await first.closed
		const second = hubSocket()
		const connected = new Promise<void>(resolve =>
			second.once("connect", resolve),
		)
		again.dial(
			second,
			{
				...config,
				caps: { ...config.caps, sampleRate: 2_400_000 },
			} as SourceConfig,
			"127.0.0.1",
			5555,
		)
		await connected
		const configures = first.hub.requestsOf("configure")
		expect(configures.map(r => r["byteRate"])).toEqual([2_048_000, 4_800_000])
	})

	it("a closed connect maps to the code a net connect gives, with and without errno", async () => {
		const cases: { reason: string; errno?: number; code: string }[] = [
			{ reason: "refused", code: "ECONNREFUSED" },
			{ reason: "unreachable", code: "EHOSTUNREACH" },
			{ reason: "timeout", code: "ETIMEDOUT" },
			{ reason: "reset", code: "ECONNRESET" },
			{ reason: "error", code: "EIO" },
			{
				reason: "refused",
				errno: os.constants.errno.ECONNREFUSED,
				code: "ECONNREFUSED",
			},
			{
				reason: "error",
				errno: os.constants.errno.ENETUNREACH,
				code: "ENETUNREACH",
			},
		]
		for (const item of cases) {
			newFake()
			fake.connectBehavior = () => ({
				kind: "refuse",
				reason: item.reason,
				...(item.errno !== undefined ? { errno: item.errno } : {}),
			})
			const supervisor = makeSupervisor()
			const socket = hubSocket()
			const closed = closeOf(socket)
			supervisor.dial(socket, config, "127.0.0.1", 5555)
			const { error, events } = await closed
			expect(error?.code).toBe(item.code)
			expect(events).toEqual(["error", "close"])
			const real = Object.assign(new Error("x"), { code: item.code })
			expect(connectErrorClass(error)).toBe(connectErrorClass(real))
			await supervisor.dispose()
			await fake.cleanup()
		}
	})

	it("a refused front sink is IQHUB_REJECTED and its attempt is aborted", async () => {
		newFake()
		fake.sinkOpenReject = "too-many-sinks"
		const supervisor = makeSupervisor()
		const socket = hubSocket()
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		expect((await closed).error?.code).toBe(IQHUB_REJECTED)
		expect(fake.last.requestsOf("abort")[0]).toMatchObject({
			attempt: 1,
			mode: "now",
		})
	})

	it("S8 (deviation): a front the hub closed on request before it started is IQHUB_FRONT_CLOSED, an intake fault", async () => {
		newFake()
		fake.connectBehavior = () => ({ kind: "accept", delayMs: 30 })
		const supervisor = makeSupervisor()
		const socket = hubSocket()
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		const hub = await fake.whenSpawned()
		await hub.whenRequest("sink-open")
		await until(() => hub.fronts.size === 1)
		hub.emit("sink-closed", {
			sink: "front-1",
			reason: "request",
			sinkBytes: 0,
		})
		const { error } = await closed
		expect(error?.code).toBe(IQHUB_FRONT_CLOSED)
		expect(isIntakeFault(error)).toBe(true)
		expect(hub.requestsOf("abort")).toHaveLength(1)
	})

	it("S8 (deviation): a started front closed by a rate change, and a refused front connection, are IQHUB_FRONT_CLOSED", async () => {
		newFake()
		const supervisor = makeSupervisor({ endWaitMs: 50 })
		const { hub, closed } = await dialActive(supervisor)
		hub.emit("sink-closed", {
			sink: "front-1",
			reason: "reconfigured",
			sinkBytes: 0,
		})
		const reconfigured = await closed
		expect(reconfigured.error?.code).toBe(IQHUB_FRONT_CLOSED)
		expect(isIntakeFault(reconfigured.error)).toBe(true)

		fake.connectBehavior = () => ({ kind: "accept", delayMs: 30 })
		const socket = hubSocket()
		const rejected = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		await hub.whenRequest("sink-open", 2)
		hub.emit("sink-rejected", { sink: "front-2", reason: "unknown" })
		const refused = await rejected
		expect(refused.error?.code).toBe(IQHUB_FRONT_CLOSED)
		expect(isIntakeFault(refused.error)).toBe(true)
	})

	it("S11 and S12: gaps are counted and placements reach the hook", async () => {
		newFake()
		const gaps: unknown[] = []
		const placements: unknown[] = []
		const supervisor = makeSupervisor({
			onIntakeGap: (_socket, event) => gaps.push(event.droppedBytes),
			onFrontPlaced: (_socket, event) => placements.push(event.atSourcePos),
		})
		const { socket, front } = await dialActive(supervisor)
		front.send(Buffer.alloc(100))
		front.gap(400)
		front.send(Buffer.alloc(50))
		front.placed(5)
		await until(() => placements.length === 1)
		expect(gaps).toEqual([400])
		expect(placements).toEqual([550])
		const accounting = supervisor.accountingOf(socket)
		expect(accounting?.droppedBytes).toBe(400)
		expect(accounting?.sinkByteOf(550)).toBe(150)
		expect(accounting?.sinkByteOf(300)).toBe(100)
	})

	it("S13, S14: an upstream eof ends the socket cleanly after the data; reset destroys with its code", async () => {
		newFake()
		const supervisor = makeSupervisor()
		const one = await dialActive(supervisor)
		one.front.send(Buffer.alloc(64, 7))
		one.front.endStream("eof")
		const first = await one.closed
		expect(first.error).toBeNull()
		expect(first.events).toEqual(["end", "close"])
		expect(one.received.bytes().length).toBe(12 + 64)
		const check = supervisor.accountingOf(one.socket)?.check(64, 64)
		expect(check?.holds).toBe(true)

		const two = hubSocket()
		const twoClosed = closeOf(two)
		const twoData = collect(two)
		supervisor.dial(two, config, "127.0.0.1", 5555)
		const front = await one.hub.whenFront()
		await front.whenStarted()
		front.send(Buffer.alloc(32, 1))
		front.endStream("reset", { errno: os.constants.errno.ECONNRESET })
		const second = await twoClosed
		expect(second.error?.code).toBe("ECONNRESET")
		// The front's FIN comes first (SourceManager has no end listener: it sees error, close).
		expect(second.events).toEqual(["end", "error", "close"])
		expect(twoData.bytes().length).toBe(12 + 32)
	})

	it("front-ended with no Node end falls back after the wait (via destroy)", async () => {
		newFake()
		const supervisor = makeSupervisor({ endWaitMs: 50 })
		const { front, closed } = await dialActive(supervisor)
		front.endStream("eof", { noFin: true })
		const result = await closed
		expect(result.error).toBeNull()
		expect(result.events).not.toContain("end")
	})

	it("Node's end before front-ended waits for it, then follows its decision", async () => {
		newFake()
		const supervisor = makeSupervisor({ endWaitMs: 1000 })
		const { front, closed } = await dialActive(supervisor)
		front.hub.closeAttempt(
			front.attempt,
			"adopted",
			"reset",
			os.constants.errno.ECONNRESET,
		)
		front.socket?.end()
		await new Promise(resolve => setTimeout(resolve, 50))
		front.frontEnded("reset", os.constants.errno.ECONNRESET)
		const result = await closed
		expect(result.error?.code).toBe("ECONNRESET")
		expect(result.events).toEqual(["end", "error", "close"])
	})

	it("Node's end with no front-ended within the wait destroys with ECONNRESET", async () => {
		newFake()
		const supervisor = makeSupervisor({ endWaitMs: 60 })
		const { front, closed } = await dialActive(supervisor)
		front.socket?.end()
		const started = Date.now()
		const result = await closed
		expect(Date.now() - started).toBeGreaterThanOrEqual(50)
		expect(result.error?.code).toBe("ECONNRESET")
	})

	it("SourceManager's end reaches the hub as the front's EOF, the commands first", async () => {
		newFake()
		const supervisor = makeSupervisor()
		const { socket, front, closed } = await dialActive(supervisor)
		socket.write(Buffer.from([0x02, 0, 0, 0, 1]))
		socket.end()
		await front.whenEof()
		expect(front.commandBytes).toEqual(Buffer.from([0x02, 0, 0, 0, 1]))
		const result = await closed
		expect(result.error).toBeNull()
	})

	it("a destroyed socket whose attempt stays live is aborted after the belt-and-braces wait", async () => {
		newFake()
		fake.ignoreFrontEof = true
		const supervisor = makeSupervisor({ abortAfterCloseMs: 50 })
		const { socket, hub, closed } = await dialActive(supervisor)
		socket.destroy()
		await closed
		expect(hub.requestsOf("abort")).toHaveLength(0)
		await hub.whenRequest("abort")
		expect(hub.requestsOf("abort")[0]).toMatchObject({
			attempt: 1,
			mode: "now",
		})
	})

	it("a dial cancelled before its connect was sent sends nothing", async () => {
		newFake()
		fake.readyDelayMs = 50
		const supervisor = makeSupervisor()
		const socket = hubSocket()
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		const hub = await fake.whenSpawned()
		socket.destroy()
		await closed
		await new Promise(resolve => setTimeout(resolve, 150))
		expect(hub.requestsOf("connect")).toHaveLength(0)
	})

	it("a dial cancelled after its connect, before the Unix connect, aborts now and never connects", async () => {
		newFake()
		fake.connectBehavior = () => ({ kind: "accept", delayMs: 80 })
		const supervisor = makeSupervisor()
		const socket = hubSocket()
		const connectSpy = vi.spyOn(socket, "connect")
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		const hub = await fake.whenSpawned()
		await hub.whenRequest("sink-open")
		socket.destroy()
		await closed
		const abort = await hub.whenRequest("abort")
		expect(abort).toMatchObject({ attempt: 1, mode: "now" })
		await new Promise(resolve => setTimeout(resolve, 120))
		expect(connectSpy).not.toHaveBeenCalled()
		expect(hub.fronts.get("front-1")?.socket).toBeNull()
	})

	it("a hub exit mid-stream destroys with IQHUB_EXITED after the data; the next dial respawns", async () => {
		newFake()
		const supervisor = makeSupervisor()
		const { hub, front, closed, received } = await dialActive(supervisor)
		front.send(Buffer.alloc(40, 3))
		await until(() => received.bytes().length === 52)
		hub.kill("SIGKILL")
		const result = await closed
		expect(result.error?.code).toBe(IQHUB_EXITED)
		const next = hubSocket()
		const connected = new Promise<void>(resolve =>
			next.once("connect", resolve),
		)
		supervisor.dial(next, config, "127.0.0.1", 5555)
		const second = await fake.whenSpawned(2)
		await connected
		expect(second.pid).not.toBe(hub.pid)
		expect(supervisor.pid).toBe(second.pid)
		expect(second.requestsOf("connect")[0]?.["attempt"]).toBeGreaterThan(1)
	})

	it("a stopped hub is killed by its handle and the dial fails IQHUB_HUNG", async () => {
		newFake()
		const supervisor = makeSupervisor({
			watchdog: { hungAfterMs: 200, checkEveryMs: 20 },
		})
		const { hub, closed } = await dialActive(supervisor)
		hub.stop()
		const result = await closed
		expect(result.error?.code).toBe(IQHUB_HUNG)
		expect(hub.signals).toEqual(["SIGKILL"])
	})

	it("a live hub that keeps sending progress is never killed", async () => {
		newFake()
		const supervisor = makeSupervisor({
			watchdog: { hungAfterMs: 200, checkEveryMs: 20 },
		})
		const { hub } = await dialActive(supervisor)
		await new Promise(resolve => setTimeout(resolve, 500))
		expect(hub.signals).toEqual([])
	})

	it("too many attempts aborts the source's older attempts and retries once; a second refusal is IQHUB_REJECTED", async () => {
		newFake()
		let refusals = 1
		fake.connectBehavior = attempt =>
			attempt === 2 && refusals-- > 0
				? { kind: "reject", reason: "too-many-attempts" }
				: { kind: "accept" }
		fake.ignoreFrontEof = true
		const supervisor = makeSupervisor()
		const first = await dialActive(supervisor)
		const second = hubSocket()
		const connected = new Promise<void>(resolve =>
			second.once("connect", resolve),
		)
		supervisor.dial(second, config, "127.0.0.1", 5555)
		await connected
		const aborts = first.hub.requestsOf("abort")
		expect(aborts[0]).toMatchObject({ attempt: 1, mode: "now" })
		const connects = first.hub.requestsOf("connect").map(r => r["attempt"])
		expect(connects).toEqual([1, 2, 3])

		fake.connectBehavior = () => ({
			kind: "reject",
			reason: "too-many-attempts",
		})
		const third = hubSocket()
		const thirdClosed = closeOf(third)
		supervisor.dial(third, config, "127.0.0.1", 5555)
		expect((await thirdClosed).error?.code).toBe(IQHUB_REJECTED)
	})

	it("dispose shuts the hub down and removes its socket dir; a hub ignoring it is killed", async () => {
		newFake()
		const supervisor = makeSupervisor()
		const { hub } = await dialActive(supervisor)
		await supervisor.dispose()
		expect(hub.requestsOf("shutdown")).toHaveLength(1)
		expect(hub.exited).toBe(true)
		expect(fs.existsSync(hub.socketDir)).toBe(false)

		newFake()
		fake.ignoreShutdown = true
		const stubborn = makeSupervisor({ shutdownWaitMs: 50 })
		const other = await dialActive(stubborn)
		await stubborn.dispose()
		expect(other.hub.signals).toContain("SIGKILL")
		expect(fs.existsSync(other.hub.socketDir)).toBe(false)
	})

	it("a ready line that waits behind a main-thread stall is read before the ready deadline acts", async () => {
		newFake()
		fake.readyDelayMs = 150
		const supervisor = makeSupervisor({ readyTimeoutMs: 150 })
		const socket = hubSocket()
		const closed = closeOf(socket)
		const connected = new Promise<void>(resolve =>
			socket.once("connect", resolve),
		)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		const hub = await fake.whenSpawned()
		// Both deadlines pass during the stall; the supervisor's fires first in the timers phase.
		const stallEnd = performance.now() + 400
		while (performance.now() < stallEnd) {
			/* a main-thread stall */
		}
		await connected
		expect(hub.signals).toEqual([])
		expect(socket.destroyed).toBe(false)
		socket.destroy()
		await closed
	})

	it("a hub that connects upstream but never answers sink-open is failed IQHUB_HUNG by the connect backstop", async () => {
		newFake()
		fake.sinkOpenSilent = true
		const supervisor = makeSupervisor({ connectGraceMs: 0 })
		const socket = hubSocket()
		const closed = closeOf(socket)
		const started = performance.now()
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		const result = await closed
		expect(result.error?.code).toBe(IQHUB_HUNG)
		expect(performance.now() - started).toBeGreaterThanOrEqual(4900)
		// tcp-connected came (the backstop outlived it) and the attempt is aborted.
		expect(fake.last.requestsOf("sink-open")).toHaveLength(1)
		expect(fake.last.requestsOf("abort")).toHaveLength(1)
	}, 15_000)

	it("a hub that never answers configure is still failed IQHUB_HUNG after the recheck", async () => {
		newFake()
		fake.configureAnswer = "silent"
		const supervisor = makeSupervisor({ readyTimeoutMs: 100 })
		const socket = hubSocket()
		const closed = closeOf(socket)
		supervisor.dial(socket, config, "127.0.0.1", 5555)
		expect((await closed).error?.code).toBe(IQHUB_HUNG)
		expect(fake.last.signals).toContain("SIGKILL")
	})

	it("a paused socket holds its end up to the cap in all, then it is destroyed", async () => {
		newFake()
		let clock = 0
		const supervisor = makeSupervisor({
			endWaitMs: 20,
			pausedEndCapMs: 1000,
			now: () => clock,
		})
		const { socket, front, closed } = await dialActive(supervisor)
		socket.pause()
		front.send(Buffer.alloc(64, 1))
		front.endStream("eof")
		await until(() => supervisor.accountingOf(socket)?.end != null)
		clock = 999
		await new Promise(resolve => setTimeout(resolve, 120))
		expect(socket.destroyed).toBe(false)
		clock = 1000
		const result = await closed
		expect(result.error).toBeNull()
		expect(result.events).not.toContain("end")
	})

	it("a hub exit after front-ended keeps the stream's clean end", async () => {
		newFake()
		const supervisor = makeSupervisor({ endWaitMs: 2000 })
		const { socket, hub, front, closed, received } =
			await dialActive(supervisor)
		front.send(Buffer.alloc(32, 2))
		await until(() => received.bytes().length === 12 + 32)
		socket.pause()
		front.endStream("eof", { noFin: true })
		await until(() => supervisor.accountingOf(socket)?.end != null)
		hub.kill("SIGKILL")
		await until(() => supervisor.pid === null)
		socket.resume()
		const result = await closed
		expect(result.error).toBeNull()
		expect(result.events).toEqual(["end", "close"])
	})

	it("dispose waits for a still-starting child: killed by its handle, its socket dir removed", async () => {
		newFake()
		fake.noReady = true
		const intake = new HubSourceIntake({
			logger: log,
			factory: fake.factory,
			supervisor: { readyTimeoutMs: 60_000 },
		})
		const socket = intake.create("rx", config, "127.0.0.1", 5555)
		sockets.push(socket)
		socket.on("error", () => {})
		intake.connect(socket, "rx", config, "127.0.0.1", 5555)
		expect(fake.instances).toHaveLength(0)
		await intake.disposeAll()
		const hub = fake.last
		expect(hub.exited).toBe(true)
		expect(hub.signals).toContain("SIGKILL")
		expect(fs.existsSync(hub.socketDir)).toBe(false)
	})

	it("ignores invalid event lines without logging their content", async () => {
		newFake()
		const supervisor = makeSupervisor()
		const { hub, front, received } = await dialActive(supervisor)
		hub.emitRaw("not json")
		hub.emitRaw(
			JSON.stringify({ v: 1, type: "front-placed", mono: 1, sink: "front-1" }),
		)
		hub.emitRaw(JSON.stringify({ v: 2, type: "progress", mono: 1 }))
		front.send(Buffer.alloc(2))
		await until(() => received.bytes().length === 14)
		expect(supervisor.invalidLines).toBe(3)
	})
})

describe("HubSourceIntake", () => {
	it("a host name keeps the socket path; an IP literal gets a tagged half-open front socket", () => {
		newFake()
		const intake = new HubSourceIntake({ logger: log, factory: fake.factory })
		const named = intake.create("rx", config, "receiver.local", 5555)
		sockets.push(named)
		expect(named.allowHalfOpen).toBe(false)
		expect(Reflect.get(named, HUB_FRONT_TAG)).toBeUndefined()
		const connect = vi.spyOn(named, "connect").mockImplementation(() => named)
		intake.connect(named, "rx", config, "receiver.local", 5555)
		expect(connect).toHaveBeenCalledWith(5555, "receiver.local")
		expect(intake.supervisor("rx")).toBeUndefined()

		const ip = intake.create("rx", config, "::1", 5555)
		sockets.push(ip)
		expect(ip.allowHalfOpen).toBe(true)
		expect(Reflect.get(ip, HUB_FRONT_TAG)).toBe("rx")

		const audio = intake.create(
			"pcm",
			{ ...config, type: "sdrpp_audio" } as unknown as SourceConfig,
			"127.0.0.1",
			5555,
		)
		sockets.push(audio)
		expect(audio.allowHalfOpen).toBe(false)
	})

	it("dispose drops the supervisor synchronously; a re-added id gets a new hub", async () => {
		newFake()
		const intake = new HubSourceIntake({ logger: log, factory: fake.factory })
		const first = intake.create("rx", config, "127.0.0.1", 5555)
		sockets.push(first)
		const connected = new Promise<void>(resolve =>
			first.once("connect", resolve),
		)
		intake.connect(first, "rx", config, "127.0.0.1", 5555)
		await connected
		const supervisor = intake.supervisor("rx")
		expect(intake.localPortOf(first)).toBe(40_001)
		first.destroy()
		intake.dispose("rx")
		expect(intake.supervisor("rx")).toBeUndefined()
		const second = intake.create("rx", config, "127.0.0.1", 5555)
		sockets.push(second)
		const again = new Promise<void>(resolve => second.once("connect", resolve))
		intake.connect(second, "rx", config, "127.0.0.1", 5555)
		await again
		expect(intake.supervisor("rx")).not.toBe(supervisor)
		expect(fake.instances).toHaveLength(2)
		second.destroy()
		await intake.disposeAll()
		expect(fake.instances.every(hub => hub.exited)).toBe(true)
	})
})
