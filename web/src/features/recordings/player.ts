// Plays recordings in this browser: one <audio> element on a blob of the WAV (the core's file route
// sends no ranges, so the whole file is fetched once and seeks are local). Live audio is muted while
// a recording plays and comes back when the player closes. Finished recordings advance to the next
// one in the list. Waveform peaks come from the same blob.
import { errorMessage, Store } from "../../data/index.ts"
import { wavPeaks } from "./wav.ts"

export type PlayerPhase = "loading" | "playing" | "paused" | "ended" | "error"

export interface PlayerState {
	/** The recording in the player, null when it is closed. */
	id: string | null
	phase: PlayerPhase
	/** Seconds. */
	pos: number
	duration: number | null
	speed: number
	error: string | null
}

export const SPEEDS = [1, 1.5, 2] as const
export const WAVE_BARS = 96

/** The part of HTMLAudioElement the player drives (a fake in tests). */
export interface AudioLike {
	src: string
	currentTime: number
	readonly duration: number
	playbackRate: number
	preservesPitch?: boolean
	play(): Promise<void>
	pause(): void
	removeAttribute(name: string): void
	load(): void
	addEventListener(type: string, fn: () => void): void
}

export interface RecordingPlayerDeps {
	/** The WAV file (RecordingsStore.file). */
	fetchFile(id: string): Promise<Blob>
	/** Mutes (true) or unmutes live audio (ListenController.hold). */
	holdLive(held: boolean): void
	/** The recording after `id` in the list as shown, for auto-advance; null at the end. */
	nextOf(id: string): string | null
	createAudio?: () => AudioLike
	createUrl?: (blob: Blob) => string
	revokeUrl?: (url: string) => void
}

interface Cached {
	blob: Blob
	url: string
	peaks: number[] | null
}

/** Files kept for replay and waveforms (call WAVs are a few hundred kB). */
const CACHE_MAX = 16

export class RecordingPlayer extends Store<PlayerState> {
	private readonly deps: RecordingPlayerDeps
	private el: AudioLike | null = null
	private readonly cache = new Map<string, Cached>()
	private readonly loading = new Map<string, Promise<Cached>>()
	private abort: AbortController | null = null
	private readonly peakStore = new Store<
		ReadonlyMap<string, number[] | "none">
	>(new Map())

	constructor(deps: RecordingPlayerDeps) {
		super({
			id: null,
			phase: "paused",
			pos: 0,
			duration: null,
			speed: 1,
			error: null,
		})
		this.deps = deps
	}

	/** Peaks per recording id ("none" when the file is not a WAV this reads). */
	get peaks(): Store<ReadonlyMap<string, number[] | "none">> {
		return this.peakStore
	}

	/** Plays `id` from `at` seconds (from the start by default). */
	async play(id: string, at = 0): Promise<void> {
		const s = this.get()
		if (s.id === id && s.phase !== "error" && s.phase !== "loading") {
			this.seek(at)
			this.resume()
			return
		}
		this.abort?.abort()
		const abort = new AbortController()
		this.abort = abort
		this.el?.pause()
		this.set({
			...s,
			id,
			phase: "loading",
			pos: at,
			duration: null,
			error: null,
		})
		this.deps.holdLive(true)
		let file: Cached
		try {
			file = await this.load(id, abort.signal)
		} catch (error) {
			if (abort.signal.aborted) return
			this.update(x => ({ ...x, phase: "error", error: errorMessage(error) }))
			return
		}
		if (abort.signal.aborted || this.get().id !== id) return
		const el = this.element()
		el.src = file.url
		el.playbackRate = this.get().speed
		el.currentTime = at
		this.start(el)
	}

	/** Play or pause the current recording; an ended one starts again. */
	toggle(): void {
		const s = this.get()
		if (s.id === null) return
		if (s.phase === "playing") this.pause()
		else if (s.phase === "error") void this.play(s.id, s.pos)
		else this.resume()
	}

	pause(): void {
		if (this.get().phase !== "playing") return
		this.el?.pause()
		this.update(s => ({ ...s, phase: "paused" }))
	}

	resume(): void {
		const s = this.get()
		const el = this.el
		if (s.id === null || !el || s.phase === "loading") return
		if (s.phase === "ended") el.currentTime = 0
		this.deps.holdLive(true)
		this.start(el)
	}

	/** Seconds into the current recording. */
	seek(seconds: number): void {
		const s = this.get()
		if (s.id === null) return
		const max = s.duration ?? Number.POSITIVE_INFINITY
		const pos = Math.min(max, Math.max(0, seconds))
		if (this.el && s.phase !== "loading") this.el.currentTime = pos
		this.update(x => ({
			...x,
			pos,
			phase: x.phase === "ended" ? "paused" : x.phase,
		}))
	}

	/** 1×, 1.5×, 2×, then 1× again. */
	cycleSpeed(): void {
		const i = SPEEDS.indexOf(this.get().speed as (typeof SPEEDS)[number])
		const speed = SPEEDS[(i + 1) % SPEEDS.length] ?? 1
		if (this.el) this.el.playbackRate = speed
		this.update(s => ({ ...s, speed }))
	}

	/** Closes the player; live audio comes back. */
	stop(): void {
		this.abort?.abort()
		this.abort = null
		const el = this.el
		if (el) {
			el.pause()
			el.removeAttribute("src")
			el.load()
		}
		this.deps.holdLive(false)
		this.update(s => ({
			...s,
			id: null,
			phase: "paused",
			pos: 0,
			duration: null,
			error: null,
		}))
	}

	/** Loads the file of `id` and its peaks (the open row's strip). Never rejects. */
	async loadPeaks(id: string): Promise<void> {
		if (this.peakStore.get().has(id)) return
		try {
			const file = await this.load(id)
			this.setPeaks(id, file.peaks ?? "none")
		} catch {
			// the strip stays flat; playing it reports the error
		}
	}

	/** A recording went away (deleted): close it when it plays, and drop its file. */
	forget(id: string): void {
		if (this.get().id === id) this.stop()
		const c = this.cache.get(id)
		if (c) (this.deps.revokeUrl ?? URL.revokeObjectURL)(c.url)
		this.cache.delete(id)
	}

	dispose(): void {
		this.stop()
		for (const c of this.cache.values())
			(this.deps.revokeUrl ?? URL.revokeObjectURL)(c.url)
		this.cache.clear()
	}

	private start(el: AudioLike): void {
		this.update(s => ({ ...s, phase: "playing", error: null }))
		el.play().catch((error: unknown) => {
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

	private element(): AudioLike {
		if (this.el) return this.el
		const el = this.deps.createAudio ? this.deps.createAudio() : new Audio()
		el.preservesPitch = true
		el.addEventListener("timeupdate", () => {
			if (this.get().phase === "loading") return
			this.update(s => ({ ...s, pos: el.currentTime }))
		})
		el.addEventListener("loadedmetadata", () => {
			const d = el.duration
			if (Number.isFinite(d)) this.update(s => ({ ...s, duration: d }))
		})
		el.addEventListener("ended", () => this.onEnded())
		el.addEventListener("error", () => {
			if (this.get().id === null) return
			this.update(s => ({
				...s,
				phase: "error",
				error: "This recording could not be played",
			}))
		})
		this.el = el
		return el
	}

	private onEnded(): void {
		const s = this.get()
		if (s.id === null) return
		const next = this.deps.nextOf(s.id)
		if (next !== null) {
			void this.play(next)
			return
		}
		this.update(x => ({ ...x, phase: "ended", pos: x.duration ?? x.pos }))
	}

	private setPeaks(id: string, peaks: number[] | "none"): void {
		const next = new Map(this.peakStore.get())
		next.set(id, peaks)
		this.peakStore.set(next)
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
			p = this.deps
				.fetchFile(id)
				.then(async blob => {
					let peaks: number[] | null = null
					try {
						peaks = wavPeaks(await blob.arrayBuffer(), WAVE_BARS)?.peaks ?? null
					} catch {
						peaks = null
					}
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
				.finally(() => this.loading.delete(id))
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
			;(this.deps.revokeUrl ?? URL.revokeObjectURL)(c.url)
			this.cache.delete(id)
		}
	}
}
