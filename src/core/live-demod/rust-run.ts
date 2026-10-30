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
import { CARRIER_LOG_GAPS } from "../analog-transmission.js"
import { ChannelSquelch } from "../channel-squelch.js"
import type { SilenceFillClock } from "../live-audio-silence.js"
import type { LiveDemodConfig, PipelineRun } from "../live-demodulator.js"
import type { DemodRetune, DemodSquelch } from "./engine.js"
import type { FramedMarker } from "../evidence-squelch/framed-audio-parser.js"
import {
	HANDSHAKE_EARLY_MAX,
	RUST_METRIC_BLOCK_SAMPLES,
	RustEngine,
	type RustStartResult,
} from "./rust-engine.js"
import {
	planRetune,
	QUIETING_DB_INFINITE,
	squelchFor,
	type QuietingDb,
} from "./rust-protocol.js"
import {
	DEMOD_PROTOCOL,
	RUST_AUDIO_RATE_HZ,
	RUST_FALLBACK_LOG,
	bandwidthAccepted,
	selectEngine,
	type EngineSelection,
	type EngineFallbackReason,
} from "./select-engine.js"

/**
 * Auto squelch has no floor when the Rust engine opens. -0.001 dBFS is the
 * csdr chain's seed (the node squelch, and the floor formula before the first
 * block): just under 0, so `squelchFor` stays in power mode (0 would turn
 * the gate off) and the gate cannot open until metrics supply a floor.
 */
export const RUST_AUTO_INITIAL_THRESHOLD_DBFS = -0.001

/**
 * Absent `engine` is the Rust engine; `csdr` selects the csdr chain. Parsed
 * config leaves the key off, so this is the one place the default lives.
 */
export const DEFAULT_LIVE_DEMOD_ENGINE = "rust" as const

export function rustEngineRequested(config: {
	engine?: "csdr" | "rust" | undefined
}): boolean {
	return (config.engine ?? DEFAULT_LIVE_DEMOD_ENGINE) === "rust"
}

/** Modulation and bandwidth a Rust demod channel can open with. */
function rustModulationAccepted(config: LiveDemodConfig): boolean {
	return (
		(config.modulation === "nfm" || config.modulation === "am") &&
		bandwidthAccepted(config.bandwidth)
	)
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

/** Fixed warn/restart text for a retune the process refused. No detail. */
export const RUST_RETUNE_REJECTED_LOG = "Live demodulation Rust retune rejected"

/**
 * `rejected.reasonCode` for a squelch write. Native uses this so a squelch
 * failure is not counted as the in-flight retune. A retune keeps
 * `channel-request-invalid`.
 */
export const SQUELCH_REJECTED_REASON = "squelch-rejected"

export interface RustPowerSample {
	/** WG10 req 3.8.1: block index in the run (output sample / 480). */
	blockIndex?: number
	/** WG10 req 3.8.1: gate state this block was decided with. */
	gateOpen?: boolean
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
	/** A18: an in-band marker of a framed run, in order with `handleAudioData`. */
	handleAudioMarker(
		run: PipelineRun,
		marker: FramedMarker,
		stage1Open: boolean,
	): void
	/** A18: the framed run failed safe; the evidence state is reset and cleared. */
	handleAudioFault(run: PipelineRun): void
	publishSquelchChange(): void
	handleRunFailure(run: PipelineRun, reason: string): void
	measureRun(run: PipelineRun, sample: RustPowerSample): void
	/** WG10 req 3.8.1: native dropped output samples (the block log keeps positions). */
	noteDiscontinuity(
		run: PipelineRun,
		sampleIndex: number,
		droppedSamples: number,
		cause: string,
	): void
	resetFloorForRetune(run: PipelineRun): void
	clearCloseOverride(): void
	/**
	 * Install the config restored after a rejected retune (`candidate`, or
	 * `acked` whole when `candidate` is not valid), re-sync the squelch and
	 * tone state, and emit `config-changed` so status listeners publish it.
	 */
	rollbackConfig(candidate: LiveDemodConfig, acked: LiveDemodConfig): void
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
	/** Last config the process has applied (`open`, or a `retuned`). */
	private ackedConfig: LiveDemodConfig | null = null
	private queuedConfig: LiveDemodConfig | null = null
	/** Retune rejections since the last `retuned`. Two in a row restart. */
	private retuneRejects = 0
	/**
	 * Control write the next `rejected` belongs to. A squelch write does not
	 * replace an outstanding retune; only `SQUELCH_REJECTED_REASON` (or a
	 * rejection whose write is the squelch) is a squelch failure.
	 */
	private controlWrite: "retune" | "squelch" | null = null
	/** Rust died during the initial start, before HTTP can arm the backoff. */
	private deferredStartFailure: string | null = null
	/** Engine whose handshake has not finished. `stop` kills this process group. */
	private starting: RustEngine | null = null
	/** Bumped when a start is cancelled so the late handshake is not adopted. */
	private startEpoch = 0

	constructor(private readonly host: RustRunHost) {}

	fallback(): EngineFallbackReason | null {
		return this.engineFallback
	}

	/** 48 kHz while Rust owns the run; null on the csdr path. */
	audioRateHz(): number | null {
		return this.host.currentRun()?.rust ? RUST_AUDIO_RATE_HZ : null
	}

	/**
	 * Format to advertise while Rust is requested and has not fallen back,
	 * and no run is up yet (the initial start, or a crash backoff). Callers
	 * that already have a run use that run's stream instead.
	 */
	pendingStream(): {
		rate: number
		format: LiveDemodConfig["audioFormat"]
	} | null {
		if (this.host.currentRun() !== null) return null
		if (!rustEngineRequested(this.host.config())) return null
		if (this.engineFallback !== null) return null
		// WFM and the other csdr-only modes fall back at start: no Rust rate.
		if (!rustModulationAccepted(this.host.config())) return null
		return {
			rate: RUST_AUDIO_RATE_HZ,
			format: this.host.config().audioFormat,
		}
	}

	clearLatch(): void {
		this.rustUnstable = false
		this.rustFailures = 0
	}

	/**
	 * An explicit csdr selection is not a fallback. `tryStart` clears the
	 * latch only when a pipeline actually starts; a stopped demodulator
	 * never gets there.
	 */
	noteEngineSelection(config: { engine?: "csdr" | "rust" | undefined }): void {
		if (rustEngineRequested(config)) return
		this.engineFallback = null
		this.warnedFallback = null
	}

	/**
	 * False when a start with `config` on a `sourceFormat` source takes the
	 * csdr chain as far as is known without a probe: csdr selected, a source
	 * that is not CU8, a csdr-only modulation or bandwidth, an unstable latch,
	 * or a binary already found missing or too old. A csdr run that would stay
	 * csdr keeps the csdr front swap instead of a restart. Shares `tryStart`'s
	 * pre-probe selection, so the two cannot disagree.
	 */
	wouldStartRust(
		config: LiveDemodConfig,
		sourceFormat: string | undefined,
	): boolean {
		return (
			rustEngineRequested(config) &&
			this.engineFallback !== "binary-unavailable" &&
			this.engineFallback !== "protocol-unsupported" &&
			this.preSelect(config, sourceFormat).engine === "rust"
		)
	}

	/**
	 * Engine selection before the version probe: every condition but the
	 * binary itself, which is assumed present at the demod protocol.
	 */
	private preSelect(
		config: LiveDemodConfig,
		sourceFormat: string | undefined,
	): EngineSelection {
		return selectEngine({
			config: {
				engine: "rust",
				modulation: config.modulation,
				bandwidth: config.bandwidth,
			},
			caps: sourceFormat === undefined ? null : { format: sourceFormat },
			probe: {
				available: true,
				protocol: DEMOD_PROTOCOL,
				processUnstable: this.rustUnstable,
				openRejected: !bandwidthAccepted(config.bandwidth),
			},
		})
	}

	/** True while `tryStart` is inside the version probe or the handshake. */
	hasPendingStart(): boolean {
		return this.starting !== null
	}

	/**
	 * Drop the in-flight start. The process group is signalled here, and a
	 * handshake that arrives afterwards is not adopted.
	 */
	async cancelPendingStart(): Promise<void> {
		this.startEpoch += 1
		const engine = this.starting
		this.starting = null
		if (engine) await engine.stop()
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
		// Diff from the config the process actually has. A rejected retune
		// leaves `sentConfig` on that ack, which may be older than `previous`.
		this.dispatchRetune(run, this.sentConfig ?? previous, next)
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
		if (this.controlWrite !== "retune") this.controlWrite = "squelch"
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
		if (!rustEngineRequested(config)) {
			// An explicit csdr selection is not a Rust fallback.
			this.engineFallback = null
			this.warnedFallback = null
			return false
		}
		const branch = this.host.branchStream()
		if (!branch) return false
		const pre = this.preSelect(config, planned.caps.format)
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
		const startup: StartupBuffer = {
			gate: null,
			metrics: [],
			discontinuities: [],
			droppedBeyond: 0,
			lastBeyondIndex: 0,
		}
		let live = false
		const epoch = this.startEpoch
		this.starting = engine
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
					onAudioMarker: (marker, stage1Open) => {
						const current = slot.run
						if (
							current &&
							this.host.currentRun() === current &&
							!current.stopping
						)
							this.host.handleAudioMarker(current, marker, stage1Open)
					},
					onAudioFault: () => {
						const current = slot.run
						if (current && this.host.currentRun() === current)
							this.host.handleAudioFault(current)
					},
					onGate: open => {
						if (!live) {
							startup.gate = open
							return
						}
						const current = slot.run
						if (current) this.onGate(current, open)
					},
					onRetuned: () => {
						if (!live) return
						const current = slot.run
						if (current) this.onRetuned(current)
					},
					onDiscontinuity: (sampleIndex, dropped, cause) => {
						if (!live) {
							// One past the block log's cap is enough: the log then fails closed.
							if (startup.discontinuities.length <= CARRIER_LOG_GAPS)
								startup.discontinuities.push({ sampleIndex, dropped, cause })
							else if (cause === "queue-overflow") {
								// Past the list: still count every dropped output sample.
								startup.droppedBeyond += dropped
								startup.lastBeyondIndex = sampleIndex
							}
							return
						}
						const current = slot.run
						if (current)
							this.host.noteDiscontinuity(current, sampleIndex, dropped, cause)
					},
					onRejected: reasonCode => {
						const current = slot.run
						if (current) this.onRetuneRejected(current, reasonCode)
					},
					onMetrics: (power, quieting, at, gates) => {
						const normalized = quieting.map(asQuietingNumber)
						if (!live) {
							startup.metrics.push({ power, quieting: normalized, at, gates })
							if (startup.metrics.length > HANDSHAKE_EARLY_MAX) {
								startup.metrics.splice(
									0,
									startup.metrics.length - HANDSHAKE_EARLY_MAX,
								)
							}
							return
						}
						const current = slot.run
						if (current) this.onMetrics(current, power, normalized, at, gates)
					},
					onDown: () => {
						const current = slot.run
						if (current && this.host.currentRun() === current)
							this.host.handleRunFailure(current, RUST_EXIT_REASON)
					},
				},
			})
		} catch (error: unknown) {
			if (this.starting === engine) this.starting = null
			if (this.startEpoch !== epoch) {
				await engine.stop()
				return true
			}
			this.noteFallback("binary-unavailable", error)
			await engine.stop()
			return false
		}
		if (this.startEpoch !== epoch) {
			if (this.starting === engine) this.starting = null
			await engine.stop()
			return true
		}
		if (this.starting === engine) this.starting = null
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
		this.ackedConfig = config
		this.sentConfig = config
		this.retuneRejects = 0
		this.host.adoptRun(run)
		live = true
		this.applyStartup(run, startup)
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
		const fields =
			error === undefined ? { reason } : { reason, err: safeErrorFields(error) }
		// The default engine meets csdr-only modulations (WFM, SSB, CW, raw) and
		// non-CU8 sources (an S16 SDR++ stream) in normal use: those fallbacks
		// are expected, so they are info, not a warning. An explicit "rust" warns.
		if (
			(reason === "modulation-unsupported" ||
				reason === "input-format-unsupported") &&
			this.host.config().engine === undefined
		)
			this.host.log.info(fields, RUST_FALLBACK_LOG)
		else this.host.log.warn(fields, RUST_FALLBACK_LOG)
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
		if (!this.inFlight) return
		if (this.host.currentRun() !== run || run.stopping) return
		this.controlWrite = null
		const coveredIdentity = this.inFlightHoldsIdentity
		this.inFlight = false
		this.inFlightHoldsIdentity = false
		this.retuneRejects = 0
		if (this.sentConfig !== null) this.ackedConfig = this.sentConfig
		const queued = this.queuedConfig
		const sent = this.sentConfig
		if (queued !== null && sent !== null) {
			this.queuedConfig = null
			// `sent` is applied. Release when that identity is still the latest
			// request, including a queue whose identity edits cancelled out.
			if (!identityChanged(sent, queued)) this.releaseHold(run)
			this.dispatchRetune(run, sent, queued)
			return
		}
		if (coveredIdentity) this.releaseHold(run)
	}

	/**
	 * A `rejected` for the in-flight retune is not a `retuned`: the process
	 * still has `ackedConfig`. One rejection frees the slot; a second in a
	 * row restarts the run. Open-time rejection never reaches here (`inFlight`
	 * is false, and the run does not exist yet).
	 */
	private onRetuneRejected(run: PipelineRun, reasonCode: string): void {
		if (
			reasonCode === SQUELCH_REJECTED_REASON ||
			this.controlWrite === "squelch"
		) {
			if (this.controlWrite === "squelch") this.controlWrite = null
			return
		}
		if (this.host.currentRun() !== run || run.stopping || !this.inFlight) return
		this.host.log.warn(
			{ err: safeErrorFields(reasonCode) },
			RUST_RETUNE_REJECTED_LOG,
		)
		this.retuneRejects += 1
		if (this.retuneRejects >= 2) {
			this.resetRetuneTracking()
			this.host.handleRunFailure(run, RUST_RETUNE_REJECTED_LOG)
			return
		}
		const queued = this.queuedConfig
		const desired = queued ?? this.sentConfig
		const acked = this.ackedConfig
		this.inFlight = false
		this.inFlightHoldsIdentity = false
		this.controlWrite = null
		this.queuedConfig = null
		this.sentConfig = acked
		// Nothing newer is waiting. Native still has `acked`. Advertising the
		// rejected request would leave the hold stuck and the status lying.
		// Every retune key moves back, including a gain-only edit. A squelch
		// edit made while this write was in flight stays on the current config.
		// The transmission hold belongs to an identity change.
		if (queued === null && desired !== null && acked !== null) {
			if (retuneKeysChanged(acked, this.host.config())) {
				this.host.rollbackConfig(
					withRetuneKeys(this.host.config(), acked),
					acked,
				)
				// Native keeps the squelch of the refused request until told.
				this.pushSquelch(run)
			}
			if (identityChanged(acked, desired)) {
				this.releaseHold(run)
				return
			}
		}
		if (desired !== null && acked !== null && !identityChanged(acked, desired))
			this.releaseHold(run)
		// The in-flight write was refused. A newer config waiting on it still
		// has to go out, diffed from the config the process kept.
		if (queued !== null && acked !== null)
			this.dispatchRetune(run, acked, queued)
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
			this.controlWrite = "retune"
			// The ack of this write leaves the process on `next`'s identity,
			// whether it changes it or a rejected change was already undone.
			this.inFlightHoldsIdentity = this.identityUnacked
		} else if (identityChanged(previous, next)) {
			if (this.identityUnacked) this.releaseHold(run)
		} else {
			// Nothing new went out. The process already has this identity,
			// including when a queued identity change cancelled itself.
			this.ackedConfig = next
			if (this.identityUnacked) this.releaseHold(run)
		}
		this.sentConfig = next
		this.pushSquelch(run)
	}

	private resetRetuneTracking(): void {
		this.inFlight = false
		this.inFlightHoldsIdentity = false
		this.identityUnacked = false
		this.controlWrite = null
		this.sentConfig = null
		this.ackedConfig = null
		this.queuedConfig = null
		this.retuneRejects = 0
	}

	/** Gate and metrics that arrived in the `opened` chunk. */
	private applyStartup(run: PipelineRun, startup: StartupBuffer): void {
		if (startup.gate !== null) this.onGate(run, startup.gate)
		// Discontinuities first: they mask their blocks before the startup metrics log them.
		for (const gap of startup.discontinuities)
			this.host.noteDiscontinuity(run, gap.sampleIndex, gap.dropped, gap.cause)
		startup.discontinuities.length = 0
		// The list is already past the log's cap here, so this only keeps droppedTotal exact.
		if (startup.droppedBeyond > 0)
			this.host.noteDiscontinuity(
				run,
				startup.lastBeyondIndex,
				startup.droppedBeyond,
				"queue-overflow",
			)
		startup.droppedBeyond = 0
		for (const sample of startup.metrics)
			this.onMetrics(
				run,
				sample.power,
				sample.quieting,
				sample.at,
				sample.gates,
			)
		startup.metrics.length = 0
	}

	private onMetrics(
		run: PipelineRun,
		powerDbfs: Array<number | null>,
		quietingDb: Array<number | null>,
		at: number,
		gates: ReadonlyArray<boolean>,
	): void {
		if (this.host.currentRun() !== run || run.stopping) return
		const first = Math.round(at / RUST_METRIC_BLOCK_SAMPLES)
		const config = this.host.config()
		const count = Math.max(powerDbfs.length, quietingDb.length)
		for (let i = 0; i < count; i++) {
			const power = powerDbfs[i] ?? null
			const quieting = quietingDb[i] ?? null
			if (power !== null) run.externalPowerDbfs = power
			const gateOpen = gates[i]
			this.host.measureRun(run, {
				blockIndex: first + i,
				...(gateOpen === undefined ? {} : { gateOpen }),
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

interface StartupBuffer {
	gate: boolean | null
	/** Queue-overflow samples of startup notices past the kept list. */
	droppedBeyond: number
	lastBeyondIndex: number
	discontinuities: Array<{
		sampleIndex: number
		dropped: number
		cause: string
	}>
	metrics: Array<{
		power: Array<number | null>
		quieting: Array<number | null>
		at: number
		gates: ReadonlyArray<boolean>
	}>
}

/** `inf` is +∞. Everything else is already a finite number or null. */
function asQuietingNumber(quieting: QuietingDb): number | null {
	return quieting === QUIETING_DB_INFINITE ? Number.POSITIVE_INFINITY : quieting
}

/**
 * `ChannelSquelch.blockQuieted`: auto nfm/wfm, quieting at least the observer
 * threshold (`LIVE_AUDIO_NOISE_QUIETING_DB.default`). `noiseQuietingDb` is the
 * noise-mode gate, not this floor predicate. `+∞` is the silent-discriminator
 * token and counts as quieted.
 */
export function metricsQuieted(
	config: LiveDemodConfig,
	quietingDb: number | null,
): boolean {
	if (config.squelchMode !== "auto") return false
	if (!LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(config.modulation))
		return false
	// +∞ is the silent-discriminator token. It is quieted carrier evidence.
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

function retuneKeysChanged(
	previous: LiveDemodConfig,
	next: LiveDemodConfig,
): boolean {
	return [...RUST_RETUNE_KEYS].some(key => previous[key] !== next[key])
}

/** Current config with only the retune keys taken from the last ack. */
function withRetuneKeys(
	current: LiveDemodConfig,
	acked: LiveDemodConfig,
): LiveDemodConfig {
	const restored: Record<string, unknown> = { ...current }
	for (const key of RUST_RETUNE_KEYS) {
		if (acked[key] === undefined) delete restored[key]
		else restored[key] = acked[key]
	}
	return restored as LiveDemodConfig
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
