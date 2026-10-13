import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import type { BandPlanStackView } from "@wavekit/api-types"
import {
	openBandPlanService,
	resolveScannerBandplans,
} from "../../../../src/core/bandplans/index.js"
import type { BandPlanService } from "../../../../src/core/bandplans/contract.js"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import type { Bandplan } from "../../../../src/core/scanner/bandplan/index.js"
import type { ScanJobSpec } from "../../../../src/core/scanner/types.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

// Scanner-level composition of the band-plan feed (M2.2, M2.3): a real band-plan
// service over a mkdtemp stateDir, a real ScannerService (serviceHarness fakes the
// SDR side, region EU) and the provider src/index.ts builds inline.

const REGION = "EU" as const
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse())
		await cleanup().catch(() => undefined)
})

/** Mirrors the inline `scannerBandplans` provider in src/index.ts. */
function indexProvider(
	current: () => Pick<BandPlanService, "view"> | undefined,
): () => readonly Bandplan[] {
	return () => {
		const service = current()
		if (service === undefined) return bandplansFor(REGION)
		try {
			return resolveScannerBandplans(service.view())
		} catch {
			return bandplansFor(REGION)
		}
	}
}

function scanner(provider?: () => readonly Bandplan[]) {
	const h = serviceHarness(provider ? { bandplans: provider } : {})
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	return h.service
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

const plans = bandplansFor(REGION)
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
		const fed = scanner(indexProvider(() => service))
		const plain = scanner()
		expect(fed.bandplans()).toEqual(bandplansFor(REGION))
		expect(fed.bandplans()).toEqual(plain.bandplans())
		for (const spec of specsFor())
			expect(fed.preview(spec)).toEqual(plain.preview(spec))
	})

	// Feature: band-plans, Property 17: Hidden removal
	// Validates: Requirements 11.1, 11.3, 11.4
	it("a hidden built-in band leaves the scanner at the next read; unhiding restores it", async () => {
		const service = await openService()
		const fed = scanner(indexProvider(() => service))
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
		const fed = scanner(indexProvider(() => ({ view: () => current })))
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
	it("falls back to bandplansFor(region) before the service opens and when view() throws", async () => {
		let source: Pick<BandPlanService, "view"> | undefined
		const fed = scanner(indexProvider(() => source))
		expect(fed.bandplans()).toEqual(bandplansFor(REGION))
		source = {
			view: () => {
				throw new Error("store exploded")
			},
		}
		expect(fed.bandplans()).toEqual(bandplansFor(REGION))
		const plain = scanner()
		for (const spec of specsFor())
			expect(fed.preview(spec)).toEqual(plain.preview(spec))
	})
})
