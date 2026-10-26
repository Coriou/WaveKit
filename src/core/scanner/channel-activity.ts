/**
 * Activity-ranked decoder channels, scanner side: the ranker behind `ChannelActivityPort`
 * (src/decoders/enablement/activity-contract.ts). It turns spectrum blocks, gated tracks, decodes,
 * replay outcomes and coarse occupancy into one score and state per candidate channel of a planner
 * query. It never adds a frequency and never assigns placements: the planner ranks its own
 * eligible candidates with it and falls back to its nearest order on anything but `ready`.
 *
 * Clock: one monotonic clock (`monoNow`, `performance.now()` in production), the planner's clock.
 * Every time the ranker stores or returns is on it.
 *
 * Cadence (stated rules):
 * - Ingest: every accepted block (`ingestBlock`) and gated track (`ingestTrack`) with the engine
 *   identity (sourceId, engineId, epoch). A block is O(tracks of the block): its segments update a
 *   bounded per-source map; no per-sample and no per-candidate work happens on the spectrum path.
 * - History (stored decodes, trial memory, occupancy) is pulled at most once per
 *   ACTIVITY_HISTORY_REFRESH_MS = 2 000 ms per source, from the block ingest, never in snapshot().
 * - Notices: a live edge (a segment appears or goes), a history refresh, a health change (retune,
 *   stop, first frame, stale) or a decay deadline marks the source dirty; the source's interests
 *   are evaluated and a notice is sent when a channel's live flag, state or rank order changed, or
 *   health changed. Coalescing is leading-edge, not trailing: the first dirty mark fires at once
 *   when no notice went out in the last ACTIVITY_NOTIFY_MAX_DELAY_MS = 250 ms, else at the end of
 *   that 250 ms window; later marks join the pending one without moving it. So a change is noticed
 *   at most 250 ms late and a source sends at most 1000 / 250 = 4 notices per second.
 *
 * Health: `stale` when now − lastFrame ≥ ACTIVITY_STALE_MS = 10 000 ms; an epoch change (retune) or
 * a new engine drops the live evidence of the old window and answers `retuning` until its first
 * block; a stop answers `unavailable` and `epochOf` null. History survives both (it is RF-keyed).
 *
 * Score per candidate c (all terms finite, ≥ 0; f(age, W) = max(0, 1 − age / W)):
 *   live 100 (energy on c in the latest accepted block)
 *   + 2 · f(energy age, WARM)             energy within the last 15 min
 *   + 0.5 · min(4, Σ f(track age, WARM))  gated tracks ended on c
 *   + 3 · f(decode age, DECODE_WARM)      decodes of a query protocol on c, 6 h memory
 *   + 2 · f(trial success age, DECODE_WARM)
 *   + 0.5 · duty                          occupancy, coarse support only (duty ≤ 1)
 *   − 1 while a complete replay of a query protocol failed within its backoff
 * The non-live part is at most 2 + 2 + 3 + 2 + 0.5 = 9.5 < 100, so every live channel outranks
 * every channel that is not live (live-first precedence).
 *
 * States: hot = live, energy within ACTIVITY_HOT_HOLD_MS = 120 000 ms, or a decode / replay success
 * within ACTIVITY_DECODE_HOT_MS = 900 000 ms; warm = energy or a gated track within
 * ACTIVITY_WARM_HOLD_MS = 900 000 ms, or a decode / success within ACTIVITY_DECODE_WARM_MS =
 * 21 600 000 ms (6 h); cold otherwise. Occupancy never changes the state. A replay success or a
 * decode stops counting after 6 h: nothing stays hot or warm without new evidence.
 *
 * Association: an item at frequency f credits the candidate nearest to f when it lies within
 * half the query's channel width (the raster); when a second candidate is also within half the
 * raster, the item is ambiguous and credits none.
 *
 * Replays: only a complete replay (whole decoder hold, no gap) that failed counts against a channel;
 * an incomplete, cancelled, budget-skipped, unsupported or not-needed trial counts for nothing.
 *
 * Bounds (arithmetic in each constant's comment): sources, segments and tracks per source, decodes
 * and trial notes per source, history items per source, interests (keyed by epoch, decoder and
 * candidates) and candidates per query. Nothing is logged with frequencies, ids or protocols.
 */
import { z } from "zod"
import type {
	ActivityChange,
	ActivityEpoch,
	ActivityQuery,
	ActivityReason,
	ActivitySnapshot,
	ActivityState,
	ChannelActivity,
	ChannelActivityPort,
} from "../../decoders/enablement/activity-contract.js"

/** Stale at now − lastFrame ≥ 10 s (Stage 1 rule). */
export const ACTIVITY_STALE_MS = 10_000
/**
 * Live means energy in a recent accepted block: the latest one, and no older than 1 000 ms
 * (20 blocks at the default 50 ms integration; 4 at 250 ms). A source whose blocks stop, or turn
 * overloaded, loses its live flags within this time.
 */
export const ACTIVITY_LIVE_TTL_MS = 1_000
/** History pull at most every 2 s per source, outside snapshot(). */
export const ACTIVITY_HISTORY_REFRESH_MS = 2_000
/** Notice coalescing: at most 250 ms late, at most 4 notices per second per source. */
export const ACTIVITY_NOTIFY_MAX_DELAY_MS = 250
/** Energy keeps a channel hot for 2 min (a paging or call cycle), then warm. */
export const ACTIVITY_HOT_HOLD_MS = 120_000
/** Energy or a gated track keeps a channel warm for 15 min. */
export const ACTIVITY_WARM_HOLD_MS = 900_000
/** A decode or replay success keeps a channel hot for 15 min. */
export const ACTIVITY_DECODE_HOT_MS = 900_000
/** A decode or replay success is remembered for 6 h (expiry), then forgotten. */
export const ACTIVITY_DECODE_WARM_MS = 21_600_000
/** A complete failed replay demotes its channel for 60 s (TRIAL_BACKOFF_BASE_MS). */
export const ACTIVITY_REPLAY_BACKOFF_MS = 60_000
/** The live bonus: larger than the 9.5 maximum of every other term. */
export const ACTIVITY_LIVE_SCORE = 100
/**
 * At most 64 sources (the pending-capture source cap); a new source past the cap gets no state
 * (`epochOf` null, its queries `unavailable`: the planner keeps its nearest order).
 */
export const ACTIVITY_MAX_SOURCES = 64
/**
 * Energy segments per source: 512 = the spectrum pipeline's default `maxTracks`, so one full
 * block fits; least recently seen dropped first. 64 × 512 × ~64 B ≈ 2 MiB at most.
 */
export const ACTIVITY_MAX_SEGMENTS = 512
/** Ended gated tracks per source (least recent dropped): 256 × 64 sources × ~48 B ≈ 0.8 MiB. */
export const ACTIVITY_MAX_TRACKS = 256
/** Pushed decodes and replay notes per source, each (least recent dropped). */
export const ACTIVITY_MAX_NOTES = 256
/** Pulled history items per source and kind (decodes, trials, occupancy); the rest is cut. */
export const ACTIVITY_MAX_HISTORY = 512
/** Interests (epoch × decoder × candidates) remembered for change notices, least recent dropped. */
export const ACTIVITY_MAX_INTERESTS = 128
/**
 * Candidates per query: 1 024 (a 12.8 MHz span at a 12.5 kHz raster). A larger query answers
 * `unavailable`, still one channel per candidate.
 */
export const ACTIVITY_MAX_CANDIDATES = 1_024

export interface ActivityTimers {
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

/** History pulled from the scanner, with ages on the scanner's own clock (converted here). */
export interface ActivityHistory {
	decodes: readonly { hz: number; protocol: string; ageMs: number }[]
	/** Remembered replay successes (trial memory); failures are not pulled (they may be incomplete). */
	successes: readonly { hz: number; protocol: string; ageMs: number }[]
	/** Coarse rolling-hour duty per occupancy bucket centre, 0..1. */
	occupancy: readonly { hz: number; duty: number }[]
}

export type ActivityHistoryProvider = (
	sourceId: string,
	window: { lowHz: number; highHz: number },
) => ActivityHistory | null

/** How one replay trial counts (Stage 1: incomplete, cancelled or skipped is never negative). */
export type ReplayTrialWeight = "success" | "failure" | "none"

/** Outcomes of IqReplayTrialOutcome as the ranker counts them; `complete` is the whole hold. */
export function replayTrialWeight(
	outcome: string,
	complete: boolean,
): ReplayTrialWeight {
	if (outcome === "decoded" || outcome === "heard") return "success"
	if (!complete) return "none"
	return outcome === "no-sync" ||
		outcome === "crc-errors" ||
		outcome === "timeout" ||
		outcome === "data-like" ||
		outcome === "carrier-only"
		? "failure"
		: "none"
}

export interface ChannelActivityDeps {
	monoNow: () => number
	timers?: ActivityTimers
	/** Set later with `setHistory` when the scanner is built after the ranker. */
	history?: ActivityHistoryProvider
}

/** The block fields the ranker reads (BlockSummary is assignable). */
export interface ActivityBlock {
	epoch: number
	centreHz: number
	sampleRateHz: number
	overload: boolean
	tracks: readonly {
		startHz: number
		endHz: number
		flags: { iqImage: boolean; spur?: boolean }
		trackId?: string
		gate?: "pending" | "passed"
	}[]
}

/** The track fields the ranker reads (TrackSnapshot is assignable). */
export interface ActivityTrack {
	trackId: string
	epoch: number
	centreHz: number
	gate?: "pending" | "passed" | "below"
	flags: { iqImage: boolean; spur: boolean }
}

export interface ChannelActivityRanker {
	readonly port: ChannelActivityPort
	epochOf(sourceId: string): ActivityEpoch | null
	/** A new epoch of a source's engine (retune) or a new engine. */
	ingestEpoch(sourceId: string, engineId: string, epoch: number): void
	ingestBlock(sourceId: string, engineId: string, block: ActivityBlock): void
	/** A gated track ended (track-close); other kinds are ignored. */
	ingestTrack(sourceId: string, engineId: string, track: ActivityTrack): void
	/** The engine stopped, failed or the source went: invalidates the source. */
	stop(sourceId: string): void
	noteDecode(sourceId: string, hz: number, protocol: string): void
	noteReplayTrial(
		sourceId: string,
		hz: number,
		protocol: string,
		weight: ReplayTrialWeight,
	): void
	setHistory(provider: ActivityHistoryProvider | null): void
	/** Bounded sizes, for tests and status. */
	sizes(): {
		sources: number
		segments: number
		tracks: number
		notes: number
		interests: number
	}
	dispose(): void
}

interface Segment {
	centreHz: number
	firstMono: number
	lastMono: number
}

interface TimedPoint {
	hz: number
	protocol: string
	at: number
}

interface SourceState {
	epoch: ActivityEpoch | null
	/** The epoch the last notice names (kept across a stop, so the stop itself is noticed). */
	noticeEpoch: ActivityEpoch | null
	epochStartMono: number
	lastFrameMono: number | null
	lastBlockMono: number | null
	revision: number
	segments: Map<string, Segment>
	liveKeys: Set<string>
	/** The previous block's live set, cleared and refilled by the next block (no per-block Set). */
	spareKeys: Set<string>
	tracks: Map<string, { centreHz: number; at: number }>
	decodes: Map<string, TimedPoint>
	successes: Map<string, TimedPoint>
	failures: Map<string, TimedPoint>
	history: {
		decodes: TimedPoint[]
		successes: TimedPoint[]
		occupancy: { hz: number; duty: number }[]
	}
	lastRefreshMono: number | null
	dirty: boolean
	healthChanged: boolean
	pendingTimer: unknown
	lastNoticeMono: number | null
	deadlineTimer: unknown
	deadlineAt: number | null
	lastStatus: ActivitySnapshot["status"] | null
}

interface Interest {
	query: ActivityQuery
	sourceId: string
	memo: Map<number, { state: ActivityState; since: number; live: boolean }>
	order: string
}

const defaultTimers: ActivityTimers = {
	setTimeout: (fn, ms) => {
		const t = setTimeout(fn, ms)
		t.unref()
		return t
	},
	clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
}

const QuerySchema = z.object({
	epoch: z.object({
		sourceId: z.string().min(1).max(256),
		engineId: z.string().min(1).max(256),
		epoch: z.number().int().min(0),
	}),
	decoderId: z.string().min(1).max(256),
	decoderType: z.enum(["multimon-ng", "dsd-fme"]),
	protocols: z.array(z.string().max(64)).max(64),
	centreHz: z.number().finite().positive(),
	candidatesHz: z
		.array(z.number().int().positive())
		.max(ACTIVITY_MAX_CANDIDATES),
	channelWidthHz: z.number().finite().positive(),
})

/** f(age, W) = max(0, 1 − age / W), 0 for a future or unknown age. */
function fade(age: number, window: number): number {
	if (!(age >= 0)) return age < 0 ? 1 : 0
	return age >= window ? 0 : 1 - age / window
}

/**
 * The candidate an item at `hz` credits: the nearest one within half the raster, else -1; -1 too
 * when a second candidate is also within half the raster (ambiguous). `sorted` ascending.
 */
export function associateCandidate(
	sorted: readonly number[],
	hz: number,
	rasterHz: number,
): number {
	if (sorted.length === 0 || !Number.isFinite(hz)) return -1
	const half = rasterHz / 2
	let lo = 0
	let hi = sorted.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (sorted[mid]! < hz) lo = mid + 1
		else hi = mid
	}
	// sorted[lo - 1] < hz <= sorted[lo]
	let best = -1
	let within = 0
	// Indices lo - 2 .. lo + 1, without allocating a list per call.
	const end = Math.min(sorted.length, lo + 2)
	for (let i = Math.max(0, lo - 2); i < end; i++) {
		const d = Math.abs(sorted[i]! - hz)
		if (d > half) continue
		within++
		if (best === -1 || d < Math.abs(sorted[best]! - hz)) best = i
	}
	return within === 1 ? best : -1
}

function noteKey(hz: number, protocol: string): string {
	return `${Math.round(hz)}|${protocol}`
}

function touch<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
	map.delete(key)
	map.set(key, value)
	while (map.size > max) {
		const oldest = map.keys().next()
		if (oldest.done === true) break
		map.delete(oldest.value)
	}
}

function sameEpoch(a: ActivityEpoch | null, b: ActivityEpoch): boolean {
	return (
		a !== null &&
		a.sourceId === b.sourceId &&
		a.engineId === b.engineId &&
		a.epoch === b.epoch
	)
}

function interestKey(q: ActivityQuery): string {
	return [
		q.epoch.sourceId,
		q.epoch.engineId,
		q.epoch.epoch,
		q.decoderId,
		q.decoderType,
		q.channelWidthHz,
		q.centreHz,
		q.protocols.join(","),
		q.candidatesHz.join(","),
	].join("|")
}

const STATE_RANK: Record<ActivityState, number> = { hot: 0, warm: 1, cold: 2 }

interface Evaluated {
	status: ActivitySnapshot["status"]
	channels: ChannelActivity[]
	next: number | null
	/** `interestKey(query)` when the answer is `ready` (built once per evaluation). */
	key?: string
}

export function createChannelActivityRanker(
	deps: ChannelActivityDeps,
): ChannelActivityRanker {
	const timers = deps.timers ?? defaultTimers
	let history: ActivityHistoryProvider | null = deps.history ?? null
	const sources = new Map<string, SourceState>()
	const interests = new Map<string, Interest>()
	const listeners = new Set<(c: ActivityChange) => void>()
	let disposed = false

	const mono = (): number => {
		const t = deps.monoNow()
		return Number.isFinite(t) ? t : 0
	}

	const stateOf = (sourceId: string, create: boolean): SourceState | null => {
		const s = sources.get(sourceId)
		if (s || !create) return s ?? null
		if (sources.size >= ACTIVITY_MAX_SOURCES) return null
		const fresh: SourceState = {
			epoch: null,
			noticeEpoch: null,
			epochStartMono: mono(),
			lastFrameMono: null,
			lastBlockMono: null,
			revision: 0,
			segments: new Map(),
			liveKeys: new Set(),
			spareKeys: new Set(),
			tracks: new Map(),
			decodes: new Map(),
			successes: new Map(),
			failures: new Map(),
			history: { decodes: [], successes: [], occupancy: [] },
			lastRefreshMono: null,
			dirty: false,
			healthChanged: false,
			pendingTimer: null,
			lastNoticeMono: null,
			deadlineTimer: null,
			deadlineAt: null,
			lastStatus: null,
		}
		sources.set(sourceId, fresh)
		return fresh
	}

	const dropInterests = (sourceId: string, keep?: ActivityEpoch): void => {
		for (const [key, it] of interests)
			if (
				it.sourceId === sourceId &&
				(keep === undefined || !sameEpoch(keep, it.query.epoch))
			)
				interests.delete(key)
	}

	const statusOf = (
		s: SourceState | null,
		q: ActivityQuery,
		now: number,
	): { status: ActivitySnapshot["status"]; next: number | null } => {
		if (!s || s.epoch === null) return { status: "unavailable", next: null }
		if (!sameEpoch(s.epoch, q.epoch)) return { status: "retuning", next: null }
		if (s.lastFrameMono === null) {
			const due = s.epochStartMono + ACTIVITY_STALE_MS
			return now >= due
				? { status: "stale", next: null }
				: { status: "retuning", next: due }
		}
		const due = s.lastFrameMono + ACTIVITY_STALE_MS
		return now >= due
			? { status: "stale", next: null }
			: { status: "ready", next: due }
	}

	const coldChannels = (q: ActivityQuery, now: number): ChannelActivity[] =>
		Array.isArray(q.candidatesHz)
			? q.candidatesHz.map(hz => ({
					hz,
					score: 0,
					state: "cold" as const,
					reasons: [],
					live: false,
					lastEnergyMonoMs: null,
					stateSinceMonoMs: now,
				}))
			: []

	/**
	 * Pure: reads the evidence and the interest memo, writes nothing. `key` is `interestKey(q)`
	 * when the caller already built it (it is O(candidates) to build, so it is built once).
	 */
	const evaluate = (q: ActivityQuery, now: number, key?: string): Evaluated => {
		if (!QuerySchema.safeParse(q).success)
			return {
				status: "unavailable",
				channels: coldChannels(q, now),
				next: null,
			}
		if (new Set(q.candidatesHz).size !== q.candidatesHz.length)
			return {
				status: "unavailable",
				channels: coldChannels(q, now),
				next: null,
			}
		const s = sources.get(q.epoch.sourceId) ?? null
		const health = statusOf(s, q, now)
		if (health.status !== "ready" || !s)
			return {
				status: health.status,
				channels: coldChannels(q, now),
				next: health.next,
			}
		const n = q.candidatesHz.length
		const order = q.candidatesHz.map((hz, i) => ({ hz, i }))
		order.sort((a, b) => a.hz - b.hz)
		const sorted = order.map(o => o.hz)
		const raster = q.channelWidthHz
		const protocols = new Set(q.protocols)
		const lastEnergy = new Array<number | null>(n).fill(null)
		const live = new Array<boolean>(n).fill(false)
		const trackSum = new Array<number>(n).fill(0)
		const lastTrack = new Array<number | null>(n).fill(null)
		const lastDecode = new Array<number | null>(n).fill(null)
		const lastSuccess = new Array<number | null>(n).fill(null)
		const lastFailure = new Array<number | null>(n).fill(null)
		const duty = new Array<number>(n).fill(0)
		const at = (hz: number): number => {
			const k = associateCandidate(sorted, hz, raster)
			return k === -1 ? -1 : order[k]!.i
		}
		const later = (a: number | null, b: number): number =>
			a === null || b > a ? b : a
		const liveFresh =
			s.lastBlockMono !== null && now - s.lastBlockMono < ACTIVITY_LIVE_TTL_MS
		for (const [key, seg] of s.segments) {
			const i = at(seg.centreHz)
			if (i === -1) continue
			lastEnergy[i] = later(lastEnergy[i]!, seg.lastMono)
			if (liveFresh && s.liveKeys.has(key)) live[i] = true
		}
		for (const t of s.tracks.values()) {
			const i = at(t.centreHz)
			if (i === -1) continue
			trackSum[i] = trackSum[i]! + fade(now - t.at, ACTIVITY_WARM_HOLD_MS)
			lastTrack[i] = later(lastTrack[i]!, t.at)
		}
		const points = (
			list: Iterable<TimedPoint>,
			into: (number | null)[],
		): void => {
			for (const p of list) {
				if (!protocols.has(p.protocol)) continue
				const i = at(p.hz)
				if (i !== -1) into[i] = later(into[i]!, p.at)
			}
		}
		points(s.decodes.values(), lastDecode)
		points(s.history.decodes, lastDecode)
		points(s.successes.values(), lastSuccess)
		points(s.history.successes, lastSuccess)
		points(s.failures.values(), lastFailure)
		for (const o of s.history.occupancy) {
			const i = at(o.hz)
			if (i !== -1)
				duty[i] = Math.max(duty[i]!, Math.min(1, Math.max(0, o.duty)))
		}
		let next = health.next ?? Infinity
		if (liveFresh && s.liveKeys.size > 0) {
			const due = s.lastBlockMono! + ACTIVITY_LIVE_TTL_MS
			if (due < next) next = due
		}
		const deadline = (t: number | null, window: number): void => {
			if (t === null) return
			const due = t + window
			if (due > now && due < next) next = due
		}
		const channels: ChannelActivity[] = []
		const k = key ?? interestKey(q)
		const memos = interests.get(k)?.memo
		for (let i = 0; i < n; i++) {
			const hz = q.candidatesHz[i]!
			const reasons: ActivityReason[] = []
			const e = lastEnergy[i]!
			const d = lastDecode[i]!
			const ok = lastSuccess[i]!
			const bad = lastFailure[i]!
			const tr = lastTrack[i]!
			const eAge = e === null ? Infinity : now - e
			const dAge = d === null ? Infinity : now - d
			const okAge = ok === null ? Infinity : now - ok
			const badActive = bad !== null && now - bad < ACTIVITY_REPLAY_BACKOFF_MS
			let score = live[i] ? ACTIVITY_LIVE_SCORE : 0
			if (live[i]) reasons.push("live-energy")
			score += 2 * fade(eAge, ACTIVITY_WARM_HOLD_MS)
			const tracks = Math.min(4, trackSum[i]!)
			if (tracks > 0) {
				score += 0.5 * tracks
				reasons.push("track")
			}
			if (duty[i]! > 0) {
				score += 0.5 * duty[i]!
				reasons.push("occupancy")
			}
			const dScore = fade(dAge, ACTIVITY_DECODE_WARM_MS)
			if (dScore > 0) {
				score += 3 * dScore
				reasons.push("decoded")
			}
			const okScore = fade(okAge, ACTIVITY_DECODE_WARM_MS)
			if (okScore > 0) {
				score += 2 * okScore
				reasons.push("trial-success")
			}
			if (badActive) {
				score -= 1
				reasons.push("trial-backoff")
			}
			score = Math.max(0, Math.round(score * 1000) / 1000)
			let state: ActivityState = "cold"
			if (
				live[i] ||
				eAge < ACTIVITY_HOT_HOLD_MS ||
				dAge < ACTIVITY_DECODE_HOT_MS ||
				okAge < ACTIVITY_DECODE_HOT_MS
			)
				state = "hot"
			else if (
				eAge < ACTIVITY_WARM_HOLD_MS ||
				(tr !== null && now - tr < ACTIVITY_WARM_HOLD_MS) ||
				dAge < ACTIVITY_DECODE_WARM_MS ||
				okAge < ACTIVITY_DECODE_WARM_MS
			)
				state = "warm"
			deadline(e, ACTIVITY_HOT_HOLD_MS)
			deadline(e, ACTIVITY_WARM_HOLD_MS)
			deadline(tr, ACTIVITY_WARM_HOLD_MS)
			deadline(d, ACTIVITY_DECODE_HOT_MS)
			deadline(d, ACTIVITY_DECODE_WARM_MS)
			deadline(ok, ACTIVITY_DECODE_HOT_MS)
			deadline(ok, ACTIVITY_DECODE_WARM_MS)
			deadline(bad, ACTIVITY_REPLAY_BACKOFF_MS)
			const memo = memos?.get(hz)
			channels.push({
				hz,
				score,
				state,
				reasons,
				live: live[i]!,
				lastEnergyMonoMs: e,
				stateSinceMonoMs: memo && memo.state === state ? memo.since : now,
			})
		}
		return {
			status: "ready",
			channels,
			next: Number.isFinite(next) ? next : null,
			key: k,
		}
	}

	const orderOf = (q: ActivityQuery, channels: readonly ChannelActivity[]) =>
		channels
			.map(c => c)
			.sort(
				(a, b) =>
					Number(b.live) - Number(a.live) ||
					STATE_RANK[a.state] - STATE_RANK[b.state] ||
					b.score - a.score ||
					Math.abs(a.hz - q.centreHz) - Math.abs(b.hz - q.centreHz) ||
					a.hz - b.hz,
			)
			.map(c => c.hz)
			.join(",")

	const remember = (it: Interest, ev: Evaluated): boolean => {
		let changed = false
		const seen = new Set<number>()
		for (const c of ev.channels) {
			seen.add(c.hz)
			const m = it.memo.get(c.hz)
			if (!m || m.state !== c.state || m.live !== c.live) {
				changed = true
				it.memo.set(c.hz, {
					state: c.state,
					since: m && m.state === c.state ? m.since : c.stateSinceMonoMs,
					live: c.live,
				})
			}
		}
		for (const hz of it.memo.keys()) if (!seen.has(hz)) it.memo.delete(hz)
		const order = orderOf(it.query, ev.channels)
		if (order !== it.order) {
			changed = it.order !== "" || changed
			it.order = order
		}
		return changed
	}

	const scheduleDeadline = (
		sourceId: string,
		s: SourceState,
		at: number,
	): void => {
		if (s.deadlineAt !== null && s.deadlineAt <= at) return
		if (s.deadlineTimer !== null) timers.clearTimeout(s.deadlineTimer)
		s.deadlineAt = at
		s.deadlineTimer = timers.setTimeout(
			() => {
				s.deadlineTimer = null
				s.deadlineAt = null
				markDirty(sourceId)
			},
			Math.max(0, at - mono()),
		)
	}

	const flush = (sourceId: string): void => {
		const s = sources.get(sourceId)
		if (!s || disposed) return
		s.pendingTimer = null
		const now = mono()
		s.dirty = false
		let changed = s.healthChanged
		s.healthChanged = false
		let next = Infinity
		for (const [key, it] of interests) {
			if (it.sourceId !== sourceId) continue
			const ev = evaluate(it.query, now, key)
			if (remember(it, ev)) changed = true
			if (ev.next !== null && ev.next < next) next = ev.next
		}
		// health deadline even without interests (stale answer for the next query)
		const h = s.epoch
			? statusOf(s, { epoch: s.epoch } as ActivityQuery, now)
			: { status: "unavailable" as const, next: null }
		if (h.status !== s.lastStatus) {
			if (s.lastStatus !== null) changed = true
			s.lastStatus = h.status
		}
		if (h.next !== null && h.next < next) next = h.next
		if (Number.isFinite(next)) scheduleDeadline(sourceId, s, next)
		if (!changed) return
		s.revision++
		s.lastNoticeMono = now
		const epoch = s.epoch ?? s.noticeEpoch
		if (!epoch) return
		const change: ActivityChange = { epoch, revision: s.revision }
		for (const l of [...listeners]) {
			try {
				l(change)
			} catch {
				// a listener failure never blocks ingest or the other listeners
			}
		}
	}

	function markDirty(sourceId: string, health = false): void {
		const s = sources.get(sourceId)
		if (!s || disposed) return
		if (health) s.healthChanged = true
		s.dirty = true
		if (s.pendingTimer !== null) return
		const now = mono()
		const wait =
			s.lastNoticeMono === null
				? 0
				: Math.max(0, s.lastNoticeMono + ACTIVITY_NOTIFY_MAX_DELAY_MS - now)
		s.pendingTimer = timers.setTimeout(() => flush(sourceId), wait)
	}

	const startEpoch = (
		sourceId: string,
		engineId: string,
		epoch: number,
	): SourceState | null => {
		const s = stateOf(sourceId, true)
		if (!s) return null
		if (s.epoch && s.epoch.engineId === engineId && s.epoch.epoch === epoch)
			return s
		s.epoch = Object.freeze({ sourceId, engineId, epoch })
		s.noticeEpoch = s.epoch
		s.epochStartMono = mono()
		s.lastFrameMono = null
		s.lastBlockMono = null
		s.segments.clear()
		s.liveKeys = new Set()
		s.tracks.clear()
		dropInterests(sourceId, s.epoch)
		markDirty(sourceId, true)
		return s
	}

	const refreshHistory = (
		sourceId: string,
		s: SourceState,
		b: ActivityBlock,
	): void => {
		const now = mono()
		if (
			s.lastRefreshMono !== null &&
			now - s.lastRefreshMono < ACTIVITY_HISTORY_REFRESH_MS
		)
			return
		s.lastRefreshMono = now
		if (!history) return
		let h: ActivityHistory | null = null
		try {
			h = history(sourceId, {
				lowHz: b.centreHz - b.sampleRateHz / 2,
				highHz: b.centreHz + b.sampleRateHz / 2,
			})
		} catch {
			h = null
		}
		if (!h) return
		const timed = (
			list: readonly { hz: number; protocol: string; ageMs: number }[],
		): TimedPoint[] => {
			const out: TimedPoint[] = []
			for (const p of list) {
				if (out.length >= ACTIVITY_MAX_HISTORY) break
				if (!Number.isFinite(p.hz) || !Number.isFinite(p.ageMs) || p.ageMs < 0)
					continue
				if (p.ageMs >= ACTIVITY_DECODE_WARM_MS) continue
				out.push({ hz: p.hz, protocol: p.protocol, at: now - p.ageMs })
			}
			return out
		}
		const occupancy: { hz: number; duty: number }[] = []
		for (const o of h.occupancy) {
			if (occupancy.length >= ACTIVITY_MAX_HISTORY) break
			if (Number.isFinite(o.hz) && Number.isFinite(o.duty) && o.duty > 0)
				occupancy.push({ hz: o.hz, duty: Math.min(1, o.duty) })
		}
		s.history = {
			decodes: timed(h.decodes),
			successes: timed(h.successes),
			occupancy,
		}
		markDirty(sourceId)
	}

	const port: ChannelActivityPort = {
		snapshot(queries, nowMonoMs) {
			const now = Number.isFinite(nowMonoMs) ? nowMonoMs : mono()
			const out: ActivitySnapshot[] = []
			for (const q of Array.isArray(queries) ? queries : []) {
				const ev = evaluate(q, now)
				const key = ev.key
				const s =
					typeof q?.epoch?.sourceId === "string"
						? (sources.get(q.epoch.sourceId) ?? null)
						: null
				if (ev.status === "ready" && s && key !== undefined) {
					// Interest only (bounded): lets a later ingest notice order changes. The answer above
					// is already computed; no evidence or history changes here.
					const known = interests.get(key)
					if (known) {
						interests.delete(key)
						interests.set(key, known)
					} else {
						const it: Interest = {
							query: q,
							sourceId: q.epoch.sourceId,
							memo: new Map(),
							order: "",
						}
						remember(it, ev)
						touch(interests, key, it, ACTIVITY_MAX_INTERESTS)
					}
				}
				out.push(
					Object.freeze({
						query: q,
						revision: s?.revision ?? 0,
						evaluatedMonoMs: now,
						lastFrameMonoMs:
							s && ev.status !== "unavailable" ? s.lastFrameMono : null,
						status: ev.status,
						nextEvaluationMonoMs: ev.next,
						channels: Object.freeze(ev.channels.map(c => Object.freeze(c))),
					}),
				)
			}
			return Object.freeze(out)
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}

	return {
		port,
		epochOf: sourceId => sources.get(sourceId)?.epoch ?? null,
		ingestEpoch(sourceId, engineId, epoch) {
			if (disposed || !Number.isInteger(epoch)) return
			startEpoch(sourceId, engineId, epoch)
		},
		ingestBlock(sourceId, engineId, block) {
			if (disposed) return
			const cur = sources.get(sourceId)?.epoch
			// A late block of an older epoch of the same engine never moves the epoch back.
			if (cur && cur.engineId === engineId && block.epoch < cur.epoch) return
			const s = startEpoch(sourceId, engineId, block.epoch)
			if (!s) return
			const now = mono()
			// An overloaded block establishes nothing: it clears the live flags and is no frame, so
			// a source that stays overloaded turns stale after ACTIVITY_STALE_MS (the planner falls back).
			if (block.overload) {
				if (s.liveKeys.size > 0) {
					s.liveKeys = new Set()
					markDirty(sourceId)
				}
				return
			}
			const first = s.lastFrameMono === null
			const wasStale =
				s.lastFrameMono !== null && now - s.lastFrameMono >= ACTIVITY_STALE_MS
			s.lastFrameMono = now
			if (first || wasStale) markDirty(sourceId, true)
			refreshHistory(sourceId, s, block)
			s.lastBlockMono = now
			const liveKeys = s.spareKeys
			liveKeys.clear()
			let edge = false
			for (const t of block.tracks) {
				if (t.flags.iqImage || t.flags.spur === true) continue
				if (t.gate !== undefined && t.gate !== "passed") continue
				const centre = (t.startHz + t.endHz) / 2
				if (!Number.isFinite(centre)) continue
				const key = t.trackId ?? `u${Math.round(centre / 1000)}`
				const seg = s.segments.get(key)
				if (seg !== undefined) {
					// Same LRU move as `touch`, reusing the entry (the map size is unchanged).
					seg.centreHz = centre
					seg.lastMono = now
					s.segments.delete(key)
					s.segments.set(key, seg)
				} else
					touch(
						s.segments,
						key,
						{ centreHz: centre, firstMono: now, lastMono: now },
						ACTIVITY_MAX_SEGMENTS,
					)
				liveKeys.add(key)
				if (!s.liveKeys.has(key)) edge = true
			}
			if (liveKeys.size !== s.liveKeys.size) edge = true
			s.spareKeys = s.liveKeys
			s.liveKeys = liveKeys
			if (edge) markDirty(sourceId)
		},
		ingestTrack(sourceId, engineId, track) {
			if (disposed) return
			const s = sources.get(sourceId)
			if (!s?.epoch || s.epoch.engineId !== engineId) return
			if (s.epoch.epoch !== track.epoch) return
			if (track.gate !== undefined && track.gate !== "passed") return
			if (track.flags.iqImage || track.flags.spur) return
			if (!Number.isFinite(track.centreHz)) return
			touch(
				s.tracks,
				track.trackId,
				{ centreHz: track.centreHz, at: mono() },
				ACTIVITY_MAX_TRACKS,
			)
			markDirty(sourceId)
		},
		stop(sourceId) {
			const s = sources.get(sourceId)
			if (!s || s.epoch === null) return
			s.epoch = null
			s.lastFrameMono = null
			s.lastBlockMono = null
			s.segments.clear()
			s.liveKeys = new Set()
			s.tracks.clear()
			dropInterests(sourceId)
			if (s.deadlineTimer !== null) timers.clearTimeout(s.deadlineTimer)
			s.deadlineTimer = null
			s.deadlineAt = null
			markDirty(sourceId, true)
		},
		noteDecode(sourceId, hz, protocol) {
			if (disposed || !Number.isFinite(hz) || hz <= 0) return
			const s = stateOf(sourceId, true)
			if (!s) return
			touch(
				s.decodes,
				noteKey(hz, protocol),
				{ hz, protocol, at: mono() },
				ACTIVITY_MAX_NOTES,
			)
			markDirty(sourceId)
		},
		noteReplayTrial(sourceId, hz, protocol, weight) {
			if (disposed || weight === "none" || !Number.isFinite(hz) || hz <= 0)
				return
			const s = stateOf(sourceId, true)
			if (!s) return
			const key = noteKey(hz, protocol)
			const point = { hz, protocol, at: mono() }
			if (weight === "success") {
				s.failures.delete(key)
				touch(s.successes, key, point, ACTIVITY_MAX_NOTES)
			} else touch(s.failures, key, point, ACTIVITY_MAX_NOTES)
			markDirty(sourceId)
		},
		setHistory(provider) {
			history = provider
		},
		sizes() {
			let segments = 0
			let tracks = 0
			let notes = 0
			for (const s of sources.values()) {
				segments += s.segments.size
				tracks += s.tracks.size
				notes += s.decodes.size + s.successes.size + s.failures.size
			}
			return {
				sources: sources.size,
				segments,
				tracks,
				notes,
				interests: interests.size,
			}
		},
		dispose() {
			disposed = true
			for (const s of sources.values()) {
				if (s.pendingTimer !== null) timers.clearTimeout(s.pendingTimer)
				if (s.deadlineTimer !== null) timers.clearTimeout(s.deadlineTimer)
			}
			sources.clear()
			interests.clear()
			listeners.clear()
		},
	}
}
