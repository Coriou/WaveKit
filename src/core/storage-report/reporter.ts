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
	StorageLowSpaceState,
	StorageReport,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import type { StorageReportOptions, StorageReportProvider } from "./contract.js"
import { scanStorageAreas } from "./scan.js"
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
	const seen = new Set<string>()
	for (const area of options.areas) {
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
	const areas = [...options.areas].sort(
		(a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
	)
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
		const scanOptions: Parameters<typeof scanStorageAreas>[1] = {}
		if (internal.fs) scanOptions.fs = internal.fs
		if (internal.limits) scanOptions.limits = internal.limits
		// Sequential so peak fs concurrency stays within the scan's limit.
		const filesystem = await readFilesystem()
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
		const min = options.minFreeBytes
		let state: StorageLowSpaceState = "unknown"
		if (min !== null && filesystem !== null) {
			state = filesystem.availableBytes < min ? "low" : "ok"
		}
		return {
			generatedAt: new Date(started).toISOString(),
			cachedUntil: new Date(started + cacheMs).toISOString(),
			filesystem,
			areas: out,
			kept: null,
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
