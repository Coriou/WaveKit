// Plays live audio in this browser. The low-latency path is PcmPlayer (fetch + AudioWorklet); where
// AudioWorklet is missing, one <audio> element plays status.wavUrl. Start and stop come from a user
// gesture (autoplay rules); reattaching follows audioAttachKey(): stream URL, format or rate only, since
// the core's stream already follows tuning.
import { errorMessage, Store } from "../../data/index.ts"
import type { LiveAudioStore } from "../../data/index.ts"
import type { AudioStreamSource } from "./audio.ts"
import { PcmPlayer, pcmPlayerSupported } from "./pcm-player.ts"
import type { RingStats } from "./pcm.ts"
import { WavRecorder } from "./recorder.ts"
import type { HearChoice } from "./sound.ts"
import { readHearChoice, writeHearChoice } from "./sound.ts"

export type ListenPhase = "off" | "connecting" | "playing" | "blocked" | "error"

export interface ListenState {
	/** The operator wants to hear audio here. */
	wanted: boolean
	phase: ListenPhase
	/** 0–1, this browser only. */
	volume: number
	error: string | null
	/** Listen › What you hear, this browser only. */
	hear: HearChoice
	/** Listen › Record audio: seconds recorded, null when not recording. */
	recording: { seconds: number; startedAt: number } | null
	/** Output latency while playing (jitter buffer plus the device), ms; null otherwise. */
	latencyMs: number | null
}

/** The part of PcmPlayer the controller drives (a fake in tests). */
export interface ListenPlayer {
	unlock(rateHint: number | null): void
	play(source: {
		url: string
		format: AudioStreamSource["format"]
		rate: number
		credentials?: boolean
	}): void
	stop(): void
	setVolume(volume: number): void
	dispose(): void
	/** Copies of the decoded stream chunks (recording); absent on fakes that cannot record. */
	setTap?(tap: ((samples: Float32Array, rate: number) => void) | null): void
	outputLatencyMs?(): number
}

export interface ListenControllerOptions {
	/** Builds the Web Audio player; null forces the <audio> fallback. Default: PcmPlayer where supported. */
	createPlayer?:
		| ((events: ConstructorParameters<typeof PcmPlayer>[0]) => ListenPlayer)
		| null
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
	private source: AudioStreamSource | null = null
	private key: string | null = null
	private attachedKey: string | null = null
	private timer: ReturnType<typeof setTimeout> | null = null
	private retries = 0
	private readonly liveAudio: LiveAudioStore
	private readonly player: ListenPlayer | null
	private unbind: (() => void) | null = null
	/** A recording is playing in this tab: live audio keeps streaming, muted. */
	private held = false
	private recorder: WavRecorder | null = null
	private recordEnd: ((wav: Blob, startedAt: number) => void) | null = null

	constructor(
		liveAudio: LiveAudioStore,
		options: ListenControllerOptions = {},
	) {
		super({
			wanted: false,
			phase: "off",
			volume: readVolume(),
			error: null,
			hear: readHearChoice(),
			recording: null,
			latencyMs: null,
		})
		this.liveAudio = liveAudio
		const events = {
			onStats: (stats: RingStats) => this.onStats(stats),
			onEnded: (reason: string) => this.fail(reason),
			onBlocked: () => {
				if (this.get().wanted) this.setPhase("blocked")
			},
		}
		const create =
			options.createPlayer === undefined
				? pcmPlayerSupported()
					? (e: typeof events) => new PcmPlayer(e)
					: null
				: options.createPlayer
		this.player = create ? create(events) : null
		this.player?.setVolume(this.get().volume)
	}

	/** Which path plays: "worklet" (low latency) or "element" (<audio> WAV fallback). */
	get backend(): "worklet" | "element" {
		return this.player ? "worklet" : "element"
	}

	/** The page's <audio> element (ref callback); only used by the fallback path. */
	bind = (el: HTMLAudioElement | null): void => {
		this.unbind?.()
		this.unbind = null
		this.el = el
		if (!el || this.player) return
		el.volume = this.outVolume()
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
	setSource(key: string | null, source: AudioStreamSource | null): void {
		this.source = source
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
		// unlock audio inside the gesture so the browser allows sound later on
		const status = this.liveAudio.get().status
		try {
			this.player?.unlock(status?.effectiveSampleRate ?? null)
		} catch (error) {
			// a player that cannot start would otherwise leave Listen on "Connecting…" for good
			this.set({ ...this.get(), phase: "error", error: errorMessage(error) })
			return
		}
		if (this.source) this.attach()
		if (!status?.running) {
			try {
				await this.liveAudio.start()
			} catch (error) {
				this.set({ ...this.get(), phase: "error", error: errorMessage(error) })
			}
		}
	}

	/**
	 * User gesture, no playback: creates or resumes the audio context so a start() after an awaited tune may
	 * sound. Call it synchronously in the click. A player that cannot start is reported by start() later.
	 */
	unlock(): void {
		try {
			this.player?.unlock(
				this.liveAudio.get().status?.effectiveSampleRate ?? null,
			)
		} catch {
			// start() unlocks again and shows the failure
		}
	}

	/**
	 * Undoes an unlock() whose Listen never started (its tune failed): the audio context is suspended again.
	 * Does nothing while Listen is on here (it may have been started meanwhile).
	 */
	suspend(): void {
		if (this.get().wanted) return
		try {
			this.player?.stop()
		} catch {
			// nothing was playing: the context stays as it is
		}
	}

	/** Stops playing here; stops the core's live audio when a fresh status shows no other client listening. */
	async stop(): Promise<void> {
		const mine =
			this.attachedKey !== null ? (this.source?.route ?? "stream") : null
		this.endRecording()
		this.clearTimer()
		this.detach()
		this.set({
			...this.get(),
			wanted: false,
			phase: "off",
			error: null,
			latencyMs: null,
		})
		// The stop is shared by every client: decide on a fresh status (a failed read leaves it running) and
		// count /stream and /auto (the web default) listeners alike. This client may still be counted on the
		// route it played (it just closed); every other listener keeps the audio on.
		await this.liveAudio.load()
		const { status, error } = this.liveAudio.get()
		if (error !== null || !status?.running) return
		const stream = status.clientCount
		const auto = status.autoRoute?.clientCount ?? 0
		const others =
			mine === "auto"
				? stream + Math.max(0, auto - 1)
				: mine === "stream"
					? auto + Math.max(0, stream - 1)
					: stream + auto
		if (others === 0) {
			try {
				await this.liveAudio.stop()
			} catch (error) {
				this.update(s => ({ ...s, error: errorMessage(error) }))
			}
		}
	}

	/** A blocked autoplay resumes on the next gesture. */
	resume(): void {
		if (!this.get().wanted) return
		if (this.player) {
			this.player.unlock(this.source?.rate ?? null)
			this.setPhase("connecting")
		} else this.attach()
	}

	setVolume(volume: number): void {
		const v = Math.min(1, Math.max(0, volume))
		writeVolume(v)
		this.update(s => ({ ...s, volume: v }))
		this.applyVolume()
	}

	setHear(hear: HearChoice): void {
		writeHearChoice(hear)
		this.update(s => ({ ...s, hear }))
	}

	/** Recording needs the low-latency path (the <audio> fallback gives no samples). */
	get canRecord(): boolean {
		return this.player?.setTap !== undefined
	}

	/** Starts keeping what plays here; `onEnd` gets the file when it stops by itself (cap, stream replaced). */
	startRecording(onEnd: (wav: Blob, startedAt: number) => void): boolean {
		if (!this.player?.setTap || this.recorder) return false
		const rec = new WavRecorder()
		this.recorder = rec
		this.recordEnd = onEnd
		this.set({
			...this.get(),
			recording: { seconds: 0, startedAt: rec.startedAt },
		})
		let shown = 0
		this.player.setTap((samples, rate) => {
			if (this.recorder !== rec) return
			if (!rec.push(samples, rate)) {
				this.endRecording()
				return
			}
			const secs = Math.floor(rec.seconds)
			if (secs !== shown) {
				shown = secs
				this.update(s => ({
					...s,
					recording: { seconds: secs, startedAt: rec.startedAt },
				}))
			}
		})
		return true
	}

	/** Ends a recording that stopped by itself (or with Listen) and hands its file to `onEnd`. */
	private endRecording(): void {
		const rec = this.recorder
		const onEnd = this.recordEnd
		const wav = this.stopRecording()
		if (rec && wav && onEnd) onEnd(wav, rec.startedAt)
	}

	/** Stops recording; the WAV, or null when nothing was recording. */
	stopRecording(): Blob | null {
		const rec = this.recorder
		if (!rec) return null
		this.recorder = null
		this.recordEnd = null
		this.player?.setTap?.(null)
		this.update(s => ({ ...s, recording: null }))
		return rec.toWav()
	}

	/** Mutes live audio while a recording plays here (the stream stays attached), and unmutes it after. */
	hold(held: boolean): void {
		if (this.held === held) return
		this.held = held
		this.applyVolume()
	}

	get isHeld(): boolean {
		return this.held
	}

	private outVolume(): number {
		return this.held ? 0 : this.get().volume
	}

	private applyVolume(): void {
		const v = this.outVolume()
		if (this.el) this.el.volume = v
		this.player?.setVolume(v)
	}

	dispose(): void {
		this.clearTimer()
		this.detach()
		this.unbind?.()
		this.player?.dispose()
	}

	private onStats(stats: RingStats): void {
		const s = this.get()
		if (!s.wanted || this.attachedKey === null || s.phase === "blocked") return
		// to 10 ms: a reading that changes every stats tick would redraw the panel for nothing
		const latency = stats.playing
			? Math.round(
					(stats.bufferedMs + (this.player?.outputLatencyMs?.() ?? 0)) / 10,
				) * 10
			: null
		if (latency !== s.latencyMs)
			this.update(x => ({ ...x, latencyMs: latency }))
		if (stats.playing) {
			this.retries = 0
			this.setPhase("playing")
		} else if (s.phase === "playing") this.setPhase("connecting")
	}

	private schedule(ms: number): void {
		this.clearTimer()
		this.timer = setTimeout(() => {
			this.timer = null
			this.attach()
		}, ms)
	}

	private attach(): void {
		const source = this.source
		if (!source) return
		this.clearTimer()
		if (this.player) {
			if (!source.httpUrl) return
			this.attachedKey = this.key
			if (this.get().phase !== "playing") this.setPhase("connecting")
			this.player.play({
				url: source.httpUrl,
				format: source.format,
				rate: source.rate,
				credentials: source.credentials,
			})
			return
		}
		const el = this.el
		if (!el || !source.wavUrl) return
		this.attachedKey = this.key
		// set before src: the element fetches with the session cookie on a protected core
		if (source.credentials) el.crossOrigin = "use-credentials"
		else el.removeAttribute("crossorigin")
		el.src = source.wavUrl
		el.volume = this.outVolume()
		if (this.get().phase !== "playing") this.setPhase("connecting")
		el.play().catch((error: unknown) => {
			if (error instanceof DOMException && error.name === "NotAllowedError")
				this.update(s => ({ ...s, phase: "blocked" }))
			// AbortError: a newer attach replaced this one; media errors arrive as "error" events
		})
	}

	private detach(): void {
		this.attachedKey = null
		this.player?.stop()
		const el = this.el
		if (!el || this.player) return
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
