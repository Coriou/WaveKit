/**
 * What happens when the source stops sending data around an automatic resume: a boot resume refused
 * for no data stays owed, and a preempted sweep waits for data instead of running with nothing to hop on,
 * then carries on when data returns. What a refused resume says matches what will happen.
 */
import { describe, expect, it, vi } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

type Harness = ReturnType<typeof serviceHarness>

const noPassive = (s: ScannerSettings): void => {
	s.passive.enabled = false
}

const sweep = {
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
	priority: 50,
	takeover: true,
	resume: { autoAfterIdleMs: null },
}

async function untilRunning(h: Harness, id: string): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, 30 + i)
	}
	await settled(h.service)
}

const bootList = (h: Harness): string[] | undefined =>
	(
		h.service as unknown as { bootResume: Map<string, string[]> }
	).bootResume.get("rtl")

/** A second service on the state of a stopped one whose running sweep has resume.onBoot. */
async function restarted(): Promise<{ again: Harness; id: string }> {
	const h = serviceHarness({ patch: noPassive })
	await h.service.start()
	h.sources.emit("payload-started", "rtl")
	const job = await h.service.createJob({
		...sweep,
		resume: { autoAfterIdleMs: null, onBoot: true },
	})
	await untilRunning(h, job.id)
	expect(h.service.getJob(job.id)?.state).toBe("running")
	await h.service.stop()
	const again = serviceHarness({ dir: h.dir, patch: noPassive })
	await again.service.start()
	return { again, id: job.id }
}

const waiting: Partial<ScanJob> = { state: "paused", reason: "core-restart" }

describe("a boot resume refused for lack of data", () => {
	it("stays owed: the next payload restarts the job", async () => {
		const { again, id } = await restarted()
		// the resume is queued on payload-started; the disconnect lands before its turn
		again.sources.emit("payload-started", "rtl")
		again.sources.emit("disconnected", "rtl")
		await settled(again.service)
		expect(again.service.getJob(id)).toMatchObject<Partial<ScanJob>>(waiting)
		expect(bootList(again)).toEqual([id])

		again.sources.emit("payload-started", "rtl")
		await vi.waitFor(() =>
			expect(again.service.getJob(id)?.state).not.toBe("paused"),
		)
		await untilRunning(again, id)
		expect(again.service.getJob(id)?.state).toBe("running")
		expect(bootList(again)).toBeUndefined()
		await again.service.cancelJob(id)
		await again.service.stop()
	}, 20_000)

	it("is listed once, however many times it is refused", async () => {
		const { again, id } = await restarted()
		for (let i = 0; i < 3; i++) {
			again.sources.emit("payload-started", "rtl")
			again.sources.emit("disconnected", "rtl")
			await settled(again.service)
			expect(bootList(again)).toEqual([id])
		}
		expect(again.service.getJob(id)).toMatchObject<Partial<ScanJob>>(waiting)
		await again.service.stop()
	}, 20_000)

	it("runs at once when data returned before the refusal landed", async () => {
		const { again, id } = await restarted()
		const drivers = (
			again.service as unknown as {
				drivers: Map<
					string,
					{ dispatch(e: { type: string }): Promise<unknown> }
				>
			}
		).drivers
		const driver = drivers.get(id)!
		const dispatch = driver.dispatch.bind(driver)
		driver.dispatch = e =>
			dispatch(e).catch((err: unknown) => {
				// source-up runs here, ahead of the service's own refusal handler
				again.sources.emit("payload-started", "rtl")
				throw err
			})
		again.sources.emit("payload-started", "rtl")
		again.sources.emit("disconnected", "rtl")
		await vi.waitFor(() =>
			expect(again.service.getJob(id)?.state).not.toBe("paused"),
		)
		await untilRunning(again, id)
		expect(again.service.getJob(id)?.state).toBe("running")
		await again.service.cancelJob(id)
		await again.service.stop()
	}, 20_000)

	it("waits for the operator after a plain resume, even with its refusal still on the way", async () => {
		const { again, id } = await restarted()
		const paused = new Set<string>()
		const kinds = new Map<string, "plain" | "restore">()
		Object.assign(again.sources, {
			isPaused: (s: string) => paused.has(s),
			resumeKind: (s: string) => kinds.get(s) ?? null,
		})
		const drivers = (
			again.service as unknown as {
				drivers: Map<
					string,
					{ dispatch(e: { type: string }): Promise<unknown> }
				>
			}
		).drivers
		const driver = drivers.get(id)!
		const dispatch = driver.dispatch.bind(driver)
		let once = true
		driver.dispatch = e =>
			dispatch(e).catch((err: unknown) => {
				if (once) {
					once = false
					// the feed comes back plainly ahead of the service's refusal handler
					paused.delete("rtl")
					kinds.set("rtl", "plain")
					again.sources.emit("connected", "rtl")
					again.sources.emit("payload-started", "rtl")
					kinds.delete("rtl")
				}
				throw err
			})
		const writes = again.tuner.sent.length
		again.sources.emit("payload-started", "rtl")
		paused.add("rtl")
		again.sources.emit("feed-changed", "rtl", { state: "paused", since: "" })
		again.sources.emit("disconnected", "rtl")
		await vi.waitFor(() =>
			expect(again.service.getJob(id)?.reason).toBe("resumed-without-retune"),
		)
		await settled(again.service)
		expect(again.service.getJob(id)?.state).toBe("paused")
		expect(bootList(again)).toBeUndefined()
		expect(
			again.tuner.sent.slice(writes).filter(c => c.name !== "set-test-mode"),
		).toEqual([])
		await again.service.stop()
	}, 20_000)

	it("says the job restarts by itself while the boot resume is owed", async () => {
		const { again, id } = await restarted()
		again.sources.emit("payload-started", "rtl")
		again.sources.emit("disconnected", "rtl")
		await settled(again.service)
		await expect(
			again.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_DOWN",
			message: expect.stringContaining("restarts by itself") as string,
		})
		await again.service.stop()
	}, 20_000)
})

describe("automatic resume without data", () => {
	async function preempted() {
		const h = serviceHarness({ patch: noPassive })
		let clock = Date.now()
		const inspected = h.service as unknown as {
			now: () => number
			tick: () => void
		}
		inspected.now = () => clock
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob({
			...sweep,
			resume: { autoAfterIdleMs: 1000 },
		})
		await untilRunning(h, job.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(h.service.getJob(job.id)?.reason).toBe("preempted-operator")
		const pass = async (ms: number) => {
			clock += ms
			inspected.tick()
			await settled(h.service)
		}
		return { h, id: job.id, pass }
	}

	it("does not run with no data past the idle timeout, says so, and resumes when data returns", async () => {
		const { h, id, pass } = await preempted()
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		await pass(60_000)
		expect(h.service.getJob(id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-operator",
			resumeAt: null,
		})
		await expect(
			h.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_DOWN",
			message: expect.stringContaining("resumes by itself") as string,
		})

		h.sources.emit("payload-started", "rtl")
		await settled(h.service)
		await pass(0)
		await untilRunning(h, id)
		expect(h.service.getJob(id)?.state).toBe("running")
		await h.service.cancelJob(id)
		await h.service.stop()
	}, 20_000)

	it("without an idle timeout the refusal still asks for another resume", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const job = await h.service.createJob(sweep)
		await untilRunning(h, job.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		await expect(
			h.service.resumeJob(job.id, { takeover: false }),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_DOWN",
			message: expect.stringContaining(
				"resume this job again once data returns",
			) as string,
		})
		await h.service.stop()
	}, 20_000)

	it("a lease freed with no data reaches its waiter only when data returns", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const low = await h.service.createJob(sweep)
		await untilRunning(h, low.id)
		const high = await h.service.createJob({
			...sweep,
			priority: 90,
			ranges: [{ startHz: 451_000_000, endHz: 451_200_000 }],
		})
		await untilRunning(h, high.id)
		expect(h.service.getJob(low.id)?.reason).toBe("preempted-job")

		h.sources.emit("disconnected", "rtl")
		await settled(h.service)
		await h.service.cancelJob(high.id)
		await settled(h.service)
		expect(h.service.getJob(low.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-job",
		})
		await expect(
			h.service.resumeJob(low.id, { takeover: false }),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_DOWN",
			message: expect.stringContaining(
				"takes the tuner back by itself",
			) as string,
		})

		h.sources.emit("payload-started", "rtl")
		await vi.waitFor(() =>
			expect(h.service.getJob(low.id)?.state).not.toBe("paused"),
		)
		await untilRunning(h, low.id)
		expect(h.service.getJob(low.id)?.state).toBe("running")
		await h.service.cancelJob(low.id)
		await h.service.stop()
	}, 20_000)

	/** A sweep preempted by a running job, with a hook on the moment the free lease is handed back. */
	async function handingBack() {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		h.sources.emit("payload-started", "rtl")
		const low = await h.service.createJob(sweep)
		await untilRunning(h, low.id)
		const high = await h.service.createJob({
			...sweep,
			priority: 90,
			ranges: [{ startHz: 451_000_000, endHz: 451_200_000 }],
		})
		await untilRunning(h, high.id)
		expect(h.service.getJob(low.id)?.reason).toBe("preempted-job")
		const driver = (
			h.service as unknown as {
				drivers: Map<
					string,
					{ dispatch(e: { type: string }): Promise<unknown> }
				>
			}
		).drivers.get(low.id)!
		const dispatch = driver.dispatch.bind(driver)
		return { h, low: low.id, high: high.id, driver, dispatch }
	}

	it("a hand-back already past its check waits when the data stops, and runs on the next payload", async () => {
		const { h, low, high, driver, dispatch } = await handingBack()
		let writes = -1
		let handBacks = 0
		driver.dispatch = e => {
			if (e.type === "preemptor-idle") {
				handBacks += 1
				if (handBacks === 1) {
					// arbitration has seen data; the source drops before the job's turn to apply it
					h.sources.emit("disconnected", "rtl")
					writes = h.tuner.sent.length
				}
			}
			return dispatch(e)
		}
		await h.service.cancelJob(high)
		await settled(h.service)
		expect(handBacks).toBe(1)
		expect(h.service.getJob(low)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-job",
		})
		expect(h.tuner.sent.slice(writes)).toEqual([])

		h.sources.emit("payload-started", "rtl")
		await vi.waitFor(() =>
			expect(h.service.getJob(low)?.state).not.toBe("paused"),
		)
		await untilRunning(h, low)
		expect(h.service.getJob(low)?.state).toBe("running")
		expect(h.tuner.sent.length).toBeGreaterThan(writes)
		await h.service.cancelJob(low)
		await h.service.stop()
	}, 20_000)

	/** Frees the lease with arbitration held off, so `pass` is the only one that can hand it back. */
	async function freedForOnePass(h: Harness, high: string) {
		const inspected = h.service as unknown as {
			arbitrateLeases: (sourceId: string) => Promise<void>
			arbitrate: (sourceId: string) => Promise<void>
			handBackOwed: Set<string>
		}
		const real = inspected.arbitrateLeases
		inspected.arbitrateLeases = () => Promise.resolve()
		await h.service.cancelJob(high)
		await settled(h.service)
		inspected.arbitrateLeases = real
		return { pass: () => inspected.arbitrate("rtl"), inspected }
	}

	it("a refusal on the only pass stays owed to the next payload", async () => {
		const { h, low, high, driver, dispatch } = await handingBack()
		const { pass, inspected } = await freedForOnePass(h, high)
		let writes = -1
		driver.dispatch = e => {
			if (e.type === "preemptor-idle" && writes < 0) {
				h.sources.emit("disconnected", "rtl")
				writes = h.tuner.sent.length
			}
			return dispatch(e)
		}
		await pass()
		expect(writes).toBeGreaterThanOrEqual(0)
		expect(inspected.handBackOwed.has("rtl")).toBe(true)
		expect(h.service.getJob(low)?.state).toBe("paused")
		expect(h.tuner.sent.slice(writes)).toEqual([])

		h.sources.emit("payload-started", "rtl")
		await vi.waitFor(() =>
			expect(h.service.getJob(low)?.state).not.toBe("paused"),
		)
		await untilRunning(h, low)
		expect(h.service.getJob(low)?.state).toBe("running")
		await h.service.cancelJob(low)
		await h.service.stop()
	}, 20_000)

	it("a hand-back refused after the data returned runs at once", async () => {
		const { h, low, high, driver, dispatch } = await handingBack()
		const { pass } = await freedForOnePass(h, high)
		let once = true
		driver.dispatch = e => {
			if (e.type !== "preemptor-idle" || !once) return dispatch(e)
			once = false
			h.sources.emit("disconnected", "rtl")
			return dispatch(e).catch((err: unknown) => {
				// the payload runs here, ahead of the service's own refusal handler: nothing is owed yet
				h.sources.emit("payload-started", "rtl")
				throw err
			})
		}
		await pass()
		await vi.waitFor(() =>
			expect(h.service.getJob(low)?.state).not.toBe("paused"),
		)
		await untilRunning(h, low)
		expect(h.service.getJob(low)?.state).toBe("running")
		await h.service.cancelJob(low)
		await h.service.stop()
	}, 20_000)
})

describe("a source that has sent no data since the core started", () => {
	it("refuses a manual resume, with no disconnect ever seen, until data arrives", async () => {
		const { again, id } = await restarted()
		let lastSampleAt: number | null = null
		Object.assign(again.sources, {
			getStatus: () => ({ activity: { lastSampleAt } }),
		})
		await expect(
			again.service.resumeJob(id, { takeover: false }),
		).rejects.toMatchObject({ code: "SCANNER_SOURCE_DOWN" })
		expect(again.service.getJob(id)).toMatchObject(waiting)
		lastSampleAt = 1
		again.sources.emit("payload-started", "rtl")
		await untilRunning(again, id)
		await again.service.stop()
	}, 20_000)
})
