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
	sourceCauseExcluded?: () => boolean
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
	const advisor = createLinkAdvisor({
		now: () => clock,
		monoNow: () => clock,
		...(scenario.sourceCauseExcluded
			? { sourceCauseExcluded: scenario.sourceCauseExcluded }
			: {}),
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
	let nextTake = 2000
	let nextMetrics = 5000
	let nextRecheck = scenario.recheckOffsetMs
	let pending = 0
	const readings: Array<{ at: number; advisory: LinkAdvisory }> = []
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
		while (nextTake <= t) {
			meter.takeInterval()
			nextTake += 2000
		}
		while (nextMetrics <= t) {
			advisor.observe(
				"s",
				scenario.metricsRate(nextMetrics - 5000, nextMetrics),
				RATE,
				t,
			)
			nextMetrics += 5000
		}
		while (nextRecheck <= t) {
			readings.push({ at: t, advisory: advisor.classify(input, null) })
			nextRecheck += 2000
		}
	}
	meter.dispose()
	return readings
}

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

	it("a steady link shortfall after the core recovered reads source within 20 s of the last core-busy decision, at 20 recheck phases", () => {
		const table: string[] = []
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
			const row = `phase ${phase * 100} ms: ${reasons
				.map(r => `${r.at}:${r.advisory.lossReason ?? r.advisory.level}`)
				.join(" ")}`
			table.push(row)
			const lastCoreBusy = reasons.findLast(
				r => r.advisory.lossReason === "core-busy",
			)
			const firstSource = reasons.find(r => r.advisory.lossReason === "source")
			expect(lastCoreBusy, row).toBeDefined()
			expect(firstSource, row).toBeDefined()
			if (!lastCoreBusy || !firstSource) continue
			// The core's evidence leaves the 15 s lookback by 52 s; the stretch rule then holds
			// core-busy for at most 20 s more, and source follows at the next recheck.
			expect(firstSource.at, row).toBeGreaterThan(lastCoreBusy.at)
			expect(firstSource.at - lastCoreBusy.at, row).toBeLessThanOrEqual(2_000)
			expect(firstSource.at, row).toBeLessThanOrEqual(
				STARVED_TO + 15_000 + 20_000 + 2_000,
			)
			// From then on the link is named until the end.
			for (const reading of reasons.filter(r => r.at >= firstSource.at))
				expect(reading.advisory.lossReason, row).toBe("source")
		}
		expect(table).toHaveLength(20)
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
