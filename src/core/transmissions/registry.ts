/**
 * The transmission registry: one in-memory, bounded table of transmissions (txId). Producers
 * claim at an artefact's start and end their claim at its end; everything derived copies the id
 * it was given (claim once, copy forward). Nothing here runs per sample or per level: a claim
 * compares only against its own source's active claimants within one match width of its centre
 * (a per-source channel index) and its source's held entries, every other call is a Map lookup.
 *
 * Rules:
 * - Joins are geometric and only against open entries with an active claimant (no hang after an
 *   end). Two analog claims match only with the same source and kind and
 *   |Δhz| < min(halfA, halfB, TX_MATCH_HALF_MAX); when both carry an epoch, the same epoch and
 *   stream. Digital voice never matches by geometry: one entry per promotion, one open per lane.
 * - `continues` joins a held rollover predecessor without geometry; `splitFrom` is never joined.
 * - 0 matches: a new entry; 1: join; 2 or more: a new entry marked ambiguous (never merged).
 * - Closed entries are frozen: late ends, tones and refusals are counted no-ops; only the alias
 *   index of an artefact already carrying the id may grow. Tone and noAudioReason are derived on
 *   read.
 */
import {
	TX_ID,
	type TxAlias,
	type TxAliasKind,
	type TxClaim,
	type TxClaimResult,
	type TxCloseReason,
	type TxCounters,
	type TxEndReason,
	type TxIdentity,
	type TxKind,
	type TxLiveTone,
	type TxOrigin,
	type TxReadOptions,
	type TxRefusalCode,
	type TxScannerPort,
	type TxLiveDemodPort,
	type TxDvPort,
	type TxReadPort,
	type TxState,
	type TxView,
} from "./types.js"
import { newTxId } from "./ids.js"
import { deriveTone } from "./tone.js"

/** Two simultaneous voices 12.5 kHz (or 6.25 kHz: strict `<`) apart are never one transmission. */
export const TX_MATCH_HALF_MAX = 6_250
/**
 * Open entries per source: the spectrum's default maxTracks (512) + 1 live demodulator + 15
 * digital-voice lanes = 528. At the cap a new claim is refused and counted; a live entry is never
 * evicted.
 */
export const TX_OPEN_PER_SOURCE = 528
/** Open entries in all: 8 sources × 528 = 4 224 (the source count the discovery store assumes). */
export const TX_OPEN_MAX = 8 * TX_OPEN_PER_SOURCE
/**
 * Closed entries whose only aliases are their own observations and that carry no refusal. Gate-
 * passed observations close up to ~20/s on a busy wideband capture: 1 024 holds ≥ 50 s, enough
 * for a rollover `continues`, a grouping lookup and an open view.
 */
export const TX_BARE_CLOSED_MAX = 1_024
/**
 * Closed entries with a recording, event or call alias or a refusal. The measured worst rate is
 * 631 refusals / 10 min ≈ 1.05/s plus live overs ≤ 0.2/s: 2 048 holds ≥ 27 min.
 */
export const TX_CLOSED_MAX = 2_048
/** Closed entries with artefacts are kept at most 6 h. */
export const TX_CLOSED_TTL_MS = 6 * 60 * 60 * 1000
/** A continuous carrier closes `max-duration` after 30 min; the next claim opens a new id. */
export const TX_MAX_MS = 30 * 60 * 1000
/**
 * Aliases per entry per kind: 30 min / 120 s file parts = 15 recordings, 15 recording-change rows
 * + 3 live-demod rows at 600 s, 15 rollovers at 120 s + splits: 32 holds each.
 */
export const TX_ALIASES_PER_KIND = 32
/** Indexed (alias, txId) pairs in all: past it an alias is dropped and counted. */
export const TX_ALIASES_MAX = 16_384
/** Transmissions one alias may name: a file spans at most 8 (its txId + 7 moreTxIds). */
export const TX_ALIAS_TX_MAX = 8
/** A scanner entry whose last track ended `max-duration` waits this long for its successor. */
export const TX_ROLLOVER_HOLD_MS = 1_000
/** A new entry joins the group of one closed on its channel at most 15 s ago (hang + turnaround). */
export const TX_GROUP_GAP_MS = 15_000
/** …or of one closed `hop` at most 120 s ago (a hop return). */
export const TX_HOP_GROUP_MS = 120_000
/**
 * Recently closed entries kept per source for grouping (pruned past TX_HOP_GROUP_MS). At ~20
 * closes/s 120 s would need 2 400: past 1 024 the oldest go first (only a hop return that far
 * back loses its group).
 */
export const TX_RECENT_PER_SOURCE = 1_024
/** Retired decoder runs remembered (each dsd-fme start retires the previous one). */
export const TX_RETIRED_RUNS_MAX = 256
/** The registry's sweep period (hang expiry, max duration, ring TTL). */
export const TX_SWEEP_MS = 1_000

const ALIAS_KINDS: readonly TxAliasKind[] = ["rec", "evt", "obs", "call"]

interface Claimant {
	readonly id: number
	readonly entry: Entry
	readonly origin: TxOrigin
	readonly hz: number | undefined
	readonly halfWidthHz: number | undefined
	readonly epoch: number | undefined
	readonly stream: number | undefined
}

interface Entry {
	readonly id: string
	/** Creation order: ties between equally new matches go to the later one, as list order did. */
	readonly seq: number
	readonly groupId: string
	readonly kind: TxKind
	readonly origin: TxOrigin
	readonly sourceKey: string
	readonly sourceId: string | null
	readonly hz: number | null
	readonly halfWidthHz: number | null
	readonly epoch: number | undefined
	readonly dvLaneKey: string | null
	readonly run: string | null
	protocol: string | null
	state: TxState | "evicted"
	startedAtMs: number
	endedAtMs: number | null
	closedAtMs: number | null
	hangUntilMs: number
	close: TxCloseReason | null
	complete: boolean
	readonly ambiguous: boolean
	refusal: TxRefusalCode | null
	liveTone: TxLiveTone | null
	identity: TxIdentity | null
	readonly active: Set<Claimant>
	readonly aliases: Record<TxAliasKind, string[]>
}

export interface TransmissionRegistryOptions {
	now?: () => number
}

/**
 * One source's claim index. `buckets`: its active claimants with a finite centre by
 * floor(hz / TX_MATCH_HALF_MAX); a match is < TX_MATCH_HALF_MAX away, so it sits in the claim's
 * bucket or a neighbour. `hanging`: its held entries. `startLowMs`: at most its open entries'
 * earliest start (a lower bound, made exact by each over-age scan).
 */
interface SourceIndex {
	readonly buckets: Map<number, Set<Claimant>>
	readonly hanging: Set<Entry>
	startLowMs: number
}

/** What claims examined: per-claim work is bounded by these, not by the open count. */
export interface TxClaimScanStats {
	claims: number
	/** Claimants compared for a geometric match. */
	matchCandidates: number
	/** Open entries examined for expiry (held ones, and every one on an over-age scan). */
	expiryCandidates: number
}

function bucketOf(hz: number): number {
	return Math.floor(hz / TX_MATCH_HALF_MAX)
}

function sourceKeyOf(sourceId: string | null): string {
	return sourceId ?? ""
}

function aliasKindOf(alias: string): TxAliasKind | null {
	const cut = alias.indexOf(":")
	if (cut <= 0 || cut === alias.length - 1) return null
	const kind = alias.slice(0, cut)
	return (ALIAS_KINDS as readonly string[]).includes(kind)
		? (kind as TxAliasKind)
		: null
}

function finite(v: number | undefined): v is number {
	return typeof v === "number" && Number.isFinite(v)
}

/** R3: same channel. Both need a centre; the narrower half (≤ 6 250 Hz) bounds the distance. */
function sameChannel(
	aHz: number | undefined,
	aHalf: number | undefined,
	bHz: number | undefined,
	bHalf: number | undefined,
): boolean {
	if (!finite(aHz) || !finite(bHz)) return false
	const limit = Math.min(
		finite(aHalf) ? aHalf : 0,
		finite(bHalf) ? bHalf : 0,
		TX_MATCH_HALF_MAX,
	)
	return Math.abs(aHz - bHz) < limit
}

export class TransmissionRegistry
	implements TxScannerPort, TxLiveDemodPort, TxDvPort, TxReadPort
{
	private readonly now: () => number
	private readonly entries = new Map<string, Entry>()
	/** Open and held entries per source. */
	private readonly open = new Map<string, Set<Entry>>()
	private readonly index = new Map<string, SourceIndex>()
	private nextSeq = 1
	private readonly scan: TxClaimScanStats = {
		claims: 0,
		matchCandidates: 0,
		expiryCandidates: 0,
	}
	private openTotal = 0
	private readonly claimants = new Map<number, Claimant>()
	private nextClaimant = 1
	private readonly dvLanes = new Map<string, Entry>()
	private readonly retiredRuns = new Set<string>()
	/** Insertion order is close order: the first key is evicted first. */
	private readonly bareClosed = new Map<string, Entry>()
	private readonly artefactClosed = new Map<string, Entry>()
	private readonly recent = new Map<string, Entry[]>()
	private readonly aliasIndex = new Map<string, string[]>()
	/** Held entries per group, oldest first. Bound: the entries map (≤ open + both rings). */
	private readonly groups = new Map<string, string[]>()
	private aliasPairs = 0
	private timer: NodeJS.Timeout | null = null
	private readonly counters: TxCounters = {
		refusedCap: 0,
		retiredRun: 0,
		lateWrites: 0,
		aliasOverflow: 0,
		evicted: 0,
		fileNoTx: 0,
		ambiguous: 0,
	}

	constructor(opts: TransmissionRegistryOptions = {}) {
		this.now = opts.now ?? Date.now
	}

	/** Starts the 1 s sweep (unref'd). */
	start(): void {
		if (this.timer !== null) return
		this.timer = setInterval(() => this.sweep(), TX_SWEEP_MS)
		this.timer.unref()
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer)
		this.timer = null
	}

	stats(): Readonly<
		TxCounters & {
			open: number
			bareClosed: number
			closed: number
			aliases: number
			claimants: number
		}
	> {
		return {
			...this.counters,
			open: this.openTotal,
			bareClosed: this.bareClosed.size,
			closed: this.artefactClosed.size,
			aliases: this.aliasPairs,
			claimants: this.claimants.size,
		}
	}

	/** Cumulative claim scan work (tests and diagnostics). */
	claimScanStats(): TxClaimScanStats {
		return { ...this.scan }
	}

	openOn(sourceId: string | null): number {
		return this.open.get(sourceKeyOf(sourceId))?.size ?? 0
	}

	claim(c: TxClaim): TxClaimResult | null {
		const at = c.atMs
		if (c.run !== undefined && this.retiredRuns.has(c.run)) {
			this.counters.retiredRun++
			return null
		}
		this.scan.claims++
		const sourceKey = sourceKeyOf(c.sourceId)
		const list = this.open.get(sourceKey)
		// Expire this source's held and over-age entries first: a claim never joins either.
		const idx = this.index.get(sourceKey)
		if (list && idx) this.expireOnClaim(list, idx, at)
		if (c.continues !== undefined) {
			const prev = this.entries.get(c.continues)
			if (
				prev !== undefined &&
				(prev.state === "hang" || prev.state === "open") &&
				prev.sourceKey === sourceKey &&
				prev.kind === c.kind
			)
				return this.join(prev, c)
		}
		if (c.kind === "voice-digital" || c.dvKey !== undefined)
			return this.claimDv(c, sourceKey)
		// An entry matches when one of its active claimants does; only claimants within one
		// match width (the claim's bucket and its neighbours) can.
		const matches = new Set<Entry>()
		const buckets = this.index.get(sourceKey)?.buckets
		if (buckets && finite(c.hz)) {
			const b = bucketOf(c.hz)
			for (let k = b - 1; k <= b + 1; k++) {
				const near = buckets.get(k)
				if (!near) continue
				for (const cl of near) {
					this.scan.matchCandidates++
					const e = cl.entry
					if (matches.has(e)) continue
					if (e.state !== "open") continue
					if (e.kind !== c.kind || e.id === c.splitFrom) continue
					if (!sameChannel(c.hz, c.halfWidthHz, cl.hz, cl.halfWidthHz)) continue
					if (
						c.epoch !== undefined &&
						cl.epoch !== undefined &&
						(c.epoch !== cl.epoch || c.stream !== cl.stream)
					)
						continue
					matches.add(e)
				}
			}
		}
		let newest: Entry | null = null
		for (const m of matches)
			if (
				newest === null ||
				m.startedAtMs > newest.startedAtMs ||
				(m.startedAtMs === newest.startedAtMs && m.seq > newest.seq)
			)
				newest = m
		if (matches.size === 1 && newest !== null) return this.join(newest, c)
		return this.create(c, sourceKey, newest)
	}

	end(claimant: number, atMs: number, reason: TxEndReason = "ended"): void {
		const cl = this.claimants.get(claimant)
		if (cl === undefined) {
			this.counters.lateWrites++
			return
		}
		this.claimants.delete(claimant)
		const e = cl.entry
		e.active.delete(cl)
		this.unindexClaimant(cl)
		if (e.state !== "open") {
			this.counters.lateWrites++
			return
		}
		e.endedAtMs = Math.max(e.endedAtMs ?? atMs, atMs)
		if (e.active.size > 0) return
		if (reason === "max-duration" && cl.origin === "scanner-observation") {
			e.state = "hang"
			e.hangUntilMs = atMs + TX_ROLLOVER_HOLD_MS
			this.index.get(e.sourceKey)?.hanging.add(e)
			return
		}
		const close: TxCloseReason = reason === "stopped" ? "ended" : reason
		this.closeEntry(e, close, atMs, reason === "ended")
	}

	attach(txId: string, alias: TxAlias): boolean {
		const e = this.entries.get(txId)
		const kind = aliasKindOf(alias)
		if (e === undefined || kind === null) return false
		const own = e.aliases[kind]
		if (own.includes(alias)) return true
		const named = this.aliasIndex.get(alias) ?? []
		if (
			own.length >= TX_ALIASES_PER_KIND ||
			named.length >= TX_ALIAS_TX_MAX ||
			this.aliasPairs >= TX_ALIASES_MAX
		) {
			this.counters.aliasOverflow++
			return false
		}
		own.push(alias)
		named.push(txId)
		this.aliasIndex.set(alias, named)
		this.aliasPairs++
		// A bare closed entry that gains an artefact moves to the artefact ring.
		if (kind !== "obs" && this.bareClosed.delete(e.id))
			this.pushClosed(this.artefactClosed, e, TX_CLOSED_MAX)
		return true
	}

	noteLiveTone(claimant: number, tone: TxLiveTone): void {
		const cl = this.claimants.get(claimant)
		if (cl === undefined || cl.entry.state !== "open") {
			this.counters.lateWrites++
			return
		}
		cl.entry.liveTone = {
			ctcssHz: tone.ctcssHz,
			dcs: tone.dcs === null ? null : { ...tone.dcs },
		}
	}

	noteIdentity(claimant: number, identity: TxIdentity): void {
		const cl = this.claimants.get(claimant)
		if (cl === undefined || cl.entry.state !== "open") {
			this.counters.lateWrites++
			return
		}
		cl.entry.identity = { ...identity }
		if (identity.protocol !== null) cl.entry.protocol = identity.protocol
	}

	noteRefusal(ref: string, code: TxRefusalCode): void {
		const e = this.resolve(ref)
		if (e === undefined) return
		if (e.state !== "open" && e.state !== "hang") {
			this.counters.lateWrites++
			return
		}
		e.refusal ??= code
	}

	noteFileWithoutTx(): void {
		this.counters.fileNoTx++
	}

	/** Closes every open or held entry of a source (filter: only those of another epoch). */
	closeSource(
		sourceId: string | null,
		reason: "retune" | "source-lost" | "hop",
		atMs: number = this.now(),
		filter?: { epochNot?: number },
	): number {
		const list = this.open.get(sourceKeyOf(sourceId))
		if (!list) return 0
		let n = 0
		for (const e of [...list]) {
			if (
				filter?.epochNot !== undefined &&
				(e.epoch === undefined || e.epoch === filter.epochNot)
			)
				continue
			this.closeEntry(e, reason, atMs, false)
			n++
		}
		return n
	}

	/** A decoder run ended: its entries close `decoder-restart`, its later claims are refused. */
	retireRun(run: string, atMs: number = this.now()): void {
		this.retiredRuns.add(run)
		if (this.retiredRuns.size > TX_RETIRED_RUNS_MAX) {
			const oldest = this.retiredRuns.values().next()
			if (oldest.done !== true) this.retiredRuns.delete(oldest.value)
		}
		for (const list of this.open.values())
			for (const e of [...list])
				if (e.run === run) this.closeEntry(e, "decoder-restart", atMs, false)
	}

	/** Hang expiry, max duration and ring TTL (the 1 s timer; tests call it directly). */
	sweep(now: number = this.now()): void {
		for (const list of [...this.open.values()])
			for (const e of [...list]) {
				if (e.state === "hang" && now >= e.hangUntilMs)
					this.closeEntry(e, "max-duration", e.hangUntilMs, false)
				else if (now - e.startedAtMs >= TX_MAX_MS)
					this.closeEntry(e, "max-duration", now, false)
			}
		// Ring order is entry order, not close order: a bare entry that gains an artefact joins at
		// the tail with its older close. So skip, never break: ≤ TX_CLOSED_MAX (2 048) compares/s.
		for (const e of [...this.artefactClosed.values()]) {
			if (e.closedAtMs !== null && now - e.closedAtMs < TX_CLOSED_TTL_MS)
				continue
			this.evict(e, this.artefactClosed)
		}
		for (const [key, list] of this.recent) {
			this.pruneRecent(list, now)
			if (list.length === 0) this.recent.delete(key)
		}
	}

	get(id: string, opts: TxReadOptions = {}): TxView | null {
		const e = this.entries.get(id)
		return e === undefined ? null : this.view(e, opts)
	}

	/** The first transmission an alias names that the registry still holds. */
	byAlias(alias: string, opts: TxReadOptions = {}): TxView | null {
		const e = this.resolve(alias)
		return e === undefined ? null : this.view(e, opts)
	}

	/** The group's transmissions the registry still holds, oldest first, at most `max`. */
	groupMembers(groupId: string, max: number): readonly TxView[] {
		const ids = this.groups.get(groupId) ?? []
		const out: TxView[] = []
		for (const id of ids) {
			if (out.length >= max) break
			const e = this.entries.get(id)
			if (e !== undefined) out.push(this.view(e, {}))
		}
		return out
	}

	/** Every transmission an alias names (a file spanning several), oldest first. */
	txIdsOf(alias: string): readonly string[] {
		return [...(this.aliasIndex.get(alias) ?? [])]
	}

	openTxOf(ref: string): string | null {
		const e = this.resolve(ref)
		return e !== undefined && (e.state === "open" || e.state === "hang")
			? e.id
			: null
	}

	// ── internals ──────────────────────────────────────────────────────────

	private resolve(ref: string): Entry | undefined {
		if (TX_ID.test(ref)) return this.entries.get(ref)
		const ids = this.aliasIndex.get(ref)
		if (!ids) return undefined
		for (const id of ids) {
			const e = this.entries.get(id)
			if (e !== undefined) return e
		}
		return undefined
	}

	/**
	 * Closes a source's held entries past their hold and, when its start bound allows one to be,
	 * its over-age entries, in creation order (the order the open list holds them).
	 */
	private expireOnClaim(list: Set<Entry>, idx: SourceIndex, at: number): void {
		let expired: Entry[] | null = null
		for (const e of idx.hanging) {
			this.scan.expiryCandidates++
			if (at >= e.hangUntilMs || at - e.startedAtMs >= TX_MAX_MS)
				(expired ??= []).push(e)
		}
		if (at - idx.startLowMs >= TX_MAX_MS) {
			let low = Number.POSITIVE_INFINITY
			for (const e of list) {
				this.scan.expiryCandidates++
				if (at - e.startedAtMs >= TX_MAX_MS) {
					if (e.state !== "hang") (expired ??= []).push(e)
				} else if (e.startedAtMs < low) low = e.startedAtMs
			}
			idx.startLowMs = low
		}
		if (expired === null) return
		if (expired.length > 1) expired.sort((a, b) => a.seq - b.seq)
		for (const e of expired)
			this.closeEntry(
				e,
				"max-duration",
				e.state === "hang" ? e.hangUntilMs : at,
				false,
			)
	}

	private indexOf(sourceKey: string): SourceIndex {
		let idx = this.index.get(sourceKey)
		if (idx === undefined) {
			idx = {
				buckets: new Map(),
				hanging: new Set(),
				startLowMs: Number.POSITIVE_INFINITY,
			}
			this.index.set(sourceKey, idx)
		}
		return idx
	}

	private unindexClaimant(cl: Claimant): void {
		if (!finite(cl.hz)) return
		const buckets = this.index.get(cl.entry.sourceKey)?.buckets
		const b = bucketOf(cl.hz)
		const set = buckets?.get(b)
		if (set?.delete(cl) === true && set.size === 0) buckets?.delete(b)
	}

	private claimDv(c: TxClaim, sourceKey: string): TxClaimResult | null {
		const laneKey = `${c.dvKey ?? ""}|${c.lane ?? 0}`
		const prev = this.dvLanes.get(laneKey)
		// One open entry per lane: a promotion ends the lane's previous call first.
		if (prev !== undefined && prev.state === "open")
			this.closeEntry(prev, "ended", c.atMs, false)
		const res = this.create(c, sourceKey, null)
		if (res !== null) {
			const e = this.entries.get(res.txId)
			if (e !== undefined) this.dvLanes.set(laneKey, e)
		}
		return res
	}

	private join(e: Entry, c: TxClaim): TxClaimResult {
		e.state = "open"
		e.hangUntilMs = 0
		e.startedAtMs = Math.min(e.startedAtMs, c.atMs)
		const idx = this.indexOf(e.sourceKey)
		idx.hanging.delete(e)
		idx.startLowMs = Math.min(idx.startLowMs, e.startedAtMs)
		const cl = this.addClaimant(e, c)
		this.attach(e.id, c.alias)
		return { txId: e.id, claimant: cl.id }
	}

	private create(
		c: TxClaim,
		sourceKey: string,
		ambiguousWith: Entry | null,
	): TxClaimResult | null {
		const list = this.open.get(sourceKey)
		if (
			(list?.size ?? 0) >= TX_OPEN_PER_SOURCE ||
			this.openTotal >= TX_OPEN_MAX
		) {
			this.counters.refusedCap++
			return null
		}
		const id = newTxId(c.atMs)
		const e: Entry = {
			id,
			seq: this.nextSeq++,
			groupId: this.groupOf(c, sourceKey, ambiguousWith) ?? `g_${id}`,
			kind: c.kind,
			origin: c.origin,
			sourceKey,
			sourceId: c.sourceId,
			hz: finite(c.hz) ? c.hz : null,
			halfWidthHz: finite(c.halfWidthHz) ? c.halfWidthHz : null,
			epoch: c.epoch,
			dvLaneKey:
				c.kind === "voice-digital" || c.dvKey !== undefined
					? `${c.dvKey ?? ""}|${c.lane ?? 0}`
					: null,
			run: c.run ?? null,
			protocol: null,
			state: "open",
			startedAtMs: c.atMs,
			endedAtMs: null,
			closedAtMs: null,
			hangUntilMs: 0,
			close: null,
			complete: false,
			ambiguous: ambiguousWith !== null,
			refusal: null,
			liveTone: null,
			identity: null,
			active: new Set(),
			aliases: { rec: [], evt: [], obs: [], call: [] },
		}
		if (e.ambiguous) this.counters.ambiguous++
		this.entries.set(id, e)
		const members = this.groups.get(e.groupId) ?? []
		members.push(id)
		this.groups.set(e.groupId, members)
		const set = list ?? new Set<Entry>()
		set.add(e)
		this.open.set(sourceKey, set)
		this.openTotal++
		const idx = this.indexOf(sourceKey)
		idx.startLowMs = Math.min(idx.startLowMs, e.startedAtMs)
		const cl = this.addClaimant(e, c)
		this.attach(id, c.alias)
		return { txId: id, claimant: cl.id }
	}

	private addClaimant(e: Entry, c: TxClaim): Claimant {
		const cl: Claimant = {
			id: this.nextClaimant++,
			entry: e,
			origin: c.origin,
			hz: c.hz,
			halfWidthHz: c.halfWidthHz,
			epoch: c.epoch,
			stream: c.stream,
		}
		e.active.add(cl)
		this.claimants.set(cl.id, cl)
		if (finite(cl.hz)) {
			const buckets = this.indexOf(e.sourceKey).buckets
			const b = bucketOf(cl.hz)
			const set = buckets.get(b) ?? new Set<Claimant>()
			set.add(cl)
			buckets.set(b, set)
		}
		return cl
	}

	private groupOf(
		c: TxClaim,
		sourceKey: string,
		ambiguousWith: Entry | null,
	): string | null {
		const linked = c.splitFrom ?? c.continues
		if (linked !== undefined) {
			const e = this.entries.get(linked)
			if (e !== undefined) return e.groupId
		}
		if (ambiguousWith !== null) return ambiguousWith.groupId
		const list = this.recent.get(sourceKey)
		if (!list) return null
		this.pruneRecent(list, c.atMs)
		const laneKey =
			c.kind === "voice-digital" || c.dvKey !== undefined
				? `${c.dvKey ?? ""}|${c.lane ?? 0}`
				: null
		for (let i = list.length - 1; i >= 0; i--) {
			const e = list[i]!
			if (e.state === "evicted" || e.kind !== c.kind) continue
			const age = c.atMs - (e.closedAtMs ?? c.atMs)
			if (
				age > TX_GROUP_GAP_MS &&
				!(e.close === "hop" && age <= TX_HOP_GROUP_MS)
			)
				continue
			const channel =
				laneKey !== null
					? e.dvLaneKey === laneKey
					: sameChannel(
							c.hz,
							c.halfWidthHz,
							e.hz ?? undefined,
							e.halfWidthHz ?? undefined,
						)
			if (channel) return e.groupId
		}
		return null
	}

	private pruneRecent(list: Entry[], now: number): void {
		let drop = 0
		while (
			drop < list.length &&
			(list[drop]!.state === "evicted" ||
				now - (list[drop]!.closedAtMs ?? now) > TX_HOP_GROUP_MS)
		)
			drop++
		if (drop > 0) list.splice(0, drop)
	}

	private closeEntry(
		e: Entry,
		reason: TxCloseReason,
		atMs: number,
		complete: boolean,
	): void {
		if (e.state !== "open" && e.state !== "hang") return
		for (const cl of e.active) {
			this.claimants.delete(cl.id)
			this.unindexClaimant(cl)
		}
		this.index.get(e.sourceKey)?.hanging.delete(e)
		const wasActive = e.active.size > 0
		e.active.clear()
		e.state = "closed"
		e.close = reason
		e.complete = complete && reason === "ended" && !wasActive
		e.closedAtMs = atMs
		e.endedAtMs ??= atMs
		const list = this.open.get(e.sourceKey)
		if (list?.delete(e) === true) {
			this.openTotal--
			if (list.size === 0) {
				this.open.delete(e.sourceKey)
				this.index.delete(e.sourceKey)
			}
		}
		if (e.dvLaneKey !== null && this.dvLanes.get(e.dvLaneKey) === e)
			this.dvLanes.delete(e.dvLaneKey)
		const recent = this.recent.get(e.sourceKey) ?? []
		recent.push(e)
		if (recent.length > TX_RECENT_PER_SOURCE) recent.shift()
		this.recent.set(e.sourceKey, recent)
		const artefact =
			e.refusal !== null ||
			e.aliases.rec.length > 0 ||
			e.aliases.evt.length > 0 ||
			e.aliases.call.length > 0
		if (artefact) this.pushClosed(this.artefactClosed, e, TX_CLOSED_MAX)
		else this.pushClosed(this.bareClosed, e, TX_BARE_CLOSED_MAX)
	}

	private pushClosed(ring: Map<string, Entry>, e: Entry, max: number): void {
		ring.set(e.id, e)
		while (ring.size > max) {
			const oldest = ring.values().next()
			if (oldest.done === true) break
			this.evict(oldest.value, ring)
		}
	}

	private evict(e: Entry, ring: Map<string, Entry>): void {
		ring.delete(e.id)
		this.entries.delete(e.id)
		const members = this.groups.get(e.groupId)
		if (members) {
			const at = members.indexOf(e.id)
			if (at >= 0) members.splice(at, 1)
			if (members.length === 0) this.groups.delete(e.groupId)
		}
		e.state = "evicted"
		this.counters.evicted++
		for (const kind of ALIAS_KINDS)
			for (const alias of e.aliases[kind]) {
				const named = this.aliasIndex.get(alias)
				if (!named) continue
				const at = named.indexOf(e.id)
				if (at >= 0) {
					named.splice(at, 1)
					this.aliasPairs--
				}
				if (named.length === 0) this.aliasIndex.delete(alias)
			}
	}

	private view(e: Entry, opts: TxReadOptions): TxView {
		const recorderTones = opts.recorderTones ?? []
		const refusal = e.refusal
		return {
			id: e.id,
			groupId: e.groupId,
			kind: e.kind,
			origin: e.origin,
			protocol: e.protocol,
			sourceId: e.sourceId,
			hz: e.hz,
			state: e.state === "evicted" ? "closed" : e.state,
			startedAtMs: e.startedAtMs,
			endedAtMs: e.endedAtMs,
			closedAtMs: e.closedAtMs,
			close: e.close,
			complete: e.complete,
			ambiguous: e.ambiguous,
			refusal,
			liveTone:
				e.liveTone === null
					? null
					: {
							ctcssHz: e.liveTone.ctcssHz,
							dcs: e.liveTone.dcs === null ? null : { ...e.liveTone.dcs },
						},
			identity: e.identity === null ? null : { ...e.identity },
			aliases: {
				rec: [...e.aliases.rec],
				evt: [...e.aliases.evt],
				obs: [...e.aliases.obs],
				call: [...e.aliases.call],
			},
			noAudioReason: e.aliases.rec.length > 0 ? null : refusal,
			tone: deriveTone(e.liveTone, recorderTones),
		}
	}
}
