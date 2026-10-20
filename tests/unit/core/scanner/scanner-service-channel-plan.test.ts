import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SpectrumService } from "../../../../src/core/spectrum/spectrum-service.js"
import {
	CHANNEL_GATE_DEFAULT_WIDTH_HZ,
	type ChannelPlan,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	ScanJobSpec,
	ScanRange,
} from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import {
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

// WG12 scanner redesign: the scanner's channel plan and gate-aware ingest
// (requirements 2.1, 2.5, 4.1). Runs against the patched scanner service.

type Harness = ReturnType<typeof serviceHarness>

interface Internals {
	onTrack(
		sourceId: string,
		ev: {
			kind: "track-open" | "track-update" | "track-close"
			track: TrackSnapshot
			endReason?: string
		},
	): void
	live: Map<string, { observationId: string }>
	jobs: Map<string, { counts: { observations: number; transients: number } }>
	spectrum: SpectrumService
	drivers: Map<string, { onTrack(...args: unknown[]): void }>
	needsConfirm(live: unknown, track: TrackSnapshot): boolean
	channelPlanOf(sourceId: string): ChannelPlan | null
}

const noPassive = (s: { passive: { enabled: boolean } }): void => {
	s.passive.enabled = false
}

const R0 = { startHz: 446_000_000, endHz: 446_050_000 }
const R1 = { startHz: 446_100_000, endHz: 446_150_000 }
const R2 = { startHz: 446_200_000, endHz: 446_250_000 }

const harnesses: Harness[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const h of harnesses.splice(0)) {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

function setup(passive = false): {
	h: Harness
	plans: (ChannelPlan | null)[]
	internals: Internals
} {
	const plans: (ChannelPlan | null)[] = []
	const orig = SpectrumService.prototype.setChannelPlan
	vi.spyOn(SpectrumService.prototype, "setChannelPlan").mockImplementation(
		function (this: SpectrumService, sourceId, plan) {
			if (sourceId === "rtl") plans.push(plan)
			orig.call(this, sourceId, plan)
		},
	)
	const h = serviceHarness(passive ? {} : { patch: noPassive })
	harnesses.push(h)
	return { h, plans, internals: h.service as unknown as Internals }
}

async function untilRunning(h: Harness, id: string, seed = 20): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await settled(h.service)
}

async function startJob(
	h: Harness,
	ranges: ScanRange[],
	extra: Partial<ScanJobSpec> = {},
): Promise<string> {
	await h.service.start()
	const job = await h.service.createJob({
		sourceId: "rtl",
		mode: "in-window",
		ranges,
		priority: 50,
		takeover: true,
		resume: { autoAfterIdleMs: null },
		...extra,
	})
	await untilRunning(h, job.id)
	return job.id
}

function track(
	id: string,
	gate: TrackSnapshot["gate"] | undefined,
	centreHz = 446_025_000,
): TrackSnapshot {
	const t = makeTrack({ id, centreHz, startedAt: 0, sourceId: "rtl" })
	return gate === undefined ? t : { ...t, gate }
}

describe("ScannerService channel plan (WG12 R 2.1)", () => {
	it("job start sends a plan with one entry per enabled range, widths clamped", async () => {
		const { h, plans } = setup()
		await startJob(h, [
			{ ...R0, obwHz: [16_000] },
			{ ...R1, rasters: [{ spacingHz: 25_000, firstChannelHz: 446_112_500 }] },
			{ ...R2, enabled: false },
			{ startHz: 446_300_000, endHz: 446_350_000 },
		])
		const plan = plans.at(-1)
		expect(plan).not.toBeNull()
		expect(plan!.sourceId).toBe("rtl")
		expect(plan!.defaultWidthHz).toBe(CHANNEL_GATE_DEFAULT_WIDTH_HZ)
		const byKey = new Map(plan!.entries.map(e => [e.rangeKey, e]))
		expect(plan!.entries).toHaveLength(byKey.size)
		expect(byKey.has(`${R2.startHz}:${R2.endHz}`)).toBe(false)
		const e0 = byKey.get(`${R0.startHz}:${R0.endHz}`)!
		expect(e0.widthHz).toBe(16_000)
		const e1 = byKey.get(`${R1.startHz}:${R1.endHz}`)!
		expect(e1).toMatchObject({
			widthHz: 25_000,
			rasterHz: 25_000,
			firstChannelHz: 446_112_500,
		})
		for (const e of plan!.entries) {
			expect(e.widthHz).toBeGreaterThanOrEqual(6_250)
			expect(e.widthHz).toBeLessThanOrEqual(200_000)
			expect(e.rangeKey).toBe(`${Math.round(e.startHz)}:${Math.round(e.endHz)}`)
			if (e.rasterHz === null) expect(e.firstChannelHz).toBeNull()
		}
	})

	it("obwHz 3000 clamps to 6250; 500000 clamps to 200000", async () => {
		const { h, plans } = setup()
		await startJob(h, [
			{ ...R0, obwHz: [3_000] },
			{ ...R1, obwHz: [500_000] },
		])
		const byKey = new Map(plans.at(-1)!.entries.map(e => [e.rangeKey, e]))
		expect(byKey.get(`${R0.startHz}:${R0.endHz}`)!.widthHz).toBe(6_250)
		expect(byKey.get(`${R1.startHz}:${R1.endHz}`)!.widthHz).toBe(200_000)
	})

	it("burst follows the burstRanges protocol rule (A11)", async () => {
		const { h, plans } = setup()
		await startJob(h, [
			{ ...R0, protocols: ["pocsag"] },
			{ ...R1, protocols: ["dmr"] },
		])
		const byKey = new Map(plans.at(-1)!.entries.map(e => [e.rangeKey, e]))
		expect(byKey.get(`${R0.startHz}:${R0.endHz}`)!.burst).toBe(true)
		expect(byKey.get(`${R1.startHz}:${R1.endHz}`)!.burst).toBe(false)
	})

	it("Range edit resends the plan", async () => {
		const { h, plans } = setup()
		const id = await startJob(h, [R0, R1])
		const keys = (p: ChannelPlan | null | undefined): string[] =>
			(p?.entries ?? []).map(e => e.rangeKey)
		expect(keys(plans.at(-1))).toContain(`${R1.startHz}:${R1.endHz}`)
		const before = plans.length
		const [c0, c1] = h.service.getJob(id)!.spec.ranges as [ScanRange, ScanRange]
		const res = await h.service.patchJob(id, {
			ranges: [c0, { ...c1, enabled: false }],
		})
		expect(res.issues.filter(i => i.severity === "error")).toEqual([])
		await settled(h.service)
		expect(plans.length).toBeGreaterThan(before)
		expect(keys(plans.at(-1))).toEqual([`${R0.startHz}:${R0.endHz}`])
	})

	it("Stop of the last job sends null", async () => {
		const { h, plans, internals } = setup()
		const id = await startJob(h, [R0])
		// A display consumer keeps the engine up after the job ends (else it simply closes).
		await internals.spectrum.acquire("rtl", "ws:test")
		expect(plans.at(-1)).not.toBeNull()
		await h.service.cancelJob(id)
		await settled(h.service)
		expect(plans.at(-1)).toBeNull()
		expect(internals.channelPlanOf("rtl")).toBeNull()
	})

	it("the passive job's band-plan ranges are in the plan", async () => {
		const { h, internals } = setup(true)
		await h.service.start()
		await settled(h.service)
		const passive = h.service.getJob("passive-rtl")
		expect(passive).toBeDefined()
		const plan = internals.channelPlanOf("rtl")
		expect(plan).not.toBeNull()
		const keys = new Set(plan!.entries.map(e => e.rangeKey))
		const enabled = bandplansFor("EU")
			.flatMap(b => b.ranges)
			.filter(r => r.enabled !== false)
		expect(enabled.length).toBeGreaterThan(0)
		for (const r of enabled)
			expect(keys.has(`${Math.round(r.startHz)}:${Math.round(r.endHz)}`)).toBe(
				true,
			)
	})
})

describe("ScannerService gate-aware ingest (WG12 R 2.5, 4.1)", () => {
	it("A below track increments transients and creates no discovery", async () => {
		const { h, internals } = setup()
		const id = await startJob(h, [R0])
		const activity = vi.fn()
		h.service.on("activity", activity)
		const before = internals.jobs.get(id)!.counts.transients
		internals.onTrack("rtl", {
			kind: "track-open",
			track: track("b", "pending"),
		})
		internals.onTrack("rtl", {
			kind: "track-update",
			track: track("b", "pending"),
		})
		internals.onTrack("rtl", {
			kind: "track-close",
			track: track("b", "below"),
			endReason: "quiet",
		})
		await settled(h.service)
		expect(internals.jobs.get(id)!.counts.transients).toBe(before + 1)
		expect(internals.jobs.get(id)!.counts.observations).toBe(0)
		expect(h.service.listDiscoveries({}).items).toEqual([])
		expect(internals.live.size).toBe(0)
		expect(activity).not.toHaveBeenCalled()
	})

	it("nextCandidate skips pending tracks", async () => {
		const { h, internals } = setup()
		const id = await startJob(h, [R0])
		const driver = internals.drivers.get(id)!
		const onTrack = vi.spyOn(driver, "onTrack")
		internals.onTrack("rtl", {
			kind: "track-open",
			track: track("p", "pending"),
		})
		expect(onTrack).not.toHaveBeenCalled()
		expect(internals.live.size).toBe(0)
		// a passed update opens the observation and reaches the confirm-candidate input
		internals.onTrack("rtl", {
			kind: "track-update",
			track: track("p", "passed"),
		})
		expect(onTrack).toHaveBeenCalledTimes(1)
		const live = internals.live.get("t-p")!
		expect(internals.needsConfirm(live, track("p", "pending"))).toBe(false)
		expect(internals.needsConfirm(live, track("p", "below"))).toBe(false)
		expect(internals.needsConfirm(live, track("p", "passed"))).toBe(true)
		expect(internals.needsConfirm(live, track("p", undefined))).toBe(false)
	})

	it("a track with no gate surfaces activity without a confirm candidate", async () => {
		const { h, internals } = setup()
		const id = await startJob(h, [R0])
		const driver = internals.drivers.get(id)!
		const onTrack = vi.spyOn(driver, "onTrack")
		const activity = vi.fn()
		h.service.on("activity", activity)
		internals.onTrack("rtl", {
			kind: "track-open",
			track: track("n", undefined),
		})
		expect(internals.live.has("t-n")).toBe(true)
		expect(onTrack).toHaveBeenCalledTimes(1)
		expect(activity).toHaveBeenCalled()
		const live = internals.live.get("t-n")!
		expect(internals.needsConfirm(live, track("n", undefined))).toBe(false)
		expect(internals.needsConfirm(live, track("n", "passed"))).toBe(true)
	})
})
