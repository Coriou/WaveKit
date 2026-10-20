import { describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import {
	poolHarness,
	probeRequest,
	flushAsync,
} from "../../../mocks/scanner/probe-fakes.js"
import { JOB_PROBE_MAX_WAIT_MS } from "../../../../src/core/scanner/scanner-redesign-contract.js"

describe("live job slot fairness", () => {
	it.each([6000, 6001])("yields at %i ms only with a waiter", async elapsed => {
		const h = poolHarness()
		h.pool.request(probeRequest({ trackId: "ambient" }))
		await flushAsync()
		h.clock.now += 5999
		h.pool.pump()
		expect(h.pool.status()[0]?.trackId).toBe("ambient")
		h.pool.request(probeRequest({ trackId: "waiting" }))
		await flushAsync()
		expect(h.pool.status()[0]?.trackId).toBe("ambient")
		h.clock.now = 1_000_000 + elapsed
		h.pool.pump()
		await flushAsync()
		expect(h.pool.status()[0]?.trackId).toBe("waiting")
		await h.pool.destroy()
	})

	it("keeps an uncontended probe even after two minutes", async () => {
		const h = poolHarness()
		h.pool.request(probeRequest({ trackId: "ambient" }))
		await flushAsync()
		h.clock.now += 120_001
		h.pool.pump()
		await flushAsync()
		expect(h.pool.status()[0]?.trackId).toBe("ambient")
		await h.pool.destroy()
	})

	it("caps a following probe without a voice recording hold", async () => {
		const h = poolHarness()
		const result = h.pool.request(probeRequest({ trackId: "ambient" }))
		await flushAsync()
		if (!("started" in result)) throw new TypeError("Expected a probe")
		h.pool.follow(result.started, true)
		h.pool.request(probeRequest({ trackId: "waiting" }))
		h.clock.now += 6000
		h.pool.pump()
		await flushAsync()
		expect(h.pool.status()[0]?.trackId).toBe("waiting")
		await h.pool.destroy()
	})

	it.each([
		[20, 19, true],
		[19.999, 19, false],
		[15, 5, true],
		[14.999, 5, false],
	])(
		"strong keyup %i dB against %i dB respects late entry",
		async (snrDb, held, preempts) => {
			const h = poolHarness()
			const began = h.clock.now
			h.pool.request(
				probeRequest({
					trackId: "ambient",
					targetHz: 446_093_000,
					admission: { kind: "undecoded", snrDb: held },
				}),
			)
			await flushAsync()
			h.pool.request(
				probeRequest({
					trackId: "keyup",
					targetHz: 446_056_250,
					gatePassedAt: began,
					admission: { kind: "undecoded", snrDb },
				}),
			)
			h.clock.now = began + 1799
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe("ambient")
			h.clock.now = began + 1800
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe(preempts ? "keyup" : "ambient")
			expect(h.clock.now - began).toBeLessThanOrEqual(2300)
			await h.pool.destroy()
		},
	)

	it.each([2300, 2301])(
		"retains strong eligibility after the mode timer fires before pumping at %i ms",
		async elapsed => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const h = poolHarness()
			try {
				const began = h.clock.now
				h.pool.request(
					probeRequest({
						trackId: "holder",
						admission: { kind: "undecoded", snrDb: 5 },
					}),
				)
				await flushAsync()
				const original = h.pool.status()[0]!
				h.pool.request(
					probeRequest({
						trackId: "waiter",
						gatePassedAt: began,
						admission: { kind: "undecoded", snrDb: 15 },
					}),
				)
				h.clock.now = began + 1800
				await vi.advanceTimersByTimeAsync(1800)
				await flushAsync()
				const successor = h.pool.status()[0]!
				expect(successor.probeId).toBe(original.probeId)
				expect(successor.decoderId).not.toBe(original.decoderId)
				expect(successor.state).toBe("confirming")
				h.clock.now = began + elapsed
				h.pool.pump()
				await flushAsync()
				expect(h.pool.status()[0]?.trackId).toBe("waiter")
			} finally {
				await h.pool.destroy()
				vi.useRealTimers()
			}
		},
	)

	it.each([null, 95])(
		"identify preempts immediately under CPU %s",
		async cpu => {
			const h = poolHarness()
			h.pool.request(probeRequest())
			await flushAsync()
			h.cpu.normalisedPercent = cpu
			h.pool.request(probeRequest({ trackId: "identify", priority: 101 }))
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe("identify")
			await h.pool.destroy()
		},
	)

	it.each([49, 50, 51, 101])(
		"protects identify and caps jobs with priority %i waiting",
		async priority => {
			const h = poolHarness()
			const began = h.clock.now
			h.pool.request(
				probeRequest({
					trackId: "holder",
					priority: priority === 101 ? 101 : 50,
				}),
			)
			await flushAsync()
			h.pool.request(
				probeRequest({
					trackId: "waiter",
					priority: priority === 101 ? 100 : priority,
				}),
			)
			h.clock.now = began + 6000
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe(
				priority === 101 ? "holder" : "waiter",
			)
			h.clock.now = began + 46001
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe(
				priority === 101 ? "holder" : "waiter",
			)
			await h.pool.destroy()
		},
	)

	it.each(["strong", "cap"])(
		"counts %s hold from delayed decoder readiness",
		async kind => {
			const h = poolHarness()
			const began = h.clock.now
			let ready!: () => void
			const gate = new Promise<void>(resolve => {
				ready = resolve
			})
			const create = h.decoders.createEphemeralDecoder.bind(h.decoders)
			vi.spyOn(h.decoders, "createEphemeralDecoder").mockImplementationOnce(
				async (...args) => {
					await gate
					return create(...args)
				},
			)
			h.pool.request(
				probeRequest({
					trackId: "holder",
					admission: { kind: "undecoded", snrDb: 5 },
				}),
			)
			await flushAsync()
			h.clock.now = began + 500
			ready()
			await flushAsync()
			h.pool.request(
				probeRequest({
					trackId: "waiter",
					gatePassedAt: began + 500,
					admission: { kind: "undecoded", snrDb: kind === "strong" ? 15 : 6 },
				}),
			)
			const hold = kind === "strong" ? 1800 : 6000
			h.clock.now = began + 500 + hold - 1
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe("holder")
			h.clock.now++
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe("waiter")
			await h.pool.destroy()
		},
	)

	it.each([2300, 2301])(
		"retains arrival eligibility through startup at %i ms",
		async elapsed => {
			const h = poolHarness()
			const began = h.clock.now
			let ready!: () => void
			const gate = new Promise<void>(resolve => {
				ready = resolve
			})
			const create = h.decoders.createEphemeralDecoder.bind(h.decoders)
			vi.spyOn(h.decoders, "createEphemeralDecoder").mockImplementationOnce(
				async (...args) => {
					await gate
					return create(...args)
				},
			)
			h.pool.request(
				probeRequest({
					trackId: "holder",
					admission: { kind: "undecoded", snrDb: 5 },
				}),
			)
			h.pool.request(
				probeRequest({
					trackId: "waiter",
					gatePassedAt: began,
					admission: { kind: "undecoded", snrDb: 20 },
				}),
			)
			await flushAsync()
			h.clock.now = began + 500
			ready()
			await flushAsync()
			h.clock.now = began + 2299
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe("holder")
			h.clock.now = began + elapsed
			h.pool.pump()
			await flushAsync()
			expect(h.pool.status()[0]?.trackId).toBe("waiter")
			await h.pool.destroy()
		},
	)

	it.each([false, true])(
		"evicts only one holder through delayed teardown (closed=%s)",
		async closed => {
			const h = poolHarness()
			h.settings.maxProbes.offset = 2
			h.settings.cpuBudgetCores = 64
			h.pool.request(probeRequest({ trackId: "holder-1" }))
			h.pool.request(probeRequest({ trackId: "holder-2" }))
			await flushAsync()
			expect(h.pool.status()).toHaveLength(2)
			let removed!: () => void
			h.decoders.removeGate = new Promise<void>(resolve => {
				removed = resolve
			})
			h.pool.request(probeRequest({ trackId: "waiter", priority: 101 }))
			await flushAsync()
			for (let i = 0; i < 5; i++) h.pool.pump()
			expect(h.pool.status().filter(r => r.state === "stopping")).toHaveLength(
				1,
			)
			if (closed) {
				h.pool.trackClosed("waiter")
				h.pool.request(probeRequest({ trackId: "replacement" }))
				for (let i = 0; i < 5; i++) h.pool.pump()
				expect(
					h.pool.status().filter(r => r.state === "stopping"),
				).toHaveLength(1)
			}
			removed()
			await flushAsync()
			expect(
				h.pool
					.status()
					.map(r => r.trackId)
					.sort(),
			).toEqual(["holder-2", closed ? "replacement" : "waiter"].sort())
			expect(h.decoders.removed).toHaveLength(1)
			await h.pool.destroy()
		},
	)

	// Feature: scanner-redesign, Property 20: bounded strong candidate admission
	// Validates: Requirements 6.8
	it("reserves the strong keyup handoff ahead of an older louder waiter", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 9 }),
				fc.integer({ min: 1, max: 9 }),
				async (held, extra) => {
					const h = poolHarness()
					const began = h.clock.now
					h.pool.request(
						probeRequest({
							trackId: "ambient",
							admission: { kind: "undecoded", snrDb: held },
						}),
					)
					await flushAsync()
					h.pool.request(
						probeRequest({
							trackId: "older",
							admission: { kind: "undecoded", snrDb: held + 10 + extra },
						}),
					)
					h.pool.request(
						probeRequest({
							trackId: "keyup",
							gatePassedAt: began,
							admission: { kind: "undecoded", snrDb: held + 10 },
						}),
					)
					h.clock.now = began + 1800
					h.pool.pump()
					await flushAsync()
					expect(h.pool.status()[0]?.trackId).toBe("keyup")
					h.clock.now = began + 2301
					h.pool.pump()
					await flushAsync()
					expect(h.pool.status()[0]?.trackId).toBe("keyup")
					await h.pool.destroy()
				},
			),
			{ numRuns: 100, examples: [[5, 4]] },
		)
	})

	// Feature: scanner-redesign, Property 20: bounded candidate waiting
	// Validates: Requirements 6.8
	it("serves eight candidates in aging order within the bound", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						snrDb: fc.integer({ min: 1, max: 19 }),
						priority: fc.integer({ min: 1, max: 100 }),
					}),
					{
						minLength: 8,
						maxLength: 8,
					},
				),
				async snrs => {
					const h = poolHarness()
					const began = h.clock.now
					const requests = snrs.map(({ snrDb, priority }, i) =>
						probeRequest({
							trackId: `t${i}`,
							priority,
							admission: { kind: "undecoded", snrDb },
						}),
					)
					h.pool.request(requests[0]!)
					await flushAsync()
					for (const req of requests.slice(1)) h.pool.request(req)
					await flushAsync()
					const seen = new Set<string>([requests[0]!.trackId])
					if (h.pool.status()[0]?.trackId === requests[0]!.trackId) {
						h.clock.now += 6500
						h.pool.pump()
					}
					for (let i = 1; i < 8; i++) {
						await flushAsync()
						const current = h.pool.status()[0]!
						expect(
							seen.has(current.trackId),
							JSON.stringify({ current: current.trackId, seen: [...seen], i }),
						).toBe(false)
						seen.add(current.trackId)
						expect(h.clock.now - began).toBeLessThanOrEqual(
							JOB_PROBE_MAX_WAIT_MS,
						)
						if (i === 7) break
						// Repeated ambient keying cannot jump ahead of never-served tracks.
						h.clock.now += 6500
						h.pool.pump()
						await flushAsync()
						h.pool.request(requests.find(r => r.trackId === current.trackId)!)
					}
					expect(seen.size).toBe(8)
					// One millisecond past the maximum wait, every original candidate has run.
					h.clock.now = began + JOB_PROBE_MAX_WAIT_MS + 1
					h.pool.pump()
					await flushAsync()
					expect(seen.size).toBe(8)
					await h.pool.destroy()
				},
			),
			{ numRuns: 100 },
		)
	})
})
