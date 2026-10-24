/**
 * AutoListenRouter (docs/specs/auto-listen-route/design.md, AutoListenRouter): owns the `/auto`
 * client registry and plays one source at a time, analog or decoded digital voice, at a fixed
 * 48 kHz s16le mono, paced by an injected monotonic clock in 20 ms blocks.
 *
 * Per block: refresh voice inputs (coverage generation, age, tail flush), choose the source by
 * the switching rules (requirements 4.1 to 4.10), discard silent heads of the other sources,
 * catch up on silence only, read 960 samples (zeros and an underrun when short) and hand a fresh
 * 1 920-byte buffer to the registry (2.8). Nothing is mixed; every sample leaves a FIFO once.
 */
import { EventEmitter } from "node:events"
import {
	LIVE_AUDIO_AUTO_ROUTE_ANALOG_RELEASE_MS,
	LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
	LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS,
	LIVE_AUDIO_AUTO_ROUTE_DIGITAL_HOLD_MS,
	LIVE_AUDIO_AUTO_ROUTE_DIGITAL_RELEASE_MS,
	LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS,
	LIVE_AUDIO_AUTO_ROUTE_FIFO_MS,
	LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS,
	LIVE_AUDIO_AUTO_ROUTE_RATE,
	LIVE_AUDIO_AUTO_ROUTE_TARGET_MS,
} from "@wavekit/api-types"
import type {
	LiveAudioAutoRoute,
	LiveAudioAutoRouteLevel,
	LiveAudioAutoRouteSource,
} from "@wavekit/api-types"
import { AudioClientRegistry } from "../audio-stream-server.js"
import type { StreamFormat } from "../audio-stream-server.js"
import type { Logger } from "../../utils/logger.js"
import {
	AUTO_ROUTE_BLOCK_BYTES,
	AUTO_ROUTE_BLOCK_SAMPLES,
	AUTO_ROUTE_STREAM,
} from "./contract.js"
import type {
	AutoRouteClock,
	VoiceCoverage,
	VoiceCoveragePort,
	VoiceTap,
	VoiceTapCall,
	VoiceTapSource,
} from "./contract.js"
import { AnalogInput, VoiceInput } from "./inputs.js"
import type { AutoRouteTraceFn, DropCounter } from "./inputs.js"
import { FLAG_AUDIBLE, FLAG_SILENT } from "./source-fifo.js"

/** 48 000 / 1 000 = 48 output samples per millisecond. */
const SAMPLES_PER_MS = LIVE_AUDIO_AUTO_ROUTE_RATE / 1000
/** 60 ms × 48 = 2 880 samples of backlog kept through catch-up (4.7). */
const TARGET_SAMPLES = LIVE_AUDIO_AUTO_ROUTE_TARGET_MS * SAMPLES_PER_MS
/** 200 ms × 48 = 9 600 samples of queued voice start a digital source (4.6). */
const START_SAMPLES = LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS * SAMPLES_PER_MS
/** Same as `/stream`'s default: a client accepting nothing for 30 s is closed (1.5). */
const DEFAULT_STALL_TIMEOUT_MS = 30_000

export interface AutoListenRouterOptions {
	/** Monotonic clock and timer; defaults to `performance.now()` and `setInterval`. */
	clock?: AutoRouteClock
	/** Wall clock for the `since` timestamp only (never for pacing or decisions). */
	wallClock?: () => number
	stallTimeoutMs?: number
	/** Diagnostics: every FIFO removal (read, silent discard, counted drop). */
	trace?: AutoRouteTraceFn
}

export interface AutoListenRouterEvents {
	"auto-route-changed": (level: LiveAudioAutoRouteLevel) => void
}

const defaultClock: AutoRouteClock = {
	now: () => performance.now(),
	setInterval: (fn, ms) => {
		const handle = setInterval(fn, ms)
		handle.unref()
		return handle
	},
	clearInterval: handle => {
		clearInterval(handle as ReturnType<typeof setInterval>)
	},
}

type Selected = AnalogInput | VoiceInput | null

function validCoverage(value: unknown): VoiceCoverage {
	return value === "yes" || value === "no" ? value : "unknown"
}

export class AutoListenRouter extends EventEmitter {
	readonly registry: AudioClientRegistry
	private readonly log: Logger
	private readonly clock: AutoRouteClock
	private readonly wallClock: () => number
	private readonly traceFn: AutoRouteTraceFn | undefined
	private readonly counter: DropCounter = { droppedSamples: 0 }
	private readonly analog: AnalogInput
	private readonly voices = new Map<string, VoiceInput>()
	/** Same inputs as `voices`, for index loops (no iterator object per block). */
	private voiceList: VoiceInput[] = []
	/** Preallocated block scratch and its byte view (copied into each fresh output block). */
	private readonly block = new Int16Array(AUTO_ROUTE_BLOCK_SAMPLES)
	private readonly blockBytes = Buffer.from(this.block.buffer)

	private voiceSource: VoiceTapSource | null = null
	private coverage: VoiceCoveragePort | null = null
	private removeTap: (() => void) | null = null
	private readonly tap: VoiceTap

	private running = false
	private timer: unknown = null
	private startAt = 0
	private emitted = 0
	private rebases = 0
	private underrunCount = 0
	private selected: Selected = null
	private selectedAt = 0
	private sinceWall: number
	private tickFailed = false

	constructor(log: Logger, options: AutoListenRouterOptions = {}) {
		super()
		this.log = log
		this.clock = options.clock ?? defaultClock
		this.wallClock = options.wallClock ?? Date.now
		this.traceFn = options.trace
		this.sinceWall = this.wallClock()
		this.analog = new AnalogInput(this.counter, this.traceFn)
		this.registry = new AudioClientRegistry(log, {
			stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
			label: "Auto listen",
			stream: AUTO_ROUTE_STREAM,
		})
		this.registry.on("client-connected", () => {
			if (this.registry.size > 0) this.start()
		})
		this.registry.on("client-disconnected", () => {
			if (this.registry.size === 0) this.stop()
		})
		this.tap = {
			frame: (decoderId, pcm, call) => {
				this.onFrame(decoderId, pcm, call)
			},
			call: (decoderId, call) => {
				this.onCall(decoderId, call)
			},
			detach: decoderId => {
				this.onDetach(decoderId)
			},
		}
	}

	/** True while `/auto` has a client: the taps and the pacer run only then (7.1). */
	get wanted(): boolean {
		return this.running
	}

	get clockRebases(): number {
		return this.rebases
	}

	get underruns(): number {
		return this.underrunCount
	}

	get droppedSamples(): number {
		return this.counter.droppedSamples
	}

	/** Output samples emitted since the pacer started. */
	get emittedSamples(): number {
		return this.emitted
	}

	/**
	 * Analog tap: `chunk[start..end)` (bytes) is exactly what `/stream` clients get, with one
	 * qualification for the whole span (requirement 3.6).
	 */
	pushAnalog(
		chunk: Buffer,
		start: number,
		end: number,
		audible: boolean,
		stream: StreamFormat,
	): void {
		if (!this.running) return
		this.analog.push(
			chunk,
			start,
			end,
			audible ? FLAG_AUDIBLE : FLAG_SILENT,
			stream,
			this.clock.now(),
		)
	}

	/** Retune, offset or modulation change, pipeline stop (requirement 5.1). */
	resetAnalog(): void {
		this.analog.reset()
		if (this.selected === this.analog) this.select(null, this.clock.now())
	}

	attachVoice(source: VoiceTapSource, coverage: VoiceCoveragePort): void {
		this.detachVoice()
		this.voiceSource = source
		this.coverage = coverage
		if (this.running) this.addTap()
	}

	detachVoice(): void {
		this.removeTap?.()
		this.removeTap = null
		this.voiceSource = null
		this.coverage = null
		for (const v of this.voiceList) this.removeVoice(v)
	}

	status(urls: { httpUrl: string; wavUrl: string }): LiveAudioAutoRoute {
		const sel = this.selected
		const route: LiveAudioAutoRoute = {
			active: this.active,
			since: new Date(this.sinceWall).toISOString(),
			httpUrl: urls.httpUrl,
			wavUrl: urls.wavUrl,
			clientCount: this.registry.size,
			digitalAvailable: this.voiceSource !== null && this.coverage !== null,
			underruns: this.underrunCount,
			droppedMs: this.counter.droppedSamples / SAMPLES_PER_MS,
			clockRebases: this.rebases,
			latencyMs:
				(sel === null ? 0 : sel.out.queued) / SAMPLES_PER_MS +
				LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
		}
		if (sel instanceof VoiceInput) {
			route.decoderId = sel.id
			route.slot = sel.call?.slot ?? null
			const protocol = sel.call?.protocol
			if (typeof protocol === "string") route.protocol = protocol
		}
		return route
	}

	/** A fresh object per call (requirement 6.2). */
	level(): LiveAudioAutoRouteLevel {
		const level: LiveAudioAutoRouteLevel = { active: this.active }
		const sel = this.selected
		if (sel instanceof VoiceInput) {
			const protocol = sel.call?.protocol
			if (typeof protocol === "string") level.protocol = protocol
		}
		return level
	}

	destroy(): void {
		this.registry.closeAll("shutdown", true)
		this.stop()
		this.detachVoice()
		this.registry.removeAllListeners()
		this.removeAllListeners()
	}

	// --- pacer ---

	private get active(): LiveAudioAutoRouteSource {
		const sel = this.selected
		if (sel === null) return "none"
		return sel === this.analog ? "analog" : "digital"
	}

	private start(): void {
		if (this.running) return
		this.running = true
		this.startAt = this.clock.now()
		this.emitted = 0
		this.timer = this.clock.setInterval(() => {
			this.tick()
		}, LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS)
		if (this.voiceSource !== null) this.addTap()
	}

	private stop(): void {
		if (!this.running) return
		this.running = false
		this.clock.clearInterval(this.timer)
		this.timer = null
		this.removeTap?.()
		this.removeTap = null
		this.analog.stop()
		for (const v of this.voiceList) v.stop()
		this.select(null, this.clock.now())
	}

	/**
	 * Emits the blocks due since `startAt` (2.6), at most `CATCHUP_MAX_BLOCKS` per tick; further
	 * behind, rebases `startAt` so nothing is owed (2.7). A clock step back emits nothing until
	 * `due` passes `emitted` again.
	 */
	private tick(): void {
		if (!this.running) return
		try {
			const now = this.clock.now()
			const due = Math.floor((now - this.startAt) * SAMPLES_PER_MS)
			let blocks = 0
			while (
				due - this.emitted >= AUTO_ROUTE_BLOCK_SAMPLES &&
				blocks < LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS
			) {
				this.produceBlock(now)
				this.emitted += AUTO_ROUTE_BLOCK_SAMPLES
				blocks++
				// The last client may have gone during the write.
				if (!this.running) return
			}
			if (due - this.emitted >= AUTO_ROUTE_BLOCK_SAMPLES) {
				this.startAt = now - this.emitted / SAMPLES_PER_MS
				this.rebases++
			}
		} catch (err) {
			if (!this.tickFailed) {
				this.tickFailed = true
				this.log.warn({ err }, "Auto listen route block failed")
			}
		}
	}

	private produceBlock(now: number): void {
		for (let i = 0; i < this.voiceList.length; i++) {
			const v = this.voiceList[i]
			if (v !== undefined) this.refreshVoice(v, now)
		}
		this.choose(now)
		const sel = this.selected
		// Silent audio of a source that is not playing is never kept (4.3).
		if (sel !== this.analog) this.analog.out.discardUntilAudible()
		for (let i = 0; i < this.voiceList.length; i++) {
			const v = this.voiceList[i]
			if (v !== undefined && v !== sel) v.out.discardUntilAudible()
		}
		if (sel === null) {
			this.block.fill(0)
		} else {
			// Catch-up only on silence, down to the target backlog (4.7).
			const excess = sel.out.queued - TARGET_SAMPLES
			if (excess > 0) sel.out.discardSilentHead(excess)
			const got = sel.out.read(this.block, AUTO_ROUTE_BLOCK_SAMPLES)
			if (got < AUTO_ROUTE_BLOCK_SAMPLES) this.underrunCount++
		}
		// A fresh block: the registry and the socket may keep the reference (2.8).
		const out = Buffer.allocUnsafe(AUTO_ROUTE_BLOCK_BYTES)
		this.blockBytes.copy(out, 0, 0, AUTO_ROUTE_BLOCK_BYTES)
		this.registry.write(out)
	}

	/** Switching rules (4.1, 4.4, 4.5, 4.6, 4.9). */
	private choose(now: number): void {
		const sel = this.selected
		if (sel === this.analog) {
			const pre = this.preemptor(now)
			if (pre !== null) {
				// 4.5: analog's remaining queued audio is dropped and counted.
				this.analog.out.dropAll()
				this.select(pre, now)
				return
			}
			if (
				!this.analogReleased(now) ||
				now - this.selectedAt < LIVE_AUDIO_AUTO_ROUTE_ANALOG_RELEASE_MS
			)
				return
		} else if (sel instanceof VoiceInput) {
			if (
				!this.digitalReleased(sel, now) ||
				now - this.selectedAt < LIVE_AUDIO_AUTO_ROUTE_DIGITAL_RELEASE_MS
			)
				return
		}
		const digital = this.oldestEligible()
		if (digital !== null) {
			// Digital beats analog: wait for its start buffer rather than start analog (4.1, 4.6).
			this.select(this.startReady(digital, now) ? digital : null, now)
			return
		}
		this.select(this.analog.out.queuedQualified > 0 ? this.analog : null, now)
	}

	private analogReleased(now: number): boolean {
		const a = this.analog
		return (
			!a.audibleNow &&
			now - a.lastAudibleAt >= LIVE_AUDIO_AUTO_ROUTE_ANALOG_RELEASE_MS &&
			a.out.queuedQualified === 0
		)
	}

	private digitalReleased(v: VoiceInput, now: number): boolean {
		return (
			v.out.queuedQualified === 0 &&
			now - v.lastAdmittedAt >= LIVE_AUDIO_AUTO_ROUTE_DIGITAL_RELEASE_MS
		)
	}

	/** Drain-eligible voice with the oldest queued admitted sample; ties by id (3.5). */
	private oldestEligible(): VoiceInput | null {
		let best: VoiceInput | null = null
		let bestAt = Number.POSITIVE_INFINITY
		for (let i = 0; i < this.voiceList.length; i++) {
			const v = this.voiceList[i]
			if (v === undefined || v.out.queuedQualified === 0) continue
			const at = v.out.oldestAt ?? Number.POSITIVE_INFINITY
			if (best === null || at < bestAt || (at === bestAt && v.id < best.id)) {
				best = v
				bestAt = at
			}
		}
		return best
	}

	private startReady(v: VoiceInput, now: number): boolean {
		if (v.out.queuedQualified >= START_SAMPLES) return true
		const at = v.out.oldestAt
		return at !== null && now - at >= LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS
	}

	/** An eligible voice whose oldest queued sample has waited the preemption bound (4.5). */
	private preemptor(now: number): VoiceInput | null {
		const v = this.oldestEligible()
		if (v === null) return null
		const at = v.out.oldestAt
		return at !== null && now - at >= LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS
			? v
			: null
	}

	private select(next: Selected, now: number): void {
		if (next === this.selected) return
		this.selected = next
		this.selectedAt = now
		this.sinceWall = this.wallClock()
		this.emit("auto-route-changed", this.level())
	}

	// --- voice ---

	private addTap(): void {
		const source = this.voiceSource
		if (source === null || this.removeTap !== null) return
		this.removeTap = source.addVoiceTap(this.tap)
	}

	private voice(decoderId: string): VoiceInput | null {
		const existing = this.voices.get(decoderId)
		if (existing !== undefined) return existing
		const source = this.voiceSource
		if (source === null || typeof decoderId !== "string") return null
		let v: VoiceInput
		try {
			v = new VoiceInput(
				decoderId,
				source.voiceSampleRate,
				this.counter,
				this.traceFn,
			)
		} catch {
			// An unsupported voice rate: nothing from this source can be routed.
			return null
		}
		this.voices.set(decoderId, v)
		this.voiceList = [...this.voices.values()]
		return v
	}

	private removeVoice(v: VoiceInput): void {
		v.invalidate()
		if (this.selected === v) this.select(null, this.clock.now())
		this.voices.delete(v.id)
		this.voiceList = [...this.voices.values()]
	}

	/**
	 * Coverage generation (3.4): a change invalidates queued audio and recomputes `covers` once;
	 * anything but "yes" invalidates. Then age invalidation (4.10) and the hold flush (4.11).
	 */
	private refreshVoice(v: VoiceInput, now: number): void {
		this.refreshCoverage(v)
		const at = v.out.oldestAt
		if (at !== null && now - at > LIVE_AUDIO_AUTO_ROUTE_FIFO_MS)
			this.invalidate(v)
		if (
			v.armed &&
			now - v.lastAdmittedAt >= LIVE_AUDIO_AUTO_ROUTE_DIGITAL_HOLD_MS
		)
			v.flush(now)
	}

	private refreshCoverage(v: VoiceInput): void {
		const port = this.coverage
		const g = port === null ? Number.NaN : port.generation
		if (port === null || typeof g !== "number" || !Number.isFinite(g)) {
			v.generation = Number.NaN
			v.coverage = "unknown"
		} else if (g !== v.generation) {
			this.invalidate(v)
			v.generation = g
			try {
				v.coverage = validCoverage(port.covers(v.id))
			} catch {
				v.coverage = "unknown"
			}
		}
		if (v.coverage !== "yes" && (v.out.queued > 0 || v.armed))
			this.invalidate(v)
	}

	private invalidate(v: VoiceInput): void {
		v.invalidate()
		if (this.selected === v) this.select(null, this.clock.now())
	}

	private noteCall(v: VoiceInput, call: VoiceTapCall): void {
		let snap = v.call
		if (snap === null) {
			snap = {
				callId: "",
				active: false,
				encrypted: false,
				protocol: null,
				slot: null,
			}
			v.call = snap
		}
		snap.callId = typeof call.callId === "string" ? call.callId : ""
		snap.active = call.active === true
		// Anything but an explicit false is treated as encrypted (fail closed).
		snap.encrypted = call.encrypted !== false
		snap.protocol = typeof call.protocol === "string" ? call.protocol : null
		snap.slot =
			typeof call.slot === "number" && Number.isFinite(call.slot)
				? call.slot
				: null
	}

	private onFrame(
		decoderId: string,
		pcm: Buffer,
		call: VoiceTapCall | null,
	): void {
		if (!this.running || !Buffer.isBuffer(pcm)) return
		const v = this.voice(decoderId)
		if (v === null) return
		const now = this.clock.now()
		if (call !== null && typeof call === "object") this.noteCall(v, call)
		this.refreshCoverage(v)
		const c = call === null ? null : v.call
		if (c !== null && c.encrypted) {
			this.invalidate(v)
			return
		}
		if (v.coverage === "yes" && c !== null && c.active) v.admit(pcm, now)
		else v.flush(now)
	}

	private onCall(decoderId: string, call: VoiceTapCall): void {
		if (!this.running || call === null || typeof call !== "object") return
		const v = this.voice(decoderId)
		if (v === null) return
		this.noteCall(v, call)
		if (v.call?.encrypted === true) this.invalidate(v)
		else if (v.call?.active !== true) v.flush(this.clock.now())
	}

	private onDetach(decoderId: string): void {
		const v = this.voices.get(decoderId)
		if (v !== undefined) this.removeVoice(v)
	}
}
