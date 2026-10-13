import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type { JobRecord } from "../../../../src/core/scanner/job-runner.js"
import { preemptedByFor } from "../../../../src/core/scanner/scanner-service.js"
import type { JobState } from "../../../../src/core/scanner/types.js"
import {
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

type Harness = ReturnType<typeof serviceHarness>

const noPassive = (s: { passive: { enabled: boolean } }): void => {
	s.passive.enabled = false
}

const sweep = (priority: number, name?: string) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
	priority,
	takeover: true,
	resume: { autoAfterIdleMs: null },
	...(name !== undefined ? { name } : {}),
})

/** R1: a starting holder is never handed over, so each sweep first leaves `starting`. */
async function untilRunning(h: Harness, id: string, seed = 20): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await settled(h.service)
}

/** The last `scanner:job` event of each job id. */
function lastEvents(h: Harness): Map<string, ScanJob> {
	const last = new Map<string, ScanJob>()
	h.service.on("job", (dto: ScanJob) => last.set(dto.id, dto))
	return last
}

describe("ScannerService preemptedBy (SF1 req 4)", () => {
	it("names the preempting job on the preempted job, in REST views and events", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		try {
			const events = lastEvents(h)
			const low = await h.service.createJob(sweep(30))
			await untilRunning(h, low.id)
			expect(h.service.getJob(low.id)?.preemptedBy).toBeUndefined()
			const high = await h.service.createJob(sweep(60, "Airband"))
			await untilRunning(h, high.id)
			const view = h.service.getJob(low.id)
			expect(view).toMatchObject({ state: "paused", reason: "preempted-job" })
			expect(view?.preemptedBy).toEqual({ jobId: high.id, name: "Airband" })
			expect(events.get(low.id)?.preemptedBy).toEqual({
				jobId: high.id,
				name: "Airband",
			})
			expect(h.service.getJob(high.id)?.preemptedBy).toBeUndefined()
			expect(
				h.service.listJobs().find(j => j.id === low.id)?.preemptedBy,
			).toEqual({ jobId: high.id, name: "Airband" })

			await h.service.cancelJob(high.id)
			await settled(h.service)
			expect(h.service.getJob(low.id)?.state).toBe("running")
			expect(h.service.getJob(low.id)?.preemptedBy).toBeUndefined()
			expect(events.get(low.id)?.state).toBe("running")
			expect(events.get(low.id)?.preemptedBy).toBeUndefined()
		} finally {
			await h.service.stop()
		}
	})

	it("re-emits a job that stays preempted when another job takes the lease, with a null name", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		try {
			const events = lastEvents(h)
			const low = await h.service.createJob(sweep(30))
			await untilRunning(h, low.id)
			const mid = await h.service.createJob(sweep(40, "Mid"))
			await untilRunning(h, mid.id)
			expect(events.get(low.id)?.preemptedBy).toEqual({
				jobId: mid.id,
				name: "Mid",
			})
			const high = await h.service.createJob(sweep(60))
			await untilRunning(h, high.id)
			expect(h.service.getJob(low.id)?.reason).toBe("preempted-job")
			expect(h.service.getJob(mid.id)?.reason).toBe("preempted-job")
			for (const id of [low.id, mid.id]) {
				expect(h.service.getJob(id)?.preemptedBy).toEqual({
					jobId: high.id,
					name: null,
				})
				expect(events.get(id)?.preemptedBy).toEqual({
					jobId: high.id,
					name: null,
				})
			}
		} finally {
			await h.service.stop()
		}
	})

	it("drops preemptedBy when the preemptor loses the lease to the operator", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		try {
			const events = lastEvents(h)
			const low = await h.service.createJob(sweep(30))
			await untilRunning(h, low.id)
			const high = await h.service.createJob(sweep(60))
			await untilRunning(h, high.id)
			await h.service.pauseJob(high.id)
			h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
			await settled(h.service)
			expect(h.service.getJob(low.id)?.reason).toBe("preempted-job")
			expect(h.service.getJob(low.id)?.preemptedBy).toBeUndefined()
			expect(events.get(low.id)?.reason).toBe("preempted-job")
			expect(events.get(low.id)?.preemptedBy).toBeUndefined()
		} finally {
			await h.service.stop()
		}
	})

	// Feature: scanner-followups, Property 11: preemptedBy presence
	// Validates: Requirements 4.1, 4.2
	it("is present iff paused(preempted-job) with another known holder, and names it", () => {
		const states: JobState[] = [
			"pending",
			"starting",
			"running",
			"holding",
			"paused",
			"completed",
			"cancelled",
			"failed",
		]
		const reasons: (JobRecord["reason"] | undefined)[] = [
			undefined,
			"operator",
			"preempted-job",
			"preempted-operator",
			"preempted-relay",
			"core-restart",
		]
		const ids = ["j_a", "j_b", "j_c"]
		fc.assert(
			fc.property(
				fc.constantFrom(...ids),
				fc.constantFrom(...states),
				fc.constantFrom(...reasons),
				fc.option(fc.constantFrom(...ids), { nil: undefined }),
				fc.dictionary(
					fc.constantFrom(...ids),
					fc.option(fc.string({ maxLength: 8 }), { nil: null }),
				),
				(id, state, reason, holder, names) => {
					const record = { id, state, ...(reason ? { reason } : {}) }
					const nameOf = (jobId: string): string | null | undefined =>
						Object.hasOwn(names, jobId) ? names[jobId] : undefined
					const out = preemptedByFor(record, holder, nameOf)
					const expected =
						state === "paused" &&
						reason === "preempted-job" &&
						holder !== undefined &&
						holder !== id &&
						Object.hasOwn(names, holder)
					expect("preemptedBy" in out).toBe(expected)
					if (expected)
						expect(out.preemptedBy).toEqual({
							jobId: holder,
							name: names[holder!],
						})
				},
			),
			{ numRuns: 200 },
		)
	})
})
