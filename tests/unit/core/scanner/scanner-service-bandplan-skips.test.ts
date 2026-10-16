/**
 * WG7 MA.1 (BX seam): band-plan skips through the scanner service (req 6) and the
 * decoded-elsewhere refresh on decoder manager events (req 7, with Main's max-wait).
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type {
	BandPlanSkipSource,
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
const SKIP: BandPlanSkipSource = {
	key: "operator/pmr-low",
	startHz: 446_000_000,
	endHz: 446_050_000,
}
const TARGET = 446_106_250
const sweep = (over: Record<string, unknown> = {}) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [PMR],
	takeover: true,
	resume: { autoAfterIdleMs: null },
	...over,
})
const channels = (job: { plan: ScanJob["plan"] }): number =>
	job.plan.hops.reduce((a, h) => a + h.channelCount, 0)
const noPassive = (s: { passive: { enabled: boolean } }): void => {
	s.passive.enabled = false
}
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
interface Internals {
	replanLockouts(): Promise<void>
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	vi.useRealTimers()
	for (const c of cleanups.splice(0).reverse()) await c()
})
function harness(opts: Parameters<typeof serviceHarness>[0] = {}) {
	const h = serviceHarness({ patch: noPassive, ...opts })
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	return h
}

describe("ScannerService band-plan skips (WG7 req 6)", () => {
	it("without the dependency, with an empty or a throwing one, previews and jobs are byte-identical", async () => {
		const bare = harness()
		const empty = harness({ bandPlanSkips: () => [] })
		const throwing = harness({
			bandPlanSkips: () => {
				throw new Error("view unavailable")
			},
		})
		for (const h of [bare, empty, throwing]) await h.service.start()
		for (const skip of [undefined, false, true]) {
			const spec = sweep(skip === undefined ? {} : { skipBandPlanSkips: skip })
			const p = bare.service.preview(spec)
			expect("bandPlanSkips" in p).toBe(false)
			expect(p.issues.some(i => i.code.startsWith("bandplan-skips"))).toBe(
				false,
			)
			expect(JSON.stringify(empty.service.preview(spec))).toBe(
				JSON.stringify(p),
			)
			expect(JSON.stringify(throwing.service.preview(spec))).toBe(
				JSON.stringify(p),
			)
		}
		const plain = bare.service.preview(sweep()).plan
		const job = await throwing.service.createJob(
			sweep({ skipBandPlanSkips: true }),
		)
		expect(job.plan).toEqual(plain)
		expect("bandPlanSkips" in job).toBe(false)
		// The flag is a PATCH-able key.
		const patched = await bare.service.patchJob(
			(await bare.service.createJob(sweep())).id,
			{ skipBandPlanSkips: true },
		)
		expect(patched.job.spec.skipBandPlanSkips).toBe(true)
		expect(patched.job.plan).toEqual(plain)
		expect("bandPlanSkips" in patched.job).toBe(false)
	}, 30_000)

	it("reports skips on preview, create, PATCH, replan and restore; applies them only with the flag", async () => {
		let sources: BandPlanSkipSource[] = [SKIP]
		const calls = vi.fn(() => sources)
		const h = harness({ bandPlanSkips: calls })
		const bare = harness()
		await h.service.start()
		await bare.service.start()
		const basePlan = bare.service.preview(sweep()).plan

		calls.mockClear()
		const p = h.service.preview(sweep())
		expect(calls).toHaveBeenCalledTimes(1)
		expect(p.bandPlanSkips).toEqual([
			{
				startHz: SKIP.startHz,
				endHz: SKIP.endHz,
				bandKeys: [SKIP.key],
				applied: false,
			},
		])
		expect(p.plan).toEqual(basePlan)

		const job = await h.service.createJob(sweep())
		expect(job.bandPlanSkips).toEqual(p.bandPlanSkips)
		expect(job.plan).toEqual(basePlan)

		const patched = await h.service.patchJob(job.id, {
			skipBandPlanSkips: true,
		})
		expect(patched.job.spec.skipBandPlanSkips).toBe(true)
		expect(patched.job.bandPlanSkips).toEqual([
			expect.objectContaining({ applied: true }),
		])
		expect(channels(patched.job)).toBeLessThan(channels({ plan: basePlan }))

		// A replan follows the view; an unchanged view emits nothing.
		const internals = h.service as unknown as Internals
		const events: ScanJob[] = []
		h.service.on("job", (dto: ScanJob) => {
			if (dto.id === job.id) events.push(dto)
		})
		sources = []
		await internals.replanLockouts()
		const cleared = h.service.getJob(job.id)!
		expect("bandPlanSkips" in cleared).toBe(false)
		expect(cleared.plan).toEqual(basePlan)
		expect(events).toHaveLength(1)
		await internals.replanLockouts()
		expect(events).toHaveLength(1)

		sources = [SKIP]
		await internals.replanLockouts()
		expect(h.service.getJob(job.id)!.bandPlanSkips).toEqual(
			patched.job.bandPlanSkips,
		)

		// Restored jobs plan with the skips of their restart.
		await h.service.stop()
		const again = serviceHarness({
			dir: h.dir,
			patch: noPassive,
			bandPlanSkips: () => sources,
		})
		await again.service.start()
		try {
			const restored = again.service.getJob(job.id)!
			expect(restored.state).not.toBe("failed")
			expect(restored.bandPlanSkips).toEqual(patched.job.bandPlanSkips)
			expect(restored.plan).toEqual(patched.job.plan)
		} finally {
			await again.service.stop()
		}
	}, 30_000)
})

describe("ScannerService decoded-elsewhere refresh (WG7 req 7)", () => {
	const EVENTS = [
		"decoder:created",
		"decoder:started",
		"decoder:stopped",
		"decoder:error",
		"decoder:restarting",
		"decoder:max-restarts",
		"decoder:removed",
		"decoder:health",
		"decoder:status-changed",
	]

	it("subscribes only with a coverage view, and unsubscribes on stop", async () => {
		const bare = harness()
		const h = harness({ decoderCoverage: () => [] })
		const before = EVENTS.map(e => h.decoders.listenerCount(e))
		await bare.service.start()
		await h.service.start()
		// The coverage refresh adds one listener per event over the bare service (ambient
		// evidence also watches decoder:created/removed in both).
		for (const e of EVENTS)
			expect(h.decoders.listenerCount(e)).toBe(
				bare.decoders.listenerCount(e) + 1,
			)
		await h.service.stop()
		await bare.service.stop()
		for (const [i, e] of EVENTS.entries()) {
			expect(h.decoders.listenerCount(e)).toBe(before[i])
			expect(bare.decoders.listenerCount(e)).toBe(before[i])
		}
	}, 30_000)

	it("a decoder change replans after the 2 s debounce; unchanged coverage does nothing", async () => {
		let views: DecoderCoverageView[] = []
		const h = harness({ decoderCoverage: () => views })
		await h.service.start()
		const job = await h.service.createJob(sweep({ skipDecodedElsewhere: true }))
		expect("decodedElsewhere" in job).toBe(false)
		const events: ScanJob[] = []
		h.service.on("job", (dto: ScanJob) => {
			if (dto.id === job.id) events.push(dto)
		})

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		views = [view()]
		h.decoders.emit("decoder:started", "pmr-elsewhere")
		await vi.advanceTimersByTimeAsync(1_900)
		expect(h.service.getJob(job.id)!.decodedElsewhere).toBeUndefined()
		await vi.advanceTimersByTimeAsync(200)
		vi.useRealTimers()
		await vi.waitFor(() =>
			expect(h.service.getJob(job.id)!.decodedElsewhere).toEqual([
				expect.objectContaining({
					decoderIds: ["pmr-elsewhere"],
					applied: true,
				}),
			]),
		)
		const afterFirst = events.length
		expect(afterFirst).toBeGreaterThanOrEqual(1)

		// Health noise with the same coverage: the next fire (30 s rate limit) finds the same
		// fingerprint and replans nothing.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		h.decoders.emit("decoder:health", "pmr-elsewhere", { status: "running" })
		await vi.advanceTimersByTimeAsync(31_000)
		vi.useRealTimers()
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(events.length).toBe(afterFirst)

		// The decoder stops: coverage gone, the plan comes back on the next refresh.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		views = []
		h.decoders.emit("decoder:stopped", "pmr-elsewhere")
		await vi.advanceTimersByTimeAsync(31_000)
		vi.useRealTimers()
		await vi.waitFor(() =>
			expect("decodedElsewhere" in h.service.getJob(job.id)!).toBe(false),
		)
	}, 30_000)
})
