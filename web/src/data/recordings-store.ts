/**
 * Recordings (WG8 inventory, WG9 Keep and delete; protected core only): the list of the WAV files
 * WaveKit writes (dsd-fme per-call recordings, scanner recordings), Keep / unkeep, delete with a
 * grace period for Undo, and the file itself for playback. The core sends no event when a file
 * appears, so the drawer refreshes while it is open; the core caches its scan for 2 s.
 */
import {
	RECORDING_DELETE_ROUTE,
	RECORDING_KEEP_ROUTE,
	RECORDINGS_FILE_ROUTE,
	RECORDINGS_PAGE_LIMIT_MAX,
	RECORDINGS_ROUTE,
	RECORDINGS_SCAN_MAX_FILES,
} from "@wavekit/api-types"
import type {
	RecordingDeleteResult,
	RecordingInventoryItem,
	RecordingInventoryPage,
	RecordingKeepResult,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import { Store } from "./store.ts"

/** Pages read per refresh: the core scans at most RECORDINGS_SCAN_MAX_FILES files. */
const MAX_PAGES = Math.ceil(
	RECORDINGS_SCAN_MAX_FILES / RECORDINGS_PAGE_LIMIT_MAX,
)
/** How long a delete waits for Undo before it reaches the core. */
export const RECORDING_DELETE_GRACE_MS = 6000

export interface RecordingsState {
	/** Every listed recording, newest first (the core's order). */
	items: readonly RecordingInventoryItem[]
	loaded: boolean
	loading: boolean
	/** `protected-only`: the routes are not mounted (a core without access protection). */
	unavailable: "protected-only" | null
	error: string | null
	/** The core's scan stopped at its file bound: older files are not listed. */
	truncated: boolean
	scannedAt: string | null
	/** Deleted here, waiting for Undo: hidden from the list until the delete lands or is undone. */
	removing: ReadonlySet<string>
	/** Keep or unkeep in flight. */
	keeping: ReadonlySet<string>
}

const path = (route: string, id: string) =>
	route.replace(":id", encodeURIComponent(id))

function isPage(value: unknown): value is RecordingInventoryPage {
	if (typeof value !== "object" || value === null) return false
	const v = value as Record<string, unknown>
	return (
		Array.isArray(v["items"]) &&
		(v["nextCursor"] === null || typeof v["nextCursor"] === "string")
	)
}

function isItem(value: unknown): value is RecordingInventoryItem {
	if (typeof value !== "object" || value === null) return false
	const v = value as Record<string, unknown>
	return (
		typeof v["id"] === "string" &&
		typeof v["kind"] === "string" &&
		typeof v["modifiedAt"] === "string" &&
		typeof v["bytes"] === "number"
	)
}

const withSet = (set: ReadonlySet<string>, id: string, on: boolean) => {
	const next = new Set(set)
	if (on) next.add(id)
	else next.delete(id)
	return next
}

export class RecordingsStore extends Store<RecordingsState> {
	private readonly api: ApiClient
	private inflight: Promise<void> | null = null
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

	constructor(api: ApiClient) {
		super({
			items: [],
			loaded: false,
			loading: false,
			unavailable: null,
			error: null,
			truncated: false,
			scannedAt: null,
			removing: new Set(),
			keeping: new Set(),
		})
		this.api = api
	}

	/** Reads every page (the first one shows as soon as it lands). Never rejects. */
	refresh(): Promise<void> {
		this.inflight ??= this.fetchAll().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	/** The download link (whole WAV, `Content-Disposition: attachment`). */
	fileUrl(id: string): string {
		return this.api.url(path(RECORDINGS_FILE_ROUTE, id))
	}

	/** The WAV file, for playback in this browser. Rejects with the ApiError. */
	file(id: string, signal?: AbortSignal): Promise<Blob> {
		return this.api.blob(
			path(RECORDINGS_FILE_ROUTE, id),
			signal ? { signal } : {},
		)
	}

	/** Keep (true) or unkeep (false). Shows the change at once; rejects with the ApiError and reverts. */
	async setKept(id: string, kept: boolean): Promise<void> {
		const before = this.get().items.find(i => i.id === id)
		if (!before) return
		this.update(s => ({
			...s,
			items: s.items.map(i => (i.id === id ? { ...i, kept } : i)),
			keeping: withSet(s.keeping, id, true),
		}))
		try {
			const route = path(RECORDING_KEEP_ROUTE, id)
			const result = kept
				? await this.api.put<RecordingKeepResult>(route)
				: await this.api.delete<RecordingKeepResult>(route)
			this.patchItem(id, { kept: result.kept })
		} catch (error) {
			this.patchItem(id, { kept: before.kept === true })
			if (error instanceof ApiError && error.code === "RECORDING_NOT_FOUND")
				this.drop(id)
			throw error
		} finally {
			this.update(s => ({ ...s, keeping: withSet(s.keeping, id, false) }))
		}
	}

	/**
	 * Hides the recording now and deletes it after `graceMs` unless the returned undo runs first.
	 * `onError` hears a failed delete (the recording shows again).
	 */
	scheduleRemove(
		id: string,
		onError: (error: unknown) => void,
		graceMs = RECORDING_DELETE_GRACE_MS,
	): () => void {
		this.cancelTimer(id)
		this.update(s => ({ ...s, removing: withSet(s.removing, id, true) }))
		this.timers.set(
			id,
			setTimeout(() => {
				this.timers.delete(id)
				void this.remove(id).catch(onError)
			}, graceMs),
		)
		return () => {
			if (!this.timers.has(id)) return
			this.cancelTimer(id)
			this.update(s => ({ ...s, removing: withSet(s.removing, id, false) }))
		}
	}

	/** Sends every delete still waiting for Undo (the page is going away). */
	flushRemovals(): void {
		for (const id of [...this.timers.keys()]) {
			this.cancelTimer(id)
			void this.remove(id).catch(() => {})
		}
	}

	/** DELETE now. Rejects with the ApiError (the recording shows again). */
	async remove(id: string): Promise<void> {
		try {
			await this.api.delete<RecordingDeleteResult>(
				path(RECORDING_DELETE_ROUTE, id),
			)
			this.drop(id)
		} catch (error) {
			if (error instanceof ApiError && error.code === "RECORDING_NOT_FOUND") {
				this.drop(id)
				return
			}
			this.update(s => ({ ...s, removing: withSet(s.removing, id, false) }))
			throw error
		}
	}

	dispose(): void {
		this.flushRemovals()
	}

	private drop(id: string): void {
		this.update(s => ({
			...s,
			items: s.items.filter(i => i.id !== id),
			removing: withSet(s.removing, id, false),
		}))
	}

	private patchItem(id: string, patch: Partial<RecordingInventoryItem>): void {
		this.update(s => ({
			...s,
			items: s.items.map(i => (i.id === id ? { ...i, ...patch } : i)),
		}))
	}

	private cancelTimer(id: string): void {
		const t = this.timers.get(id)
		if (t) clearTimeout(t)
		this.timers.delete(id)
	}

	private async fetchAll(): Promise<void> {
		this.update(s => ({ ...s, loading: true }))
		const items: RecordingInventoryItem[] = []
		let cursor: string | null = null
		let truncated = false
		let scannedAt: string | null = null
		try {
			for (let page = 0; page < MAX_PAGES; page++) {
				const body: unknown = await this.api.get<unknown>(RECORDINGS_ROUTE, {
					query: {
						limit: RECORDINGS_PAGE_LIMIT_MAX,
						...(cursor !== null ? { cursor } : {}),
					},
				})
				if (!isPage(body))
					throw new Error(`Unexpected answer from ${RECORDINGS_ROUTE}`)
				for (const item of body.items) if (isItem(item)) items.push(item)
				truncated = body.truncated === true
				scannedAt = typeof body.scannedAt === "string" ? body.scannedAt : null
				cursor = body.nextCursor
				// the first page shows at once on the first load
				if (page === 0 && !this.get().loaded && cursor !== null)
					this.update(s => ({ ...s, items: [...items], loaded: true }))
				if (cursor === null) break
			}
			this.update(s => ({
				...s,
				items,
				loaded: true,
				loading: false,
				unavailable: null,
				error: null,
				truncated,
				scannedAt,
			}))
		} catch (error) {
			const missing =
				error instanceof ApiError &&
				error.status === 404 &&
				error.code !== "RECORDING_NOT_FOUND"
			this.update(s => ({
				...s,
				loading: false,
				loaded: s.loaded || missing,
				unavailable: missing ? "protected-only" : null,
				error: missing ? null : errorMessage(error),
			}))
		}
	}
}
