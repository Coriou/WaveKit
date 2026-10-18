/**
 * Rust live-demod run: selection, start, retune, squelch updates, and the
 * fallback latch. `LiveDemodulator` is the host (audio, measurement, restart)
 * and does not keep this state.
 */

import { PassThrough, type Readable } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { LIVE_AUDIO_NOISE_QUIETING_DB } from "@wavekit/api-types"
import type { SourceCaps } from "../../config.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import type { Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import { ChannelSquelch } from "../channel-squelch.js"
import type { SilenceFillClock } from "../live-audio-silence.js"
import type { LiveDemodConfig, PipelineRun } from "../live-demodulator.js"
import type { DemodSquelch } from "./engine.js"
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
	quieted: boolean
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
	centerHz(sourceId: string): number | undefined
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
		const identity = [...RUST_IDENTITY_KEYS].some(
			key => previous[key] !== next[key],
		)
		if (identity) {
			run.gateHeld = true
			this.host.publishSquelchChange()
			this.host.resetFloorForRetune(run)
			this.host.clearCloseOverride()
		}
		const sourceId = this.host.activeSourceId()
		const center = sourceId ? this.host.centerHz(sourceId) : undefined
		run.rust?.applyRetune(planRetune(previous, next, center))
		this.pushSquelch(run)
	}

	pushSquelch(run: PipelineRun): void {
		const engine = run.rust
		if (!engine) return
		const squelch = squelchFor(
			this.host.config(),
			this.host.effectiveThreshold(run),
		)
		const encoded = JSON.stringify(squelch)
		if (encoded === this.lastSentSquelch) return
		this.lastSentSquelch = encoded
		engine.applySquelch(squelch)
	}

	/**
	 * True when this attempt consumed the start (the engine is up, or a crash
	 * is backing off). False continues with the csdr chain. A fallback does
	 * not throw.
	 */
	async tryStart(planned: { caps: SourceCaps }): Promise<boolean> {
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
				if (!this.host.httpListening() && !this.rustUnstable) {
					this.host.markStartError(RUST_EXIT_REASON)
					throw new WaveKitError(RUST_EXIT_REASON, "LIVE_DEMOD_PIPELINE_EXIT")
				}
				if (this.rustUnstable && !this.host.httpListening()) {
					this.noteFallback("process-unstable")
					return false
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
		if (run.gateHeld) run.gateHeld = false
		this.host.publishSquelchChange()
	}

	private onMetrics(
		run: PipelineRun,
		powerDbfs: Array<number | null>,
		quietingDb: Array<number | null>,
	): void {
		if (this.host.currentRun() !== run || run.stopping) return
		const count = Math.max(powerDbfs.length, quietingDb.length)
		for (let i = 0; i < count; i++) {
			const power = powerDbfs[i] ?? null
			if (power !== null) run.externalPowerDbfs = power
			this.host.measureRun(run, { powerDbfs: power, quieted: false })
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
