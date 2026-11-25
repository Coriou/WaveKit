/**
 * Whether a recording an Activity row links is served yet. The core links a row to its file the moment the
 * call ends (or the scanner keeps the file), but its catalogue lists and serves a file only once it has been
 * quiet for RECORDINGS_IN_PROGRESS_MS (10 s, a file still being written): a Play in between met a 404 and the
 * dock said "This recording is no longer on the receiver" about a file still being finalised.
 *
 * So a link first seen while its row is younger than the settle time is "saving" until the file can be
 * listed (its row's age, or the catalogue listing it, whichever comes first), and a fetch of such a file that
 * is still refused is tried again for a bounded while (RecordingsStore.file) instead of failing. A row first
 * seen older than that (history, a replay) is settled at once: a 404 then is the truth.
 *
 * The row's age is read against this browser's clock, which can disagree with the core's. So a link that
 * arrives on the live socket (just linked, whatever its producedAt says: a core clock behind this one makes
 * it look old) and a link newly found on a row already seen without one (a call file found late, which the
 * core adds to the existing row) always get a retry window from now; only the Saving display stays
 * age-based (a wrong guess there costs a few seconds of Saving, never an error).
 */
import type { ActivitySummary } from "@wavekit/api-types"
import { RECORDINGS_IN_PROGRESS_MS } from "@wavekit/api-types"

import { Store } from "./store.ts"

/** From the row's end to a served file: the core's quiet time plus its catalogue's pass. */
export const RECORDING_SETTLE_MS = RECORDINGS_IN_PROGRESS_MS + 2_000
/** How long past its settle time a just-linked file's refused fetch is tried again. */
export const RECORDING_SETTLE_GRACE_MS = 20_000
/** Between two tries of a just-linked file. */
export const RECORDING_RETRY_STEP_MS = 1_500
/** Sightings remembered (the newest win), and as many rows seen without a link. */
const MAX_SIGHTINGS = 2_000

export interface ReadinessClock {
	now(): number
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

const realClock: ReadinessClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: handle => {
		globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
	},
}

interface Sighting {
	/** When the file can be listed (this browser's clock). */
	readyAt: number
	/** Until when a refused fetch is tried again. */
	retryUntil: number
}

/**
 * How long until a link on a row produced at `producedAt` can be served, seen at `now`: 0 when already
 * past (or the time is unreadable), never more than RECORDING_SETTLE_MS (a core clock ahead of this one
 * cannot hold it longer).
 */
export function settleDelay(producedAt: string, now: number): number {
	const at = Date.parse(producedAt)
	if (!Number.isFinite(at)) return 0
	const age = Math.max(0, now - at)
	return Math.max(0, RECORDING_SETTLE_MS - age)
}

export class RecordingReadiness {
	/** Recording ids still being saved by the core (not served yet), with when they should be. */
	readonly saving = new Store<ReadonlyMap<string, number>>(new Map())
	private readonly seen = new Map<string, Sighting>()
	/** Event ids of rows seen without a link (a late call file adds one to the same row). */
	private readonly unlinked = new Set<string>()
	private readonly clock: ReadinessClock
	private timer: unknown = null
	private timerAt = Infinity

	constructor(clock: ReadinessClock = realClock) {
		this.clock = clock
	}

	/**
	 * Rows read or received: a link seen for the first time while young is saving. `live`: the rows came on
	 * the live socket (just produced, whatever the core's clock says).
	 */
	note(
		items: readonly ActivitySummary[],
		{ live = false }: { live?: boolean } = {},
	): void {
		const now = this.clock.now()
		let added: Map<string, number> | null = null
		for (const item of items) {
			const id = item.recording?.id
			if (typeof id !== "string" || id === "") {
				this.rememberUnlinked(item.eventId)
				continue
			}
			// a link added to a row seen before without one: found just now
			const late = this.unlinked.delete(item.eventId)
			if (this.seen.has(id)) continue
			const delay = settleDelay(item.producedAt, now)
			const readyAt = now + delay
			const fresh = live || late
			this.remember(id, {
				readyAt,
				retryUntil: fresh
					? now + RECORDING_SETTLE_MS + RECORDING_SETTLE_GRACE_MS
					: delay > 0
						? readyAt + RECORDING_SETTLE_GRACE_MS
						: 0,
			})
			if (delay > 0) {
				added ??= new Map(this.saving.get())
				added.set(id, readyAt)
			}
		}
		if (added !== null) {
			this.saving.set(added)
			this.arm()
		}
	}

	/** The catalogue lists these ids (or keys): served now. */
	listed(ids: Iterable<string>): void {
		const current = this.saving.get()
		let next: Map<string, number> | null = null
		for (const id of ids) {
			const s = this.seen.get(id)
			if (s !== undefined) s.readyAt = Math.min(s.readyAt, this.clock.now())
			if (!current.has(id)) continue
			next ??= new Map(current)
			next.delete(id)
		}
		if (next !== null) this.saving.set(next)
	}

	/** Whether `id` is still being saved. */
	isSaving(id: string): boolean {
		return this.saving.get().has(id)
	}

	/**
	 * How long to wait before trying a refused fetch of `id` again; null when it is not to be tried again
	 * (not a just-linked file, or past its grace).
	 */
	retryIn(id: string): number | null {
		const s = this.seen.get(id)
		if (s === undefined) return null
		const now = this.clock.now()
		if (now >= s.retryUntil) return null
		return Math.min(
			Math.max(s.readyAt - now, RECORDING_RETRY_STEP_MS),
			s.retryUntil - now,
		)
	}

	/** Waits `ms` on this clock; rejects with the signal's reason when aborted. */
	wait(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason as Error)
				return
			}
			const handle = this.clock.setTimeout(() => {
				signal?.removeEventListener("abort", onAbort)
				resolve()
			}, ms)
			const onAbort = () => {
				this.clock.clearTimeout(handle)
				reject(signal?.reason as Error)
			}
			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}

	/**
	 * These ids (or keys) were deleted: no Saving and no retry window for them any more (a row still
	 * linking one reads as gone at once, not after ~30 s of tries).
	 */
	forget(ids: Iterable<string>): void {
		const current = this.saving.get()
		let next: Map<string, number> | null = null
		for (const id of ids) {
			this.seen.delete(id)
			if (!current.has(id)) continue
			next ??= new Map(current)
			next.delete(id)
		}
		if (next !== null) this.saving.set(next)
	}

	/** Forgets everything (tests, a new pairing or a session that ended: data/index.ts). */
	reset(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer)
		this.timer = null
		this.timerAt = Infinity
		this.seen.clear()
		this.unlinked.clear()
		this.saving.set(new Map())
	}

	private remember(id: string, s: Sighting): void {
		this.seen.set(id, s)
		while (this.seen.size > MAX_SIGHTINGS) {
			const oldest = this.seen.keys().next().value
			if (oldest === undefined) break
			this.seen.delete(oldest)
		}
	}

	private rememberUnlinked(eventId: string): void {
		if (typeof eventId !== "string" || eventId === "") return
		this.unlinked.delete(eventId)
		this.unlinked.add(eventId)
		while (this.unlinked.size > MAX_SIGHTINGS) {
			const oldest = this.unlinked.values().next().value
			if (oldest === undefined) break
			this.unlinked.delete(oldest)
		}
	}

	/** One timer, at the earliest readyAt: each due id turns playable. */
	private arm(): void {
		const saving = this.saving.get()
		if (saving.size === 0) return
		const first = Math.min(...saving.values())
		if (this.timer !== null && this.timerAt <= first) return
		if (this.timer !== null) this.clock.clearTimeout(this.timer)
		this.timerAt = first
		this.timer = this.clock.setTimeout(
			() => {
				this.timer = null
				this.timerAt = Infinity
				this.expire()
			},
			Math.max(0, first - this.clock.now()),
		)
	}

	private expire(): void {
		const now = this.clock.now()
		const current = this.saving.get()
		const next = new Map<string, number>()
		for (const [id, at] of current) if (at > now) next.set(id, at)
		if (next.size !== current.size) this.saving.set(next)
		this.arm()
	}
}

/** The app's one readiness (Activity feeds note links, the recordings store lists and fetches). */
export const recordingReadiness = new RecordingReadiness()
