import { rm } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type {
	DecoderCoverageView,
	ScanRange,
} from "../../../../src/core/scanner/types.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const PMR: ScanRange = {
	startHz: 446_000_000,
	endHz: 446_200_000,
	rasters: [{ spacingHz: 12_500, firstChannelHz: 446_006_250 }],
	obwHz: [9000],
}
const TARGET = 446_056_250
const sweep = (skip?: boolean) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [PMR],
	takeover: true,
	resume: { autoAfterIdleMs: null },
	...(skip === undefined ? {} : { skipDecodedElsewhere: skip }),
})
const channels = (job: { plan: ScanJob["plan"] }): number =>
	job.plan.hops.reduce((a, h) => a + h.channelCount, 0)

function view(over: Partial<DecoderCoverageView> = {}): DecoderCoverageView {
	return {
		id: "pmr-elsewhere",
		running: true,
		health: "running",
		suspended: false,
		owner: "config",
		sourceId: "other",
		inputKind: "iq",
		band: {
			verdict: "in-band",
			basis: "configured",
			targetsHz: [TARGET],
			rangesHz: [],
			captureCenterHz: 446_000_000,
			windowHalfWidthHz: 1_000_000,
		},
		...over,
	}
}
const noPassive = (s: { passive: { enabled: boolean } }): void => {
	s.passive.enabled = false
}

interface Internals {
	replanLockouts(): Promise<void>
	drivers: Map<string, { replan: (...args: unknown[]) => void }>
}

describe("ScannerService decoded elsewhere (WG6 req 1)", () => {
	it("without the dependency plans, previews and jobs carry nothing new and the skip flag is inert", async () => {
		const bare = serviceHarness({ patch: noPassive })
		const empty = serviceHarness({
			patch: noPassive,
			decoderCoverage: () => [],
		})
		const untrusted = serviceHarness({
			patch: noPassive,
			decoderCoverage: () => [
				view({ sourceId: "rtl" }),
				view({ running: false }),
				view({ owner: "scanner" }),
				view({ suspended: true }),
				view({ health: "faulted" }),
			],
		})
		try {
			for (const h of [bare, empty, untrusted]) await h.service.start()
			for (const skip of [undefined, false, true]) {
				const p = bare.service.preview(sweep(skip))
				expect("decodedElsewhere" in p).toBe(false)
				expect(p.issues.some(i => i.code.startsWith("decoded-elsewhere"))).toBe(
					false,
				)
				// A dependency that proves nothing answers byte-identically.
				expect(JSON.stringify(empty.service.preview(sweep(skip)))).toBe(
					JSON.stringify(p),
				)
				expect(JSON.stringify(untrusted.service.preview(sweep(skip)))).toBe(
					JSON.stringify(p),
				)
			}
			const plainPlan = bare.service.preview(sweep()).plan
			const flagged = await bare.service.createJob(sweep(true))
			expect(flagged.plan).toEqual(plainPlan)
			expect("decodedElsewhere" in bare.service.getJob(flagged.id)!).toBe(false)
			const patched = await bare.service.patchJob(flagged.id, {
				skipDecodedElsewhere: false,
			})
			expect(patched.job.spec.skipDecodedElsewhere).toBe(false)
			expect(patched.job.plan).toEqual(plainPlan)
			expect("decodedElsewhere" in patched.job).toBe(false)
		} finally {
			for (const h of [bare, empty, untrusted]) {
				await h.service.stop()
				await rm(h.dir, { recursive: true, force: true })
			}
		}
	}, 30_000)

	it("reports covered ranges on preview, create, PATCH, replan and restore; skips them only with the flag", async () => {
		let views: DecoderCoverageView[] = [view()]
		const calls = vi.fn(() => views)
		const h = serviceHarness({ patch: noPassive, decoderCoverage: calls })
		const bare = serviceHarness({ patch: noPassive })
		try {
			await h.service.start()
			await bare.service.start()
			const basePlan = bare.service.preview(sweep()).plan

			calls.mockClear()
			const p = h.service.preview(sweep())
			// Read once per plan.
			expect(calls).toHaveBeenCalledTimes(1)
			expect(p.decodedElsewhere).toEqual([
				{
					startHz: TARGET - 6_250,
					endHz: TARGET + 6_250,
					sourceId: "other",
					decoderIds: ["pmr-elsewhere"],
					applied: false,
				},
			])
			expect(p.plan).toEqual(basePlan)

			const job = await h.service.createJob(sweep())
			expect(job.decodedElsewhere).toEqual(p.decodedElsewhere)
			expect(job.plan).toEqual(basePlan)
			expect(h.service.getJob(job.id)!.decodedElsewhere).toEqual(
				p.decodedElsewhere,
			)

			// Live-editable: the PATCH applies the ranges.
			const patched = await h.service.patchJob(job.id, {
				skipDecodedElsewhere: true,
			})
			expect(patched.job.spec.skipDecodedElsewhere).toBe(true)
			expect(patched.job.decodedElsewhere).toEqual([
				expect.objectContaining({ applied: true }),
			])
			expect(channels(patched.job)).toBeLessThan(channels({ plan: basePlan }))
			expect(
				patched.job.plan.hops.some(hop =>
					hop.excluded.some(x => x.startHz <= TARGET && TARGET <= x.endHz),
				),
			).toBe(true)

			// A replan with a changed decoder set follows it; nothing covers → back to today's plan.
			const internals = h.service as unknown as Internals
			const events: ScanJob[] = []
			h.service.on("job", (dto: ScanJob) => {
				if (dto.id === job.id) events.push(dto)
			})
			views = []
			await internals.replanLockouts()
			const cleared = h.service.getJob(job.id)!
			expect("decodedElsewhere" in cleared).toBe(false)
			expect(cleared.plan).toEqual(basePlan)
			expect(events).toHaveLength(1)
			// Unchanged coverage: no event.
			await internals.replanLockouts()
			expect(events).toHaveLength(1)

			views = [view()]
			await internals.replanLockouts()
			expect(h.service.getJob(job.id)!.decodedElsewhere).toEqual(
				patched.job.decodedElsewhere,
			)

			// Restored jobs plan with the coverage of their restart.
			await h.service.stop()
			const again = serviceHarness({
				dir: h.dir,
				patch: noPassive,
				decoderCoverage: () => views,
			})
			await again.service.start()
			try {
				const restored = again.service.getJob(job.id)!
				expect(restored.state).not.toBe("failed")
				expect(restored.decodedElsewhere).toEqual(patched.job.decodedElsewhere)
				expect(restored.plan).toEqual(patched.job.plan)
			} finally {
				await again.service.stop()
			}
		} finally {
			await bare.service.stop()
			await rm(h.dir, { recursive: true, force: true })
			await rm(bare.dir, { recursive: true, force: true })
		}
	}, 30_000)

	it("a coverage change that leaves the plan alone does not replan the driver", async () => {
		let views: DecoderCoverageView[] = [view()]
		const h = serviceHarness({
			patch: noPassive,
			decoderCoverage: () => views,
		})
		try {
			await h.service.start()
			const job = await h.service.createJob(sweep())
			const internals = h.service as unknown as Internals
			const replan = vi.spyOn(internals.drivers.get(job.id)!, "replan")
			views = [view({ id: "another" })]
			await internals.replanLockouts()
			expect(replan).not.toHaveBeenCalled()
			expect(h.service.getJob(job.id)!.decodedElsewhere).toEqual([
				expect.objectContaining({ decoderIds: ["another"], applied: false }),
			])
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	}, 30_000)

	it("a throwing dependency counts as no coverage", async () => {
		const h = serviceHarness({
			patch: noPassive,
			decoderCoverage: () => {
				throw new Error("status unavailable")
			},
		})
		try {
			await h.service.start()
			const job = await h.service.createJob(sweep(true))
			expect("decodedElsewhere" in job).toBe(false)
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	}, 30_000)
})

describe("ScannerService last hit duration (WG6 req 2.1)", () => {
	it("sets lastDurationMs when the job's latest credited observation closes", async () => {
		const h = serviceHarness({ patch: noPassive })
		try {
			await h.service.start()
			const a = await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
			})
			const internals = h.service as unknown as {
				store: { ingest: (input: unknown) => unknown }
				ingest: (live: unknown, track: unknown, endReason?: string) => void
			}
			let first = true
			internals.store.ingest = () => {
				const attributed = first
					? [
							{
								observationId: "o_1",
								discoveryId: "d_p",
								jobIds: [a.id],
								created: true,
							},
						]
					: []
				first = false
				return { discoveryId: "d_p", change: "updated", attributed }
			}
			const live = {
				observationId: "o_1",
				sourceId: "rtl",
				trackId: "t",
				epoch: 0,
				jobIds: [a.id],
				discoveryId: null,
				startedAt: Date.now() - 2_000,
				classification: {},
				probeIds: new Set(),
				lastActivityAt: 0,
				lastIngestAt: 0,
				lastTrack: null,
				decoded: false,
				encrypted: false,
			}
			internals.ingest(live, {})
			expect(h.service.jobHits(a.id, 10).hits[0]!.lastDurationMs).toBeNull()
			internals.ingest(live, {}, "quiet")
			const d = h.service.jobHits(a.id, 10).hits[0]!.lastDurationMs
			expect(d).toBeGreaterThanOrEqual(2_000)
			expect(d).toBeLessThan(10_000)
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	}, 30_000)
})
