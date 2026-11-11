import { once } from "node:events"
import * as net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import type { TuningReceipt } from "../../../src/core/tuning-ledger.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	startStampedRtlTcp,
	type StampedRtlTcp,
} from "../../mocks/stamped-rtl-tcp.js"

const logger = createLogger({ level: "error" })
const cleanups: (() => unknown)[] = []

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 102.4 ksps declared: 204.8 kB/s, so a 64 KiB in-flight settle is 320 ms. */
const RATE = 102_400
const IN_FLIGHT = 64 * 1024
const F0 = 100_000_000
const F1 = 101_000_000
const F2 = 102_000_000

function config(port: number): SourceConfig {
	return {
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: RATE,
			centerFreq: F0,
			exclusive: false,
		},
	} as SourceConfig
}

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

async function freePort(): Promise<number> {
	const server = net.createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as net.AddressInfo
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

/** Real SourceManager on a stamped fake; records each session's bytes and the event order. */
async function harness(opts: { chunkBytes?: number } = {}) {
	const fake = await startStampedRtlTcp({
		initialHz: F0,
		initialRate: RATE,
		...(opts.chunkBytes !== undefined ? { chunkBytes: opts.chunkBytes } : {}),
	})
	cleanups.push(() => fake.close())
	const manager = new SourceManager(logger, {
		tuningSettleMs: () => 0,
		tuningInFlightBytes: IN_FLIGHT,
	})
	cleanups.push(() => manager.disconnectAll())
	const events: string[] = []
	const sessions = new Map<number, Buffer[]>()
	let current: Buffer[] | null = null
	manager.on("session-started", (id: string, session: number) => {
		events.push(`session:${session}`)
		current = []
		sessions.set(session, current)
	})
	manager.on("payload-started", () => events.push("payload-started"))
	const attach = () => {
		const stream = manager.getStream("rtl")!
		stream.on("data", (chunk: Buffer) => {
			if (events.at(-1) !== "data") events.push("data")
			current?.push(chunk)
		})
	}
	await manager.connect(config(fake.port))
	attach()
	return { fake, manager, sessions, events, attach }
}

/**
 * Every block of `block` bytes the ledger trusts must carry only the stamps of the centre and rate
 * it names. Returns the trusted and foreign block counts.
 */
function audit(
	manager: SourceManager,
	fake: StampedRtlTcp,
	session: number,
	bytes: Buffer,
	block = 1024,
): { trusted: number; foreign: number; relay: number } {
	const ledger = manager.tuningLedger
	let trusted = 0
	let foreign = 0
	let relay = 0
	for (let a = 0; a + block <= bytes.length; a += block / 2) {
		const v = ledger.trustAt("rtl", session, a, a + block)
		if (v.trust === "unverified") continue
		trusted += 1
		if (v.trust === "relay") relay += 1
		for (let i = a; i < a + block; i += 2) {
			if (
				fake.centreOf(bytes[i]!) !== v.frequency ||
				fake.rateOf(bytes[i + 1]!) !== v.sampleRate
			) {
				foreign += 1
				break
			}
		}
	}
	return { trusted, foreign, relay }
}

describe("tuning ledger wiring (real SourceManager, TunerRelay, stamped fake rtl_tcp)", () => {
	it("labels operator and relay writes against the stamps with no foreign sample trusted", async () => {
		const { fake, manager, sessions, events } = await harness()
		await until(() => (sessions.get(1)?.length ?? 0) > 4)
		// session-started precedes the first payload byte and payload-started.
		expect(events.slice(0, 3)).toEqual(["session:1", "data", "payload-started"])
		const ledger = manager.tuningLedger
		expect(ledger.trustNow("rtl")).toMatchObject({
			trust: "unverified",
			reason: "no-receipt",
		})

		manager.writeToSource(
			"rtl",
			Buffer.concat([frame(0x01, F1), frame(0x02, RATE)]),
			{ writer: "operator" },
		)
		await until(() => ledger.receipts("rtl").length === 2)
		await until(() => ledger.trustNow("rtl").trust === "commanded", 3000)
		expect(ledger.trustNow("rtl").frequency).toBe(F1)

		const fanout = new FanoutManager(logger)
		fanout.attachSource(manager.getStream("rtl")!)
		const relay = new TunerRelay(logger, manager, fanout, {
			enabled: true,
			host: "127.0.0.1",
			port: await freePort(),
			sourceId: "rtl",
			controlPolicy: "exclusive",
		})
		cleanups.push(() => relay.stop())
		await relay.start()
		const client = net.connect(relay.getStatus().port, "127.0.0.1")
		cleanups.push(() => client.destroy())
		client.on("data", () => undefined)
		await once(client, "connect")
		// One relay frame split across two TCP writes.
		const f = frame(0x01, F2)
		client.write(f.subarray(0, 2))
		await wait(20)
		client.write(f.subarray(2))
		await until(() =>
			ledger
				.receipts("rtl")
				.some(r => r.field === "frequency" && r.value === F2),
		)
		const receipt = ledger.receipts("rtl").at(-1)!
		expect(receipt).toMatchObject({ writer: "relay", value: F2 })
		await until(() => ledger.trustNow("rtl").trust === "relay", 3000)
		await wait(100)

		const bytes = Buffer.concat(sessions.get(1)!)
		const result = audit(manager, fake, 1, bytes)
		expect(result.foreign).toBe(0)
		expect(result.trusted).toBeGreaterThan(10)
		expect(result.relay).toBeGreaterThan(0)
		// Bytes before the first receipt's settle are never trusted.
		const first = ledger.receipts("rtl")[0]!.pos
		expect(ledger.trustAt("rtl", 1, 0, first + 1).trust).toBe("unverified")
	}, 20_000)

	it("gives a write held by socket backpressure its receipt only when it leaves", async () => {
		const { fake, manager, sessions } = await harness()
		await until(() => (sessions.get(1)?.length ?? 0) > 2)
		const ledger = manager.tuningLedger
		fake.pauseReading()
		// Fill the core's send path with gain frames until flushes stop: write until the socket
		// refuses more, and again whenever the kernel took the queue (its receipts arrived).
		const filler = Buffer.alloc(5 * 13_107)
		for (let i = 0; i < filler.length; i += 5) filler[i] = 0x04
		const lastSeq = () => ledger.receipts("rtl").at(-1)?.seq ?? 0
		let stalled = false
		for (let round = 0; round < 50 && !stalled; round++) {
			let accepted = true
			for (let i = 0; i < 400 && accepted; i++)
				accepted = manager.writeToSource("rtl", filler, { writer: "operator" })
			const before = lastSeq()
			await wait(300)
			stalled = lastSeq() === before
		}
		expect(stalled).toBe(true)
		const posAtWrite = ledger.position("rtl")!.pos
		const got: (number | null)[] = []
		manager.writeToSource("rtl", frame(0x01, F1), { writer: "operator" }, r =>
			got.push(r?.value ?? null),
		)
		await wait(200)
		expect(ledger.receipts("rtl").some(r => r.field === "frequency")).toBe(
			false,
		)
		// Written, not flushed: reported queued, no receipt handed back yet.
		expect(ledger.fieldState("rtl").frequency.queued).toEqual({
			value: F1,
			writer: "operator",
		})
		expect(got).toEqual([])
		expect(ledger.position("rtl")!.pos).toBeGreaterThan(posAtWrite)
		fake.resumeReading()
		await until(
			() => ledger.receipts("rtl").some(r => r.field === "frequency"),
			10_000,
		)
		const receipt = ledger.receipts("rtl").find(r => r.field === "frequency")!
		expect(receipt.pos).toBeGreaterThan(posAtWrite)
		expect(got).toEqual([F1])
		expect(ledger.fieldState("rtl").frequency.queued).toBeNull()
	}, 30_000)

	it("hands a controller write its receipt at flush with the writer of its origin", async () => {
		const { manager, sessions } = await harness()
		await until(() => (sessions.get(1)?.length ?? 0) > 2)
		const controller = new TunerController(logger, manager)
		controller.initializeSource("rtl", config(0).caps)
		const got: TuningReceipt[] = []
		await controller.setFrequency("rtl", F1, {
			onReceipt: r => {
				if (r) got.push(r)
			},
		})
		await controller.setFrequency("rtl", F2, {
			origin: "scanner",
			jobId: "job-1",
			onReceipt: r => {
				if (r) got.push(r)
			},
		})
		await until(() => got.length === 2)
		expect(got.map(r => [r.field, r.value, r.writer, r.jobId])).toEqual([
			["frequency", F1, "operator", undefined],
			["frequency", F2, "scanner", "job-1"],
		])
		expect(manager.tuningLedger.receipts("rtl").map(r => r.seq)).toEqual(
			got.map(r => r.seq),
		)
	}, 20_000)

	it("hands a multi-frame controller call one receipt, its last frame's", async () => {
		const { manager, sessions } = await harness()
		await until(() => (sessions.get(1)?.length ?? 0) > 2)
		const controller = new TunerController(logger, manager)
		controller.initializeSource("rtl", config(0).caps)
		const calls: (TuningReceipt | null)[] = []
		const before = manager.tuningLedger.receipts("rtl").length
		await controller.configure(
			"rtl",
			{ frequency: F1, sampleRate: 250_000 },
			{ onReceipt: r => calls.push(r) },
		)
		await until(() => manager.tuningLedger.receipts("rtl").length >= before + 2)
		await until(() => calls.length > 0)
		// Every frame of the call has flushed: any further call would have run by now.
		await wait(50)
		const written = manager.tuningLedger.receipts("rtl").slice(before)
		expect(written.map(r => r.field)).toEqual(["frequency", "sampleRate"])
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({
			field: "sampleRate",
			value: 250_000,
			seq: written.at(-1)!.seq,
		})
	}, 20_000)

	it("reads the source's live settle at each read", async () => {
		const fake = await startStampedRtlTcp({ initialHz: F0, initialRate: RATE })
		cleanups.push(() => fake.close())
		let settleMs = 60_000
		const asked: string[] = []
		const manager = new SourceManager(logger, {
			tuningSettleMs: id => {
				asked.push(id)
				return settleMs
			},
			tuningInFlightBytes: 0,
		})
		cleanups.push(() => manager.disconnectAll())
		await manager.connect(config(fake.port))
		const ledger = manager.tuningLedger
		await until(() => (ledger.position("rtl")?.pos ?? 0) > 0)
		manager.writeToSource(
			"rtl",
			Buffer.concat([frame(0x01, F1), frame(0x02, RATE)]),
			{ writer: "operator" },
		)
		await until(() => ledger.receipts("rtl").length === 2)
		await wait(100)
		expect(ledger.trustNow("rtl").reason).toBe("settling")
		settleMs = 0
		expect(ledger.trustNow("rtl").trust).toBe("commanded")
		expect(new Set(asked)).toEqual(new Set(["rtl"]))
	}, 20_000)

	it("starts a new session unverified on reconnect, and the old one reads ended", async () => {
		const { fake, manager, sessions, events, attach } = await harness()
		await until(() => (sessions.get(1)?.length ?? 0) > 2)
		const ledger = manager.tuningLedger
		manager.writeToSource(
			"rtl",
			Buffer.concat([frame(0x01, F1), frame(0x02, RATE)]),
			{ writer: "operator" },
		)
		await until(() => ledger.trustNow("rtl").trust === "commanded", 3000)
		const end1 = ledger.position("rtl")!.pos
		await manager.reconnect("rtl")
		attach()
		await until(() => (sessions.get(2)?.length ?? 0) > 4)
		expect(events.filter(e => e.startsWith("session:"))).toEqual([
			"session:1",
			"session:2",
		])
		// The receiver is still on F1, but nothing proves it in this session.
		expect(ledger.trustNow("rtl")).toMatchObject({
			trust: "unverified",
			reason: "no-receipt",
		})
		expect(ledger.trustAt("rtl", 1, 0, end1).reason).toBe("session-ended")
		const bytes = Buffer.concat(sessions.get(2)!)
		expect(audit(manager, fake, 2, bytes).trusted).toBe(0)
		expect(fake.centreOf(bytes[0]!)).toBe(F1)
	}, 20_000)
})
