import { statfs as nodeStatfs } from "node:fs/promises"
import {
	STORAGE_AREA_CLASS,
	STORAGE_AREA_IDS,
	STORAGE_REPORT_CACHE_MS,
} from "@wavekit/api-types"
import type {
	StorageActivityRetention,
	StorageArea,
	StorageAreaPart,
	StorageCountState,
	StorageFilesystem,
	StorageKeptSummary,
	StorageLowSpaceState,
	StorageReport,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import {
	STORAGE_COUNT_FS_CONCURRENCY,
	STORAGE_COUNT_MAX_ENTRIES,
	STORAGE_COUNT_MAX_SERVE_AGE_MS,
	STORAGE_COUNT_MAX_WALL_MS,
} from "./contract.js"
import type {
	StorageAreaSource,
	StorageReportOptions,
	StorageReportProvider,
} from "./contract.js"
import { scanStorageAreas } from "./scan.js"
import { DEFAULT_STORAGE_SCAN_LIMITS } from "./scan.js"
import type {
	StorageAreaScan,
	StorageScanFs,
	StorageScanLimits,
} from "./scan.js"

type Num = number | bigint

export interface StorageReporterInternals {
	scan?: typeof scanStorageAreas
	statfs?: (p: string) => Promise<{
		blocks: Num
		bfree: Num
		bavail: Num
		bsize: Num
	}>
	fs?: StorageScanFs
	/** Request budget (maxWallMs) and the count's maxDepth. */
	limits?: Partial<Pick<StorageScanLimits, "maxWallMs" | "maxDepth">>
	/** The background count's own bounds (defaults STORAGE_COUNT_MAX_*, STORAGE_COUNT_FS_CONCURRENCY). */
	countLimits?: Partial<
		Pick<StorageScanLimits, "maxEntries" | "maxWallMs" | "concurrency">
	>
	cacheMs?: number
	/** Oldest count served as exact (default STORAGE_COUNT_MAX_SERVE_AGE_MS). */
	maxServeAgeMs?: number
}

export function createStorageReporter(
	options: StorageReportOptions,
	internal: StorageReporterInternals = {},
): StorageReportProvider {
	const order = new Map(STORAGE_AREA_IDS.map((id, i) => [id, i]))
	/** Validated areas in STORAGE_AREA_IDS order. */
	const ordered = (
		sources: readonly StorageAreaSource[],
	): StorageAreaSource[] => {
		const seen = new Set<string>()
		for (const area of sources) {
			if (!order.has(area.id)) {
				throw new WaveKitError(
					`Unknown storage area id: ${String(area.id)}`,
					"STORAGE_AREA_INVALID",
				)
			}
			if (seen.has(area.id)) {
				throw new WaveKitError(
					`Duplicate storage area id: ${area.id}`,
					"STORAGE_AREA_INVALID",
				)
			}
			seen.add(area.id)
		}
		return [...sources].sort(
			(a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
		)
	}
	const areaOption = options.areas
	// A static list fails at construction; a provider is read (and checked) per scan.
	let currentAreas: () => StorageAreaSource[]
	if (typeof areaOption === "function") {
		currentAreas = () => ordered(areaOption())
	} else {
		const fixed = ordered(areaOption)
		currentAreas = () => fixed
	}
	const minFreeOption = options.minFreeBytes
	const currentMinFree = (): number | null =>
		typeof minFreeOption === "function" ? minFreeOption() : minFreeOption
	const now = options.now ?? Date.now
	const scan = internal.scan ?? scanStorageAreas
	const statfs = internal.statfs ?? nodeStatfs
	const cacheMs = internal.cacheMs ?? STORAGE_REPORT_CACHE_MS
	const maxServeAgeMs = internal.maxServeAgeMs ?? STORAGE_COUNT_MAX_SERVE_AGE_MS
	const countConcurrency =
		internal.countLimits?.concurrency ?? STORAGE_COUNT_FS_CONCURRENCY

	let cached: {
		report: StorageReport
		until: number
		/** Built while a count ran: dropped when it finishes, so its sizes show at once. */
		provisional: boolean
	} | null = null
	let inflight: Promise<StorageReport> | null = null

	function readRetention(): StorageActivityRetention | null {
		try {
			return options.activityRetention?.() ?? null
		} catch {
			return null
		}
	}

	function readKept(): StorageKeptSummary | null {
		try {
			return options.kept?.() ?? null
		} catch {
			return null
		}
	}

	async function readFilesystem(): Promise<StorageFilesystem | null> {
		try {
			const s = await statfs(options.stateDir)
			const bsize = Number(s.bsize)
			const fsInfo = {
				totalBytes: Number(s.blocks) * bsize,
				freeBytes: Number(s.bfree) * bsize,
				availableBytes: Number(s.bavail) * bsize,
			}
			return Object.values(fsInfo).every(Number.isFinite) ? fsInfo : null
		} catch {
			return null
		}
	}

	/** One area's count identity: two areas with one key count the same files. */
	function oneKey(a: StorageAreaSource): string {
		return JSON.stringify([
			a.id,
			a.paths,
			a.exclude ?? [],
			a.parts?.parts.map(p => p.names) ?? null,
		])
	}

	/** What a count walks: two area lists with one key count the same files. */
	function areaKey(areas: readonly StorageAreaSource[]): string {
		return JSON.stringify(areas.map(oneKey))
	}

	/**
	 * The last finished count (of the area set `key`), served until the next one finishes. An
	 * area whose own key is in `byKey` is served from it even when the set changed since.
	 */
	let tally: {
		key: string
		byKey: Map<string, StorageAreaScan>
		countedAt: number
	} | null = null
	/** The background count running, at most one. */
	let counting: {
		key: string
		done: Promise<StorageAreaScan[]>
		peek: (() => StorageAreaScan[]) | null
	} | null = null
	/** A count of other areas asked for while one ran: started when it finishes (no overlap). */
	let queued: {
		areas: readonly StorageAreaSource[]
		key: string
		concurrency: number
	} | null = null
	/** Counts settled so far: a report built during a count is not cached past it. */
	let settledCounts = 0

	/**
	 * Starts the background count: off the request path, with its own bounds (entries, wall
	 * time and fs calls sized for a live state tree), never more than one at a time.
	 */
	function startCount(
		areas: readonly StorageAreaSource[],
		key: string,
		concurrency: number,
	): void {
		const scanOptions: Parameters<typeof scanStorageAreas>[1] = {
			limits: {
				maxEntries:
					internal.countLimits?.maxEntries ?? STORAGE_COUNT_MAX_ENTRIES,
				maxDepth:
					internal.limits?.maxDepth ?? DEFAULT_STORAGE_SCAN_LIMITS.maxDepth,
				maxWallMs: internal.countLimits?.maxWallMs ?? STORAGE_COUNT_MAX_WALL_MS,
				concurrency,
			},
			progress: peek => {
				entry.peek = peek
			},
		}
		if (internal.fs) scanOptions.fs = internal.fs
		const entry: NonNullable<typeof counting> = {
			key,
			peek: null,
			done: Promise.resolve([]),
		}
		counting = entry
		const settle = (): void => {
			settledCounts++
			if (counting === entry) counting = null
			// A report built during the count is dropped, so the next one shows the result.
			if (cached?.provisional === true) cached = null
			const next = queued
			queued = null
			// The areas changed while this count ran: count them now.
			if (next !== null && next.key !== key && counting === null)
				startCount(next.areas, next.key, next.concurrency)
		}
		entry.done = scan(areas, scanOptions).then(
			scans => {
				const byId = new Map(scans.map(s => [s.id, s]))
				const byKey = new Map<string, StorageAreaScan>()
				for (const a of areas) {
					const s = byId.get(a.id)
					if (s !== undefined) byKey.set(oneKey(a), s)
				}
				tally = { key, byKey, countedAt: now() }
				settle()
				return scans
			},
			(err: unknown) => {
				// A failed refresh keeps serving the previous count; the next report retries.
				settle()
				throw err
			},
		)
		// A request that stopped waiting must not leave the rejection unhandled.
		entry.done.catch(() => undefined)
	}

	async function build(): Promise<{
		report: StorageReport
		provisional: boolean
		finished: number
	}> {
		const started = now()
		const areas = currentAreas()
		const min = currentMinFree()
		const limits: StorageScanLimits = {
			...DEFAULT_STORAGE_SCAN_LIMITS,
			...internal.limits,
		}
		const key = areaKey(areas)
		// One wall budget for statfs + the wait on the count, in real time from report start.
		const wallStart = Date.now()
		// statfs is one fs call outside the count's limit (STORAGE_COUNT_FS_CONCURRENCY); it gets
		// a bounded wait so a stalled statfs cannot hang the report.
		let timer: ReturnType<typeof setTimeout> | undefined
		const timedOut = Symbol("timeout")
		const fsResult = await Promise.race([
			readFilesystem(),
			new Promise<typeof timedOut>(resolve => {
				timer = setTimeout(() => resolve(timedOut), limits.maxWallMs)
			}),
		])
		clearTimeout(timer)
		const filesystem = fsResult === timedOut ? null : fsResult
		const fresh =
			tally !== null && tally.key === key && now() - tally.countedAt < cacheMs
		if (fresh || counting?.key === key) queued = null
		else {
			// A stalled statfs still holds one pool thread: the count takes one call less.
			const concurrency =
				fsResult === timedOut
					? Math.max(1, countConcurrency - 1)
					: countConcurrency
			if (counting === null) startCount(areas, key, concurrency)
			else queued = { areas, key, concurrency }
		}
		// A statfs timeout spent the whole budget; recomputing the remainder from the clock
		// could leave a millisecond of timer/clock rounding.
		const remaining =
			fsResult === timedOut
				? 0
				: Math.max(0, limits.maxWallMs - (Date.now() - wallStart))
		// A finished count that holds every area and is within the serve age is served at once
		// (the refresh shows in the next report). Otherwise the report waits for the count of
		// these areas within the budget: the first one, or the refresh of a too old one.
		const running = counting
		const before = tally
		const complete =
			before !== null && areas.every(a => before.byKey.has(oneKey(a)))
		const tooOld =
			before !== null && Math.max(0, started - before.countedAt) > maxServeAgeMs
		if (
			running !== null &&
			running.key === key &&
			(!complete || tooOld) &&
			remaining > 0
		) {
			const waited = Symbol("waited")
			let wait: ReturnType<typeof setTimeout> | undefined
			try {
				await Promise.race([
					// A failed first count fails the report (uncached); a failed refresh serves the
					// previous count.
					complete ? running.done.catch(() => undefined) : running.done,
					new Promise<typeof waited>(resolve => {
						wait = setTimeout(() => resolve(waited), remaining)
					}),
				])
			} finally {
				clearTimeout(wait)
			}
		}
		const finished = settledCounts
		const refreshing = counting !== null
		const served = tally
		const ageMs =
			served === null ? null : Math.max(0, started - served.countedAt)
		const stale = ageMs !== null && ageMs > maxServeAgeMs
		// Before the first count of an area finishes: the running count's progress, as lower bounds.
		const progress = new Map(
			(counting?.key === key ? (counting.peek?.() ?? []) : []).map(s => [
				s.id,
				s,
			]),
		)
		let fromCount = false
		const out: StorageArea[] = areas.map(source => {
			let s: StorageAreaScan | undefined = served?.byKey.get(oneKey(source))
			if (s !== undefined) {
				fromCount = true
				// Too old and not refreshed in time: once exact, not any more (first reason wins).
				if (stale && s.partialReason === null)
					s = { ...s, partialReason: "stale" }
			} else {
				s = progress.get(source.id) ?? {
					id: source.id,
					bytes: 0,
					files: 0,
					exists: false,
					partialReason: "time-limit",
				}
			}
			const parts = partsOf(source, s)
			const area: StorageArea = {
				id: source.id,
				class: STORAGE_AREA_CLASS[source.id],
				bytes: s.bytes,
				files: s.files,
				exists: s.exists,
				partial: s.partialReason !== null,
				partialReason: s.partialReason,
				cap: source.capBytes === null ? null : { bytes: source.capBytes },
				retention: source.id === "activity" ? readRetention() : null,
			}
			if (parts !== null) area.parts = parts
			return area
		})
		let state: StorageLowSpaceState = "unknown"
		if (min !== null && filesystem !== null) {
			state = filesystem.availableBytes < min ? "low" : "ok"
		}
		const count: StorageCountState =
			fromCount && served !== null
				? {
						countedAt: new Date(served.countedAt).toISOString(),
						ageMs,
						refreshing,
					}
				: { countedAt: null, ageMs: null, refreshing }
		return {
			report: {
				generatedAt: new Date(started).toISOString(),
				cachedUntil: new Date(started + cacheMs).toISOString(),
				filesystem,
				areas: out,
				kept: readKept(),
				lowSpace: {
					policy: "scanner-evidence-stops-writing",
					minFreeBytes: min,
					state,
				},
				count,
			},
			provisional: refreshing,
			finished,
		}
	}

	/**
	 * The split of a source with parts (STORAGE_SCANNER_PART_IDS order): each part's scanned
	 * totals and bounds. A part the scan did not reach reads 0 (the area is partial then).
	 */
	function partsOf(
		source: StorageAreaSource,
		scan: StorageAreaScan | undefined,
	): StorageAreaPart[] | null {
		const split = source.parts
		if (split === undefined || source.paths.length !== 1) return null
		const partial = scan === undefined || scan.partialReason !== null
		return [...split.parts, split.fallback].map((p, i) => {
			const found = scan?.parts?.[i]
			const bytes = found?.bytes ?? 0
			const files = found?.files ?? 0
			// maxFiles counts in its prune's unit (StorageAreaPartSource.boundedFile).
			const boundedFiles = found?.boundedFiles ?? files
			// maxBytes counts the bytes its cap counts (StorageAreaPartSource.boundedPath).
			const boundedBytes = found?.boundedBytes ?? bytes
			const { maxBytes, maxFiles } = p.bounds
			return {
				id: p.id,
				bytes,
				files,
				exists: found?.exists ?? false,
				boundedFiles,
				bounds: { ...p.bounds },
				overBound:
					partial || (maxBytes === null && maxFiles === null)
						? null
						: (maxBytes !== null && boundedBytes > maxBytes) ||
							(maxFiles !== null && boundedFiles > maxFiles),
			}
		})
	}

	return {
		warm() {
			// Off the request path: the first report then serves a finished count.
			try {
				if (counting !== null || inflight !== null) return
				const areas = currentAreas()
				const key = areaKey(areas)
				if (tally?.key === key && now() - tally.countedAt < cacheMs) return
				startCount(areas, key, countConcurrency)
			} catch {
				// Invalid areas: the next report fails with the reason.
			}
		},
		report() {
			if (cached && now() < cached.until) return Promise.resolve(cached.report)
			if (inflight) return inflight
			const started = now()
			const p = build().then(
				({ report, provisional, finished }) => {
					// A count that finished after this report was built makes it stale already.
					cached =
						provisional && finished !== settledCounts
							? null
							: { report, until: started + cacheMs, provisional }
					inflight = null
					return report
				},
				(err: unknown) => {
					inflight = null
					throw err
				},
			)
			inflight = p
			return p
		},
	}
}
