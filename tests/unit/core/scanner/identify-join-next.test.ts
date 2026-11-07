/** Joining a running identify job needs wait left to cover the request, and the suggested tune must fit. */
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	IDENTIFY_JOIN_COVERED_FRACTION,
	IDENTIFY_QUEUE_WAIT_MS,
	IdentifyRunner,
	identifyTargetNextStep,
	identifyTuneCentreHz,
	identifyWaitCovered,
	inWindow,
	normaliseIdentify,
} from "../../../../src/core/scanner/identify.js"
import { DQ_DC_ADMIT_HZ } from "../../../../src/core/scanner/detection-quality-contract.js"
import { USABLE_FRACTION } from "../../../../src/core/spectrum/spectrum-engine.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyHarness,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync } from "../../../mocks/scanner/probe-fakes.js"

const ask = (over: Record<string, unknown> = {}) =>
	normaliseIdentify({
		target: { frequencyHz: TARGET_HZ },
		record: false,
		...over,
	})

describe("joining compares what is left with what is asked", () => {
	it("a silent 15 s job: a repeat at 1 500 ms joins, at 1 501 ms and at 14.9 s it does not", async () => {
		const h = identifyHarness({ request: { timeoutMs: 15_000 } })
		await h.runner.start()
		const started = h.record.startedAt ?? 0
		await h.advance(10)
		expect(h.runner.joins(ask({ timeoutMs: 15_000 }))).toBe(true)
		h.clock.now = started + 1500
		expect(h.runner.joins(ask({ timeoutMs: 15_000 }))).toBe(true)
		h.clock.now = started + 1501
		expect(h.runner.joins(ask({ timeoutMs: 15_000 }))).toBe(false)
		h.clock.now = started + 14_900
		expect(h.runner.joins(ask({ timeoutMs: 15_000 }))).toBe(false)
		// A short ask is still covered by what is left of the long wait.
		h.clock.now = started + 13_000
		expect(h.runner.joins(ask({ timeoutMs: 2000 }))).toBe(true)
		h.clock.now = started + 13_201
		expect(h.runner.joins(ask({ timeoutMs: 2000 }))).toBe(false)
	})

	it("a deadline that already passed covers nothing", async () => {
		const h = identifyHarness({ request: { timeoutMs: 1000 } })
		await h.runner.start()
		await h.advance(1000)
		await h.advance(10)
		expect(h.runner.joins(ask({ timeoutMs: 1000 }))).toBe(false)
	})

	it("a job with its signal joins whatever the clock says: its holds bound the trials", async () => {
		const h = identifyHarness({
			request: { timeoutMs: 1000, protocols: ["dmr"] },
		})
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99 })))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		expect(h.last()?.state).toBe("trying")
		h.clock.now += 900
		expect(h.runner.joins(ask({ timeoutMs: 1000, protocols: ["dmr"] }))).toBe(
			true,
		)
	})

	it("a job waiting for a gate compares its wait with the request's", async () => {
		const h = identifyHarness({
			request: { timeoutMs: 2000, waitUntilSignal: true, waitMs: 10_000 },
			gatedAt: () => null,
		})
		const waitAsk = ask({
			timeoutMs: 2000,
			waitUntilSignal: true,
			waitMs: 10_000,
		})
		await h.runner.start()
		const started = h.record.startedAt ?? 0
		await h.advance(10)
		h.clock.now = started + 1000
		expect(h.runner.joins(waitAsk)).toBe(true)
		h.clock.now = started + 1001
		expect(h.runner.joins(waitAsk)).toBe(false)
		// A plain request's timeoutMs must be covered by the wait too.
		h.clock.now = started + 8199
		expect(h.runner.joins(ask({ timeoutMs: 2000 }))).toBe(true)
		h.clock.now = started + 8201
		expect(h.runner.joins(ask({ timeoutMs: 2000 }))).toBe(false)
	})

	it("once a gate is taken its trials end at the gate's timeout, so that is what is left", () => {
		expect(
			identifyWaitCovered(ask({ timeoutMs: 1000 }), {
				ms: 1000 * IDENTIFY_JOIN_COVERED_FRACTION,
				awaitingGate: false,
			}),
		).toBe(true)
		expect(
			identifyWaitCovered(ask({ timeoutMs: 1000 }), {
				ms: 1000 * IDENTIFY_JOIN_COVERED_FRACTION - 1,
				awaitingGate: false,
			}),
		).toBe(false)
		expect(identifyWaitCovered(ask(), null)).toBe(true)
	})

	it("a new job queues for the taken slot, then answers could-not-test (budget)", async () => {
		const h = identifyHarness({
			request: { timeoutMs: 15_000, protocols: ["dmr"] },
		})
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99 })))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		expect(h.decoders.created.size).toBe(1)
		const record = { ...identifyRecord(), id: "j_second" }
		const events: { verdict?: unknown; state: string }[] = []
		const second = new IdentifyRunner({
			record,
			identify: ask({ timeoutMs: 15_000, protocols: ["dmr"] }),
			inner: fakeInner(record, () => h.clock.now),
			probes: h.pool,
			engine: () => h.engine,
			artefactAt: () => Promise.resolve(null),
			liveTracks: () => h.tracks,
			lastSummary: () => summaryOf(),
			discoveryOf: () => undefined,
			priorsAt: () => ({}),
			format: () => "U8_IQ",
			channelizer: () => false,
			settings: () => h.settings,
			emit: d => events.push(structuredClone(d)),
			logger: pino({ level: "silent" }),
			now: () => h.clock.now,
		})
		// Hold the first job's run past the queue wait: only the second ticks, and its slot never frees.
		const step = async (ms: number): Promise<void> => {
			h.clock.now += ms
			second.tick(h.clock.now)
			await flushAsync()
			await flushAsync()
		}
		await second.start()
		await step(100)
		await step(100)
		expect(h.decoders.created.size).toBe(1)
		await step(IDENTIFY_QUEUE_WAIT_MS - 1)
		expect(events.at(-1)?.state).toBe("trying")
		await step(1)
		await step(100)
		await step(100)
		expect(events.at(-1)).toMatchObject({
			verdict: { code: "could-not-test", why: "budget", protocol: "dmr" },
		})
		await second.dispose()
		await h.runner.dispose()
		await h.pool.destroy()
	})
})

describe("the suggested centre", () => {
	const HZ = 446_100_000

	it("225 001 Hz and 150 000 Hz: inside the window, past the DC exclusion", () => {
		const centre = identifyTuneCentreHz(HZ, { sampleRateHz: 225_001 }, 150_000)
		expect(centre).not.toBeNull()
		const offset = Math.abs(HZ - centre!)
		expect(offset).toBeGreaterThan(DQ_DC_ADMIT_HZ)
		// usable half span 90 000.4 Hz − 75 000 Hz of half bandwidth.
		expect(offset).toBeLessThanOrEqual(15_000)
		// The middle of 12 501 and 15 000.4.
		expect(offset).toBe(13_751)
	})

	it("no bandwidth keeps half the usable half span, at most 100 kHz", () => {
		expect(identifyTuneCentreHz(HZ, { sampleRateHz: 225_001 }, 0)).toBe(
			HZ - 45_000,
		)
		expect(identifyTuneCentreHz(HZ, { sampleRateHz: 1_024_000 }, 12_500)).toBe(
			HZ - 100_000,
		)
	})

	it("at and past the limit: room of 12 501 Hz fits, under it nothing does", () => {
		const sampleRateHz = 300_000 // usable half span 120 000 Hz
		const atLimit = (120_000 - 12_501) * 2
		expect(
			Math.abs(HZ - identifyTuneCentreHz(HZ, { sampleRateHz }, atLimit)!),
		).toBe(12_501)
		expect(identifyTuneCentreHz(HZ, { sampleRateHz }, atLimit + 2)).toBeNull()
	})

	it("next says no call helps instead of giving one that fails", () => {
		const target = { frequencyHz: HZ, bandwidthHz: 240_000 }
		const next = identifyTargetNextStep(
			"rtl",
			target,
			{ sampleRateHz: 300_000 },
			false,
		)
		expect(next).toEqual({
			effect: expect.stringContaining("No retune helps") as string,
		})
		expect(
			identifyTargetNextStep("rtl", target, { sampleRateHz: 2_048_000 }, true),
		).toMatchObject({
			method: "POST",
			body: { frequencyHz: HZ - 100_000, preempt: true },
		})
	})

	it("a target with its bandwidth, at every allowed rate", () => {
		// Feature: agent-identify, Property 1: suggested centre
		// Validates: identify next step
		fc.assert(
			fc.property(
				fc.oneof(
					fc.integer({ min: 225_001, max: 300_000 }),
					fc.integer({ min: 900_001, max: 3_200_000 }),
				),
				fc.option(fc.double({ min: 1, max: 1_000_000, noNaN: true }), {
					nil: undefined,
				}),
				fc.integer({ min: 24_000_000, max: 1_900_000_000 }),
				(sampleRateHz, bandwidthHz, frequencyHz) => {
					const bw = bandwidthHz ?? 0
					const centreHz = identifyTuneCentreHz(
						frequencyHz,
						{ sampleRateHz },
						bw,
					)
					const room = (sampleRateHz * USABLE_FRACTION) / 2 - bw / 2
					if (centreHz === null) {
						// Only when the room is at the limit, give or take the rounding.
						expect(room).toBeLessThan(DQ_DC_ADMIT_HZ + 2)
						return
					}
					expect(Math.abs(frequencyHz - centreHz)).toBeGreaterThan(
						DQ_DC_ADMIT_HZ,
					)
					expect(
						inWindow(
							frequencyHz,
							bw,
							{ centreHz, sampleRateHz },
							USABLE_FRACTION,
						),
					).toBe(true)
				},
			),
			{ numRuns: 500 },
		)
	})
})
