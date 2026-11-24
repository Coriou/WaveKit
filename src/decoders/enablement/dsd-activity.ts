import type { BandRegion } from "@wavekit/api-types"
import { z } from "zod"
import { builtinBandplansFor } from "../../core/bandplans/builtin-supplement.js"
import type { ScannerProtocol } from "../../core/scanner/types.js"
import {
	ACTIVITY_DECODE_HOT_MS,
	ACTIVITY_DECODE_WARM_MS,
	ACTIVITY_WARM_HOLD_MS,
} from "../../core/scanner/channel-activity.js"
import { ACTIVITY_MAX_CANDIDATES } from "./activity-contract.js"
import { ACTIVITY_DWELL_MS, ACTIVITY_MOVE_WINDOW_MS } from "./activity-plan.js"
import type { ActivityPolicy } from "./activity-plan.js"
import { DECODER_PROTOCOLS } from "./contract.js"

/** 256 = one quarter of a 1,024-candidate query; oldest insertion dropped first. */
export const DSD_MAX_DEMOTIONS = ACTIVITY_MAX_CANDIDATES / 4

/**
 * Hold for a full rolling move window or one dwell per permitted move,
 * whichever is longer: max(60,000, dwellMs × max(1, maxMovesPerMinute)).
 * Defaults: max(60,000, 20,000 × 6) = 120 s, enough to try six other dwells
 * before a failed channel competes again. Zero moves still holds a full window.
 */
export function dsdNoSyncCooldownMs(policy: ActivityPolicy): number {
	return Math.max(
		ACTIVITY_MOVE_WINDOW_MS,
		policy.dwellMs * Math.max(1, policy.maxMovesPerMinute),
	)
}

/** A quiet run loses clean-sync protection at/past one cooldown from receipt. */
export function dsdSyncProtectionUntil(
	lastCleanMonoMs: number | null,
	now: number,
	policy: ActivityPolicy,
): number | null {
	if (
		lastCleanMonoMs === null ||
		!Number.isFinite(lastCleanMonoMs) ||
		!Number.isFinite(now) ||
		lastCleanMonoMs > now
	)
		return null
	const until = lastCleanMonoMs + dsdNoSyncCooldownMs(policy)
	return Number.isFinite(until) && now < until ? until : null
}

/** Only explicitly checked, CRC/FEC-clean parser lines renew protection. */
const SyncSchema = z.object({
	protocol: z.enum(["dmr", "p25", "nxdn", "ysf", "dpmr", "dstar"]),
	at: z.number().finite(),
	crcErr: z.literal(false),
	verified: z.literal(true),
	fecErrs: z.literal(0).optional(),
})
export function isDsdActivitySync(line: unknown): boolean {
	return SyncSchema.safeParse(line).success
}

/**
 * Digital hold: 2 × ACTIVITY_DECODE_HOT_MS = 2 × 900,000 = 1,800,000 ms
 * (30 min) after the last checked sync, while the channel has not decayed
 * (class H, docs/DECODER-GUIDE.md item 8). 30 min is also the longest
 * site interval the slot rules are sized for.
 */
export const DSD_DIGITAL_HOLD_MS = 2 * ACTIVITY_DECODE_HOT_MS
/**
 * Digital memory: ACTIVITY_DECODE_WARM_MS = 21,600,000 ms (6 h) after the
 * last checked sync, the same memory as a scanner decode. Only this clears
 * the last sync: no failure and no decay does.
 */
export const DSD_DIGITAL_MEMORY_MS = ACTIVITY_DECODE_WARM_MS
/** Cooldown doubling steps: cooldown(n) = base × 2^min(n − 1, 4); base 120 s gives 120..1,920 s. */
export const DSD_NOSYNC_MAX_DOUBLINGS = 4
/**
 * A channel the scanner classed analog FM is tried at most once per
 * cooldown(DSD_ANALOG_TRY_FAILURES) = cooldown(5) = 120 × 2^4 = 1,920 s, and a
 * slot group makes at most one such analog-to-analog move per 1,920 s:
 * 3,600 / 1,920 = 1.875 moves per hour per group.
 */
export const DSD_ANALOG_TRY_FAILURES = DSD_NOSYNC_MAX_DOUBLINGS + 1
/**
 * Decay by listened time: a remembered channel decays once it was listened
 * to for DSD_DECAY_QUIET_MS = 2 × DSD_DIGITAL_HOLD_MS = 60 min without a
 * sync (twice the longest site interval, so a periodic site never decays;
 * a Poisson site of mean 17.5 min decays with e^−3.4 ≈ 3 %), or for
 * DSD_DECAY_LIVE_MS = 10 min of that while the channel had energy
 * (600 s / 3 s = 200 heard bursts without a sync; a sync needs one 360 ms
 * DMR superframe). Listened time is wall time with a dsd-fme placement
 * running at the channel on a connected source, from
 * DSD_LISTEN_WARMUP_MS after its start or reconnect.
 */
export const DSD_DECAY_QUIET_MS = 2 * DSD_DIGITAL_HOLD_MS
export const DSD_DECAY_LIVE_MS = 10 * ACTIVITY_MOVE_WINDOW_MS
/** Listening starts 2,000 ms after a run start or reconnect: spawn <= 1 s + one 360 ms DMR superframe + margin. */
export const DSD_LISTEN_WARMUP_MS = 2_000
/**
 * Live reclaim (T1) budget: a remembered channel may enter a slot through
 * its live energy DSD_RECLAIM_BUDGET = 2 times per DSD_RECLAIM_WINDOW_MS =
 * DSD_DIGITAL_HOLD_MS = 30 min without a sync (a sync resets the count), so
 * a false sync costs at most 2 × (60 / 30) = 4 reclaims an hour.
 */
export const DSD_RECLAIM_BUDGET = 2
export const DSD_RECLAIM_WINDOW_MS = DSD_DIGITAL_HOLD_MS
/**
 * Moves kept for T1: of the ACTIVITY_MOVES_PER_MINUTE = 6 moves per 60 s
 * window the other kinds may use 6 − 2 = 4, so with two slots both can be
 * reclaimed within one minute.
 */
export const DSD_RECLAIM_RESERVE = 2
/**
 * How quiet a held victim of a live reclaim (T1) must be: its last sync at
 * least DSD_QUIET_VICTIM_MS = 60 s old (>= 6 × the 2-10 s gap between overs
 * of one call, so a call is never cut). Deliberately shorter than the 120 s
 * (dsdNoSyncCooldownMs) a held victim of the discovery yield (T3) or a burst
 * trial (TB) needs: those challengers are unknown, a T1 challenger is a
 * site with a checked sync.
 */
export const DSD_QUIET_VICTIM_MS = ACTIVITY_MOVE_WINDOW_MS
/**
 * Trial token and burst-trial gap, each split in two lanes per slot group:
 * a fresh lane for a challenger never tried (failures 0, no try noted) and a
 * retry lane for one that failed before. An unknown or decayed channel
 * enters an occupied slot (T2 or T3) at most once per lane gap, and a burst
 * trial (TB) the same, each gate on its own times: fresh every
 * DSD_TRIAL_GAP_MS = 300 s (3,600 / 300 = 12 an hour), retry every
 * DSD_RETRY_TRIAL_GAP_MS = 600 s (6 an hour). Failing channels then never
 * hold the gate a new site needs: 18 moves an hour per gate at most.
 */
export const DSD_TRIAL_GAP_MS = 5 * ACTIVITY_MOVE_WINDOW_MS
export const DSD_RETRY_TRIAL_GAP_MS = 2 * DSD_TRIAL_GAP_MS
/** A trial lane: never tried (fresh) or failed before (retry). */
export type DsdTrialLane = "fresh" | "retry"
export const dsdTrialLane = (
	failures: number,
	triedMonoMs: number | null,
): DsdTrialLane => (failures === 0 && triedMonoMs === null ? "fresh" : "retry")
/** The gap of one trial lane. */
export const dsdTrialGapMs = (lane: DsdTrialLane): number =>
	lane === "fresh" ? DSD_TRIAL_GAP_MS : DSD_RETRY_TRIAL_GAP_MS
/** A trial-token or burst-trial gate of one lane. */
export type DsdTrialGate = `${"trial" | "burst"}:${DsdTrialLane}`
const DSD_TRIAL_GATES: readonly DsdTrialGate[] = [
	"trial:fresh",
	"trial:retry",
	"burst:fresh",
	"burst:retry",
]
/** A challenger with a failed try in the last 30 min (DSD_DIGITAL_HOLD_MS) does not use the yield or a repeat burst trial. */
export const DSD_TRIED_RECENT_MS = DSD_DIGITAL_HOLD_MS
/**
 * Failure memory: an entry (failures, last try) is kept 6 h after its last
 * try (DSD_DIGITAL_MEMORY_MS), so an escalated cooldown survives sparse
 * retries. 6 h / 1,920 s = 11.25 analog tries per group, so with up to 11
 * scanner-analog channels in a group every one is tried before any is tried
 * twice.
 */
export const DSD_TRY_MEMORY_MS = DSD_DIGITAL_MEMORY_MS
/**
 * Channel tiers kept: DSD_MAX_DEMOTIONS = 256 (≈ 256 × 160 B ≈ 40 KiB).
 * Past it entries without a last sync go first (oldest try first), then the
 * oldest last sync.
 */
export const DSD_MAX_TIERS = DSD_MAX_DEMOTIONS
/**
 * A dsd-fme activity victim is sent SIGTERM and, when it has not exited,
 * SIGKILL after DSD_VICTIM_STOP_KILL_MS = 1,000 ms (the default stop waits
 * 5,000 ms). Its replacement starts after that exit, so a live reclaim
 * reaches its first checked sync within the 250 ms notice + 100 ms
 * coalesce + plan + <= 1,000 ms exit + <= 1,000 ms spawn + 360 ms superframe
 * <= ~2.7 s, inside a 3 s burst.
 */
export const DSD_VICTIM_STOP_KILL_MS = 1_000
/** Slot groups with a gate time, per gate: the same 256 bound, oldest insertion dropped first. */
export const DSD_MAX_RETRY_GROUPS = DSD_MAX_DEMOTIONS

/** cooldown(n) = dsdNoSyncCooldownMs × 2^min(max(n, 1) − 1, 4). */
export function dsdNoSyncCooldownAfter(
	failures: number,
	policy: ActivityPolicy,
): number {
	const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1
	return (
		dsdNoSyncCooldownMs(policy) * 2 ** Math.min(n - 1, DSD_NOSYNC_MAX_DOUBLINGS)
	)
}

/**
 * Tier keys round to DSD_TIER_RASTER_HZ = 6,250 / 2 = 3,125 Hz:
 * round(hz / 3,125) × 3,125, ties upward, at most 1,562.5 Hz off. Both
 * 6.25 kHz rasters (n × 6,250, which holds the 12.5 kHz grid, and
 * 3,125 + n × 6,250) are multiples of 3,125 Hz, so every channel of either
 * raster keeps its own key: two channels 3,125 Hz apart never share a tier.
 * (A plain 6,250 Hz rounding would put a 3,125 Hz-offset channel on its
 * upper neighbour's key.) Scanner observed centres are already on the
 * n × 6,250 raster (quantiseObservedCentre, activity-contract.ts) and keep their own frequency.
 */
export const DSD_TIER_RASTER_HZ = 3_125

/**
 * The RF identity of one dsd-fme channel of one (decoder, source) group: the
 * candidate's own frequency rounded to DSD_TIER_RASTER_HZ, not the placement
 * key, so it survives restarts, origin changes and retunes. Null for a
 * frequency that is not finite and positive (no tier is kept).
 */
export function dsdTierKey(
	decoderId: string,
	sourceId: string,
	hz: number,
): string | null {
	if (!Number.isFinite(hz) || hz <= 0) return null
	return dsdChallengeKey(
		decoderId,
		sourceId,
		Math.round(hz / DSD_TIER_RASTER_HZ) * DSD_TIER_RASTER_HZ,
	)
}

/** The key of one (decoder, source) slot group for its analog try time. */
export function dsdGroupKey(decoderId: string, sourceId: string): string {
	return JSON.stringify([decoderId, sourceId])
}

/** One manager tier entry, as the planner reads it. */
export interface DsdTierView {
	key: string
	/** digital: a last sync within 6 h (remembered); nosync: failures only. */
	tier: "digital" | "nosync"
	/** digital: last sync + 6 h; nosync: the cooldown end (or the last try). */
	untilMonoMs: number
	failures: number
	lastSyncMonoMs?: number
	/** The last failed try. */
	notedMonoMs?: number
	/** The no-sync cooldown end, either tier (a decayed channel can cool down too). */
	cooldownUntilMonoMs?: number
	/** Remembered and decayed (listened quiet past the decay bounds). */
	decayed?: boolean
	/** Listened time without a sync since the last sync, and its energized part. */
	quietMs?: number
	quietLiveMs?: number
	/** Live reclaims (T1) in the current 30 min window without a sync. */
	reclaims?: number
	reclaimWindowMonoMs?: number
}

/** One gate time of a slot group: the trial token or the burst trial (per lane), or the analog try. */
export type DsdGroupGate = DsdTrialGate | "analog"

interface TierEntry {
	lastSyncMonoMs: number | null
	quietMs: number
	quietLiveMs: number
	/** Listened time is counted up to here (dedups a VFO and a slot on one channel). */
	accountedToMonoMs: number | null
	decayed: boolean
	failures: number
	untilMonoMs: number | null
	triedMonoMs: number | null
	reclaims: number
	reclaimWindowMonoMs: number | null
}

const forgetOf = (e: TierEntry): number =>
	Math.max(
		e.lastSyncMonoMs === null
			? Number.NEGATIVE_INFINITY
			: e.lastSyncMonoMs + DSD_DIGITAL_MEMORY_MS,
		e.triedMonoMs === null
			? Number.NEGATIVE_INFINITY
			: e.triedMonoMs + DSD_TRY_MEMORY_MS,
		e.untilMonoMs ?? Number.NEGATIVE_INFINITY,
	)

const remembered = (e: TierEntry | undefined): e is TierEntry =>
	e !== undefined && e.lastSyncMonoMs !== null

/**
 * Per-channel dsd-fme tiers (manager-owned, on the manager's monotonic
 * clock). Transitions (user rules in docs/DECODER-GUIDE.md, Troubleshooting,
 * Decoder not starting, item 8):
 * - a checked sync: last sync = now; quiet, decay, failures, cooldown and
 *   reclaims reset;
 * - listened time (account): adds to the quiet totals of a remembered
 *   channel; at DSD_DECAY_QUIET_MS or DSD_DECAY_LIVE_MS it decays (the last
 *   sync is kept);
 * - a failed run (dwell passed, no sync since its start): unchanged while
 *   remembered and not decayed; otherwise failures + 1, cooldown =
 *   now + cooldown(failures), last try = now. While that run goes on, each
 *   pass renews the cooldown from now (renewFailure);
 * - a live reclaim (T1): reclaims + 1 in a 30 min window;
 * - last sync + 6 h: the sync is forgotten (not remembered any more); at
 *   max(last sync + 6 h, last try + 6 h, cooldown end) the entry is deleted.
 * Insertion order is renewed by delete-then-set on every write.
 */
export class DsdChannelTiers {
	private readonly entries = new Map<string, TierEntry>()
	private readonly gates: Record<DsdGroupGate, Map<string, number>> = {
		"trial:fresh": new Map(),
		"trial:retry": new Map(),
		"burst:fresh": new Map(),
		"burst:retry": new Map(),
		analog: new Map(),
	}

	/**
	 * Writes one entry. Past DSD_MAX_TIERS, entries at/past their forget time
	 * are swept first; then entries without a last sync go (oldest try first),
	 * then the oldest last sync. The entry just written is never its own
	 * victim, so at most DSD_MAX_TIERS entries remain and the newest survives.
	 */
	private set(key: string, entry: TierEntry, now: number): void {
		this.entries.delete(key)
		this.entries.set(key, entry)
		if (this.entries.size <= DSD_MAX_TIERS) return
		for (const [k, e] of [...this.entries])
			if (k !== key && now >= forgetOf(e)) this.entries.delete(k)
		while (this.entries.size > DSD_MAX_TIERS) {
			let victim: string | undefined
			let best = Number.POSITIVE_INFINITY
			let bestSynced: boolean | undefined
			for (const [k, e] of this.entries) {
				if (k === key) continue
				const synced = e.lastSyncMonoMs !== null
				const at = synced
					? e.lastSyncMonoMs!
					: (e.triedMonoMs ?? Number.NEGATIVE_INFINITY)
				if (
					victim === undefined ||
					(bestSynced === true && !synced) ||
					(bestSynced === synced && at < best)
				) {
					victim = k
					best = at
					bestSynced = synced
				}
			}
			if (victim === undefined) break
			this.entries.delete(victim)
		}
	}

	/** The entry with its expiries applied (6 h sync memory, forget time), or undefined. */
	private live(key: string, now: number): TierEntry | undefined {
		const e = this.entries.get(key)
		if (!e) return undefined
		if (now >= forgetOf(e)) {
			this.entries.delete(key)
			return undefined
		}
		if (
			e.lastSyncMonoMs !== null &&
			now - e.lastSyncMonoMs >= DSD_DIGITAL_MEMORY_MS
		) {
			e.lastSyncMonoMs = null
			e.quietMs = 0
			e.quietLiveMs = 0
			e.accountedToMonoMs = null
			e.decayed = false
			e.reclaims = 0
			e.reclaimWindowMonoMs = null
		}
		return e
	}

	/** Records a checked sync; true when the channel was not held before (a pass is due). */
	noteSync(key: string, now: number): boolean {
		if (!Number.isFinite(now)) return false
		const wasHeld = this.held(key, now)
		const old = this.live(key, now)
		this.set(
			key,
			{
				lastSyncMonoMs: now,
				quietMs: 0,
				quietLiveMs: 0,
				accountedToMonoMs: now,
				decayed: false,
				failures: 0,
				untilMonoMs: null,
				triedMonoMs: old?.triedMonoMs ?? null,
				reclaims: 0,
				reclaimWindowMonoMs: null,
			},
			now,
		)
		return !wasHeld
	}

	/**
	 * Listened time of a remembered channel from `fromMonoMs` to `toMonoMs`
	 * (`live`: it had energy throughout). Time before the last sync or before
	 * what was already counted is not counted again, so a VFO and a slot on
	 * one channel count once. True when the channel decays now (a pass is due).
	 */
	account(
		key: string,
		fromMonoMs: number,
		toMonoMs: number,
		live: boolean,
	): boolean {
		if (!Number.isFinite(toMonoMs) || Number.isNaN(fromMonoMs)) return false
		const e = this.live(key, toMonoMs)
		if (!remembered(e)) return false
		const from = Math.max(
			fromMonoMs,
			e.lastSyncMonoMs!,
			e.accountedToMonoMs ?? Number.NEGATIVE_INFINITY,
		)
		const delta = Math.max(0, toMonoMs - from)
		e.accountedToMonoMs = Math.max(
			e.accountedToMonoMs ?? Number.NEGATIVE_INFINITY,
			toMonoMs,
		)
		if (delta === 0) return false
		e.quietMs += delta
		if (live) e.quietLiveMs += delta
		if (
			!e.decayed &&
			(e.quietMs >= DSD_DECAY_QUIET_MS || e.quietLiveMs >= DSD_DECAY_LIVE_MS)
		) {
			e.decayed = true
			return true
		}
		return false
	}

	/**
	 * Records a failed sync of one run. A remembered channel that has not
	 * decayed is unchanged (its quiet time already counts); otherwise the
	 * failure escalates the cooldown.
	 */
	noteFailure(key: string, now: number, policy: ActivityPolicy): void {
		if (!Number.isFinite(now)) return
		const old = this.live(key, now)
		if (remembered(old) && !old.decayed) return
		const failures = (old?.failures ?? 0) + 1
		this.set(
			key,
			{
				lastSyncMonoMs: old?.lastSyncMonoMs ?? null,
				quietMs: old?.quietMs ?? 0,
				quietLiveMs: old?.quietLiveMs ?? 0,
				accountedToMonoMs: old?.accountedToMonoMs ?? null,
				decayed: old?.decayed ?? false,
				failures,
				untilMonoMs: now + dsdNoSyncCooldownAfter(failures, policy),
				triedMonoMs: now,
				reclaims: old?.reclaims ?? 0,
				reclaimWindowMonoMs: old?.reclaimWindowMonoMs ?? null,
			},
			now,
		)
	}

	/**
	 * A failed run that is still running: its cooldown and try time count
	 * from now (the try lasts the whole run), failures unchanged. Without it
	 * a long no-sync run would outlive its cooldown and retake a slot at once.
	 */
	renewFailure(key: string, now: number, policy: ActivityPolicy): void {
		if (!Number.isFinite(now)) return
		const e = this.live(key, now)
		if (!e || e.failures < 1 || e.untilMonoMs === null) return
		if (remembered(e) && !e.decayed) return
		this.set(
			key,
			{
				...e,
				untilMonoMs: Math.max(
					e.untilMonoMs,
					now + dsdNoSyncCooldownAfter(e.failures, policy),
				),
				triedMonoMs: now,
			},
			now,
		)
	}

	/** Records a live reclaim (T1) into a slot: +1 in the 30 min window (DSD_RECLAIM_WINDOW_MS). */
	noteReclaim(key: string, now: number): void {
		if (!Number.isFinite(now)) return
		const e = this.live(key, now)
		if (!remembered(e)) return
		if (
			e.reclaimWindowMonoMs === null ||
			now - e.reclaimWindowMonoMs >= DSD_RECLAIM_WINDOW_MS
		) {
			e.reclaimWindowMonoMs = now
			e.reclaims = 1
		} else e.reclaims++
	}

	/** Whether the channel is held: remembered, not decayed, a sync within the 30 min hold. */
	held(key: string, now: number): boolean {
		const e = this.live(key, now)
		return (
			remembered(e) &&
			!e.decayed &&
			now - e.lastSyncMonoMs! < DSD_DIGITAL_HOLD_MS
		)
	}

	/** The last checked sync of a remembered channel, null for none. */
	lastSync(key: string): number | null {
		return this.entries.get(key)?.lastSyncMonoMs ?? null
	}

	/** The listened quiet totals of a remembered channel that has not decayed, or null. */
	quiet(
		key: string,
		now: number,
	): { quietMs: number; quietLiveMs: number } | null {
		const e = this.live(key, now)
		return remembered(e) && !e.decayed
			? { quietMs: e.quietMs, quietLiveMs: e.quietLiveMs }
			: null
	}

	/** Records a gate time of a slot group (a trial-token, burst-trial or analog-try move). */
	noteTrial(groupKey: string, gate: DsdGroupGate, now: number): void {
		if (!Number.isFinite(now)) return
		const map = this.gates[gate]
		map.delete(groupKey)
		map.set(groupKey, now)
		while (map.size > DSD_MAX_RETRY_GROUPS) {
			const oldest = map.keys().next()
			if (oldest.done) break
			map.delete(oldest.value)
		}
	}

	/** Records an analog-to-analog try move of a slot group. */
	noteAnalogRetry(groupKey: string, now: number): void {
		this.noteTrial(groupKey, "analog", now)
	}

	/** Drops every entry of a source removed for good. */
	dropSource(sourceId: string): void {
		const ofSource = (key: string) => {
			try {
				const parsed: unknown = JSON.parse(key)
				return Array.isArray(parsed) && parsed[1] === sourceId
			} catch {
				return false
			}
		}
		for (const key of [...this.entries.keys()])
			if (ofSource(key)) this.entries.delete(key)
		for (const map of Object.values(this.gates))
			for (const key of [...map.keys()]) if (ofSource(key)) map.delete(key)
	}

	/** Live entries (expired ones are swept) and the gate times of each group. */
	snapshot(
		now: number,
		policy: ActivityPolicy,
	): {
		tiers: DsdTierView[]
		analogRetries: { groupKey: string; atMonoMs: number }[]
		trials: { groupKey: string; gate: DsdTrialGate; atMonoMs: number }[]
	} {
		const tiers: DsdTierView[] = []
		for (const key of [...this.entries.keys()]) {
			const e = this.live(key, now)
			if (!e) continue
			const digital = e.lastSyncMonoMs !== null
			tiers.push({
				key,
				tier: digital ? "digital" : "nosync",
				untilMonoMs: digital
					? e.lastSyncMonoMs! + DSD_DIGITAL_MEMORY_MS
					: (e.untilMonoMs ?? e.triedMonoMs ?? now),
				failures: e.failures,
				...(digital ? { lastSyncMonoMs: e.lastSyncMonoMs! } : {}),
				...(e.triedMonoMs !== null ? { notedMonoMs: e.triedMonoMs } : {}),
				...(e.untilMonoMs !== null
					? { cooldownUntilMonoMs: e.untilMonoMs }
					: {}),
				...(digital
					? {
							decayed: e.decayed,
							quietMs: e.quietMs,
							quietLiveMs: e.quietLiveMs,
							reclaims: e.reclaims,
							...(e.reclaimWindowMonoMs !== null
								? { reclaimWindowMonoMs: e.reclaimWindowMonoMs }
								: {}),
						}
					: {}),
			})
		}
		const gateOf = (map: Map<string, number>, gapMs: number) => {
			const out: { groupKey: string; atMonoMs: number }[] = []
			for (const [groupKey, atMonoMs] of map) {
				if (now - atMonoMs >= gapMs) map.delete(groupKey)
				else out.push({ groupKey, atMonoMs })
			}
			return out
		}
		const analogRetries = gateOf(
			this.gates.analog,
			dsdNoSyncCooldownAfter(DSD_ANALOG_TRY_FAILURES, policy),
		)
		const trials = DSD_TRIAL_GATES.flatMap(gate =>
			gateOf(
				this.gates[gate],
				dsdTrialGapMs(gate.endsWith(":fresh") ? "fresh" : "retry"),
			).map(t => ({ ...t, gate })),
		)
		return { tiers, analogRetries, trials }
	}
}

/** Band-plan protocols that make a range ISM/SRD or LoRa: never a dsd-fme activity slot. */
const DSD_NEVER_PROTOCOLS: readonly ScannerProtocol[] = ["ism", "lora"]

interface DsdSlotRanges {
	voice: readonly (readonly [number, number])[]
	never: readonly (readonly [number, number])[]
}
/** One entry per region at most (BAND_REGIONS), filled on first use. */
const slotRanges = new Map<BandRegion, DsdSlotRanges>()

function slotRangesFor(region: BandRegion): DsdSlotRanges {
	const hit = slotRanges.get(region)
	if (hit) return hit
	const voiceProtocols: readonly string[] = DECODER_PROTOCOLS["dsd-fme"] ?? []
	const voice: (readonly [number, number])[] = []
	const never: (readonly [number, number])[] = []
	for (const plan of builtinBandplansFor(region))
		for (const range of plan.ranges) {
			const protocols: readonly string[] = range.protocols ?? []
			const span = [range.startHz, range.endHz] as const
			if (
				protocols.some(p => DSD_NEVER_PROTOCOLS.includes(p as ScannerProtocol))
			)
				never.push(span)
			else if (protocols.some(p => voiceProtocols.includes(p))) voice.push(span)
		}
	const out = { voice, never }
	slotRanges.set(region, out)
	return out
}

/**
 * Whether a dsd-fme activity slot (a ranked secondary channel, scanner energy
 * centres included) may sit at `hz`: inside a range of the region's band plan
 * catalogue that lists a protocol dsd-fme decodes (land mobile, PMR446, dPMR446,
 * amateur 2 m / 70 cm) and inside no range listing ISM or LoRa (in the EU the
 * 433 MHz and 863-870 MHz ISM/SRD bands, where LoRa and telemetry bursts would
 * otherwise pull slots around). Unknown region or a malformed frequency: no
 * slot (the safe answer). The configured, band and VFO channels are not
 * activity slots and are not checked here.
 */
export function dsdActivitySlotAllowed(
	region: BandRegion | undefined,
	hz: number,
): boolean {
	if (region === undefined || !Number.isFinite(hz) || hz <= 0) return false
	let ranges: DsdSlotRanges
	try {
		ranges = slotRangesFor(region)
	} catch {
		return false
	}
	const inside = (r: readonly [number, number]) => hz >= r[0] && hz <= r[1]
	return ranges.voice.some(inside) && !ranges.never.some(inside)
}

/**
 * Challenge hysteresis: a ranked channel may displace a running dsd-fme
 * activity slot only after its energy was observed at least
 * DSD_CHALLENGE_MIN_OBSERVATIONS = 2 times (distinct energy timestamps, one
 * per placement pass) spanning at least DSD_CHALLENGE_MIN_SPAN_MS = 10 s
 * (ACTIVITY_DWELL_MS / 2 = 20 000 / 2) within DSD_CHALLENGE_MEMORY_MS. A
 * one-off burst shorter than 10 s therefore never moves a slot however many
 * passes see it: every energy timestamp it leaves lies inside its own
 * duration, so first and last differ by less than the span. A voice channel
 * qualifies with one transmission of 10 s or more, or two transmissions 10 s
 * apart. Together with the 20 s dwell and at most 6 moves a minute, a slot
 * moves at most once per 20 s and only towards a channel heard for 10 s.
 */
export const DSD_CHALLENGE_MIN_OBSERVATIONS = 2
export const DSD_CHALLENGE_MIN_SPAN_MS = ACTIVITY_DWELL_MS / 2
/**
 * Evidence is forgotten after 2 × 60 s = 120 s (two move windows, as long as
 * a channel stays hot after energy), so an old burst never pairs with a new one.
 */
export const DSD_CHALLENGE_MEMORY_MS = 2 * ACTIVITY_MOVE_WINDOW_MS
/**
 * Kept timestamps are thinned to one per DSD_CHALLENGE_THIN_MS = 5 s
 * (DSD_CHALLENGE_MIN_SPAN_MS / 2) plus the newest: a new timestamp within 5 s
 * of the one before the newest replaces the newest. Every kept timestamp is a
 * real observation, so thinning never confirms early; the oldest kept lies at
 * most 5 s after the oldest seen, so it can delay a confirmation by 5 s once
 * the first observation ages out. At most 120 000 / 5 000 + 2 = 26 per channel.
 */
export const DSD_CHALLENGE_THIN_MS = DSD_CHALLENGE_MIN_SPAN_MS / 2
export const DSD_CHALLENGE_MAX_OBSERVATIONS =
	DSD_CHALLENGE_MEMORY_MS / DSD_CHALLENGE_THIN_MS + 2
/** Channels tracked: one query's 1 024 candidates; oldest insertion dropped first. */
export const DSD_MAX_CHALLENGERS = ACTIVITY_MAX_CANDIDATES
/**
 * Burst runs: a site heard only in short bursts minutes apart (3 s every
 * 5 to 10 min) never meets the 10 s span within the 120 s memory. Each pass
 * sees a channel live or not: a live channel without an open run opens one
 * (onset = that snapshot's last energy), a channel that is not live closes
 * its open run (end = its last energy, exact to one block). The last two
 * runs per channel are kept. A burst pair (burstPaired) holds when all of:
 * - the previous run is closed and lasted DSD_BURST_MIN_MS = 1,000 ms
 *   (ACTIVITY_LIVE_TTL_MS; a DMR PTT is at least 1 s) to
 *   DSD_BURST_MAX_MS = ACTIVITY_MOVE_WINDOW_MS = 60 s;
 * - it was off for at least DSD_BURST_OFF_MS = 60 s before the current
 *   onset (current onset − previous end);
 * - the onsets lie DSD_CHALLENGE_MEMORY_MS = 120 s (inclusive) to
 *   DSD_CHALLENGE_BURST_MEMORY_MS = ACTIVITY_WARM_HOLD_MS = 900 s
 *   (exclusive) apart;
 * - now − the current onset < 120 s (the span rule's freshness).
 * A steady carrier never closes its run, so it never pairs however sparse
 * the passes; a blip under 1 s is never a first burst; an off period no pass
 * saw merges two runs into one, which can only lose a pair. State: two runs
 * per channel, at most DSD_MAX_CHALLENGERS = 1 024 channels (oldest
 * insertion dropped first), swept 900 s after a closed run's end.
 */
export const DSD_CHALLENGE_BURST_MEMORY_MS = ACTIVITY_WARM_HOLD_MS
export const DSD_BURST_MIN_MS = 1_000
export const DSD_BURST_MAX_MS = ACTIVITY_MOVE_WINDOW_MS
export const DSD_BURST_OFF_MS = ACTIVITY_MOVE_WINDOW_MS

/** The identity of one challenger channel of one (decoder, source) group. */
export function dsdChallengeKey(
	decoderId: string,
	sourceId: string,
	hz: number,
): string {
	return JSON.stringify([decoderId, sourceId, hz])
}

interface BurstRun {
	onsetMonoMs: number
	endMonoMs: number | null
}

export class DsdChallengeEvidence {
	private readonly entries = new Map<string, number[]>()
	private readonly runs = new Map<
		string,
		{ prev: BurstRun | null; cur: BurstRun }
	>()

	/** Opens or closes the channel's run from one pass's live flag (see DSD_CHALLENGE_BURST_MEMORY_MS). */
	private noteRun(
		key: string,
		live: boolean,
		energyMonoMs: number | null,
		now: number,
	): void {
		const r = this.runs.get(key)
		const energy =
			energyMonoMs !== null &&
			Number.isFinite(energyMonoMs) &&
			energyMonoMs <= now
				? energyMonoMs
				: null
		if (live) {
			if (r && r.cur.endMonoMs === null) return
			const onset = energy ?? now
			if (r && onset <= (r.cur.endMonoMs ?? r.cur.onsetMonoMs)) return
			this.runs.delete(key)
			this.runs.set(key, {
				prev: r?.cur ?? null,
				cur: { onsetMonoMs: onset, endMonoMs: null },
			})
			while (this.runs.size > DSD_MAX_CHALLENGERS) {
				const oldest = this.runs.keys().next()
				if (oldest.done) break
				this.runs.delete(oldest.value)
			}
			return
		}
		if (!r || r.cur.endMonoMs !== null) return
		r.cur.endMonoMs = Math.max(r.cur.onsetMonoMs, energy ?? r.cur.onsetMonoMs)
	}

	/**
	 * Records one pass's view of a channel, as a snapshot reports it: its
	 * energy timestamp (`lastEnergyMonoMs`) for the span rule and, when given,
	 * its live flag for the burst runs. An energy timestamp is ignored when it
	 * is not finite, in the future, older than the memory, or not newer than
	 * the last one recorded (the same energy seen by another pass is not a
	 * new observation).
	 */
	note(
		key: string,
		energyMonoMs: number | null,
		now: number,
		live?: boolean,
	): void {
		if (!Number.isFinite(now)) return
		if (live !== undefined) this.noteRun(key, live, energyMonoMs, now)
		if (
			energyMonoMs === null ||
			!Number.isFinite(energyMonoMs) ||
			energyMonoMs > now ||
			now - energyMonoMs >= DSD_CHALLENGE_MEMORY_MS
		)
			return
		const kept = (this.entries.get(key) ?? []).filter(
			t => now - t < DSD_CHALLENGE_MEMORY_MS,
		)
		if (kept.length && energyMonoMs <= kept[kept.length - 1]!) return
		if (
			kept.length >= 2 &&
			energyMonoMs - kept[kept.length - 2]! < DSD_CHALLENGE_THIN_MS
		)
			kept[kept.length - 1] = energyMonoMs
		else kept.push(energyMonoMs)
		while (kept.length > DSD_CHALLENGE_MAX_OBSERVATIONS) kept.shift()
		this.entries.delete(key)
		this.entries.set(key, kept)
		while (this.entries.size > DSD_MAX_CHALLENGERS) {
			const oldest = this.entries.keys().next()
			if (!oldest.done) this.entries.delete(oldest.value)
		}
	}

	/** Whether the channel's last two runs are a burst pair now (DSD_CHALLENGE_BURST_MEMORY_MS). */
	burstPaired(key: string, now: number): boolean {
		const r = this.runs.get(key)
		const prev = r?.prev
		if (!r || !prev || prev.endMonoMs === null) return false
		const length = prev.endMonoMs - prev.onsetMonoMs
		const off = r.cur.onsetMonoMs - prev.endMonoMs
		const gap = r.cur.onsetMonoMs - prev.onsetMonoMs
		const age = now - r.cur.onsetMonoMs
		return (
			length >= DSD_BURST_MIN_MS &&
			length <= DSD_BURST_MAX_MS &&
			off >= DSD_BURST_OFF_MS &&
			gap >= DSD_CHALLENGE_MEMORY_MS &&
			gap < DSD_CHALLENGE_BURST_MEMORY_MS &&
			age >= 0 &&
			age < DSD_CHALLENGE_MEMORY_MS
		)
	}

	/**
	 * Whether the channel's evidence within the memory meets both bounds, or
	 * its last two runs are a burst pair (DSD_CHALLENGE_BURST_MEMORY_MS).
	 */
	confirmed(key: string, now: number): boolean {
		if (this.burstPaired(key, now)) return true
		const kept = (this.entries.get(key) ?? []).filter(
			t => now - t < DSD_CHALLENGE_MEMORY_MS && t <= now,
		)
		return (
			kept.length >= DSD_CHALLENGE_MIN_OBSERVATIONS &&
			kept[kept.length - 1]! - kept[0]! >= DSD_CHALLENGE_MIN_SPAN_MS
		)
	}

	/** Keys confirmed now (span rule or burst pair); expired evidence is dropped. */
	snapshot(now: number): string[] {
		for (const [key, r] of this.runs)
			if (
				r.cur.endMonoMs !== null &&
				now - r.cur.endMonoMs >= DSD_CHALLENGE_BURST_MEMORY_MS
			)
				this.runs.delete(key)
		const out = new Set<string>()
		for (const [key, kept] of this.entries) {
			if (!kept.some(t => now - t < DSD_CHALLENGE_MEMORY_MS))
				this.entries.delete(key)
			else if (this.confirmed(key, now)) out.add(key)
		}
		for (const key of this.runs.keys())
			if (this.burstPaired(key, now)) out.add(key)
		return [...out]
	}

	/** Keys whose last two runs are a burst pair now (the burst-trial right). */
	burstPairedKeys(now: number): string[] {
		const out: string[] = []
		for (const key of this.runs.keys())
			if (this.burstPaired(key, now)) out.push(key)
		return out
	}
}
