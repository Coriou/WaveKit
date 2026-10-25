/**
 * Scanner (signal discovery) data: discoveries, jobs, status and band plans from the core's
 * /api/scanner routes, kept live from the `scanner` channel (scanner:job, scanner:progress,
 * scanner:discovery, scanner:activity, scanner:status). Live events are coalesced into one
 * snapshot per animation frame; sweep progress (2 Hz) lives in its own small store so the
 * band strip can re-render without the discoveries list.
 *
 * load() (status, jobs, band plans) runs at start; the discoveries list loads on the first
 * refreshDiscoveries(). A reconnect refetches what was loaded (the core replays nothing).
 */
import type {
	Bandplan,
	Discovery,
	HopPlan,
	Impact,
	PlanIssue,
	PlanPreview,
	ScanJob,
	ScanJobHit,
	ScanJobHitStats,
	ScanJobHitsResponse,
	ScanJobSpec,
	ScannerActivityEventData,
	ScannerConfidence,
	ScannerDiscoveryEventData,
	ScannerProgressEventData,
	ScannerProtocol,
	ScannerStatus,
} from "@wavekit/api-types"
import type { ApiClient, QueryValue } from "./api-client.ts"
import { WriteOrder } from "./write-order.ts"
import { errorMessage, isApiError } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { confidenceRank, isJobActive } from "./scanner-format.ts"
import { Store } from "./store.ts"

// ---- types

export type DiscoverySort = "lastSeen" | "frequency" | "confidence"

/** GET /api/scanner/discoveries query (src/api/routes/scanner-schemas.ts discoveryQuerySchema). */
export interface DiscoveryQuery {
	/** Matches the operator label or the identity value (case-insensitive substring). */
	q?: string
	/** `kind:value`, e.g. "dmr-cc:1" (see identityQuery()). */
	identity?: string
	protocol?: ScannerProtocol
	minConfidence?: ScannerConfidence
	freqMinHz?: number
	freqMaxHz?: number
	/** Default lastSeen (newest first). */
	sort?: DiscoverySort
	/** Page size, 1–500 (core default 100). */
	limit?: number
	jobId?: string
	sourceId?: string
	encrypted?: boolean
	/** ISO date-time: last seen at or after. */
	since?: string
	/** WG12: `proven` (has a proof), `weak` (none) or `all`; absent means all. Older cores refuse it. */
	evidence?: "proven" | "weak" | "all"
}

/** The answer of GET /api/scanner/discoveries. */
export interface DiscoveryPage {
	items: Discovery[]
	nextCursor: string | null
}

/** POST /api/scanner/discoveries/:id/listen (core src/core/scanner/listen.ts ListenResult). */
export interface ScannerListenResult {
	mode: "live-audio" | "monitor"
	sourceId: string
	frequencyHz: number
	offsetHz?: number
	jobId?: string
	httpUrl: string
	wavUrl: string
}

/** PATCH /api/scanner/jobs/:id answer. */
export interface PatchJobResult {
	job: ScanJob
	plan: HopPlan
	issues: PlanIssue[]
}

/** Operator fields of PATCH /api/scanner/discoveries/:id (at least one). */
export interface DiscoveryOperatorPatch {
	label?: string
	notes?: string
	lockout?: boolean
	keep?: boolean
}

export interface ScannerDiscoveriesState {
	/** The loaded pages matching `query`, in its sort order, kept live. */
	items: readonly Discovery[]
	/** Every discovery this store has seen (pages, events, patches), by id, filter or not. */
	byId: ReadonlyMap<string, Discovery>
	query: DiscoveryQuery
	nextCursor: string | null
	/** True once a first page arrived (stays true across refreshes). */
	loaded: boolean
	/** A first page (refresh) is in flight. */
	loading: boolean
	loadingMore: boolean
	error: string | null
	/** False once the core refused the `evidence` filter (a core before WG12): the list asks without it. */
	evidenceSupported: boolean
	/**
	 * Bumped when the core says what is loaded may be stale (a truncated merge, `scanner:discoveries-resync`):
	 * span fetches (the spectrum's tags) ask again.
	 */
	epoch: number
}

export interface ScannerState {
	discoveries: ScannerDiscoveriesState
	/** Active observations by observationId (scanner:activity active=true, dropped after ~10 s quiet). */
	activity: ReadonlyMap<string, ScannerActivityEventData>
	/** Discovery ids with an active observation now. */
	activeNow: ReadonlySet<string>
	jobs: ReadonlyMap<string, ScanJob>
	jobsLoaded: boolean
	jobsError: string | null
	/** The operator's live (pending … paused) non-passive, non-identify job, most recent. */
	sweep: ScanJob | null
	/** The live passive job (most recent), else the most recent passive job. */
	passive: ScanJob | null
	/** The last operator sweep job seen, ended or not (its hits stay for the hit log). */
	lastSweepId: string | null
	/** Hits by job id then discovery id: live jobs and the last sweep only. */
	jobHits: ReadonlyMap<string, ReadonlyMap<string, ScanJobHit>>
	/** From getJobHits(). */
	jobHitStats: ReadonlyMap<string, ScanJobHitStats>
	status: ScannerStatus | null
	statusError: string | null
	/** The core's code of the status error: SCANNER_DISABLED, NOT_FOUND (no scanner on this core)… */
	statusErrorCode: string | null
	bandplans: readonly Bandplan[] | null
	bandplansError: string | null
}

export interface ScannerStoreOptions {
	/** Animation-frame scheduler; default requestAnimationFrame (16 ms timer without one). */
	frame?: {
		request: (cb: () => void) => unknown
		cancel: (handle: unknown) => void
	}
	/** Clock for the activity staleness check. Default Date.now. */
	now?: () => number
	/** An active observation with no update for this long is dropped. Default 10 000. */
	activityStaleMs?: number
}

// ---- pure helpers

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/** The core's discovery order for `sort` (discovery-store.ts list()). */
export function discoveryComparator(
	sort: DiscoverySort = "lastSeen",
): (a: Discovery, b: Discovery) => number {
	const byLastSeen = (a: Discovery, b: Discovery): number =>
		compareText(b.lastSeenAt, a.lastSeenAt) || compareText(a.id, b.id)
	if (sort === "frequency")
		return (a, b) => a.frequencyHz - b.frequencyHz || compareText(a.id, b.id)
	if (sort === "confidence")
		return (a, b) =>
			confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
			byLastSeen(a, b)
	return byLastSeen
}

/** Whether a discovery belongs to a query's result (the core's filter, client side). */
export function matchesDiscoveryQuery(
	d: Discovery,
	query: DiscoveryQuery,
): boolean {
	if (query.jobId !== undefined && !d.jobIds.includes(query.jobId)) return false
	if (query.sourceId !== undefined && !d.sourceIds.includes(query.sourceId))
		return false
	if (query.protocol !== undefined && d.protocol !== query.protocol)
		return false
	if (
		query.minConfidence !== undefined &&
		confidenceRank(d.confidence) < confidenceRank(query.minConfidence)
	)
		return false
	if (query.freqMinHz !== undefined && d.frequencyHz < query.freqMinHz)
		return false
	if (query.freqMaxHz !== undefined && d.frequencyHz > query.freqMaxHz)
		return false
	if (
		query.since !== undefined &&
		Date.parse(d.lastSeenAt) < Date.parse(query.since)
	)
		return false
	if (query.encrypted !== undefined && d.encrypted !== query.encrypted)
		return false
	// a discovery without `evidenceLevel` comes from an older core: it matches either way
	if (
		(query.evidence === "proven" && d.evidenceLevel === "weak") ||
		(query.evidence === "weak" && d.evidenceLevel === "proven")
	)
		return false
	if (query.identity !== undefined) {
		const colon = query.identity.indexOf(":")
		const kind = colon < 0 ? "" : query.identity.slice(0, colon)
		const value = query.identity
			.slice(colon + 1)
			.trim()
			.toLowerCase()
		if (
			d.identity?.kind !== kind ||
			d.identity.value.trim().toLowerCase() !== value
		)
			return false
	}
	if (query.q !== undefined) {
		const q = query.q.toLowerCase()
		if (
			!(d.operator?.label ?? "").toLowerCase().includes(q) &&
			!(d.identity?.value ?? "").toLowerCase().includes(q)
		)
			return false
	}
	return true
}

/**
 * The discoveries a `merged` survivor most likely absorbed: the core merges discoveries with the
 * same first source, frequency key, family and identity, and its event names only the survivor.
 */
export function absorbedBy(
	survivor: Discovery,
	candidates: Iterable<Discovery>,
): string[] {
	const out: string[] = []
	for (const d of candidates)
		if (
			d.id !== survivor.id &&
			d.frequencyKey === survivor.frequencyKey &&
			d.family === survivor.family &&
			(d.sourceIds[0] ?? "") === (survivor.sourceIds[0] ?? "") &&
			(d.identity === undefined ||
				(d.identity.kind === survivor.identity?.kind &&
					d.identity.value === survivor.identity.value))
		)
			out.push(d.id)
	return out
}

/** The 409 SCANNER_TAKEOVER_REQUIRED impact (who the sweep would disturb), else null. */
export function takeoverImpact(error: unknown): Impact | null {
	if (!isApiError(error) || error.code !== "SCANNER_TAKEOVER_REQUIRED")
		return null
	const body = error.body as { details?: { impact?: unknown } } | null
	const impact = body?.details?.impact
	return typeof impact === "object" && impact !== null
		? (impact as Impact)
		: null
}

/** The plan issues of a 400 SCANNER_PLAN_INVALID, else []. */
export function planIssues(error: unknown): PlanIssue[] {
	if (!isApiError(error) || error.code !== "SCANNER_PLAN_INVALID") return []
	const body = error.body as { details?: { issues?: unknown } } | null
	const issues = body?.details?.issues
	return Array.isArray(issues) ? (issues as PlanIssue[]) : []
}

function isOperatorJob(job: ScanJob): boolean {
	return !job.passive && job.spec.kind !== "identify"
}

function newest(a: ScanJob | null, b: ScanJob): ScanJob {
	if (!a) return b
	return compareText(b.createdAt, a.createdAt) > 0 ||
		(b.createdAt === a.createdAt && b.id > a.id)
		? b
		: a
}

/** `sweep` and `passive` of a job set (see ScannerState). */
export function deriveJobs(jobs: Iterable<ScanJob>): {
	sweep: ScanJob | null
	passive: ScanJob | null
} {
	let sweep: ScanJob | null = null
	let livePassive: ScanJob | null = null
	let anyPassive: ScanJob | null = null
	for (const job of jobs) {
		const live = isJobActive(job.state)
		if (isOperatorJob(job)) {
			if (live) sweep = newest(sweep, job)
		} else if (job.passive) {
			anyPassive = newest(anyPassive, job)
			if (live) livePassive = newest(livePassive, job)
		}
	}
	return { sweep, passive: livePassive ?? anyPassive }
}

/** A progress event made from a job's own progress (before the first scanner:progress). */
export function progressOfJob(job: ScanJob): ScannerProgressEventData {
	const p = job.progress
	const centre = job.plan.hops[p.hopIndex]?.centreHz ?? 0
	const out: ScannerProgressEventData = {
		jobId: job.id,
		state: job.state,
		sweepIndex: p.sweepIndex,
		hopIndex: p.hopIndex,
		hopCount: p.hopCount,
		centerHz: centre,
		coverage: p.coverage,
		probes: p.probes.length,
	}
	if (p.holdingOn) out.holdingOn = p.holdingOn
	// WG12: what the scan is doing
	if (p.phase !== undefined) out.phase = p.phase
	if (p.parked !== undefined) out.parked = p.parked
	if (p.holding !== undefined) out.holding = p.holding
	if (p.trial !== undefined) out.trial = p.trial
	if (p.replayQueueDepth !== undefined)
		out.replayQueueDepth = p.replayQueueDepth
	if (p.hitStats) {
		out.hits = p.hitStats.hits
		out.newDiscoveries = p.hitStats.newDiscoveries
	}
	return out
}

function queryParams(
	query: DiscoveryQuery,
	cursor?: string,
): Record<string, QueryValue> {
	const params: Record<string, QueryValue> = { ...query }
	if (cursor !== undefined) params["cursor"] = cursor
	return params
}

const encode = encodeURIComponent

const INITIAL_DISCOVERIES: ScannerDiscoveriesState = {
	items: [],
	byId: new Map(),
	query: {},
	nextCursor: null,
	loaded: false,
	loading: false,
	loadingMore: false,
	error: null,
	evidenceSupported: true,
	epoch: 0,
}

const INITIAL: ScannerState = {
	discoveries: INITIAL_DISCOVERIES,
	activity: new Map(),
	activeNow: new Set(),
	jobs: new Map(),
	jobsLoaded: false,
	jobsError: null,
	sweep: null,
	passive: null,
	lastSweepId: null,
	jobHits: new Map(),
	jobHitStats: new Map(),
	status: null,
	statusError: null,
	statusErrorCode: null,
	bandplans: null,
	bandplansError: null,
}

function defaultFrame(): NonNullable<ScannerStoreOptions["frame"]> {
	const scope = globalThis as {
		requestAnimationFrame?: (cb: () => void) => number
		cancelAnimationFrame?: (handle: number) => void
	}
	const raf = scope.requestAnimationFrame
	const caf = scope.cancelAnimationFrame
	if (typeof raf === "function" && typeof caf === "function")
		return {
			request: cb => raf.call(scope, cb),
			cancel: h => caf.call(scope, h as number),
		}
	return {
		request: cb => setTimeout(cb, 16),
		cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
	}
}

// ---- the store

export class ScannerStore extends Store<ScannerState> {
	/** Latest progress of the sweep job (null without one); coalesced to one update per frame. */
	readonly progress = new Store<ScannerProgressEventData | null>(null)

	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	private readonly frame: NonNullable<ScannerStoreOptions["frame"]>
	private readonly now: () => number
	private readonly staleMs: number
	/** Live changes not yet published (applied on the next frame). */
	private draft: ScannerState | null = null
	private frameHandle: unknown = null
	private frameScheduled = false
	/** Latest scanner:progress per job. */
	private readonly progressByJob = new Map<string, ScannerProgressEventData>()
	/** Last update time per active observation. */
	private readonly activitySeen = new Map<string, number>()
	private staleTimer: ReturnType<typeof setTimeout> | null = null
	private discoveryGeneration = 0
	/**
	 * Write order of `byId`: a live event writes at the next sequence, a response at its request's
	 * start; every write goes through applyWrites(), which applies it only when it is newer than
	 * what that id last saw (see write-order.ts).
	 */
	private readonly order = new WriteOrder<Discovery>()
	private discoveryAbort: AbortController | null = null
	private loading: Promise<void> | null = null
	private bandplansLoading: Promise<void> | null = null
	private loadedOnce = false
	private disposed = false

	constructor(
		api: ApiClient,
		events: EventsClient,
		options: ScannerStoreOptions = {},
	) {
		super(INITIAL)
		this.api = api
		this.frame = options.frame ?? defaultFrame()
		this.now = options.now ?? (() => Date.now())
		this.staleMs = options.activityStaleMs ?? 10_000
		this.cleanup = [
			events.subscribe(["scanner"]),
			events.on("scanner:job", job => this.live(s => this.withJob(s, job))),
			events.on("scanner:progress", p => this.onProgress(p)),
			events.on("scanner:discovery", d => {
				this.live(s => this.withDiscoveryEvent(s, d))
				// band inspection UX req 3.2: mergedIds was cut at 64, so some absorbed ids are unknown here
				if (d.mergedTruncated === true)
					this.resyncDiscoveries(d.change === "deleted" ? null : d.discovery.id)
			}),
			events.on("scanner:discoveries-resync", () =>
				this.resyncDiscoveries(null),
			),
			events.on("scanner:activity", a => this.onActivity(a)),
			events.on("scanner:status", status =>
				this.live(s => ({
					...s,
					status,
					statusError: null,
					statusErrorCode: null,
				})),
			),
			events.onReconnected(() => void this.resync()),
		]
	}

	/** The snapshot including changes waiting for the next frame. */
	private current(): ScannerState {
		return this.draft ?? this.get()
	}

	// ---- loading

	/** Status, jobs and band plans. Never rejects (failures land in the *Error fields). */
	load(): Promise<void> {
		this.loading ??= Promise.all([
			this.loadStatus(),
			this.loadJobs(),
			this.loadBandplans(),
		])
			.then(() => {
				this.loadedOnce = true
			})
			.finally(() => {
				this.loading = null
			})
		return this.loading
	}

	/** GET /api/scanner. Never rejects. */
	async loadStatus(): Promise<void> {
		try {
			const status = await this.api.get<ScannerStatus>("/api/scanner")
			this.commit(s => ({
				...s,
				status,
				statusError: null,
				statusErrorCode: null,
			}))
		} catch (error) {
			this.commit(s => ({
				...s,
				statusError: errorMessage(error),
				statusErrorCode: isApiError(error)
					? (error.code ?? (error.status === 404 ? "NOT_FOUND" : null))
					: null,
			}))
		}
	}

	/** GET /api/scanner/jobs (replaces the job set). Never rejects. */
	async loadJobs(): Promise<void> {
		try {
			const list = await this.api.get<ScanJob[]>("/api/scanner/jobs")
			this.commit(s => {
				const jobs = new Map(list.map(j => [j.id, j] as const))
				return this.derive({ ...s, jobs, jobsLoaded: true, jobsError: null })
			})
		} catch (error) {
			this.commit(s => ({ ...s, jobsError: errorMessage(error) }))
		}
	}

	/** GET /api/scanner/bandplans, once (a failure may be retried). Never rejects. */
	loadBandplans(): Promise<void> {
		if (this.current().bandplans !== null) return Promise.resolve()
		this.bandplansLoading ??= this.api
			.get<Bandplan[]>("/api/scanner/bandplans")
			.then(
				bandplans =>
					this.commit(s => ({ ...s, bandplans, bandplansError: null })),
				(error: unknown) =>
					this.commit(s => ({ ...s, bandplansError: errorMessage(error) })),
			)
			.finally(() => {
				this.bandplansLoading = null
			})
		return this.bandplansLoading
	}

	/**
	 * Loads the first page for `query` (default: the current query), replacing the list. A newer
	 * call aborts an older one. Never rejects; a failure lands in `discoveries.error`.
	 */
	refreshDiscoveries(query?: DiscoveryQuery, keepCount = 0): Promise<void> {
		const q = query ?? this.current().discoveries.query
		const generation = ++this.discoveryGeneration
		const started = this.requestStart()
		this.discoveryAbort?.abort()
		const abort = new AbortController()
		this.discoveryAbort = abort
		this.commit(s => ({
			...s,
			discoveries: {
				...s.discoveries,
				query: q,
				loading: true,
				loadingMore: false,
				error: null,
			},
		}))
		const params = queryParams(q)
		if (keepCount > (q.limit ?? 100)) params["limit"] = Math.min(500, keepCount)
		return this.api
			.get<DiscoveryPage>("/api/scanner/discoveries", {
				query: params,
				signal: abort.signal,
			})
			.then(
				page => {
					if (generation !== this.discoveryGeneration) return
					this.commit(s => {
						const byId = this.reconcile(s.discoveries.byId, q, page, started)
						// the page's order, with what is newer than the page in its place
						const items = page.items.flatMap(d => {
							const have = byId.get(d.id)
							return have ? [have] : []
						})
						return {
							...s,
							discoveries: {
								...s.discoveries,
								items,
								byId,
								nextCursor: page.nextCursor,
								loaded: true,
								loading: false,
								error: null,
							},
						}
					})
				},
				(error: unknown) => {
					if (generation !== this.discoveryGeneration) return
					if (
						q.evidence !== undefined &&
						isApiError(error) &&
						error.status === 400
					) {
						// a core before WG12: ask again without the filter, and stop asking
						const { evidence: _, ...older } = q
						this.commit(s => ({
							...s,
							discoveries: { ...s.discoveries, evidenceSupported: false },
						}))
						void this.refreshDiscoveries(older, keepCount)
						return
					}
					this.commit(s => ({
						...s,
						discoveries: {
							...s.discoveries,
							loading: false,
							error: errorMessage(error),
						},
					}))
				},
			)
			.finally(() => {
				if (this.discoveryAbort === abort) this.discoveryAbort = null
			})
	}

	/** The next page of the current query (no-op without one or while loading). Never rejects. */
	async loadMore(): Promise<void> {
		const d = this.current().discoveries
		if (d.nextCursor === null || d.loading || d.loadingMore) return
		const generation = this.discoveryGeneration
		const cursor = d.nextCursor
		const started = this.requestStart()
		this.commit(s => ({
			...s,
			discoveries: { ...s.discoveries, loadingMore: true },
		}))
		try {
			const page = await this.api.get<DiscoveryPage>(
				"/api/scanner/discoveries",
				{ query: queryParams(d.query, cursor) },
			)
			if (generation !== this.discoveryGeneration) return
			this.commit(s => {
				const byId = new Map(s.discoveries.byId)
				const applied = this.applyWrites(byId, started, { upsert: page.items })
				const have = new Set(s.discoveries.items.map(x => x.id))
				const items = s.discoveries.items.map(x =>
					applied.has(x.id) ? (byId.get(x.id) ?? x) : x,
				)
				for (const x of page.items) {
					const now = byId.get(x.id)
					// offset cursors shift when live discoveries arrive: drop repeats
					if (now && !have.has(x.id)) {
						have.add(x.id)
						items.push(now)
					}
				}
				return {
					...s,
					discoveries: {
						...s.discoveries,
						items,
						byId,
						nextCursor: page.nextCursor,
						loadingMore: false,
						error: null,
					},
				}
			})
		} catch (error) {
			if (generation !== this.discoveryGeneration) return
			this.commit(s => ({
				...s,
				discoveries: {
					...s.discoveries,
					loadingMore: false,
					error: errorMessage(error),
				},
			}))
		}
	}

	/**
	 * GET /api/scanner/discoveries/:id into `byId` (e.g. a hit-log row outside the list). An id a merge
	 * absorbed answers with the survivor (`absorbedInto`): the old id leaves the state, the survivor takes it.
	 */
	async fetchDiscovery(id: string): Promise<Discovery> {
		const started = this.requestStart()
		const d = await this.api.get<Discovery>(
			`/api/scanner/discoveries/${encode(id)}`,
		)
		this.commit(s => {
			const absorbed =
				typeof d.absorbedInto === "string" && d.id !== id ? id : null
			const base =
				absorbed === null ? s : this.withoutDiscovery(s, absorbed, started)
			return this.withDiscovery(base, d, "updated", undefined, started)
		})
		return d
	}

	/**
	 * What is loaded may be stale (a merge whose ids were truncated, a startup consolidation): refetch
	 * `survivorId` (when given), the list when one is loaded, and bump `epoch` so span fetches ask again.
	 */
	private resyncDiscoveries(survivorId: string | null): void {
		if (this.disposed) return
		this.commit(s => ({
			...s,
			discoveries: { ...s.discoveries, epoch: s.discoveries.epoch + 1 },
		}))
		if (survivorId !== null)
			this.fetchDiscovery(survivorId).catch(() => undefined)
		const d = this.current().discoveries
		if (d.loaded) void this.refreshDiscoveries(d.query, d.items.length)
	}

	/**
	 * One page for `query` into `byId` only: the list, its query and cursor stay (the spectrum's discovery
	 * tags read `byId` for the visible span). Rejects with the core's ApiError or an AbortError.
	 */
	async fetchDiscoveries(
		query: DiscoveryQuery,
		options: { signal?: AbortSignal } = {},
	): Promise<readonly Discovery[]> {
		const started = this.requestStart()
		const page = await this.api.get<DiscoveryPage>(
			"/api/scanner/discoveries",
			options.signal
				? { query: queryParams(query), signal: options.signal }
				: { query: queryParams(query) },
		)
		// an answer that arrives after a newer one changes only the ids nothing newer spoke for
		this.commit(s => {
			const byId = this.reconcile(s.discoveries.byId, query, page, started)
			return { ...s, discoveries: { ...s.discoveries, byId } }
		})
		return page.items
	}

	// ---- actions (reject with the core's ApiError)

	/** POST /api/scanner/plan: a side-effect-free preview. Pass a signal to drop a stale one. */
	previewPlan(
		spec: ScanJobSpec,
		options: { signal?: AbortSignal } = {},
	): Promise<PlanPreview> {
		return this.api.post<PlanPreview>(
			"/api/scanner/plan",
			spec,
			options.signal ? { signal: options.signal } : {},
		)
	}

	/**
	 * POST /api/scanner/jobs (201). A sweep that disturbs others rejects with 409
	 * SCANNER_TAKEOVER_REQUIRED (takeoverImpact(error) names who) until `takeover: true`.
	 */
	async startJob(
		spec: ScanJobSpec,
		options: { takeover?: boolean } = {},
	): Promise<ScanJob> {
		const body: ScanJobSpec =
			options.takeover !== undefined
				? { ...spec, takeover: options.takeover }
				: spec
		const job = await this.api.post<ScanJob>("/api/scanner/jobs", body)
		this.commit(s => this.withJob(s, job))
		return job
	}

	pauseJob(id: string): Promise<ScanJob> {
		return this.jobAction(id, "pause")
	}

	resumeJob(
		id: string,
		options: { takeover?: boolean } = {},
	): Promise<ScanJob> {
		return this.jobAction(
			id,
			"resume",
			options.takeover !== undefined ? { takeover: options.takeover } : {},
		)
	}

	/**
	 * Stops a job. A job that already ended is a success: WG11 cores answer 200 with it unchanged,
	 * older ones 409 SCANNER_INVALID_TRANSITION, after which the job is read back.
	 */
	async cancelJob(id: string): Promise<ScanJob> {
		try {
			return await this.jobAction(id, "cancel")
		} catch (error) {
			if (!isApiError(error) || error.code !== "SCANNER_INVALID_TRANSITION")
				throw error
			const job = await this.api.get<ScanJob>(`/api/scanner/jobs/${encode(id)}`)
			if (isJobActive(job.state)) throw error
			this.commit(s => this.withJob(s, job))
			return job
		}
	}

	/** POST /api/scanner/jobs/:id/{pause,resume,cancel}: the job after the transition. */
	private async jobAction(
		id: string,
		action: "pause" | "resume" | "cancel",
		body?: { takeover?: boolean },
	): Promise<ScanJob> {
		const job = await this.api.post<ScanJob>(
			`/api/scanner/jobs/${encode(id)}/${action}`,
			body,
		)
		this.commit(s => this.withJob(s, job))
		return job
	}

	/** PATCH /api/scanner/jobs/:id: a live edit, applied at the next hop. */
	async patchJob(id: string, spec: ScanJobSpec): Promise<PatchJobResult> {
		const result = await this.api.patch<PatchJobResult>(
			`/api/scanner/jobs/${encode(id)}`,
			spec,
		)
		this.commit(s => this.withJob(s, result.job))
		return result
	}

	/** GET /api/scanner/jobs/:id/hits (most recent first; limit 1–500, default 100). */
	async getJobHits(id: string, limit?: number): Promise<ScanJobHitsResponse> {
		const res = await this.api.get<ScanJobHitsResponse>(
			`/api/scanner/jobs/${encode(id)}/hits`,
			limit !== undefined ? { query: { limit } } : {},
		)
		this.commit(s => {
			const hits = new Map(s.jobHits.get(id) ?? [])
			for (const h of res.hits) {
				const have = hits.get(h.discoveryId)
				if (!have || have.lastHitAt <= h.lastHitAt) hits.set(h.discoveryId, h)
			}
			const jobHits = new Map(s.jobHits)
			jobHits.set(id, hits)
			const jobHitStats = new Map(s.jobHitStats)
			jobHitStats.set(id, res.stats)
			return { ...s, jobHits, jobHitStats }
		})
		return res
	}

	/** PATCH /api/scanner/discoveries/:id: label, notes, lockout (Ignore), keep. */
	async patchDiscovery(
		id: string,
		patch: DiscoveryOperatorPatch,
	): Promise<Discovery> {
		const started = this.requestStart()
		const d = await this.api.patch<Discovery>(
			`/api/scanner/discoveries/${encode(id)}`,
			patch,
		)
		this.commit(s => this.withDiscovery(s, d, "updated", undefined, started))
		return d
	}

	/** DELETE /api/scanner/discoveries/:id; one the core no longer has counts as deleted. */
	async deleteDiscovery(id: string): Promise<void> {
		const started = this.requestStart()
		try {
			await this.api.delete<unknown>(`/api/scanner/discoveries/${encode(id)}`)
		} catch (error) {
			if (!isApiError(error) || error.status !== 404) throw error
		}
		this.commit(s => this.withoutDiscovery(s, id, started))
	}

	/** POST /api/scanner/discoveries/:id/listen: where to hear it in the current window. */
	listenDiscovery(id: string): Promise<ScannerListenResult> {
		return this.api.post<ScannerListenResult>(
			`/api/scanner/discoveries/${encode(id)}/listen`,
		)
	}

	/** A discovery seen by this store, by id. */
	discovery(id: string): Discovery | undefined {
		return this.current().discoveries.byId.get(id)
	}

	dispose(): void {
		this.disposed = true
		for (const fn of this.cleanup.splice(0)) fn()
		this.discoveryAbort?.abort()
		if (this.frameScheduled) this.frame.cancel(this.frameHandle)
		this.frameScheduled = false
		if (this.staleTimer) clearTimeout(this.staleTimer)
		this.staleTimer = null
	}

	// ---- internals: publishing

	/** A live change: applied to the draft, published on the next frame. */
	private live(fn: (s: ScannerState) => ScannerState): void {
		if (this.disposed) return
		this.draft = fn(this.current())
		if (this.frameScheduled) return
		this.frameScheduled = true
		const handle = this.frame.request(() => {
			this.frameScheduled = false
			this.frameHandle = null
			this.flush()
		})
		if (this.frameScheduled) this.frameHandle = handle
	}

	/** A REST answer: applied and published now (with any waiting live changes). */
	private commit(fn: (s: ScannerState) => ScannerState): void {
		if (this.disposed) return
		this.draft = fn(this.current())
		if (this.frameScheduled) this.frame.cancel(this.frameHandle)
		this.frameScheduled = false
		this.frameHandle = null
		this.flush()
	}

	private flush(): void {
		const next = this.draft
		this.draft = null
		if (next) this.set(next)
		const sweep = this.get().sweep
		const p = sweep
			? (this.progressByJob.get(sweep.id) ?? progressOfJob(sweep))
			: null
		this.progress.set(p)
	}

	// ---- internals: reducers (pure on the snapshot)

	private derive(s: ScannerState): ScannerState {
		const { sweep, passive } = deriveJobs(s.jobs.values())
		const lastSweepId = sweep?.id ?? s.lastSweepId
		const ended = [...s.jobHits.keys()].filter(id => {
			const job = s.jobs.get(id)
			return job !== undefined && !isJobActive(job.state) && id !== lastSweepId
		})
		let jobHits = s.jobHits
		if (ended.length > 0) {
			const kept = new Map(s.jobHits)
			for (const id of ended) kept.delete(id)
			jobHits = kept
		}
		return { ...s, sweep, passive, lastSweepId, jobHits }
	}

	private withJob(s: ScannerState, job: ScanJob): ScannerState {
		const have = s.jobs.get(job.id)
		if (have && have.updatedAt > job.updatedAt) return s
		const jobs = new Map(s.jobs)
		jobs.set(job.id, job)
		// a state change wins over an older progress event's state
		const p = this.progressByJob.get(job.id)
		if (p && p.state !== job.state)
			this.progressByJob.set(job.id, { ...p, state: job.state })
		if (!isJobActive(job.state)) this.progressByJob.delete(job.id)
		return this.derive({ ...s, jobs })
	}

	/** The start sequence of a request whose answer will write to `byId`. */
	private requestStart(): number {
		return this.order.next()
	}

	/**
	 * The one way records enter or leave `byId` (mutated in place): each removal, then each upsert,
	 * applies only when `at` is newer than everything that id last saw; `covers` records a complete
	 * answer for that query at `at` (after its own writes). Returns the ids whose write applied.
	 */
	private applyWrites(
		byId: Map<string, Discovery>,
		at: number,
		writes: {
			upsert?: readonly Discovery[]
			remove?: Iterable<string>
			covers?: DiscoveryQuery
		},
	): Set<string> {
		const applied = new Set<string>()
		for (const id of writes.remove ?? [])
			if (this.order.remove(id, at)) {
				byId.delete(id)
				applied.add(id)
			}
		for (const d of writes.upsert ?? [])
			if (this.order.upsert(d.id, d, at)) {
				byId.set(d.id, d)
				applied.add(d.id)
			}
		const q = writes.covers
		if (q !== undefined) this.order.cover(d => matchesDiscoveryQuery(d, q), at)
		return applied
	}

	/**
	 * An answer for `query` from a request that started at `started`: its records go in; when the page
	 * is complete, a cached record the query covers but the page no longer has is gone (merged, deleted
	 * or evicted: band inspection UX req 3.2), and the query is covered so an older answer cannot bring
	 * one back. Whatever something newer already said about an id stays.
	 */
	private reconcile(
		byId: ReadonlyMap<string, Discovery>,
		query: DiscoveryQuery,
		page: DiscoveryPage,
		started: number,
	): Map<string, Discovery> {
		const out = new Map(byId)
		const complete = page.nextCursor === null
		const have = new Set(page.items.map(d => d.id))
		const remove = complete
			? [...byId.values()]
					.filter(d => !have.has(d.id) && matchesDiscoveryQuery(d, query))
					.map(d => d.id)
			: []
		this.applyWrites(out, started, {
			upsert: page.items,
			remove,
			...(complete ? { covers: query } : {}),
		})
		return out
	}

	/** Upserts `d` at `at` (a live event: the next sequence); refused when something newer spoke for it. */
	private withDiscovery(
		s: ScannerState,
		d: Discovery,
		change: ScannerDiscoveryEventData["change"],
		mergedIds?: readonly string[],
		at: number = this.order.next(),
	): ScannerState {
		const list = s.discoveries
		const byId = new Map(list.byId)
		let items = list.items
		const gone =
			change === "merged"
				? // current cores name what the merge absorbed; older ones are guessed
					new Set(mergedIds ?? absorbedBy(d, items))
				: new Set<string>()
		gone.delete(d.id)
		const applied = this.applyWrites(byId, at, { upsert: [d], remove: gone })
		if (applied.size === 0) return s
		items = items.filter(x => !applied.has(x.id))
		if (
			applied.has(d.id) &&
			list.loaded &&
			matchesDiscoveryQuery(d, list.query)
		) {
			const compare = discoveryComparator(list.query.sort)
			let i = items.findIndex(x => compare(d, x) < 0)
			if (i < 0) i = items.length
			// past the loaded pages: loadMore() brings it in its place
			if (i < items.length || list.nextCursor === null)
				items = [...items.slice(0, i), d, ...items.slice(i)]
		}
		return { ...s, discoveries: { ...list, items, byId } }
	}

	/** Removes `id` at `at` (a live event: the next sequence); refused when something newer spoke for it. */
	private withoutDiscovery(
		s: ScannerState,
		id: string,
		at: number = this.order.next(),
	): ScannerState {
		const list = s.discoveries
		const byId = new Map(list.byId)
		if (this.applyWrites(byId, at, { remove: [id] }).size === 0) return s
		return {
			...s,
			discoveries: {
				...list,
				byId,
				items: list.items.filter(x => x.id !== id),
			},
		}
	}

	private withDiscoveryEvent(
		s: ScannerState,
		e: ScannerDiscoveryEventData,
	): ScannerState {
		let next: ScannerState
		if (e.change === "deleted") {
			// band inspection UX req 3.2: a merge into the deleted survivor may ride along: drop those too
			next = this.withoutDiscovery(s, e.discovery.id)
			for (const id of e.mergedIds ?? []) next = this.withoutDiscovery(next, id)
		} else next = this.withDiscovery(s, e.discovery, e.change, e.mergedIds)
		if (e.jobHits && e.jobHits.length > 0) {
			const jobHits = new Map(next.jobHits)
			for (const hit of e.jobHits) {
				const job = next.jobs.get(hit.jobId)
				if (job && !isJobActive(job.state)) continue
				const hits = new Map(jobHits.get(hit.jobId) ?? [])
				hits.set(hit.discoveryId, hit)
				jobHits.set(hit.jobId, hits)
			}
			next = { ...next, jobHits }
		}
		return next
	}

	private onProgress(p: ScannerProgressEventData): void {
		this.progressByJob.set(p.jobId, p)
		const s = this.current()
		const job = s.jobs.get(p.jobId)
		// a state the job list has not seen yet: keep jobs in step
		if (job && job.state !== p.state)
			this.live(x => {
				const j = x.jobs.get(p.jobId)
				if (!j) return x
				const jobs = new Map(x.jobs)
				jobs.set(j.id, { ...j, state: p.state })
				return this.derive({ ...x, jobs })
			})
		else if (s.sweep?.id === p.jobId) this.live(x => x)
	}

	private onActivity(a: ScannerActivityEventData): void {
		if (a.active) this.activitySeen.set(a.observationId, this.now())
		else this.activitySeen.delete(a.observationId)
		this.live(s => {
			const activity = new Map(s.activity)
			if (a.active) activity.set(a.observationId, a)
			else if (!activity.delete(a.observationId)) return s
			return withActivity(s, activity)
		})
		this.armStaleTimer()
	}

	private armStaleTimer(): void {
		if (this.staleTimer || this.activitySeen.size === 0 || this.disposed) return
		let oldest = Infinity
		for (const t of this.activitySeen.values()) oldest = Math.min(oldest, t)
		const wait = Math.max(0, oldest + this.staleMs - this.now())
		this.staleTimer = setTimeout(() => {
			this.staleTimer = null
			this.dropStale()
			this.armStaleTimer()
		}, wait + 50)
	}

	private dropStale(): void {
		const cutoff = this.now() - this.staleMs
		const stale: string[] = []
		for (const [id, t] of this.activitySeen) if (t <= cutoff) stale.push(id)
		if (stale.length === 0) return
		for (const id of stale) this.activitySeen.delete(id)
		this.live(s => {
			const activity = new Map(s.activity)
			for (const id of stale) activity.delete(id)
			return withActivity(s, activity)
		})
	}

	/** After a reconnect: refetch what was loaded; activity seen before the drop is unknown now. */
	private async resync(): Promise<void> {
		this.activitySeen.clear()
		this.progressByJob.clear()
		this.commit(s =>
			s.activity.size === 0
				? s
				: { ...s, activity: new Map(), activeNow: new Set() },
		)
		const d = this.current().discoveries
		await Promise.all([
			this.loadedOnce ? this.load() : Promise.resolve(),
			d.loaded
				? this.refreshDiscoveries(d.query, d.items.length)
				: Promise.resolve(),
		])
	}
}

/** Recomputes activeNow from the active observations; keeps the old set when unchanged. */
function withActivity(
	s: ScannerState,
	activity: Map<string, ScannerActivityEventData>,
): ScannerState {
	const ids = new Set<string>()
	for (const a of activity.values()) if (a.discoveryId) ids.add(a.discoveryId)
	const same =
		ids.size === s.activeNow.size && [...ids].every(id => s.activeNow.has(id))
	return { ...s, activity, activeNow: same ? s.activeNow : ids }
}
