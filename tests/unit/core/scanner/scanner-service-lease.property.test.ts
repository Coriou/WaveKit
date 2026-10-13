import type * as FsPromises from "node:fs/promises"
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { chooseLeaseHolder } from "../../../../src/core/scanner/job-runner.js"
import {
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

/**
 * Durability is not under test here: each run persists jobs, leases and engine state dozens of
 * times, and the fsync of every atomic write dominated the run time (SF1 req 7.1). The writes
 * still go through tmp file and rename; only the flush to disk is skipped.
 */
vi.mock("node:fs/promises", async importOriginal => {
	const fs = await importOriginal<typeof FsPromises>()
	const open: typeof fs.open = async (...args) => {
		const handle = await fs.open(...args)
		handle.sync = () => Promise.resolve()
		return handle
	}
	return { ...fs, default: { ...fs, open }, open }
})

type Harness = ReturnType<typeof serviceHarness>

const sweep = (priority: number) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
	priority,
	takeover: true,
	resume: { autoAfterIdleMs: null },
})

/** Feeds noise until the sweep leaves `starting` (R1: a starting holder is never handed over). */
async function untilRunning(h: Harness, id: string, seed = 20): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await settled(h.service)
}

describe("ScannerService lease holder", () => {
	// Feature: signal-discovery-scanner, Property 16: Priority
	// Validates: spec § 10.2
	it("keeps at most one lease holder per source and it is the best runnable sweep", async () => {
		type Op =
			| { t: "create"; priority: number }
			| { t: "cancel" | "pause" | "resume"; idx: number }
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				t: fc.constant("create" as const),
				priority: fc.integer({ min: 0, max: 100 }),
			}),
			fc.record({
				t: fc.constantFrom(
					"cancel" as const,
					"pause" as const,
					"resume" as const,
				),
				idx: fc.nat(5),
			}),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(op, { minLength: 1, maxLength: 12 }),
				async ops => {
					const h = serviceHarness({
						patch: s => {
							s.passive.enabled = false
						},
					})
					await h.service.start()
					const ids: string[] = []
					try {
						for (const o of ops) {
							try {
								if (o.t === "create") {
									const id = (await h.service.createJob(sweep(o.priority))).id
									ids.push(id)
									// R1: a starting holder is never handed over; let it run so preemption is exercised.
									await untilRunning(h, id)
								} else {
									const id = ids[o.idx % Math.max(1, ids.length)]
									if (!id) continue
									if (o.t === "cancel") await h.service.cancelJob(id)
									if (o.t === "pause") await h.service.pauseJob(id)
									if (o.t === "resume")
										await h.service.resumeJob(id, { takeover: true })
								}
							} catch (err) {
								expect(err).toMatchObject({ statusCode: expect.any(Number) })
							}
							await settled(h.service)
							const jobs = h.service
								.listJobs()
								.filter(j => j.spec.mode === "sweep")
							const holder = (
								h.service as unknown as {
									arbiter: {
										holder(id: string): { jobId: string } | undefined
									}
								}
							).arbiter.holder("rtl")
							const runnable = jobs.filter(
								j =>
									["starting", "running", "holding"].includes(j.state) ||
									(j.state === "paused" &&
										((j.reason === "operator" && holder?.jobId === j.id) ||
											j.reason === "preempted-job")),
							)
							const best = chooseLeaseHolder(
								runnable.map(j => ({
									jobId: j.id,
									priority: j.spec.priority,
									createdAt: Date.parse(j.createdAt),
								})),
							)
							// R1: a holder still in `starting` keeps the lease (a better job's create got 409).
							const holderStarting =
								holder !== undefined &&
								jobs.find(j => j.id === holder.jobId)?.state === "starting"
							if (best === null) expect(holder).toBeUndefined()
							else if (!holderStarting) expect(holder?.jobId).toBe(best)
						}
					} finally {
						await h.service.stop()
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})
