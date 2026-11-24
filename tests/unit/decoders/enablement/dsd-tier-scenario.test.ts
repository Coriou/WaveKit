/**
 * dsd-fme activity slots by evidence tier, production composition: the real
 * DecoderManager, planPlacements, createChannelActivityRanker and the real
 * dsd-fme decoder with its checked-sync parser. Fake timers drive one clock.
 *
 * MODELLED inputs (labelled; not captures): the spectrum is a list of block
 * tracks per 900 ms block (not IQ), the scanner history (analog FM proof and
 * identity) is a modelled provider, the channelizer and the dsd-fme child are
 * in-process fakes, and a DMR burst replays checked rows of the synthesised
 * fixture `dmr-ms-two-ptt.txt`. Traffic is seeded:
 * - 10 analog FM voices on 12.5 kHz channels (overs 5-40 s, gaps 2-30 s);
 *   8 carry modelled scanner analog FM proof, 2 have none. Their fake child
 *   never prints a sync.
 * - one DMR channel: a 3 s burst every U(180, 300) s.
 * - one unknown 4FSK-like carrier from t = 1 800 s: 15 s on every 60 s, no
 *   history, no sync.
 * Warm-up rule for the analog move metric: moves count from after the first
 * history refresh (2 s, ACTIVITY_HISTORY_REFRESH_MS), so a channel's
 * modelled analog proof is known before its moves are judged.
 *
 * Block size (speed): BLOCK_MS = 900 < ACTIVITY_LIVE_TTL_MS = 1 000, so a
 * channel's latest energy block is always under the live TTL at any pass
 * (live never lapses inside a transmission, and the ranker's live-expiry
 * deadline at block + 1 000 ms is always preceded by the next block). The
 * shortest transmission is a 3 s DMR burst, which spans at least
 * floor(3 000 / 900) = 3 blocks; overs are >= 5 s (>= 5 blocks) and gaps
 * >= 2 s (>= 2 quiet blocks), so every burst and every gap is seen. Each
 * run asserts both (minBurstBlocks, minGapBlocks).
 */
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { PassThrough } from "node:stream"
import type * as ChildProcessModule from "node:child_process"
import type { ChildProcess } from "node:child_process"
import type * as ProcessToolsModule from "../../../../src/decoders/process-tools.js"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"

const MARKER = Buffer.from("BURST-ON-CHANNEL")
function fixtureRows(name: string) {
	return readFileSync(
		new URL(`../../../mocks/fixtures/dsd-fme/${name}`, import.meta.url),
		"utf8",
	)
		.split("\n")
		.filter(line => line && !line.startsWith("#"))
		.map(row => ({
			at: Number(row.split("\t")[0]),
			line: row.slice(row.indexOf("\t") + 1),
		}))
}
/** The first second of the first PTT: checked VLC/VC rows (fixture, modelled). */
const BURST_ROWS = fixtureRows("dmr-ms-two-ptt.txt").filter(r => r.at < 1_000)

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	readonly pid = undefined
	killed = false
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	constructor() {
		super()
		this.stdin.on("data", (chunk: Buffer) => {
			if (!chunk.includes(MARKER) || this.killed) return
			for (const row of BURST_ROWS)
				setTimeout(() => {
					if (!this.killed) this.stderr.write(`${row.line}\n`)
				}, row.at)
		})
		setImmediate(() => this.emit("spawn"))
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.killed) return true
		this.killed = true
		this.signalCode = signal
		setImmediate(() => {
			this.stdout.end()
			this.stderr.end()
			this.emit("exit", null, signal)
			this.emit("close", null, signal)
		})
		return true
	}
}

vi.mock("node:child_process", async importOriginal => {
	const actual = await importOriginal<typeof ChildProcessModule>()
	return {
		...actual,
		spawn: vi.fn(() => new FakeChild() as unknown as ChildProcess),
	}
})
vi.mock("../../../../src/decoders/process-tools.js", async importOriginal => {
	const actual = await importOriginal<typeof ProcessToolsModule>()
	return {
		...actual,
		signalDecoder: (proc: ChildProcess, signal: NodeJS.Signals) => {
			proc.kill(signal)
		},
	}
})

const { DecoderManager } = await import("../../../../src/decoders/manager.js")
const { DecoderRegistry } = await import("../../../../src/decoders/registry.js")
const { FanoutManager } = await import("../../../../src/core/fanout-manager.js")
const { createDsdFmeDecoder, DSD_FME_CAPS } =
	await import("../../../../src/decoders/builtin/dsd-fme.js")
const { resolveActivityPolicy } =
	await import("../../../../src/decoders/enablement/activity-plan.js")
const { EFFICIENCY_BUDGET_X64 } =
	await import("../../../../src/decoders/enablement/contract.js")
const { planPlacements } =
	await import("../../../../src/decoders/enablement/placement.js")
const { ACTIVITY_LIVE_TTL_MS, createChannelActivityRanker } =
	await import("../../../../src/core/scanner/channel-activity.js")
const { FakeSources, iqCaps } = await import("../../../mocks/rate-fakes.js")
const { mulberry32 } = await import("../../../mocks/scanner/signals.js")
import type { ChannelRequestResult } from "../../../../src/core/channelizer/types.js"
import type { PlannerInput } from "../../../../src/decoders/enablement/contract.js"

const RATE = 1_024_000
const CENTRE = 446_315_000
const BLOCK_MS = 900
const HOUR_MS = 3_600_000
const pmr = (k: number) => 446_006_250 + k * 12_500
const ANALOG = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10].map(pmr)
/** The 8 analog channels with modelled scanner analog FM proof. */
const CLASSIFIED = ANALOG.slice(0, 8)
const DMR = pmr(8)
const UNKNOWN = 446_181_250
const UNKNOWN_FROM_MS = 1_800_000

type Span = readonly [number, number]

interface Variant {
	seed: number
	/** "identity": scanner DMR decode at 600 s; "hysteresis": two overs 10 s apart. */
	discovery: "identity" | "hysteresis" | "none"
	durationMs: number
	slots?: number
	/** DMR silent from this time on. */
	dmrUntilMs?: number
	unknownFromMs?: number
	/** The DMR channel also carries modelled analog FM proof. */
	dmrAnalog?: boolean
	/** Voice channels with modelled scanner analog FM proof (default 8 of 10). */
	classified?: number
}

export interface ScenarioMetrics {
	bursts: number
	burstsHeld: number
	heldShare: number
	moves: number
	movesPerHour: number
	classifiedAnalogMoves: number
	unclassifiedTries: Record<number, number>
	/** Tries per unclassified channel per 1 h window from t = 30 min (last window partial). */
	unclassifiedWindows: Record<number, number[]>
	/** Start times of every try (move into it) per unclassified channel. */
	unclassifiedTryTimes: Record<number, number[]>
	/** Start times of the rate-gated analog tries (analog-to-analog by tier). */
	analogRetryTimes: number[]
	/** Analog-to-analog moves (by channel identity) that are neither of the two tries. */
	analogOtherMoves: number
	/** All moves per hour after the 30 min warm-up. */
	steadyMovesPerHour: number
	analogToAnalogPerHour: number
	/** Fewest energy blocks any transmission was seen in; fewest quiet blocks in a gap. */
	minBurstBlocks: number
	minGapBlocks: number
	firstIdentityMs: number | null
	firstSyncMs: number | null
	unknownConfirmedMs: number | null
	unknownPlacedMs: number | null
	unknownPlacedState: string | null
	nosyncHoldShare: number
	reasonViolations: string[]
	placementReasons: Record<string, number>
	syncs: number
	dmrRunningMs: number
	moveTargets: Record<string, number>
	analogTries: string[]
}

function schedule(rng: () => number, durationMs: number) {
	const voice = new Map<number, Span[]>()
	for (const hz of ANALOG) {
		const spans: Span[] = []
		let t = rng() * 30_000
		while (t < durationMs) {
			const len = 5_000 + rng() * 35_000
			spans.push([t, t + len])
			t += len + 2_000 + rng() * 28_000
		}
		voice.set(hz, spans)
	}
	const dmr: Span[] = []
	let t = 60_000 + rng() * 120_000
	while (t < durationMs) {
		dmr.push([t, t + 3_000])
		t += 180_000 + rng() * 120_000
	}
	return { voice, dmr }
}

const lastStart = (spans: readonly Span[] | undefined, t: number) => {
	let last: number | null = null
	for (const [a] of spans ?? []) if (a <= t) last = a
	return last
}

let teardown: (() => Promise<void>) | null = null
afterEach(async () => {
	await teardown?.()
	teardown = null
	vi.useRealTimers()
})

async function runScenario(v: Variant): Promise<ScenarioMetrics> {
	vi.useFakeTimers({
		toFake: [
			"Date",
			"performance",
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
		],
	})
	vi.setSystemTime(Date.parse("2026-10-23T12:00:00.000Z"))
	const t0 = performance.now()
	const elapsed = () => performance.now() - t0
	const rng = mulberry32(v.seed)
	const { voice, dmr: dmrAll } = schedule(rng, v.durationMs)
	const dmrBursts = dmrAll.filter(([a]) => a < (v.dmrUntilMs ?? Infinity))
	// Variant "hysteresis": the first discovery is two bursts 10 s apart at 600 s.
	if (v.discovery === "hysteresis") {
		const at = dmrBursts.findIndex(([a]) => a > 600_000)
		dmrBursts.splice(Math.max(0, at), 0, [600_000, 603_000], [610_000, 613_000])
	}
	const unknownFrom = v.unknownFromMs ?? UNKNOWN_FROM_MS
	const unknownOn = (t: number) =>
		t >= unknownFrom && (t - unknownFrom) % 60_000 < 15_000
	const classified = ANALOG.slice(0, v.classified ?? CLASSIFIED.length)
	const analogProof = new Set<number>([
		...classified,
		...(v.dmrAnalog ? [DMR] : []),
	])

	const logger = pino({ level: "silent" })
	const monoNow = () => performance.now()
	const ranker = createChannelActivityRanker({ monoNow })
	// MODELLED scanner history: analog FM proof aged from the channel's latest over.
	ranker.setHistory(() => {
		const t = elapsed()
		const analog: { hz: number; ageMs: number }[] = []
		for (const hz of analogProof) {
			const start = lastStart(voice.get(hz) ?? dmrBursts, t)
			if (start !== null) analog.push({ hz, ageMs: Math.max(0, t - start) })
		}
		return { decodes: [], successes: [], occupancy: [], analog }
	})
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	registry.register("dsd-fme", createDsdFmeDecoder, DSD_FME_CAPS)
	const moves: {
		at: number
		fromHz: number
		toHz: number
		analogRetry?: boolean
	}[] = []
	let unknownConfirmedMs: number | null = null
	const manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		logger,
		{
			validateVersions: false,
			enablement: {
				planner: (input: PlannerInput) => {
					const plan = planPlacements(input)
					const t = elapsed()
					for (const m of plan.activity?.moves ?? [])
						moves.push({
							at: t,
							fromHz: m.fromHz,
							toHz: m.toHz,
							...(m.kind === "analog-try" ? { analogRetry: true } : {}),
						})
					if (
						unknownConfirmedMs === null &&
						input.activity?.confirmedChallengers?.some(k =>
							k.includes(String(UNKNOWN)),
						)
					)
						unknownConfirmedMs = t
					return plan
				},
				resolveMode: () => ({ mode: "auto", source: "default" }),
				isCatalogue: () => false,
				unavailable: () => false,
				recheckAvailable: async () => true,
				vfo: () => ({ sourceId: "rtl", frequencyHz: CENTRE }),
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
				activity: {
					port: ranker.port,
					epochOf: sourceId => ranker.epochOf(sourceId),
					policy: resolveActivityPolicy(
						v.slots !== undefined
							? { slots: { "dsd-fme": v.slots } }
							: undefined,
						EFFICIENCY_BUDGET_X64,
						"x64",
						8,
					),
					monoNow,
				},
			},
		},
	)
	manager.setSourceManager(sources as never)
	const channels = new Map<string, { centerHz: number; stream: PassThrough }>()
	let seq = 0
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: async (
			_sourceId: string,
			_decoderId: string,
			req: { centerHz: number },
		): Promise<ChannelRequestResult> => {
			const channelId = String(++seq)
			const stream = new PassThrough()
			channels.set(channelId, { centerHz: req.centerHz, stream })
			return {
				ok: true as const,
				stream,
				channelId,
				generation: 1,
				realised: {
					outputRateHz: 48_000,
					format: "cu8" as const,
					groupDelaySamples: 0,
				},
			}
		},
		releaseChannel: async (channelId: string) => {
			channels.get(channelId)?.stream.end()
			channels.delete(channelId)
		},
		currentGeneration: () => 1,
	})
	manager.setChannelizer(provider as never)
	let firstSyncMs: number | null = null
	let syncs = 0
	manager.on(
		"decoder:placed-link",
		(
			_id: string,
			line: { verified?: boolean },
			binding: { channelHz: number | null } | undefined,
		) => {
			if (line.verified !== true || binding?.channelHz !== DMR) return
			syncs++
			if (firstSyncMs === null) firstSyncMs = elapsed()
		},
	)
	teardown = async () => {
		await manager.destroy()
		ranker.dispose()
	}
	void manager.createDecoder({
		id: "voice",
		type: "dsd-fme",
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	await manager.startAll()
	ranker.ingestEpoch("rtl", "engine", 1)

	const placements = () =>
		(manager.getStatus("voice")?.placements ?? []).filter(
			p => p.origin === "activity" && p.running && p.channelHz !== null,
		)
	let firstIdentityMs: number | null = null
	let unknownPlacedMs: number | null = null
	let unknownPlacedState: string | null = null
	let bursts = 0
	let burstsHeld = 0
	let slotMs = 0
	let dmrRunningMs = 0
	let nosyncMs = 0
	const runningSince = new Map<number, number>()
	const reasonViolations: string[] = []
	const placementReasons: Record<string, number> = {}
	// Held-share sample: the first block end at or after burst start + 500 ms.
	const burstChecks = new Set(
		dmrBursts.map(([a]) => Math.ceil((a + 500) / BLOCK_MS) * BLOCK_MS),
	)
	// Blocks with energy per transmission and quiet blocks per gap (coverage).
	// Block times only grow, so one cursor per channel walks its spans once.
	const seenIn = new Map<string, number>()
	const quietIn = new Map<string, number>()
	const cursors = new Map<string, number>()
	/** Whether `t` is inside a span of `name`, counting coverage on the way. */
	const cover = (name: string, spans: readonly Span[], t: number) => {
		let i = cursors.get(name) ?? 0
		while (i < spans.length && spans[i]![1] <= t) i++
		cursors.set(name, i)
		const inside = i < spans.length && spans[i]![0] <= t
		const key = inside ? `${name}:${i}` : `${name}:${i - 1}`
		if (inside) seenIn.set(key, (seenIn.get(key) ?? 0) + 1)
		else if (
			i >= 1 &&
			i < spans.length &&
			spans[i]![0] <= v.durationMs - BLOCK_MS
		)
			quietIn.set(key, (quietIn.get(key) ?? 0) + 1)
		return inside
	}
	let nextSample = 60_000
	for (let t = 0; t < v.durationMs; t += BLOCK_MS) {
		const voiceOn = new Set(
			ANALOG.filter(hz => cover(String(hz), voice.get(hz)!, t)),
		)
		const dmrOn = cover("dmr", dmrBursts, t)
		if (
			v.discovery === "identity" &&
			firstIdentityMs === null &&
			t >= 600_000
		) {
			ranker.noteDecode("rtl", DMR, "dmr")
			firstIdentityMs = t
		}
		if (
			v.discovery === "hysteresis" &&
			firstIdentityMs === null &&
			t >= 600_000
		)
			firstIdentityMs = t
		const tracks: {
			startHz: number
			endHz: number
			flags: { iqImage: false }
		}[] = []
		const add = (hz: number) =>
			tracks.push({
				startHz: hz - 4_000,
				endHz: hz + 4_000,
				flags: { iqImage: false },
			})
		for (const hz of voiceOn) add(hz)
		if (dmrOn) add(DMR)
		if (unknownOn(t)) add(UNKNOWN)
		ranker.ingestBlock("rtl", "engine", {
			epoch: 1,
			centreHz: CENTRE,
			sampleRateHz: RATE,
			overload: false,
			tracks,
		})
		if (dmrOn)
			for (const c of channels.values())
				if (c.centerHz === DMR) c.stream.write(MARKER)
		await vi.advanceTimersByTimeAsync(BLOCK_MS)
		const now = t + BLOCK_MS
		const running = placements()
		const hzs = new Set(running.map(p => p.channelHz!))
		for (const hz of hzs) if (!runningSince.has(hz)) runningSince.set(hz, now)
		if (unknownPlacedMs === null && hzs.has(UNKNOWN)) {
			unknownPlacedMs = now
			unknownPlacedState =
				running.find(p => p.channelHz === UNKNOWN)?.activity?.state ?? null
		}
		for (const hz of [...runningSince.keys()])
			if (!hzs.has(hz)) runningSince.delete(hz)
		if (
			burstChecks.has(now) &&
			firstSyncMs !== null &&
			now - 1_000 > firstSyncMs
		) {
			bursts++
			if (hzs.has(DMR)) burstsHeld++
		}
		if (hzs.has(DMR)) dmrRunningMs += BLOCK_MS
		for (const hz of hzs) {
			slotMs += BLOCK_MS
			if (hz !== DMR && now - runningSince.get(hz)! >= 20_000)
				nosyncMs += BLOCK_MS
		}
		const sample = now >= nextSample
		if (sample) nextSample += 60_000
		if (sample)
			for (const p of running) {
				const reasons = p.activity?.reasons ?? []
				for (const r of reasons)
					placementReasons[r] = (placementReasons[r] ?? 0) + 1
				const hz = p.channelHz!
				const age = now - runningSince.get(hz)!
				if (hz === DMR && firstSyncMs !== null) {
					if (!reasons.includes("digital-memory" as never))
						reasonViolations.push(`${now}: DMR without digital-memory`)
				} else if (classified.includes(hz) && hz !== DMR) {
					if (
						!reasons.includes("analog-voice" as never) &&
						!reasons.includes("no-sync" as never)
					)
						reasonViolations.push(`${now}: analog ${hz} without analog-voice`)
				} else if (ANALOG.includes(hz) && age >= 30_000) {
					if (!reasons.includes("no-sync" as never))
						reasonViolations.push(`${now}: unclassified ${hz} without no-sync`)
				}
			}
	}
	const counted = moves.filter(m => m.at >= 2_000)

	const hours = v.durationMs / HOUR_MS
	const classifiedAnalogMoves = counted.filter(
		m => classified.includes(m.fromHz) && classified.includes(m.toHz),
	).length
	const unclassifiedTries: Record<number, number> = {}
	const unclassifiedWindows: Record<number, number[]> = {}
	const unclassifiedTryTimes: Record<number, number[]> = {}
	const unclassifiedHz = ANALOG.slice(classified.length)
	for (const hz of unclassifiedHz) {
		unclassifiedTryTimes[hz] = counted.filter(m => m.toHz === hz).map(m => m.at)
		const tries = counted.filter(m => m.toHz === hz && m.at >= 1_800_000)
		unclassifiedTries[hz] = tries.length
		const windows = Math.ceil((v.durationMs - 1_800_000) / HOUR_MS)
		unclassifiedWindows[hz] = Array.from(
			{ length: Math.max(0, windows) },
			(_, k) =>
				tries.filter(
					m =>
						m.at >= 1_800_000 + k * HOUR_MS &&
						m.at < 1_800_000 + (k + 1) * HOUR_MS,
				).length,
		)
	}
	// Every transmission that ends a block before the run ends (a span cut by
	// the horizon is not a whole transmission): DMR bursts and voice overs.
	const inside = (spans: readonly Span[], name: string) =>
		spans.flatMap(([, b], i) =>
			b <= v.durationMs - BLOCK_MS ? [`${name}:${i}`] : [],
		)
	const allSpans = [
		...inside(dmrBursts, "dmr"),
		...ANALOG.flatMap(hz => inside(voice.get(hz)!, String(hz))),
	]
	const minBurstBlocks = Math.min(...allSpans.map(k => seenIn.get(k) ?? 0))
	const minGapBlocks = Math.min(...quietIn.values())
	const analogToAnalogMoves = counted.filter(
		m => ANALOG.includes(m.fromHz) && ANALOG.includes(m.toHz),
	)
	const analogToAnalog = analogToAnalogMoves.length
	const analogRetryTimes = counted.filter(m => m.analogRetry).map(m => m.at)
	const analogOtherMoves = analogToAnalogMoves.filter(
		m => !m.analogRetry && !unclassifiedHz.includes(m.toHz),
	).length
	return {
		bursts,
		burstsHeld,
		heldShare: bursts ? burstsHeld / bursts : 0,
		moves: counted.length,
		movesPerHour: counted.length / hours,
		classifiedAnalogMoves,
		unclassifiedTries,
		unclassifiedWindows,
		unclassifiedTryTimes,
		analogRetryTimes,
		analogOtherMoves,
		steadyMovesPerHour:
			counted.filter(m => m.at >= 1_800_000).length / (hours - 0.5),
		analogToAnalogPerHour: analogToAnalog / hours,
		minBurstBlocks,
		minGapBlocks,
		firstIdentityMs,
		firstSyncMs,
		unknownConfirmedMs,
		unknownPlacedMs,
		unknownPlacedState,
		nosyncHoldShare: slotMs ? nosyncMs / slotMs : 0,
		syncs,
		dmrRunningMs,
		moveTargets: counted.reduce<Record<string, number>>((acc, m) => {
			const kind = (hz: number) =>
				hz === DMR
					? "dmr"
					: hz === UNKNOWN
						? "unknown"
						: classified.includes(hz)
							? "classified"
							: "unclassified"
			const k = `${kind(m.fromHz)}>${kind(m.toHz)}`
			acc[k] = (acc[k] ?? 0) + 1
			return acc
		}, {}),
		analogTries: counted
			.filter(m => m.analogRetry)
			.map(m => `${Math.round(m.at / 1000)}s:${m.toHz - 446_000_000}`),
		reasonViolations: reasonViolations.slice(0, 5),
		placementReasons,
	}
}

const summary = (name: string, m: ScenarioMetrics) =>
	// Test report line (not production logging).
	console.info(
		`[dsd-tier-scenario] ${name} ${JSON.stringify({ ...m, reasonViolations: m.reasonViolations.length })}`,
	)

/** Every transmission and gap is seen by the coarse blocks (see the header). */
function expectCoverage(m: ScenarioMetrics) {
	expect(BLOCK_MS).toBeLessThan(ACTIVITY_LIVE_TTL_MS)
	expect(m.minBurstBlocks).toBeGreaterThanOrEqual(Math.floor(3_000 / BLOCK_MS))
	expect(m.minGapBlocks).toBeGreaterThanOrEqual(Math.floor(2_000 / BLOCK_MS))
}

const DWELL_MS = 20_000
const COOLDOWN_BASE_MS = 120_000
const COOLDOWN_CAP_MS = 1_920_000
/**
 * The former 15 min no-sync forget. Failures are now kept 6 h after the
 * last try, so k never resets; the bounds below still allow the reset and
 * are therefore looser than the code, never tighter.
 */
const FORGET_MS = 900_000

/**
 * Analog churn bound, by tier: every analog-to-analog move is either the rate-gated analog
 * try (one per slot group per cooldown(5) = 1,920 s, so at most
 * floor(D / 1,920 s) + 1 in a run of D, consecutive ones >= 1,920 s apart)
 * or an unknown-tier try of an unclassified channel (a voice channel the
 * scanner never classed analog: it is unknown until it fails). Unclassified
 * tries escalate: the k-th failure keeps the channel out for cooldown(k) =
 * 120 s × 2^min(k - 1, 4) from the end of a >= 20 s run, so consecutive
 * try starts are >= 20 s + cooldown(k) apart (k resets to 1 when the gap
 * could include the 15 min forget); once escalated (from the 5th try) any
 * 1 h window holds at most ceil(3,600 / (1,920 + 20)) = 2 tries.
 */
function expectAnalogBounds(m: ScenarioMetrics, durationMs: number) {
	expect(m.analogOtherMoves).toBe(0)
	expect(m.analogRetryTimes.length).toBeLessThanOrEqual(
		Math.floor(durationMs / COOLDOWN_CAP_MS) + 1,
	)
	m.analogRetryTimes.forEach((at, i) => {
		if (i > 0)
			expect(at - m.analogRetryTimes[i - 1]!).toBeGreaterThanOrEqual(
				COOLDOWN_CAP_MS,
			)
	})
	expect(m.classifiedAnalogMoves).toBeLessThanOrEqual(m.analogRetryTimes.length)
	expectUnclassifiedWindows(m)
	for (const times of Object.values(m.unclassifiedTryTimes)) {
		let k = 1
		for (let i = 1; i < times.length; i++) {
			const gap = times[i]! - times[i - 1]!
			const cooldown = Math.min(
				COOLDOWN_CAP_MS,
				COOLDOWN_BASE_MS * 2 ** Math.min(k - 1, 4),
			)
			expect(gap).toBeGreaterThanOrEqual(DWELL_MS + cooldown)
			k = gap >= DWELL_MS + cooldown + FORGET_MS ? 1 : k + 1
		}
		const escalated = times.slice(4)
		for (const from of escalated)
			expect(
				escalated.filter(t => t >= from && t < from + HOUR_MS).length,
			).toBeLessThanOrEqual(Math.ceil(3_600_000 / (COOLDOWN_CAP_MS + DWELL_MS)))
	}
}

/**
 * Unclassified tries per 1 h window from t = 30 min (the windows the metric
 * counts; the last one may be partial), held to the bound the code allows.
 * Not 2: an escalated channel's tries are >= cooldown(5) + dwell = 1,940 s
 * apart (2 per window), but a channel left untried 15 min past its cooldown
 * restarts at cooldown(1), and the modelled traffic does that (measured: 3 in
 * a window on identity seed 5, 4 on the silent-digital variant, gaps 140 s
 * and 261 s after a reset). Nor one per 1,040 s (20 + 120 + 900 s): that is
 * only the reset-every-try pattern. The bound: after the k-th failure the
 * next try starts >= 20 s + cooldown(k) later (k + 1), or, past the forget,
 * >= 20 s + cooldown(k) + 900 s later (k = 1); the most try starts that fit
 * in [0, 3,600 s) is 8, e.g. 0, 140, (+20 + 240 + 900) 1,300, 1,440, 1,700,
 * (+20 + 480 + 900) 3,100, 3,240, 3,500 s: 3,600 / 8 = one per 450 s.
 */
function maxTriesPerWindow(windowMs: number): number {
	const memo = new Map<string, number>()
	// Tries after one at `at` that was the k-th failure (k capped at 5).
	const after = (at: number, k: number): number => {
		const id = `${at}:${k}`
		const hit = memo.get(id)
		if (hit !== undefined) return hit
		const cd = Math.min(COOLDOWN_CAP_MS, COOLDOWN_BASE_MS * 2 ** (k - 1))
		let best = 0
		for (const [next, nk] of [
			[at + DWELL_MS + cd, Math.min(k + 1, 5)],
			[at + DWELL_MS + cd + FORGET_MS, 1],
		] as const)
			if (next < windowMs) best = Math.max(best, 1 + after(next, nk))
		memo.set(id, best)
		return best
	}
	return Math.max(...[1, 2, 3, 4, 5].map(k => 1 + after(0, k)))
}

function expectUnclassifiedWindows(m: ScenarioMetrics) {
	const bound = maxTriesPerWindow(HOUR_MS)
	expect(bound).toBe(8)
	for (const windows of Object.values(m.unclassifiedWindows))
		for (const n of windows) expect(n).toBeLessThanOrEqual(bound)
}

/**
 * Intended change (trial token, docs/DECODER-GUIDE.md item 8): an unknown
 * channel enters an occupied slot at most once per 300 s per source and
 * decoder in the fresh lane (never tried). Channels that failed before (the
 * unclassified voices after their first failed run) use the retry lane, so
 * they never hold the unknown's token. At its confirmation the fresh lane
 * is either free or was taken < 300 s before; the pass that follows its
 * reopening moves it within one move window: 300 + 60 = 360 s, not within
 * 60 s as before the token.
 */
const UNKNOWN_ENTRY_MS = 300_000 + 60_000

/** Shared PASS criteria (fixed before the change; behaviour in docs/DECODER-GUIDE.md, dsd-fme evidence ranking). */
function expectTierPass(m: ScenarioMetrics, durationMs: number) {
	const hours = durationMs / HOUR_MS
	expectCoverage(m)
	expect(m.firstSyncMs).not.toBeNull()
	// Bursts after the first sync, at most 300 s apart: at least
	// floor((duration - first sync) / 300 s) - 1 of them are sampled.
	expect(m.bursts).toBeGreaterThanOrEqual(
		Math.max(1, Math.floor((durationMs - m.firstSyncMs!) / 300_000) - 1),
	)
	// Held share: DMR slot held at >= 95 % of bursts after its first sync.
	expect(m.heldShare).toBeGreaterThanOrEqual(0.95)
	// Move rate: every dsd-fme activity move, <= 12 per hour after the 30 min
	// warm-up (the unclassified channels' fast first tries), and over a
	// 4 h run (averaged over the 4 h) <= 12 per hour in all.
	expect(m.steadyMovesPerHour).toBeLessThanOrEqual(12)
	if (hours >= 4) expect(m.movesPerHour).toBeLessThanOrEqual(12)
	expectAnalogBounds(m, durationMs)
	// Unknown placement: still hot or warm, within UNKNOWN_ENTRY_MS of its
	// confirmation (the trial token, see UNKNOWN_ENTRY_MS).
	expect(m.unknownConfirmedMs).not.toBeNull()
	expect(m.unknownPlacedMs).not.toBeNull()
	expect(m.unknownPlacedMs! - m.unknownConfirmedMs!).toBeLessThanOrEqual(
		UNKNOWN_ENTRY_MS,
	)
	expect(["hot", "warm"]).toContain(m.unknownPlacedState)
	// Reasons on every sampled minute.
	expect(m.reasonViolations).toEqual([])
}

describe("dsd-fme evidence tiers, production composition (modelled traffic)", () => {
	// Horizons (speed): seed 1 runs 4 h, seeds 2-5 run 2 h each.
	it.each([
		[1, 4 * HOUR_MS],
		[2, 2 * HOUR_MS],
		[3, 2 * HOUR_MS],
		[4, 2 * HOUR_MS],
		[5, 2 * HOUR_MS],
	])(
		"identity variant, seed %i (%i ms): DMR keeps its slot, analog churn stops, the unknown is tried",
		async (seed, durationMs) => {
			const m = await runScenario({ seed, discovery: "identity", durationMs })
			summary(`identity seed=${seed}`, m)
			expectTierPass(m, durationMs)
		},
		300_000,
	)

	it("hysteresis variant: a first discovery by two bursts 10 s apart (1.5 h)", async () => {
		const durationMs = 1.5 * HOUR_MS
		const m = await runScenario({
			seed: 1,
			discovery: "hysteresis",
			durationMs,
		})
		summary("hysteresis seed=1", m)
		expectTierPass(m, durationMs)
	}, 300_000)

	it("silent digital channel yields: a DMR channel silent past its 30 min hold yields its only slot to a confirmed unknown", async () => {
		// DMR stops at 0.6 h, so its last sync is >= 0.6 h = 36 min old when the
		// unknown appears at 1.2 h: past DSD_DIGITAL_HOLD_MS = 30 min.
		const m = await runScenario({
			seed: 1,
			discovery: "identity",
			durationMs: 1.5 * HOUR_MS,
			slots: 1,
			dmrUntilMs: 0.6 * HOUR_MS,
			unknownFromMs: 1.2 * HOUR_MS,
		})
		summary("silent-digital-yields seed=1", m)
		expectCoverage(m)
		expectUnclassifiedWindows(m)
		expect(m.firstSyncMs).not.toBeNull()
		expect(m.unknownConfirmedMs).not.toBeNull()
		expect(m.unknownConfirmedMs!).toBeGreaterThanOrEqual(1.2 * HOUR_MS)
		expect(m.unknownPlacedMs! - m.unknownConfirmedMs!).toBeLessThanOrEqual(
			UNKNOWN_ENTRY_MS,
		)
		expect(["hot", "warm"]).toContain(m.unknownPlacedState)
	}, 300_000)

	it("analog-classified DMR reaches first sync: a DMR channel that also carries analog FM proof still reaches a first sync", async () => {
		// 3 scanner-analog channels (2 voices + this one), tried least recently
		// first at one try per group per cooldown(5) = 1,920 s, so its try
		// starts within 3 × 1,920 = 5,760 s; the try holds its slot over the
		// next burst (gap <= 300 s), plus the 20 s dwell: 6,080 s.
		const durationMs = 2 * HOUR_MS
		const m = await runScenario({
			seed: 1,
			discovery: "none",
			durationMs,
			dmrAnalog: true,
			classified: 2,
		})
		summary("analog-classified-dmr seed=1", m)
		expectCoverage(m)
		expect(m.firstSyncMs).not.toBeNull()
		expect(m.firstSyncMs!).toBeLessThanOrEqual(3 * 1_920_000 + 300_000 + 20_000)
		// 8 unclassified voices here: the move rate is not bounded by 12 per hour, but
		// every analog-to-analog move is one of the two rate-bounded tries.
		expectAnalogBounds(m, durationMs)
	}, 300_000)
})
