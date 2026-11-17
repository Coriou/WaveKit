import { describe, expect, it } from "vitest"
import type { LinkAdvisory } from "@wavekit/api-types"
import { createEventLoopMeter } from "../../../src/core/link-burst/loop-meter.js"
import { createIngestRecorder } from "../../../src/core/link-burst/recorder.js"
import { createCoreLoadSignal } from "../../../src/core/core-load.js"
import {
	createLinkAdvisor,
	linkAdvisorEvidence,
	sourceCauseExcluded,
	sourceIsLive,
} from "../../../src/core/link-advisory.js"

const RATE = 2_400_000
const PAYLOAD = RATE * 2
const STEP_MS = 10
const input = { sourceId: "s", host: "source.invalid", sampleRateHz: RATE }

interface Phase {
	/** Event-loop utilisation outside stalls. */
	utilisation: number
	/** Loop delay outside stalls (ms). */
	loopDelayMs: number
}

interface Scenario {
	endMs: number
	phaseAt: (t: number) => Phase
	/** Main-thread stalls [from, to): no chunk, timer or read runs inside one. */
	stalls: Array<[number, number]>
	/**
	 * Received byte rate a metrics observation reports for its scheduled 5 s interval
	 * [from, to) (it runs late after a stall, but describes that interval).
	 */
	metricsRate: (from: number, to: number) => number
	/** Gaps in arrival with a healthy loop (the link itself stops) [from, to). */
	linkGaps?: Array<[number, number]>
	recheckOffsetMs: number
	/** Offsets (ms) of the take and metrics stamps from their 2 s and 5 s grids. */
	takeOffsetMs?: number
	metricsOffsetMs?: number
	/** The efficiency monitor stops taking intervals at this time. */
	takesUntilMs?: number
	sourceCauseExcluded?: () => boolean
	/**
	 * The tuner is under external control until this time, then the core takes it back:
	 * `source` is excluded before, and the advisor is reset then, as `wireDecoderLinkFeed`
	 * does on `control-mode-changed` to internal.
	 */
	controlReturnAt?: number
}

/**
 * The production composition on one fake clock: the real loop meter (fake histogram and ELU at
 * the perf_hooks boundary), ingest recorder, core load signal and link advisor wired as
 * src/index.ts wires them. Chunks every 10 ms, the efficiency monitor's 2 s takes, the source
 * manager's 5 s metrics, and the 2 s rechecks; a timer due inside a stall runs when it ends.
 */
function simulate(scenario: Scenario) {
	let clock = 0
	let active = 0
	let idle = 0
	let histogramMax = 0
	let histogramCount = 0
	const histogram = {
		get max() {
			return histogramMax
		},
		get count() {
			return histogramCount
		},
		percentile: () => histogramMax,
		reset: () => {
			histogramMax = 0
			histogramCount = 0
		},
		enable: () => undefined,
		disable: () => undefined,
	}
	const meter = createEventLoopMeter({
		histogram,
		monoNow: () => clock,
		elu: () => ({ active, idle }),
	})
	const recorder = createIngestRecorder()
	recorder.configure(RATE, 2)
	const controlReturnAt = scenario.controlReturnAt
	const excluded =
		controlReturnAt === undefined
			? scenario.sourceCauseExcluded
			: () => clock < controlReturnAt
	const advisor = createLinkAdvisor({
		now: () => clock,
		monoNow: () => clock,
		...(excluded ? { sourceCauseExcluded: excluded } : {}),
		...linkAdvisorEvidence({
			coreLoad: createCoreLoadSignal({ loopMeter: meter }),
			recorderOf: id => (id === "s" ? recorder : null),
			monoNow: () => clock,
		}),
	})
	const stallAt = (t: number) =>
		scenario.stalls.find(([from, to]) => t >= from && t < to)
	const linkGapAt = (t: number) =>
		scenario.linkGaps?.some(([from, to]) => t >= from && t < to) === true
	const takeOffset = scenario.takeOffsetMs ?? 0
	const metricsOffset = scenario.metricsOffsetMs ?? 0
	let nextTake = 2000
	let nextMetrics = 5000
	let nextRecheck = scenario.recheckOffsetMs
	let controlPending = controlReturnAt !== undefined
	let pending = 0
	const readings: Array<{ at: number; advisory: LinkAdvisory }> = []
	// Each 2 s take as the meter sees it: its end, utilisation and worst loop delay.
	const takes: Array<{ at: number; elu: number; loopMs: number }> = []
	let takeActive = 0
	let takeIdle = 0
	for (let t = 0; t <= scenario.endMs; t += STEP_MS) {
		const stall = stallAt(t)
		const phase = scenario.phaseAt(t)
		if (stall) {
			active += STEP_MS
			clock = t + STEP_MS
			if (t + STEP_MS >= stall[1]) {
				// The loop resumes: the histogram records the stall.
				histogramMax = Math.max(histogramMax, (stall[1] - stall[0]) * 1e6)
				histogramCount++
			}
			pending += PAYLOAD * (STEP_MS / 1000)
			continue
		}
		clock = t
		active += STEP_MS * phase.utilisation
		idle += STEP_MS * (1 - phase.utilisation)
		histogramMax = Math.max(histogramMax, phase.loopDelayMs * 1e6)
		histogramCount++
		if (!linkGapAt(t)) {
			recorder.observeChunk(PAYLOAD * (STEP_MS / 1000) + pending, t)
			pending = 0
		}
		// Timers due in this step run at their own stamps, in order (late after a stall).
		const due: Array<{ at: number; run: () => void }> = []
		const before = t + STEP_MS
		for (; nextTake + takeOffset < before; nextTake += 2000) {
			if (
				scenario.takesUntilMs !== undefined &&
				nextTake + takeOffset > scenario.takesUntilMs
			)
				continue
			due.push({
				at: Math.max(t, nextTake + takeOffset),
				run: () => {
					const loopMs = histogramCount > 0 ? histogramMax / 1e6 : 0
					const total = active - takeActive + idle - takeIdle
					takes.push({
						at: clock,
						elu: (active - takeActive) / total,
						loopMs,
					})
					takeActive = active
					takeIdle = idle
					meter.takeInterval()
				},
			})
		}
		for (; nextMetrics + metricsOffset < before; nextMetrics += 5000) {
			const bytes = scenario.metricsRate(nextMetrics - 5000, nextMetrics)
			due.push({
				at: Math.max(t, nextMetrics + metricsOffset),
				run: () => advisor.observe("s", bytes, RATE, clock),
			})
		}
		if (
			controlPending &&
			controlReturnAt !== undefined &&
			controlReturnAt < before
		) {
			controlPending = false
			due.push({
				at: Math.max(t, controlReturnAt),
				run: () => advisor.reset("s"),
			})
		}
		for (; nextRecheck < before; nextRecheck += 2000)
			due.push({
				at: Math.max(t, nextRecheck),
				run: () =>
					readings.push({ at: clock, advisory: advisor.classify(input, null) }),
			})
		due.sort((a, b) => a.at - b.at)
		for (const event of due) {
			clock = event.at
			event.run()
		}
	}
	meter.dispose()
	return Object.assign(readings, { takes })
}

const row = (
	label: string,
	readings: Array<{ at: number; advisory: LinkAdvisory }>,
): string =>
	`${label}: ${readings
		.map(r => `${r.at}:${r.advisory.lossReason ?? r.advisory.level}`)
		.join(" ")}`

/** Stall-free starvation from 20 s to `endMs` (ELU 0.97, loop 40 ms), losing 3 % meanwhile. */
const stallFree = (
	endMs: number,
	recheckOffsetMs: number,
	utilisation = 0.97,
): Scenario => ({
	endMs: 80_000,
	phaseAt: t =>
		t >= STARVED_FROM && t < endMs
			? { utilisation, loopDelayMs: 40 }
			: { utilisation: 0.3, loopDelayMs: 5 },
	stalls: [],
	metricsRate: (from, to) =>
		to > STARVED_FROM && from < endMs ? PAYLOAD * 0.97 : PAYLOAD,
	recheckOffsetMs,
})

const STARVED_FROM = 20_000
const STARVED_TO = 37_000
const starvation: Omit<Scenario, "recheckOffsetMs"> = {
	endMs: 70_000,
	phaseAt: t =>
		t >= STARVED_FROM && t < STARVED_TO
			? { utilisation: 0.97, loopDelayMs: 40 }
			: { utilisation: 0.3, loopDelayMs: 5 },
	stalls: [
		[24_000, 25_500],
		[29_000, 30_800],
		[35_000, 37_000],
	],
	// Each 5 s metrics interval overlapping the starvation loses 3 %.
	metricsRate: (from, to) =>
		to > STARVED_FROM && from < STARVED_TO ? PAYLOAD * 0.97 : PAYLOAD,
}

describe("a starvation episode's tail through the production composition", () => {
	it("never reads source from the start of starvation until dropping ends, at 20 recheck phases", () => {
		const table: string[] = []
		const offenders: string[] = []
		for (let phase = 0; phase < 20; phase++) {
			const readings = simulate({
				...starvation,
				recheckOffsetMs: phase * 100,
			})
			const dropping = readings.filter(r => r.advisory.level === "dropping")
			expect(dropping.length).toBeGreaterThan(0)
			const lastDropping = dropping.at(-1)?.at ?? 0
			const stretch = readings.filter(
				r => r.at >= STARVED_FROM && r.at <= lastDropping,
			)
			const causes = stretch.map(r => r.advisory.lossReason ?? "none")
			table.push(
				`phase ${phase * 100} ms: ${stretch
					.map(r => `${r.at}:${r.advisory.lossReason ?? r.advisory.level}`)
					.join(" ")}`,
			)
			if (causes.includes("source")) offenders.push(table.at(-1) ?? "")
			expect(causes, table.at(-1)).toContain("core-busy")
			// Dropping ends within the averaged window after the last lossy interval.
			expect(lastDropping).toBeLessThan(STARVED_TO + 15_000)
			const after = readings.filter(r => r.at > lastDropping)
			expect(after.length).toBeGreaterThan(0)
			for (const reading of after)
				expect(reading.advisory.lossReason).toBeUndefined()
		}
		// Every dropping reading in every phase names the core, never the link.
		expect(offenders).toEqual([])
	})

	it("a stall-free starvation ending anywhere from 40 s to 50 s never reads source while dropping, at 20 recheck phases", () => {
		// Every end in 100 ms steps (101 ends x 20 phases = 2020 runs, ~8 s on a quiet host). Take
		// and metrics stamps sit 1 ms off their grids, alternating sides by phase, so no take,
		// metrics observation or recheck ties with another.
		const offenders: string[] = []
		let cells = 0
		for (let end = 40_000; end <= 50_000; end += 100)
			for (let phase = 0; phase < 20; phase++) {
				const side = phase % 2 === 0 ? 1 : -1
				const readings = simulate({
					...stallFree(end, phase * 100),
					takeOffsetMs: side,
					metricsOffsetMs: -side,
				})
				const dropping = readings.filter(r => r.advisory.level === "dropping")
				const lastDropping = dropping.at(-1)?.at ?? 0
				const stretch = readings.filter(
					r => r.at >= STARVED_FROM && r.at <= lastDropping,
				)
				cells++
				if (
					dropping.length === 0 ||
					!stretch.some(r => r.advisory.lossReason === "core-busy") ||
					stretch.some(r => r.advisory.lossReason === "source")
				)
					offenders.push(row(`end ${end} phase ${phase * 100}`, stretch))
			}
		expect(cells).toBe(2020)
		expect(offenders).toEqual([])
	}, 120_000)

	it("never reads source from 4 s after the onset of starvation, and names the core", () => {
		for (let phase = 0; phase < 20; phase++) {
			const readings = simulate({
				...stallFree(60_000, phase * 100),
				takeOffsetMs: 1,
				metricsOffsetMs: -1,
			})
			const starving = readings.filter(
				r => r.at >= STARVED_FROM + 4000 && r.at < 60_000,
			)
			const label = row(`phase ${phase * 100}`, starving)
			const dropping = starving.filter(r => r.advisory.level === "dropping")
			expect(dropping.length, label).toBeGreaterThan(10)
			for (const reading of dropping)
				expect(reading.advisory.lossReason, label).toBe("core-busy")
		}
	})

	it("a steady link shortfall after the core recovered reads source only once the core's evidence left W, and by 21 s after the starvation, at 20 recheck phases", () => {
		for (let phase = 0; phase < 20; phase++) {
			const readings = simulate({
				...starvation,
				endMs: 150_000,
				// The link loses 5 % from the starvation on, with no arrival gaps.
				metricsRate: (from, to) =>
					to > STARVED_FROM && from < 150_000 ? PAYLOAD * 0.95 : PAYLOAD,
				recheckOffsetMs: phase * 100,
			})
			const reasons = readings.filter(r => r.at >= STARVED_FROM)
			const label = row(`phase ${phase * 100}`, reasons)
			const lastStressed = readings.takes.findLast(
				take => take.elu >= 0.9 || take.loopMs >= 200,
			)
			const firstSource = reasons.find(r => r.advisory.lossReason === "source")
			expect(lastStressed, label).toBeDefined()
			expect(firstSource, label).toBeDefined()
			if (!lastStressed || !firstSource) continue
			expect(reasons.some(r => r.advisory.lossReason === "core-busy")).toBe(
				true,
			)
			// W is at least the sustained window: the last stressed take is still in it before.
			expect(firstSource.at, label).toBeGreaterThan(lastStressed.at + 10_000)
			expect(firstSource.at, label).toBeLessThanOrEqual(STARVED_TO + 21_000)
			// From then on the link is named until the end.
			for (const reading of reasons.filter(r => r.at >= firstSource.at))
				expect(reading.advisory.lossReason, label).toBe("source")
		}
	})

	it("a stopped efficiency monitor reads unknown: neither source nor a permanent core-busy", () => {
		for (const phase of [0, 700, 1300]) {
			// Takes stop at 30 s, mid-starvation; the link then keeps losing 5 % to the end.
			const readings = simulate({
				...stallFree(40_000, phase),
				endMs: 120_000,
				takesUntilMs: 30_000,
				// A stall after the last take stays in the live histogram, never reset again.
				stalls: [[32_000, 33_000]],
				metricsRate: (from, to) =>
					to > STARVED_FROM ? PAYLOAD * 0.95 : PAYLOAD,
			})
			const label = row(`phase ${phase}`, readings)
			const dropping = readings.filter(r => r.advisory.level === "dropping")
			expect(dropping.length, label).toBeGreaterThan(30)
			for (const reading of dropping)
				expect(reading.advisory.lossReason, label).not.toBe("source")
			// Once the last take left W, nothing asserts the core either.
			for (const reading of dropping.filter(r => r.at >= 50_000))
				expect(reading.advisory.lossReason, label).toBe("unknown")
		}
	})

	it("a shortfall accrued under external control does not read source once the core takes the tuner back", () => {
		for (const phase of [0, 900, 1700]) {
			const base = {
				endMs: 70_000,
				phaseAt: () => ({ utilisation: 0.3, loopDelayMs: 5 }),
				stalls: [],
				// The shortfall ends when control returns at 40 s.
				metricsRate: (from: number, to: number) =>
					to > 20_000 && from < 40_000 ? PAYLOAD * 0.97 : PAYLOAD,
				recheckOffsetMs: phase,
			}
			const readings = simulate({ ...base, controlReturnAt: 40_000 })
			const label = row(`phase ${phase}`, readings)
			const under = readings.filter(
				r => r.at < 40_000 && r.advisory.level === "dropping",
			)
			expect(under.length, label).toBeGreaterThan(0)
			for (const reading of readings)
				expect(reading.advisory.lossReason, label).not.toBe("source")
			// Without the reset the averaged shortfall would read source after 40 s.
			const unreset = simulate({
				...base,
				sourceCauseExcluded: () => false,
			}).filter(r => r.at >= 40_000)
			expect(unreset.some(r => r.advisory.lossReason === "source")).toBe(true)
		}
	})

	it("a stretch where every take is at least 0.9 busy reads core-busy throughout, never alternating with unknown", () => {
		for (const phase of [0, 300, 900, 1500, 1900]) {
			// Takes alternate 0.97 and 0.92 busy.
			const readings = simulate({
				...stallFree(60_000, phase),
				phaseAt: t =>
					t >= STARVED_FROM && t < 60_000
						? {
								utilisation: Math.floor(t / 2000) % 2 ? 0.92 : 0.97,
								loopDelayMs: 40,
							}
						: { utilisation: 0.3, loopDelayMs: 5 },
			})
			const dropping = readings.filter(r => r.advisory.level === "dropping")
			expect(dropping.length).toBeGreaterThan(10)
			for (const reading of dropping)
				expect(
					reading.advisory.lossReason,
					row(`phase ${phase}`, dropping),
				).toBe("core-busy")
		}
	})

	it("a stretch where every take is 0.7 to 0.9 busy reads unknown throughout: the evidence names neither side", () => {
		for (const phase of [0, 700, 1300]) {
			const readings = simulate(stallFree(60_000, phase, 0.8))
			const dropping = readings.filter(r => r.advisory.level === "dropping")
			expect(dropping.length).toBeGreaterThan(10)
			for (const reading of dropping)
				expect(
					reading.advisory.lossReason,
					row(`phase ${phase}`, dropping),
				).toBe("unknown")
		}
	})

	it("a slow link with a healthy loop still reads source", () => {
		for (const phase of [0, 700, 1300]) {
			const readings = simulate({
				endMs: 40_000,
				phaseAt: () => ({ utilisation: 0.3, loopDelayMs: 5 }),
				stalls: [],
				linkGaps: [
					[21_000, 21_600],
					[26_000, 26_700],
				],
				metricsRate: (from, to) =>
					to > 20_000 && from < 30_000 ? PAYLOAD * 0.97 : PAYLOAD,
				recheckOffsetMs: phase,
			})
			const dropping = readings.filter(r => r.advisory.level === "dropping")
			expect(dropping.length).toBeGreaterThan(0)
			for (const reading of dropping)
				expect(reading.advisory.lossReason).toBe("source")
		}
	})

	it("a link gap after the core recovered replaces core-busy with source", () => {
		const readings = simulate({
			...starvation,
			// The stall evidence leaves the 15 s lookback at 53 s; the link then stops.
			linkGaps: [[56_000, 56_800]],
			metricsRate: (from, to) =>
				to > STARVED_FROM && from < 62_000 ? PAYLOAD * 0.97 : PAYLOAD,
			recheckOffsetMs: 300,
		})
		const causes = readings
			.filter(r => r.advisory.level === "dropping")
			.map(r => r.advisory.lossReason)
		expect(causes).toContain("core-busy")
		expect(causes.at(-1)).toBe("source")
		expect(causes.indexOf("source")).toBeGreaterThan(
			causes.lastIndexOf("core-busy"),
		)
	})

	it("reads unknown, not source, while the source cause is excluded", () => {
		const readings = simulate({
			endMs: 40_000,
			phaseAt: () => ({ utilisation: 0.3, loopDelayMs: 5 }),
			stalls: [],
			linkGaps: [[21_000, 21_600]],
			metricsRate: (from, to) =>
				to > 20_000 && from < 40_000 ? PAYLOAD * 0.97 : PAYLOAD,
			recheckOffsetMs: 0,
			sourceCauseExcluded: () => true,
		})
		const dropping = readings.filter(r => r.advisory.level === "dropping")
		expect(dropping.length).toBeGreaterThan(0)
		for (const reading of dropping)
			expect(reading.advisory.lossReason).toBe("unknown")
	})
})

describe("sourceCauseExcluded", () => {
	const of = (
		mode: string | null,
	): Parameters<typeof sourceCauseExcluded>[0] => ({
		controlModeOf: () => mode,
	})
	it("excludes external tuner control only", () => {
		expect(sourceCauseExcluded(of("external"), "s")).toBe(true)
		expect(sourceCauseExcluded(of("internal"), "s")).toBe(false)
		expect(sourceCauseExcluded(of(null), "s")).toBe(false)
	})

	it("a sustained link shortfall with a healthy core reads source throughout", () => {
		// Rate truth measures the same received bytes, so it would report this link failure as
		// a slower dongle at about 30 s; that must not turn the cause unknown.
		for (const phase of [0, 900, 1700]) {
			const readings = simulate({
				endMs: 90_000,
				phaseAt: () => ({ utilisation: 0.3, loopDelayMs: 5 }),
				stalls: [],
				metricsRate: (from, to) =>
					to > 20_000 && from < 80_000 ? PAYLOAD * 0.97 : PAYLOAD,
				recheckOffsetMs: phase,
				sourceCauseExcluded: () =>
					sourceCauseExcluded({ controlModeOf: () => "internal" }, "s"),
			})
			const dropping = readings.filter(r => r.advisory.level === "dropping")
			expect(dropping.length).toBeGreaterThan(20)
			for (const reading of dropping)
				expect(reading.advisory.lossReason, `${reading.at}`).toBe("source")
		}
	})
})

describe("sourceIsLive, the advisor's live gate in src/index.ts", () => {
	const manager = (
		status: { connected: boolean } | undefined,
		paused: boolean,
	) => ({
		getStatus: () => status,
		isPaused: () => paused,
	})
	it("is live only while connected with a live feed", () => {
		expect(sourceIsLive(manager({ connected: true }, false), "s")).toBe(true)
		// Paused, resuming or failed to resume: the feed is held back.
		expect(sourceIsLive(manager({ connected: true }, true), "s")).toBe(false)
		// Disconnected or in error (reconnecting): not live.
		expect(sourceIsLive(manager({ connected: false }, false), "s")).toBe(false)
		expect(sourceIsLive(manager(undefined, false), "s")).toBe(false)
	})

	it("drops a paused source's observations and reads none through the advisor", () => {
		let live = true
		const sources = {
			getStatus: () => ({ connected: true }),
			isPaused: () => !live,
		}
		let clock = 0
		const advisor = createLinkAdvisor({
			now: () => clock,
			monoNow: () => clock,
			live: id => sourceIsLive(sources, id),
		})
		for (clock = 5000; clock <= 20_000; clock += 5000)
			advisor.observe("s", PAYLOAD * 0.9, RATE, clock)
		expect(advisor.classify(input, null).level).toBe("dropping")
		live = false
		const paused = advisor.classify(input, null)
		expect(paused.level).toBe("none")
		expect(paused.lossReason).toBeUndefined()
	})
})
