// Plays live audio in this browser: one <audio> element bound to status.wavUrl. Start and stop come
// from a user gesture (autoplay rules); reattaching follows audioAttachKey() (audio follows tuning).
import { errorMessage, Store } from "../../data/index.ts"
import type { LiveAudioStore } from "../../data/index.ts"

export type ListenPhase = "off" | "connecting" | "playing" | "blocked" | "error"

export interface ListenState {
	/** The operator wants to hear audio here. */
	wanted: boolean
	phase: ListenPhase
	/** 0–1, this browser only. */
	volume: number
	error: string | null
}

const VOLUME_KEY = "wavekit.web.volume"
const REATTACH_DELAY_MS = 250
const RETRY_MS = [1000, 2000, 5000] as const

function readVolume(): number {
	try {
		const raw = globalThis.localStorage?.getItem(VOLUME_KEY)
		const v = raw === null || raw === undefined ? Number.NaN : Number(raw)
		return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8
	} catch {
		return 0.8
	}
}

function writeVolume(v: number): void {
	try {
		globalThis.localStorage?.setItem(VOLUME_KEY, String(v))
	} catch {
		// storage blocked: the volume stays for this page only
	}
}

export class ListenController extends Store<ListenState> {
	private el: HTMLAudioElement | null = null
	private url: string | null = null
	private key: string | null = null
	private attachedKey: string | null = null
	private timer: ReturnType<typeof setTimeout> | null = null
	private retries = 0
	private readonly liveAudio: LiveAudioStore
	private unbind: (() => void) | null = null

	constructor(liveAudio: LiveAudioStore) {
		super({ wanted: false, phase: "off", volume: readVolume(), error: null })
		this.liveAudio = liveAudio
	}

	/** The page's <audio> element (ref callback). */
	bind = (el: HTMLAudioElement | null): void => {
		this.unbind?.()
		this.unbind = null
		this.el = el
		if (!el) return
		el.volume = this.get().volume
		const on = (type: string, fn: () => void) => {
			el.addEventListener(type, fn)
			return () => el.removeEventListener(type, fn)
		}
		const offs = [
			on("playing", () => {
				this.retries = 0
				this.setPhase("playing")
			}),
			on("waiting", () => this.get().wanted && this.setPhase("connecting")),
			on("error", () => this.fail("The audio stream could not be played")),
			on("ended", () => this.fail("The audio stream ended")),
		]
		this.unbind = () => offs.forEach(fn => fn())
	}

	/** Called on every render with the current stream; reattaches when `key` changes. */
	setSource(key: string | null, url: string | null): void {
		this.url = url
		if (key === this.key) return
		const first = this.key === null
		this.key = key
		if (!this.get().wanted) return
		if (key === null) {
			// live audio stopped (here or by another client)
			this.clearTimer()
			this.detach()
			this.set({ ...this.get(), wanted: false, phase: "off" })
			return
		}
		this.schedule(first ? 0 : REATTACH_DELAY_MS)
	}

	/** User gesture: start the core's live audio if needed and play here. */
	async start(): Promise<void> {
		this.set({ ...this.get(), wanted: true, phase: "connecting", error: null })
		this.retries = 0
		// play inside the gesture so the browser allows sound later on (Safari needs this call here)
		if (this.el && this.url) this.attach()
		if (!this.liveAudio.get().status?.running) {
			try {
				await this.liveAudio.start()
			} catch (error) {
				this.set({ ...this.get(), phase: "error", error: errorMessage(error) })
			}
		}
	}

	/** Stops playing here; stops the core's live audio when no other client listens. */
	async stop(): Promise<void> {
		this.clearTimer()
		this.detach()
		this.set({ ...this.get(), wanted: false, phase: "off", error: null })
		const status = this.liveAudio.get().status
		if (status?.running && status.clientCount <= 1) {
			try {
				await this.liveAudio.stop()
			} catch (error) {
				this.update(s => ({ ...s, error: errorMessage(error) }))
			}
		}
	}

	/** A blocked autoplay resumes on the next gesture. */
	resume(): void {
		if (this.get().wanted) this.attach()
	}

	setVolume(volume: number): void {
		const v = Math.min(1, Math.max(0, volume))
		if (this.el) this.el.volume = v
		writeVolume(v)
		this.update(s => ({ ...s, volume: v }))
	}

	dispose(): void {
		this.clearTimer()
		this.detach()
		this.unbind?.()
	}

	private schedule(ms: number): void {
		this.clearTimer()
		this.timer = setTimeout(() => {
			this.timer = null
			this.attach()
		}, ms)
	}

	private attach(): void {
		const el = this.el
		if (!el || !this.url) return
		this.clearTimer()
		this.attachedKey = this.key
		el.src = this.url
		el.volume = this.get().volume
		if (this.get().phase !== "playing") this.setPhase("connecting")
		el.play().catch((error: unknown) => {
			if (error instanceof DOMException && error.name === "NotAllowedError")
				this.update(s => ({ ...s, phase: "blocked" }))
			// AbortError: a newer attach replaced this one; media errors arrive as "error" events
		})
	}

	private detach(): void {
		const el = this.el
		this.attachedKey = null
		if (!el) return
		el.pause()
		el.removeAttribute("src")
		el.load()
	}

	private fail(message: string): void {
		const s = this.get()
		if (!s.wanted || this.attachedKey === null) return
		const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)] ?? 5000
		this.retries += 1
		this.update(x => ({
			...x,
			phase: this.retries > RETRY_MS.length ? "error" : "connecting",
			error: this.retries > RETRY_MS.length ? message : null,
		}))
		if (this.key !== null) this.schedule(delay)
	}

	private setPhase(phase: ListenPhase): void {
		if (this.get().phase !== phase) this.update(s => ({ ...s, phase }))
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}
}
