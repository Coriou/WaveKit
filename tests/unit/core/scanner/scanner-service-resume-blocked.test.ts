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

function setup(dir?: string) {
	const live = { running: false, sourceId: "rtl", clientCount: 0 }
	const h = serviceHarness({
		...(dir !== undefined ? { dir } : {}),
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

/** The sweep moves on to another hop, and the move reaches the tuner. */
async function hopsAgain(s: ReturnType<typeof setup>, id: string) {
	const { h, job, feedUntil } = s
	const at = job(id).progress.hopIndex
	const writes = h.tuner.sent.length
	await feedUntil(() => job(id).progress.hopIndex !== at, 500)
	expect(h.tuner.sent.slice(writes).some(c => c.name === "set-frequency")).toBe(
		true,
	)
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
			expect((refused as Error).message).toContain("No data from the source")
			expect((refused as Error).message).toContain("when data returns")
			expect(job(id).reason).toBe("source-down")
		}
		// connected again, no byte yet: still no data
		h.sources.emit("connected", "rtl")
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({ code: "SCANNER_SOURCE_DOWN" })
		h.sources.emit("payload-started", "rtl")
		await settled(h.service)
		expect(job(id).state).toBe("running")
		expect(job(id).startedAt).toBe(before.startedAt)
		await hopsAgain(s, id)
		await h.service.stop()
	}, 30_000)

	it("a dropout and return during a resume's held-up decoder hold ends running, and it hops", async () => {
		const s = setup()
		const { h, job, record, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob(sweep())
		await feedUntil(() => job(id).state === "running")
		await h.service.pauseJob(id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(job(id)).toMatchObject({ state: "paused", reason: "operator" })

		const hold = h.decoders.holdSource.bind(h.decoders)
		let release = (): void => undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		h.decoders.holdSource = async (...args) => {
			await gate
			return hold(...args)
		}
		const resuming = h.service.resumeJob(id, { takeover: true })
		await vi.waitFor(() => expect(record(id).state).toBe("running"), WAIT)
		h.sources.emit("disconnected", "rtl")
		h.sources.emit("payload-started", "rtl")
		release()
		await resuming
		await vi.waitFor(() => {
			expect(job(id).state).toBe("running")
			expect(job(id).reason).toBeUndefined()
		}, WAIT)
		await settled(h.service)
		expect(job(id).state).toBe("running")
		await hopsAgain(s, id)
		await h.service.stop()
	}, 30_000)

	it("a dropout and return in one tick ends running, and it hops", async () => {
		const s = setup()
		const { h, job, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob(sweep())
		await feedUntil(() => job(id).state === "running")
		h.sources.emit("disconnected", "rtl")
		h.sources.emit("payload-started", "rtl")
		await vi.waitFor(() => expect(job(id).state).toBe("running"), WAIT)
		await settled(h.service)
		expect(job(id).state).toBe("running")
		await hopsAgain(s, id)
		await h.service.stop()
	}, 30_000)

	it("a second dropout right after the return leaves the job waiting in source-down", async () => {
		const s = setup()
		const { h, job, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob(sweep())
		await feedUntil(() => job(id).state === "running")
		h.sources.emit("disconnected", "rtl")
		h.sources.emit("payload-started", "rtl")
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		await tick(20)
		await settled(h.service)
		expect(job(id)).toMatchObject({ state: "paused", reason: "source-down" })
		await h.service.stop()
	}, 30_000)

	it("a resume carries on a job left in source-down with the source up", async () => {
		const s = setup()
		const { h, job, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob(sweep())
		await feedUntil(() => job(id).state === "running")
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		// a return this job never heard of
		const arbiter = (
			h.service as unknown as {
				arbiter: {
					listeners(e: string): ((...args: unknown[]) => void)[]
					off(e: string, l: (...args: unknown[]) => void): void
					on(e: string, l: (...args: unknown[]) => void): void
				}
			}
		).arbiter
		const listeners = arbiter.listeners("source-up")
		for (const l of listeners) arbiter.off("source-up", l)
		h.sources.emit("payload-started", "rtl")
		for (const l of listeners) arbiter.on("source-up", l)
		await settled(h.service)
		expect(job(id)).toMatchObject({ state: "paused", reason: "source-down" })

		await h.service.resumeJob(id, { takeover: false })
		await settled(h.service)
		expect(job(id).state).toBe("running")
		await hopsAgain(s, id)
		await h.service.stop()
	}, 30_000)

	it("a blocked job refuses while the source is down, keeps its reason, and resumes once it returns", async () => {
		const s = setup()
		const { h, job, holder } = s
		const { id, before } = await blocked(s)
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		for (const takeover of [false, true]) {
			const refused = await h.service
				.resumeJob(id, { takeover })
				.catch((err: unknown) => err)
			expect(refused).toMatchObject({
				statusCode: 409,
				code: "SCANNER_SOURCE_DOWN",
				details: { reason: "source-down" },
			})
			expect((refused as Error).message).toContain("once data returns")
			expect((refused as Error).message).toContain(
				"stays paused with its progress",
			)
			expect(job(id)).toMatchObject({
				state: "paused",
				reason: "resume-blocked",
			})
			expect(holder()).toBeUndefined()
		}
		h.sources.emit("payload-started", "rtl")
		await settled(h.service)
		// it comes back to the same question, not to a running job
		expect(job(id)).toMatchObject({ state: "paused", reason: "resume-blocked" })
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({ code: "SCANNER_TAKEOVER_REQUIRED" })
		await h.service.resumeJob(id, { takeover: true })
		await settled(h.service)
		await carriedOn(s, id, before)
		await h.service.stop()
	}, 30_000)

	it("an operator pause refuses while the source is down, and resumes once it returns", async () => {
		const s = setup()
		const { h, job, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob(sweep())
		await feedUntil(() => job(id).state === "running")
		await h.service.pauseJob(id)
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_DOWN",
			message: expect.stringContaining("once data returns") as string,
		})
		expect(job(id)).toMatchObject({ state: "paused", reason: "operator" })
		h.sources.emit("payload-started", "rtl")
		await settled(h.service)
		expect(job(id)).toMatchObject({ state: "paused", reason: "operator" })
		await h.service.resumeJob(id, { takeover: false })
		await settled(h.service)
		expect(job(id).state).toBe("running")
		await hopsAgain(s, id)
		await h.service.stop()
	}, 30_000)
})

describe("a failed takeover", () => {
	it("keeps the old consent when the decoder hold rejects", async () => {
		const s = setup()
		const { h, job, record, holder } = s
		const { id } = await blocked(s)
		const consented = record(id).consentedImpact
		const hold = h.decoders.holdSource.bind(h.decoders)
		h.decoders.holdSource = () => Promise.reject(new Error("no hold"))
		await expect(h.service.resumeJob(id, { takeover: true })).rejects.toThrow(
			"no hold",
		)
		expect(job(id)).toMatchObject({ state: "paused", reason: "resume-blocked" })
		expect(record(id).consentedImpact).toEqual(consented)
		expect(holder()).toBeUndefined()
		h.decoders.holdSource = hold
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({ code: "SCANNER_TAKEOVER_REQUIRED" })
		await h.service.stop()
	}, 30_000)
})

describe("a blocked job across a restart", () => {
	/** A second service on the same state dir, with the first one's listener still present. */
	async function restarted(dir: string) {
		const s = setup(dir)
		s.live.running = true
		s.live.clientCount = 1
		await s.h.service.start()
		s.h.sources.emit("payload-started", "rtl")
		await settled(s.h.service)
		return s
	}

	it("keeps its block: a plain resume still asks about the listener", async () => {
		const first = setup()
		const { id } = await blocked(first)
		await first.h.service.stop()

		const s = await restarted(first.h.dir)
		const { h, job, holder } = s
		expect(job(id)).toMatchObject({ state: "paused", reason: "resume-blocked" })
		const refused = await h.service
			.resumeJob(id, { takeover: false })
			.catch((err: unknown) => err)
		expect(refused).toMatchObject({
			code: "SCANNER_TAKEOVER_REQUIRED",
			details: { impact: { liveAudioClients: 1 } },
		})
		expect(job(id).reason).toBe("resume-blocked")
		expect(holder()).toBeUndefined()

		await h.service.resumeJob(id, { takeover: true })
		await settled(h.service)
		expect(job(id).state).toBe("running")
		expect(holder()).toBe(id)
		await hopsAgain(s, id)
		await h.service.stop()
	}, 30_000)

	it("does not resume on boot, even with onBoot set", async () => {
		const first = setup()
		const { h: h1, job: job1, live, feedUntil } = first
		await h1.service.start()
		const { id } = await h1.service.createJob({
			...sweep(),
			resume: { autoAfterIdleMs: 30, onBoot: true },
		})
		await feedUntil(() => job1(id).state === "running")
		h1.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h1.service)
		live.running = true
		live.clientCount = 1
		await vi.waitFor(() => expect(job1(id).reason).toBe("resume-blocked"), WAIT)
		await h1.service.stop()

		const s = await restarted(h1.dir)
		const { h, job, holder } = s
		const writes = h.tuner.sent.length
		await tick(100)
		await settled(h.service)
		expect(job(id)).toMatchObject({ state: "paused", reason: "resume-blocked" })
		expect(holder()).toBeUndefined()
		expect(h.tuner.sent.length).toBe(writes)
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({ code: "SCANNER_TAKEOVER_REQUIRED" })
		await h.service.stop()
	}, 30_000)
})

describe("a resume of a job that is not paused", () => {
	it("names the state and that nothing is needed, keeping the code", async () => {
		const s = setup()
		const { h, job, feedUntil } = s
		await h.service.start()
		const { id } = await h.service.createJob(sweep())
		await feedUntil(() => job(id).state === "running")
		const refused = await h.service
			.resumeJob(id, { takeover: false })
			.catch((err: unknown) => err)
		expect(refused).toMatchObject({
			statusCode: 409,
			code: "SCANNER_INVALID_TRANSITION",
		})
		expect((refused as Error).message).toContain("already running")
		expect((refused as Error).message).toContain("nothing is needed")
		await h.service.cancelJob(id)
		await settled(h.service)
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({
			code: "SCANNER_INVALID_TRANSITION",
			message: expect.stringContaining(
				"has ended (cancelled) and cannot resume; start a new scan",
			) as string,
		})
		await h.service.stop()
	}, 30_000)
})
