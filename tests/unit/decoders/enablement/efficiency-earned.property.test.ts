import { expect, it } from "vitest"
import fc from "fast-check"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { EFFICIENCY_CLEAR_MS } from "../../../../src/decoders/enablement/contract.js"
import type { WantedPlacement } from "../../../../src/decoders/enablement/contract.js"

const newcomer = (sourceId: string): WantedPlacement => ({
	key: `new#raw@${sourceId}`,
	decoderId: "new",
	sourceId,
	channelHz: null,
	reach: "raw",
	origin: "band",
	primary: true,
	costCores: 0.1,
	sampleRateHz: 2400000,
})

// Feature: decoder-enablement, Property 8: Unknown is never drop-free
// Validates: Requirements 4.6, 4.1
it("checks every transition from earned cleanliness and delivers every produced drop", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.constantFrom(
					"clean",
					"drop",
					"chunk peek throw",
					"partial",
					"reset",
					"topology",
					"prune",
					"backdated",
					"malformed",
					"throw once",
					"throw twice",
					"reentrant",
				),
				{ minLength: 1, maxLength: 60 },
			),
			events => {
				const gate = createEfficiencyGate({
					budgetCores: 1.5,
					cpuGuardPercent: 90,
				})
				let now = 0
				let barrier = 0
				let bytes = 0
				let chunks = 0
				let present = true
				let unreadable = false
				let throws = 0
				let reentrant = false
				let tick: () => void = () => {}
				let deliveredBytes = 0
				let deliveredChunks = 0
				const check = () => {
					gate.forget(newcomer("a").key)
					if (now - barrier < EFFICIENCY_CLEAR_MS) {
						expect(gate.admit(newcomer("a"), [], now).admit).toBe(false)
						expect(
							gate.view([], [], now).sources.find(s => s.sourceId === "a")
								?.drops,
						).not.toBe("ok")
					}
				}
				const monitor = createEfficiencyMonitor({
					sources: () => (present ? ["a"] : []),
					dropTotals: () => {
						if (unreadable) {
							unreadable = false
							throw new TypeError("unreadable")
						}
						return { droppedBytesTotal: bytes, droppedChunksTotal: chunks }
					},
					cpu: { normalisedPercent: 10 },
					now: () => now,
					setInterval: fn => {
						tick = fn
						return { cancel() {} }
					},
					onSample: sample => {
						if (throws > 0) {
							throws--
							throw new TypeError("delivery")
						}
						gate.record(sample)
						deliveredBytes += sample.sources.get("a")?.droppedBytesDelta ?? 0
						deliveredChunks += sample.sources.get("a")?.droppedChunksDelta ?? 0
						if (reentrant) {
							reentrant = false
							bytes += 100
							chunks += 1
							monitor.sampleNow()
							bytes = 0
							chunks = 0
							// Delivery is still in progress: the bounded follow-up closes
							// the gate before the timer tick returns.
						}
					},
				})
				monitor.start()
				for (; now <= 62000; now += 2000) tick()
				now -= 2000
				expect(gate.view([], [], now).sources[0]?.drops).toBe("ok")
				for (const event of events) {
					now += 2000
					const before = deliveredBytes
					const chunksBefore = deliveredChunks
					if (event !== "clean") barrier = now
					if (event === "drop") {
						bytes += 100
						chunks += 1
					}
					if (event === "chunk peek throw") {
						chunks += 1
						monitor.sampleNow()
						unreadable = true
						monitor.sampleNow()
						chunks = 0
					}
					if (event === "partial") {
						bytes += 100
						chunks = NaN
					}
					if (event === "reset") {
						bytes = 0
						chunks = 0
						unreadable = true
					}
					if (event === "topology") unreadable = true
					if (event === "prune") present = false
					if (event === "throw once") throws = 1
					if (event === "throw twice") throws = 2
					if (event === "reentrant") reentrant = true
					tick()
					if (event === "backdated" || event === "malformed") {
						gate.record({
							atMs: 0,
							cpuPercent: 10,
							sources:
								event === "backdated"
									? new Map()
									: ({} as unknown as Map<
											string,
											{ droppedBytesDelta: number; droppedChunksDelta: number }
										>),
						})
					}
					if (event === "throw twice") {
						// Both callbacks reject all evidence. Freshness must close the
						// previously earned gate even without another successful tick.
						expect(gate.admit(newcomer("a"), [], now + 6000).admit).toBe(false)
						expect(gate.view([], [], now + 6000).sources[0]?.drops).not.toBe(
							"ok",
						)
					} else check()
					if (event === "chunk peek throw")
						expect(deliveredChunks - chunksBefore).toBeGreaterThanOrEqual(1)
					if (event === "drop" || event === "partial" || event === "reentrant")
						expect(deliveredBytes - before).toBeGreaterThanOrEqual(100)
					present = true
					if (!Number.isFinite(chunks)) chunks = 0
					now += 2000
					tick()
					check()
				}
				for (let i = 0; i < 34; i++) {
					now += 2000
					tick()
					check()
				}
				gate.forget(newcomer("a").key)
				expect(gate.admit(newcomer("a"), [], now)).toEqual({ admit: true })
				monitor.stop()
			},
		),
		{ numRuns: 200 },
	)
})

// Feature: decoder-enablement, Property 8: Unknown is never drop-free
// Validates: Requirements 4.6, 4.1
it("arbitrary far-future samples keep admission closed", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1000000, max: Number.MAX_SAFE_INTEGER }),
			future => {
				const gate = createEfficiencyGate({
					budgetCores: 1.5,
					cpuGuardPercent: 90,
				})
				const record = (atMs: number) =>
					gate.record({
						atMs,
						cpuPercent: 10,
						sources: new Map([
							["a", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
						]),
					})
				for (let at = 0; at <= 60000; at += 2000) record(at)
				record(future)
				record(62000)
				expect(gate.admit(newcomer("a"), [], 62000).admit).toBe(false)
				for (let at = 64000; at <= 124000; at += 2000) {
					record(at)
					gate.forget(newcomer("a").key)
					expect(gate.admit(newcomer("a"), [], at).admit).toBe(false)
				}
			},
		),
		{ numRuns: 200 },
	)
})
