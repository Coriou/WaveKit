/**
 * Resume from paused(resume-blocked), through the real ScannerService and JobRunner with in-process
 * fakes: a sweep the operator interrupted, with someone new on the receiver at the idle check. The
 * resume goes through the consent gate of the other lease-less resumes, never answers a generic
 * invalid transition, and the sweep carries on with its progress.
 */
import { describe, expect, it, vi } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type { JobRecord } from "../../../../src/core/scanner/job-runner.js"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import {
	feedTone,
	serviceHarness,
	settled,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

const WAIT = { timeout: 8_000, interval: 5 }

/** Three hops wider than the capture window; the operator's idle check runs 30 ms after a write. */
const sweep = (priority = 50) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 452_400_000 }],
	priority,
	takeover: true,
	resume: { autoAfterIdleMs: 30 },
})

function setup() {
	const live = { running: false, sourceId: "rtl", clientCount: 0 }
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
		liveDemod: {
			getStatus: () => live,
		} as unknown as ScannerServiceDeps["liveDemod"],
	})
	const holder = (): string | undefined =>
		(
			h.service as unknown as {
				arbiter: { holder(id: string): { jobId: string } | undefined }
			}
		).arbiter.holder("rtl")?.jobId
	const record = (id: string): JobRecord =>
		(h.service as unknown as { jobs: Map<string, JobRecord> }).jobs.get(id)!
	const job = (id: string): ScanJob => h.service.getJob(id)!
	/** Feeds noise until `done` (real samples through the real engine and scheduler, no clock tricks). */
	const feedUntil = async (done: () => boolean, seed = 40): Promise<void> => {
		for (let i = 0; i < 400 && !done(); i++) {
			await settled(h.service)
			feedTone(h.fanout, 0.1, 0, 0, seed + i)
		}
		await settled(h.service)
		expect(done()).toBe(true)
	}
	return { h, live, holder, record, job, feedUntil }
}

/** A sweep that has hopped at least once, then: retune, a listener appears, idle: paused(resume-blocked). */
async function blocked(s: ReturnType<typeof setup>, priority = 50) {
	const { h, live, job, feedUntil } = s
	await h.service.start()
	const created = await h.service.createJob(sweep(priority))
	const id = created.id
	await feedUntil(() => job(id).state === "running")
	const first = job(id).progress.hopIndex
	await feedUntil(() => job(id).progress.hopIndex !== first)
	h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
	await settled(h.service)
	expect(job(id)).toMatchObject({
		state: "paused",
		reason: "preempted-operator",
	})
	expect(h.decoders.isSourceHeld("rtl")).toBe(false)
	live.running = true
	live.clientCount = 1
	await vi.waitFor(() => expect(job(id).reason).toBe("resume-blocked"), WAIT)
	expect(job(id).state).toBe("paused")
	expect(job(id).impact?.liveAudioClients).toBe(1)
	return { id, before: job(id) }
}

/** The sweep is running, holds the lease and the decoders, and went on hopping from where it was. */
async function carriedOn(
	s: ReturnType<typeof setup>,
	id: string,
	before: ScanJob,
) {
	const { h, holder, job, feedUntil } = s
	expect(job(id).state).toBe("running")
	expect(job(id).reason).toBeUndefined()
	expect(holder()).toBe(id)
	expect(h.decoders.isSourceHeld("rtl")).toBe(true)
	expect(job(id).startedAt).toBe(before.startedAt)
	expect(job(id).createdAt).toBe(before.createdAt)
	expect(job(id).progress.sweepIndex).toBeGreaterThanOrEqual(
		before.progress.sweepIndex,
	)
	expect(job(id).progress.counts.observations).toBeGreaterThanOrEqual(
		before.progress.counts.observations,
	)
	const at = job(id).progress.hopIndex
	const writes = h.tuner.sent.length
	await feedUntil(() => job(id).progress.hopIndex !== at, 500)
	expect(h.tuner.sent.slice(writes).some(c => c.name === "set-frequency")).toBe(
		true,
	)
}

describe("resume from paused(resume-blocked), service level", () => {
	it("asks for consent naming the listener, then a takeover carries on with the progress", async () => {
		const s = setup()
		const { h, job, record } = s
		const { id, before } = await blocked(s)
		expect(before.progress.hopCount).toBeGreaterThan(1)

		const refused = await h.service
			.resumeJob(id, { takeover: false })
			.catch((err: unknown) => err)
		expect(refused).toMatchObject({
			statusCode: 409,
			code: "SCANNER_TAKEOVER_REQUIRED",
			details: { impact: { liveAudioClients: 1 } },
		})
		expect((refused as Error).message).toContain("1 live audio listener")
		expect((refused as Error).message).toContain("takeover: true")
		// nothing moved
		expect(job(id)).toMatchObject({ state: "paused", reason: "resume-blocked" })
		expect(job(id).progress.hopIndex).toBe(before.progress.hopIndex)
		expect(s.holder()).toBeUndefined()

		await h.service.resumeJob(id, { takeover: true })
		await settled(h.service)
		// the accepted takeover is the new consent: the same listener no longer blocks
		expect(record(id).consentedImpact?.liveAudioClients).toBe(1)
		await carriedOn(s, id, before)
		await h.service.stop()
	}, 30_000)

	it("keeps the discoveries and hit statistics found before the pause", async () => {
		const s = setup()
		const { h, job, live, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob({
			...sweep(),
			ranges: [{ startHz: 445_500_000, endHz: 447_900_000 }],
			resume: { autoAfterIdleMs: 30 },
		})
		await feedUntil(() => job(id).state === "running")
		const discovered = () => h.service.listDiscoveries({}).items.map(d => d.id)
		// a tone wherever the receiver is, then noise so the track closes and is ingested
		for (let i = 0; i < 6 && discovered().length === 0; i++) {
			feedTone(h.fanout, 1, 93_750, 0.5, 60 + i)
			feedTone(h.fanout, 0.5, 0, 0, 80 + i)
			await tick(300)
			await settled(h.service)
		}
		const found = discovered()
		expect(found.length).toBeGreaterThan(0)
		const before = job(id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		live.running = true
		live.clientCount = 1
		await vi.waitFor(() => expect(job(id).reason).toBe("resume-blocked"), WAIT)
		await h.service.resumeJob(id, { takeover: true })
		await settled(h.service)
		expect(discovered()).toEqual(expect.arrayContaining(found))
		expect(job(id).startedAt).toBe(before.startedAt)
		expect(job(id).progress.counts.observations).toBeGreaterThanOrEqual(
			before.progress.counts.observations,
		)
		expect(job(id).progress.hitStats?.discoveries ?? 0).toBeGreaterThanOrEqual(
			before.progress.hitStats?.discoveries ?? 0,
		)
		await h.service.stop()
	}, 30_000)

	it("names a decoder started since, too", async () => {
		const s = setup()
		const { h, live } = s
		const { id } = await blocked(s)
		live.running = false
		live.clientCount = 0
		h.decoders.getAllStatus = () =>
			[
				{
					id: "aprs-1",
					sourceId: "rtl",
					owner: "config",
					running: true,
					suspended: false,
					startMode: "auto",
				},
			] as never
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({
			code: "SCANNER_TAKEOVER_REQUIRED",
			message: expect.stringContaining("decoder aprs-1") as string,
			details: { impact: { runningDecoders: ["aprs-1"] } },
		})
		await h.service.stop()
	}, 30_000)

	it("resumes plainly once the impact is gone", async () => {
		const s = setup()
		const { h, live, record } = s
		const { id, before } = await blocked(s)
		const consented = record(id).consentedImpact
		live.running = false
		live.clientCount = 0
		await h.service.resumeJob(id, { takeover: false })
		await settled(h.service)
		// a plain resume consents to nothing new
		expect(record(id).consentedImpact).toEqual(consented)
		await carriedOn(s, id, before)
		await h.service.stop()
	}, 30_000)

	for (const [what, holderPriority] of [
		["equal", 50],
		["higher", 60],
	] as const)
		it(`a holder of ${what} priority refuses with what to do; the job stays resumable with its progress`, async () => {
			const s = setup()
			const { h, job, holder, live, feedUntil, record } = s
			const { id, before } = await blocked(s)
			const other = await h.service.createJob(sweep(holderPriority))
			await feedUntil(() => job(other.id).state === "running")
			const consented = record(id).consentedImpact
			for (const takeover of [false, true]) {
				const refused = await h.service
					.resumeJob(id, { takeover })
					.catch((err: unknown) => err)
				expect(refused).toMatchObject({
					statusCode: 409,
					code: "SCANNER_SOURCE_BUSY",
					details: { reason: "held", holderJobId: other.id },
				})
				const message = (refused as Error).message
				expect(message).toContain(`Lease held by scanner job ${other.id}`)
				expect(message).toContain("equal or higher priority")
				expect(message).toContain("stop that job")
				expect(message).toContain("stays paused with its progress")
				expect(job(id)).toMatchObject({
					state: "paused",
					reason: "resume-blocked",
				})
				expect(job(id).progress.hopIndex).toBe(before.progress.hopIndex)
				expect(holder()).toBe(other.id)
			}
			// a refused takeover consents to nothing
			expect(record(id).consentedImpact).toEqual(consented)
			await h.service.cancelJob(other.id)
			await settled(h.service)
			live.running = false
			live.clientCount = 0
			await h.service.resumeJob(id, { takeover: false })
			await settled(h.service)
			await carriedOn(s, id, before)
			await h.service.stop()
		}, 30_000)

	it("a lower-priority holder needs consent, naming it; the takeover hands the lease over", async () => {
		const s = setup()
		const { h, job, holder, live, feedUntil, record } = s
		const { id, before } = await blocked(s, 50)
		const other = await h.service.createJob(sweep(30))
		await feedUntil(() => job(other.id).state === "running")
		live.running = false
		live.clientCount = 0
		const refused = await h.service
			.resumeJob(id, { takeover: false })
			.catch((err: unknown) => err)
		expect(refused).toMatchObject({
			code: "SCANNER_TAKEOVER_REQUIRED",
			details: { impact: { scannerJobs: [other.id] } },
		})
		expect((refused as Error).message).toContain(`scanner job ${other.id}`)
		expect(holder()).toBe(other.id)

		await h.service.resumeJob(id, { takeover: true })
		await settled(h.service)
		expect(record(id).consentedImpact?.scannerJobs).toEqual([other.id])
		expect(job(other.id)).toMatchObject({
			state: "paused",
			reason: "preempted-job",
		})
		await carriedOn(s, id, before)
		await h.service.stop()
	}, 30_000)
})

describe("resume from paused(source-down), service level", () => {
	it("says the job continues by itself, keeps it paused, and it does when the source returns", async () => {
		const s = setup()
		const { h, job, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob(sweep())
		await feedUntil(() => job(id).state === "running")
		const before = job(id)
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		expect(job(id)).toMatchObject({ state: "paused", reason: "source-down" })
		for (const takeover of [false, true]) {
			const refused = await h.service
				.resumeJob(id, { takeover })
				.catch((err: unknown) => err)
			expect(refused).toMatchObject({
				statusCode: 409,
				code: "SCANNER_SOURCE_DOWN",
				details: { reason: "source-down" },
			})
			expect((refused as Error).message).toContain("when it reconnects")
			expect(job(id).reason).toBe("source-down")
		}
		h.sources.emit("payload-started", "rtl")
		await settled(h.service)
		expect(job(id).state).toBe("running")
		expect(job(id).startedAt).toBe(before.startedAt)
		await h.service.stop()
	}, 30_000)
})
