/**
 * WG4 lane S storage scanner (docs/specs/web-gaps-4, requirement 3). Walks the configured
 * areas iteratively with one shared budget (entries, depth, wall time, fs concurrency) and
 * never throws for filesystem errors: they become a per-area partialReason.
 */
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"

import {
	STORAGE_SCAN_MAX_DEPTH,
	STORAGE_SCAN_MAX_ENTRIES,
	STORAGE_SCAN_MAX_WALL_MS,
} from "@wavekit/api-types"
import type { StorageAreaId, StoragePartialReason } from "@wavekit/api-types"

import { STORAGE_SCAN_FS_CONCURRENCY } from "./contract.js"
import type { StorageAreaSource } from "./contract.js"

export interface StorageScanFs {
	lstat(path: string): Promise<{
		size: number
		isFile(): boolean
		isDirectory(): boolean
		isSymbolicLink(): boolean
	}>
	/** Entry names. */
	readdir(path: string): Promise<string[]>
}

export const nodeStorageScanFs: StorageScanFs = {
	lstat: p => lstat(p),
	readdir: p => readdir(p),
}

export interface StorageScanLimits {
	maxEntries: number
	maxDepth: number
	maxWallMs: number
	concurrency: number
}

export const DEFAULT_STORAGE_SCAN_LIMITS: StorageScanLimits = {
	maxEntries: STORAGE_SCAN_MAX_ENTRIES,
	maxDepth: STORAGE_SCAN_MAX_DEPTH,
	maxWallMs: STORAGE_SCAN_MAX_WALL_MS,
	concurrency: STORAGE_SCAN_FS_CONCURRENCY,
}

export interface StorageAreaScan {
	id: StorageAreaId
	bytes: number
	files: number
	exists: boolean
	partialReason: StoragePartialReason | null
}

type BoundReason = "entry-limit" | "time-limit" | "depth-limit"

interface WalkItem {
	path: string
	depth: number
	root: boolean
}

function errnoCode(err: unknown): string | undefined {
	if (typeof err === "object" && err !== null && "code" in err) {
		const code = (err as { code: unknown }).code
		return typeof code === "string" ? code : undefined
	}
	return undefined
}

function errorReason(err: unknown): StoragePartialReason {
	const code = errnoCode(err)
	return code === "EACCES" || code === "EPERM" ? "permission" : "io-error"
}

function isMissing(err: unknown): boolean {
	const code = errnoCode(err)
	return code === "ENOENT"
}

/**
 * Scans every area with one shared budget; results are in input order. The wall deadline is
 * also enforced on stalled I/O: when it fires, a frozen snapshot is returned and late fs
 * completions cannot change it.
 */
export async function scanStorageAreas(
	areas: readonly StorageAreaSource[],
	options: {
		fs?: StorageScanFs
		limits?: Partial<StorageScanLimits>
		now?: () => number
	} = {},
): Promise<StorageAreaScan[]> {
	const fs = options.fs ?? nodeStorageScanFs
	const limits: StorageScanLimits = {
		...DEFAULT_STORAGE_SCAN_LIMITS,
		...options.limits,
	}
	const concurrency = Math.max(1, Math.floor(limits.concurrency))
	const now = options.now ?? Date.now
	const start = now()
	let entries = 0
	let bound: BoundReason | null = null

	/** Reserves one lstat from the shared budget, or records the bound reached. */
	const takeEntry = (): boolean => {
		if (bound !== null) return false
		if (now() - start >= limits.maxWallMs) {
			bound = "time-limit"
			return false
		}
		if (entries >= limits.maxEntries) {
			bound = "entry-limit"
			return false
		}
		entries++
		return true
	}

	const expired = (): boolean => now() - start >= limits.maxWallMs
	/** Post-op deadline check; results landing after the deadline are dropped. */
	const lateCheck = (): boolean => {
		if (!expired()) return false
		bound ??= "time-limit"
		return true
	}

	const results: StorageAreaScan[] = []
	let frozen: StorageAreaScan[] | null = null
	let done = 0
	const snapshot = (reason: BoundReason): StorageAreaScan[] =>
		areas.map((area, i) => {
			const r = results[i]
			if (r === undefined) {
				return {
					id: area.id,
					bytes: 0,
					files: 0,
					exists: false,
					partialReason: reason,
				}
			}
			if (i < done) return { ...r }
			return { ...r, partialReason: r.partialReason ?? reason }
		})

	const run = async (): Promise<StorageAreaScan[]> => {
		for (const area of areas) {
			if (bound !== null) {
				results.push({
					id: area.id,
					bytes: 0,
					files: 0,
					exists: false,
					partialReason: bound,
				})
				continue
			}
			await scanArea(area)
			done++
		}
		return results.map(r => ({ ...r }))
	}

	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<StorageAreaScan[]>(resolve => {
		const remaining = Math.max(0, limits.maxWallMs - (now() - start))
		timer = setTimeout(() => {
			// Preserve the first bound reached (e.g. depth-limit) over the timeout.
			const reason: BoundReason = bound ?? "time-limit"
			bound = reason
			frozen = snapshot(reason)
			resolve(frozen)
		}, remaining)
	})
	try {
		return await Promise.race([run(), deadline])
	} finally {
		clearTimeout(timer)
	}

	async function scanArea(area: StorageAreaSource): Promise<void> {
		const excluded = new Set((area.exclude ?? []).map(p => path.resolve(p)))
		const scan: StorageAreaScan = {
			id: area.id,
			bytes: 0,
			files: 0,
			exists: false,
			partialReason: null,
		}
		results.push(scan)
		const mark = (reason: StoragePartialReason): void => {
			if (frozen !== null) return
			if (scan.partialReason === null) scan.partialReason = reason
		}
		const queue: WalkItem[] = area.paths.map(p => ({
			path: p,
			depth: 0,
			root: true,
		}))
		const inFlight = new Set<Promise<void>>()

		const visit = async (item: WalkItem): Promise<void> => {
			if (excluded.has(path.resolve(item.path))) return
			if (!takeEntry()) return
			let stat: Awaited<ReturnType<StorageScanFs["lstat"]>>
			try {
				stat = await fs.lstat(item.path)
			} catch (err: unknown) {
				if (lateCheck()) return
				if (!isMissing(err)) mark(errorReason(err))
				return
			}
			if (lateCheck() || frozen !== null) return
			if (item.root) scan.exists = true
			if (stat.isFile() || stat.isSymbolicLink()) {
				scan.bytes += stat.size
				scan.files++
				return
			}
			if (!stat.isDirectory()) return
			let names: string[]
			try {
				names = await fs.readdir(item.path)
			} catch (err: unknown) {
				if (lateCheck()) return
				if (!isMissing(err)) mark(errorReason(err))
				return
			}
			if (lateCheck() || frozen !== null) return
			if (names.length === 0) return
			if (item.depth + 1 > limits.maxDepth) {
				bound ??= "depth-limit"
				return
			}
			for (const name of names) {
				queue.push({
					path: path.join(item.path, name),
					depth: item.depth + 1,
					root: false,
				})
			}
		}

		while (queue.length > 0 || inFlight.size > 0) {
			while (
				queue.length > 0 &&
				inFlight.size < concurrency &&
				bound === null
			) {
				const item = queue.pop()
				if (item === undefined) break
				const task: Promise<void> = visit(item)
					.catch((err: unknown) => {
						mark(errorReason(err))
					})
					.finally(() => {
						inFlight.delete(task)
					})
				inFlight.add(task)
			}
			if (bound !== null && inFlight.size === 0) break
			if (inFlight.size > 0) await Promise.race(inFlight)
			else if (bound !== null) break
		}
		if (bound !== null) mark(bound)
	}
}
