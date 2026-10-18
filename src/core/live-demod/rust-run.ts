/**
 * Rust live-demod run: selection, start, retune, squelch updates, and the
 * fallback latch. `LiveDemodulator` is the host (audio, measurement, restart)
 * and does not keep this state.
 */

import { PassThrough, type Readable } from "node:stream"
import type { ChildProcess } from "node:child_process"
import {
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
} from "@wavekit/api-types"
import type { SourceCaps } from "../../config.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import type { Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import { ChannelSquelch } from "../channel-squelch.js"
import type { SilenceFillClock } from "../live-audio-silence.js"
import type { LiveDemodConfig, PipelineRun } from "../live-demodulator.js"
import type { DemodRetune, DemodSquelch } from "./engine.js"
import { RustEngine, type RustStartResult } from "./rust-engine.js"
import { planRetune, squelchFor } from "./rust-protocol.js"
import {
	DEMOD_PROTOCOL,
	RUST_AUDIO_RATE_HZ,
	RUST_FALLBACK_LOG,
	bandwidthAccepted,
	selectEngine,
	type EngineFallbackReason,
} from "./select-engine.js"

/**
 * Auto squelch has no floor when the Rust engine opens. -0.001 dBFS is the
 * csdr chain's seed (the node squelch, and the floor formula before the first
 * block): just under 0, so `squelchFor` stays in power mode (0 would turn
 * the gate off) and the gate cannot open until metrics supply a floor.
 */
export const RUST_AUTO_INITIAL_THRESHOLD_DBFS = -0.001

/** Absent `engine` is the csdr chain. Parsed config leaves the key off. */
export function rustEngineRequested(config: {
	engine?: "csdr" | "rust" | undefined
}): boolean {
	return (config.engine ?? "csdr") === "rust"
}

/** Pipeline keys a running Rust demod can apply with one `retune`. */
const RUST_RETUNE_KEYS = new Set<keyof LiveDemodConfig>([
	"offsetHz",
	"bandwidth",
	"modulation",
	"gain",
	"lowPass",
	"highPass",
	"noiseReduction",
	"deEmphasis",
	"deEmphasisTau",
])

/** Retune keys that close the open transmission, matching a csdr front swap. */
const RUST_IDENTITY_KEYS = new Set<keyof LiveDemodConfig>([
	"offsetHz",
	"bandwidth",
	"modulation",
])

const RUST_EXIT_REASON = "Live demodulation Rust engine exited"

export interface RustPowerSample {
	powerDbfs: number | null
	/** FM quieting shows a carrier, matching `ChannelSquelch.blockQuieted`. */
	quieted: boolean
	/** Quieting of this block, or null when the engine did not report one. */
	quietingDb: number | null
}

/**
 * What the Rust run may ask the demodulator to do. It does not read the
 * demodulator's private fields.
 */
export interface RustRunHost {
	readonly log: Logger
	readonly clock: SilenceFillClock
	config(): LiveDemodConfig
	branchStream(): Readable | null
	httpListening(): boolean
	stableRunMs(): number
	activeSourceId(): string | null
	squelchHangMs(): number
	effectiveThreshold(run: PipelineRun): number
	currentRun(): PipelineRun | null
	handleAudioData(chunk: Buffer): void
	publishSquelchChange(): void
	handleRunFailure(run: PipelineRun, reason: string): void
	measureRun(run: PipelineRun, sample: RustPowerSample): void
	resetFloorForRetune(run: PipelineRun): void
	clearCloseOverride(): void
	adoptRun(run: PipelineRun): void
	markStartError(reason: string): void
	emitError(error: Error): void
	scheduleRestart(lastRunMs: number): void
}

export class RustLiveRun {
	private rustFailures = 0
	/** Latched after three Rust deaths until the next restart-key change. */
	private rustUnstable = false
	private engineFallback: EngineFallbackReason | null = null
	private warnedFallback: EngineFallbackReason | null = null
	/** Last squelch JSON sent, so an unchanged threshold is not repeated. */
	private lastSentSquelch = ""
	/**
	 * One retune is unacknowledged at a time. `retuned` carries no sequence,
	 * and native folds every retune queued before the next input block into
	 * a single `retuned`, so a count of writes cannot be matched to events.
	 * The next retune is sent only after the previous `retuned`. Updates that
	 * arrive in between fold into that next write.
	 */
	private inFlight = false
	/** The in-flight retune is an identity change the hold is waiting on. */
	private inFlightHoldsIdentity = false
	/** An identity change has been requested and not yet applied. */
	private identityUnacked = false
	private sentConfig: LiveDemodConfig | null = null
	private queuedConfig: LiveDemodConfig | null = null
	/** Rust died during the initial start, before HTTP can arm the backoff. */
	private deferredStartFailure: string | null = null

	constructor(private readonly host: RustRunHost) {}

	fallback(): EngineFallbackReason | null {
		return this.engineFallback
	}

	/** 48 kHz while Rust owns the run; null on the csdr path. */
	audioRateHz(): number | null {
		return this.host.currentRun()?.rust ? RUST_AUDIO_RATE_HZ : null
	}

	clearLatch(): void {
		this.rustUnstable = false
		this.rustFailures = 0
	}

	noteCrash(lastRunMs: number): void {
		if (lastRunMs >= this.host.stableRunMs()) this.rustFailures = 0
		this.rustFailures += 1
		if (this.rustFailures >= 3) this.rustUnstable = true
	}

	canRetune(
		keys: ReadonlyArray<keyof LiveDemodConfig>,
		next: LiveDemodConfig,
	): boolean {
		const run = this.host.currentRun()
		if (!run?.rust || run.stopping || this.rustUnstable) return false
		if (!rustEngineRequested(this.host.config())) return false
		if (keys.length === 0) return false
		if (!keys.every(key => RUST_RETUNE_KEYS.has(key))) return false
		if (next.modulation !== "nfm" && next.modulation !== "am") return false
		if (!bandwidthAccepted(next.bandwidth)) return false
		return true
	}

	retune(
		run: PipelineRun,
		previous: LiveDemodConfig,
		next: LiveDemodConfig,
	): void {
		if (identityChanged(previous, next)) {
			run.gateHeld = true
			this.identityUnacked = true
			this.host.publishSquelchChange()
			this.host.resetFloorForRetune(run)
			this.host.clearCloseOverride()
		}
		// A retune already on the wire may be acknowledged before this one is
		// applied. Hold it and send it when that `retuned` arrives.
		if (this.inFlight) {
			this.queuedConfig = next
			this.pushSquelch(run)
			return
		}
		this.dispatchRetune(run, previous, next)
	}

	pushSquelch(run: PipelineRun): void {
		const engine = run.rust
		if (!engine) return
		const squelch = withTrackedFloor(
			squelchFor(this.host.config(), this.host.effectiveThreshold(run)),
			run.noiseFloorDbfs,
		)
		const encoded = JSON.stringify(squelch)
		if (encoded === this.lastSentSquelch) return
		this.lastSentSquelch = encoded
		engine.applySquelch(squelch)
	}

	/**
	 * Arms the backoff for a Rust crash that happened before HTTP was up.
	 * `scheduleRestart` does nothing until the server is listening.
	 */
	flushDeferredRestart(): void {
		const reason = this.deferredStartFailure
		if (reason === null) return
		this.deferredStartFailure = null
		this.failStart(reason)
	}

	/**
	 * True when this attempt consumed the start (the engine is up, or a crash
	 * is backing off). False continues with the csdr chain. A fallback does
	 * not throw.
	 */
	async tryStart(planned: { caps: SourceCaps }): Promise<boolean> {
		this.resetRetuneTracking()
		const config = this.host.config()
		if (!rustEngineRequested(config)) return false
		const branch = this.host.branchStream()
		if (!branch) return false
		const pre = selectEngine({
			config: {
				engine: "rust",
				modulation: config.modulation,
				bandwidth: config.bandwidth,
			},
			caps: { format: planned.caps.format },
			probe: {
				available: true,
				protocol: DEMOD_PROTOCOL,
				processUnstable: this.rustUnstable,
				openRejected: !bandwidthAccepted(config.bandwidth),
			},
		})
		if (pre.engine !== "rust") {
			if (pre.fallback) this.noteFallback(pre.fallback)
			return false
		}
		const threshold =
			config.squelchMode === "auto"
				? RUST_AUTO_INITIAL_THRESHOLD_DBFS
				: config.squelch
		const squelch = squelchFor(config, threshold)
		const engine = new RustEngine({
			binaryPath: config.chanBinaryPath ?? "wavekit-chan",
			logger: this.host.log,
			clock: this.host.clock,
		})
		const slot: { run: PipelineRun | null } = { run: null }
		let result: RustStartResult
		try {
			result = await engine.start({
				config,
				caps: planned.caps,
				input: branch,
				squelch,
				handlers: {
					onAudio: chunk => {
						const current = slot.run
						if (
							current &&
							this.host.currentRun() === current &&
							!current.stopping
						)
							this.host.handleAudioData(chunk)
					},
					onGate: open => {
						const current = slot.run
						if (current) this.onGate(current, open)
					},
					onRetuned: () => {
						const current = slot.run
						if (current) this.onRetuned(current)
					},
					onMetrics: (power, quieting) => {
						const current = slot.run
						if (current) this.onMetrics(current, power, quieting)
					},
					onDown: () => {
						const current = slot.run
						if (current && this.host.currentRun() === current)
							this.host.handleRunFailure(current, RUST_EXIT_REASON)
					},
				},
			})
		} catch (error: unknown) {
			this.noteFallback("binary-unavailable", error)
			await engine.stop()
			return false
		}
		if (!result.ok) {
			if ("crashed" in result) {
				await engine.stop()
				this.noteCrash(0)
				if (!this.host.httpListening()) {
					if (this.rustUnstable) {
						this.noteFallback("process-unstable")
						return false
					}
					// Count the death and retry under the existing backoff once
					// HTTP is up. Falling straight through to csdr, or throwing,
					// skips that path: the restart timer requires the server.
					this.deferredStartFailure = RUST_EXIT_REASON
					this.host.markStartError(RUST_EXIT_REASON)
					return true
				}
				this.failStart(RUST_EXIT_REASON)
				return true
			}
			this.noteFallback(result.fallback, result.error)
			return false
		}
		const child = engine.childProcess
		if (!child) {
			this.noteFallback("binary-unavailable")
			await engine.stop()
			return false
		}
		const run = this.buildRun(engine, child, planned, threshold, squelch)
		slot.run = run
		this.engineFallback = null
		this.warnedFallback = null
		this.lastSentSquelch = JSON.stringify(squelch)
		this.host.adoptRun(run)
		this.host.log.info(
			{
				sourceId: this.host.activeSourceId(),
				effectiveSampleRate: RUST_AUDIO_RATE_HZ,
				offsetHz: this.host.config().offsetHz,
			},
			"Starting live demodulation Rust engine",
		)
		return true
	}

	private failStart(reason: string): void {
		this.host.markStartError(reason)
		this.host.log.error({ reason }, "Live demodulation pipeline failed")
		this.host.emitError(new WaveKitError(reason, "LIVE_DEMOD_PIPELINE_EXIT"))
		this.host.scheduleRestart(0)
	}

	private noteFallback(reason: EngineFallbackReason, error?: unknown): void {
		this.engineFallback = reason
		if (this.warnedFallback === reason) return
		this.warnedFallback = reason
		this.host.log.warn(
			error === undefined
				? { reason }
				: { reason, err: safeErrorFields(error) },
			RUST_FALLBACK_LOG,
		)
	}

	private onGate(run: PipelineRun, open: boolean): void {
		if (this.host.currentRun() !== run || run.stopping) return
		run.externalGate = open
		// An identity retune holds the transmission until `retuned`. Native emits
		// `gate` only on transitions, so a gate event must not release the hold.
		this.host.publishSquelchChange()
	}

	/** `retuned` is the atOutputSample boundary of the in-flight retune. */
	private onRetuned(run: PipelineRun): void {
		if (this.host.currentRun() !== run || run.stopping) return
		const coveredIdentity = this.inFlightHoldsIdentity
		this.inFlight = false
		this.inFlightHoldsIdentity = false
		const queued = this.queuedConfig
		const sent = this.sentConfig
		if (queued !== null && sent !== null) {
			this.queuedConfig = null
			// This ack does not cover a newer identity that is still queued.
			if (coveredIdentity && !identityChanged(sent, queued))
				this.releaseHold(run)
			this.dispatchRetune(run, sent, queued)
			return
		}
		if (coveredIdentity) this.releaseHold(run)
	}

	private releaseHold(run: PipelineRun): void {
		this.identityUnacked = false
		if (!run.gateHeld) return
		run.gateHeld = false
		this.host.publishSquelchChange()
	}

	/**
	 * offsetHz is the shift from the tuned centre. A source-centre change
	 * keeps this process (the csdr chain does too): IQ DC is the new centre,
	 * and native still mixes `centerHz - input_center` with the centre from
	 * process start. Sending the live source centre would add that retune
	 * on top of the frozen input centre.
	 */
	private dispatchRetune(
		run: PipelineRun,
		previous: LiveDemodConfig,
		next: LiveDemodConfig,
	): void {
		const plan = planRetune(
			previous,
			next,
			run.rust?.inputCenterHz ?? undefined,
		)
		if (hasRetunePlan(plan)) {
			run.rust?.applyRetune(plan)
			this.inFlight = true
			this.inFlightHoldsIdentity =
				identityChanged(previous, next) && this.identityUnacked
		} else if (identityChanged(previous, next) && this.identityUnacked) {
			this.releaseHold(run)
		}
		this.sentConfig = next
		this.pushSquelch(run)
	}

	private resetRetuneTracking(): void {
		this.inFlight = false
		this.inFlightHoldsIdentity = false
		this.identityUnacked = false
		this.sentConfig = null
		this.queuedConfig = null
	}

	private onMetrics(
		run: PipelineRun,
		powerDbfs: Array<number | null>,
		quietingDb: Array<number | null>,
	): void {
		if (this.host.currentRun() !== run || run.stopping) return
		const config = this.host.config()
		const count = Math.max(powerDbfs.length, quietingDb.length)
		for (let i = 0; i < count; i++) {
			const power = powerDbfs[i] ?? null
			const quieting = quietingDb[i] ?? null
			if (power !== null) run.externalPowerDbfs = power
			this.host.measureRun(run, {
				powerDbfs: power,
				quieted: metricsQuieted(config, quieting),
				quietingDb: quieting,
			})
		}
		this.pushSquelch(run)
	}

	private buildRun(
		engine: RustEngine,
		child: ChildProcess,
		planned: { caps: SourceCaps },
		threshold: number,
		squelch: DemodSquelch,
	): PipelineRun {
		const config = this.host.config()
		const stream = {
			rate: RUST_AUDIO_RATE_HZ,
			format: config.audioFormat,
		}
		const nodeSquelch = new ChannelSquelch({
			sampleRate: RUST_AUDIO_RATE_HZ,
			thresholdDbfs: threshold,
			hangMs: this.host.squelchHangMs(),
			mode: config.squelchMode === "noise" ? "noise" : "power",
			noiseQuietingDb:
				config.noiseQuietingDb ?? LIVE_AUDIO_NOISE_QUIETING_DB.default,
			...(config.bandwidth > 0 ? { bandwidthHz: config.bandwidth } : {}),
			// Carrier evidence matches the csdr run. Metrics supply the quieting;
			// the IQ meter inside this squelch is not fed.
			...(LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(config.modulation)
				? { carrierEvidence: true }
				: {}),
		})
		return {
			front: child,
			back: child,
			frontAligner: null,
			frontCommand: "",
			backCommand: "",
			detachFront: () => undefined,
			swap: null,
			gateHeld: false,
			squelch: nodeSquelch,
			// Metrics drive the floor. Nothing writes this stream; stop destroys it.
			squelchStream: new PassThrough(),
			noiseFloorDbfs: null,
			retuneFloorDbfs: null,
			startedAt: Date.now(),
			sourceSampleRate: planned.caps.sampleRate,
			sourceFormat: planned.caps.format,
			stream,
			tone: null,
			pcmPhase: 0,
			pcmTailMuted: false,
			stopping: false,
			failed: false,
			rust: engine,
			externalGate: squelch.mode === "off",
		}
	}
}

/**
 * `ChannelSquelch.blockQuieted`: auto nfm/wfm, quieting at least the observer
 * threshold (`LIVE_AUDIO_NOISE_QUIETING_DB.default`). `noiseQuietingDb` is the
 * noise-mode gate, not this floor predicate.
 */
function metricsQuieted(
	config: LiveDemodConfig,
	quietingDb: number | null,
): boolean {
	if (config.squelchMode !== "auto") return false
	if (!LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(config.modulation))
		return false
	return (
		quietingDb !== null && quietingDb >= LIVE_AUDIO_NOISE_QUIETING_DB.default
	)
}

function identityChanged(
	previous: LiveDemodConfig,
	next: LiveDemodConfig,
): boolean {
	return [...RUST_IDENTITY_KEYS].some(key => previous[key] !== next[key])
}

function hasRetunePlan(update: DemodRetune): boolean {
	return (
		update.centerHz !== undefined ||
		update.bandwidthHz !== undefined ||
		update.modulation !== undefined ||
		update.audio !== undefined
	)
}

/** Attach the tracked floor. `null` clears it on the wire; a number sets it. */
function withTrackedFloor(
	squelch: DemodSquelch,
	noiseFloorDbfs: number | null,
): DemodSquelch {
	return { ...squelch, noiseFloorDbfs }
}
