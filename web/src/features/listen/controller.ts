// Plays live audio in this browser. The low-latency path is PcmPlayer (fetch + AudioWorklet); where
// AudioWorklet is missing, one <audio> element plays status.wavUrl. Start and stop come from a user
// gesture (autoplay rules); reattaching follows audioAttachKey(): stream URL, format or rate only, since
// the core's stream already follows tuning.
import { errorMessage, Store } from "../../data/index.ts"
import type { LiveAudioStore } from "../../data/index.ts"
import type { AudioStreamSource } from "./audio.ts"
import {
	AudioHealthTracker,
	audioExpected,
	NO_AUDIO_HEALTH,
} from "./audio-health.ts"
import type { AudioHealth } from "./audio-health.ts"
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
	/** Output latency while playing (core backlog on `/auto`, jitter buffer and the device), ms; null otherwise. */
	latencyMs: number | null
	/** How much of the expected audio played: the card's "breaking up" and Audio options' detail. */
	audio: AudioHealth
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
/**
 * How long a dry jitter ring on an open stream stays "playing" before Listen says Connecting…. A busy core
 * holds its 20 ms pacer for up to about 1.3 s, then the ring needs RING_TARGET_MS (200 ms) to prime again:
 * 1 500 ms, rounded up. A real stall shows at most 2 000 + 200 ms (the ring draining) after its last byte.
 */
export const STALL_GRACE_MS = 2000
/**
 * No byte for this long on an open stream: it is dead, so reattach through fail(). Every route sends bytes
 * all the time (exact silence while squelched or between calls), so the longest gap on a live stream is the
 * core's 1 300 ms stall. 2.5 × STALL_GRACE_MS = 5 000 ms is 3.8 times that, and leaves Connecting… on the
 * card for 2 800 ms first. With RETRY_MS an unanswering core reaches the error state 5 + 1 + 5 + 2 + 5 + 5 + 5
 * = 28 s after the attach.
 */
export const DEAD_STREAM_MS = 2.5 * STALL_GRACE_MS
/**
 * How often the core's `/auto` counters are read while playing there, in ring time. Status broadcasts only
 * on a change, so this is the zero-fill figure's source: 5 readings per 10 s window, one small GET each 2 s.
 */
export const ROUTE_POLL_MS = 2000
/**
 * Stats arrive every 250 ms of rendering. Over 4 of those periods with none, the ring was not rendering
 * (suspended, or a blocked page), so the core's counters since the last reading are not about this Listen.
 * Time under the bound can credit at most 1 000 ms: 10% of the 10 s window, which is not yet breaking up.
 */
export const STATS_GAP_MS = 1_000

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
	private stallTimer: ReturnType<typeof setTimeout> | null = null
	private deadTimer: ReturnType<typeof setTimeout> | null = null
	private lastDataAt = 0
	private health = new AudioHealthTracker()
	/** The route reading in flight; one that comes back after being replaced here is ignored. */
	private routeRead: AbortController | null = null
	private routePolledAt = Number.NEGATIVE_INFINITY
	private lastStatsAt = 0
	private routeSourceId: string | undefined
	private routeLatencyMs = 0
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
			audio: NO_AUDIO_HEALTH,
		})
		this.liveAudio = liveAudio
		const events = {
			onStats: (stats: RingStats) => this.onStats(stats),
			onData: () => this.noteData(),
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
				this.clearStall()
				this.setPhase("playing")
			}),
			on("waiting", () => this.noteDry()),
			// the element's only signs of bytes: it fetched more, or is playing what it fetched
			on("progress", () => this.noteData()),
			on("timeupdate", () => this.noteData()),
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
		this.set({
			...this.get(),
			wanted: true,
			phase: "connecting",
			error: null,
			audio: NO_AUDIO_HEALTH,
		})
		this.retries = 0
		this.health = new AudioHealthTracker()
		this.abortRouteRead()
		this.routePolledAt = Number.NEGATIVE_INFINITY
		this.routeLatencyMs = 0
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
		const auto = this.source?.route === "auto"
		const { status, level } = this.liveAudio.get()
		const now = Date.now()
		if (
			now - this.lastStatsAt > STATS_GAP_MS ||
			status?.sourceId !== this.routeSourceId
		)
			this.rebaseRoute()
		this.lastStatsAt = now
		if (auto) this.readRoute(stats.renderedMs)
		const audio = this.health.noteStats(
			stats,
			audioExpected(status, level, auto),
			auto,
		)
		// to 10 ms: a reading that changes every stats tick would redraw the panel for nothing
		const latency = stats.playing
			? Math.round(
					(stats.bufferedMs +
						(auto ? this.routeLatencyMs : 0) +
						(this.player?.outputLatencyMs?.() ?? 0)) /
						10,
				) * 10
			: null
		const error = stats.playing ? null : s.error
		if (latency !== s.latencyMs || audio !== s.audio || error !== s.error)
			this.update(x => ({ ...x, latencyMs: latency, audio, error }))
		if (stats.playing) {
			this.retries = 0
			this.clearStall()
			this.setPhase("playing")
		} else this.noteDry()
	}

	/** One reading at a time; a failed one is skipped and the next says what happened since. */
	private readRoute(renderedMs: number): void {
		if (this.routeRead || renderedMs - this.routePolledAt < ROUTE_POLL_MS)
			return
		const read = new AbortController()
		this.routeRead = read
		this.routePolledAt = renderedMs
		void this.liveAudio.readAutoRoute(read.signal).then(route => {
			if (this.routeRead !== read) return
			this.routeRead = null
			if (!route) return
			this.health.noteRoute(route)
			this.routeLatencyMs = route.latencyMs
		})
	}

	private abortRouteRead(): void {
		this.routeRead?.abort()
		this.routeRead = null
	}

	/**
	 * What the core counted from here on is about this Listen again; what it counted before is not: a
	 * suspended ring, a new stream, or another source. The base comes from a reading taken now.
	 */
	private rebaseRoute(): void {
		this.abortRouteRead()
		this.routePolledAt = Number.NEGATIVE_INFINITY
		this.health.rebaseRoute()
		this.lastStatsAt = Date.now()
		this.routeSourceId = this.liveAudio.get().status?.sourceId
	}

	/**
	 * The buffer ran dry on a stream that is still open. An underrun is not a reconnect: nothing was torn
	 * down, and a core that paces late causes one a second. Connecting… is for a dry spell past the bound;
	 * a stream that failed or ended goes through fail() at once, and one that went quiet at DEAD_STREAM_MS.
	 */
	private noteDry(): void {
		if (this.get().phase !== "playing" || this.stallTimer) return
		this.stallTimer = setTimeout(() => {
			this.stallTimer = null
			if (this.get().phase === "playing") this.setPhase("connecting")
		}, STALL_GRACE_MS)
	}

	/** Called for every read of the stream, so it only stamps the time; the timer re-arms itself. */
	private noteData(): void {
		this.lastDataAt = Date.now()
	}

	private armDeadTimer(ms: number): void {
		this.deadTimer = setTimeout(() => {
			this.deadTimer = null
			const s = this.get()
			if (!s.wanted || this.attachedKey === null) return
			const quiet = Date.now() - this.lastDataAt
			if (quiet < DEAD_STREAM_MS) this.armDeadTimer(DEAD_STREAM_MS - quiet)
			// a reattach would hide "Tap to play"; without the gesture nothing can sound anyway
			else if (s.phase === "blocked") this.armDeadTimer(DEAD_STREAM_MS)
			else this.fail(`No audio arrived for ${DEAD_STREAM_MS / 1000} s`)
		}, ms)
	}

	/** A new stream has the full bound to send its first byte (a fetch may hang before any headers). */
	private watchStream(): void {
		this.clearDead()
		this.lastDataAt = Date.now()
		this.armDeadTimer(DEAD_STREAM_MS)
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
			this.watchStream()
			this.rebaseRoute()
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
		this.watchStream()
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
		this.clearStall()
		this.clearDead()
		this.abortRouteRead()
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
		this.clearStall()
		this.clearDead()
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

	private clearStall(): void {
		if (this.stallTimer) clearTimeout(this.stallTimer)
		this.stallTimer = null
	}

	private clearDead(): void {
		if (this.deadTimer) clearTimeout(this.deadTimer)
		this.deadTimer = null
	}
}
