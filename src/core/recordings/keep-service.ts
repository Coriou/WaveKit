/**
 * WG9 lane RK: the recording protection coordinator (docs/specs/web-gaps-9, requirement 2,
 * design "Recording Keep and deletion", Coordinator). Owns the single deletion decision every
 * deletion owner consults (`RecordingProtection`, synchronous, O(1), no IO, fail closed) and the
 * Keep, unkeep and delete operations the routes call.
 *
 * Memory: `protecting` (committed keeps plus a Keep whose write is in flight: a deleter sees it
 * protected at once), `deleting` (keys with a delete requested or running) and a per-discovery
 * count of protecting scanner keys. One async mutex per key (map entries removed when idle) and
 * one commit chain (read-modify-write of the store file, so concurrent Keeps never lose each
 * other and the bounds hold across them).
 *
 * Logs: component logger `RecordingKeeps`; fixed text, codes and counts only; never a key, id,
 * path or file name. Imports stay minimal (contract, store, inventory types) so the deleters can
 * import the port without pulling runtime modules into the startup bundle.
 */
import {
	RECORDING_INVENTORY_ID,
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
} from "@wavekit/api-types"
import type {
	RecordingDeleteResult,
	RecordingKeepResult,
} from "@wavekit/api-types"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"
import {
	RECORDING_KEEP_KEY,
	RecordingKeepError,
	dsdFmeKeepKey,
	recordingKeepKeyOf,
	scannerKeepKey,
} from "./contract.js"
import type {
	RecordingKeepEntry,
	RecordingKeepKey,
	RecordingKeepService,
	RecordingKeepTotals,
	RecordingKeepTotalsSource,
	RecordingKeepsFile,
	ScannerRecordingDeleter,
} from "./contract.js"
import type { RecordingInventory } from "./inventory.js"
import {
	RECORDING_KEEPS_LIMIT_TEXT,
	RECORDING_KEEPS_UNAVAILABLE_TEXT,
	openRecordingKeepStore,
} from "./keep-store.js"
import type { RecordingKeepStore, RecordingKeepsFs } from "./keep-store.js"
import {
	RECORDING_BUSY_TEXT,
	RECORDING_DELETE_FAILED_TEXT,
	RECORDING_DELETE_UNSUPPORTED_TEXT,
	nodeRecordingDeleteFs,
	verifiedUnlink,
} from "./verified-unlink.js"
import type { RecordingDeleteFs } from "./verified-unlink.js"

export const RECORDING_NOT_FOUND_TEXT = "Recording not found"
export const RECORDING_KEPT_TEXT = "Recording is kept; unkeep it first"
export {
	RECORDING_BUSY_TEXT,
	RECORDING_DELETE_FAILED_TEXT,
	RECORDING_DELETE_UNSUPPORTED_TEXT,
}

export type { RecordingDeleteFs } from "./verified-unlink.js"
export { RECORDING_DELETE_PRIVATE_PREFIX } from "./verified-unlink.js"

/**
 * WG9's fixed name of the moved recording inside the private directory. WG10 deletes no longer
 * use it (the moved entry keeps its basename, then becomes `verified`); a WG9-format leftover
 * carries it and the startup sweep leaves it in place.
 */
export const RECORDING_DELETE_INNER_NAME = "recording"

export interface RecordingKeepServiceOptions {
	stateDir: string
	inventory: RecordingInventory
	logger: Logger
	now?: () => number
	/** Test seam: the store's filesystem. */
	storeFs?: RecordingKeepsFs
	/** Test seam: the delete's `lstat` and `unlink`. */
	deleteFs?: RecordingDeleteFs
	/**
	 * WG10 req 1.1: the scanner side of a `scan:` delete. Absent: a `scan:` delete answers 409
	 * RECORDING_DELETE_UNSUPPORTED (WG9 behaviour).
	 */
	scannerDeleter?: ScannerRecordingDeleter
}

/** WG10 req 1.8: the service also reports the keep store's totals. */
export type OpenedRecordingKeepService = RecordingKeepService &
	RecordingKeepTotalsSource

/** The service plus a test-only view of its bounded maps. */
export interface RecordingKeepServiceInternal
	extends RecordingKeepService, RecordingKeepTotalsSource {
	/** Keys with a live mutex entry (0 when idle). */
	mutexCount(): number
}

function notFound(): RecordingKeepError {
	return new RecordingKeepError("RECORDING_NOT_FOUND", RECORDING_NOT_FOUND_TEXT)
}

function unavailable(): RecordingKeepError {
	return new RecordingKeepError(
		"RECORDING_KEEPS_UNAVAILABLE",
		RECORDING_KEEPS_UNAVAILABLE_TEXT,
	)
}

function limit(): RecordingKeepError {
	return new RecordingKeepError(
		"RECORDING_KEEP_LIMIT",
		RECORDING_KEEPS_LIMIT_TEXT,
	)
}

/** The discovery id of a scanner keep key, or null for a dsd key. */
function discoveryOf(key: RecordingKeepKey): string | null {
	const m = RECORDING_KEEP_KEY.exec(key)
	return m?.[2] ?? null
}

/**
 * Opens the store and returns the coordinator. Resolves after the load in state `ready` or
 * `failed`; never rejects.
 */
export async function openRecordingKeepService(
	options: RecordingKeepServiceOptions,
): Promise<OpenedRecordingKeepService> {
	const log = createComponentLogger(options.logger, "RecordingKeeps")
	const inventory = options.inventory
	const deleteFs = options.deleteFs ?? nodeRecordingDeleteFs
	const scannerDeleter = options.scannerDeleter
	const nowFn = options.now ?? Date.now
	let store: RecordingKeepStore | null = null
	try {
		store = await openRecordingKeepStore({
			stateDir: options.stateDir,
			log,
			...(options.storeFs ? { fs: options.storeFs } : {}),
		})
	} catch (error: unknown) {
		// openRecordingKeepStore does not reject; this keeps the promise of never rejecting.
		log.warn(
			{ err: safeErrorFields(error) },
			"Recording keep store could not be opened",
		)
	}
	const ready = (): boolean => store !== null && store.state() === "ready"

	const protecting = new Set<RecordingKeepKey>()
	const deleting = new Map<RecordingKeepKey, number>()
	const discoveryCounts = new Map<string, number>()
	const mutexes = new Map<
		RecordingKeepKey,
		{ tail: Promise<void>; n: number }
	>()
	let commitChain: Promise<void> = Promise.resolve()

	const protect = (key: RecordingKeepKey): void => {
		if (protecting.has(key)) return
		protecting.add(key)
		const d = discoveryOf(key)
		if (d !== null) discoveryCounts.set(d, (discoveryCounts.get(d) ?? 0) + 1)
	}
	const unprotect = (key: RecordingKeepKey): void => {
		if (!protecting.delete(key)) return
		const d = discoveryOf(key)
		if (d === null) return
		const n = (discoveryCounts.get(d) ?? 1) - 1
		if (n <= 0) discoveryCounts.delete(d)
		else discoveryCounts.set(d, n)
	}
	if (store && ready()) for (const e of store.snapshot().keeps) protect(e.key)

	/** WG10 req 1.8: count and byte sum of the committed keeps (recomputed per write, O(1) read). */
	let totals: RecordingKeepTotals = { recordings: 0, bytes: 0 }
	function setTotals(file: RecordingKeepsFile): void {
		let bytes = 0
		for (const e of file.keeps) bytes += e.bytes
		totals = { recordings: file.keeps.length, bytes }
	}
	if (store && ready()) setTotals(store.snapshot())

	/** Runs `fn` alone for `key`; the map entry is removed once nothing waits on it. */
	async function withMutex<T>(
		key: RecordingKeepKey,
		fn: () => Promise<T>,
	): Promise<T> {
		let slot = mutexes.get(key)
		if (!slot) {
			slot = { tail: Promise.resolve(), n: 0 }
			mutexes.set(key, slot)
		}
		const s = slot
		s.n++
		const prev = s.tail
		let release = (): void => undefined
		s.tail = new Promise<void>(resolve => {
			release = resolve
		})
		try {
			await prev
			return await fn()
		} finally {
			release()
			s.n--
			if (s.n === 0 && mutexes.get(key) === s) mutexes.delete(key)
		}
	}

	/** Read-modify-write of the store file, serialised across keys. */
	function commit(
		change: (file: RecordingKeepsFile) => RecordingKeepsFile,
	): Promise<void> {
		const run = async (): Promise<void> => {
			const s = store
			if (!s || !ready()) throw unavailable()
			const next = change(s.snapshot())
			await s.write(next)
			setTotals(next)
		}
		const result = commitChain.then(run)
		commitChain = result.catch(() => undefined)
		return result
	}

	function nextRevision(file: RecordingKeepsFile): number {
		const r = file.revision + 1
		if (!Number.isSafeInteger(r)) throw unavailable()
		return r
	}

	function keptAtNow(): string {
		const t = nowFn()
		const d = new Date(Number.isFinite(t) ? t : Date.now())
		return Number.isNaN(d.getTime())
			? new Date().toISOString()
			: d.toISOString()
	}

	function isProtected(key: RecordingKeepKey): boolean {
		return !ready() || protecting.has(key) || deleting.has(key)
	}

	function markDeleting(key: RecordingKeepKey): void {
		deleting.set(key, (deleting.get(key) ?? 0) + 1)
	}
	function clearDeleting(key: RecordingKeepKey): void {
		const n = (deleting.get(key) ?? 1) - 1
		if (n <= 0) deleting.delete(key)
		else deleting.set(key, n)
	}

	function invalidate(): void {
		try {
			inventory.invalidate?.()
		} catch (error: unknown) {
			log.debug(
				{ err: safeErrorFields(error) },
				"Recording inventory invalidation failed",
			)
		}
	}

	async function keep(inventoryId: string): Promise<RecordingKeepResult> {
		if (!ready()) throw unavailable()
		const key = recordingKeepKeyOf(inventoryId)
		if (key === null) throw notFound()
		// A delete requested or running for this key wins (the other one won).
		if (deleting.has(key))
			throw new RecordingKeepError("RECORDING_BUSY", RECORDING_BUSY_TEXT)
		return withMutex(key, async () => {
			if (!ready()) throw unavailable()
			const alreadyKept =
				store?.snapshot().keeps.some(e => e.key === key) === true
			const wasProtecting = protecting.has(key)
			// Pending keep: protected from before the inventory open, so a deleter that runs during
			// the open, the close or the write sees it protected. Cleared again on any failure.
			protect(key)
			let bytes: number
			try {
				// Verified even when already kept: a vanished or ineligible file answers 404 (only
				// unkeep tolerates a gone file).
				const opened = await inventory.open(inventoryId)
				if (!opened) throw notFound()
				try {
					bytes = opened.stat.size
				} finally {
					await opened.handle.close().catch(() => undefined)
				}
				if (!Number.isSafeInteger(bytes) || bytes < 0) throw notFound()
			} catch (error: unknown) {
				if (!wasProtecting && !alreadyKept) unprotect(key)
				if (error instanceof RecordingKeepError) throw error
				log.warn({ err: safeErrorFields(error) }, "Recording Keep failed")
				throw unavailable()
			}
			if (alreadyKept) return { id: inventoryId, kept: true, changed: false }
			try {
				await commit(file => {
					if (file.keeps.some(e => e.key === key)) return file
					if (file.keeps.length + 1 > RECORDING_KEEPS_MAX_ENTRIES) throw limit()
					let total = bytes
					for (const e of file.keeps) total += e.bytes
					if (total > RECORDING_KEEPS_MAX_BYTES) throw limit()
					const entry: RecordingKeepEntry = {
						key,
						keptAt: keptAtNow(),
						bytes,
					}
					return {
						schemaVersion: file.schemaVersion,
						revision: nextRevision(file),
						keeps: [...file.keeps, entry],
					}
				})
			} catch (error: unknown) {
				if (!wasProtecting) unprotect(key)
				if (error instanceof RecordingKeepError) {
					log.info({ code: error.code }, "Recording Keep refused")
					throw error
				}
				log.warn({ err: safeErrorFields(error) }, "Recording Keep failed")
				throw unavailable()
			}
			invalidate()
			log.info({ kept: protecting.size }, "Recording kept")
			return { id: inventoryId, kept: true, changed: true }
		})
	}

	async function unkeep(inventoryId: string): Promise<RecordingKeepResult> {
		if (!ready()) throw unavailable()
		const key = recordingKeepKeyOf(inventoryId)
		if (key === null) throw notFound()
		return withMutex(key, async () => {
			if (!ready()) throw unavailable()
			if (!store?.snapshot().keeps.some(e => e.key === key))
				return { id: inventoryId, kept: false, changed: false }
			try {
				// Write first: a failed write keeps it protected.
				await commit(file => ({
					schemaVersion: file.schemaVersion,
					revision: nextRevision(file),
					keeps: file.keeps.filter(e => e.key !== key),
				}))
			} catch (error: unknown) {
				if (error instanceof RecordingKeepError) {
					log.info({ code: error.code }, "Recording unkeep refused")
					throw error
				}
				log.warn({ err: safeErrorFields(error) }, "Recording unkeep failed")
				throw unavailable()
			}
			unprotect(key)
			invalidate()
			log.info({ kept: protecting.size }, "Recording unkept")
			return { id: inventoryId, kept: false, changed: true }
		})
	}

	/** WG9 delete through the shared WG10 verified unlink; kept or busy answers 409. */
	async function deleteVerified(
		key: RecordingKeepKey,
		filePath: string,
		handleStat: { dev: number; ino: number },
	): Promise<void> {
		const outcome = await verifiedUnlink({
			filePath,
			handleStat,
			stillDeletable: () => ready() && !protecting.has(key),
			fs: deleteFs,
			log,
		})
		if (outcome === "not-found") throw notFound()
		if (outcome === "protected")
			throw new RecordingKeepError("RECORDING_KEPT", RECORDING_KEPT_TEXT)
	}

	async function remove(inventoryId: string): Promise<RecordingDeleteResult> {
		if (!ready()) throw unavailable()
		const m =
			typeof inventoryId === "string"
				? RECORDING_INVENTORY_ID.exec(inventoryId)
				: null
		if (!m) throw notFound()
		const scannerId = m[3]
		const deleter = scannerDeleter
		if (scannerId !== undefined && deleter === undefined)
			throw new RecordingKeepError(
				"RECORDING_DELETE_UNSUPPORTED",
				RECORDING_DELETE_UNSUPPORTED_TEXT,
			)
		const key = recordingKeepKeyOf(inventoryId)
		if (key === null) throw notFound()
		if (protecting.has(key))
			throw new RecordingKeepError("RECORDING_KEPT", RECORDING_KEPT_TEXT)
		// Marked before the mutex: a Keep arriving from now on is refused RECORDING_BUSY, and every
		// deletion decision on this key answers protected until the delete ends.
		markDeleting(key)
		try {
			return await withMutex(key, async () => {
				if (!ready()) throw unavailable()
				if (protecting.has(key))
					throw new RecordingKeepError("RECORDING_KEPT", RECORDING_KEPT_TEXT)
				if (scannerId !== undefined && deleter !== undefined)
					await deleteScanner(key, scannerId, deleter)
				else await deleteDsd(key, inventoryId)
				log.info({}, "Recording deleted")
				return { id: inventoryId, deleted: true as const }
			})
		} finally {
			clearDeleting(key)
			invalidate()
		}
	}

	async function deleteDsd(
		key: RecordingKeepKey,
		inventoryId: string,
	): Promise<void> {
		const opened = await inventory.open(inventoryId)
		if (!opened) throw notFound()
		try {
			await deleteVerified(key, opened.path, await opened.handle.stat())
		} catch (error: unknown) {
			if (error instanceof RecordingKeepError) throw error
			log.warn({ err: safeErrorFields(error) }, "Recording delete failed")
			throw new RecordingKeepError(
				"RECORDING_DELETE_FAILED",
				RECORDING_DELETE_FAILED_TEXT,
			)
		} finally {
			await opened.handle.close().catch(() => undefined)
		}
	}

	/** WG10 req 1.1-1.3: the scanner side verifies, unlinks and updates its bookkeeping. */
	async function deleteScanner(
		key: RecordingKeepKey,
		recordingId: string,
		deleter: ScannerRecordingDeleter,
	): Promise<void> {
		let outcome: "deleted" | "not-found"
		try {
			outcome = await deleter.deleteRecording(
				recordingId,
				() => ready() && !protecting.has(key),
			)
		} catch (error: unknown) {
			if (error instanceof RecordingKeepError) throw error
			log.warn({ err: safeErrorFields(error) }, "Recording delete failed")
			throw new RecordingKeepError(
				"RECORDING_DELETE_FAILED",
				RECORDING_DELETE_FAILED_TEXT,
			)
		}
		if (outcome === "deleted") return
		// The deleter deletes nothing while the decision is false: name why.
		if (!ready()) throw unavailable()
		if (protecting.has(key))
			throw new RecordingKeepError("RECORDING_KEPT", RECORDING_KEPT_TEXT)
		throw notFound()
	}

	const service: RecordingKeepServiceInternal = {
		isProtected,
		isDsdFmeFileProtected(basename) {
			if (!ready()) return true
			const key = dsdFmeKeepKey(basename)
			return key === null ? false : isProtected(key)
		},
		isScannerFileProtected(discoveryId, basename) {
			if (!ready()) return true
			const key = scannerKeepKey(discoveryId, basename)
			return key === null ? false : isProtected(key)
		},
		discoveryHoldsKept(discoveryId) {
			if (!ready()) return true
			return (discoveryCounts.get(discoveryId) ?? 0) > 0
		},
		keep,
		unkeep,
		remove,
		state: () => (store === null ? "failed" : store.state()),
		totals: () => (ready() ? { ...totals } : null),
		async close() {
			await commitChain
			await store?.close()
		},
		mutexCount: () => mutexes.size,
	}
	return service
}
