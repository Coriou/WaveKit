import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	LOCKOUT_EXCLUSIONS_MAX,
	LOCKOUT_MIN_WIDTH_HZ,
	lockoutExclusionsFor,
} from "../../../../../src/core/scanner/plan/lockouts.js"
import type { LockoutTarget } from "../../../../../src/core/scanner/plan/lockouts.js"
import {
	previewPlan,
	toJobSpec,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	PreviewContext,
	PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	Impact,
	ScanRange,
} from "../../../../../src/core/scanner/types.js"
import type { StoredScanJobSpec } from "../../../../../src/core/scanner/plan/range-contract.js"
import { testSettings } from "../../../../mocks/scanner/engine-fakes.js"

const PI: PreviewSourceView = {
	id: "pi",
	kind: "rtl_tcp",
	format: "U8_IQ",
	sampleRateHz: 2_048_000,
	centreHz: 446_100_000,
	controllable: true,
	controlMode: "internal",
	role: "shared",
	link: "network",
}
const SETTINGS = testSettings()

function emptyImpact(): Impact {
	return {
		liveAudioClients: 0,
		digitalVoiceListeners: 0,
		runningDecoders: [],
		pinnedDecoders: [],
		scannerJobs: [],
		unrestorable: [],
	}
}

function ctx(lockouts?: readonly LockoutTarget[]): PreviewContext {
	return {
		sources: [PI],
		channelizerAvailable: false,
		usableFraction: 0.8,
		settings: SETTINGS,
		measured: {
			settleMs: { local: null, network: null },
			markerSupported: { pi: true },
			probeStartMs: 400,
		},
		impactFor: () => emptyImpact(),
		region: "EU",
		tunerRange: () => ({ startHz: 24_000_000, endHz: 1_766_000_000 }),
		...(lockouts ? { lockouts: () => lockouts } : {}),
	}
}

const PMR: ScanRange = {
	startHz: 446_000_000,
	endHz: 446_200_000,
	rasters: [{ spacingHz: 12_500, firstChannelHz: 446_006_250 }],
	obwHz: [9000],
}
const sweep = (
	ranges: ScanRange[],
	extra: Partial<StoredScanJobSpec> = {},
): StoredScanJobSpec => ({ sourceId: "pi", mode: "sweep", ranges, ...extra })
const channels = (p: { plan: { hops: { channelCount: number }[] } }): number =>
	p.plan.hops.reduce((a, h) => a + h.channelCount, 0)

describe("lockout exclusions (WG2 req 12)", () => {
	it("excludes the locked channel at the next plan and restores it when cleared", () => {
		const spec = sweep([PMR])
		const base = previewPlan(spec, ctx())
		const lock: LockoutTarget = {
			discoveryId: "d_1",
			centreHz: 446_106_250,
			bandwidthHz: 8000,
		}
		const locked = previewPlan(spec, ctx([lock]))
		expect(locked.lockoutExclusions).toEqual([
			{
				discoveryId: "d_1",
				startHz: 446_100_000,
				endHz: 446_112_500,
				applied: true,
			},
		])
		expect(channels(locked)).toBe(channels(base) - 1)
		expect(locked.spec).toEqual(base.spec)
		expect(toJobSpec(locked.spec)).toEqual(toJobSpec(base.spec))
		// Cleared (12.5): the plan is the one without lockouts again.
		expect(previewPlan(spec, ctx([]))).toStrictEqual(base)
	})

	it("leaves previews without lockouts unchanged (no lockoutExclusions key)", () => {
		const spec = sweep([PMR], {
			exclusions: [{ startHz: 446_050_000, endHz: 446_060_000 }],
		})
		const base = previewPlan(spec, ctx())
		expect("lockoutExclusions" in base).toBe(false)
		expect(previewPlan(spec, ctx([]))).toStrictEqual(base)
		// A lockout outside the job's ranges, or on an in-window job, changes nothing.
		const far = { discoveryId: "d_far", centreHz: 460_000_000, bandwidthHz: 0 }
		expect(previewPlan(spec, ctx([far]))).toStrictEqual(base)
		const win = sweep([PMR], { mode: "in-window" })
		const lock = { discoveryId: "d_1", centreHz: 446_106_250, bandwidthHz: 0 }
		expect(previewPlan(win, ctx([lock]))).toStrictEqual(previewPlan(win, ctx()))
	})

	it("never empties a plan: a lockout over the whole range applies nothing (12.4)", () => {
		const spec = sweep([PMR])
		const base = previewPlan(spec, ctx())
		const wide = { discoveryId: "d_w", centreHz: 446_100_000, bandwidthHz: 1e6 }
		const p = previewPlan(spec, ctx([wide]))
		expect(p.plan).toEqual(base.plan)
		expect(p.issues).toEqual(base.issues)
		expect(p.lockoutExclusions).toEqual([
			{
				discoveryId: "d_w",
				startHz: PMR.startHz,
				endHz: PMR.endHz,
				applied: false,
			},
		])
	})

	it("applies the 256 lowest and lists the rest unapplied (12.3)", () => {
		const free: ScanRange = { startHz: 400_000_000, endHz: 410_000_000 }
		const targets: LockoutTarget[] = Array.from({ length: 300 }, (_, i) => ({
			discoveryId: `d_${String(299 - i).padStart(3, "0")}`,
			centreHz: 400_010_000 + (299 - i) * 20_000,
			bandwidthHz: 0,
		}))
		const out = lockoutExclusionsFor(targets, [free])
		expect(out).toHaveLength(300)
		expect(out.filter(x => x.applied)).toHaveLength(LOCKOUT_EXCLUSIONS_MAX)
		expect(out.slice(0, 256).every(x => x.applied)).toBe(true)
		expect(out.slice(256).some(x => x.applied)).toBe(false)
		expect(out[0]).toEqual({
			discoveryId: "d_000",
			startHz: 400_009_500,
			endHz: 400_010_500,
			applied: true,
		})
		expect(out[0]!.endHz - out[0]!.startHz).toBe(LOCKOUT_MIN_WIDTH_HZ)
	})

	it("ignores lockouts in disabled ranges and keeps hostile widths finite", () => {
		const off: ScanRange = { ...PMR, enabled: false }
		expect(
			lockoutExclusionsFor(
				[{ discoveryId: "d", centreHz: 446_106_250, bandwidthHz: 0 }],
				[off].filter(r => r.enabled !== false),
			),
		).toEqual([])
		const hostile = lockoutExclusionsFor(
			[
				{ discoveryId: "a", centreHz: 446_106_250, bandwidthHz: Number.NaN },
				{ discoveryId: "b", centreHz: 446_106_250, bandwidthHz: -5 },
				{ discoveryId: "c", centreHz: Number.NaN, bandwidthHz: 0 },
				{
					discoveryId: "d",
					centreHz: 446_106_250,
					bandwidthHz: Number.POSITIVE_INFINITY,
				},
			],
			[PMR],
		)
		// Non-finite or negative widths count as unknown: the raster step applies.
		expect(hostile.map(x => x.discoveryId)).toEqual(["a", "b", "d"])
		for (const x of hostile) {
			expect(x.endHz - x.startHz).toBe(12_500)
			expect(Number.isFinite(x.startHz) && Number.isFinite(x.endHz)).toBe(true)
			expect(x.startHz).toBeGreaterThanOrEqual(PMR.startHz)
			expect(x.endHz).toBeLessThanOrEqual(PMR.endHz)
		}
	})
})

const rangeArb = fc
	.record({
		startKhz: fc.integer({ min: 440_000, max: 448_000 }),
		widthKhz: fc.integer({ min: 20, max: 3000 }),
		raster: fc.constantFrom("none", "12k5", "25k"),
		enabled: fc.boolean(),
	})
	.map(({ startKhz, widthKhz, raster, enabled }): ScanRange => {
		const startHz = startKhz * 1000
		const spacingHz = raster === "25k" ? 25_000 : 12_500
		return {
			startHz,
			endHz: startHz + widthKhz * 1000,
			...(raster === "none"
				? {}
				: {
						rasters: [{ spacingHz, firstChannelHz: startHz + spacingHz / 2 }],
					}),
			...(enabled ? {} : { enabled: false }),
		}
	})

const targetArb = fc.record({
	at: fc.double({ min: -0.1, max: 1.1, noNaN: true }),
	pick: fc.nat(),
	bandwidthHz: fc.constantFrom(0, 500, 9000, 12_500, 200_000, 5_000_000),
})

describe("lockout exclusions property (WG2 req 12)", () => {
	// Feature: web-gaps-2, Property 15: Lockout exclusions
	// Validates: Requirements 12.1, 12.2, 12.3, 12.4
	it("applied exclusions are capped, cover their centres, never empty a plan and leave the spec alone", () => {
		fc.assert(
			fc.property(
				fc.array(rangeArb, { minLength: 1, maxLength: 4 }),
				fc.array(targetArb, { maxLength: 40 }),
				(rangesIn, picks) => {
					const ranges: ScanRange[] = rangesIn.map((r, i) =>
						i === 0 ? { ...r, enabled: true } : r,
					)
					const targets: LockoutTarget[] = picks.map((p, i) => {
						const r = ranges[p.pick % ranges.length]!
						return {
							discoveryId: `d_${i}`,
							centreHz: Math.round(r.startHz + p.at * (r.endHz - r.startHz)),
							bandwidthHz: p.bandwidthHz,
						}
					})
					const spec = sweep(ranges)
					const base = previewPlan(spec, ctx())
					const p = previewPlan(spec, ctx(targets))
					// 12.2: the job spec is the one without lockouts.
					expect(p.spec).toEqual(base.spec)
					expect(toJobSpec(p.spec)).toEqual(toJobSpec(base.spec))
					const list = p.lockoutExclusions ?? []
					const applied = list.filter(x => x.applied)
					// 12.3
					expect(applied.length).toBeLessThanOrEqual(LOCKOUT_EXCLUSIONS_MAX)
					for (let i = 1; i < list.length; i++)
						expect(list[i]!.startHz).toBeGreaterThanOrEqual(
							list[i - 1]!.startHz,
						)
					// 12.1: each applied exclusion covers its locked centre inside an enabled range.
					const enabled = ranges.filter(r => r.enabled !== false)
					const byId = new Map(targets.map(t => [t.discoveryId, t]))
					for (const x of list) {
						const t = byId.get(x.discoveryId)!
						expect(
							enabled.some(
								r => t.centreHz >= r.startHz && t.centreHz <= r.endHz,
							),
						).toBe(true)
						expect(x.startHz).toBeLessThanOrEqual(t.centreHz)
						expect(x.endHz).toBeGreaterThanOrEqual(t.centreHz)
					}
					expect(list.length).toBe(
						targets.filter(t =>
							enabled.some(
								r => t.centreHz >= r.startHz && t.centreHz <= r.endHz,
							),
						).length,
					)
					// 12.4: never empty a non-empty plan.
					if (base.plan.hops.length > 0)
						expect(p.plan.hops.length).toBeGreaterThan(0)
					if (list.length === 0) expect(p).toStrictEqual(base)
					else if (applied.length === 0) expect(p.plan).toEqual(base.plan)
				},
			),
			{ numRuns: 100 },
		)
	})
})
