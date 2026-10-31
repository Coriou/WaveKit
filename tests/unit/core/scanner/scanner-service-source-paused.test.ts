/**
 * Scanner jobs and a paused receiver feed (SourceManager.pause / resume): a running sweep waits in
 * paused(source-down) through the pause and runs again on resume, never failing; an identify job,
 * starting or running, ends cancelled(source-paused); new, identify and resumed jobs on a paused
 * feed are refused with 409 SOURCE_PAUSED. A plain resume (another client may hold the receiver)
 * leaves the sweep in paused(resumed-without-retune), writing no tuning until the operator's
 * Resume scan; a restore resume continues it.
 */
import { describe, expect, it } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

type Harness = ReturnType<typeof serviceHarness>

const noPassive = (s: ScannerSettings): void => {
	s.passive.enabled = false
}
/** Markers and no samples: the first own epoch waits for its marker run, so a sweep stays starting. */
const heldStarting = (s: ScannerSettings): void => {
	s.passive.enabled = false
	s.sweep.markers = true
}

const sweep = {
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
	priority: 50,
	takeover: true,
	resume: { autoAfterIdleMs: null },
}

/** The feed half of SourceManager on the harness's fake sources. */
function pausable(h: Harness) {
	const paused = new Set<string>()
	const pending = new Map<string, "plain" | "restore">()
	Object.assign(h.sources, {
		isPaused: (id: string) => paused.has(id),
		resumeKind: (id: string) => pending.get(id) ?? null,
	})
	return {
		pause(id: string) {
			paused.add(id)
			pending.delete(id)
			h.sources.emit("feed-changed", id, { state: "paused", since: "" })
			h.sources.emit("disconnected", id)
		},
		/** Without a kind: the resumeKind-less doubles of older tests (a dropout's return). */
		resume(id: string, kind?: "plain" | "restore") {
			paused.delete(id)
			if (kind) pending.set(id, kind)
			h.sources.emit("connected", id)
			h.sources.emit("payload-started", id)
			pending.delete(id)
		},
	}
}

/** Tuning writes (not TEST_MODE markers) sent from index `from` on. */
const tuningWrites = (h: Harness, from: number) =>
	h.tuner.sent.slice(from).filter(c => c.name !== "set-test-mode")

async function untilRunning(h: Harness, id: string): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, 30 + i)
	}
	await settled(h.service)
}

describe("scanner jobs on a paused feed", () => {
	it("a running sweep waits through the pause and runs again on resume", async () => {
		const h = serviceHarness({ patch: noPassive })
		const feed = pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob(sweep)
		await untilRunning(h, job.id)
		expect(h.service.getJob(job.id)?.state).toBe("running")

		feed.pause("rtl")
		await settled(h.service)
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "source-down",
		})

		feed.resume("rtl")
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		await h.service.cancelJob(job.id)
		await h.service.stop()
	})

	it("a plain resume holds the sweep in paused(resumed-without-retune) without a tuning write until Resume scan", async () => {
		const h = serviceHarness({ patch: noPassive })
		const feed = pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob(sweep)
		await untilRunning(h, job.id)
		expect(h.service.getJob(job.id)?.state).toBe("running")

		feed.pause("rtl")
		await settled(h.service)
		const sent = h.tuner.sent.length
		feed.resume("rtl", "plain")
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, 90)
		await settled(h.service)
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "resumed-without-retune",
		})
		expect(tuningWrites(h, sent)).toEqual([])
		// The configured decoders run meanwhile.
		expect(h.decoders.held.size).toBe(0)

		// Resume scan: the operator's explicit choice retunes to the sweep's hop and it runs again.
		await h.service.resumeJob(job.id, { takeover: false })
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(tuningWrites(h, sent).some(c => c.name === "set-frequency")).toBe(
			true,
		)
		expect(h.decoders.held.size).toBeGreaterThan(0)
		await h.service.cancelJob(job.id)
		await h.service.stop()
	})

	it("a restore resume continues the sweep at once, as before", async () => {
		const h = serviceHarness({ patch: noPassive })
		const feed = pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob(sweep)
		await untilRunning(h, job.id)

		feed.pause("rtl")
		await settled(h.service)
		const sent = h.tuner.sent.length
		feed.resume("rtl", "restore")
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(tuningWrites(h, sent).some(c => c.name === "set-frequency")).toBe(
			true,
		)
		await h.service.cancelJob(job.id)
		await h.service.stop()
	})

	it("a sweep paused before engine-ready waits through the pause and runs on resume", async () => {
		const h = serviceHarness({ patch: heldStarting })
		const feed = pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob(sweep)
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("starting")

		feed.pause("rtl")
		await settled(h.service)
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "source-down",
		})

		feed.resume("rtl")
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		await h.service.cancelJob(job.id)
		await h.service.stop()
	})

	it("a dropout before engine-ready still fails the sweep (no pause)", async () => {
		const h = serviceHarness({ patch: heldStarting })
		pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob(sweep)
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("starting")

		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "failed",
			reason: "tuner-unavailable",
		})
		await h.service.stop()
	})

	it("refuses new, identify and resumed jobs while the feed is paused", async () => {
		const h = serviceHarness({ patch: noPassive })
		const feed = pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob(sweep)
		await untilRunning(h, job.id)
		await h.service.pauseJob(job.id)

		feed.pause("rtl")
		await settled(h.service)
		const refused = { code: "SOURCE_PAUSED", statusCode: 409 }
		await expect(h.service.createJob(sweep)).rejects.toMatchObject(refused)
		await expect(
			h.service.identify({ sourceId: "rtl", target: { all: true } }),
		).rejects.toMatchObject(refused)
		await expect(
			h.service.resumeJob(job.id, { takeover: false }),
		).rejects.toMatchObject(refused)
		// The operator-paused job is untouched by the refusal.
		expect(h.service.getJob(job.id)?.state).toBe("paused")

		feed.resume("rtl")
		await settled(h.service)
		await h.service.resumeJob(job.id, { takeover: false })
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		await h.service.cancelJob(job.id)
		await h.service.stop()
	})

	it("an identify job still starting ends cancelled(source-paused) on a pause, not failed", async () => {
		const h = serviceHarness({ patch: noPassive })
		const feed = pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		// No samples: identify waits for its first epoch in `starting`.
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + 100_000 },
		})
		expect(h.service.getJob(job.id)?.state).toBe("starting")

		feed.pause("rtl")
		await settled(h.service)
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "cancelled",
			reason: "source-paused",
		})
		expect(h.decoders.held.size).toBe(0)
		await h.service.stop()
	})

	it("a running identify job ends cancelled(source-paused) on a pause with its results so far", async () => {
		const h = serviceHarness({ patch: noPassive })
		const feed = pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + 100_000 },
			timeoutMs: 60_000,
			record: false,
		})
		await untilRunning(h, job.id)
		expect(h.service.getJob(job.id)?.state).toBe("running")

		feed.pause("rtl")
		await settled(h.service)
		const ended = h.service.getJob(job.id)
		expect(ended).toMatchObject<Partial<ScanJob>>({
			state: "cancelled",
			reason: "source-paused",
		})
		// The target reports what it had: ended, not left open.
		expect(ended?.identify?.targets[0]?.state).toBe("unidentified")
		await h.service.stop()
	})

	it("a dropout of a running identify job still ends it completed (no pause)", async () => {
		const h = serviceHarness({ patch: noPassive })
		pausable(h)
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + 100_000 },
			timeoutMs: 60_000,
			record: false,
		})
		await untilRunning(h, job.id)
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("completed")
		expect(h.service.getJob(job.id)?.reason).toBeUndefined()
		await h.service.stop()
	})
})
