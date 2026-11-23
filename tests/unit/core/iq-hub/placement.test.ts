/**
 * R3: tuner-command receipts at the hub's exact placements. The supervisor resolves registered
 * command ends from `front-placed` (S12), SourceManager registers them synchronously at the write
 * (M4) and the ledger records receipts at the placed position (parked until forwardData reaches
 * it). The stamped fake receiver proves I-P end to end: no new-centre byte before a receipt's
 * position, and with no in-flight bytes the first one exactly at it.
 */
import * as net from "node:net"
import fc from "fast-check"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../../src/config.js"
import type { CommandPlacement } from "../../../../src/core/iq-hub/intake.js"
import {
	HubSourceIntake,
	IQHUB_PLACEMENT_MISMATCH,
	Supervisor,
	type SupervisorHooks,
} from "../../../../src/core/iq-hub/supervisor.js"
import { isIntakeFault } from "../../../../src/core/source-manager-connect-failure.js"
import { IN_FLIGHT_BOUND_BYTES } from "../../../../src/core/spectrum/network-settle.js"
import { SourceManager } from "../../../../src/core/source-manager.js"
import type { TuningReceipt } from "../../../../src/core/tuning-ledger.js"
import { FakeHub, STAMP_BASE, closeOf, collect, until } from "./fake-hub.js"

const log = pino({ level: "silent" })

const config = {
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

function frequencyFrame(value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = 0x01
	b.writeUInt32BE(value, 1)
	return b
}

let fake: FakeHub
let supervisors: Supervisor[] = []
let manager: SourceManager | undefined
const sockets: net.Socket[] = []

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy()
	await manager?.disconnectAll()
	manager = undefined
	await Promise.all(supervisors.map(s => s.dispose()))
	supervisors = []
	await fake.cleanup()
})

async function dialActive(hooks: SupervisorHooks = {}) {
	fake = new FakeHub()
	const supervisor = new Supervisor({
		sourceId: "rx",
		logger: log,
		factory: fake.factory,
		...hooks,
	})
	supervisors.push(supervisor)
	const socket = new net.Socket({ allowHalfOpen: true })
	sockets.push(socket)
	const connected = new Promise<void>(resolve =>
		socket.once("connect", resolve),
	)
	const closed = closeOf(socket)
	supervisor.dial(socket, config, "127.0.0.1", 5555)
	const hub = await fake.whenSpawned()
	const front = await hub.whenFront()
	await front.whenStarted()
	await connected
	return { supervisor, socket, hub, front, closed }
}

describe("S12: placements of the front's command bytes", () => {
	it("resolves registered ends in write order at the placed sink byte, with the in-flight bound added", async () => {
		const { supervisor, socket, front } = await dialActive()
		const got: (CommandPlacement & { n: number })[] = []
		const write = (n: number, bytes: number) => {
			socket.write(Buffer.alloc(bytes, 0x04))
			expect(
				supervisor.noteCommandBytes(socket, bytes, p => got.push({ ...p, n })),
			).toBe(true)
		}
		write(1, 5)
		write(2, 5)
		write(3, 5)
		await front.whenCommandBytes(15)
		front.send(Buffer.alloc(100))
		// One placement covers the first two writes (10 bytes); the third waits.
		front.placed(10, 7)
		await until(() => got.length === 2)
		expect(got).toEqual([
			{ n: 1, pos: 100, inFlightBytes: 7 + IN_FLIGHT_BOUND_BYTES },
			{ n: 2, pos: 100, inFlightBytes: 7 + IN_FLIGHT_BOUND_BYTES },
		])
		front.send(Buffer.alloc(50))
		front.placed(15)
		await until(() => got.length === 3)
		expect(got[2]).toEqual({
			n: 3,
			pos: 150,
			inFlightBytes: IN_FLIGHT_BOUND_BYTES,
		})
		// An empty registration places nothing (no byte of it reaches the receiver).
		expect(
			supervisor.noteCommandBytes(socket, 0, p => got.push({ ...p, n: 4 })),
		).toBe(true)
		expect(got[3]).toEqual({ n: 4, pos: null })
		expect(supervisor.placementMismatches).toBe(0)
	})

	it("M-A: a registration the hub already read past fails the dial with an intake fault; pending ones resolve as mismatches", async () => {
		const { supervisor, socket, front, closed } = await dialActive()
		const got: CommandPlacement[] = []
		socket.write(Buffer.alloc(5, 0x04))
		supervisor.noteCommandBytes(socket, 5, p => got.push(p))
		await front.whenCommandBytes(5)
		front.send(Buffer.alloc(100))
		// The hub reports 10 command bytes read while Node has registered only 5.
		front.placed(10)
		await until(() => got.length === 1)
		expect(got[0]?.pos).toBe(100)
		front.send(Buffer.alloc(50))
		socket.write(Buffer.alloc(5, 0x04))
		// The hub sent these bytes upstream already, at a position nobody knows: the dial fails.
		supervisor.noteCommandBytes(socket, 5, p => got.push(p))
		expect(got[1]).toEqual({ pos: null, mismatch: true })
		expect(supervisor.placementMismatches).toBe(1)
		const { error } = await closed
		expect(error?.code).toBe(IQHUB_PLACEMENT_MISMATCH)
		expect(isIntakeFault(error)).toBe(true)
		// Nothing registered after the failure is ever placed.
		supervisor.noteCommandBytes(socket, 5, p => got.push(p))
		expect(got[2]).toEqual({ pos: null })
	})

	it("m-1: a placed sink byte the front's own gap history maps elsewhere fails the dial", async () => {
		const hooked: number[] = []
		const { supervisor, socket, front, closed } = await dialActive({
			onFrontPlaced: (_s, e) => hooked.push(e.sinkByte),
		})
		const got: CommandPlacement[] = []
		socket.write(Buffer.alloc(5, 0x04))
		supervisor.noteCommandBytes(socket, 5, p => got.push(p))
		await front.whenCommandBytes(5)
		front.send(Buffer.alloc(40))
		front.gap(1000)
		// The gap history maps this source position to sink byte 40; the hub says 41.
		front.hub.emit("front-placed", {
			sink: front.sink,
			frontBytes: 5,
			atSourcePos: front.hub.sourcePos - 400,
			sinkByte: 41,
			queuedBytes: 0,
		})
		await until(() => got.length === 1)
		expect(got[0]).toEqual({ pos: null, mismatch: true })
		const { error } = await closed
		expect(error?.code).toBe(IQHUB_PLACEMENT_MISMATCH)
		expect(supervisor.placementMismatches).toBe(1)
		// Neither figure is passed on as a placement.
		expect(hooked).toEqual([])
	})

	it("m-1: a placement below an earlier one (sink byte or front bytes moving back) fails the dial", async () => {
		for (const back of ["sinkByte", "frontBytes"] as const) {
			const { supervisor, socket, front, closed } = await dialActive()
			const got: CommandPlacement[] = []
			for (let i = 0; i < 2; i++) {
				socket.write(Buffer.alloc(5, 0x04))
				supervisor.noteCommandBytes(socket, 5, p => got.push(p))
			}
			await front.whenCommandBytes(10)
			front.send(Buffer.alloc(100))
			front.placed(5)
			await until(() => got.length === 1)
			expect(got[0]?.pos).toBe(100)
			front.hub.emit("front-placed", {
				sink: front.sink,
				frontBytes: back === "frontBytes" ? 4 : 10,
				atSourcePos: front.hub.sourcePos,
				sinkByte: back === "sinkByte" ? 60 : 100,
				queuedBytes: 0,
			})
			await until(() => got.length === 2)
			expect(got[1]).toEqual({ pos: null, mismatch: true })
			expect((await closed).error?.code).toBe(IQHUB_PLACEMENT_MISMATCH)
			if (back === "frontBytes") break
			await Promise.all(supervisors.splice(0).map(s => s.dispose()))
			await fake.cleanup()
		}
	})

	it("a placement inside a lag gap resolves at the gap's sink byte (the hub's own mapping)", async () => {
		const { supervisor, socket, front } = await dialActive()
		const got: CommandPlacement[] = []
		socket.write(Buffer.alloc(5, 0x04))
		supervisor.noteCommandBytes(socket, 5, p => got.push(p))
		await front.whenCommandBytes(5)
		front.send(Buffer.alloc(40))
		front.gap(1000)
		// The hub emits the gap first, then the placement whose position the skip covered.
		front.hub.emit("front-placed", {
			sink: front.sink,
			frontBytes: 5,
			atSourcePos: front.hub.sourcePos - 400,
			sinkByte: 40,
			queuedBytes: 0,
		})
		await until(() => got.length === 1)
		expect(got[0]?.pos).toBe(40)
		expect(supervisor.placementMismatches).toBe(0)
	})

	it("pending placements resolve null when the front ends, when Node closes, and on an F10 hang-up", async () => {
		{
			const { supervisor, socket, front } = await dialActive()
			const got: CommandPlacement[] = []
			socket.write(Buffer.alloc(5, 0x04))
			supervisor.noteCommandBytes(socket, 5, p => got.push(p))
			await front.whenCommandBytes(5)
			front.endStream("eof")
			await until(() => got.length === 1)
			expect(got[0]).toEqual({ pos: null })
			// Nothing written after the end is ever placed.
			supervisor.noteCommandBytes(socket, 5, p => got.push(p))
			expect(got[1]).toEqual({ pos: null })
		}
		await Promise.all(supervisors.splice(0).map(s => s.dispose()))
		await fake.cleanup()
		{
			const { supervisor, socket, front, closed } = await dialActive()
			const got: CommandPlacement[] = []
			socket.write(Buffer.alloc(5, 0x04))
			supervisor.noteCommandBytes(socket, 5, p => got.push(p))
			await front.whenCommandBytes(5)
			socket.destroy()
			await closed
			await until(() => got.length === 1)
			expect(got[0]).toEqual({ pos: null })
		}
		await Promise.all(supervisors.splice(0).map(s => s.dispose()))
		await fake.cleanup()
		{
			const { supervisor, socket, front, hub, closed } = await dialActive()
			fake.hangupWithoutRead = true
			const got: CommandPlacement[] = []
			socket.write(Buffer.alloc(5, 0x04))
			supervisor.noteCommandBytes(socket, 5, p => got.push(p))
			await front.whenCommandBytes(5)
			socket.destroy()
			await closed
			await until(() => got.length === 1)
			expect(got[0]).toEqual({ pos: null })
			// F10: only sink-closed {peer}, no front-ended (so no end in the accounting).
			await until(() => hub.attempts.get(1)?.closed === true)
			expect(supervisor.accountingOf(socket)?.end ?? null).toBeNull()
		}
	})

	it("a socket the supervisor does not dial is refused (no callback)", async () => {
		const { supervisor } = await dialActive()
		const other = new net.Socket()
		sockets.push(other)
		let called = false
		expect(
			supervisor.noteCommandBytes(other, 5, () => {
				called = true
			}),
		).toBe(false)
		expect(called).toBe(false)
	})
})

describe("SourceManager receipts at the hub's placements", () => {
	async function hubManager(
		supervisor: { endWaitMs?: number; pausedEndCapMs?: number } = {},
	) {
		fake = new FakeHub()
		fake.stampedFronts = true
		const intake = new HubSourceIntake({
			logger: log,
			factory: fake.factory,
			supervisor,
		})
		manager = new SourceManager(log, {
			intake,
			tuningSettleMs: () => 0,
			tuningInFlightBytes: 0,
		})
		const stream = await manager.connect(config)
		const received = collect(stream as unknown as net.Socket)
		const hub = await fake.whenSpawned()
		const front = [...hub.fronts.values()][0]
		if (!front) throw new Error("no front")
		await front.whenStarted()
		return { manager, received, hub, front }
	}

	it("M4: a placement that arrives before the write callback still waits for it, and the receipt is exact", async () => {
		const { manager, front } = await hubManager()
		front.produce(1000)
		front.deliver(1000)
		const ledger = manager.tuningLedger
		await until(() => ledger.position("rx")?.pos === 1000)
		// The socket's write callback is held back until after the placement was handled.
		const socket = Reflect.get(
			Reflect.get(manager, "sources").get("rx") as object,
			"socket",
		) as net.Socket
		const original = socket.write.bind(socket) as (
			chunk: Buffer,
			cb?: (err?: Error | null) => void,
		) => boolean
		let releaseCallback: (() => void) | null = null
		Object.defineProperty(socket, "write", {
			configurable: true,
			value: (chunk: Buffer, cb?: (err?: Error | null) => void) =>
				original(chunk, err => {
					releaseCallback = () => cb?.(err)
				}),
		})
		// The receiver is 600 bytes ahead of Node when it reads the command.
		front.produce(600)
		const got: (TuningReceipt | null)[] = []
		manager.writeToSource(
			"rx",
			frequencyFrame(STAMP_BASE + 7),
			{ writer: "operator" },
			r => got.push(r),
		)
		await front.whenCommandBytes(5)
		front.deliver(600)
		await until(() => ledger.position("rx")?.pos === 1600)
		await new Promise(resolve => setTimeout(resolve, 20))
		// Placed (front-placed handled) but the write callback has not run: no receipt yet.
		expect(releaseCallback).not.toBeNull()
		expect(got).toEqual([])
		expect(ledger.fieldState("rx").frequency.queued).not.toBeNull()
		releaseCallback!()
		expect(got).toHaveLength(1)
		expect(got[0]?.pos).toBe(1600)
		expect(got[0]?.inFlightBytes).toBe(IN_FLIGHT_BOUND_BYTES)
	})

	it("M-A: a forced placement mismatch ends the session as an intake fault; no read past the command proves the old value", async () => {
		const { manager, front } = await hubManager()
		const ledger = manager.tuningLedger
		const rate = Buffer.alloc(5)
		rate[0] = 0x02
		rate.writeUInt32BE(1_024_000, 1)
		manager.writeToSource("rx", rate, { writer: "operator" })
		manager.writeToSource("rx", frequencyFrame(STAMP_BASE + 1), {
			writer: "operator",
		})
		await front.whenCommandBytes(10)
		// Past the in-flight bound of the receipts at 0, so the old value is proven.
		const F = IN_FLIGHT_BOUND_BYTES
		const writePos = F + 1000
		front.produce(writePos)
		front.deliver(writePos)
		await until(() => ledger.position("rx")?.pos === writePos)
		await until(() => ledger.receipts("rx").length === 2)
		const session = ledger.position("rx")!.session
		expect(ledger.trustAt("rx", session, F, writePos)).toMatchObject({
			trust: "commanded",
			frequency: STAMP_BASE + 1,
		})
		const socket = Reflect.get(
			Reflect.get(manager, "sources").get("rx") as object,
			"socket",
		) as net.Socket
		const closed = closeOf(socket)
		// The hub claims to have read the next command's bytes before Node wrote them (its own
		// placement of them later is in order, so only the registration check can catch it).
		front.hub.emit("front-placed", {
			sink: front.sink,
			frontBytes: 15,
			atSourcePos: front.hub.sourcePos,
			sinkByte: writePos,
			queuedBytes: 0,
		})
		await new Promise(resolve => setTimeout(resolve, 20))
		const got: (TuningReceipt | null)[] = []
		manager.writeToSource(
			"rx",
			frequencyFrame(STAMP_BASE + 7),
			{ writer: "operator" },
			r => got.push(r),
		)
		// From the write on, no read past the command's write position proves the old value.
		const neverOld = () => {
			const at = ledger.position("rx")
			if (at?.session !== session) return
			for (const a of [0, F, writePos - 1, writePos])
				for (const b of [writePos + 1, at.pos])
					if (a < b && b > writePos && b <= at.pos)
						expect(ledger.trustAt("rx", session, a, b).trust).not.toBe(
							"commanded",
						)
		}
		neverOld()
		// The receiver keeps sending while the dial fails (whatever reaches Node is checked too).
		front.produce(2000)
		front.deliver(2000)
		const ended = closed.then(c => c)
		let done = false
		void ended.then(() => {
			done = true
		})
		while (!done) {
			neverOld()
			await new Promise(resolve => setImmediate(resolve))
		}
		const { error } = await ended
		expect(error?.code).toBe(IQHUB_PLACEMENT_MISMATCH)
		expect(got).toEqual([null])
		// The session ended: nothing in it is proven any more; the next session starts unverified.
		expect(ledger.trustAt("rx", session, F, writePos).trust).not.toBe(
			"commanded",
		)
		// An intake fault: no receiver connect-failure record.
		const status = manager.getStatus("rx")
		expect(status?.connectFailure).toBeUndefined()
		expect(status?.lastError).toContain("IQ hub")
	})

	it("M1: a write after a paused front ended gets a null receipt and no doubt, so a controller writes at most once before the socket ends", async () => {
		const { manager, front } = await hubManager({
			endWaitMs: 20,
			pausedEndCapMs: 400,
		})
		const ledger = manager.tuningLedger
		front.produce(1000)
		front.deliver(1000)
		await until(() => ledger.position("rx")?.pos === 1000)
		const socket = Reflect.get(
			Reflect.get(manager, "sources").get("rx") as object,
			"socket",
		) as net.Socket
		const closed = closeOf(socket)
		// The tuner controller's reaction to a doubt: re-assert (one write per microtask turn).
		let controllerWrites = 0
		const unsubscribe = ledger.subscribe((id, change) => {
			if (id !== "rx" || change.kind !== "doubt") return
			queueMicrotask(() => {
				if (controllerWrites >= 50 || !socket.writable) return
				controllerWrites += 1
				try {
					manager.writeToSource(
						"rx",
						frequencyFrame(STAMP_BASE + 3),
						{ writer: "operator" },
						() => {},
					)
				} catch {
					// Refused (disconnected): the controller would stop here too.
				}
			})
		})
		const got: (TuningReceipt | null)[] = []
		// Node is paused (backpressure that does not drain), so the front's end is held while the
		// socket stays writable.
		socket.pause()
		Object.defineProperty(socket, "resume", {
			configurable: true,
			value: () => socket,
		})
		// The FIN is still on its way (Node has not read it): the end waits for it, capped.
		front.endStream("eof", { noFin: true })
		// front-ended handled: no placement comes any more, yet the socket is still writable.
		await new Promise(resolve => setTimeout(resolve, 60))
		expect(socket.writable).toBe(true)
		manager.writeToSource(
			"rx",
			frequencyFrame(STAMP_BASE + 2),
			{ writer: "operator" },
			r => got.push(r),
		)
		await until(() => got.length === 1)
		expect(got).toEqual([null])
		expect(socket.writable).toBe(true)
		await new Promise(resolve => setTimeout(resolve, 100))
		expect(ledger.doubts("rx").map(d => d.reason)).not.toContain("write-failed")
		await closed
		unsubscribe()
		expect(controllerWrites).toBeLessThanOrEqual(1)
	})

	it("parks a placement beyond Node's position and records it when forwardData reaches it", async () => {
		const { manager, hub, front } = await hubManager()
		const ledger = manager.tuningLedger
		front.produce(2000)
		front.deliver(500)
		await until(() => ledger.position("rx")?.pos === 500)
		const got: (TuningReceipt | null)[] = []
		manager.writeToSource(
			"rx",
			frequencyFrame(STAMP_BASE + 9),
			{ writer: "operator" },
			r => got.push(r),
		)
		await front.whenCommandBytes(5)
		// Placed at 2000 (the head when the receiver read it), emitted when the cursor reaches it.
		front.deliver(1500)
		await until(() => ledger.position("rx")?.pos === 2000)
		await until(() => got.length === 1)
		expect(got[0]?.pos).toBe(2000)
		expect(hub.requestsOf("connect")).toHaveLength(1)
	})

	it("Feature: rx-starvation, Property 6: no new-centre byte appears before a receipt's position (stamped receiver)", async () => {
		// Feature: rx-starvation, Property 6: no new-centre sample before a receipt's position
		// Validates: S3 I-P, R3 items 1-2, M4, B2
		const { manager, received, front } = await hubManager()
		const ledger = manager.tuningLedger
		let stampCounter = 0
		let delivered = 0
		const nodeAt = async (bytes: number) => {
			await until(() => (ledger.position("rx")?.pos ?? 0) >= bytes, 5000)
		}
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.record({
							kind: fc.constant("produce" as const),
							frames: fc.integer({ min: 1, max: 400 }),
						}),
						fc.record({
							kind: fc.constant("deliver" as const),
							frames: fc.integer({ min: 1, max: 400 }),
						}),
						fc.record({
							kind: fc.constant("command" as const),
							before: fc.integer({ min: 0, max: 300 }),
						}),
					),
					{ minLength: 1, maxLength: 12 },
				),
				async steps => {
					await until(
						() => received.bytes().length === (ledger.position("rx")?.pos ?? 0),
					)
					const base = ledger.position("rx")?.pos ?? 0
					const startByte = received.bytes().length
					const receipts: {
						stamp: number
						receipt: TuningReceipt | null
					}[] = []
					for (const step of steps) {
						if (step.kind === "produce") front.produce(step.frames * 2)
						else if (step.kind === "deliver")
							delivered += front.deliver(step.frames * 2)
						else {
							stampCounter = (stampCounter % 250) + 1
							const stamp = stampCounter
							const entry: (typeof receipts)[number] = {
								stamp,
								receipt: null,
							}
							receipts.push(entry)
							const before = front.commandBytes.length
							manager.writeToSource(
								"rx",
								frequencyFrame(STAMP_BASE + stamp),
								{ writer: "operator" },
								r => {
									entry.receipt = r
								},
							)
							// The receiver produces a little more before it reads the command.
							front.produce(step.before * 2)
							await front.whenCommandBytes(before + 5)
						}
					}
					// Everything produced reaches Node; every receipt then records.
					delivered += front.deliver(Number.MAX_SAFE_INTEGER)
					await nodeAt(delivered)
					await until(() => receipts.every(r => r.receipt !== null), 5000)
					await until(
						() => received.bytes().length - startByte >= delivered - base,
					)
					const bytes = received.bytes().subarray(startByte)
					let from = 0
					for (const { stamp, receipt } of receipts) {
						const at = receipt!.pos - base
						expect(at).toBeGreaterThanOrEqual(from)
						// No byte before the receipt carries the new stamp...
						expect(bytes.subarray(from, at).includes(stamp)).toBe(false)
						// ...and with no in-flight bytes the first new-stamp byte is at it exactly.
						const first = bytes.indexOf(stamp, at)
						if (first !== -1) expect(first).toBe(at)
						from = at
					}
				},
			),
			{ numRuns: 200 },
		)
	}, 120_000)
})
