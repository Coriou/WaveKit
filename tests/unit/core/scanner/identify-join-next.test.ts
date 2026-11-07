/** Joining a running identify job needs wait left to cover the request, and the suggested tune must fit. */
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	IDENTIFY_IQ_FRESH_BLOCKS,
	IDENTIFY_JOIN_COVERED_FRACTION,
	IDENTIFY_NEARBY_HZ,
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
import { TUNER_VALUE_BOUNDS } from "../../../../src/core/tuner-controller.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyHarness,
	identifyRecord,
	quietSummaryOf,
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
	})

	it("a plain request never joins a job blocked on a gate, however much wait is left", async () => {
		const h = identifyHarness({
			request: { timeoutMs: 2000, waitUntilSignal: true, waitMs: 10_000 },
			gatedAt: () => null,
		})
		await h.runner.start()
		await h.advance(10)
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
	const { min, max } = TUNER_VALUE_BOUNDS.frequency

	it("near the lower edge it goes up; at the edge it stays a value the tuner takes", () => {
		const window = { sampleRateHz: 1_024_000 }
		expect(identifyTuneCentreHz(24_050_000, window)).toBe(24_150_000)
		expect(identifyTuneCentreHz(min, window)).toBe(min + 100_000)
		expect(identifyTuneCentreHz(min + 100_000, window)).toBe(min)
		expect(identifyTuneCentreHz(min + 99_999, window)).toBe(min + 199_999)
		expect(identifyTuneCentreHz(max, window)).toBe(max - 100_000)
	})

	it("a target outside the tuner's range has no centre, and next says why", () => {
		const window = { sampleRateHz: 1_024_000 }
		for (const hz of [150_000, min - 1, max + 1]) {
			expect(identifyTuneCentreHz(hz, window)).toBeNull()
			expect(
				identifyTargetNextStep("rtl", { frequencyHz: hz }, window, false),
			).toEqual({
				effect: expect.stringContaining("the tuner reaches") as string,
			})
		}
	})

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
					expect(centreHz).toBeGreaterThanOrEqual(min)
					expect(centreHz).toBeLessThanOrEqual(max)
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

describe("nothing through the runner", () => {
	// Feature: identify verdict, bounds of IDENTIFY_IQ_FRESH_BLOCKS and IDENTIFY_NEARBY_HZ
	const silent = (over: Parameters<typeof identifyHarness>[0] = {}) =>
		identifyHarness({
			request: { timeoutMs: 1000, protocols: ["dmr"] },
			...over,
		})
	const finish = async (h: ReturnType<typeof silent>, ms = 1000) => {
		await h.runner.start()
		await h.advance(10)
		await h.advance(ms)
		await flushAsync()
		await h.advance(10)
	}

	it("blocks through the deadline, a quiet target and no track: nothing", async () => {
		const h = silent()
		h.state.summary = quietSummaryOf()
		await finish(h)
		expect(h.last()?.verdict).toEqual({ code: "nothing", protocol: "dmr" })
		await h.pool.destroy()
	})

	it("the verdict is fixed when the target ends: a later read does not age it", async () => {
		const h = silent()
		h.state.summary = quietSummaryOf()
		await finish(h)
		h.clock.now += 600_000
		expect(h.runner.view().targets[0]?.verdict?.code).toBe("nothing")
		await h.pool.destroy()
	})

	it("blocks that stopped: no-samples, whatever the last block measured", async () => {
		const h = silent()
		h.state.summary = quietSummaryOf()
		await h.runner.start()
		await h.advance(100)
		h.state.iqFlowing = false
		await h.advance(1000)
		await flushAsync()
		await h.advance(10)
		expect(h.last()?.verdict).toEqual({
			code: "could-not-test",
			why: "no-samples",
			protocol: "dmr",
		})
		await h.pool.destroy()
	})

	it.each([
		["no block at all", []],
		["one block that never advanced", [1000]],
		["a repeated end sample", [1000, 1000]],
	])("%s: no-samples", async (_name, blocks) => {
		const h = silent()
		h.state.summary = quietSummaryOf()
		h.state.iqFlowing = false
		await h.runner.start()
		await h.advance(10)
		for (const endSample of blocks) h.runner.onBlock(endSample, false)
		await h.advance(1000)
		await flushAsync()
		await h.advance(10)
		expect(h.last()?.verdict?.why).toBe("no-samples")
		await h.pool.destroy()
	})

	it.each([
		[IDENTIFY_IQ_FRESH_BLOCKS * 50, "nothing"],
		[IDENTIFY_IQ_FRESH_BLOCKS * 50 + 1, "could-not-test"],
	] as const)(
		"the newest block %i ms old when the wait ends: %s",
		async (ageMs, code) => {
			const h = silent()
			h.state.summary = quietSummaryOf()
			h.state.iqFlowing = false
			await h.runner.start()
			const deadline = (h.record.startedAt ?? 0) + 1000
			await h.advance(10)
			let endSample = 0
			for (let at = h.clock.now; at < deadline - ageMs; at += 50) {
				h.clock.now = at
				endSample += 1000
				h.runner.onBlock(endSample, false)
			}
			h.clock.now = deadline - ageMs
			h.runner.onBlock(endSample + 1000, false)
			h.clock.now = deadline
			h.runner.tick(h.clock.now)
			await flushAsync()
			await flushAsync()
			expect(h.last()?.verdict?.code).toBe(code)
			await h.pool.destroy()
		},
	)

	it("a gap inside the wait is no proof, even with blocks at the deadline", async () => {
		const h = silent()
		h.state.summary = quietSummaryOf()
		await h.runner.start()
		await h.advance(100)
		h.clock.now += 501
		h.runner.onBlock(99_999_999, false)
		await h.advance(1000)
		await flushAsync()
		await h.advance(10)
		expect(h.last()?.verdict?.why).toBe("no-samples")
		await h.pool.destroy()
	})

	it.each([
		[1500, "could-not-test"],
		[IDENTIFY_NEARBY_HZ, "could-not-test"],
		[IDENTIFY_NEARBY_HZ + 1, "nothing"],
	])("a live track %i Hz off the target: %s", async (offsetHz, code) => {
		const h = silent()
		h.state.summary = quietSummaryOf()
		h.tracks.push(viewOf(trackOf({ centreHz: TARGET_HZ + offsetHz })))
		await finish(h)
		expect(h.last()?.verdict?.code).toBe(code)
		if (code === "could-not-test") {
			expect(h.last()?.verdict?.why).toBe("signal-nearby")
			expect(h.last()?.result?.nearbyHz).toBe(TARGET_HZ + offsetHz)
		} else expect(h.last()?.result?.nearbyHz).toBeUndefined()
		await h.pool.destroy()
	})

	it("a spur or an image close by is no signal", async () => {
		const h = silent()
		h.state.summary = quietSummaryOf()
		const track = trackOf({ centreHz: TARGET_HZ + 1500 })
		h.tracks.push(viewOf({ ...track, flags: { ...track.flags, spur: true } }))
		await finish(h)
		expect(h.last()?.verdict?.code).toBe("nothing")
		await h.pool.destroy()
	})

	it("a level at the target with no track names the bin", async () => {
		const h = silent()
		await finish(h)
		expect(h.last()?.result?.measurements.snrDb).toBe(30)
		expect(h.last()?.verdict?.why).toBe("signal-nearby")
		expect(
			Math.abs((h.last()?.result?.nearbyHz ?? 0) - TARGET_HZ),
		).toBeLessThanOrEqual(2000)
		await h.pool.destroy()
	})

	it("a gate that never opened on a track that is live: signal-nearby, not nothing", async () => {
		const h = identifyHarness({
			request: {
				protocols: ["dmr"],
				waitUntilSignal: true,
				waitMs: 1000,
			},
			gatedAt: () => null,
		})
		h.state.summary = quietSummaryOf()
		h.tracks.push(viewOf(trackOf({})))
		await finish(h)
		expect(h.last()?.result?.ended).toBe("no-signal")
		expect(h.last()?.verdict?.why).toBe("signal-nearby")
		await h.pool.destroy()
	})
})
