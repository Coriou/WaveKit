/**
 * WG11 identify lane wiring in the scanner service: narrowRasterAt and the known-protocol memory
 * reach the identify runner and every job driver (req 1.3, 1.7), the memory forgets deleted
 * discoveries (a merge's loser is reported deleted; the survivor keeps its count), cancel of an
 * ended job skips arbitration (req 1.6) and a sweep silent at the frequency takes the band plan's
 * ISM prior (req 1.4).
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	bandplansFor,
	type Bandplan,
} from "../../../../src/core/scanner/bandplan/index.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import type { JobDriver } from "../../../../src/core/scanner/job-runner.js"
import type { KnownProtocolMemory } from "../../../../src/core/scanner/known-protocol-contract.js"
import type {
	ScannerProtocol,
	ScanRange,
} from "../../../../src/core/scanner/types.js"
import { makeNormalisedSpec } from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	vi.useRealTimers()
	for (const c of cleanups.splice(0).reverse()) await c()
})

const NARROW: ScanRange = {
	startHz: CENTRE - 50_000,
	endHz: CENTRE + 50_000,
	protocols: ["dmr"],
	rasters: [{ spacingHz: 6250, firstChannelHz: CENTRE }],
}
const plan: Bandplan = {
	id: "t",
	region: "all",
	name: "t",
	ranges: [NARROW],
}

function harness(opts: Parameters<typeof serviceHarness>[0] = {}) {
	const h = serviceHarness({
		bandplans: () => [plan],
		patch: s => {
			s.passive.enabled = false
		},
		...opts,
	})
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	return h
}
interface Internals {
	drivers: Map<string, JobDriver>
	knownProtocols: KnownProtocolMemory
	onStoreChange: (id: string, change: string) => void
	onStoreEvicted: (d: { id: string }[]) => void
	classifierContext: (
		sourceId: string,
		hz: number,
	) => {
		priors: Partial<Record<ScannerProtocol, number>>
		protocols: ScannerProtocol[]
	}
	driversOn: (sourceId: string) => JobDriver[]
	arbitrate: (...a: unknown[]) => Promise<void>
	updateMasks: (...a: unknown[]) => void
	persistJobs: () => Promise<void>
}
const internals = (h: ReturnType<typeof harness>): Internals =>
	h.service as unknown as Internals
const depsOf = (h: ReturnType<typeof harness>, id: string) =>
	(internals(h).drivers.get(id) as unknown as { deps: Record<string, unknown> })
		.deps

describe("ScannerService WG11 identify wiring", () => {
	it("passes narrowRasterAt and the shared memory to the identify runner and its inner driver", async () => {
		const h = harness()
		await h.service.start()
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE },
			timeoutMs: 1000,
		})
		const deps = depsOf(h, job.id)
		const at = deps["narrowRasterAt"] as (hz: number) => boolean
		expect(at(CENTRE)).toBe(true)
		expect(at(CENTRE + 1_000_000)).toBe(false)
		const memory = internals(h).knownProtocols
		expect(deps["knownProtocols"]).toBe(memory)
		const inner = (deps["inner"] as { deps: Record<string, unknown> }).deps
		expect(inner["knownProtocols"]).toBe(memory)
	})

	it("passes the memory to a plain job driver", async () => {
		const h = harness()
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: CENTRE - 10_000, endHz: CENTRE + 10_000 }],
		})
		expect(depsOf(h, job.id)["knownProtocols"]).toBe(
			internals(h).knownProtocols,
		)
	})

	it("forgets a deleted or evicted discovery, never a merge survivor", () => {
		const h = harness()
		const forget = vi.spyOn(internals(h).knownProtocols, "forget")
		internals(h).onStoreChange("d1", "deleted")
		internals(h).onStoreChange("d2", "merged")
		internals(h).onStoreChange("d3", "updated")
		internals(h).onStoreEvicted([{ id: "d4" }])
		// discovery-store mergeInto: mark(drop, "deleted"), mark(keep, "merged"): d2 is the survivor.
		expect(forget.mock.calls.map(c => c[0])).toEqual(["d1", "d4"])
	})

	it("cancel of an ended job returns it unchanged without arbitration, masks or persist", async () => {
		vi.useFakeTimers()
		const h = harness()
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: CENTRE - 10_000, endHz: CENTRE + 10_000 }],
		})
		const ended = await h.service.cancelJob(job.id)
		expect(ended.state).toBe("cancelled")
		const arbitrate = vi.spyOn(internals(h), "arbitrate")
		const masks = vi.spyOn(internals(h), "updateMasks")
		const persist = vi.spyOn(internals(h), "persistJobs")
		const again = await h.service.cancelJob(job.id)
		expect(again).toEqual(ended)
		expect(arbitrate).toHaveBeenCalledTimes(0)
		expect(masks).toHaveBeenCalledTimes(0)
		expect(persist).toHaveBeenCalledTimes(0)
	})

	/** One covering driver of `mode` whose ranges list no protocols (the 135-174 MHz band scan). */
	const coveredBy = (
		h: ReturnType<typeof harness>,
		mode: "sweep" | "in-window",
	) =>
		vi.spyOn(internals(h), "driversOn").mockReturnValue([
			{
				covers: () => true,
				record: {
					spec: makeNormalisedSpec({
						sourceId: "rtl",
						mode,
						ranges: [{ startHz: 100_000_000, endHz: 500_000_000 }],
					}),
				},
			} as unknown as JobDriver,
		])

	it("fills the band plan ISM prior only for a sweep silent at the frequency (review M1)", async () => {
		const h = harness()
		await h.service.start()
		// Nothing covering (passive off) or an in-window job: today's priors.
		expect(internals(h).classifierContext("rtl", CENTRE).priors["ism"]).toBe(
			undefined,
		)
		coveredBy(h, "in-window")
		expect(internals(h).classifierContext("rtl", CENTRE).priors["ism"]).toBe(
			undefined,
		)
		coveredBy(h, "sweep")
		expect(internals(h).classifierContext("rtl", CENTRE).priors["ism"]).toBe(
			0.25,
		)
	})

	it("433.92 MHz OOK stays ook-burst: US outside and inside a sweep, EU in a sweep (review M1, round 2)", async () => {
		const OOK = 433_920_000
		const ook = makeTrack({ id: "ook", centreHz: OOK, startedAt: 0, blocks: 3 })
		const us = harness({ bandplans: () => bandplansFor("US") })
		await us.service.start()
		const usSilent = internals(us).classifierContext("rtl", OOK)
		expect(classifySpectral(ook, usSilent).class).toBe("ook-burst")
		coveredBy(us, "in-window")
		const usWindow = internals(us).classifierContext("rtl", OOK)
		expect(classifySpectral(ook, usWindow).class).toBe("ook-burst")
		// Review round 2: a US sweep across 433.92 MHz (inside 433.05-434.79 MHz) never fills either.
		coveredBy(us, "sweep")
		const usSweep = internals(us).classifierContext("rtl", OOK)
		expect(usSweep.priors["ism"]).toBe(undefined)
		expect(classifySpectral(ook, usSweep).class).toBe("ook-burst")
		const eu = harness({ bandplans: () => bandplansFor("EU") })
		await eu.service.start()
		coveredBy(eu, "sweep")
		const euSweep = internals(eu).classifierContext("rtl", OOK)
		expect(classifySpectral(ook, euSweep).class).toBe("ook-burst")
	})

	it("the sweep DMR case (135-174 MHz, no protocols) still classifies probe-able", async () => {
		const h = harness({ bandplans: () => bandplansFor("EU") })
		await h.service.start()
		coveredBy(h, "sweep")
		const young = makeTrack({
			id: "dmr",
			centreHz: 150_012_500,
			startedAt: 0,
			blocks: 3,
		})
		const ctx = internals(h).classifierContext("rtl", 150_012_500)
		expect(ctx.priors["ism"]).toBe(0.25)
		expect(classifySpectral(young, ctx).class).toBe("fsk4-12k5")
	})

	it("leaves a protocol-listing job alone", async () => {
		const h = harness()
		await h.service.start()
		await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [
				{
					startHz: CENTRE - 10_000,
					endHz: CENTRE + 10_000,
					protocols: ["dmr"],
				},
			],
		})
		const listed = internals(h).classifierContext("rtl", CENTRE)
		expect(listed.protocols).toEqual(["dmr"])
		expect(listed.priors["ism"]).toBe(0)
	})
})
