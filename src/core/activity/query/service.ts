import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { createComponentLogger } from "../../../utils/logger.js"
import type { Logger } from "../../../utils/logger.js"
import type {
	ActivityFacetRequest,
	ActivityFacetResult,
	ActivityQueryService,
	ActivityRecord,
	ActivityReplayHandle,
	ActivityReplayRequest,
	ActivityReplaySink,
	ActivitySearchPage,
	ActivitySearchRequest,
	ActivityTrails,
	ActivityTrailsQuery,
	StoreIdentity,
} from "../storage/contract.js"
import { QueryAdmission } from "./admission.js"
import { issueCursor, verifyCursor } from "./cursor.js"
import {
	ActivityQueryClosedError,
	ActivityQueryInvalidError,
	ActivityQueryTimeoutError,
	ActivityReaderFailedError,
	ActivitySnapshotResetError,
	ActivityCursorGapError,
} from "./errors.js"
import {
	assembleSummaries,
	type ObservedStore,
	type ReadRequest,
	type ReadResult,
} from "./read.js"
import {
	DEFAULT_TRAILS_READ_LIMITS,
	TRAILS_WALL_BUDGET_MS,
	type TrailsReadLimits,
} from "./trails.js"
import { ReaderHost, type ReaderHostEvent } from "./reader-host.js"
import { startReplay } from "./replay.js"
import {
	cursorBehindWatermark,
	formatSeq,
	higherWatermark,
	holeStateOf,
	newerHoles,
	parseSeq,
	snapshotLowerBoundPassed,
} from "./seq.js"
import {
	hashQuery,
	normaliseQuery,
	normaliseTrailsQuery,
	parseDimensions,
	parseLimit,
	parseOrder,
} from "./validate.js"

const clients = new AsyncLocalStorage<string>()

/** Binds later reads to one client admission slot. Async work keeps the binding. */
export function withActivityClient<T>(clientKey: string, run: () => T): T {
	return clients.run(clientKey, run)
}

function currentClient(): string {
	return clients.getStore() ?? `anon-${randomUUID()}`
}

/** The storage-lane surface this lane is allowed to call. */
export interface ActivityStoreQueryHandle {
	readonly dbPath: string
	identity(): StoreIdentity
	cursorKey(): Buffer
	onCommit(listener: (identity: StoreIdentity) => void): () => void
}

export interface ActivityQueryLimits {
	filterTerms: number
	textBytes: number
	ftsTokens: number
	pageDefault: number
	pageMax: number
	pageBytes: number
	facetDimensions: number
	facetValues: number
	facetScan: number
	deadlineMs: number
	/** WG4: deadline of one bulk trails read (backstop: a timeout restarts the reader). */
	trailsDeadlineMs: number
	/** WG4: cooperative budget of the trails scan plus its older-points check; past it `time-limit`. */
	trailsWallBudgetMs: number
	maxQueued: number
	maxExecuting: number
	maxInFlightPerClient: number
	snapshotTtlMs: number
	replayPage: number
}

export const DEFAULT_ACTIVITY_QUERY_LIMITS: ActivityQueryLimits = {
	filterTerms: 16,
	textBytes: 256,
	ftsTokens: 8,
	pageDefault: 100,
	pageMax: 200,
	pageBytes: 512 * 1024,
	facetDimensions: 5,
	facetValues: 32,
	facetScan: 50_000,
	deadlineMs: 250,
	trailsDeadlineMs: 1_000,
	trailsWallBudgetMs: TRAILS_WALL_BUDGET_MS,
	maxQueued: 4,
	maxExecuting: 1,
	maxInFlightPerClient: 1,
	snapshotTtlMs: 5 * 60 * 1000,
	replayPage: 100,
}

export interface ActivityQueryServiceOptions {
	store: ActivityStoreQueryHandle
	logger: Logger
	now?: () => number
	/** Defaults to dist/activity-query-worker.js next to the bundled entry. */
	workerUrl?: URL
	/** Tests pass "inline" so they do not need the built worker. */
	execution?: "worker" | "inline"
	limits?: Partial<ActivityQueryLimits>
	/** Test override of the trails read bounds, merged over DEFAULT_TRAILS_READ_LIMITS. */
	trailsLimits?: Partial<TrailsReadLimits>
	/** Test hook. A number, or a function sampled once per read. */
	readerDelayMs?: number | (() => number)
	onReaderEvent?: (event: ReaderHostEvent) => void
	/**
	 * Reader startup budget. The query deadline starts only after the reader
	 * is ready. Defaults to 5 s.
	 */
	readyTimeoutMs?: number
}

const READER_READY_TIMEOUT_MS = 5_000

export function defaultActivityQueryWorkerUrl(): URL {
	return new URL("./activity-query-worker.js", import.meta.url)
}

function resolveLimits(
	overrides: Partial<ActivityQueryLimits> | undefined,
): ActivityQueryLimits {
	const limits: ActivityQueryLimits = { ...DEFAULT_ACTIVITY_QUERY_LIMITS }
	if (!overrides) return limits
	for (const key of Object.keys(overrides) as (keyof ActivityQueryLimits)[]) {
		const value = overrides[key]
		if (value !== undefined) limits[key] = value
	}
	limits.maxExecuting = Math.max(1, limits.maxExecuting)
	limits.maxInFlightPerClient = Math.max(1, limits.maxInFlightPerClient)
	return limits
}

function isEventId(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 128 &&
		!/[\u0000-\u001f\u007f]/.test(value)
	)
}

export function createActivityQueryService(
	options: ActivityQueryServiceOptions,
): ActivityQueryService {
	const limits = resolveLimits(options.limits)
	const trailsLimits: TrailsReadLimits = {
		...DEFAULT_TRAILS_READ_LIMITS,
		...options.trailsLimits,
	}
	const log = createComponentLogger(options.logger, "ActivityQuery")
	const now = options.now ?? (() => Date.now())
	const execution = options.execution ?? "worker"
	const store = options.store
	const host = new ReaderHost(
		store.dbPath,
		execution,
		options.workerUrl ?? defaultActivityQueryWorkerUrl(),
		options.onReaderEvent,
		options.readyTimeoutMs ?? READER_READY_TIMEOUT_MS,
	)
	const admission = new QueryAdmission(
		limits.maxExecuting,
		limits.maxQueued,
		limits.maxInFlightPerClient,
	)
	const stops = new Set<() => void>()
	let closed = false

	function delayMs(): number {
		const value = options.readerDelayMs
		if (typeof value === "function") return value()
		return value ?? 0
	}

	async function perform(
		clientKey: string,
		request: ReadRequest,
		deadlineMs: number = limits.deadlineMs,
	): Promise<ReadResult> {
		if (closed) throw new ActivityQueryClosedError()
		const release = await admission.acquire(clientKey)
		const ticket = {}
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await host.ensureReady()
			if (closed) throw new ActivityQueryClosedError()
			return await new Promise((resolve, reject) => {
				timer = setTimeout(() => {
					host.invalidate(ticket)
					reject(new ActivityQueryTimeoutError())
				}, deadlineMs)
				timer.unref()
				void host.execute(request, delayMs(), ticket).then(
					value => {
						if (timer) clearTimeout(timer)
						resolve(value)
					},
					(error: unknown) => {
						if (timer) clearTimeout(timer)
						reject(
							error instanceof Error ? error : new ActivityReaderFailedError(),
						)
					},
				)
			})
		} finally {
			if (timer) clearTimeout(timer)
			release()
		}
	}

	function guardSnapshot(
		captured: StoreIdentity,
		low: bigint,
		continuation: bigint | undefined,
		tokenHoleGeneration: number | undefined,
		observed: ObservedStore,
	): void {
		const fresh = store.identity()
		if (
			fresh.storeUuid !== captured.storeUuid ||
			fresh.restoreGeneration !== captured.restoreGeneration ||
			observed.storeUuid !== captured.storeUuid ||
			observed.restoreGeneration !== captured.restoreGeneration
		) {
			throw new ActivitySnapshotResetError(
				"store-changed",
				"Activity store changed",
			)
		}
		const watermark = higherWatermark(
			parseSeq(fresh.pruneWatermark),
			parseSeq(observed.pruneWatermark),
		)
		if (
			continuation !== undefined &&
			cursorBehindWatermark(continuation, watermark)
		) {
			throw new ActivityCursorGapError()
		}
		if (snapshotLowerBoundPassed(low, watermark)) {
			throw new ActivitySnapshotResetError(
				"snapshot-reset",
				"Activity snapshot lower bound moved",
			)
		}
		if (
			tokenHoleGeneration !== undefined &&
			newerHoles(holeStateOf(fresh), holeStateOf(observed)).generation >
				tokenHoleGeneration
		) {
			throw new ActivitySnapshotResetError(
				"snapshot-reset",
				"Activity snapshot lost rows to a hole",
			)
		}
	}

	const service: ActivityQueryService = {
		async search(input: ActivitySearchRequest): Promise<ActivitySearchPage> {
			if (closed) throw new ActivityQueryClosedError()
			const query = normaliseQuery(input.query, limits)
			const order = parseOrder(input.order)
			const limit = parseLimit(input.limit, limits)
			const queryHash = hashQuery(query)
			const identity = store.identity()
			let low = parseSeq(identity.pruneWatermark)
			let high = parseSeq(identity.committedMax)
			let before: string | null = null
			let after: string | null = null
			let expiresAtMs = now() + limits.snapshotTtlMs
			let continuation: bigint | undefined
			let tokenHoleGeneration: number | undefined
			if (input.pageToken !== undefined) {
				const payload = verifyCursor({
					token: input.pageToken,
					key: store.cursorKey(),
					identity,
					queryHash,
					order,
					now: now(),
					mode: "page",
				})
				if (payload.L === undefined || payload.H === undefined) {
					throw new ActivityQueryInvalidError(
						"Activity page token is incomplete",
					)
				}
				low = parseSeq(payload.L)
				high = parseSeq(payload.H)
				continuation = parseSeq(payload.lastSeq)
				tokenHoleGeneration = payload.hg
				if (order === "desc") before = payload.lastSeq
				else after = payload.lastSeq
				expiresAtMs = Date.parse(payload.expiresAt)
			}
			const result = await perform(currentClient(), {
				op: "search",
				query,
				order,
				limit: limit + 1,
				low: formatSeq(low),
				high: formatSeq(high),
				before,
				after,
			})
			guardSnapshot(
				identity,
				low,
				continuation,
				tokenHoleGeneration,
				result.observed,
			)
			if (result.op !== "search") throw new ActivityReaderFailedError()
			// First page: the generation read with its rows. Continuation: carried.
			const holeGeneration =
				tokenHoleGeneration ?? result.observed.holeGeneration
			const page = assembleSummaries(result.rows, limit, limits.pageBytes)
			const expiresAt = new Date(expiresAtMs).toISOString()
			const replay = issueCursor({
				key: store.cursorKey(),
				identity,
				queryHash,
				order: "asc",
				lastSeq: high,
				high,
				holeGeneration,
				expiresAtMs,
			})
			let nextPageToken: string | null = null
			if (page.hasMore) {
				if (page.lastSeq === null) throw new ActivityReaderFailedError()
				nextPageToken = issueCursor({
					key: store.cursorKey(),
					identity,
					queryHash,
					order,
					lastSeq: parseSeq(page.lastSeq),
					low,
					high,
					holeGeneration,
					expiresAtMs,
				}).token
			}
			return {
				items: page.items,
				nextPageToken,
				replayCursor: replay.token,
				snapshot: {
					lowBarrier: formatSeq(low),
					highWater: formatSeq(high),
					expiresAt,
				},
				searchCoverage: "bounded-projection",
			}
		},

		async detail(eventId: string): Promise<ActivityRecord | null> {
			if (closed) throw new ActivityQueryClosedError()
			if (!isEventId(eventId)) {
				throw new ActivityQueryInvalidError("eventId is invalid")
			}
			const result = await perform(currentClient(), { op: "detail", eventId })
			if (result.op !== "detail") throw new ActivityReaderFailedError()
			return result.record
		},

		async facets(input: ActivityFacetRequest): Promise<ActivityFacetResult> {
			if (closed) throw new ActivityQueryClosedError()
			const query = normaliseQuery(input.query, limits)
			const dimensions = parseDimensions(
				input.dimensions,
				limits.facetDimensions,
			)
			const identity = store.identity()
			const low = parseSeq(identity.pruneWatermark)
			const high = parseSeq(identity.committedMax)
			const result = await perform(currentClient(), {
				op: "facets",
				query,
				dimensions,
				low: formatSeq(low),
				high: formatSeq(high),
				scanCap: limits.facetScan,
				valueCap: limits.facetValues,
			})
			guardSnapshot(identity, low, undefined, undefined, result.observed)
			if (result.op !== "facets") throw new ActivityReaderFailedError()
			return {
				facets: result.facets,
				scanned: result.scanned,
				truncated: result.truncated,
				snapshot: {
					lowBarrier: formatSeq(low),
					highWater: formatSeq(high),
				},
			}
		},

		async trails(input: ActivityTrailsQuery): Promise<ActivityTrails> {
			if (closed) throw new ActivityQueryClosedError()
			const query = normaliseTrailsQuery(input, now())
			const result = await perform(
				currentClient(),
				{
					op: "trails",
					input: {
						producedFromMs: query.producedFromMs,
						producedToMs: query.producedToMs,
						...(query.categories ? { categories: query.categories } : {}),
						...(query.protocols ? { protocols: query.protocols } : {}),
						...(query.entityKeys ? { entityKeys: query.entityKeys } : {}),
						limits: trailsLimits,
						wallBudgetMs: limits.trailsWallBudgetMs,
					},
				},
				limits.trailsDeadlineMs,
			)
			if (result.op !== "trails") throw new ActivityReaderFailedError()
			return result.trails
		},

		replay(
			input: ActivityReplayRequest,
			sink: ActivityReplaySink,
		): ActivityReplayHandle {
			if (closed) {
				sink.send({ type: "reset", reason: "invalid-cursor" })
				return { resume() {}, stop() {} }
			}
			return startReplay(
				{
					store,
					now,
					limits,
					log,
					clientKey: currentClient(),
					read: (clientKey, request) => perform(clientKey, request),
					register: stop => {
						stops.add(stop)
					},
					unregister: stop => {
						stops.delete(stop)
					},
				},
				input,
				sink,
			)
		},

		async close(): Promise<void> {
			if (closed) return
			closed = true
			for (const stop of [...stops]) stop()
			stops.clear()
			admission.close()
			await host.close()
		},
	}

	if (execution === "worker") {
		void host.ensureReady().catch((error: unknown) => {
			if (closed) return
			log.warn({ err: error }, "Activity reader prewarm failed")
		})
	}

	log.debug("Activity query service created")
	return service
}
