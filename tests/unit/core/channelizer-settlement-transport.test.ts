import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { Socket } from "node:net"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	SettlementTransport,
	parseSettlementFrame,
} from "../../../src/core/channelizer/settlement-transport.js"
import {
	SettlementRegistry,
	ObservedPermitLedger,
} from "../../../src/core/channelizer/settlement-observer.js"
import type { ProcessClaim } from "../../../src/core/channelizer/settlement-observer.js"
import type { ChannelProvider } from "../../../src/core/channelizer/types.js"

const mocks = vi.hoisted(() => ({
	server: undefined as unknown,
	chmod: vi.fn(),
	unlink: vi.fn(),
	rmdir: vi.fn(),
}))
vi.mock("node:net", () => ({
	createServer: vi.fn(
		(_options: unknown, listener: (socket: Socket) => void) => {
			const server = mocks.server as FakeServer
			server.on("connection", listener)
			return server
		},
	),
}))
vi.mock("node:os", () => ({ tmpdir: () => "/tmp" }))
vi.mock("node:fs/promises", () => ({
	mkdtemp: vi.fn(() => Promise.resolve("/tmp/wks-owned")),
	mkdir: vi.fn(() => Promise.resolve()),
	chmod: mocks.chmod,
	lstat: vi.fn((path: string) =>
		Promise.resolve({
			dev: 1,
			ino: path.endsWith("ack.sock") ? 3 : path.endsWith("observer") ? 2 : 1,
			uid: process.getuid?.(),
			mode: path.endsWith("ack.sock") ? 0o600 : 0o700,
			isDirectory: () => !path.endsWith("ack.sock"),
			isSocket: () => path.endsWith("ack.sock"),
			isSymbolicLink: () => false,
		}),
	),
	unlink: mocks.unlink,
	rmdir: mocks.rmdir,
}))

class FakeSocket extends EventEmitter {
	readonly chunks: Buffer[] = []
	readonly reads: number[] = []
	destroyed = false
	deferClose = false
	get readableLength(): number {
		return this.chunks[0]?.length ?? 0
	}
	read(size: number): Buffer | null {
		this.reads.push(size)
		const first = this.chunks[0]
		if (!first) return null
		const out = first.subarray(0, size)
		if (out.length === first.length) this.chunks.shift()
		else this.chunks[0] = first.subarray(size)
		return out
	}
	feed(bytes: Buffer | string): void {
		this.chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
		this.emit("readable")
	}
	destroy(): this {
		this.destroyed = true
		if (!this.deferClose) this.emit("close")
		return this
	}
}
class FakeServer extends EventEmitter {
	listening = false
	closing = false
	readonly sockets = new Set<FakeSocket>()
	listen(): this {
		this.listening = true
		queueMicrotask(() => this.emit("listening"))
		return this
	}
	close(callback?: (error?: Error) => void): this {
		this.listening = false
		this.closing = true
		if (!this.sockets.size) {
			this.emit("close")
			callback?.()
		} else this.once("close", () => callback?.())
		return this
	}
	connect(socket: FakeSocket): void {
		this.sockets.add(socket)
		socket.once("close", () => {
			this.sockets.delete(socket)
			if (this.closing && !this.sockets.size) this.emit("close")
		})
		this.emit("connection", socket)
	}
}
class ProviderEmitter extends EventEmitter {
	override off(
		event: string | symbol,
		listener: (...args: never[]) => void,
	): this {
		return super.off(event, listener as (...args: unknown[]) => void)
	}
}

const request = {
	centerHz: 100e6,
	bandwidthHz: 16_000,
	transitionHz: 4000,
	outputRateHz: 48_000,
	format: "cf32",
} as const
const caps = {
	kind: "iq",
	format: "U8_IQ",
	sampleRate: 2_048_000,
	centerFreq: 100e6,
	exclusive: false,
} as const
function processOwner() {
	const registry = new SettlementRegistry(),
		lifetime = registry.registerProviderLifetime()!,
		observer = registry.createObserver(lifetime)
	const handle = observer.allocateAcquisition({
		activation: "decoder",
		sourceId: "s",
		decoderId: "d",
		scannerAttempt: {},
		expectedRequest: request,
		expectedInputCaps: caps,
	})!
	const ledger = new ObservedPermitLedger(
		{ cpu: 100, bytes: 100 },
		{ cpu: 0, bytes: 0 },
	)
	const costs = Array.from({ length: 6 }, () => ({ cpu: 1, bytes: 1 }))
	handle.attachPermit(
		ledger.prepareObservedPermit(handle.requestToken, costs, costs, {
			decoder: { cpu: 1, bytes: 1 },
			classifier: { cpu: 1, bytes: 1 },
			analog: { cpu: 1, bytes: 1 },
		})!,
	)
	const underlying = Object.assign(new ProviderEmitter(), {
		requestChannel: vi.fn(
			(_source: string, _decoder: string, actual: typeof request) => {
				observer.takeAcquisition("s", "d", actual)
				return Promise.resolve({
					ok: false,
					reasonCode: "channelizer-unavailable",
					detail: "held",
				} as const)
			},
		),
		releaseChannel: () => Promise.resolve(),
		currentGeneration: () => 1,
	}) as ChannelProvider
	handle.arm()
	void observer.bindProvider(underlying).requestChannel("s", "d", request, caps)
	const tx = observer.tryReserveObservedTransaction(handle)!
	const owner = observer.claimProcess(tx, {
		sourceId: "s",
		generation: 1,
		sampleRateHz: caps.sampleRate,
		centerHz: caps.centerFreq,
	})!
	const dispose = vi.spyOn(observer, "recordDisposed").mockReturnValue(true)
	const sealed = vi.spyOn(observer, "sealAdmission")
	return { owner, observer, registry, handle, tx, dispose, sealed }
}
function ownedChild(owner: ProcessClaim): ChildProcess {
	const child = Object.assign(new EventEmitter(), { pid: 42 }) as ChildProcess
	owner.beginSpawn()
	owner.recordReturnedChild(child)
	owner.recordStartSettled()
	return child
}
const hello = (transport: SettlementTransport, pid = "42") =>
	`{"v":1,"type":"hello","nonce":"${transport.nonce.toString("hex")}","pid":"${pid}"}\n`
const disposal = (token = "1", id = "a") =>
	`{"v":1,"type":"disposed","token":"${token}","id":"${id}"}\n`
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

beforeEach(() => {
	mocks.server = new FakeServer()
	mocks.chmod.mockReset().mockResolvedValue(undefined)
	mocks.unlink.mockReset().mockResolvedValue(undefined)
	mocks.rmdir.mockReset().mockResolvedValue(undefined)
})

describe("canonical settlement frame boundary", () => {
	it("accepts exact worst-case ASCII frames and rejects alternate identity spelling", () => {
		const worst = disposal("18446744073709551615", "x".repeat(64))
		expect(Buffer.byteLength(worst)).toBe(129)
		expect(parseSettlementFrame(Buffer.from(worst))).toMatchObject({
			type: "disposed",
			token: "18446744073709551615",
		})
		for (const line of [
			disposal("01"),
			disposal("18446744073709551616"),
			disposal("0"),
			disposal("1", "é"),
			disposal().replace('"id":"a"', '"id":"\\u0061"'),
			disposal().replace('"v":1', '"v":1,"v":1'),
			disposal().replace('"v":1', '"v":1,"extra":true'),
			disposal().replace("\n", "\r\n"),
			disposal().trimEnd(),
			" ".repeat(256) + "\n",
		])
			expect(parseSettlementFrame(Buffer.from(line))).toBeUndefined()
	})
})

describe("owned nonflowing settlement transport", () => {
	it("waits for both ready and authenticated short idle hello, with fresh confined permissions", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		expect(Buffer.byteLength(t.socketPath)).toBeLessThanOrEqual(90)
		expect(mocks.chmod).toHaveBeenCalledWith("/tmp/wks-owned", 0o700)
		expect(mocks.chmod).toHaveBeenCalledWith(t.socketPath, 0o600)
		t.assignChild(ownedChild(s.owner))
		const socket = new FakeSocket()
		;(mocks.server as FakeServer).connect(socket)
		let authenticated = false
		void t.authenticated.then(() => {
			authenticated = true
		})
		socket.feed(hello(t))
		await Promise.resolve()
		expect(authenticated).toBe(false)
		expect(socket.reads).toEqual([Buffer.byteLength(hello(t))])
		t.markReady("attempt-disposal-v1")
		await t.authenticated
		socket.feed(disposal())
		expect(s.dispose).toHaveBeenCalledWith(s.owner, "1", "a")
		expect(socket.listenerCount("data")).toBe(0)
		await t.cleanup()
	})

	it("authenticates ready-first, rejects foreign first and duplicate callbacks without fencing healthy A", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const server = mocks.server as FakeServer
		const foreign = new FakeSocket()
		server.connect(foreign)
		foreign.feed(hello(t, "99"))
		expect(foreign.destroyed).toBe(true)
		const a = new FakeSocket(),
			b = new FakeSocket(),
			c = new FakeSocket()
		b.deferClose = true
		c.deferClose = true
		server.connect(a)
		server.connect(b)
		server.connect(c)
		a.feed(hello(t))
		await t.authenticated
		b.emit("error", new Error("rejected error"))
		c.emit("end")
		b.emit("close")
		c.emit("close")
		const duplicate = new FakeSocket()
		server.connect(duplicate)
		duplicate.emit("error", new Error("duplicate error"))
		a.feed(disposal())
		expect(s.dispose).toHaveBeenCalledTimes(1)
		expect(s.sealed).not.toHaveBeenCalled()
		expect(a.destroyed).toBe(false)
		await t.cleanup()
	})

	it("drains every byte split without treating partial UTF8/escaped/EOF bytes as proof", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const server = mocks.server as FakeServer,
			bad = new FakeSocket()
		server.connect(bad)
		bad.feed(Buffer.from([0xc3]))
		bad.feed(Buffer.from([0xa9, 10]))
		expect(bad.destroyed).toBe(true)
		expect(s.sealed).not.toHaveBeenCalled()
		const a = new FakeSocket()
		server.connect(a)
		for (const byte of Buffer.from(hello(t))) a.feed(Buffer.from([byte]))
		await t.authenticated
		for (const byte of Buffer.from(disposal())) a.feed(Buffer.from([byte]))
		expect(s.dispose).toHaveBeenCalledTimes(1)
		a.feed('{"v":1,"type":"disposed"')
		a.emit("end")
		expect(s.dispose).toHaveBeenCalledTimes(1)
		expect(s.sealed).toHaveBeenCalledTimes(1)
		await t.cleanup()
	})

	it("bounds eight pulls and one continuation; rejected B's queued work cannot publish after A wins", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const server = mocks.server as FakeServer,
			a = new FakeSocket(),
			b = new FakeSocket()
		server.connect(a)
		server.connect(b)
		b.deferClose = true
		for (const byte of Buffer.from(hello(t))) b.chunks.push(Buffer.from([byte]))
		b.emit("readable")
		expect(b.reads).toHaveLength(8)
		b.emit("readable")
		b.emit("readable")
		expect(b.reads).toHaveLength(8)
		a.feed(hello(t))
		await t.authenticated
		await nextTurn()
		expect(b.reads).toHaveLength(8)
		b.emit("close")
		expect(s.sealed).not.toHaveBeenCalled()
		for (let i = 0; i < 12; i++)
			a.chunks.push(Buffer.from(disposal(String(i + 1))))
		const before = a.reads.length
		a.emit("readable")
		expect(a.reads.length - before).toBe(8)
		a.emit("readable")
		expect(a.reads.length - before).toBe(8)
		await nextTurn()
		expect(a.reads.length - before).toBe(12)
		expect(a.reads.every(size => size > 0 && size <= 256)).toBe(true)
		await t.cleanup()
	})

	it("retains the four-candidate bound and one overflow lane until actual close", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		const server = mocks.server as FakeServer
		const sockets = Array.from({ length: 5 }, () => {
			const socket = new FakeSocket()
			socket.deferClose = true
			server.connect(socket)
			return socket
		})
		expect(sockets.every(socket => socket.destroyed)).toBe(true)
		await expect(t.authenticated).rejects.toThrow("candidate capacity")
		expect(
			s.registry
				.snapshot()
				.processes[0]!.locals.filter(x => x.kind === "candidate"),
		).toHaveLength(5)
		const late = new FakeSocket()
		server.connect(late)
		expect(
			s.registry
				.snapshot()
				.processes[0]!.locals.filter(x => x.kind === "candidate"),
		).toHaveLength(5)
		for (const socket of sockets) socket.emit("close")
		await t.cleanup()
	})

	it("accepted malformed or wrong proof seals once; old callbacks cannot fence successor V", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const a = new FakeSocket()
		;(mocks.server as FakeServer).connect(a)
		a.feed(hello(t))
		await t.authenticated
		s.dispose.mockReturnValue(false)
		a.feed(disposal("1", "wrong"))
		a.emit("error", new Error("old error"))
		a.emit("close")
		expect(s.sealed).toHaveBeenCalledTimes(1)
		const successorRegistry = s.registry,
			successorV = successorRegistry.registerProviderLifetime()!,
			successor = successorRegistry.createObserver(successorV)
		a.emit("readable")
		a.emit("end")
		expect(successor.snapshot().admissionSealed).toBe(false)
		await t.cleanup()
	})
})

describe("bounded transport tail and startup ownership schedules", () => {
	it("counts eight total admissions independently of concurrent candidate cleanup", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		const server = mocks.server as FakeServer
		for (let i = 0; i < 8; i++) {
			const foreign = new FakeSocket()
			server.connect(foreign)
			foreign.feed(hello(t, "99"))
			expect(s.sealed).not.toHaveBeenCalled()
		}
		const ninth = new FakeSocket()
		server.connect(ninth)
		await expect(t.authenticated).rejects.toThrow("candidate capacity")
		expect(ninth.destroyed).toBe(true)
		await t.cleanup()
	})

	it("stops on a null read without a stale immediate and requires genuine readability to resume", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const a = new FakeSocket()
		;(mocks.server as FakeServer).connect(a)
		const read = vi.spyOn(a, "read").mockReturnValueOnce(null)
		a.feed(hello(t))
		expect(read).toHaveBeenCalledTimes(1)
		await nextTurn()
		expect(read).toHaveBeenCalledTimes(1)
		a.emit("readable")
		await t.authenticated
		expect(read).toHaveBeenCalledTimes(2)
		a.emit("readable")
		await nextTurn()
		expect(read).toHaveBeenCalledTimes(2)
		await t.cleanup()
	})

	it("accepted error cancels its pending continuation before any queued proof publication", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const a = new FakeSocket()
		;(mocks.server as FakeServer).connect(a)
		a.feed(hello(t))
		await t.authenticated
		for (let i = 0; i < 12; i++)
			a.chunks.push(Buffer.from(disposal(String(i + 1))))
		a.emit("readable")
		expect(s.dispose).toHaveBeenCalledTimes(8)
		a.emit("error", new Error("owned channel failed"))
		await nextTurn()
		expect(s.dispose).toHaveBeenCalledTimes(8)
		expect(s.sealed).toHaveBeenCalledTimes(1)
		await t.cleanup()
	})

	it("bounds no-LF overflow and partial hello EOF to candidate-local rejection", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const server = mocks.server as FakeServer,
			overlong = new FakeSocket(),
			partial = new FakeSocket()
		server.connect(overlong)
		overlong.feed(Buffer.alloc(256, 0x61))
		expect(overlong.destroyed).toBe(true)
		server.connect(partial)
		partial.feed(hello(t).slice(0, -1))
		partial.emit("end")
		expect(partial.destroyed).toBe(true)
		expect(s.sealed).not.toHaveBeenCalled()
		const a = new FakeSocket()
		server.connect(a)
		a.feed(hello(t))
		await t.authenticated
		a.feed(disposal("1") + disposal("2") + disposal("3"))
		expect(s.dispose).toHaveBeenCalledTimes(3)
		await t.cleanup()
	})

	it("initiates pathname cleanup while an independently held server close remains pending", async () => {
		const s = processOwner(),
			t = new SettlementTransport(s.owner, s.observer)
		await t.listen()
		t.assignChild(ownedChild(s.owner))
		t.markReady("attempt-disposal-v1")
		const a = new FakeSocket()
		a.deferClose = true
		const server = mocks.server as FakeServer
		server.connect(a)
		a.feed(hello(t))
		await t.authenticated
		let complete = false
		const cleanup = t.cleanup().then(outcomes => {
			complete = true
			return outcomes
		})
		await nextTurn()
		expect(mocks.unlink).toHaveBeenCalledWith(t.socketPath)
		expect(mocks.rmdir).toHaveBeenCalledWith("/tmp/wks-owned")
		expect(complete).toBe(false)
		a.emit("close")
		await expect(cleanup).resolves.toEqual(
			expect.arrayContaining([{ ok: true }]),
		)
	})
})

describe("assigned startup without a returned child", () => {
	it("keeps positive no-process separate from late listen/path cleanup and never assigns a child", async () => {
		const s = processOwner(),
			server = mocks.server as FakeServer
		vi.spyOn(server, "listen").mockImplementation(() => server)
		const t = new SettlementTransport(s.owner, s.observer),
			listening = t.listen()
		void listening.catch(() => {})
		await nextTurn()
		t.seal()
		s.owner.recordStartSettled()
		s.observer.finishAcquisition(s.handle)
		expect(s.owner.recordNoProcess()).toBe(true)
		expect(s.registry.snapshot().owners.P).toBe(1)
		const cleanup = t.cleanup()
		server.listening = true
		server.emit("listening")
		await expect(listening).rejects.toThrow("startup sealed")
		await cleanup
		expect(s.registry.snapshot().owners.P).toBe(0)
		expect(s.dispose).not.toHaveBeenCalled()
	})

	it("settles unused pre-effect transport reservations if construction cannot own its server slot", () => {
		const s = processOwner(),
			existingServer = s.owner.retainLocal("server")!
		expect(() => new SettlementTransport(s.owner, s.observer)).toThrow(
			"local ownership",
		)
		s.owner.sealStartup()
		s.owner.recordStartSettled()
		s.observer.finishAcquisition(s.handle)
		expect(s.owner.recordNoProcess()).toBe(true)
		expect(s.registry.snapshot().owners.P).toBe(1)
		existingServer.settle({ ok: true })
		expect(s.registry.snapshot().owners.P).toBe(0)
	})
})
