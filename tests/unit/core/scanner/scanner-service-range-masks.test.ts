import { rm } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import type { EngineMasks } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	ScanJobSpec,
	ScanRange,
} from "../../../../src/core/scanner/types.js"
import {
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

type Harness = ReturnType<typeof serviceHarness>

const noPassive = (s: { passive: { enabled: boolean } }): void => {
	s.passive.enabled = false
}

const R0 = { startHz: 450_000_000, endHz: 450_200_000 }
const R1 = { startHz: 452_000_000, endHz: 452_200_000 }
const R2 = { startHz: 454_000_000, endHz: 454_200_000 }

async function untilRunning(h: Harness, id: string, seed = 20): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await settled(h.service)
}

/** Runs a sweep with `ranges`, then returns the masks updateMasks sends to the engine. */
async function masksFor(
	ranges: ScanRange[],
	extra: Partial<ScanJobSpec> = {},
): Promise<{ masks: EngineMasks; spec: { ranges: ScanRange[] } }> {
	const h = serviceHarness({ patch: noPassive })
	try {
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			ranges,
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
			...extra,
		})
		await untilRunning(h, job.id)
		const internals = h.service as unknown as {
			spectrum: { engine(id: string): { setMasks(m: EngineMasks): void } }
			updateMasks(sourceId: string): void
		}
		const engine = internals.spectrum.engine("rtl")
		if (!engine) throw new Error("engine not open")
		const spy = vi.spyOn(engine, "setMasks")
		internals.updateMasks("rtl")
		const masks = spy.mock.calls.at(-1)?.[0]
		if (!masks) throw new Error("no masks sent")
		return { masks, spec: h.service.getJob(job.id)!.spec }
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
}

describe("ScannerService CFAR masks (SF1 req 2.2, 2.5)", () => {
	it("sends exactly today's masks for a job without per-range fields", async () => {
		const { masks, spec } = await masksFor([R0, R1], {
			protocols: ["pocsag"],
		})
		// The pre-SF1 updateMasks, written out over the normalised ranges.
		const ranges = spec.ranges
		const today = {
			exclusions: masks.exclusions,
			cfarRanges: ranges.map(r => ({ startHz: r.startHz, endHz: r.endHz })),
			burstRanges: ranges
				.filter(r =>
					(r.protocols ?? []).some(p => ["ism", "pocsag", "aprs"].includes(p)),
				)
				.map(r => ({ startHz: r.startHz, endHz: r.endHz })),
			// Each raster is bounded to its range.
			rasters: ranges.flatMap(r =>
				(r.rasters ?? []).map(x => ({
					...x,
					startHz: r.startHz,
					endHz: r.endHz,
				})),
			),
			obwHz: [...new Set(ranges.flatMap(r => r.obwHz ?? []))],
			inWindow: masks.inWindow,
		}
		expect(JSON.stringify(masks)).toBe(JSON.stringify(today))
		for (const c of masks.cfarRanges)
			expect(c).not.toHaveProperty("faTargetPerMhzMin")
	})

	it("carries per-range targets, merges shared spans to the most sensitive, and leaves disabled ranges out", async () => {
		const { masks } = await masksFor([
			{ ...R0, sensitivity: "high" },
			// same span, no sensitivity: the pipeline target, below "high"
			{ ...R0 },
			// low together with an unset range: the pipeline target wins, so no entry
			{ ...R1, sensitivity: "low" },
			{ ...R1 },
			{ ...R2, sensitivity: "high", enabled: false, protocols: ["pocsag"] },
		])
		expect(masks.cfarRanges).toEqual([
			{ ...R0, faTargetPerMhzMin: 2 },
			{ ...R0, faTargetPerMhzMin: 2 },
			{ ...R1 },
			{ ...R1 },
		])
		const inR2 = (hz: number) => hz >= R2.startHz && hz <= R2.endHz
		expect(masks.burstRanges).toEqual([])
		expect(masks.rasters.some(r => inR2(r.firstChannelHz))).toBe(false)
	})

	it("sends a lone low range its own target", async () => {
		const { masks } = await masksFor([{ ...R0, sensitivity: "low" }, R1])
		expect(masks.cfarRanges).toEqual([
			{ ...R0, faTargetPerMhzMin: 0.25 },
			{ ...R1 },
		])
	})
})
