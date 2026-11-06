/**
 * A pass adds up through the production composition (sweep-qualification-harness.ts): job progress
 * from the real service, with a voice hold, a pause, its restart and a replan. Synthetic signals only.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
	qualificationWorld,
	synthWorld,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const SIGNAL_HZ = CENTRE_HZ + 800_000 + 100_437
const STEP_MS = 100

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

describe("a pass adds up", () => {
	it("every hop's phases sum to its time across a hold, a pause, a restart and a replan", async () => {
		const w = qualificationWorld({
			centreHz: CENTRE_HZ,
			world: synthWorld([
				{ hz: SIGNAL_HZ, kind: "voice", fromMs: 2_000, toMs: 7_000 },
			]),
		})
		stops.push(() => w.stop())
		await w.service.start()
		const job = await w.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			bandplans: [],
			ranges: [RANGE],
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
		} as never)
		const hops = () => w.service.getJob(job.id)!.progress.hops!
		const check = () => {
			for (const h of hops()) {
				const phases = [
					h.measuredSettleMs!,
					h.measuredStaleMs!,
					h.measuredDwellMs!,
					h.measuredQualifyMs!,
					h.holdMs,
					h.overheadMs!,
				]
				for (const ms of phases) expect(ms).toBeGreaterThanOrEqual(0)
				expect(phases.reduce((a, b) => a + b, 0)).toBe(h.timeMs)
			}
		}
		const total = () => hops().reduce((n, h) => n + h.timeMs, 0)
		const step = async () => {
			await w.advance(STEP_MS)
			check()
		}
		// Visits abut: until a pause, the hops' times are the whole pass.
		await step()
		while (w.scheduler()?.progress().holdingOn == null) {
			expect(w.nowMs()).toBeLessThan(7_000)
			await step()
		}
		expect(total()).toBe(w.nowMs())
		const swept = hops()
		expect(swept.reduce((n, h) => n + h.measuredSettleMs!, 0)).toBeGreaterThan(
			0,
		)
		expect(swept.reduce((n, h) => n + h.measuredDwellMs!, 0)).toBeGreaterThan(0)

		// Into the hold, then a pause inside it.
		await step()
		await step()
		const heldBefore = hops().reduce((n, h) => n + h.holdMs, 0)
		expect(heldBefore).toBeGreaterThan(0)
		await w.service.pauseJob(job.id)
		check()
		const atPause = total()
		const pausedFrom = w.nowMs()
		await w.advance(2_000)
		check()
		expect(total()).toBe(atPause)

		// The resume re-sends the hop: the visit restarts, so its dwell runs again.
		const dwellBefore = hops().reduce((n, h) => n + h.measuredDwellMs!, 0)
		await w.service.resumeJob(job.id, { takeover: true })
		const pausedMs = w.nowMs() - pausedFrom
		check()
		for (let i = 0; i < 15; i++) await step()
		expect(total()).toBe(w.nowMs() - pausedMs)
		expect(hops().reduce((n, h) => n + h.measuredDwellMs!, 0)).toBeGreaterThan(
			dwellBefore,
		)
		expect(hops().reduce((n, h) => n + h.holdMs, 0)).toBeGreaterThanOrEqual(
			heldBefore,
		)

		// A replan swaps at the next hop boundary and keeps every hop's account.
		const ranges = w.service.getJob(job.id)!.spec.ranges
		await w.service.patchJob(job.id, {
			ranges: ranges.map(r => ({ ...r, dwellMs: 400 })),
		} as never)
		for (let i = 0; i < 40; i++) await step()
		expect(w.service.getJob(job.id)!.plan.hops[0]?.dwellMs).toBe(400)
		expect(total()).toBe(w.nowMs() - pausedMs)
	}, 120_000)
})
