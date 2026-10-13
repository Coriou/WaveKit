import { rm } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
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
	})

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
})
