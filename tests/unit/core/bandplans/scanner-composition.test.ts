import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BandPlanStackView } from "@wavekit/api-types"
import {
	createScannerBandplanProvider,
	openBandPlanService,
} from "../../../../src/core/bandplans/index.js"
import type { BandPlanService } from "../../../../src/core/bandplans/contract.js"
import { priorsFor } from "../../../../src/core/scanner/bandplan/index.js"
import { builtinBandplansFor } from "../../../../src/core/bandplans/builtin-supplement.js"
import type { Bandplan } from "../../../../src/core/scanner/bandplan/index.js"
import type { ScanJob } from "@wavekit/api-types"
import type { JobDriver } from "../../../../src/core/scanner/job-runner.js"
import type {
	ScanJobSpec,
	ScannerSettings,
} from "../../../../src/core/scanner/types.js"
import {
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

// Scanner-level composition of the band-plan feed (M2.2, M2.3): a real band-plan
// service over a mkdtemp stateDir, a real ScannerService (serviceHarness fakes the
// SDR side, region EU) and createScannerBandplanProvider, as src/index.ts wires it.

const REGION = "EU" as const
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse())
		await cleanup().catch(() => undefined)
})

/** The provider src/index.ts builds, over a service that may be absent. */
function feedFrom(
	current: () => Pick<BandPlanService, "view"> | undefined,
	onError?: (err: unknown) => void,
): () => readonly Bandplan[] {
	return createScannerBandplanProvider(() => current()?.view(), REGION, onError)
}

const noPassive = (s: ScannerSettings): void => {
	s.passive.enabled = false
}

function harness(provider?: () => readonly Bandplan[]) {
	const h = serviceHarness({
		patch: noPassive,
		...(provider ? { bandplans: provider } : {}),
	})
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	return h
}

function scanner(provider?: () => readonly Bandplan[]) {
	return harness(provider).service
}

async function openService(): Promise<BandPlanService> {
	const root = await mkdtemp(join(tmpdir(), "wavekit-bandplans-scanner-"))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const stateDir = join(root, "state")
	await mkdir(stateDir, { mode: 0o700 })
	const service = await openBandPlanService({
		stateDir,
		context: { region: REGION, effectiveCountry: null },
		writable: true,
	})
	cleanups.push(() => service.close())
	return service
}

function expectedOf(view: BandPlanStackView) {
	if (view.store.state !== "available" || view.store.storeId === null)
		throw new Error("store not writable")
	return { storeId: view.store.storeId, revision: view.store.revision }
}

function builtinPackId(view: BandPlanStackView): string {
	const entry = view.stack.entries[0]
	if (!entry) throw new Error("empty default stack")
	return entry.packId
}

const plans = builtinBandplansFor(REGION)
const planIds = plans.map(plan => plan.id)

/** Job specs covering plan-id lookup and host-range inheritance. */
function specsFor(): ScanJobSpec[] {
	const specs: ScanJobSpec[] = planIds.map(id => ({
		mode: "sweep",
		bandplans: [id],
	}))
	for (const plan of plans) {
		const range = plan.ranges[0]
		if (range)
			specs.push({
				mode: "sweep",
				ranges: [{ startHz: range.startHz, endHz: range.endHz }],
			})
	}
	return specs
}

function rangeEmptyFor(
	preview: ReturnType<typeof scanner>["preview"],
	id: string,
) {
	return preview({ mode: "sweep", bandplans: [id] }).issues.some(
		issue => issue.code === "range-empty",
	)
}

describe("scanner fed by the band-plan stack", () => {
	it("region EU has built-in plans to hide", () => {
		expect(planIds.length).toBeGreaterThan(1)
	})

	// Feature: band-plans, Property 16: Default scanner parity
	// Validates: Requirements 11.2, 11.3, 11.4
	it("default stack: bandplans() and previews equal the scanner without a provider", async () => {
		const service = await openService()
		const fed = scanner(feedFrom(() => service))
		const plain = scanner()
		expect(fed.bandplans()).toEqual(builtinBandplansFor(REGION))
		expect(fed.bandplans()).toEqual(plain.bandplans())
		for (const spec of specsFor())
			expect(fed.preview(spec)).toEqual(plain.preview(spec))
	})

	// Feature: band-plans, Property 17: Hidden removal
	// Validates: Requirements 11.1, 11.3, 11.4
	it("a hidden built-in band leaves the scanner at the next read; unhiding restores it", async () => {
		const service = await openService()
		const fed = scanner(feedFrom(() => service))
		const view = service.view()
		const packId = builtinPackId(view)
		const hiddenId = planIds[0]
		const otherId = planIds[1]
		if (hiddenId === undefined || otherId === undefined)
			throw new Error("plans")

		const hidden = await service.mutate({
			type: "patch-band-edit",
			expected: expectedOf(view),
			packId,
			bandId: hiddenId,
			set: { hidden: true },
			reset: [],
		})
		expect(hidden.changed).toBe(true)
		const remaining = plans.filter(plan => plan.id !== hiddenId)
		expect(fed.bandplans()).toEqual(remaining)
		expect(rangeEmptyFor(spec => fed.preview(spec), hiddenId)).toBe(true)
		expect(rangeEmptyFor(spec => fed.preview(spec), otherId)).toBe(false)
		// Same previews as a scanner given exactly the remaining plans.
		const reference = scanner(() => remaining)
		for (const spec of specsFor())
			expect(fed.preview(spec)).toEqual(reference.preview(spec))
		// Admission reads the same list.
		await expect(
			fed.createJob({ mode: "sweep", bandplans: [hiddenId] }),
		).rejects.toMatchObject({
			code: "SCANNER_PLAN_INVALID",
			details: {
				issues: expect.arrayContaining([
					expect.objectContaining({
						code: "range-empty",
						details: { bandplan: hiddenId },
					}),
				]),
			},
		})

		// Display-only edits do not change the scanner list.
		const skipped = await service.mutate({
			type: "patch-band-edit",
			expected: expectedOf(hidden.view),
			packId,
			bandId: otherId,
			set: { skip: { reason: "noisy" }, name: "Renamed" },
			reset: [],
		})
		expect(skipped.changed).toBe(true)
		expect(fed.bandplans()).toEqual(remaining)

		const restored = await service.mutate({
			type: "reset-pack-edits",
			expected: expectedOf(skipped.view),
			packId,
		})
		expect(restored.changed).toBe(true)
		expect(fed.bandplans()).toEqual(plans)
		expect(rangeEmptyFor(spec => fed.preview(spec), hiddenId)).toBe(false)
	})

	// Feature: band-plans, Property 17: Hidden removal
	// Validates: Requirements 11.1, 11.4
	it("bandplans() and preview track any set of hidden built-in bands", async () => {
		const service = await openService()
		const base = service.view()
		const packId = builtinPackId(base)
		let current: BandPlanStackView = base
		const fed = scanner(feedFrom(() => ({ view: () => current })))
		const displayOnly = fc.constantFrom<
			BandPlanStackView["edits"][number]["set"]
		>({ skip: { reason: "noisy" } }, { name: "Renamed" }, { hidden: false })
		await fc.assert(
			fc.asyncProperty(
				fc.subarray(planIds),
				fc.array(fc.tuple(fc.constantFrom(...planIds), displayOnly), {
					maxLength: 4,
				}),
				fc.constantFrom(...planIds),
				async (hiddenIds, others, probe) => {
					const hidden = new Set(hiddenIds)
					const edits = [
						...hiddenIds.map(bandId => ({
							packId,
							bandId,
							set: { hidden: true },
							updatedAt: "2026-10-13T00:00:00.000Z",
						})),
						...others
							.filter(([bandId]) => !hidden.has(bandId))
							.map(([bandId, set]) => ({
								packId,
								bandId,
								set,
								updatedAt: "2026-10-13T00:00:00.000Z",
							})),
					]
					current = { ...base, edits }
					expect(fed.bandplans()).toEqual(
						plans.filter(plan => !hidden.has(plan.id)),
					)
					expect(rangeEmptyFor(spec => fed.preview(spec), probe)).toBe(
						hidden.has(probe),
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 16: Default scanner parity
	// Validates: Requirements 11.5
	it("falls back to builtinBandplansFor(region) before the service opens and when view() throws", async () => {
		let source: Pick<BandPlanService, "view"> | undefined
		const onError = vi.fn()
		const fed = scanner(feedFrom(() => source, onError))
		expect(fed.bandplans()).toEqual(builtinBandplansFor(REGION))
		expect(onError).not.toHaveBeenCalled()
		source = {
			view: () => {
				throw new Error("store exploded")
			},
		}
		expect(fed.bandplans()).toEqual(builtinBandplansFor(REGION))
		expect(onError).toHaveBeenCalled()
		const plain = scanner()
		for (const spec of specsFor())
			expect(fed.preview(spec)).toEqual(plain.preview(spec))
	})

	// Feature: band-plans, Property 17: Hidden removal
	// Validates: Requirements 11.3
	it("an admitted sweep keeps its plans through a hide, a pause and a resume; create and patch re-resolve", async () => {
		const service = await openService()
		const h = harness(feedFrom(() => service))
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			bandplans: [PLAN],
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
		})
		await untilRunning(h, job.id)
		const admitted = h.service.getJob(job.id)
		expect(admitted?.state).toBe("running")
		const view = service.view()
		await service.mutate({
			type: "patch-band-edit",
			expected: expectedOf(view),
			packId: builtinPackId(view),
			bandId: PLAN,
			set: { hidden: true },
			reset: [],
		})
		expect(h.service.bandplans().map(plan => plan.id)).not.toContain(PLAN)

		// Running: unchanged.
		feedTone(h.fanout, 0.1, 0, 0, 7)
		await settled(h.service)
		expect(pinned(h.service.getJob(job.id))).toEqual(pinned(admitted))
		expect(h.service.getJob(job.id)?.state).toBe("running")

		// Paused and resumed: still the admitted plan, no error.
		await h.service.pauseJob(job.id)
		expect(h.service.getJob(job.id)?.state).toBe("paused")
		await h.service.resumeJob(job.id, { takeover: true })
		await untilRunning(h, job.id)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(pinned(h.service.getJob(job.id))).toEqual(pinned(admitted))

		// A patch re-previews the operator's spec against the current list.
		await expect(
			h.service.patchJob(job.id, { thresholdDb: 9 }),
		).rejects.toMatchObject({ code: "SCANNER_PLAN_INVALID" })
		expect(pinned(h.service.getJob(job.id))).toEqual(pinned(admitted))
		// A new create naming the hidden plan is range-empty.
		await expect(
			h.service.createJob({ mode: "sweep", bandplans: [PLAN] }),
		).rejects.toMatchObject({
			code: "SCANNER_PLAN_INVALID",
			details: {
				issues: expect.arrayContaining([
					expect.objectContaining({
						code: "range-empty",
						details: { bandplan: PLAN },
					}),
				]),
			},
		})
	})

	// Feature: band-plans, Property 17: Hidden removal
	// Validates: Requirements 11.3 (scanner-followups requirement 6.4)
	it("running and operator-paused sweeps restored at boot keep their admitted plans after a hide", async () => {
		const service = await openService()
		const provider = feedFrom(() => service)
		const spec: ScanJobSpec = {
			sourceId: "rtl",
			mode: "sweep",
			bandplans: [PLAN],
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
		}
		// One job per state directory: a second sweep on the same source would wait for the lease.
		const boots = []
		for (const pause of [false, true]) {
			const first = serviceHarness({ patch: noPassive, bandplans: provider })
			cleanups.push(() => rm(first.dir, { recursive: true, force: true }))
			await first.service.start()
			const job = await first.service.createJob(spec)
			await untilRunning(first, job.id)
			if (pause) await first.service.pauseJob(job.id)
			await settled(first.service)
			expect(first.service.getJob(job.id)).toMatchObject(
				pause ? { state: "paused", reason: "operator" } : { state: "running" },
			)
			boots.push({ dir: first.dir, id: job.id, pause, admitted: pinned(job) })
			expect(pinned(first.service.getJob(job.id))).toEqual(pinned(job))
			await first.service.stop()
		}

		const view = service.view()
		await service.mutate({
			type: "patch-band-edit",
			expected: expectedOf(view),
			packId: builtinPackId(view),
			bandId: PLAN,
			set: { hidden: true },
			reset: [],
		})

		for (const boot of boots) {
			const h = serviceHarness({
				dir: boot.dir,
				patch: noPassive,
				bandplans: provider,
			})
			cleanups.push(() => h.service.stop())
			await h.service.start()
			await settled(h.service)
			expect(h.service.bandplans().map(plan => plan.id)).not.toContain(PLAN)
			const restored = h.service.getJob(boot.id)
			expect(restored).toMatchObject({
				state: "paused",
				reason: boot.pause ? "operator" : "core-restart",
				issues: [],
			})
			expect(pinned(restored)).toEqual(boot.admitted)
			// Resumed after the restore: still the admitted plan.
			await h.service.resumeJob(boot.id, { takeover: true })
			await untilRunning(h, boot.id)
			expect(h.service.getJob(boot.id)?.state).toBe("running")
			expect(pinned(h.service.getJob(boot.id))).toEqual(boot.admitted)
		}
	})

	// Feature: band-plans, Property 17: Hidden removal
	// Validates: Requirements 11.1, 11.3
	it("identify priors follow the effective list: default unchanged, a hidden band drops its priors", async () => {
		const service = await openService()
		const h = harness(feedFrom(() => service))
		await h.service.start()
		const probe = priorProbe()
		// Identify targets must sit in the tuned window; the fake tuner reports caps.
		h.sources.setCaps("rtl", { centerFreq: probe.hz })
		const all = plans.flatMap(plan => plan.ranges)
		const visible = plans
			.filter(plan => plan.id !== probe.id)
			.flatMap(plan => plan.ranges)
		expect(priorsFor(visible, probe.hz)).not.toEqual(priorsFor(all, probe.hz))

		const before = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: probe.hz },
			timeoutMs: 1000,
		})
		expect(priorsOf(h, before.id)(probe.hz)).toEqual(priorsFor(all, probe.hz))
		await h.service.cancelJob(before.id)
		await settled(h.service)

		const view = service.view()
		await service.mutate({
			type: "patch-band-edit",
			expected: expectedOf(view),
			packId: builtinPackId(view),
			bandId: probe.id,
			set: { hidden: true },
			reset: [],
		})
		const after = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: probe.hz },
			timeoutMs: 1000,
		})
		expect(priorsOf(h, after.id)(probe.hz)).toEqual(
			priorsFor(visible, probe.hz),
		)
		await h.service.cancelJob(after.id)
	})
})

/** pmr446 sits at the harness centre (446.1 MHz). */
const PLAN = "pmr446"

type Harness = ReturnType<typeof harness>

/** Feeds noise until the sweep leaves `starting`. */
async function untilRunning(h: Harness, id: string): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, 20 + i)
	}
	await settled(h.service)
}

/** The admitted parts a band-plan change must not touch. */
function pinned(job: ScanJob | undefined) {
	if (!job) throw new Error("job missing")
	return { spec: job.spec, plan: job.plan }
}

function priorsOf(h: Harness, id: string) {
	const drivers = (h.service as unknown as { drivers: Map<string, JobDriver> })
		.drivers
	const driver = drivers.get(id) as unknown as
		| { deps: { priorsAt: (hz: number) => unknown } }
		| undefined
	if (!driver) throw new Error("identify driver missing")
	return driver.deps.priorsAt
}

/** A plan and a frequency inside it whose priors change when that plan is hidden. */
function priorProbe(): { id: string; hz: number } {
	const all = plans.flatMap(plan => plan.ranges)
	for (const plan of plans) {
		const visible = plans
			.filter(other => other.id !== plan.id)
			.flatMap(other => other.ranges)
		for (const range of plan.ranges) {
			const hz = Math.round((range.startHz + range.endHz) / 2)
			if (!isDeepStrictEqual(priorsFor(all, hz), priorsFor(visible, hz)))
				return { id: plan.id, hz }
		}
	}
	throw new Error("no EU plan with distinct priors")
}
