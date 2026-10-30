import { statfs as nodeStatfs } from "node:fs/promises"
import {
	STORAGE_AREA_CLASS,
	STORAGE_AREA_IDS,
	STORAGE_REPORT_CACHE_MS,
} from "@wavekit/api-types"
import type {
	StorageActivityRetention,
	StorageArea,
	StorageFilesystem,
	StorageKeptSummary,
	StorageLowSpaceState,
	StorageReport,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import type {
	StorageAreaSource,
	StorageReportOptions,
	StorageReportProvider,
} from "./contract.js"
import { scanStorageAreas } from "./scan.js"
import { DEFAULT_STORAGE_SCAN_LIMITS } from "./scan.js"
import type { StorageScanFs, StorageScanLimits } from "./scan.js"

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
	limits?: Partial<StorageScanLimits>
	cacheMs?: number
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

	let cached: { report: StorageReport; until: number } | null = null
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

	async function build(): Promise<StorageReport> {
		const started = now()
		const areas = currentAreas()
		const min = currentMinFree()
		const limits: StorageScanLimits = {
			...DEFAULT_STORAGE_SCAN_LIMITS,
			...internal.limits,
		}
		// One wall budget for statfs + scan, measured in real time from report start.
		const wallStart = Date.now()
		// statfs runs before the scan so peak fs concurrency stays within the limit; it gets
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
		const scanOptions: Parameters<typeof scanStorageAreas>[1] = {
			limits: {
				...limits,
				// A statfs timeout spent the whole budget; recomputing the remainder from the
				// clock could leave a millisecond of timer/clock rounding and start a scan.
				maxWallMs:
					fsResult === timedOut
						? 0
						: Math.max(0, limits.maxWallMs - (Date.now() - wallStart)),
				// A stalled statfs still holds one fs slot.
				concurrency:
					fsResult === timedOut
						? Math.max(1, limits.concurrency - 1)
						: limits.concurrency,
			},
		}
		if (internal.fs) scanOptions.fs = internal.fs
		const scans = await scan(areas, scanOptions)
		const byId = new Map(scans.map(s => [s.id, s]))
		const out: StorageArea[] = areas.map(source => {
			const s = byId.get(source.id)
			return {
				id: source.id,
				class: STORAGE_AREA_CLASS[source.id],
				bytes: s?.bytes ?? 0,
				files: s?.files ?? 0,
				exists: s?.exists ?? false,
				partial: (s?.partialReason ?? null) !== null,
				partialReason: s?.partialReason ?? null,
				cap: source.capBytes === null ? null : { bytes: source.capBytes },
				retention: source.id === "activity" ? readRetention() : null,
			}
		})
		let state: StorageLowSpaceState = "unknown"
		if (min !== null && filesystem !== null) {
			state = filesystem.availableBytes < min ? "low" : "ok"
		}
		return {
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
		}
	}

	return {
		report() {
			if (cached && now() < cached.until) return Promise.resolve(cached.report)
			if (inflight) return inflight
			const started = now()
			const p = build().then(
				report => {
					cached = { report, until: started + cacheMs }
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
