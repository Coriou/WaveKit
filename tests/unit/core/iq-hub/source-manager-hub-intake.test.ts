import * as net from "node:net"
import * as os from "node:os"
import fc from "fast-check"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SourceConfig } from "../../../../src/config.js"
import { FrontAccounting } from "../../../../src/core/iq-hub/front-accounting.js"
import {
	HubSourceIntake,
	Supervisor,
} from "../../../../src/core/iq-hub/supervisor.js"
import { SourceManager } from "../../../../src/core/source-manager.js"
import { FakeHub, closeOf, collect, until } from "./fake-hub.js"

const log = pino({ level: "silent" })
const HEADER_BYTES = 12

/** A Node-side pause between writes: none, one check phase, one timer, or a short busy stall. */
async function nodePause(
	kind: "none" | "immediate" | "timer" | "busy",
): Promise<void> {
	if (kind === "immediate") await new Promise(resolve => setImmediate(resolve))
	else if (kind === "timer")
		await new Promise(resolve => setTimeout(resolve, 2))
	else if (kind === "busy") {
		const stallEnd = performance.now() + 3
		while (performance.now() < stallEnd) {
			/* a short main-thread stall */
		}
	}
}
const source = (host = "127.0.0.1"): SourceConfig =>
	({
		id: "rx",
		type: "rtl_tcp",
		host,
		port: 5555,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 1_024_000,
			exclusive: false,
		},
	}) as SourceConfig

let fake: FakeHub
let manager: SourceManager | undefined
afterEach(async () => {
	await manager?.disconnectAll()
	manager = undefined
	await fake.cleanup()
	vi.restoreAllMocks()
})

describe("SourceManager through the injected hub intake", () => {
	it("connects through the front: header parsed, payload on the stream, commands upstream, local port", async () => {
		fake = new FakeHub()
		const intake = new HubSourceIntake({ logger: log, factory: fake.factory })
		manager = new SourceManager(log, { intake })
		const stream = await manager.connect(source())
		const received = collect(stream as unknown as net.Socket)
		const hub = await fake.whenSpawned()
		const front = [...hub.fronts.values()][0]
		if (!front) throw new Error("no front")
		await front.whenStarted()
		const payload = Buffer.alloc(4096)
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
		front.send(payload)
		await until(() => received.bytes().length === payload.length)
		expect(received.bytes()).toEqual(payload)
		expect(manager.getRtlTcpInfo("rx")).toMatchObject({
			tunerType: 5,
			gainCount: 29,
		})
		expect(manager.connectionLocalPort("rx")).toBe(40_001)
		manager.writeToSource("rx", Buffer.from([0x01, 0x05, 0xf5, 0xe1, 0x00]))
		expect(await front.whenCommandBytes(5)).toEqual(
			Buffer.from([0x01, 0x05, 0xf5, 0xe1, 0x00]),
		)
	})

	it("M2: a hub failure is no receiver failure (no connect-failure record, no endpoint close); a refused receiver is", async () => {
		fake = new FakeHub()
		fake.features = ["front"]
		const intake = new HubSourceIntake({ logger: log, factory: fake.factory })
		manager = new SourceManager(log, { intake })
		const endpointClose = vi.spyOn(
			manager as unknown as { noteEndpointClose: () => void },
			"noteEndpointClose",
		)
		await expect(manager.connect(source())).rejects.toThrow()
		const status = manager.getStatus("rx")
		expect(status?.connectFailure).toBeUndefined()
		expect(status?.lastError).toContain("IQ hub")
		expect(endpointClose).not.toHaveBeenCalled()
		await manager.disconnectAll()

		fake = new FakeHub()
		fake.connectBehavior = () => ({
			kind: "refuse",
			reason: "refused",
			errno: os.constants.errno.ECONNREFUSED,
		})
		const receiverIntake = new HubSourceIntake({
			logger: log,
			factory: fake.factory,
		})
		manager = new SourceManager(log, { intake: receiverIntake })
		const receiverClose = vi.spyOn(
			manager as unknown as { noteEndpointClose: () => void },
			"noteEndpointClose",
		)
		await expect(manager.connect(source())).rejects.toThrow()
		expect(manager.getStatus("rx")?.connectFailure).toMatchObject({
			errorClass: "refused",
			attempts: 1,
		})
		expect(receiverClose).toHaveBeenCalled()
	})

	it("M8: a host name dials Node's own socket (connect(port, host)), never the hub", async () => {
		fake = new FakeHub()
		const intake = new HubSourceIntake({ logger: log, factory: fake.factory })
		const connect = vi
			.spyOn(net.Socket.prototype, "connect")
			.mockImplementation(function (this: net.Socket) {
				queueMicrotask(() =>
					this.destroy(Object.assign(new Error("x"), { code: "ECONNREFUSED" })),
				)
				return this
			})
		manager = new SourceManager(log, { intake })
		await expect(manager.connect(source("receiver.invalid"))).rejects.toThrow()
		expect(connect).toHaveBeenCalledWith(5555, "receiver.invalid")
		expect(fake.instances).toHaveLength(0)
	})
})

describe("byte invariants through the injected intake", () => {
	it("Node's bytes, the gaps, the discarded tail and the abandoned bytes conserve the stream at every event", async () => {
		// Feature: rx-starvation, Property 2: hub intake conserves bytes at every event
		// Validates: S3 I-S3, S6, S9, S10, S11, S14, M5
		fake = new FakeHub()
		const supervisor = new Supervisor({
			sourceId: "rx",
			logger: log,
			factory: fake.factory,
		})
		try {
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 0, max: 2048 }),
					fc.array(
						fc.oneof(
							fc.record({
								kind: fc.constant("data" as const),
								frames: fc.integer({ min: 1, max: 2048 }),
							}),
							fc.record({
								kind: fc.constant("gap" as const),
								frames: fc.integer({ min: 1, max: 4096 }),
							}),
						),
						{ maxLength: 12 },
					),
					fc.oneof(
						fc.record({
							kind: fc.constant("eof" as const),
							frames: fc.integer({ min: 0, max: 2048 }),
						}),
						fc.record({
							kind: fc.constant("node-close" as const),
							frames: fc.integer({ min: 1, max: 2048 }),
						}),
					),
					fc.uint8Array({ minLength: 12, maxLength: 12 }),
					async (startGapFrames, steps, ending, header) => {
						const headerBuf = Buffer.from(header)
						fake.connectBehavior = () => ({ kind: "accept", header: headerBuf })
						const socket = new net.Socket({ allowHalfOpen: true })
						const received = collect(socket)
						const closed = closeOf(socket)
						const nextFront =
							fake.instances.length > 0 ? fake.last.whenFront() : null
						supervisor.dial(socket, source(), "127.0.0.1", 5555)
						const hub = await fake.whenSpawned()
						const front = await (nextFront ?? hub.whenFront())
						await front.whenStarted()
						const accounting = supervisor.accountingOf(socket)
						if (!accounting) throw new Error("no accounting")
						const startPos = hub.sourcePos
						expect(accounting.startSourcePos).toBe(startPos)
						// N: what Node read, its header excluded (never the test's own sent count).
						const nodeBytes = () => received.bytes().length - HEADER_BYTES
						const conserved = async () => {
							await until(() => nodeBytes() === front.sinkBytes)
							expect(hub.sourcePos - startPos).toBe(
								nodeBytes() + accounting.droppedBytes,
							)
						}
						await until(() => received.bytes().length >= HEADER_BYTES)
						await conserved()
						if (startGapFrames > 0) {
							front.gap(startGapFrames * 2, "start")
							await conserved()
						}
						const sent: Buffer[] = []
						for (const step of steps) {
							const bytes = step.frames * 2
							if (step.kind === "gap") front.gap(bytes)
							else {
								const chunk = Buffer.alloc(bytes, (hub.sourcePos / 2) & 0xff)
								sent.push(chunk)
								front.send(chunk)
							}
							await conserved()
						}
						const tail = ending.frames * 2
						if (ending.kind === "eof") {
							front.endStream("eof", { discardedBytes: tail })
							const result = await closed
							expect(result.error).toBeNull()
						} else {
							// M5: Node closes early; what the front sent behind its pause is abandoned.
							socket.pause()
							front.send(Buffer.alloc(tail, 0xee))
							await new Promise(resolve => setTimeout(resolve, 1))
							socket.destroy()
							await closed
							await until(() => accounting.end !== null)
						}
						expect(received.bytes()).toEqual(
							Buffer.concat([headerBuf, ...sent]),
						)
						const upstream = hub.sourcePos - startPos
						expect(accounting.check(upstream, nodeBytes())).toMatchObject({
							holds: true,
							gaps: accounting.droppedBytes,
							discarded: ending.kind === "eof" ? tail : 0,
							abandoned: ending.kind === "eof" ? 0 : tail,
						})
					},
				),
				{ numRuns: 200 },
			)
		} finally {
			await supervisor.dispose()
		}
	}, 120_000)

	it("the upstream receives a prefix of Node's writes in order, all of them when Node ends the socket", async () => {
		// Feature: rx-starvation, Property 3: commands reach the receiver in order
		// Validates: S3 I-C, F8 mapping (write), S15
		fake = new FakeHub()
		const supervisor = new Supervisor({
			sourceId: "rx",
			logger: log,
			factory: fake.factory,
		})
		try {
			await fc.assert(
				fc.asyncProperty(
					fc.array(
						fc.record({
							bytes: fc.uint8Array({ minLength: 1, maxLength: 300 }),
							pause: fc.constantFrom("none", "immediate", "timer", "busy"),
						}),
						{ maxLength: 8 },
					),
					fc.constantFrom("end", "destroySoon", "destroy"),
					async (writes, ending) => {
						const socket = new net.Socket({ allowHalfOpen: true })
						const closed = closeOf(socket)
						// SourceManager reads in flowing mode: the front's FIN reaches it as `end`.
						socket.resume()
						const nextFront =
							fake.instances.length > 0 ? fake.last.whenFront() : null
						supervisor.dial(socket, source(), "127.0.0.1", 5555)
						const hub = await fake.whenSpawned()
						const front = await (nextFront ?? hub.whenFront())
						await front.whenStarted()
						const written: Buffer[] = []
						for (const write of writes) {
							const bytes = Buffer.from(write.bytes)
							written.push(bytes)
							socket.write(bytes)
							await nodePause(write.pause)
						}
						const all = Buffer.concat(written)
						if (ending === "end") socket.end()
						else if (ending === "destroySoon") socket.destroySoon()
						else socket.destroy()
						const result = await closed
						await front.whenEof()
						expect(result.error).toBeNull()
						const upstream = front.commandBytes
						expect(upstream.length).toBeLessThanOrEqual(all.length)
						expect(upstream).toEqual(all.subarray(0, upstream.length))
						if (ending !== "destroy") expect(upstream).toEqual(all)
						if (ending === "end")
							expect(result.events).toEqual(["end", "close"])
					},
				),
				{ numRuns: 200 },
			)
		} finally {
			await supervisor.dispose()
		}
	}, 120_000)

	it("the front position map equals a brute-force replay and is monotone", () => {
		// Feature: rx-starvation, Property 5: front position map is exact and monotone
		// Validates: S3 I-P, S11
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1000 }).map(n => n * 2),
				fc.array(
					fc.record({
						keep: fc.integer({ min: 0, max: 50 }),
						drop: fc.integer({ min: 1, max: 50 }),
					}),
					{ maxLength: 10 },
				),
				(start, segments) => {
					const accounting = new FrontAccounting()
					accounting.noteStarted(start)
					// Brute force: a map from every source position to its sink byte.
					const map = new Map<number, number>()
					let pos = start
					let sinkByte = 0
					for (const segment of segments) {
						for (let i = 0; i < segment.keep * 2; i++)
							map.set(pos++, sinkByte++)
						accounting.noteGap({
							atSinkByte: sinkByte,
							atSourcePos: pos,
							droppedBytes: segment.drop * 2,
							cause: "lag",
						})
						for (let i = 0; i < segment.drop * 2; i++) map.set(pos++, sinkByte)
					}
					for (let i = 0; i < 6; i++) map.set(pos++, sinkByte++)
					let previous = -1
					for (const [at, expected] of map) {
						const got = accounting.sinkByteOf(at)
						expect(got).toBe(expected)
						expect(got as number).toBeGreaterThanOrEqual(previous)
						previous = got as number
					}
					expect(accounting.sinkByteOf(start - 1)).toBeNull()
				},
			),
			{ numRuns: 200 },
		)
	})
})
