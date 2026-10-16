import { rm } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type { Bandplan } from "../../../../src/core/scanner/bandplan/index.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type {
	ScannerProtocol,
	ScanRange,
} from "../../../../src/core/scanner/types.js"
import {
	CENTRE,
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

const sweep = {
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [R0, R1],
	priority: 50,
	takeover: true,
	resume: { autoAfterIdleMs: null },
}

/** R1 (ruling): a starting holder is never handed over; tests start from a running sweep. */
async function untilRunning(h: Harness, id: string, seed = 20): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await settled(h.service)
}

const overlaps = (
	hop: { covered: { startHz: number; endHz: number } },
	r: { startHz: number; endHz: number },
): boolean => hop.covered.startHz <= r.endHz && hop.covered.endHz >= r.startHz

const scannerTunes = (h: Harness, from = 0): number[] =>
	h.tuner.sent
		.slice(from)
		.filter(c => c.origin === "scanner" && c.name === "set-frequency")
		.map(c => c.value)

function pinned(job: ScanJob | undefined) {
	if (!job) throw new Error("job missing")
	return { spec: job.spec, plan: job.plan }
}

describe("ScannerService range edits (SF1 req 1, 2, 6)", () => {
	it("applies live range edits at the next hop, keeps them across restart and later patches", async () => {
		const first = serviceHarness({ patch: noPassive })
		try {
			await first.service.start()
			const job = await first.service.createJob(sweep)
			await untilRunning(first, job.id)
			const before = first.service.getJob(job.id)!
			expect(before.plan.hops.some(hop => overlaps(hop, R1))).toBe(true)
			const events: ScanJob[] = []
			first.service.on("job", (dto: ScanJob) => {
				if (dto.id === job.id) events.push(dto)
			})

			const [c0, c1] = before.spec.ranges as [ScanRange, ScanRange]
			const edited: ScanRange[] = [
				{
					...c0,
					name: "Channel A",
					dwellMs: 400,
					sensitivity: "high",
					protocols: ["dmr"],
				},
				{ ...c1, enabled: false },
			]
			const res = await first.service.patchJob(job.id, { ranges: edited })
			expect(res.issues.filter(i => i.severity === "error")).toEqual([])
			expect(res.job.spec.ranges[0]).toMatchObject({
				name: "Channel A",
				dwellMs: 400,
				sensitivity: "high",
				protocols: ["dmr"],
			})
			expect(res.job.spec.ranges[1]).toMatchObject({ ...R1, enabled: false })
			// Disabled ranges are not planned; the enabled range's dwell is the hop's.
			expect(res.plan.hops.length).toBeGreaterThan(0)
			expect(res.plan.hops.length).toBeLessThan(before.plan.hops.length)
			for (const hop of res.plan.hops) {
				expect(overlaps(hop, R1)).toBe(false)
				expect(hop.dwellMs).toBe(400)
			}
			expect(events.at(-1)?.spec.ranges).toEqual(res.job.spec.ranges)

			// The plan swap happens at a hop boundary: after it, the sweep tunes only the new hops.
			const driver = (): { hopCount: number } =>
				first.service.getJob(job.id)!.progress
			for (
				let i = 0;
				i < 80 && driver().hopCount !== res.plan.hops.length;
				i++
			) {
				feedTone(first.fanout, 0.1, 0, 0, 100 + i)
				await settled(first.service)
			}
			expect(driver().hopCount).toBe(res.plan.hops.length)
			const mark = first.tuner.sent.length
			for (let i = 0; i < 20; i++) {
				feedTone(first.fanout, 0.1, 0, 0, 300 + i)
				await settled(first.service)
			}
			const centres = new Set(res.plan.hops.map(hop => hop.centreHz))
			for (const hz of scannerTunes(first, mark))
				expect(centres.has(hz)).toBe(true)
			expect(centres.has(first.tuner.states.get("rtl")!.frequency)).toBe(true)
			const admitted = pinned(first.service.getJob(job.id))
			await first.service.stop()

			// Restart: the restored plan honours enabled ranges and per-hop dwell (6.1).
			const second = serviceHarness({ dir: first.dir, patch: noPassive })
			try {
				await second.service.start()
				await settled(second.service)
				const restored = second.service.getJob(job.id)
				expect(restored?.state).not.toBe("failed")
				expect(pinned(restored)).toEqual(admitted)
				// A later PATCH of another key keeps the range edits (6.3).
				const later = await second.service.patchJob(job.id, {
					thresholdDb: 9,
				})
				expect(later.job.spec.ranges).toEqual(admitted.spec.ranges)
				expect(later.plan.hops).toEqual(admitted.plan.hops)
			} finally {
				await second.service.stop()
			}
		} finally {
			await first.service.stop()
			await rm(first.dir, { recursive: true, force: true })
		}
	}, 20_000)

	it("refuses locked-field, count and all-disabled edits with 400 and leaves the job unchanged", async () => {
		const h = serviceHarness({ patch: noPassive })
		try {
			await h.service.start()
			const job = await h.service.createJob(sweep)
			await untilRunning(h, job.id)
			const before = pinned(h.service.getJob(job.id))
			const [c0, c1] = before.spec.ranges as [ScanRange, ScanRange]

			await expect(
				h.service.patchJob(job.id, {
					ranges: [c0, { ...c1, endHz: c1.endHz + 100_000 }],
				}),
			).rejects.toMatchObject({
				statusCode: 400,
				code: "SCANNER_PLAN_INVALID",
				details: {
					issues: [
						expect.objectContaining({
							code: "range-locked",
							severity: "error",
							details: { index: 1, fields: ["endHz"] },
						}),
					],
				},
			})
			await expect(
				h.service.patchJob(job.id, { ranges: [c0] }),
			).rejects.toMatchObject({
				statusCode: 400,
				code: "SCANNER_PLAN_INVALID",
				details: {
					issues: [expect.objectContaining({ code: "range-locked" })],
				},
			})
			await expect(
				h.service.patchJob(job.id, {
					ranges: [
						{ ...c0, enabled: false },
						{ ...c1, enabled: false },
					],
				}),
			).rejects.toMatchObject({
				statusCode: 400,
				code: "SCANNER_PLAN_INVALID",
				details: {
					issues: expect.arrayContaining([
						expect.objectContaining({ code: "range-empty" }),
					]),
				},
			})
			expect(pinned(h.service.getJob(job.id))).toEqual(before)
			expect(h.service.getJob(job.id)?.state).toBe("running")
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	})

	it("drops a signals-only job from the probe protocol union, live through PATCH (req 3.3)", async () => {
		const h = serviceHarness({ patch: noPassive })
		try {
			await h.service.start()
			const window = (protocols: ScannerProtocol[]) => ({
				sourceId: "rtl",
				mode: "in-window" as const,
				ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
				protocols,
			})
			const a = await h.service.createJob(window(["dmr"]))
			const b = await h.service.createJob(window(["pocsag"]))
			const protocolsFor = (jobIds: string[]): ScannerProtocol[] =>
				(
					h.service as unknown as {
						protocolsFor(
							live: LiveObservation,
							centreHz: number,
						): ScannerProtocol[]
					}
				)
					.protocolsFor({ jobIds } as LiveObservation, CENTRE)
					.sort()
			expect(protocolsFor([a.id, b.id])).toEqual(["dmr", "pocsag"])

			const res = await h.service.patchJob(b.id, { signalsOnly: true })
			expect(res.job.spec.signalsOnly).toBe(true)
			expect(protocolsFor([a.id, b.id])).toEqual(["dmr"])
			await h.service.patchJob(b.id, { signalsOnly: false })
			expect(protocolsFor([a.id, b.id])).toEqual(["dmr", "pocsag"])
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	})

	// R1 finding 1: the plan under a running job changes; earlier range edits never move to
	// another range and never block later patches.
	it("drops stale range edits with a warning when the job's band plan changes, and stays editable", async () => {
		const band = (startHz: number) => ({
			startHz,
			endHz: startHz + 200_000,
			rasters: [{ spacingHz: 12_500, firstChannelHz: startHz + 6_250 }],
			bandplanId: "user-p",
		})
		let plan: Bandplan = {
			id: "user-p",
			region: "all",
			name: "User P",
			ranges: [band(450_000_000), band(452_000_000)],
		}
		const h = serviceHarness({ patch: noPassive, bandplans: () => [plan] })
		try {
			await h.service.start()
			const job = await h.service.createJob({
				sourceId: "rtl",
				mode: "sweep",
				bandplans: ["user-p"],
				priority: 50,
				takeover: true,
				resume: { autoAfterIdleMs: null },
			})
			await untilRunning(h, job.id)
			const [c0, c1] = h.service.getJob(job.id)!.spec.ranges as [
				ScanRange,
				ScanRange,
			]
			await h.service.patchJob(job.id, {
				ranges: [
					{ ...c0, name: "low" },
					{ ...c1, enabled: false },
				],
			})

			// The plan gains a range at the end: both edits still apply to their ranges.
			plan = { ...plan, ranges: [...plan.ranges, band(454_000_000)] }
			const grown = await h.service.patchJob(job.id, { thresholdDb: 9 })
			expect(grown.job.spec.ranges).toHaveLength(3)
			expect(grown.job.spec.ranges[0]?.name).toBe("low")
			expect(grown.job.spec.ranges[1]?.enabled).toBe(false)
			expect(grown.job.spec.ranges[2]?.enabled).toBeUndefined()
			expect(grown.issues.some(i => i.code === "range-locked")).toBe(false)

			// The second range's edges move: its edit is dropped with a warning, the first stays.
			plan = {
				...plan,
				ranges: [band(450_000_000), band(452_100_000), band(454_000_000)],
			}
			const moved = await h.service.patchJob(job.id, { thresholdDb: 8 })
			expect(moved.job.spec.ranges[0]?.name).toBe("low")
			expect(moved.job.spec.ranges[1]).toMatchObject({ startHz: 452_100_000 })
			expect(moved.job.spec.ranges[1]?.enabled).toBeUndefined()
			expect(moved.issues.filter(i => i.severity === "error")).toEqual([])
			expect(moved.issues).toContainEqual(
				expect.objectContaining({
					code: "range-locked",
					severity: "warning",
					details: expect.objectContaining({
						reason: "range-live-stale",
						dropped: [1],
					}),
				}),
			)

			// R2 finding 2: the dropped entry is pruned; the warning is not repeated or stored.
			expect(
				h.service.getJob(job.id)!.issues.some(i => i.code === "range-locked"),
			).toBe(false)
			const again = await h.service.patchJob(job.id, { thresholdDb: 8 })
			expect(again.issues.some(i => i.code === "range-locked")).toBe(false)
			expect(again.job.spec.ranges[0]?.name).toBe("low")
			expect(again.job.spec.ranges[1]?.enabled).toBeUndefined()

			// A range gained at the front shifts every index: nothing applies, the PATCH succeeds.
			plan = { ...plan, ranges: [band(448_000_000), ...plan.ranges] }
			const shifted = await h.service.patchJob(job.id, { thresholdDb: 7 })
			expect(shifted.job.spec.ranges).toHaveLength(4)
			expect(shifted.job.spec.ranges.some(r => r.name !== undefined)).toBe(
				false,
			)
			expect(shifted.job.spec.ranges.some(r => r.enabled === false)).toBe(false)
			expect(shifted.issues).toContainEqual(
				expect.objectContaining({ code: "range-locked", severity: "warning" }),
			)

			// A fresh range edit against the new list replaces the stale entries.
			const now = h.service.getJob(job.id)!.spec.ranges
			const fresh = await h.service.patchJob(job.id, {
				ranges: now.map((r, i) => (i === 3 ? { ...r, enabled: false } : r)),
			})
			expect(fresh.job.spec.ranges[3]?.enabled).toBe(false)
			expect(fresh.issues.some(i => i.code === "range-locked")).toBe(false)
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	})

	// R2 finding 1: a `ranges` PATCH read before the band plan changed never loses its edit silently.
	it("refuses a ranges PATCH whose edit no longer lands after the plan's edges moved", async () => {
		const band = (startHz: number) => ({
			startHz,
			endHz: startHz + 200_000,
			rasters: [{ spacingHz: 12_500, firstChannelHz: startHz + 6_250 }],
			bandplanId: "user-p",
		})
		let plan: Bandplan = {
			id: "user-p",
			region: "all",
			name: "User P",
			ranges: [band(450_000_000), band(452_000_000)],
		}
		const h = serviceHarness({ patch: noPassive, bandplans: () => [plan] })
		try {
			await h.service.start()
			const job = await h.service.createJob({
				sourceId: "rtl",
				mode: "sweep",
				bandplans: ["user-p"],
				priority: 50,
				takeover: true,
				resume: { autoAfterIdleMs: null },
			})
			await untilRunning(h, job.id)
			const before = h.service.getJob(job.id)!
			const [c0, c1] = before.spec.ranges as [ScanRange, ScanRange]
			// The plan moves range 1 after the client read the job.
			plan = { ...plan, ranges: [band(450_000_000), band(452_100_000)] }
			await expect(
				h.service.patchJob(job.id, {
					ranges: [c0, { ...c1, enabled: false }],
				}),
			).rejects.toMatchObject({
				statusCode: 400,
				code: "SCANNER_PLAN_INVALID",
				details: {
					issues: [
						expect.objectContaining({
							code: "range-locked",
							severity: "error",
							details: expect.objectContaining({
								reason: "range-plan-changed",
								dropped: [1],
							}),
						}),
					],
				},
			})
			const after = h.service.getJob(job.id)!
			expect({ spec: after.spec, plan: after.plan }).toEqual({
				spec: before.spec,
				plan: before.plan,
			})
			// Re-read against the current list (a PATCH of another key re-plans) and retry: it lands.
			const replanned = await h.service.patchJob(job.id, { thresholdDb: 9 })
			const [n0, n1] = replanned.job.spec.ranges as [ScanRange, ScanRange]
			expect(n1.startHz).toBe(452_100_000)
			const retried = await h.service.patchJob(job.id, {
				ranges: [n0, { ...n1, enabled: false }],
			})
			expect(retried.job.spec.ranges[1]?.enabled).toBe(false)
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	})
})
