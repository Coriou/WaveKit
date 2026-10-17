/**
 * Random store steps for the WG11 lane SC index and counts properties (not a test file): ingest
 * (dense, so sticky and key merges happen), re-ingest with joined jobs and moved centres, retract,
 * evidence (identity confirms, co-channel twins, caps), classification (cap downgrades), operator,
 * delete, rekey, prune, capacity eviction, many jobs (the 64-entry job list trims) and a restore
 * plus journal replay into a fresh store. Linear oracles read the store's own maps.
 */
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Discovery,
	Observation,
	ObservationInput,
	ProtocolFamily,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const BASE = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: BASE }]
const T0 = Date.UTC(2026, 9, 17, 8, 0, 0)
const PROTOS: ScannerProtocol[] = [
	"dmr",
	"analog-fm",
	"unknown",
	"nxdn96",
	"digital-unknown",
]
export const SOURCES = ["src-1", "src-2", "src-3"]

export function mulberry(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

export interface Ctx {
	store: DiscoveryStore
	rand: () => number
	clock: number
	inputs: ObservationInput[]
	journal: JournalEntry[]
	checkpoint: { snap: StoreSnapshot; seq: number } | null
	jobs: Set<string>
	make: () => DiscoveryStore
	/** Wide job pool: some discoveries carry more than 64 job ids (the list trims). */
	wideJobs: boolean
}

export function newCtx(seed: number, wideJobs = false): Ctx {
	const ids = counterIds()
	const ctx: Ctx = {
		store: undefined as unknown as DiscoveryStore,
		rand: mulberry(seed),
		clock: T0,
		inputs: [],
		journal: [],
		checkpoint: null,
		jobs: new Set(),
		wideJobs,
		make: () => {
			const s = new DiscoveryStore({
				maxDiscoveries: 24,
				now: () => ctx.clock,
				newId: ids,
				rasters: sourceId => (sourceId === "src-2" ? [] : PMR),
			})
			s.on("mutation", (e: Omit<JournalEntry, "seq">) =>
				ctx.journal.push(
					JSON.parse(
						JSON.stringify({ seq: ctx.journal.length + 1, ...e }),
					) as JournalEntry,
				),
			)
			return s
		},
	}
	ctx.store = ctx.make()
	return ctx
}

const classOf = (p: ScannerProtocol) =>
	p === "dmr" || p === "nxdn96"
		? ("fsk4-12k5" as const)
		: p === "analog-fm"
			? ("analog-fm" as const)
			: p === "digital-unknown"
				? ("fsk4-6k25" as const)
				: ("unknown" as const)

function ids(store: DiscoveryStore): string[] {
	return store
		.list({ limit: 500 })
		.items.map(d => d.id)
		.sort()
}

/** One random step. */
export function step(ctx: Ctx): void {
	const r = ctx.rand
	const int = (n: number): number => Math.floor(r() * n)
	const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T
	const store = ctx.store
	ctx.clock += 200 + int(3_000)
	const roll = int(100)
	if (roll < 50) {
		const proto = pick(PROTOS)
		const jobs = ctx.wideJobs
			? Array.from({ length: 1 + int(30) }, () => `job-${int(90)}`)
			: [`job-${int(4)}`]
		for (const j of jobs) ctx.jobs.add(j)
		const obs = makeObs({
			id: `o${ctx.inputs.length}`,
			centreHz: BASE + int(6) * 6_250 + int(3_000) - 1_500,
			startedAt: ctx.clock,
			blocks: 1 + int(4),
			cls: classOf(proto),
			hypotheses: proto === "unknown" ? [] : [[proto, 0.8]],
			...(r() < 0.1 ? { cap: "adjacent-leak" as const } : {}),
			tier: r() < 0.5 ? "channel" : "spectral",
			sweep: r() < 0.5,
			jobIds: jobs,
			sourceId: r() < 0.6 ? "src-1" : pick(SOURCES),
			obwHz: 6_000 + int(6_000),
			truncated: r() < 0.03,
		})
		ctx.inputs.push(obs)
		store.ingest(obs)
	} else if (roll < 60 && ctx.inputs.length > 0) {
		const prev = pick(ctx.inputs)
		const job = `job-${int(6)}`
		ctx.jobs.add(job)
		store.ingest({
			...prev,
			jobIds: r() < 0.5 ? [...prev.jobIds, job] : prev.jobIds,
			endedAt: prev.startedAt + 2_000,
			track: {
				...prev.track,
				centreHz: prev.track.centreHz + int(4_000) - 2_000,
				flags: { ...prev.track.flags, truncated: r() < 0.05 },
			},
		})
	} else if (roll < 70) {
		const all = ids(store)
		if (all.length === 0) return
		const proto = pick(["dmr", "nxdn96"] as ScannerProtocol[])
		store.applyEvidence(
			pick(all),
			evidence(proto, ctx.clock, {
				...(r() < 0.7
					? {
							identity:
								proto === "dmr"
									? dmrCc(1 + int(3))
									: { kind: "nxdn-ran" as const, value: String(int(3)) },
						}
					: {}),
				talkgroups: [String(int(9))],
			}),
			r() < 0.3 ? { cap: "suspected-intermod" } : {},
		)
	} else if (roll < 80) {
		const all = ids(store)
		if (all.length === 0) return
		const proto = pick(PROTOS)
		store.applyClassification(
			pick(all),
			classification(
				classOf(proto),
				proto === "unknown" ? [] : [[proto, 0.8]],
				r() < 0.4 ? "adjacent-leak" : undefined,
				r() < 0.6 ? "channel" : "spectral",
			),
		)
	} else if (roll < 84) {
		const all = ids(store)
		if (all.length > 0) store.delete(pick(all))
	} else if (roll < 87) {
		store.rekey(pick(SOURCES), int(4_000) - 2_000)
	} else if (roll < 89) {
		ctx.clock += 3 * 86_400_000
		store.pruneInactive(2)
	} else if (roll < 92) {
		store.setLimits({ maxDiscoveries: 4 + int(24), minSurfaceBlocks: 2 })
	} else if (roll < 94) {
		const all = ids(store)
		if (all.length > 0) store.setOperator(pick(all), { keep: r() < 0.5 })
	} else if (roll < 98) {
		if (ctx.checkpoint === null)
			ctx.checkpoint = { snap: store.snapshot(), seq: ctx.journal.length }
		else {
			const fresh = ctx.make()
			fresh.restore(ctx.checkpoint.snap)
			for (const e of ctx.journal)
				if (e.seq > ctx.checkpoint.seq) fresh.replay(e)
			ctx.store = fresh
			ctx.checkpoint = null
		}
	} else {
		// a fresh store restored from the current snapshot only
		const fresh = ctx.make()
		fresh.restore(store.snapshot())
		ctx.store = fresh
		ctx.checkpoint = null
	}
}

// ── linear oracles over the store's own maps (today's code, fresh medians) ──

interface Internals {
	discoveries: Map<string, Discovery>
	byDiscovery: Map<string, Observation[]>
	bySource: Map<string, Set<string>>
	toleranceHz(sourceId: string, centreHz: number, obwHz: number): number
	stickyMatch(
		obs: ObservationInput,
		family: ProtocolFamily,
	): Discovery | undefined
	atKey(sourceId: string, key: string): Discovery[]
}

export const internals = (s: DiscoveryStore): Internals =>
	s as unknown as Internals

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	const upper = sorted[mid] ?? 0
	return sorted.length % 2 === 1
		? upper
		: ((sorted[mid - 1] ?? upper) + upper) / 2
}

export function freshMedian(s: DiscoveryStore, d: Discovery): number {
	const recent = (internals(s).byDiscovery.get(d.id) ?? []).slice(-64)
	return recent.length > 0
		? median(recent.map(o => o.centerHz))
		: d.frequencyHz + d.measuredOffsetHz
}

export function linearSticky(
	s: DiscoveryStore,
	obs: ObservationInput,
	family: ProtocolFamily,
): Discovery | undefined {
	const i = internals(s)
	const set = i.bySource.get(obs.sourceId)
	if (set === undefined) return undefined
	const tol = i.toleranceHz(obs.sourceId, obs.track.centreHz, obs.track.obwHz)
	let best: Discovery | undefined
	let bestDist = Number.POSITIVE_INFINITY
	for (const id of set) {
		const d = i.discoveries.get(id)
		if (d === undefined || d.family !== family) continue
		const dist = Math.abs(freshMedian(s, d) - obs.track.centreHz)
		if (dist > tol) continue
		if (
			best === undefined ||
			dist < bestDist ||
			(dist === bestDist &&
				(d.lastSeenAt > best.lastSeenAt ||
					(d.lastSeenAt === best.lastSeenAt && d.id < best.id)))
		) {
			best = d
			bestDist = dist
		}
	}
	return best
}

export function linearAtKey(
	s: DiscoveryStore,
	sourceId: string,
	key: string,
): string[] {
	const i = internals(s)
	const out: Discovery[] = []
	for (const id of i.bySource.get(sourceId) ?? []) {
		const d = i.discoveries.get(id)
		if (d !== undefined && d.frequencyKey === key) out.push(d)
	}
	return out
		.sort((a, b) =>
			a.lastSeenAt !== b.lastSeenAt
				? a.lastSeenAt < b.lastSeenAt
					? 1
					: -1
				: a.id < b.id
					? -1
					: 1,
		)
		.map(d => d.id)
}

/** Today's `discoveryCounts`: page `list({ jobId })` and count by confidence. */
export function recount(
	s: DiscoveryStore,
	jobId: string,
): Record<ScannerConfidence, number> {
	const counts = { activity: 0, candidate: 0, classified: 0, decoded: 0 }
	let cursor: string | null = null
	do {
		const page = s.list({ jobId, limit: 500, cursor })
		for (const d of page.items) counts[d.confidence] += 1
		cursor = page.nextCursor
	} while (cursor)
	return counts
}

export function probe(ctx: Ctx, n: number): ObservationInput {
	const r = ctx.rand
	return makeObs({
		id: `probe-${n}`,
		centreHz:
			BASE + Math.floor(r() * 6) * 6_250 + Math.floor(r() * 5_000) - 2_500,
		startedAt: ctx.clock,
		obwHz: 6_000 + Math.floor(r() * 6_000),
		sourceId: SOURCES[Math.floor(r() * SOURCES.length)] ?? "src-1",
	})
}

export const FAMILIES: ProtocolFamily[] = [
	"digital-voice",
	"analog",
	"unknown",
	"carrier",
]
