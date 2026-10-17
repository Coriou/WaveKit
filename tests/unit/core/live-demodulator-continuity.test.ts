/**
 * WG10 req 2.1, 2.2: clients survive restarts and hear silence until the new
 * run's audio. Fake stages, injected clock, counted bytes.
 */

import { describe, it, expect, afterEach } from "vitest"
import fc from "fast-check"
import {
	LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS,
	LIVE_AUDIO_SILENCE_CHUNK_MS,
	LIVE_AUDIO_SILENCE_FILL_MAX_MS,
} from "@wavekit/api-types"
import {
	capturingLogger,
	createDemodHarness,
	delay,
	waitFor,
	writeAndSettle,
} from "./live-demodulator-continuity-fakes.js"

type Harness = Awaited<ReturnType<typeof createDemodHarness>>
let harness: Harness | null = null

afterEach(async () => {
	await harness?.dispose()
	harness = null
})

// 25 kHz s16le default stream: 20 ms = 500 samples = 1 000 bytes.
const CHUNK_BYTES = 1000

async function startHarness(
	options: Parameters<typeof createDemodHarness>[0] = {},
) {
	harness = await createDemodHarness(options)
	await harness.demod.start()
	return harness
}

describe("LiveDemodulator continuity (WG10 req 2.1, 2.2)", () => {
	it("a full restart that keeps the format fills exactly 250 chunks and never chunk 251", async () => {
		const h = await startHarness()
		const { transport } = h.addClient()
		await h.demod.reconfigure({ gain: 5 })
		expect(transport.received().length).toBe(CHUNK_BYTES)
		h.clock.advance(LIVE_AUDIO_SILENCE_FILL_MAX_MS - 1)
		expect(transport.received().length).toBe(250 * CHUNK_BYTES)
		h.clock.advance(1)
		h.clock.advance(10_000)
		expect(transport.received().length).toBe(250 * CHUNK_BYTES)
		expect(transport.received().every(byte => byte === 0)).toBe(true)
		expect(transport.writableEnded).toBe(false)
	})

	it("silence never reaches the pcm event and the first real audio ends the fill", async () => {
		const h = await startHarness()
		const pcm: Buffer[] = []
		h.demod.on("pcm", chunk => pcm.push(Buffer.from(chunk)))
		const { transport } = h.addClient()
		await h.demod.reconfigure({ gain: 5 })
		h.clock.advance(100)
		expect(pcm).toEqual([])
		const silentBytes = transport.received().length
		expect(silentBytes).toBe(6 * CHUNK_BYTES)
		const audio = Buffer.alloc(200, 7)
		await writeAndSettle(h.current().back.stdout, audio)
		h.clock.advance(1000)
		expect(pcm).toHaveLength(1)
		const received = transport.received()
		expect(received.length).toBe(silentBytes + 200)
		expect(received.subarray(silentBytes)).toEqual(audio)
	})

	it("no fill without clients, and none when the format changes (clients closed as today)", async () => {
		const h = await startHarness()
		await h.demod.reconfigure({ gain: 5 })
		h.clock.advance(100)
		expect(h.clock.pending).toBe(0)
		const { transport } = h.addClient()
		await h.demod.reconfigure({ audioFormat: "f32le" })
		await delay(5)
		expect(transport.writableEnded).toBe(true)
		expect(transport.received().length).toBe(0)
		expect(h.clock.pending).toBe(0)
	})

	it("stop ends the fill", async () => {
		const h = await startHarness()
		const { transport } = h.addClient()
		await h.demod.reconfigure({ gain: 5 })
		await h.demod.stop()
		const bytes = transport.received().length
		h.clock.advance(1000)
		expect(transport.received().length).toBe(bytes)
		expect(h.clock.pending).toBe(0)
	})

	it("a restart after a pipeline failure fills; a failure of the new run ends it", async () => {
		const h = await startHarness()
		const { transport } = h.addClient()
		h.current().front.exit(1)
		await waitFor(() => h.processes.length === 4)
		await waitFor(() => h.demod.getStatus().pipelineHealth === "running")
		expect(transport.received().length).toBe(CHUNK_BYTES)
		h.current().back.exit(1)
		await delay(2)
		const bytes = transport.received().length
		// The failure disarmed; the next restart (after backoff) re-arms.
		expect(h.clock.pending).toBe(0)
		await waitFor(() => h.processes.length === 6)
		await waitFor(() => h.demod.getStatus().pipelineHealth === "running")
		expect(transport.received().length).toBe(bytes + CHUNK_BYTES)
		expect(transport.writableEnded).toBe(false)
	})

	it("a full restart adds one debug log line with clients attached, none without", async () => {
		const captured = capturingLogger()
		const h = await startHarness({ logger: captured.logger })
		captured.lines.splice(0)
		await h.demod.reconfigure({ gain: 5 })
		expect(
			captured.lines.filter(l => l.msg === "Live audio silence fill armed"),
		).toHaveLength(0)
		h.addClient()
		captured.lines.splice(0)
		await h.demod.reconfigure({ gain: 6 })
		const armed = captured.lines.filter(
			l => l.msg === "Live audio silence fill armed",
		)
		expect(armed).toHaveLength(1)
		expect(armed[0]).toMatchObject({ level: 20, clients: 1 })
	})

	// Feature: web-gaps-10, Property 4: Clients stay, time stays filled
	// Validates: Requirements 2.1, 2.2
	it("property 4: random reconfigures and failures never close a client unless the format changed, and a fill delivers one chunk per 20 ms", async () => {
		const h = await startHarness()
		type Op =
			| { kind: "offset"; hz: number }
			| { kind: "modulation"; value: "nfm" | "am" | "usb" }
			| { kind: "squelch"; db: number }
			| { kind: "bandwidth"; hz: number }
			| { kind: "format"; value: "s16le" | "f32le" }
			| { kind: "fail" }
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				kind: fc.constant("offset" as const),
				hz: fc.integer({ min: -100, max: 100 }).map(k => k * 1000),
			}),
			fc.record({
				kind: fc.constant("modulation" as const),
				value: fc.constantFrom("nfm" as const, "am" as const, "usb" as const),
			}),
			fc.record({
				kind: fc.constant("squelch" as const),
				db: fc.integer({ min: -100, max: -1 }),
			}),
			fc.record({
				kind: fc.constant("bandwidth" as const),
				hz: fc.constantFrom(10_000, 12_500, 50_000),
			}),
			fc.record({
				kind: fc.constant("format" as const),
				value: fc.constantFrom("s16le" as const, "f32le" as const),
			}),
			fc.record({ kind: fc.constant("fail" as const) }),
		)
		await fc.assert(
			fc.asyncProperty(
				op,
				fc.integer({ min: 0, max: 300 }),
				async (operation, waitMs) => {
					const { transport, client } = h.addClient()
					const formatBefore = { ...client.stream }
					if (operation.kind === "fail") {
						const spawned = h.processes.length
						h.current().front.exit(1)
						await waitFor(() => h.processes.length === spawned + 2)
						await waitFor(() => h.internals.run !== null)
					} else {
						const update =
							operation.kind === "offset"
								? { offsetHz: operation.hz }
								: operation.kind === "modulation"
									? { modulation: operation.value }
									: operation.kind === "squelch"
										? { squelch: operation.db }
										: operation.kind === "bandwidth"
											? { bandwidth: operation.hz }
											: { audioFormat: operation.value }
						const done = h.demod.reconfigure(update)
						// A pending swap times out on the injected clock (silent fakes).
						await delay(2)
						h.clock.advance(LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS)
						await done
					}
					await delay(2)
					const stream = h.internals.run!.stream
					const formatChanged =
						stream.rate !== formatBefore.rate ||
						stream.format !== formatBefore.format
					expect(transport.writableEnded).toBe(formatChanged)
					if (formatChanged) return
					// Silence is whole chunks of the stream format, all zero.
					const chunkBytes =
						Math.round((stream.rate * LIVE_AUDIO_SILENCE_CHUNK_MS) / 1000) *
						(stream.format === "s16le" ? 2 : 4)
					const filled = transport.received().length
					expect(filled % chunkBytes).toBe(0)
					const armedChunks = filled / chunkBytes
					h.clock.advance(waitMs)
					const after = transport.received().length / chunkBytes
					if (armedChunks > 0) {
						// One chunk per started 20 ms since the arm (the clock may
						// already be past the arm by the swap timeout).
						expect(after).toBeGreaterThanOrEqual(armedChunks)
						expect(after).toBeLessThanOrEqual(250)
						const expectedGrowth = Math.floor(waitMs / 20)
						expect(after - armedChunks).toBeGreaterThanOrEqual(
							expectedGrowth - 1,
						)
						expect(after - armedChunks).toBeLessThanOrEqual(expectedGrowth + 1)
					} else expect(after).toBe(0)
					expect(transport.received().every(b => b === 0)).toBe(true)
					transport.destroy()
					// Real audio ends any fill before the next case.
					await writeAndSettle(h.current().back.stdout, Buffer.alloc(8))
					expect(h.clock.pending).toBe(0)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
