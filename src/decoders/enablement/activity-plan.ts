/**
 * Activity-ranked decoder channels, planner side (Stage 1): ordering of a
 * decoder's eligible channels from an activity snapshot, the global slot
 * allocator, and the bounded move selection. Pure: every time, snapshot and
 * piece of running state is supplied by the caller (the decoder manager
 * takes one snapshot batch per reconciliation pass).
 */
import type {
	ActivityDecoder,
	ActivityEpoch,
	ActivityQuery,
	ActivityReason,
	ActivitySnapshot,
	ActivityState,
	ChannelActivity,
	ObservedActivityCentre,
} from "./activity-contract.js"
import { REASONS } from "./activity-contract.js"
import type { DecoderReach } from "./contract.js"
import type { DsdTierView, DsdTrialGate, DsdTrialLane } from "./dsd-activity.js"
import { channelizerBaseCores } from "./contract.js"

export const ACTIVITY_DECODERS: readonly ActivityDecoder[] = [
	"multimon-ng",
	"dsd-fme",
]
export const isActivityDecoder = (type: string): type is ActivityDecoder =>
	(ACTIVITY_DECODERS as readonly string[]).includes(type)

/** A source moves at most this many activity channels per rolling window. */
export const ACTIVITY_MOVES_PER_MINUTE = 6
export const ACTIVITY_MOVE_WINDOW_MS = 60_000
/** A running activity channel is not displaced for this long after its start. */
export const ACTIVITY_DWELL_MS = 20_000
export const ACTIVITY_MAX_SLOTS = 32
/**
 * Default activity slots per decoder per source (beyond the primary or VFO
 * channel), and the replay allowance. At 1.024 Msps (channelizer base 0.22):
 *
 * x86-64, 1.5-core budget: multimon-ng VFO + 4 = 5 x 0.14 = 0.70, dsd-fme
 * VFO + 2 = 3 x 0.155 = 0.465, base 0.22, replay 0.10:
 * 0.70 + 0.465 + 0.22 + 0.10 = 1.485 <= 1.5.
 *
 * arm64 (at most 4 cores), 0.75-core budget: multimon-ng VFO + 1 = 0.28,
 * dsd-fme VFO + 0 = 0.155, base 0.22, replay 0.05:
 * 0.28 + 0.155 + 0.22 + 0.05 = 0.705 <= 0.75. (VFO + 2 paging slots with the
 * dsd-fme VFO channel is 0.22 + 0.42 + 0.155 = 0.795, over the budget.)
 *
 * Slot counts are upper bounds: the allocator gives only what the budget
 * holds beside every other placement.
 */
export const ACTIVITY_SLOTS_X64: Readonly<Record<ActivityDecoder, number>> = {
	"multimon-ng": 4,
	"dsd-fme": 2,
}
export const ACTIVITY_SLOTS_ARM64: Readonly<Record<ActivityDecoder, number>> = {
	"multimon-ng": 1,
	"dsd-fme": 0,
}
export const ACTIVITY_REPLAY_CORES_X64 = 0.1
export const ACTIVITY_REPLAY_CORES_ARM64 = 0.05
/** Floating point slack of the budget comparison (cores). */
export const BUDGET_EPSILON = 1e-9

export interface ActivityPolicy {
	slots: Readonly<Record<ActivityDecoder, number>>
	replayAllowanceCores: number
	budgetCores: number
	maxMovesPerMinute: number
	dwellMs: number
}

/** A placement of an activity decoder the manager runs or is starting. */
export interface ActivityIncumbent {
	key: string
	decoderId: string
	sourceId: string
	hz: number
	primary: boolean
	/** Its successful start, or when it was first planned while never started. */
	dwellSinceMonoMs: number
	/**
	 * dsd-fme: the channel is digital-held, a checked CRC/FEC-clean sync on it
	 * within DSD_DIGITAL_HOLD_MS (30 min, dsd-activity.ts), kept per RF channel.
	 */
	syncSeen?: boolean
	/** Monotonic expiry supplied by the manager; re-evaluate even in quiet spectrum. */
	syncUntilMonoMs?: number
	/**
	 * dsd-fme: the current run passed its dwell of listened time since the
	 * later of its start, its last sync and the source's reconnect, without a
	 * sync (a decayed victim then counts as no-sync). Absent: judged from
	 * `dwellSinceMonoMs`.
	 */
	noSyncRun?: boolean
}

/** A placement whose process start is in flight (it holds capacity already). */
export interface ActivityPendingStart {
	key: string
	sourceId: string
	reach: DecoderReach
	costCores: number
	sampleRateHz: number
}

export interface PlannerActivity {
	nowMonoMs: number
	/**
	 * dsd-fme channel tiers (dsdTierKey keys, bounded to DSD_MAX_TIERS = 256),
	 * carried by the manager on the same clock.
	 */
	tiers?: readonly DsdTierView[]
	/** Per dsd-fme slot group (dsdGroupKey), its last analog-to-analog try move. */
	analogRetries?: readonly { groupKey: string; atMonoMs: number }[]
	/**
	 * Per dsd-fme slot group, its last trial-token and burst-trial moves per
	 * lane (fresh 300 s, retry 600 s gates).
	 */
	trials?: readonly {
		groupKey: string
		gate: DsdTrialGate
		atMonoMs: number
	}[]
	/** dsd-fme challengers whose last two burst runs pair (dsdChallengeKey keys). */
	burstPairedChallengers?: readonly string[]
	/**
	 * dsd-fme challengers whose energy passed the challenge hysteresis
	 * (dsdChallengeKey keys, dsd-activity.ts). Absent: none did, so no dsd-fme
	 * slot moves; free slots still fill.
	 */
	confirmedChallengers?: readonly string[]
	policy: ActivityPolicy
	/** The current spectrum epoch of each source; a source without one is unranked. */
	epochs: readonly ActivityEpoch[]
	/** Scanner energy centres, at most the ranker's bounded segment count per source. */
	observed?: readonly {
		epoch: ActivityEpoch
		channelsHz: readonly number[]
		centres?: readonly ObservedActivityCentre[]
	}[]
	/** One atomic batch taken for this pass (empty while computing the queries). */
	snapshots: readonly ActivitySnapshot[]
	incumbents: readonly ActivityIncumbent[]
	/** Successful-or-attempted moves of the rolling window, any order. */
	recentMoves: readonly { sourceId: string; atMonoMs: number }[]
	pendingStarts: readonly ActivityPendingStart[]
}

export interface ActivityMove {
	decoderId: string
	sourceId: string
	fromKey: string
	fromHz: number
	toKey: string
	toHz: number
	atMonoMs: number
	/** dsd-fme: the gate of the move (T1 reclaim, T2 tier, T3 yield, TB burst trial, T4 analog try). */
	kind?: MoveKind
	/** dsd-fme: the move used the group's trial token (T2 by D/S/U, T3). */
	trial?: true
	/** dsd-fme: the trial lane a trial-token or burst-trial move used. */
	lane?: DsdTrialLane
}

export interface ActivityGroupView {
	decoderId: string
	sourceId: string
	ranking: "activity" | "nearest"
	/** Slots asked for (min of the configured count and the eligible channels). */
	wanted: number
	/** Slots the budget gave. */
	given: number
}

export interface ActivityPlanResult {
	queries: readonly ActivityQuery[]
	moves: readonly ActivityMove[]
	groups: readonly ActivityGroupView[]
	/** Earliest time a new pass may change the plan; null for none. */
	nextEvaluationMonoMs: number | null
}

/** Why a placement of an activity decoder runs, bounded for the status view. */
export interface PlacementActivity {
	ranking: "activity" | "nearest"
	state?: ActivityState
	score?: number
	live?: boolean
	reasons?: readonly ActivityReason[]
}

const STATES: readonly ActivityState[] = ["hot", "warm", "cold"]
const sameEpoch = (a: ActivityEpoch, b: ActivityEpoch | undefined) =>
	b !== undefined &&
	a.sourceId === b.sourceId &&
	a.engineId === b.engineId &&
	a.epoch === b.epoch

function validChannel(c: ChannelActivity | null | undefined, hz: number) {
	return (
		c != null &&
		c.hz === hz &&
		typeof c.score === "number" &&
		Number.isFinite(c.score) &&
		c.score >= 0 &&
		STATES.includes(c.state) &&
		typeof c.live === "boolean" &&
		Array.isArray(c.reasons) &&
		(c.excluded === undefined || typeof c.excluded === "boolean") &&
		(c.evidence === undefined ||
			c.evidence === "digital" ||
			c.evidence === "analog")
	)
}

/**
 * The snapshot answering `query`, or null: not exactly one snapshot for the
 * query's decoder and source, not `ready`, another epoch, other candidates,
 * or a channel list that is not one valid entry per candidate in order.
 */
export function readySnapshot(
	query: ActivityQuery,
	snapshots: readonly ActivitySnapshot[],
): ActivitySnapshot | null {
	let found: ActivitySnapshot | null = null
	let count = 0
	for (const s of Array.isArray(snapshots) ? snapshots : []) {
		if (
			s?.query?.decoderId === query.decoderId &&
			s.query.epoch?.sourceId === query.epoch.sourceId
		) {
			found = s
			count++
		}
	}
	if (count !== 1 || !found) return null
	const s = found
	const candidates = s.query.candidatesHz
	if (
		s.status !== "ready" ||
		!sameEpoch(query.epoch, s.query.epoch) ||
		s.query.decoderType !== query.decoderType ||
		!Array.isArray(candidates) ||
		candidates.length !== query.candidatesHz.length ||
		candidates.some((hz, i) => hz !== query.candidatesHz[i]) ||
		!Array.isArray(s.channels) ||
		s.channels.length !== query.candidatesHz.length ||
		s.channels.some((c, i) => !validChannel(c, query.candidatesHz[i]!))
	)
		return null
	return s
}

const stateRank = { hot: 0, warm: 1, cold: 2 } as const

/**
 * Activity order of `candidatesHz` (given in today's planner order: nearest
 * the capture centre first, paging raster before other band-plan channels):
 * hot by score (highest first), then warm by score, then cold; equal scores
 * and cold channels keep today's order. Without a snapshot: today's order.
 * Excludes candidates with recent non-voice decode evidence; otherwise a permutation.
 */
export function activityOrder(
	candidatesHz: readonly number[],
	snapshot: ActivitySnapshot | null,
	tierOf?: (hz: number) => SlotTier | undefined,
): number[] {
	if (!snapshot) return [...candidatesHz]
	const by = new Map(snapshot.channels.map(c => [c.hz, c]))
	const index = new Map(candidatesHz.map((hz, i) => [hz, i]))
	// dsd-fme classes (SlotClass): 0 H in any state; cold otherwise 4;
	// 1 R; 2 D, S, U (in that order, D by most recent sync first); 3 A;
	// 4 DN, N. Inside a class: state, live first, score, today's order.
	const cls = (hz: number, c: ChannelActivity) => {
		// No tiers (multimon-ng): one class. A channel the planner has no tier
		// for is unknown, never tried.
		if (!tierOf) return 0
		const t = tierOf(hz)?.cls ?? "U"
		if (t === "H") return 0
		if (c.state === "cold") return 4
		return t === "R" ? 1 : t === "A" ? 3 : t === "DN" || t === "N" ? 4 : 2
	}
	const sub = (hz: number) => {
		const t = tierOf?.(hz)?.cls
		return t === "D" ? 0 : t === "S" ? 1 : 2
	}
	const syncOf = (hz: number) =>
		tierOf?.(hz)?.lastSyncMonoMs ?? Number.NEGATIVE_INFINITY
	return candidatesHz
		.filter(hz => by.get(hz)?.excluded !== true)
		.sort((a, b) => {
			const ca = by.get(a)!
			const cb = by.get(b)!
			return (
				cls(a, ca) - cls(b, cb) ||
				(tierOf && cls(a, ca) === 2
					? sub(a) - sub(b) ||
						(sub(a) === 0 && syncOf(b) !== syncOf(a)
							? syncOf(b) > syncOf(a)
								? 1
								: -1
							: 0)
					: 0) ||
				stateRank[ca.state] - stateRank[cb.state] ||
				(tierOf ? Number(cb.live) - Number(ca.live) : 0) ||
				(ca.state === "cold" ? 0 : cb.score - ca.score) ||
				index.get(a)! - index.get(b)!
			)
		})
}

/** The bounded status entry for one channel. */
export function placementActivity(
	channel: ChannelActivity | undefined,
	tierReasons: readonly ActivityReason[] = [],
): PlacementActivity {
	if (!channel) return { ranking: "nearest" }
	return {
		ranking: "activity",
		state: channel.state,
		score: roundScore(channel.score),
		live: channel.live,
		reasons: REASONS.filter(
			r => channel.reasons.includes(r) || tierReasons.includes(r),
		),
	}
}

/** Three decimals without overflow: a score too large to scale is kept as is. */
export function roundScore(score: number): number {
	if (!Number.isFinite(score) || score < 0) return 0
	const scaled = score * 1000
	return Number.isFinite(scaled) ? Math.round(scaled) / 1000 : score
}

export interface SlotCharge {
	key: string
	sourceId: string
	reach: DecoderReach
	costCores: number
	sampleRateHz: number
}
export interface SlotGroup {
	sourceId: string
	sampleRateHz: number
	/** One channel of this decoder: decoder share plus the channel marginal. */
	perChannelCores: number
	/** Slots asked for. */
	want: number
	/**
	 * Pending starts of this group's own candidates. They are charged as
	 * pending starts, so up to `want` of them hold a slot at no further cost;
	 * the selection must keep them (`pinned`).
	 */
	prepaid?: number
}
export interface SlotAllocation {
	given: number[]
	/** Cores of mandatory placements, their channelizer bases and pending starts. */
	committedCores: number
	/** Budget left after the replay allowance and every slot given (may be negative). */
	remainingCores: number
}

const finiteNonNegative = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n >= 0

/**
 * The global activity slot allocator. Arithmetic:
 *
 *   committed = sum(cost of every mandatory placement)
 *             + sum(channelizer base of each source holding a mandatory
 *                   channel placement: 0.22, 0.26 above 2.048 Msps)
 *             + sum(cost of each distinct pending start that is not a
 *                   mandatory placement, plus its source's base when
 *                   uncharged)
 *   remaining = budget - committed - replay allowance
 *
 * A pending start is capacity in use whether or not the plan keeps it, so it
 * is deduplicated only against the mandatory placements, never against
 * eligibility. A group's own pending candidates (`prepaid`, at most `want`)
 * then hold slots at no further cost, and the selection keeps them. The
 * other slots go round-robin over the groups in plan order (one slot per
 * group per round), each costing the decoder's channel cost plus the
 * channelizer base when its source is not charged yet; a group whose next
 * slot does not fit stops. Every core is spent once:
 * committed + replay + sum(unpaid slot costs) <= budget whenever a slot was
 * paid for, and when committed + replay already exceeds the budget no slot
 * is paid for.
 */
export function allocateActivitySlots(args: {
	budgetCores: number
	replayAllowanceCores: number
	mandatory: readonly SlotCharge[]
	pending: readonly SlotCharge[]
	/** Keys of the mandatory placements (already counted in `mandatory`). */
	plannedKeys: ReadonlySet<string>
	groups: readonly SlotGroup[]
}): SlotAllocation {
	const given = args.groups.map(() => 0)
	const charged = new Set<string>()
	let committed = 0
	let invalid = false
	const charge = (p: SlotCharge) => {
		if (!finiteNonNegative(p.costCores)) {
			invalid = true
			return
		}
		committed += p.costCores
		if (p.reach === "channel" && !charged.has(p.sourceId)) {
			if (!finiteNonNegative(p.sampleRateHz) || p.sampleRateHz === 0) {
				invalid = true
				return
			}
			charged.add(p.sourceId)
			committed += channelizerBaseCores(p.sampleRateHz)
		}
	}
	for (const p of args.mandatory) charge(p)
	const pendingSeen = new Set<string>()
	for (const p of args.pending)
		if (!args.plannedKeys.has(p.key) && !pendingSeen.has(p.key)) {
			pendingSeen.add(p.key)
			charge(p)
		}
	const budget = args.budgetCores
	const replay = args.replayAllowanceCores
	if (invalid || !finiteNonNegative(budget) || !finiteNonNegative(replay))
		return {
			given,
			committedCores: invalid ? Infinity : committed,
			remainingCores: -Infinity,
		}
	let remaining = budget - committed - replay
	args.groups.forEach((g, i) => {
		const want = Number.isInteger(g.want) && g.want > 0 ? g.want : 0
		const prepaid =
			Number.isInteger(g.prepaid) && g.prepaid! > 0 ? g.prepaid! : 0
		given[i] = Math.min(want, prepaid)
	})
	const open = args.groups.map(
		g =>
			Number.isInteger(g.want) &&
			g.want > 0 &&
			finiteNonNegative(g.perChannelCores) &&
			finiteNonNegative(g.sampleRateHz) &&
			g.sampleRateHz > 0,
	)
	let progress = true
	while (progress) {
		progress = false
		args.groups.forEach((g, i) => {
			if (!open[i] || given[i]! >= g.want) return
			const base = charged.has(g.sourceId)
				? 0
				: channelizerBaseCores(g.sampleRateHz)
			const cost = g.perChannelCores + base
			if (cost > remaining + BUDGET_EPSILON) {
				open[i] = false
				return
			}
			remaining -= cost
			charged.add(g.sourceId)
			given[i]!++
			progress = true
		})
	}
	return { given, committedCores: committed, remainingCores: remaining }
}

export interface SelectionIncumbent {
	key: string
	hz: number
	dwellSinceMonoMs: number
	/** A prepaid pending start: always kept, never a victim. */
	pinned?: boolean
	/** Sync from this placement protects an identified voice channel between bursts. */
	syncSeen?: boolean
}
export interface SelectionResult {
	chosen: {
		hz: number
		movedFrom?: { key: string; hz: number }
		kind?: MoveKind
		trial?: true
		lane?: DsdTrialLane
	}[]
	moves: number
	/** When a blocked move may become possible (dwell end or move window). */
	blockedUntilMonoMs: number | null
}

/**
 * dsd-fme channel classes for one pass (docs/DECODER-GUIDE.md,
 * Troubleshooting, Decoder not starting, item 8), built by the planner:
 * - H held: a sync within 30 min, not decayed;
 * - R remembered: a sync within 6 h, not decayed, not held;
 * - D decayed: a sync within 6 h, decayed, not in a no-sync cooldown;
 * - DN: decayed and in a cooldown (demoted, but keeps its live reclaim);
 * - S: scanner digital-voice evidence, no sync here;
 * - U unknown; A analog (scanner analog FM or a trial backoff);
 * - N no-sync: not remembered and in a cooldown, or a run past its dwell
 *   without a sync.
 * H, R, D and DN are remembered: never demoted from the snapshot (zeroed).
 */
export type SlotClass = "H" | "R" | "D" | "DN" | "S" | "U" | "A" | "N"
/** How a dsd-fme slot move happened (the gates T1, T2, TB, T3, T4). */
export type MoveKind =
	| "reclaim"
	| "tier"
	| "yield"
	| "burst-trial"
	| "analog-try"

export interface SlotTier {
	cls: SlotClass
	/** Live reclaims left (T1 budget: 2 per 30 min without a sync). */
	reclaimOk: boolean
	/** Its last two burst runs pair (the burst-trial right). */
	burstPaired: boolean
	/** No fill, no T2 (DN, N, analog in its try gap or backoff). */
	demoted: boolean
	/** Scanner analog past its try gap: the analog try (T4) may pick it. */
	retry: boolean
	/** Last checked sync on the channel (manager clock), null for none. */
	lastSyncMonoMs: number | null
	/** Its last noted failed try, null for none. */
	triedMonoMs: number | null
	failures: number
	/** As an incumbent: its current run passed its dwell without a sync (D/DN victims count as N). */
	noSyncRun: boolean
}

const REMEMBERED: ReadonlySet<SlotClass> = new Set(["H", "R", "D", "DN"])
/** A channel the planner has no tier for: unknown, never tried. */
const UNKNOWN_TIER: SlotTier = {
	cls: "U",
	reclaimOk: false,
	burstPaired: false,
	demoted: false,
	retry: false,
	lastSyncMonoMs: null,
	triedMonoMs: null,
	failures: 0,
	noSyncRun: false,
}

/** A challenger as `mayTake` judges it. */
export interface TakeChallenger {
	cls: SlotClass
	live: boolean
	/** Past the hysteresis (span rule or burst pair). */
	confirmed: boolean
	state: ActivityState
	reclaimOk: boolean
	burstPaired: boolean
	demoted: boolean
	retry: boolean
	failures: number
	triedMonoMs: number | null
	/** Its index in the activity order (lower is better). */
	rank: number
}
/** A running incumbent as `mayTake` judges it. */
export interface TakeVictim {
	cls: SlotClass
	live: boolean
	lastSyncMonoMs: number | null
	/** Its run passed the dwell. */
	dwellPassed: boolean
	pinned: boolean
	/** Its current run passed its dwell without a sync (M-c: a D/DN victim counts as N for T2/TB/T4). */
	noSyncRun: boolean
	rank: number
}
export interface TakeContext {
	nowMonoMs: number
	count: number
	/** Every chosen slot holds an H incumbent. */
	allHeld: boolean
	/** The group's trial token is free in the challenger's lane (T2 by D/S/U into an occupied slot, T3). */
	trialOpen: boolean
	/** The group's burst-trial gap is free in the challenger's lane (TB). */
	burstTrialOpen: boolean
	/** No discovery yield (T3) yet this pass. */
	yieldOpen: boolean
	/** The group's analog try gate is open (T4). */
	analogTryOpen: boolean
	/** T1: a held victim's last sync must be at least this old (DSD_QUIET_VICTIM_MS, 60 s). */
	quietVictimMs: number
	/** T3 and TB: a held victim's last sync must be at least this old (dsdNoSyncCooldownMs, 120 s). */
	yieldSyncMs: number
	/** T3, and TB after a failure: no failed try within this (DSD_TRIED_RECENT_MS, 30 min). */
	triedRecentMs: number
}

/** The victim column of the slot table: H/R/D/U by live and quiet, A/N any live. */
export type VictimColumn =
	| "Hl"
	| "Hr"
	| "Hq"
	| "Rl"
	| "Rq"
	| "Dl"
	| "Dq"
	| "Ul"
	| "Uq"
	| "AN"

export function victimColumn(
	v: TakeVictim,
	ctx: Pick<TakeContext, "nowMonoMs" | "quietVictimMs">,
	asNoSync = false,
): VictimColumn {
	switch (v.cls) {
		case "H":
			if (v.live) return "Hl"
			return v.lastSyncMonoMs !== null &&
				ctx.nowMonoMs - v.lastSyncMonoMs < ctx.quietVictimMs
				? "Hr"
				: "Hq"
		case "R":
			return v.live ? "Rl" : "Rq"
		case "D":
		case "DN":
			if (asNoSync && v.noSyncRun) return "AN"
			return v.live ? "Dl" : "Dq"
		case "S":
		case "U":
			return v.live ? "Ul" : "Uq"
		default:
			return "AN"
	}
}

const oldSync = (v: TakeVictim, now: number, ms: number) =>
	v.lastSyncMonoMs === null || now - v.lastSyncMonoMs >= ms

/**
 * The slot challenge/yield table (docs/DECODER-GUIDE.md item 8): the gate a
 * challenger `c` takes the slot of victim `v` by, or null. Gates are tried in
 * the order T1 (live reclaim), T2 (tiered), TB (burst trial), T3 (discovery
 * yield), T4 (analog try); the first that allows the pair is returned. The
 * move budget is the caller's (selectChannels).
 *
 * | C ↓ / V →          | Hl | Hr | Hq        | Rl | Rq        | Dl / Dq        | Ul / Uq        | A / N        |
 * | T1 H/R/D/DN live   | no | no | yes       | no | yes       | no / yes       | yes, no dwell  | yes, no dwell|
 * | T2 H, R (not live) | no | no | no        | no | if below  | yes            | yes            | yes          |
 * | T2 D, S, U (token, live) | no | no | no  | no | sync≥120s | no / if below  | no / if below  | yes          |
 * | T3 D, S, U (≥2, all H, live) | no | no | sync≥120s | n/a | n/a | n/a     | n/a            | n/a          |
 * | TB D, S, U burst   | no | no | sync≥120s | no | yes       | no / yes       | no / yes       | yes          |
 * | T4 A (analog try)  | no | no | no        | no | no        | no             | no             | A/N, oldest  |
 *
 * Hr / Hq split at quietVictimMs (60 s). For T2, TB and T4 a D/DN victim
 * whose current run passed its dwell without a sync is an A/N victim. Every
 * victim needs its dwell except a non-remembered one (S, U, A, N) taken by
 * T1; a pinned victim (start in flight) never is one. A discovery challenger
 * (D, S, U) takes a token (T2), burst (TB) or yield (T3) move only while live:
 * a silent warm site that took the token would only fail into the retry lane.
 */
export function mayTake(
	c: TakeChallenger,
	v: TakeVictim,
	ctx: TakeContext,
): MoveKind | null {
	if (v.pinned) return null
	const now = ctx.nowMonoMs
	const below = v.rank > c.rank
	const remembered = REMEMBERED.has(c.cls)
	const discovery = c.cls === "D" || c.cls === "S" || c.cls === "U"
	const recentTry =
		c.triedMonoMs !== null && now - c.triedMonoMs < ctx.triedRecentMs
	// T1 live reclaim: no hysteresis; a non-remembered victim without its dwell.
	if (remembered && c.live && c.reclaimOk) {
		const col = victimColumn(v, ctx)
		const ok =
			col === "Hq" ||
			col === "Rq" ||
			col === "Dq" ||
			col === "Ul" ||
			col === "Uq" ||
			col === "AN"
		const dwellOk = v.dwellPassed || !REMEMBERED.has(v.cls)
		if (ok && dwellOk) return "reclaim"
	}
	if (!v.dwellPassed) return null
	// T2 tiered: confirmed, hot or warm, not demoted.
	if (c.confirmed && c.state !== "cold" && !c.demoted) {
		const col = victimColumn(v, ctx, true)
		if ((c.cls === "H" || c.cls === "R") && !c.live) {
			if (
				(col === "Rq" && below) ||
				col === "Dl" ||
				col === "Dq" ||
				col === "Ul" ||
				col === "Uq" ||
				col === "AN"
			)
				return "tier"
		} else if (discovery && c.live && ctx.trialOpen) {
			if (
				(col === "Rq" && oldSync(v, now, ctx.yieldSyncMs)) ||
				(col === "Dq" && below) ||
				(col === "Uq" && below) ||
				col === "AN"
			)
				return "tier"
		}
	}
	// TB burst trial: a burst pair, live, the group's burst gap free; after a
	// failure only once its last try is 30 min old.
	if (
		discovery &&
		c.burstPaired &&
		c.live &&
		ctx.burstTrialOpen &&
		(c.failures < 1 || !recentTry)
	) {
		const col = victimColumn(v, ctx, true)
		if (
			(col === "Hq" && oldSync(v, now, ctx.yieldSyncMs)) ||
			col === "Rq" ||
			col === "Dq" ||
			col === "Uq" ||
			col === "AN"
		)
			return "burst-trial"
	}
	// T3 discovery yield: two or more slots, all held.
	if (
		discovery &&
		ctx.count >= 2 &&
		ctx.allHeld &&
		ctx.trialOpen &&
		ctx.yieldOpen &&
		c.confirmed &&
		c.state === "hot" &&
		c.live &&
		!c.demoted &&
		!recentTry &&
		victimColumn(v, ctx) === "Hq" &&
		oldSync(v, now, ctx.yieldSyncMs)
	)
		return "yield"
	// T4 analog try: A/N victims only.
	if (
		c.cls === "A" &&
		c.retry &&
		ctx.analogTryOpen &&
		c.state !== "cold" &&
		victimColumn(v, ctx, true) === "AN"
	)
		return "analog-try"
	return null
}

/** Victim preference: A/N first, then U/S, D, R, H; lowest-ranked first (A/N: the oldest run). */
const VICTIM_RANK: Readonly<Record<VictimColumn, number>> = {
	AN: 0,
	Ul: 1,
	Uq: 1,
	Dl: 2,
	Dq: 2,
	Rl: 3,
	Rq: 3,
	Hl: 4,
	Hr: 4,
	Hq: 4,
}

/**
 * Picks `count` secondary channels of one (decoder, source) group from its
 * order (activity or nearest; the primary excluded) and the running
 * incumbents:
 *
 * 1. Incumbents still in the order are kept, pinned ones first, then by
 *    rank; the lowest-ranked unpinned are dropped only when the slot count
 *    shrank (budget or eligibility, not a move).
 * 2. Free slots take the best-ranked channels not chosen (a new slot, not a
 *    move). With tiers, analog channels fill only after every other
 *    candidate, and demoted channels never (a demoted DN only while live
 *    with its reclaim budget).
 * 3. Ranked only: without tiers (multimon-ng), a hot or warm channel
 *    outranking an incumbent (and passing `canChallenge`, when given)
 *    replaces the lowest-ranked incumbent that is not live and whose dwell
 *    has passed, while the source has moves left. With tiers (dsd-fme) the
 *    moves follow `mayTake`, phase by phase: T1 for every challenger, then
 *    T2, TB, T3 and T4 (T1 candidates by rank, T4 least recently tried
 *    first, T2, TB and T3 fewest failures first, then least recently
 *    tried). T1 may use every move left; the others together
 *    stop `reclaimReserve` moves short of it, so those stay for T1. The
 *    trial token and the burst gap each allow one move per pass and lane
 *    (fresh: never tried; retry: failed before), the analog gate one per
 *    pass, and T3 one per pass. Each replacement carries the victim it
 *    replaces and its kind. The nearest-order fallback never displaces an
 *    incumbent, so a ranking outage reshuffles nothing.
 */
export function selectChannels(args: {
	order: readonly number[]
	/** Demoted channels cannot fill a free slot or challenge; incumbents still spend moves. */
	demotedHz?: ReadonlySet<number>
	/** Absent: every hot or warm channel may challenge; false: it may not (hysteresis). */
	canChallenge?: (hz: number) => boolean
	ranked: boolean
	activity: ReadonlyMap<number, ChannelActivity> | null
	count: number
	incumbents: readonly SelectionIncumbent[]
	nowMonoMs: number
	dwellMs: number
	movesLeft: number
	/** When the oldest counted move leaves the window (for blocked moves). */
	moveWindowFreesMonoMs: number | null
	/** dsd-fme channel classes; absent: today's rules (multimon-ng). */
	tierOf?: (hz: number) => SlotTier | undefined
	/** dsd-fme group gates (absent: open; a boolean sets both lanes). */
	trialOpen?: boolean | Readonly<Record<DsdTrialLane, boolean>>
	burstTrialOpen?: boolean | Readonly<Record<DsdTrialLane, boolean>>
	analogRetryOpen?: boolean
	/** Moves kept for T1 (DSD_RECLAIM_RESERVE). */
	reclaimReserve?: number
	/** mayTake bounds (absent: 60 s, 120 s, 30 min). */
	quietVictimMs?: number
	syncCooldownMs?: number
	triedRecentMs?: number
}): SelectionResult {
	const rank = new Map(args.order.map((hz, i) => [hz, i]))
	const count = Math.max(0, Math.min(args.count, args.order.length))
	const seen = new Set<number>()
	const incumbents = args.incumbents
		.filter(i => rank.has(i.hz) && !seen.has(i.hz) && seen.add(i.hz))
		.sort(
			(a, b) =>
				Number(b.pinned === true) - Number(a.pinned === true) ||
				rank.get(a.hz)! - rank.get(b.hz)!,
		)
		.slice(0, count)
	type Entry = {
		hz: number
		incumbent?: SelectionIncumbent
		movedFrom?: { key: string; hz: number }
		kind?: MoveKind
		trial?: true
		lane?: DsdTrialLane
	}
	const chosen: Entry[] = incumbents.map(i => ({ hz: i.hz, incumbent: i }))
	const has = (hz: number) => chosen.some(e => e.hz === hz)
	const tierOf = args.tierOf
	const tier = (hz: number) => tierOf?.(hz) ?? UNKNOWN_TIER
	const liveOf = (hz: number) => args.activity?.get(hz)?.live === true
	const fill = (accept: (hz: number) => boolean) => {
		for (const hz of args.order) {
			if (chosen.length >= count) break
			if (!has(hz) && !args.demotedHz?.has(hz) && accept(hz))
				chosen.push({ hz })
		}
	}
	if (tierOf) {
		const fills = (t: SlotTier, hz: number) =>
			!t.demoted || (t.cls === "DN" && liveOf(hz) && t.reclaimOk)
		fill(hz => tier(hz).cls !== "A" && fills(tier(hz), hz))
		fill(hz => fills(tier(hz), hz))
	} else fill(() => true)
	let moves = 0
	let blocked: number | null = null
	const block = (at: number) => {
		blocked = blocked === null ? at : Math.min(blocked, at)
	}
	const now = args.nowMonoMs
	const finish = (): SelectionResult => {
		chosen.sort((a, b) => rank.get(a.hz)! - rank.get(b.hz)!)
		return {
			chosen: chosen.map(e =>
				e.movedFrom
					? {
							hz: e.hz,
							movedFrom: e.movedFrom,
							...(e.kind ? { kind: e.kind } : {}),
							...(e.trial ? { trial: true as const } : {}),
							...(e.lane ? { lane: e.lane } : {}),
						}
					: { hz: e.hz },
			),
			moves,
			blockedUntilMonoMs: blocked,
		}
	}
	if (!args.ranked || !args.activity) return finish()
	const activity = args.activity
	if (!tierOf) {
		for (const hz of args.order) {
			if (has(hz) || args.demotedHz?.has(hz)) continue
			const a = activity.get(hz)
			if (!a || a.state === "cold") continue
			if (args.canChallenge && args.canChallenge(hz) !== true) continue
			const victims = chosen
				.filter(
					e =>
						e.incumbent !== undefined &&
						e.incumbent.pinned !== true &&
						e.incumbent.syncSeen !== true &&
						rank.get(e.hz)! > rank.get(hz)! &&
						activity.get(e.hz)?.live !== true,
				)
				.sort((x, y) => rank.get(y.hz)! - rank.get(x.hz)!)
			if (!victims.length) continue
			const victim = victims.find(
				e => now - e.incumbent!.dwellSinceMonoMs >= args.dwellMs,
			)
			if (!victim) {
				for (const e of victims)
					block(e.incumbent!.dwellSinceMonoMs + args.dwellMs)
				continue
			}
			if (moves >= args.movesLeft) {
				if (args.moveWindowFreesMonoMs !== null)
					block(args.moveWindowFreesMonoMs)
				break
			}
			chosen[chosen.indexOf(victim)] = {
				hz,
				movedFrom: { key: victim.incumbent!.key, hz: victim.hz },
			}
			moves++
		}
		return finish()
	}
	const ctx: TakeContext = {
		nowMonoMs: now,
		count,
		allHeld: false,
		trialOpen: true,
		burstTrialOpen: true,
		yieldOpen: true,
		analogTryOpen: args.analogRetryOpen === true,
		quietVictimMs: args.quietVictimMs ?? ACTIVITY_MOVE_WINDOW_MS,
		yieldSyncMs: args.syncCooldownMs ?? 2 * ACTIVITY_MOVE_WINDOW_MS,
		triedRecentMs: args.triedRecentMs ?? 30 * ACTIVITY_MOVE_WINDOW_MS,
	}
	const lanes = (
		open: boolean | Readonly<Record<DsdTrialLane, boolean>> | undefined,
	): Record<DsdTrialLane, boolean> =>
		typeof open === "object"
			? { fresh: open.fresh, retry: open.retry }
			: { fresh: open ?? true, retry: open ?? true }
	const trialLanes = lanes(args.trialOpen)
	const burstLanes = lanes(args.burstTrialOpen)
	const laneOf = (c: TakeChallenger): DsdTrialLane =>
		c.failures === 0 && c.triedMonoMs === null ? "fresh" : "retry"
	const otherLeft = Math.max(
		0,
		args.movesLeft - Math.max(0, args.reclaimReserve ?? 0),
	)
	const challenger = (hz: number): TakeChallenger => {
		const t = tier(hz)
		const a = activity.get(hz)
		return {
			cls: t.cls,
			live: a?.live === true,
			confirmed: !args.canChallenge || args.canChallenge(hz) === true,
			state: a?.state ?? "cold",
			reclaimOk: t.reclaimOk,
			burstPaired: t.burstPaired,
			demoted: t.demoted || args.demotedHz?.has(hz) === true,
			retry: t.retry,
			failures: t.failures,
			triedMonoMs: t.triedMonoMs,
			rank: rank.get(hz)!,
		}
	}
	const victimOf = (e: Entry): TakeVictim => {
		const t = tier(e.hz)
		return {
			cls: t.cls,
			live: liveOf(e.hz),
			lastSyncMonoMs: t.lastSyncMonoMs,
			dwellPassed: now - e.incumbent!.dwellSinceMonoMs >= args.dwellMs,
			// A sync flag the planner could not class held (no valid expiry)
			// still protects the run from every move.
			pinned:
				e.incumbent!.pinned === true ||
				(e.incumbent!.syncSeen === true && t.cls !== "H"),
			noSyncRun: t.noSyncRun,
			rank: rank.get(e.hz)!,
		}
	}
	const tried = (hz: number) => tier(hz).triedMonoMs ?? Number.NEGATIVE_INFINITY
	const byRank = (x: number, y: number) => rank.get(x)! - rank.get(y)!
	const phases: readonly MoveKind[] = [
		"reclaim",
		"tier",
		"burst-trial",
		"yield",
		"analog-try",
	]
	const failures = (hz: number) => tier(hz).failures
	for (const kind of phases) {
		// Live reclaims go by rank; the analog try least recently tried first
		// (never tried first). Token classes (D, S, U) in the trial, burst-trial
		// and yield gates go by fewest failures, then least recently tried, so
		// channels that keep failing (escalated) never take a lane opening from
		// one that failed less. H and R challengers of the tier gate keep rank
		// order and go before every token class.
		const tokenCls = (hz: number) => {
			const cls = tier(hz).cls
			return cls === "D" || cls === "S" || cls === "U"
		}
		const order =
			kind === "reclaim"
				? args.order
				: kind === "analog-try"
					? [...args.order].sort((x, y) => tried(x) - tried(y) || byRank(x, y))
					: [...args.order].sort((x, y) => {
							const tx = tokenCls(x)
							const ty = tokenCls(y)
							if (!tx || !ty) return Number(tx) - Number(ty) || byRank(x, y)
							return (
								failures(x) - failures(y) || tried(x) - tried(y) || byRank(x, y)
							)
						})
		for (const hz of order) {
			if (has(hz)) continue
			const a = activity.get(hz)
			if (!a) continue
			const c = challenger(hz)
			const lane = laneOf(c)
			ctx.trialOpen = trialLanes[lane]
			ctx.burstTrialOpen = burstLanes[lane]
			ctx.allHeld =
				chosen.length === count &&
				chosen.every(e => e.incumbent !== undefined && tier(e.hz).cls === "H")
			const sitting = chosen.filter(e => e.incumbent !== undefined)
			const victims = sitting
				.filter(e => mayTake(c, victimOf(e), ctx) === kind)
				.sort((x, y) => {
					const vx = victimOf(x)
					const vy = victimOf(y)
					const cx = victimColumn(vx, ctx, kind !== "reclaim")
					const cy = victimColumn(vy, ctx, kind !== "reclaim")
					return (
						VICTIM_RANK[cx] - VICTIM_RANK[cy] ||
						(cx === "AN" && cy === "AN"
							? x.incumbent!.dwellSinceMonoMs - y.incumbent!.dwellSinceMonoMs
							: 0) ||
						vy.rank - vx.rank
					)
				})
			if (!victims.length) {
				// Analog challengers never schedule a blocked deadline.
				if (c.cls === "A") continue
				for (const e of sitting) {
					const v = victimOf(e)
					if (
						!v.dwellPassed &&
						mayTake(c, { ...v, dwellPassed: true }, ctx) === kind
					)
						block(e.incumbent!.dwellSinceMonoMs + args.dwellMs)
					// A live reclaim waiting for a held victim's quiet 60 s.
					if (
						kind === "reclaim" &&
						v.cls === "H" &&
						!v.live &&
						v.lastSyncMonoMs !== null &&
						now - v.lastSyncMonoMs < ctx.quietVictimMs &&
						mayTake(c, { ...v, lastSyncMonoMs: null }, ctx) === kind
					)
						block(v.lastSyncMonoMs + ctx.quietVictimMs)
				}
				continue
			}
			const cap = kind === "reclaim" ? args.movesLeft : otherLeft
			if (moves >= cap) {
				if (args.moveWindowFreesMonoMs !== null)
					block(args.moveWindowFreesMonoMs)
				break
			}
			const victim = victims[0]!
			const trial =
				kind === "yield" ||
				(kind === "tier" && (c.cls === "D" || c.cls === "S" || c.cls === "U"))
			chosen[chosen.indexOf(victim)] = {
				hz,
				movedFrom: { key: victim.incumbent!.key, hz: victim.hz },
				kind,
				...(trial ? { trial: true as const } : {}),
				...(trial || kind === "burst-trial" ? { lane } : {}),
			}
			moves++
			if (trial) trialLanes[lane] = false
			if (kind === "yield") ctx.yieldOpen = false
			if (kind === "burst-trial") burstLanes[lane] = false
			if (kind === "analog-try") ctx.analogTryOpen = false
		}
	}
	return finish()
}

/** Configured activity policy (`decoderPolicy.efficiency.activity`), defaults per host. */
export interface ActivityPolicyConfig {
	slots?: { [K in ActivityDecoder]?: number | undefined } | undefined
	replayAllowanceCores?: number | undefined
	maxMovesPerMinute?: number | undefined
	dwellMs?: number | undefined
}

export function resolveActivityPolicy(
	config: ActivityPolicyConfig | undefined,
	budgetCores: number,
	arch: string,
	cpuCount: number,
): ActivityPolicy {
	const small = arch === "arm64" && cpuCount <= 4
	const slots = small ? ACTIVITY_SLOTS_ARM64 : ACTIVITY_SLOTS_X64
	return {
		slots: {
			"multimon-ng": config?.slots?.["multimon-ng"] ?? slots["multimon-ng"],
			"dsd-fme": config?.slots?.["dsd-fme"] ?? slots["dsd-fme"],
		},
		replayAllowanceCores:
			config?.replayAllowanceCores ??
			(small ? ACTIVITY_REPLAY_CORES_ARM64 : ACTIVITY_REPLAY_CORES_X64),
		budgetCores,
		maxMovesPerMinute: config?.maxMovesPerMinute ?? ACTIVITY_MOVES_PER_MINUTE,
		dwellMs: config?.dwellMs ?? ACTIVITY_DWELL_MS,
	}
}
