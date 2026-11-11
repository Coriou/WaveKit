/**
 * Rate-truth check wired into SourceManager: measured bytes per metrics
 * interval versus caps.sampleRate × bytes per sample. Surfaces in getStatus()
 * as `rateMismatch` and emits "rate-truth-changed"; caps are never changed.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import * as net from "node:net"
import { SourceManager } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const DECLARED = 2_048_000
const TICK = 5_000

describe("source rate truth", () => {
	const manager = new SourceManager(createLogger({ level: "fatal" }))
	let server: net.Server | undefined
	const sockets: net.Socket[] = []
	let now = 1_000_000

	afterEach(async () => {
		vi.restoreAllMocks()
		await manager.disconnectAll()
		for (const socket of sockets) socket.destroy()
		sockets.length = 0
		if (server)
			await new Promise<void>(resolve => server!.close(() => resolve()))
	})

	async function connect(type: "rtl_tcp" | "recording" = "rtl_tcp") {
		vi.spyOn(Date, "now").mockImplementation(() => now)
		server = net.createServer(socket => sockets.push(socket))
		await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve))
		const port = (server.address() as net.AddressInfo).port
		const stream = await manager.connect({
			id: "iq",
			type,
			host: "127.0.0.1",
			port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: DECLARED,
				exclusive: false,
			},
		})
		stream.resume()
		await vi.waitFor(() => expect(sockets.length).toBe(1))
		return stream
	}

	/** Delivers one metrics interval of IQ at `actualHz` and runs the tick. */
	async function interval(actualHz: number) {
		await intervalBytes(Math.round((actualHz * 2 * TICK) / 1000))
	}

	/** Delivers one metrics interval of `bytes` IQ bytes and runs the tick. */
	async function intervalBytes(bytes: number) {
		const before = manager.getStatus("iq")!.bytesReceived
		sockets[0]!.write(Buffer.alloc(bytes))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.bytesReceived).toBe(before + bytes),
		)
		now += TICK
		;(manager as unknown as { emitMetrics(id: string): void }).emitMetrics("iq")
	}

	it("flags a sustained faster-than-declared stream and clears after agreement", async () => {
		await connect()
		const changes: string[] = []
		manager.on("rate-truth-changed", (id: string) => changes.push(id))
		await interval(2_160_000) // first interval after connect is not trusted
		for (let i = 0; i < 5; i++) await interval(2_160_000)
		expect(manager.getStatus("iq")!.rateMismatch).toBeUndefined()
		await interval(2_160_000)
		expect(manager.getStatus("iq")!.rateMismatch).toMatchObject({
			declaredSampleRateHz: DECLARED,
			measuredSampleRateHz: 2_160_000,
		})
		expect(manager.getStatus("iq")!.caps.sampleRate).toBe(DECLARED)
		expect(changes).toEqual(["iq"])

		for (let i = 0; i < 6; i++) await interval(DECLARED)
		expect(manager.getStatus("iq")!.rateMismatch).toBeUndefined()
		expect(changes).toEqual(["iq", "iq"])
	}, 20_000)

	it("doubts the rate from the session start when the wrong rate held from connect", async () => {
		await connect()
		const ledger = manager.tuningLedger
		await interval(2_160_000) // not trusted, yet already at the wrong rate
		expect(ledger.position("iq")!.pos).toBeGreaterThan(0)
		for (let i = 0; i < 6; i++) await interval(2_160_000)
		expect(manager.getStatus("iq")!.rateMismatch).toBeDefined()
		const doubt = ledger.doubts("iq").at(-1)!
		expect(doubt).toMatchObject({
			field: "sampleRate",
			reason: "rate-truth-mismatch",
		})
		// No agreeing interval was ever measured: the wrong rate may hold from the start.
		expect(doubt.pos).toBe(0)
	}, 20_000)

	it("doubts the rate from the agreeing interval in which the rate changed part-way", async () => {
		await connect()
		const ledger = manager.tuningLedger
		await interval(DECLARED) // not trusted
		await interval(DECLARED)
		await interval(DECLARED)
		// Interval k: 70 % at the declared rate, then 30 % at a faster one. The mean
		// deviates 0.3 × 5.5 % ≈ 1.6 %, inside the 2 % tolerance, so k still agrees.
		const startOfK = ledger.position("iq")!.pos
		const perTick = (hz: number) => (hz * 2 * TICK) / 1000
		await intervalBytes(
			Math.round(0.7 * perTick(DECLARED) + 0.3 * perTick(2_160_000)),
		)
		expect(manager.getStatus("iq")!.rateMismatch).toBeUndefined()
		for (let i = 0; i < 6; i++) await interval(2_160_000)
		expect(manager.getStatus("iq")!.rateMismatch).toBeDefined()
		const doubt = ledger.doubts("iq").at(-1)!
		expect(doubt.reason).toBe("rate-truth-mismatch")
		expect(doubt.pos).toBeLessThanOrEqual(startOfK)
		expect(doubt.pos).toBeGreaterThan(0)
	}, 20_000)

	it("doubts the rate from the session start when an invalid interval came after the last agreeing one", async () => {
		await connect()
		const ledger = manager.tuningLedger
		await interval(DECLARED) // not trusted
		await interval(DECLARED)
		await interval(DECLARED)
		// An interval with nothing delivered measures no rate: agreement before it says
		// nothing about what the receiver ran after it.
		now += TICK
		;(manager as unknown as { emitMetrics(id: string): void }).emitMetrics("iq")
		for (let i = 0; i < 6; i++) await interval(2_160_000)
		expect(manager.getStatus("iq")!.rateMismatch).toBeDefined()
		expect(ledger.doubts("iq").at(-1)!.pos).toBe(0)
	}, 20_000)

	it("does not flag a connected source that sends nothing (e.g. rtlmux without dongle)", async () => {
		await connect()
		for (let i = 0; i < 10; i++) {
			now += TICK
			;(manager as unknown as { emitMetrics(id: string): void }).emitMetrics(
				"iq",
			)
		}
		expect(manager.getStatus("iq")!.rateMismatch).toBeUndefined()
	}, 20_000)

	it("clears the flag when the declared rate changes", async () => {
		await connect()
		for (let i = 0; i < 7; i++) await interval(2_160_000)
		expect(manager.getStatus("iq")!.rateMismatch).toBeDefined()
		manager.updateSourceCaps("iq", { sampleRate: 2_160_000 })
		await interval(2_160_000)
		expect(manager.getStatus("iq")!.rateMismatch).toBeUndefined()
	}, 20_000)

	it("does not count intervals in which the socket was paused by backpressure", async () => {
		const stream = await connect()
		stream.pause()
		// Fill the stream's buffer so the source pauses the socket.
		const before = manager.getStatus("iq")!.bytesReceived
		sockets[0]!.write(Buffer.alloc(4 * 1024 * 1024))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("paused"),
		)
		expect(manager.getStatus("iq")!.bytesReceived).toBeGreaterThan(before)
		for (let i = 0; i < 8; i++) {
			now += TICK
			;(manager as unknown as { emitMetrics(id: string): void }).emitMetrics(
				"iq",
			)
		}
		expect(manager.getStatus("iq")!.rateMismatch).toBeUndefined()
	}, 20_000)
})
