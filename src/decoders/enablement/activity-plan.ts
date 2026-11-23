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
import type { DsdTierView } from "./dsd-activity.js"
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
	/** dsd-fme: the last failed try per channel (dsdTierKey), kept 6 h, at most 256. */
	tries?: readonly { key: string; atMonoMs: number }[]
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
	/** dsd-fme: an analog-to-analog try (one per group per cooldown(5)). */
	analogRetry?: true
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
	// dsd-fme tier classes: 0 digital-held; 1 digital (not held) or unknown,
	// hot or warm; 2 analog, hot or warm; 3 cold, any tier. Inside a class:
	// state, live first, digital before unknown, score, today's order.
	const cls = (hz: number, c: ChannelActivity) => {
		// No tiers (multimon-ng): one class. A channel the planner has no tier
		// for is unknown, never tried (class 1, or 3 when cold).
		if (!tierOf) return 0
		const t = tierOf(hz) ?? UNKNOWN_TIER
		if (t.held) return 0
		if (c.state === "cold") return 3
		return t.tier === "analog" ? 2 : 1
	}
	return candidatesHz
		.filter(hz => by.get(hz)?.excluded !== true)
		.sort((a, b) => {
			const ca = by.get(a)!
			const cb = by.get(b)!
			return (
				cls(a, ca) - cls(b, cb) ||
				stateRank[ca.state] - stateRank[cb.state] ||
				(tierOf ? Number(cb.live) - Number(ca.live) : 0) ||
				(tierOf
					? Number(tierOf(a)?.tier !== "digital") -
						Number(tierOf(b)?.tier !== "digital")
					: 0) ||
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
		analogRetry?: true
	}[]
	moves: number
	/** When a blocked move may become possible (dwell end or move window). */
	blockedUntilMonoMs: number | null
}

/**
 * The evidence tier of one dsd-fme channel for one pass (the evidence
 * ranking of docs/DECODER-GUIDE.md, Troubleshooting, Decoder not starting,
 * item 8; built by the planner from the manager's tiers and the snapshot's
 * `evidence`):
 * - `tier`: how it challenges and ranks (digital > unknown > analog);
 * - `victim`: how it is judged as an incumbent (a manager no-sync failure
 *   turns scanner-only digital into analog here);
 * - `held`: digital-held (sync within 30 min), never a victim but for the
 *   discovery yield;
 * - `demoted`: analog in its cooldown, never fills a free slot or challenges;
 * - `retry`: scanner analog past its try gap: may take an analog slot once
 *   per group per cooldown(5), and fills a free slot only after digital and
 *   unknown candidates.
 */
export interface SlotTier {
	tier: "digital" | "unknown" | "analog"
	victim: "digital" | "unknown" | "analog"
	held: boolean
	demoted: boolean
	retry: boolean
	/** Last checked sync on the channel (manager clock), null for none. */
	lastSyncMonoMs: number | null
	/** Its last noted failed try, null for none (analog tries go least recent first). */
	triedMonoMs: number | null
}

const TIER_RANK = { analog: 0, unknown: 1, digital: 2 } as const
/** A channel the planner has no tier for: unknown, never tried. */
const UNKNOWN_TIER: SlotTier = {
	tier: "unknown",
	victim: "unknown",
	held: false,
	demoted: false,
	retry: false,
	lastSyncMonoMs: null,
	triedMonoMs: null,
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
 *    move). With tiers, analog channels fill only after every digital and
 *    unknown candidate, and demoted channels never.
 * 3. Ranked only: a hot or warm channel outranking an incumbent (and passing
 *    `canChallenge`, when given) replaces the lowest-ranked incumbent that is
 *    not live and whose dwell has passed, while the source has moves left. Each replacement is one move and
 *    carries the victim it replaces. The nearest-order fallback never
 *    displaces an incumbent, so a ranking outage reshuffles nothing.
 *
 * With `tierOf` (dsd-fme), step 3 follows the tiers instead:
 * - a higher tier replaces a lower one whatever the victim's live flag; the
 *   same tier (digital or unknown) needs today's rank rule and a victim that
 *   is not live; analog never replaces analog but for one `retry` per pass
 *   while `analogRetryOpen` (one per group per cooldown(5) = 1,920 s): the
 *   least recently tried channel, into the oldest analog run, without the
 *   hysteresis (the rate gate bounds it, and a channel heard only in short
 *   bursts is still tried);
 * - victims go lowest tier first; among analog runs the oldest first;
 * - a digital-held incumbent is never a victim; a digital incumbent that is
 *   not held is a victim of an unknown only when not live and its last sync
 *   (or none) is at least `syncCooldownMs` old;
 * - a digital challenger that is live passes the hysteresis at once (a short
 *   burst on a known channel reclaims a slot);
 * - discovery yield: when every slot is digital-held, count >= 2 and a
 *   confirmed hot unknown waits, the lowest-ranked held incumbent whose last
 *   sync is at least `syncCooldownMs` old yields, at most once per pass;
 * - analog challengers never schedule a blocked deadline.
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
	/** dsd-fme evidence tiers; absent: today's rules (multimon-ng). */
	tierOf?: (hz: number) => SlotTier | undefined
	/** Whether this group may make an analog-to-analog try move now. */
	analogRetryOpen?: boolean
	/** A not-held digital victim's last sync must be at least this old (no-sync cooldown). */
	syncCooldownMs?: number
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
		analogRetry?: true
	}
	const chosen: Entry[] = incumbents.map(i => ({ hz: i.hz, incumbent: i }))
	const has = (hz: number) => chosen.some(e => e.hz === hz)
	const tierOf = args.tierOf
	const fill = (accept: (hz: number) => boolean) => {
		for (const hz of args.order) {
			if (chosen.length >= count) break
			if (!has(hz) && !args.demotedHz?.has(hz) && accept(hz))
				chosen.push({ hz })
		}
	}
	if (tierOf) {
		fill(hz => tierOf(hz)?.tier !== "analog")
		fill(hz => tierOf(hz)?.demoted !== true)
	} else fill(() => true)
	let moves = 0
	let blocked: number | null = null
	const block = (at: number) => {
		blocked = blocked === null ? at : Math.min(blocked, at)
	}
	const now = args.nowMonoMs
	const cooldown = args.syncCooldownMs ?? 0
	const oldSync = (t: SlotTier | undefined) =>
		t === undefined ||
		t.lastSyncMonoMs === null ||
		now - t.lastSyncMonoMs >= cooldown
	let yielded = false
	// Victims: lowest tier first; among analog runs the oldest run first (a
	// fresh try keeps its slot longest), otherwise the lowest-ranked first.
	const victimOrder = (x: Entry, y: Entry): number => {
		if (!tierOf) return rank.get(y.hz)! - rank.get(x.hz)!
		const vx = tierOf(x.hz)?.victim ?? "unknown"
		const vy = tierOf(y.hz)?.victim ?? "unknown"
		return (
			TIER_RANK[vx] - TIER_RANK[vy] ||
			(vx === "analog" && vy === "analog"
				? (x.incumbent?.dwellSinceMonoMs ?? 0) -
					(y.incumbent?.dwellSinceMonoMs ?? 0)
				: 0) ||
			rank.get(y.hz)! - rank.get(x.hz)!
		)
	}
	if (args.ranked && args.activity) {
		for (const hz of args.order) {
			if (has(hz) || args.demotedHz?.has(hz)) continue
			const a = args.activity.get(hz)
			if (!a || a.state === "cold") continue
			const ct = tierOf ? (tierOf(hz) ?? UNKNOWN_TIER) : undefined
			if (ct?.demoted) continue
			const liveDigital = ct?.tier === "digital" && a.live
			if (args.canChallenge && args.canChallenge(hz) !== true && !liveDigital)
				continue
			// Analog challengers move only through the rate-gated try below.
			if (ct?.tier === "analog") continue
			const eligible = (e: Entry): boolean => {
				if (e.incumbent === undefined || e.incumbent.pinned === true)
					return false
				const live = args.activity!.get(e.hz)?.live === true
				const below = rank.get(e.hz)! > rank.get(hz)!
				if (!ct || !tierOf)
					return e.incumbent.syncSeen !== true && below && !live
				const vt = tierOf(e.hz) ?? UNKNOWN_TIER
				if (vt.held || e.incumbent.syncSeen === true) return false
				const victim = vt.victim
				// Silent digital channel yields: a not-held digital incumbent
				// yields to an unknown only when quiet: not live and no sync within
				// the no-sync cooldown.
				if (victim === "digital")
					return ct.tier === "digital" ? below && !live : !live && oldSync(vt)
				if (TIER_RANK[ct.tier] > TIER_RANK[victim]) return true
				return ct.tier === victim && below && !live
			}
			const victims = chosen.filter(eligible).sort(victimOrder)
			let yieldVictim = false
			if (
				!victims.length &&
				tierOf &&
				ct?.tier === "unknown" &&
				a.state === "hot" &&
				!yielded &&
				count >= 2 &&
				chosen.length === count &&
				chosen.every(
					e => e.incumbent !== undefined && tierOf(e.hz)?.held === true,
				)
			) {
				// Discovery yield: the lowest-ranked held incumbent with an old sync.
				const quiet = chosen
					.filter(e => e.incumbent!.pinned !== true && oldSync(tierOf(e.hz)))
					.sort((x, y) => rank.get(y.hz)! - rank.get(x.hz)!)
				if (quiet.length) {
					victims.push(...quiet)
					yieldVictim = true
				}
			}
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
			const at = chosen.indexOf(victim)
			chosen[at] = {
				hz,
				movedFrom: { key: victim.incumbent!.key, hz: victim.hz },
			}
			if (yieldVictim) yielded = true
			moves++
		}
		// The analog try: one per pass while the group's gate is open (one per
		// cooldown(5) = 1,920 s, dsd-activity.ts), the least recently tried
		// scanner-analog channel (never tried first, then rank) into the
		// oldest analog run past its dwell. The rate gate replaces the
		// hysteresis, so a channel with only short bursts is still tried.
		if (tierOf && args.analogRetryOpen === true && moves < args.movesLeft) {
			const tried = (hz: number) =>
				tierOf(hz)?.triedMonoMs ?? Number.NEGATIVE_INFINITY
			const candidate = args.order
				.filter(hz => {
					const t = tierOf(hz)
					const a = args.activity!.get(hz)
					return (
						!has(hz) &&
						!args.demotedHz?.has(hz) &&
						t?.tier === "analog" &&
						t.retry &&
						a !== undefined &&
						a.state !== "cold"
					)
				})
				.sort((x, y) => tried(x) - tried(y) || rank.get(x)! - rank.get(y)!)[0]
			const victim =
				candidate === undefined
					? undefined
					: chosen
							.filter(
								e =>
									e.incumbent !== undefined &&
									e.incumbent.pinned !== true &&
									e.incumbent.syncSeen !== true &&
									tierOf(e.hz)?.held !== true &&
									tierOf(e.hz)?.victim === "analog" &&
									now - e.incumbent.dwellSinceMonoMs >= args.dwellMs,
							)
							.sort(victimOrder)[0]
			if (candidate !== undefined && victim) {
				chosen[chosen.indexOf(victim)] = {
					hz: candidate,
					movedFrom: { key: victim.incumbent!.key, hz: victim.hz },
					analogRetry: true,
				}
				moves++
			}
		}
	}
	chosen.sort((a, b) => rank.get(a.hz)! - rank.get(b.hz)!)
	return {
		chosen: chosen.map(e =>
			e.movedFrom
				? {
						hz: e.hz,
						movedFrom: e.movedFrom,
						...(e.analogRetry ? { analogRetry: true as const } : {}),
					}
				: { hz: e.hz },
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
