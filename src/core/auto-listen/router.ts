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
	LiveAudioAutoRouteReason,
	LiveAudioAutoRouteSource,
	LiveAudioListenMode,
} from "@wavekit/api-types"
import { AudioClientRegistry } from "../audio-stream-server.js"
import type { StreamFormat } from "../audio-stream-server.js"
import type { Logger } from "../../utils/logger.js"
import {
	AUTO_ROUTE_BLOCK_BYTES,
	AUTO_ROUTE_BLOCK_SAMPLES,
	AUTO_ROUTE_OPERATOR_MODE_MAX_MS,
	AUTO_ROUTE_PENDING_END_GUARD_MS,
	AUTO_ROUTE_STREAM,
	AUTO_ROUTE_TAKEOVER_MS,
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
import type { AutoRouteTraceFn, DropCounter, PendingCounter } from "./inputs.js"
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

/**
 * Seam for a call event's optional `encryptionKnown` (not in `VoiceTapCall` yet): true only when
 * the event says outright that its encryption is not known yet. Such a call is not clear (fail
 * closed): its voice waits as pending voice and is let go if the call ends so. A clear call that
 * turns unresolved (this snapshot after an active, clear one) invalidates its queued voice
 * (counted, as an encrypted turn does; see `noteCall`).
 *
 * When the field lands, it must also be forwarded by the digital voice service: its
 * `handleVoiceCall` (src/core/digital-voice.ts) rebuilds the `DigitalVoiceCall` it hands to the
 * taps field by field, so a field the decoder sets but that rebuild omits never reaches here and
 * every call reads as resolved.
 */
export function encryptionUnresolved(call: VoiceTapCall): boolean {
	const known: unknown = (call as Partial<Record<"encryptionKnown", unknown>>)
		.encryptionKnown
	return known === false
}

/** Listen: an unknown listen mode keeps the default `auto` (the route as it always was). */
function validListenMode(value: unknown): LiveAudioListenMode {
	return value === "analog" || value === "digital" ? value : "auto"
}

export class AutoListenRouter extends EventEmitter {
	readonly registry: AudioClientRegistry
	private readonly log: Logger
	private readonly clock: AutoRouteClock
	private readonly wallClock: () => number
	private readonly traceFn: AutoRouteTraceFn | undefined
	private readonly counter: DropCounter = { droppedSamples: 0 }
	/** `autoRoute.pendingOverwrittenMs`: pending voice the bound let go (diagnostic, uncounted). */
	private readonly pendingCounter: PendingCounter = { overwrittenMs: 0 }
	/**
	 * `autoRoute.analogSupersededMs` (samples here): audible unchecked analog let go while a
	 * covering call took it over (diagnostic, never part of `droppedMs`).
	 */
	private analogSuperseded = 0
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
	/** At 48 000 samples/s a double stays exact for over 5 000 years. */
	private zeroFilled = 0
	/**
	 * Zeros played while the selected voice has nothing queued. They count only if the voice goes on: waiting
	 * out the release after a call's last frame (about 98 ms per call, up to the 300 ms hold) is not lost audio.
	 */
	private voiceFillPending = 0
	private selected: Selected = null
	private selectedAt = 0
	private sinceWall: number
	private tickFailed = false

	/**
	 * Listen policy. `mode` is in force; `requested` (`analog` while the squelch is open, else the
	 * configured mode) replaces it at once when it still plays the source playing now (or nothing
	 * plays), since no switch follows; otherwise at the playing source's release (a transmission
	 * boundary). The route never switches source mid-over for a mode change.
	 */
	private mode: LiveAudioListenMode = "auto"
	private requested: LiveAudioListenMode = "auto"
	private configuredMode: LiveAudioListenMode = "auto"
	private squelchOpen = false
	/** Cached "does any decoder cover the tuned channel", per coverage generation and id list. */
	private coveredAt = Number.NaN
	/** The id list the cached answer was computed for (a copy, replaced only when it changes). */
	private coveredIds: string[] | null = null
	private coveredAny: boolean | null = false
	/** Clock time of the operator's pending listen mode change (NaN: none pending). */
	private operatorAt = Number.NaN
	/**
	 * Takeover: whether the analog played now passed a check of its content (the evidence gate or
	 * a tone squelch). Unchecked analog yields to an admitted clear call after the 200 ms takeover
	 * instead of the 1.5 s preemption bound. Defaults to checked (the route as it was).
	 */
	private analogChecked = true
	/** While `choose` runs, `auto-route-changed` is emitted once at its end (one event per block). */
	private holdEmit = false
	private heldEmit = false

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

	/** Output samples that were zeros because the selected source ran short. */
	get zeroFilledSamples(): number {
		return this.zeroFilled
	}

	get droppedSamples(): number {
		return this.counter.droppedSamples
	}

	/** Pending voice overwritten by its bound (or older than it at admission), ms, cumulative. */
	get pendingOverwrittenMs(): number {
		return this.pendingCounter.overwrittenMs
	}

	/** Audible unchecked analog superseded by a covering call (takeover), ms, cumulative. */
	get analogSupersededMs(): number {
		return this.analogSuperseded / SAMPLES_PER_MS
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
		const flag = audible ? FLAG_AUDIBLE : FLAG_SILENT
		// Listen: `digital` in force with nothing pending never plays analog (every block discards
		// it): no resampling, the audibility state and the sample grid kept.
		if (this.mode === "digital" && this.requested === "digital")
			this.analog.skip(chunk, start, end, flag, stream, this.clock.now())
		else this.analog.push(chunk, start, end, flag, stream, this.clock.now())
	}

	/**
	 * Takeover: whether the analog handed over now passed a check of its content (the evidence
	 * gate or a tone squelch governs it). Unchecked analog (Voice only off, a manual or carrier
	 * squelch) is taken over by an admitted clear call after `AUTO_ROUTE_TAKEOVER_MS`, and while
	 * that call plays the analog queued meanwhile (its own carrier) is let go uncounted.
	 */
	setAnalogVoiceChecked(checked: boolean): void {
		this.analogChecked = checked !== false
	}

	/** Retune, offset or modulation change, pipeline stop (requirement 5.1). */
	resetAnalog(): void {
		this.analog.reset()
		// The next analog is checked until the demodulator says otherwise (the safe default).
		this.analogChecked = true
		if (this.selected === this.analog) this.select(null, this.clock.now())
	}

	/**
	 * Listen: the configured `listenMode` and whether the squelch is `open` (which forces
	 * `analog`). Applies at once when nothing plays (or no client listens) or when the new mode
	 * still plays the source playing now (no switch follows: `analog` during an analog over,
	 * `auto` always, `digital` during a call); otherwise when the playing transmission releases,
	 * so one transmission is heard from one source.
	 */
	setListenPolicy(listenMode: LiveAudioListenMode, squelchOpen: boolean): void {
		this.configuredMode = validListenMode(listenMode)
		this.squelchOpen = squelchOpen === true
		const before = this.requested
		this.requested = this.squelchOpen ? "analog" : this.configuredMode
		if (this.requested === this.mode) {
			this.operatorAt = Number.NaN
			return
		}
		const now = this.clock.now()
		// An operator change: it waits at most AUTO_ROUTE_OPERATOR_MODE_MAX_MS from the latest one.
		if (this.requested !== before || Number.isNaN(this.operatorAt))
			this.operatorAt = now
		if (!this.running) this.applyMode(now)
		else this.applyWithoutSwitch(now)
	}

	/** Listen: the listen mode in force (see `setListenPolicy`). */
	get listenMode(): LiveAudioListenMode {
		return this.mode
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
			zeroFilledSamples: this.zeroFilled,
			droppedMs: this.counter.droppedSamples / SAMPLES_PER_MS,
			pendingOverwrittenMs: this.pendingCounter.overwrittenMs,
			analogSupersededMs: this.analogSuperseded / SAMPLES_PER_MS,
			clockRebases: this.rebases,
			latencyMs:
				(sel === null ? 0 : sel.out.queued) / SAMPLES_PER_MS +
				LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
			listenMode: this.mode,
		}
		if (this.requested !== this.mode) route.pendingListenMode = this.requested
		const reason = this.reason()
		if (reason !== null) route.reason = reason
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
		const reason = this.reason()
		if (reason !== null) level.reason = reason
		return level
	}

	/**
	 * Listen: `squelch-open` when the open squelch overrides a configured `auto` or `digital`;
	 * `no-decoder` while `digital` is in force and every decoder answers that it does not cover
	 * the tuned channel (or none exists). Unknown coverage (a decoder answering `unknown`, a
	 * throwing `covers` or id list) reports nothing; the route still treats it as not covered
	 * and plays only decoded voice of covering decoders (silence otherwise).
	 */
	private reason(): LiveAudioAutoRouteReason | null {
		if (this.squelchOpen && this.configuredMode !== "analog")
			return "squelch-open"
		if (this.mode === "digital" && this.digitalCovered() === false)
			return "no-decoder"
		return null
	}

	/**
	 * True when a decoder covers the tuned channel, false when every decoder answers `no` (or
	 * there is none), null when any answer is unknown and none is `yes`. With the source's
	 * `voiceDecoderIds` the answer is computed once per coverage generation and id list
	 * (`covers` is called only then, and the list is compared element by element against the
	 * cached copy, so a steady state allocates nothing here); a decoder added or removed changes
	 * the list and refreshes the answer. Without it only decoders heard from count.
	 */
	private digitalCovered(): boolean | null {
		const source = this.voiceSource
		const port = this.coverage
		if (source === null || port === null) return false
		let ids: readonly string[] | undefined
		try {
			ids = source.voiceDecoderIds?.()
		} catch {
			return null
		}
		if (ids === undefined || !Array.isArray(ids)) {
			for (let i = 0; i < this.voiceList.length; i++)
				if (this.voiceList[i]?.coverage === "yes") return true
			return null
		}
		const g = port.generation
		if (typeof g !== "number" || !Number.isFinite(g)) return null
		if (g !== this.coveredAt || !this.sameCoveredIds(ids)) {
			let any: boolean | null = false
			for (const id of ids) {
				if (typeof id !== "string") {
					any = null
					continue
				}
				let answer: VoiceCoverage
				try {
					answer = validCoverage(port.covers(id))
				} catch {
					answer = "unknown"
				}
				if (answer === "yes") {
					any = true
					break
				}
				// Unknown is not "no": it routes as not covering but never reports no-decoder.
				if (answer === "unknown") any = null
			}
			this.coveredAt = g
			this.coveredIds = ids.slice()
			this.coveredAny = any
		}
		return this.coveredAny
	}

	/** Whether `ids` is the cached id list, element by element (no allocation). */
	private sameCoveredIds(ids: readonly string[]): boolean {
		const cached = this.coveredIds
		if (cached === null || cached.length !== ids.length) return false
		for (let i = 0; i < ids.length; i++) if (cached[i] !== ids[i]) return false
		return true
	}

	/**
	 * Listen: puts `requested` in force. Entering `analog` empties every voice FIFO, entering
	 * `digital` the analog FIFO, uncounted (policy, not lost audio).
	 */
	private applyMode(now: number): void {
		const next = this.requested
		this.operatorAt = Number.NaN
		if (next === this.mode) return
		this.mode = next
		if (next === "analog") for (const v of this.voiceList) v.discard()
		if (next === "digital") this.analog.discardQueued()
		if (this.selected !== null && !this.plays(this.selected))
			this.select(null, now)
		else this.changed()
	}

	/** Whether the listen mode in force plays this input. */
	private plays(input: AnalogInput | VoiceInput): boolean {
		return AutoListenRouter.playsUnder(input === this.analog, this.mode)
	}

	/** Whether `mode` plays analog (`isAnalog`) or decoded voice. */
	private static playsUnder(
		isAnalog: boolean,
		mode: LiveAudioListenMode,
	): boolean {
		return isAnalog ? mode !== "digital" : mode !== "analog"
	}

	/** `auto-route-changed`, or noted for the end of `choose` (one event per block). */
	private changed(): void {
		if (this.holdEmit) this.heldEmit = true
		else this.emit("auto-route-changed", this.level())
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
		this.analogChecked = true
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
		// Silent audio of a source that is not playing is never kept (4.3); under `digital` no
		// analog is kept at all (uncounted: the mode never plays it).
		if (this.mode === "digital") this.analog.discardQueued()
		else if (sel instanceof VoiceInput && !this.analogChecked)
			// Takeover: unchecked analog queued while a covering call plays is that call's own
			// carrier (raw buzz), let go so it never plays after the call: not a drop, but its
			// audible part is reported as `analogSupersededMs`.
			this.analogSuperseded += this.analog.discardQueued()
		else if (sel !== this.analog) this.analog.out.discardUntilAudible()
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
			const short = AUTO_ROUTE_BLOCK_SAMPLES - got
			if (short > 0) this.underrunCount++
			if (sel === this.analog) this.zeroFilled += short
			else {
				// A whole block means the voice went on; a call's tail only ever trickles short ones.
				if (short === 0) {
					this.zeroFilled += this.voiceFillPending
					this.voiceFillPending = 0
				} else this.voiceFillPending += short
			}
		}
		// A fresh block: the registry and the socket may keep the reference (2.8).
		const out = Buffer.allocUnsafe(AUTO_ROUTE_BLOCK_BYTES)
		this.blockBytes.copy(out, 0, 0, AUTO_ROUTE_BLOCK_BYTES)
		this.registry.write(out)
	}

	/**
	 * Switching rules (4.1, 4.4, 4.5, 4.6, 4.9), then the listen mode: a pending mode is put in
	 * force at once when it still plays the playing source (or nothing plays), else past that
	 * source's release (a transmission boundary). `analog` never selects a voice; `digital`
	 * never selects analog (silence when no call plays). Emits at most one route event.
	 */
	private choose(now: number): void {
		this.holdEmit = true
		try {
			this.applyWithoutSwitch(now)
			this.chooseSource(now)
			// The selection may have changed (a preemption, a start): a pending mode that plays it
			// is in force from this block.
			this.applyWithoutSwitch(now)
			// An operator change still waiting on an audible source is in force at its bound: the
			// only switch a mode makes mid-over.
			if (
				this.requested !== this.mode &&
				now - this.operatorAt >= AUTO_ROUTE_OPERATOR_MODE_MAX_MS
			) {
				this.applyMode(now)
				this.chooseSource(now)
			}
		} finally {
			this.holdEmit = false
			if (this.heldEmit) {
				this.heldEmit = false
				this.emit("auto-route-changed", this.level())
			}
		}
	}

	/** A pending mode that still plays the playing source (or nothing plays) needs no switch. */
	private applyWithoutSwitch(now: number): void {
		const playing = this.selected
		if (
			this.requested !== this.mode &&
			(playing === null ||
				AutoListenRouter.playsUnder(playing === this.analog, this.requested))
		)
			this.applyMode(now)
	}

	private chooseSource(now: number): void {
		const sel = this.selected
		if (sel === this.analog) {
			// Preemption is part of `auto` only; a pending `analog` keeps the analog over.
			const pre =
				this.mode === "auto" && this.requested !== "analog"
					? this.preemptor(now)
					: null
			if (pre !== null) {
				// 4.5: analog's remaining queued audio is dropped and counted. Its silent head is
				// discarded first, uncounted (4.3), so a preemption after analog has gone quiet
				// (including one in the same block as its release) loses and counts nothing.
				// Takeover of unchecked analog: what is queued is the call's own carrier (raw
				// buzz), let go as `analogSupersededMs`, not a drop.
				this.analog.out.discardUntilAudible()
				if (this.analogChecked) this.analog.out.dropAll()
				else this.analogSuperseded += this.analog.discardQueued()
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
		// A transmission boundary: nothing plays or the playing source has released.
		if (this.requested !== this.mode) this.applyMode(now)
		if (this.mode !== "analog") {
			const digital = this.oldestEligible()
			if (digital !== null) {
				// Digital beats analog: wait for its start buffer rather than start analog (4.1, 4.6).
				this.select(this.startReady(digital, now) ? digital : null, now)
				return
			}
			if (this.mode === "digital") {
				this.select(null, now)
				return
			}
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

	/** The 200 ms start buffer (4.6), also the takeover bound of unchecked analog. */
	private startReady(v: VoiceInput, now: number): boolean {
		if (v.out.queuedQualified >= START_SAMPLES) return true
		const at = v.out.oldestAt
		return at !== null && now - at >= AUTO_ROUTE_TAKEOVER_MS
	}

	/**
	 * An eligible voice whose oldest queued sample has waited the preemption bound (4.5), or for
	 * unchecked analog the takeover bound (its start buffer, `AUTO_ROUTE_TAKEOVER_MS`).
	 */
	private preemptor(now: number): VoiceInput | null {
		const v = this.oldestEligible()
		if (v === null) return null
		if (!this.analogChecked) return this.startReady(v, now) ? v : null
		const at = v.out.oldestAt
		return at !== null && now - at >= LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS
			? v
			: null
	}

	private select(next: Selected, now: number): void {
		if (next === this.selected) return
		// 4.3: a switch starts the new source at its oldest queued audible sample, so silence
		// queued before it (between blocks, or before the first tick) is not played.
		if (next !== null) next.out.discardUntilAudible()
		this.selected = next
		this.voiceFillPending = 0
		this.selectedAt = now
		this.sinceWall = this.wallClock()
		this.changed()
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
				this.pendingCounter,
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
		if (
			v.coverage !== "yes" &&
			(v.out.queued > 0 || v.armed || v.pending.length > 0)
		)
			this.invalidate(v)
	}

	private invalidate(v: VoiceInput): void {
		v.invalidate()
		if (this.selected === v) this.select(null, this.clock.now())
	}

	/**
	 * Takes the call snapshot. Returns true when a call that was active and explicitly clear is
	 * now unresolved (`encryptionKnown === false`): its queued voice must be invalidated (fail
	 * closed, as an encrypted turn).
	 */
	private noteCall(v: VoiceInput, call: VoiceTapCall, now: number): boolean {
		const wasClear =
			v.call !== null && v.call.active && !v.call.encrypted && !v.unresolved
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
		v.unresolved = encryptionUnresolved(call)
		if (snap.active) {
			// An encrypted call's voice with no call never waits as pending (fail closed).
			v.callClosed = snap.encrypted
		} else {
			// Ended: its late datagrams (no call) never become the next call's pre-voice; after
			// an encrypted or unresolved end none is kept until the next call snapshot.
			v.endedAt = now
			v.callClosed = snap.encrypted || v.unresolved
		}
		snap.protocol = typeof call.protocol === "string" ? call.protocol : null
		snap.slot =
			typeof call.slot === "number" && Number.isFinite(call.slot)
				? call.slot
				: null
		return wasClear && v.unresolved && !snap.encrypted
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
		if (
			call !== null &&
			typeof call === "object" &&
			this.noteCall(v, call, now)
		)
			this.invalidate(v)
		this.refreshCoverage(v)
		const c = call === null ? null : v.call
		if (c !== null && c.encrypted) {
			this.invalidate(v)
			return
		}
		// Listen: `analog` in force or requested never queues decoded voice (so nothing ages out
		// and counts dropped while an analog over goes on, `digital` pending included), except
		// the call playing now, which plays to its release (the pending `analog` applies then).
		if (
			(this.mode === "analog" || this.requested === "analog") &&
			v !== this.selected
		) {
			if (v.out.queued > 0 || v.armed || v.pending.length > 0) v.discard()
			return
		}
		if (v.coverage !== "yes") {
			// Never kept for a decoder that does not cover the tuned channel (refreshCoverage
			// already let its pending voice go).
			v.flush(now)
			return
		}
		if (c !== null && c.active && !v.unresolved) {
			// Active and explicitly clear: the pending head first, in order, then this frame.
			v.admitPending(now)
			v.admit(pcm, now)
		} else {
			// No call yet, or one whose encryption is unresolved: pending, never played as is.
			v.flush(now)
			// Not after an ended call, though: after an encrypted or unresolved end until the
			// next call snapshot, after a clear end for the end guard (its late datagrams).
			if (
				(c === null || !c.active) &&
				(v.callClosed || now - v.endedAt < AUTO_ROUTE_PENDING_END_GUARD_MS)
			)
				return
			v.pending.write(pcm, now)
		}
	}

	private onCall(decoderId: string, call: VoiceTapCall): void {
		if (!this.running || call === null || typeof call !== "object") return
		const v = this.voice(decoderId)
		if (v === null) return
		const now = this.clock.now()
		const turnedUnresolved = this.noteCall(v, call, now)
		if (v.call?.encrypted === true || turnedUnresolved) this.invalidate(v)
		else if (v.call?.active !== true) {
			// Ended (clear or unresolved): voice still pending was never admitted; let it go.
			v.pending.clear()
			v.flush(now)
		} else if (!v.unresolved && v.pending.length > 0) {
			// Turned active and clear: admit the pending voice now if this decoder covers the
			// tuned channel and the mode plays decoded voice.
			this.refreshCoverage(v)
			if (
				v.coverage === "yes" &&
				this.mode !== "analog" &&
				this.requested !== "analog"
			)
				v.admitPending(now)
		}
	}

	private onDetach(decoderId: string): void {
		const v = this.voices.get(decoderId)
		if (v !== undefined) this.removeVoice(v)
	}
}
