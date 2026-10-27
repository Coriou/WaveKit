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
import type { DecoderReach } from "./contract.js"
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
	/** Recent checked, CRC/FEC-clean sync from this exact running placement. */
	syncSeen?: boolean
	/** Monotonic expiry supplied by the manager; re-evaluate even in quiet spectrum. */
	syncUntilMonoMs?: number
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
	/** Bounded no-sync cooldowns, carried by the manager on the same clock. */
	demotions?: readonly { key: string; untilMonoMs: number }[]
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
const REASONS: readonly ActivityReason[] = [
	"live-energy",
	"track",
	"occupancy",
	"decoded",
	"trial-success",
	"trial-backoff",
]

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
		(c.excluded === undefined || typeof c.excluded === "boolean")
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
): number[] {
	if (!snapshot) return [...candidatesHz]
	const by = new Map(snapshot.channels.map(c => [c.hz, c]))
	const index = new Map(candidatesHz.map((hz, i) => [hz, i]))
	return candidatesHz
		.filter(hz => by.get(hz)?.excluded !== true)
		.sort((a, b) => {
			const ca = by.get(a)!
			const cb = by.get(b)!
			return (
				stateRank[ca.state] - stateRank[cb.state] ||
				(ca.state === "cold" ? 0 : cb.score - ca.score) ||
				index.get(a)! - index.get(b)!
			)
		})
}

/** The bounded status entry for one channel. */
export function placementActivity(
	channel: ChannelActivity | undefined,
): PlacementActivity {
	if (!channel) return { ranking: "nearest" }
	return {
		ranking: "activity",
		state: channel.state,
		score: roundScore(channel.score),
		live: channel.live,
		reasons: REASONS.filter(r => channel.reasons.includes(r)),
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
	chosen: { hz: number; movedFrom?: { key: string; hz: number } }[]
	moves: number
	/** When a blocked move may become possible (dwell end or move window). */
	blockedUntilMonoMs: number | null
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
 *    move).
 * 3. Ranked only: a hot or warm channel outranking an incumbent replaces the
 *    lowest-ranked incumbent that is not live and whose dwell has passed,
 *    while the source has moves left. Each replacement is one move and
 *    carries the victim it replaces. The nearest-order fallback never
 *    displaces an incumbent, so a ranking outage reshuffles nothing.
 */
export function selectChannels(args: {
	order: readonly number[]
	/** Demoted channels cannot fill a free slot or challenge; incumbents still spend moves. */
	demotedHz?: ReadonlySet<number>
	ranked: boolean
	activity: ReadonlyMap<number, ChannelActivity> | null
	count: number
	incumbents: readonly SelectionIncumbent[]
	nowMonoMs: number
	dwellMs: number
	movesLeft: number
	/** When the oldest counted move leaves the window (for blocked moves). */
	moveWindowFreesMonoMs: number | null
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
	}
	const chosen: Entry[] = incumbents.map(i => ({ hz: i.hz, incumbent: i }))
	const has = (hz: number) => chosen.some(e => e.hz === hz)
	for (const hz of args.order) {
		if (chosen.length >= count) break
		if (!has(hz) && !args.demotedHz?.has(hz)) chosen.push({ hz })
	}
	let moves = 0
	let blocked: number | null = null
	const block = (at: number) => {
		blocked = blocked === null ? at : Math.min(blocked, at)
	}
	if (args.ranked && args.activity) {
		for (const hz of args.order) {
			if (has(hz) || args.demotedHz?.has(hz)) continue
			const a = args.activity.get(hz)
			if (!a || a.state === "cold") continue
			const victims = chosen
				.filter(
					e =>
						e.incumbent !== undefined &&
						e.incumbent.pinned !== true &&
						e.incumbent.syncSeen !== true &&
						rank.get(e.hz)! > rank.get(hz)! &&
						args.activity!.get(e.hz)?.live !== true,
				)
				.sort((x, y) => rank.get(y.hz)! - rank.get(x.hz)!)
			if (!victims.length) continue
			const victim = victims.find(
				e => args.nowMonoMs - e.incumbent!.dwellSinceMonoMs >= args.dwellMs,
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
			const at = chosen.indexOf(victim)
			chosen[at] = {
				hz,
				movedFrom: { key: victim.incumbent!.key, hz: victim.hz },
			}
			moves++
		}
	}
	chosen.sort((a, b) => rank.get(a.hz)! - rank.get(b.hz)!)
	return {
		chosen: chosen.map(e =>
			e.movedFrom ? { hz: e.hz, movedFrom: e.movedFrom } : { hz: e.hz },
		),
		moves,
		blockedUntilMonoMs: blocked,
	}
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
