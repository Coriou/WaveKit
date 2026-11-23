// Plays recordings in this browser, wherever they are listed: one service per app (services.playback), so
// playback outlives every panel, and one transport (the PlayerDock). One <audio> element on a blob of the WAV
// (the core's file route sends no ranges, so the whole file is fetched once and seeks are local). Live audio
// is muted while a recording loads to play or plays (one subscriber calls holdLive on every change, so every
// path restores it). A finished recording plays the next one of the list it was started from (a snapshot the
// surface refreshes while it is shown) when Auto-next is on (per browser), or always for a Play all queue. Waveform
// peaks come from the same blob.
//
// One player model. Every surface (a Recordings row, an Activity row or detail, the Transmission view, the tuned
// card) only drives this service: its disc toggles it, its waveform seeks it, nothing holds a second <audio> or
// a second transport. The dock (PlayerDock) is the one transport and always names what plays and can close it.
//
// Transitions (event → next phase; "–" stays). `play row` is a row's disc or a waveform click, `play all` a list's
// Play all (its first entry, with the list as queue), `next/prev` the transport's or Auto-next's step, `end` the
// file playing to its end, `error` a failed fetch or a failed element. A play of another recording always goes
// to loading; next/prev with no entry that way do nothing (prev past PREV_RESTART_S restarts the same one).
//
// | from \ event | play row  | play all | next/prev           | close | end                              | error |
// | ------------ | --------- | -------- | ------------------- | ----- | -------------------------------- | ----- |
// | idle         | loading   | loading  | –                   | –     | –                                | –     |
// | loading      | loading   | loading  | loading (the other) | idle  | –                                | error |
// | playing      | loading¹  | loading¹ | loading (the other) | idle  | loading (Auto-next) or ended     | error |
// | paused       | loading¹  | loading¹ | loading (the other) | idle  | –                                | error |
// | ended        | loading¹  | loading¹ | loading (the other) | idle  | –                                | –     |
// | error        | loading   | loading  | loading (the other) | idle  | –                                | –     |
//
// ¹ the same recording again plays on from where it is asked (playing), without a new fetch.
import { errorMessage, isApiError, Store } from "../../data/index.ts"
import { wavPeaks } from "./wav.ts"

export type PlaybackPhase =
	| "idle"
	| "loading"
	| "playing"
	| "paused"
	| "ended"
	| "error"

/** Where a recording was played from: its list is the queue Next, Prev and Auto-next follow. */
export type QueueSource = "activity" | "recordings" | "tuned"

export interface QueueRef {
	source: QueueSource
	/** Which list of the source (Activity: the drawer's or a pinned column's); only that list refreshes it. */
	list?: string
	/** Recording ids of the rows that have audio, in the order shown. */
	ids: readonly string[]
	/** What the dock calls each one (the row's title). */
	titles?: Readonly<Record<string, string>>
	/** Started by a Play all: each one plays on into the next to the queue's end, whatever Auto-next says. */
	playAll?: boolean
}

export interface PlaybackState {
	/** The recording in the player; null exactly when idle. */
	id: string | null
	phase: PlaybackPhase
	/** Seconds. */
	pos: number
	duration: number | null
	speed: number
	error: string | null
	queue: QueueRef | null
	autoNext: boolean
	/** Play once loaded (false: a pause or Listen came while it loaded). */
	wantPlay: boolean
	/** The title the surface gave with play(), for a queue that does not name it. */
	title: string | null
}

export const SPEEDS = [1, 1.5, 2] as const
export const WAVE_BARS = 96
export const AUTO_NEXT_KEY = "wk.playback.autoNext"
/** Prev past this many seconds goes back to the start of the same recording. */
export const PREV_RESTART_S = 2

/** The part of HTMLAudioElement the service drives (a fake in tests). */
export interface AudioLike {
	src: string
	currentTime: number
	readonly duration: number
	playbackRate: number
	preservesPitch?: boolean
	/** True after the end (a "pause" event then is the end's, not a pause). */
	readonly ended?: boolean
	/** The element's own state when an event is handled (a queued pause event after a play is old news). */
	readonly paused?: boolean
	play(): Promise<void>
	pause(): void
	removeAttribute(name: string): void
	load(): void
	addEventListener(type: string, fn: () => void): void
}

/** The part of Storage the Auto-next switch uses. */
export interface KeyValueStore {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
}

export interface PlaybackDeps {
	/** The WAV file (RecordingsStore.file). */
	fetchFile(id: string): Promise<Blob>
	/** Mutes (true) or unmutes live audio (ListenController.hold). */
	holdLive(held: boolean): void
	createAudio?: () => AudioLike
	createUrl?: (blob: Blob) => string
	revokeUrl?: (url: string) => void
	/** Default: localStorage (null: none). */
	storage?: KeyValueStore | null
}

interface Cached {
	blob: Blob
	url: string
	peaks: number[] | null
}

/** A fetch that landed after forget() or dispose(): it keeps nothing, and its waveform is not "none". */
class StaleFetchError extends Error {}

/** Files kept for replay and waveforms (call WAVs are a few hundred kB). */
const CACHE_MAX = 16

/** What the dock says when the file could not be fetched (the core's refusals carry a code, not a sentence). */
export function fileErrorText(error: unknown): string {
	if (isApiError(error))
		switch (error.status) {
			case 401:
				return "Session expired, pair again"
			case 404:
			case 410:
				return "This recording is no longer on the receiver"
			case 429:
				return "Too many recordings are being read; try again in a moment"
			case 503:
				return "The receiver is busy; try again"
		}
	return errorMessage(error)
}

/** Live audio is muted while this holds (invariant I2). */
export function heldOf(s: PlaybackState): boolean {
	return s.phase === "playing" || (s.phase === "loading" && s.wantPlay)
}

/** The queue entry after (by 1) or before (by -1) `id`; null when `id` is not in it or at its end. */
export function queueStep(
	queue: QueueRef | null,
	id: string | null,
	by: 1 | -1,
): string | null {
	if (queue === null || id === null) return null
	const i = queue.ids.indexOf(id)
	if (i < 0) return null
	return queue.ids[i + by] ?? null
}

/** Prev restarts the recording (past PREV_RESTART_S) or steps back in the queue; false when it would do nothing. */
export function canPrev(s: PlaybackState): boolean {
	if (s.id === null) return false
	if (restartsOnPrev(s)) return true
	return queueStep(s.queue, s.id, -1) !== null
}

function restartsOnPrev(s: PlaybackState): boolean {
	return s.pos > PREV_RESTART_S && s.phase !== "loading"
}

/** "2 of 7"; null when the recording is not in its queue. */
export function queuePosition(s: PlaybackState): string | null {
	if (s.queue === null || s.id === null) return null
	const i = s.queue.ids.indexOf(s.id)
	return i < 0 ? null : `${i + 1} of ${s.queue.ids.length}`
}

/** What every surface marks: the phase of `id` when it is the one in the player, else null. */
export const markOf =
	(id: string) =>
	(s: PlaybackState): PlaybackPhase | null =>
		s.id === id ? s.phase : null

/**
 * A disc's click pauses (it says Pause, pressed) while the recording plays, and while it loads to play: a
 * click then cancels the start.
 */
export function discPauses(
	phase: PlaybackPhase | null,
	wantPlay: boolean,
): boolean {
	return phase === "playing" || (phase === "loading" && wantPlay)
}

/** Same keys with the same values (titles are rebuilt on every render, so identity says nothing). */
function sameTitles(
	a: Readonly<Record<string, string>> | undefined,
	b: Readonly<Record<string, string>> | undefined,
): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false
	const keys = Object.keys(a)
	return (
		keys.length === Object.keys(b).length &&
		keys.every(k => Object.hasOwn(b, k) && a[k] === b[k])
	)
}

function defaultStorage(): KeyValueStore | null {
	try {
		return globalThis.localStorage ?? null
	} catch {
		return null
	}
}

function readAutoNext(storage: KeyValueStore | null): boolean {
	try {
		const v = storage?.getItem(AUTO_NEXT_KEY) ?? null
		return v === null ? true : v !== "0"
	} catch {
		return true
	}
}

export class PlaybackService extends Store<PlaybackState> {
	private readonly deps: PlaybackDeps
	private readonly storage: KeyValueStore | null
	private el: AudioLike | null = null
	private readonly cache = new Map<string, Cached>()
	/**
	 * Fetches in flight, one per file. forget() and dispose() drop the entry: a fetch no longer listed
	 * here when it lands keeps nothing (no object URL, no cache, no peaks), and a new play fetches anew.
	 */
	private readonly loading = new Map<string, Promise<Cached>>()
	private disposed = false
	private abort: AbortController | null = null
	/** Bumped at every play, src set and stop; element events and play() results of an older one are stale. */
	private epoch = 0
	/** The epoch the element's current src was set in (events count only while it is the current one). */
	private srcEpoch = -1
	/** Bumped at every start (el.play()); only the latest start's rejection pauses. */
	private starts = 0
	private readonly offHold: () => void
	private readonly peakStore = new Store<
		ReadonlyMap<string, number[] | "none">
	>(new Map())

	constructor(deps: PlaybackDeps) {
		const storage = deps.storage === undefined ? defaultStorage() : deps.storage
		super({
			id: null,
			phase: "idle",
			pos: 0,
			duration: null,
			speed: 1,
			error: null,
			queue: null,
			autoNext: readAutoNext(storage),
			wantPlay: false,
			title: null,
		})
		this.deps = deps
		this.storage = storage
		// the one place live audio is held and restored
		let held = false
		this.offHold = this.subscribe(s => {
			const h = heldOf(s)
			if (h === held) return
			held = h
			deps.holdLive(h)
		})
	}

	/** Peaks per recording id ("none" when the file is not a WAV this reads). */
	get peaks(): Store<ReadonlyMap<string, number[] | "none">> {
		return this.peakStore
	}

	/** Plays `id` from `at` seconds; `queue` is the list it was played from (kept for the same id when omitted). */
	play(id: string, queue?: QueueRef, at = 0, title?: string): void {
		const s = this.get()
		if (s.id === id && s.phase === "loading") {
			// no second fetch: it plays when it lands
			this.set({
				...s,
				wantPlay: true,
				queue: queue ?? s.queue,
				title: title ?? s.title,
			})
			return
		}
		if (
			s.id === id &&
			(s.phase === "playing" || s.phase === "paused" || s.phase === "ended")
		) {
			this.set({ ...s, queue: queue ?? s.queue, title: title ?? s.title })
			this.seek(at)
			const el = this.el
			if (el) this.start(el)
			return
		}
		this.abort?.abort()
		const abort = new AbortController()
		this.abort = abort
		this.el?.pause()
		this.epoch += 1
		const token = this.epoch
		this.set({
			...s,
			id,
			phase: "loading",
			pos: Math.max(0, at),
			duration: null,
			error: null,
			wantPlay: true,
			queue: queue ?? (s.id === id ? s.queue : null),
			title: title ?? (s.id === id ? s.title : null),
		})
		this.load(id, abort.signal).then(
			file => this.loaded(id, token, file),
			(error: unknown) => {
				if (abort.signal.aborted || token !== this.epoch) return
				this.update(x => ({
					...x,
					phase: "error",
					error: fileErrorText(error),
				}))
			},
		)
	}

	/** Play or pause; an ended one starts again, a failed one is fetched again from where it was. */
	toggle(): void {
		const s = this.get()
		if (s.id === null) return
		switch (s.phase) {
			case "loading":
				this.set({ ...s, wantPlay: !s.wantPlay })
				return
			case "playing":
				this.pause()
				return
			case "error":
				this.play(s.id, s.queue ?? undefined, s.pos)
				return
			default:
				this.resume()
		}
	}

	/** Pauses (a loading one will not start); also what Listen calls when it starts. */
	pause(): void {
		const s = this.get()
		if (s.phase === "loading") {
			if (s.wantPlay) this.set({ ...s, wantPlay: false })
			return
		}
		if (s.phase !== "playing") return
		this.el?.pause()
		this.set({ ...s, phase: "paused" })
	}

	resume(): void {
		const s = this.get()
		if (s.phase === "loading") {
			if (!s.wantPlay) this.set({ ...s, wantPlay: true })
			return
		}
		const el = this.el
		if (!el || (s.phase !== "paused" && s.phase !== "ended")) return
		if (s.phase === "ended") {
			el.currentTime = 0
			this.set({ ...s, pos: 0 })
		}
		this.start(el)
	}

	/** Seconds into the current recording (kept while it loads, applied when it lands). */
	seek(seconds: number): void {
		const s = this.get()
		if (s.id === null) return
		if (s.phase === "loading" || s.phase === "error") {
			this.set({ ...s, pos: Math.max(0, seconds) })
			return
		}
		const max = s.duration ?? Number.POSITIVE_INFINITY
		const pos = Math.min(max, Math.max(0, seconds))
		if (this.el) this.el.currentTime = pos
		this.set({ ...s, pos, phase: s.phase === "ended" ? "paused" : s.phase })
	}

	/**
	 * A click on a recording's waveform: the current one goes there and plays on from there (a paused or
	 * ended one resumes); another one starts there.
	 */
	seekOrPlay(
		id: string,
		seconds: number,
		queue: QueueRef,
		title?: string,
	): void {
		const s = this.get()
		if (s.id !== id) {
			this.play(id, queue, seconds, title)
			return
		}
		if (s.phase === "error") {
			this.play(id, s.queue ?? queue, seconds, title)
			return
		}
		this.seek(seconds)
		if (s.phase !== "playing") this.resume()
	}

	/** The next recording of the queue; nothing at its end. */
	next(): void {
		const s = this.get()
		const target = queueStep(s.queue, s.id, 1)
		if (target !== null) this.play(target, s.queue ?? undefined)
	}

	/** Back to the start past PREV_RESTART_S, else the previous recording of the queue. */
	prev(): void {
		const s = this.get()
		if (s.id === null) return
		if (restartsOnPrev(s)) {
			this.seek(0)
			return
		}
		const target = queueStep(s.queue, s.id, -1)
		if (target !== null) this.play(target, s.queue ?? undefined)
	}

	/**
	 * A surface's list changed while shown: its snapshot is replaced when the recording is still in it. A
	 * source with several lists (`list`) refreshes only the queue played from that same list.
	 */
	setQueue(
		source: QueueSource,
		ids: readonly string[],
		titles?: Readonly<Record<string, string>>,
		list?: string,
	): void {
		const s = this.get()
		if (s.queue?.source !== source || s.id === null || !ids.includes(s.id))
			return
		if ((s.queue.list ?? null) !== (list ?? null)) return
		const same =
			ids.length === s.queue.ids.length &&
			ids.every((x, i) => s.queue?.ids[i] === x)
		if (same && (titles === undefined || sameTitles(titles, s.queue.titles)))
			return
		const queue: QueueRef = { source, ids }
		if (titles !== undefined) queue.titles = titles
		if (list !== undefined) queue.list = list
		if (s.queue.playAll === true) queue.playAll = true
		this.set({ ...s, queue })
	}

	setAutoNext(on: boolean): void {
		try {
			this.storage?.setItem(AUTO_NEXT_KEY, on ? "1" : "0")
		} catch {
			// private windows and full storage: kept for this page only
		}
		this.update(s => (s.autoNext === on ? s : { ...s, autoNext: on }))
	}

	/** 1×, 1.5×, 2×, then 1× again. */
	cycleSpeed(): void {
		const i = SPEEDS.indexOf(this.get().speed as (typeof SPEEDS)[number])
		const speed = SPEEDS[(i + 1) % SPEEDS.length] ?? 1
		if (this.el && this.srcEpoch === this.epoch) this.el.playbackRate = speed
		this.update(s => ({ ...s, speed }))
	}

	/** Closes the player; live audio comes back. */
	stop(): void {
		const s = this.get()
		if (s.phase === "idle") return
		this.abort?.abort()
		this.abort = null
		this.epoch += 1
		const el = this.el
		if (el) {
			el.pause()
			el.removeAttribute("src")
			el.load()
		}
		this.set({
			...s,
			id: null,
			phase: "idle",
			pos: 0,
			duration: null,
			error: null,
			queue: null,
			wantPlay: false,
			title: null,
		})
	}

	/** Loads the file of `id` and its peaks (an open row's waveform). Never rejects. */
	async loadPeaks(id: string): Promise<void> {
		if (this.peakStore.get().has(id)) return
		try {
			const file = await this.load(id)
			this.setPeaks(id, file.peaks ?? "none")
		} catch (error: unknown) {
			// the strip stays flat (never "Loading waveform…" for good); playing it reports the error
			if (error instanceof StaleFetchError || this.disposed) return
			if (!this.peakStore.get().has(id)) this.setPeaks(id, "none")
		}
	}

	/** A recording went away (deleted): closed when it plays, dropped from the queue and every cache. */
	forget(id: string): void {
		const s = this.get()
		if (s.id === id) this.stop()
		else if (s.queue?.ids.includes(id))
			this.set({
				...s,
				queue: { ...s.queue, ids: s.queue.ids.filter(x => x !== id) },
			})
		// an in-flight fetch keeps nothing when it lands; a play after an Undo fetches anew
		this.loading.delete(id)
		this.dropFile(id)
		if (this.peakStore.get().has(id)) {
			const next = new Map(this.peakStore.get())
			next.delete(id)
			this.peakStore.set(next)
		}
	}

	dispose(): void {
		this.disposed = true
		this.loading.clear()
		this.stop()
		this.offHold()
		for (const c of this.cache.values()) this.revoke(c.url)
		this.cache.clear()
	}

	private loaded(id: string, token: number, file: Cached): void {
		const s = this.get()
		if (token !== this.epoch || s.id !== id || s.phase !== "loading") return
		const el = this.element()
		el.src = file.url
		this.epoch += 1
		this.srcEpoch = this.epoch
		el.playbackRate = s.speed
		el.currentTime = s.pos
		if (s.wantPlay) this.start(el)
		else this.set({ ...s, phase: "paused" })
	}

	private start(el: AudioLike): void {
		this.update(s => ({ ...s, phase: "playing", error: null, wantPlay: true }))
		const token = this.epoch
		// each start its own: an earlier play() rejecting late (after a pause and a resume of the same src) is not this one's
		this.starts += 1
		const started = this.starts
		el.play().catch((error: unknown) => {
			if (
				token !== this.epoch ||
				started !== this.starts ||
				this.get().phase !== "playing"
			)
				return
			if (error instanceof DOMException && error.name === "AbortError") return
			this.update(s => ({
				...s,
				phase: "paused",
				error:
					error instanceof DOMException && error.name === "NotAllowedError"
						? null
						: errorMessage(error),
			}))
		})
	}

	/** An element event of the current src while a recording is loaded (not loading, not idle). */
	private live(): boolean {
		const p = this.get().phase
		return this.srcEpoch === this.epoch && p !== "loading" && p !== "idle"
	}

	private element(): AudioLike {
		if (this.el) return this.el
		const el = this.deps.createAudio ? this.deps.createAudio() : new Audio()
		el.preservesPitch = true
		el.addEventListener("timeupdate", () => {
			if (!this.live()) return
			this.update(s => ({ ...s, pos: el.currentTime }))
		})
		el.addEventListener("loadedmetadata", () => {
			if (!this.live()) return
			const d = el.duration
			if (Number.isFinite(d)) this.update(s => ({ ...s, duration: d }))
		})
		el.addEventListener("ended", () => this.onEnded())
		// a pause or play the service did not make (a media key, a headset taken out): its own calls set the
		// phase first, so their events find it already matching
		el.addEventListener("pause", () => {
			if (!this.live() || el.ended === true || el.paused === false) return
			const s = this.get()
			if (s.phase === "playing") this.set({ ...s, phase: "paused" })
		})
		el.addEventListener("play", () => {
			if (!this.live() || el.paused === true) return
			const s = this.get()
			// after the end the element plays from its start: the recording plays again, so live audio is held again
			if (s.phase === "paused" || s.phase === "ended")
				this.set({
					...s,
					phase: "playing",
					error: null,
					wantPlay: true,
					pos: s.phase === "ended" ? el.currentTime : s.pos,
				})
		})
		el.addEventListener("error", () => {
			const s = this.get()
			if (!this.live() || (s.phase !== "playing" && s.phase !== "paused"))
				return
			if (s.id !== null) this.dropFile(s.id)
			this.set({
				...s,
				phase: "error",
				error: "This recording could not be played",
			})
		})
		this.el = el
		return el
	}

	private onEnded(): void {
		if (!this.live()) return
		const s = this.get()
		if (s.phase === "playing" && (s.autoNext || s.queue?.playAll === true)) {
			const next = queueStep(s.queue, s.id, 1)
			if (next !== null) {
				this.play(next, s.queue ?? undefined)
				return
			}
		}
		// a paused file stays paused (an end event then is a seek to the end, not the file playing out)
		if (s.phase !== "playing") return
		this.set({ ...s, phase: "ended", pos: s.duration ?? s.pos })
	}

	private setPeaks(id: string, peaks: number[] | "none"): void {
		const next = new Map(this.peakStore.get())
		next.set(id, peaks)
		this.peakStore.set(next)
	}

	private revoke(url: string): void {
		;(this.deps.revokeUrl ?? URL.revokeObjectURL)(url)
	}

	private dropFile(id: string): void {
		const c = this.cache.get(id)
		if (c) this.revoke(c.url)
		this.cache.delete(id)
	}

	private load(id: string, signal?: AbortSignal): Promise<Cached> {
		const hit = this.cache.get(id)
		if (hit) {
			this.cache.delete(id)
			this.cache.set(id, hit)
			return Promise.resolve(hit)
		}
		let p = this.loading.get(id)
		if (!p) {
			// one fetch per file, shared; it is not cancelled when one caller stops waiting
			// still the listed fetch of the file: forget() or dispose() since means it keeps nothing
			const stale = (): Error | null =>
				this.disposed
					? new StaleFetchError("Playback closed")
					: this.loading.get(id) !== p
						? new StaleFetchError("This recording was deleted")
						: null
			p = this.deps
				.fetchFile(id)
				.then(async blob => {
					const before = stale()
					if (before) throw before
					let peaks: number[] | null = null
					try {
						peaks = wavPeaks(await blob.arrayBuffer(), WAVE_BARS)?.peaks ?? null
					} catch {
						peaks = null
					}
					const after = stale()
					if (after) throw after
					const file: Cached = {
						blob,
						url: (this.deps.createUrl ?? URL.createObjectURL)(blob),
						peaks,
					}
					this.cache.set(id, file)
					this.setPeaks(id, peaks ?? "none")
					this.trim()
					return file
				})
				.finally(() => {
					if (this.loading.get(id) === p) this.loading.delete(id)
				})
			this.loading.set(id, p)
		}
		if (!signal) return p
		return new Promise<Cached>((resolve, reject) => {
			const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
			signal.addEventListener("abort", onAbort, { once: true })
			p.then(resolve, reject).finally(() =>
				signal.removeEventListener("abort", onAbort),
			)
		})
	}

	private trim(): void {
		const playing = this.get().id
		for (const [id, c] of this.cache) {
			if (this.cache.size <= CACHE_MAX) break
			if (id === playing) continue
			this.revoke(c.url)
			this.cache.delete(id)
		}
	}
}
