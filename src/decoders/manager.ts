/**
 * Decoder Manager - Orchestrates decoder lifecycle
 *
 * Requirements:
 * - 4.1: WHEN a decoder is started, THE Decoder_Manager SHALL spawn the decoder process with appropriate arguments
 * - 4.2: WHEN a decoder process exits unexpectedly, THE Decoder_Manager SHALL restart it with exponential backoff
 * - 4.3: WHEN a decoder is stopped, THE Decoder_Manager SHALL send SIGTERM and wait, then SIGKILL if needed
 * - 4.4: WHEN a decoder produces output, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
 * - 4.5: WHEN requested, THE Decoder_Manager SHALL return status for all managed decoders including PID, uptime, and statistics
 * - 4.6: THE Decoder_Manager SHALL emit events for decoder output, errors, and exit conditions
 * - 20.1: WHEN a decoder is running and producing output, THE Decoder_Manager SHALL report health as "running"
 * - 20.2: WHEN a decoder is running but has not produced output for the configured timeout, THE Decoder_Manager SHALL report health as "idle"
 * - 20.3: WHEN a decoder has crashed and exceeded restart limits, THE Decoder_Manager SHALL report health as "faulted"
 * - 20.4: WHEN decoder health changes, THE Decoder_Manager SHALL emit a health event with the new status
 * - 27.1: WHEN a decoder is configured, THE Decoder_Manager SHALL validate the installed version against the pinned version
 * - 27.2: WHEN a version mismatch is detected, THE Decoder_Manager SHALL log a warning with upgrade instructions
 * - 27.3: THE Configuration SHALL support specifying minimum and maximum versions per decoder type
 */

import { EventEmitter } from "node:events"
import type {
	DecoderOptionIssue,
	DecoderSettingValue,
} from "@wavekit/api-types"
import type { Readable } from "node:stream"
import type {
	Decoder,
	DecoderBandAssessment,
	DecoderConfig,
	DecoderHealth,
	DecoderLastError,
	DecoderOutput,
	DecoderBandOverride,
	DecoderBandRegion,
	DecoderBandSettings,
	DecoderRateAssessment,
	DecoderStartMode,
	DecoderStatus,
	DecoderSuspensionReasonCode,
	DecoderSuspensionStatus,
	CoreSuspensionReason,
} from "./types.js"
import {
	assessDecoderRate,
	validateDeclaredRateRequirements,
	type DecoderRateContext,
} from "./rate-resolver.js"
import { assessDecoderBand } from "./band-resolver.js"
import {
	normalizeBandOverride,
	resolveBandRequirements,
	type ResolvedBand,
} from "./band-defaults.js"
import { BandOverrideStore } from "./band-override-store.js"
import {
	createDecoderExitError,
	createDecoderLastError,
	describeDecoderStatusFields,
} from "./status-fields.js"
import type { DecoderRegistry } from "./registry.js"
import { SourceFanoutRouter } from "../core/source-fanout-router.js"
import type {
	ChannelAdmissionReason,
	ChannelProvider,
	ChannelRequestResult,
	DecoderChannelRequest,
	DecoderChannelRequestResult,
	RealisedChannel,
} from "../core/channelizer/types.js"
import { isChannelAdmissionReason } from "../core/channelizer/types.js"
import { channelisedRatePlan } from "../core/channelizer/rate-plan.js"
import { isValidRtlSampleRate } from "../core/tuner-controller.js"
import type { FanoutManager } from "../core/fanout-manager.js"
import type { SourceManager, SourceCaps } from "../core/source-manager.js"
import {
	decoderOptionDescriptors,
	validateDecoderOptions,
} from "./options/index.js"
import { WaveKitError } from "../utils/errors.js"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import {
	validateDecoderVersion,
	getUpgradeInstructions,
	type VersionValidationResult,
} from "../utils/version.js"
import { safeErrorFields } from "./safe-error-fields.js"

/**
 * Optional activity publication. Runs after the legacy `decoder:output`
 * listeners; a throw must not change health or that emit.
 */
export type ActivityPublisher = (
	decoderId: string,
	decoderType: string | undefined,
	output: DecoderOutput,
) => void

/**
 * Configuration for the Decoder Manager.
 */
export interface DecoderManagerConfig {
	/** Initial restart delay in milliseconds (default: 2000) */
	restartDelay: number
	/** Maximum restart delay in milliseconds (default: 30000) */
	maxRestartDelay: number
	/** Maximum number of restarts before giving up (0 = unlimited, default: 0) */
	maxRestarts: number
	/**
	 * Consecutive unstable runs before health becomes "faulted" (default: 5).
	 * Retries continue at the max backoff unless maxRestarts is exhausted.
	 */
	faultAfterFailures: number
	/** A run that lasts this long (or produces output) is stable (default: 30000) */
	stableRunMs: number
	/** Interval in milliseconds between health checks (default: 5000) */
	healthCheckInterval: number
	/** Timeout in milliseconds without output before marking decoder as idle (default: 30000) */
	idleTimeout: number
	/** Whether to validate decoder versions at startup (default: true) */
	validateVersions: boolean
	/**
	 * Suspend wanted decoders whose targets are all outside the tuned window
	 * (default: true). The band assessment is reported either way.
	 */
	bandSuspension: boolean
	/** Effective global band region (default: EU, source "default"). */
	bandRegion: DecoderBandRegion
}

/**
 * Internal state for tracking decoder restart behavior.
 */
interface DecoderState {
	/** WG6: option problems found at creation; undefined = type has no schema */
	optionIssues?: DecoderOptionIssue[] | undefined
	decoder: Decoder
	config: DecoderConfig
	restartCount: number
	currentDelay: number
	restartTimer: ReturnType<typeof setTimeout> | null
	/** When restartTimer fires; null when no automatic restart is pending */
	nextRestartAt: Date | null
	/** Unstable runs (or failed restarts) since the last stable run or explicit start */
	consecutiveFailures: number
	intentionallyStopped: boolean
	stopRevision: number
	inputCaps?: SourceCaps
	branchId: string | null
	branchFanout: FanoutManager | null
	assignedSourceId: string | null
	/** Last known health state for change detection */
	lastHealth: DecoderHealth
	/** Timestamp of last output received */
	lastOutputAt: Date | null
	/** Version validation result (Requirements 27.1, 27.2, 27.3) */
	versionValidation?: VersionValidationResult | undefined
	/** Most recent failure; retained across auto-restarts, cleared by startDecoder */
	lastError: DecoderLastError | null
	/** When the current run started; scopes lastError to a run */
	lastStartedAt: Date | null
	/** Cached instance rate plan; recomputed on wire, caps change, connect/remove */
	ratePlan: DecoderRateAssessment | undefined
	/** Cached band check; recomputed with ratePlan */
	bandPlan: DecoderBandAssessment | undefined
	/** Operator intent: set by start, cleared by stop/remove */
	desiredRunning: boolean
	/** Set while the source rate or band makes the instance unusable (reversible) */
	suspension: DecoderSuspension | null
	/** An in-flight suspend (stop pending or failed) or resume */
	transition: "suspending" | "resuming" | null
	/** Bumped by every rate transition, start, stop and remove */
	rateGeneration: number
	/** The channelizer channel feeding stdin (addendum §4); null on the raw path */
	channel: OpenChannelRef | null
	/** A terminal ref awaiting its batch notification/cleanup, never an adopted live identity. */
	endingChannel: OpenChannelRef | null
	/** The channel was invalidated under a wanted decoder; the worker restarts it */
	channelStale: boolean
	/**
	 * Set by the worker for a restart caused by a channel invalidation: the
	 * next start keeps restartCount, the backoff and lastError (Review Focus 3).
	 */
	keepFailureAccounting: boolean
	/**
	 * Who started the decoder: "operator" (REST start) is never
	 * band-suspended. Cleared to "auto" by stop; kept by restart.
	 */
	startMode: DecoderStartMode
	/** "scanner": a runtime-only probe owned by a scanner job (spec § 6.5). */
	owner: "config" | "scanner"
	/** Owning scanner job of a probe; null for configured decoders. */
	scannerJobId: string | null
	/** Scanner-provided input used instead of a fanout branch (probes only). */
	input: Readable | null
	/** True while `input` is attached to the decoder. */
	inputAttached: boolean
	/** Scanner-only acquisition/startup identity; terminal tokens never become live again. */
	scannerChannelAttempt: ScannerChannelAttempt | null
	/**
	 * WG8: option values staged for the next start (`null` removes the key);
	 * null when nothing is staged. Configured decoders only.
	 */
	stagedOptions: Record<string, DecoderSettingValue | null> | null
}

/** A staged option value equals the current one (JSON values; absent = null). */
function sameJsonValue(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === undefined || a === null) return b === undefined || b === null
	if (b === undefined || b === null) return false
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false
		return a.every((v, i) => sameJsonValue(v, b[i]))
	}
	if (Array.isArray(b)) return false
	if (typeof a === "object" && typeof b === "object") {
		const ar = a as Record<string, unknown>
		const br = b as Record<string, unknown>
		const keys = new Set([...Object.keys(ar), ...Object.keys(br)])
		for (const k of keys) if (!sameJsonValue(ar[k], br[k])) return false
		return true
	}
	return false
}

/** The rebuild of a decoder with staged options failed (fixed text, no cause). */
export class DecoderRebuildError extends WaveKitError {
	constructor() {
		super("Decoder rebuild failed", "DECODER_REBUILD_FAILED")
		this.name = "DecoderRebuildError"
	}
}

interface DecoderSuspension {
	reasonCode: CoreSuspensionReason
	since: Date
}

interface OpenChannelRef {
	/** The provider that opened it; releases go back to it after a swap. */
	provider: ChannelProvider
	channelId: string
	sourceId: string
	generation: number
	realised: RealisedChannel
	stream: Readable
	binding: ScannerDecoderChannelBinding | null
	ending: { release: boolean; cleanupStarted: boolean } | null
}

/** Internal lifecycle snapshot, not a capability or native-close/writer-drain receipt. */
export interface ScannerDecoderChannelBinding {
	readonly decoderId: string
	readonly sourceId: string
	readonly channelId: string
	readonly generation: number
	readonly realised: Readonly<RealisedChannel>
}

interface ScannerChannelAttempt {
	state: DecoderState
	rateGeneration: number
	sourceId: string
	provider: ChannelProvider
	terminal: boolean
	invalidated: Set<string>
}

/** A channel reason holding a wanted decoder back (addendum §5). */
interface ChannelHold {
	reasonCode: ChannelAdmissionReason
	detail: string
	/** A retune race, not an outage: logged at debug. */
	race?: true
}

/** How wiring ended: wired, superseded by a newer transition, or held for a channel reason. */
type WireOutcome =
	| { wired: true; scannerChannel?: OpenChannelRef }
	| { wired: false; superseded: true }
	| ({ wired: false; superseded: false } & ChannelHold)

/** Plan A3: channel reasons are not in the shared rate union yet; omit the object rather than emit a false code. */
function publicSuspension(s: DecoderSuspension | null): {
	suspension?: DecoderSuspensionStatus
} {
	if (!s) return {}
	const code = s.reasonCode
	if (isChannelAdmissionReason(code)) return {}
	return { suspension: { reasonCode: code, since: s.since } }
}

/** Rate and band plans for one caps snapshot, and what (if anything) blocks. */
interface Eligibility {
	rate: DecoderRateAssessment
	band: DecoderBandAssessment
	blockedBy: DecoderSuspensionReasonCode | null
}

/** Result of DecoderManager.previewRates. */
export type RatePreviewResult =
	| { ok: true; items: RatePreviewItem[] }
	| { ok: false; reason: "source-not-found" | "unsupported-rate" }

export interface RatePreviewItem {
	decoderId: string
	assessment: DecoderRateAssessment
}

/** A queued source evaluation; adapt=false never restarts running pipelines. */
interface PendingSourceEvaluation {
	caps: SourceCaps | null
	adapt: boolean
}

/**
 * Events emitted by the Decoder Manager.
 */
export interface DecoderManagerEvents {
	"decoder:scanner-channel-granted": (
		binding: ScannerDecoderChannelBinding,
	) => void
	"decoder:scanner-channel-ended": (
		binding: ScannerDecoderChannelBinding,
		reason: "invalidated" | "released",
	) => void
	/** Emitted when a decoder produces output */
	"decoder:output": (decoderId: string, output: DecoderOutput) => void
	/** Emitted when a decoder encounters an error */
	"decoder:error": (decoderId: string, error: Error) => void
	/** Emitted when a decoder starts */
	"decoder:started": (decoderId: string) => void
	/** Emitted when a decoder stops */
	"decoder:stopped": (decoderId: string) => void
	/** Emitted when a decoder is restarting */
	"decoder:restarting": (
		decoderId: string,
		attempt: number,
		delay: number,
	) => void
	/** Emitted when max restarts exceeded */
	"decoder:max-restarts": (decoderId: string, restartCount: number) => void
	/** Emitted when decoder health changes (Requirement 20.4) */
	"decoder:health": (decoderId: string, health: DecoderHealth) => void
	/** Emitted after stop/exit cleanup so status consumers read the final state */
	"decoder:status-changed": (decoderId: string) => void
	/** Emitted after a decoder (configured or probe) is added */
	"decoder:created": (decoderId: string) => void
	/** Emitted after a decoder is removed from management */
	"decoder:removed": (decoderId: string) => void
	/** Emitted when decoder version validation fails (Requirement 27.2) */
	"decoder:version-mismatch": (
		decoderId: string,
		validation: VersionValidationResult,
	) => void
}

const DEFAULT_CONFIG: DecoderManagerConfig = {
	restartDelay: 2000,
	maxRestartDelay: 30000,
	maxRestarts: 0,
	faultAfterFailures: 5,
	stableRunMs: 30000,
	healthCheckInterval: 5000,
	idleTimeout: 30000,
	validateVersions: true,
	bandSuspension: true,
	bandRegion: { code: "EU", source: "default" },
}

/** Start intent; an omitted intent keeps the current start mode. */
export interface DecoderStartIntent {
	startMode: DecoderStartMode
	/**
	 * Throw SOURCE_HELD_BY_SCANNER instead of recording a suspended start when
	 * a scanner sweep holds the source (REST routes only, spec § 10.4).
	 */
	refuseIfHeld?: boolean
}

/**
 * DecoderManager - Orchestrates decoder lifecycle and coordinates with other components.
 *
 * Handles:
 * - Creating decoders via the registry
 * - Starting/stopping/restarting decoders
 * - Auto-restart with exponential backoff on unexpected exits
 * - Wiring decoders to fanout branches for audio input
 * - Forwarding decoder events
 * - Periodic health checks (Requirements 20.1, 20.2, 20.3, 20.4)
 */
export class DecoderManager extends EventEmitter {
	private readonly log: Logger
	private readonly registry: DecoderRegistry
	private readonly fanout: FanoutManager
	private readonly config: DecoderManagerConfig
	private readonly decoders: Map<string, DecoderState> = new Map()
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null
	private sourceManager: SourceManager | null = null
	private sourceRouting: SourceFanoutRouter | null = null
	private ownsSourceRouting = false
	private sourceConnectedHandler: ((sourceId: string) => void) | null = null
	private sourceRemovedHandler: ((sourceId: string) => void) | null = null
	private sourceConnectedEvaluation: ((sourceId: string) => void) | null = null
	private capsChangedHandler:
		| ((sourceId: string, caps: SourceCaps) => void)
		| null = null
	private capsChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null
	/** Tail of the serial caps worker; each drain runs after the previous one. */
	private capsWork: Promise<void> = Promise.resolve()
	private destroying = false
	private readonly pendingCapsChanges = new Map<
		string,
		PendingSourceEvaluation
	>()
	private readonly bandOverrides: BandOverrideStore
	/**
	 * Sources held by scanner sweeps, keyed by holder (scanner job id);
	 * configured decoders there stay suspended while any holder remains.
	 */
	private readonly heldSources = new Map<string, Set<string>>()
	private static readonly CAPS_CHANGE_DEBOUNCE_MS = 300
	/** Optional core channelizer (addendum §4); null keeps the raw fanout path. */
	private channelizer: ChannelProvider | null = null
	/** Optional activity publication; null leaves output handling unchanged. */
	private activityPublisher: ActivityPublisher | null = null
	/** Review Focus 4: one error line per outage, not one per decoder. */
	private channelizerUnavailableLogged = false
	/** Per source: one pending re-evaluation for decoders held for channelizer-unavailable. */
	private readonly channelRetryTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>()
	private static readonly CHANNELIZER_RETRY_MS = 15_000
	private readonly pendingScannerChannels = new Map<
		DecoderState,
		ScannerChannelAttempt
	>()
	private channelInvalidatedHandler:
		| ((sourceId: string, generation: number, channelIds: string[]) => void)
		| null = null

	private onChannelsInvalidated(
		provider: ChannelProvider,
		sourceId: string,
		generation: number,
		channelIds: string[],
	): void {
		// Capture pending identities first, before any adopted-channel listener can reenter.
		for (const attempt of this.pendingScannerChannels.values()) {
			if (
				attempt.provider !== provider ||
				attempt.sourceId !== sourceId ||
				attempt.terminal
			)
				continue
			for (const id of channelIds) {
				const key = JSON.stringify([generation, id])
				if (attempt.invalidated.has(key)) continue
				if (attempt.invalidated.size === 64) {
					this.cancelScannerChannelAttempt(attempt.state, attempt)
					break
				}
				attempt.invalidated.add(key)
			}
		}
		let affected = false
		const claimed: Array<{ state: DecoderState; ref: OpenChannelRef }> = []
		const bindings = [...this.decoders.values()].map(state => ({
			state,
			ref: state.channel,
		}))
		for (const { state, ref } of bindings) {
			if (
				!ref ||
				state.channel !== ref ||
				ref.provider !== provider ||
				ref.sourceId !== sourceId ||
				ref.generation !== generation ||
				!channelIds.includes(ref.channelId)
			)
				continue
			if (state.owner === "config") affected = true
			this.claimChannel(state, ref, false)
			claimed.push({ state, ref })
		}
		for (const { state, ref } of claimed) this.finishChannelDrop(state, ref)
		// The serial worker restarts stale decoders (handleCapsChange); a
		// rejection there becomes a suspension, a later usable centre resumes.
		if (affected) this.recheckStaleChannel(sourceId)
	}

	constructor(
		registry: DecoderRegistry,
		fanout: FanoutManager,
		logger: Logger,
		config?: Partial<DecoderManagerConfig>,
		bandOverrides?: BandOverrideStore,
	) {
		super()
		this.registry = registry
		this.fanout = fanout
		this.log = createComponentLogger(logger, "DecoderManager")
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.bandOverrides = bandOverrides ?? BandOverrideStore.inMemory(logger)

		// Start periodic health checks (Requirements 20.1, 20.2, 20.3, 20.4)
		this.startHealthChecks()
	}

	/**
	 * Attaches the optional core channelizer (addendum §4). Decoders with
	 * `useChannelizer` and a channel request then read a channel instead of
	 * a raw fanout branch; null (the default) keeps today's behaviour.
	 */
	setChannelizer(provider: ChannelProvider | null): void {
		if (this.channelizer === provider) return
		// Claim the complete old installation before callbacks can reinstall its provider.
		// Cleanup owns these exact refs even if an ended callback performs another swap.
		const replaced: Array<{ state: DecoderState; ref: OpenChannelRef }> = []
		const sources = new Set<string>()
		for (const state of this.decoders.values()) {
			const ref = state.channel
			if (!ref || ref.provider === provider) continue
			this.claimChannel(state, ref, true)
			replaced.push({ state, ref })
			if (state.owner === "config") sources.add(ref.sourceId)
		}
		if (this.channelInvalidatedHandler)
			this.channelizer?.off(
				"channel-invalidated",
				this.channelInvalidatedHandler,
			)
		for (const state of this.pendingScannerChannels.keys())
			this.cancelScannerChannelAttempt(state)
		this.channelizer = provider
		this.channelizerUnavailableLogged = false
		this.channelInvalidatedHandler = null
		if (provider) {
			const handler = (sourceId: string, generation: number, ids: string[]) => {
				if (this.channelInvalidatedHandler === handler)
					this.onChannelsInvalidated(provider, sourceId, generation, ids)
			}
			this.channelInvalidatedHandler = handler
		}
		if (provider && this.channelInvalidatedHandler)
			provider.on("channel-invalidated", this.channelInvalidatedHandler)
		// Channels of a replaced provider would never be invalidated again:
		// release them and let the worker re-wire their decoders.
		for (const { state, ref } of replaced) this.finishChannelDrop(state, ref)
		for (const sourceId of sources) this.recheckStaleChannel(sourceId)
		if (!this.channelizer) this.clearChannelRetries()
	}

	/**
	 * Attaches activity publication. Null (the default) keeps today's output
	 * path. The hook is invoked after `decoder:output` and cannot affect it.
	 */
	setActivityPublisher(publish: ActivityPublisher | null): void {
		this.activityPublisher = publish
	}

	/**
	 * Creates a decoder instance using the registry.
	 * Does not start the decoder - call startDecoder() separately.
	 * Validates decoder version against configured constraints (Requirements 27.1, 27.2, 27.3).
	 *
	 * @param config - Configuration for the decoder
	 * @returns The created decoder instance
	 * @throws RegistryError if the decoder type is not registered
	 */
	createDecoder(config: DecoderConfig): Decoder {
		return this.registerDecoder(config, null)
	}

	/** Report-only option validation; never throws, never logs values. */
	private checkDecoderOptions(
		config: DecoderConfig,
	): DecoderOptionIssue[] | undefined {
		try {
			const issues = validateDecoderOptions(config.type, config.options)
			if (issues && issues.length > 0) {
				// Log known-schema keys only: an unknown key is operator text of any
				// meaning, so it is counted (unknownKeyCount), never named.
				const known = new Set(
					(decoderOptionDescriptors(config.type) ?? []).map(d => d.key),
				)
				const paths = new Set<string>()
				let unknownKeyCount = 0
				for (const issue of issues) {
					if (issue.code === "truncated") continue
					const top = issue.path.split(".", 1)[0] ?? ""
					// "" is the options object itself (a schema path, no operator text).
					if (issue.code === "unknown-key" || (top !== "" && !known.has(top)))
						unknownKeyCount++
					else paths.add(top)
				}
				this.log.warn(
					{
						decoderId: config.id,
						type: config.type,
						issueCount: issues.length,
						paths: [...paths].sort(),
						unknownKeyCount,
					},
					"Decoder options have issues (reported only)",
				)
			}
			return issues?.slice(0, 32)
		} catch (err) {
			this.log.warn(
				{
					decoderId: config.id,
					type: config.type,
					err: safeErrorFields(err),
				},
				"Decoder option validation failed; issues not reported",
			)
			return undefined
		}
	}

	private registerDecoder(
		config: DecoderConfig,
		probe: { jobId: string; input: Readable | null } | null,
	): Decoder {
		if (this.decoders.has(config.id)) {
			this.log.warn(
				{ decoderId: config.id },
				"Decoder already exists, returning existing instance",
			)
			return this.decoders.get(config.id)!.decoder
		}

		this.log.info(
			{
				decoderId: config.id,
				type: config.type,
				owner: probe ? "scanner" : "config",
			},
			"Creating decoder",
		)

		const decoder = this.registry.create(config, this.log)
		const declared = decoder.getRateRequirements?.()
		if (declared !== undefined) {
			try {
				validateDeclaredRateRequirements(
					declared,
					`decoders.${config.id}.rateRequirements`,
				)
			} catch (err) {
				decoder.removeAllListeners()
				throw err
			}
		}

		// Validate decoder version if constraints are specified (Requirements 27.1, 27.2, 27.3)
		let versionValidation: VersionValidationResult | undefined
		if (this.config.validateVersions) {
			versionValidation = this.validateDecoderVersion(config)
		}

		const optionIssues = this.checkDecoderOptions(config)

		const state: DecoderState = {
			decoder,
			config,
			optionIssues,
			restartCount: 0,
			currentDelay: this.config.restartDelay,
			restartTimer: null,
			nextRestartAt: null,
			consecutiveFailures: 0,
			intentionallyStopped: false,
			stopRevision: 0,
			branchId: null,
			branchFanout: null,
			assignedSourceId: null,
			lastHealth: "running",
			lastOutputAt: null,
			versionValidation,
			lastError: null,
			lastStartedAt: null,
			ratePlan: undefined,
			bandPlan: undefined,
			desiredRunning: false,
			suspension: null,
			transition: null,
			rateGeneration: 0,
			channel: null,
			endingChannel: null,
			channelStale: false,
			keepFailureAccounting: false,
			startMode: "auto",
			owner: probe ? "scanner" : "config",
			scannerJobId: probe?.jobId ?? null,
			input: probe?.input ?? null,
			inputAttached: false,
			scannerChannelAttempt: null,
			stagedOptions: null,
		}

		this.decoders.set(config.id, state)
		this.setupDecoderEventHandlers(state)
		this.refreshRatePlan(state)
		this.emit("decoder:created", config.id)

		return decoder
	}

	/**
	 * Creates and starts a scanner probe (spec § 6.5): not in config, never
	 * persisted, not band-checked, held or pinned, never auto-restarted. With
	 * `input`, it reads that stream instead of a fanout branch. Resolves after
	 * the process started; on failure the instance is removed and the error
	 * rethrown.
	 */
	async createEphemeralDecoder(
		config: DecoderConfig,
		opts: { owner: "scanner"; jobId: string; input?: Readable },
	): Promise<Decoder> {
		if (this.destroying) throw this.probeRemovedError(config.id)
		if (this.decoders.has(config.id)) {
			throw new WaveKitError(
				`Decoder already exists: ${config.id}`,
				"DECODER_EXISTS",
			)
		}
		const decoder = this.registerDecoder(config, {
			jobId: opts.jobId,
			input: opts.input ?? null,
		})
		const state = this.decoders.get(config.id)
		try {
			if (
				!state ||
				state.decoder !== decoder ||
				state.intentionallyStopped ||
				this.destroying
			)
				throw this.probeRemovedError(config.id)
			state.desiredRunning = true
			state.intentionallyStopped = false
			state.rateGeneration++
			const generation = state.rateGeneration
			const outcome = await this.wireDecoderToFanout(state)
			if (!this.probeLive(state)) throw this.probeRemovedError(config.id)
			if (!outcome.wired) {
				throw new WaveKitError(
					`Scanner probe ${config.id} could not be wired: ${outcome.superseded ? "superseded" : `${outcome.reasonCode}: ${outcome.detail}`}`,
					"PROBE_NOT_WIRED",
				)
			}
			const channel = outcome.scannerChannel
			if (!this.probeStartupLive(state, generation, channel))
				throw this.probeRemovedError(config.id)
			await decoder.start()
			if (!this.probeStartupLive(state, generation, channel)) {
				// Removed or stopped while spawning: that stop ran before the
				// process existed, so stop it again (this also clears timers the
				// decoder armed after the spawn).
				try {
					await decoder.stop()
				} catch (stopErr: unknown) {
					this.log.warn(
						{ err: safeErrorFields(stopErr), decoderId: config.id },
						"Failed to stop a scanner probe removed during its start",
					)
				}
				throw this.probeRemovedError(config.id)
			}
			// Attach only once the process exists: attachInput starts the stream
			// flowing and pipes to stdin only when a process is running, so an
			// earlier attach would drain the buffered pre-roll into the byte
			// counter instead of the decoder.
			if (state.input) {
				decoder.attachInput(state.input)
				state.inputAttached = true
			}
			if (!this.probeStartupLive(state, generation, channel))
				throw this.probeRemovedError(config.id)
			this.emitStatusChanged(state)
			if (!this.probeStartupLive(state, generation, channel)) {
				await decoder.stop()
				throw this.probeRemovedError(config.id)
			}
		} catch (err) {
			// Remove only this creation's original state, including a registration-time stop.
			if (
				state &&
				state.decoder === decoder &&
				this.decoders.get(config.id) === state
			) {
				state.lastError = createDecoderLastError(err, "error")
				try {
					await this.removeDecoder(config.id)
				} catch (removeErr: unknown) {
					this.log.error(
						{ err: safeErrorFields(removeErr), decoderId: config.id },
						"Failed to remove a scanner probe whose start failed",
					)
				}
			}
			throw err
		}
		return decoder
	}

	/** False once the probe was removed or stopped (e.g. by the probe pool). */
	private probeLive(state: DecoderState): boolean {
		return (
			this.decoders.get(state.config.id) === state &&
			!state.intentionallyStopped
		)
	}

	private probeStartupLive(
		state: DecoderState,
		generation: number,
		channel: OpenChannelRef | undefined,
	): boolean {
		if (!this.probeLive(state) || !this.stillWanted(state, generation))
			return false
		if (!channel) return true
		const currentGeneration = this.scannerProviderGeneration(
			channel.provider,
			channel.sourceId,
		)
		return (
			state.channel === channel &&
			this.scannerAttemptLive(state.scannerChannelAttempt) &&
			!channel.stream.destroyed &&
			!channel.stream.readableEnded &&
			channel.generation === currentGeneration
		)
	}

	private scannerProviderGeneration(
		provider: ChannelProvider,
		sourceId: string,
	): number | null {
		try {
			return provider.currentGeneration(sourceId)
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err), sourceId },
				"Channel generation unavailable",
			)
			return null
		}
	}

	private scannerAttemptLive(attempt: ScannerChannelAttempt | null): boolean {
		return (
			!!attempt &&
			!attempt.terminal &&
			attempt.state.scannerChannelAttempt === attempt &&
			this.stillWanted(attempt.state, attempt.rateGeneration) &&
			!attempt.state.intentionallyStopped &&
			this.channelizer === attempt.provider &&
			this.selectedSourceId(attempt.state) === attempt.sourceId &&
			attempt.state.assignedSourceId === attempt.sourceId
		)
	}

	private cancelScannerChannelAttempt(
		state: DecoderState,
		expected?: ScannerChannelAttempt,
	): void {
		const attempt = state.scannerChannelAttempt
		if (!attempt || (expected && attempt !== expected)) return
		attempt.terminal = true
		attempt.invalidated.clear()
		if (this.pendingScannerChannels.get(state) === attempt)
			this.pendingScannerChannels.delete(state)
		state.scannerChannelAttempt = null
	}

	private probeRemovedError(id: string): WaveKitError {
		return new WaveKitError(
			`Scanner probe ${id} was removed during its start`,
			"PROBE_REMOVED",
		)
	}

	/** Stops and removes a probe; no-op for unknown ids. */
	async removeEphemeralDecoder(id: string): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) return
		if (state.owner !== "scanner") {
			throw new WaveKitError(
				`Decoder ${id} is configured, not a scanner probe`,
				"DECODER_NOT_EPHEMERAL",
			)
		}
		await this.removeDecoder(id)
	}

	/**
	 * Holds a source for a scanner sweep (spec § 10.4): every configured
	 * decoder on it is suspended with reason "tuner-scanning" until the last
	 * holder released it, so per-hop caps changes do not resume and
	 * re-suspend them. Resolves once those decoders were suspended.
	 */
	async holdSource(
		sourceId: string,
		reason: "tuner-scanning",
		holderId: string,
	): Promise<void> {
		const holders = this.heldSources.get(sourceId) ?? new Set<string>()
		holders.add(holderId)
		this.heldSources.set(sourceId, holders)
		this.log.info(
			{ sourceId, reason, holderId, holders: holders.size },
			"Source held by the scanner",
		)
		await this.evaluateSourceNow(sourceId)
	}

	/**
	 * Drops one holder's hold; the source stays held while another holder
	 * remains. Resolves once the decoders were re-evaluated (resumed).
	 */
	async releaseSource(sourceId: string, holderId: string): Promise<void> {
		const holders = this.heldSources.get(sourceId)
		if (!holders?.delete(holderId)) return
		if (holders.size > 0) {
			this.log.debug(
				{ sourceId, holderId, holders: holders.size },
				"Scanner hold released; other holders remain",
			)
			return
		}
		this.heldSources.delete(sourceId)
		this.log.info({ sourceId, holderId }, "Source released by the scanner")
		await this.evaluateSourceNow(sourceId)
	}

	isSourceHeld(sourceId: string): boolean {
		return (this.heldSources.get(sourceId)?.size ?? 0) > 0
	}

	/**
	 * Evaluates a source on the serial caps worker now. The 300 ms debounce
	 * cannot be used for holds: every scanner hop emits caps-changed and
	 * re-arms it, so during a sweep it would never fire. Other sources'
	 * pending evaluations are applied by the same drain.
	 */
	private evaluateSourceNow(sourceId: string): Promise<void> {
		this.enqueueSourceEvaluation(sourceId, {
			caps: this.sourceManager?.getCaps(sourceId) ?? null,
			adapt: false,
		})
		return this.drainCapsChanges()
	}

	/** The hold reason that applies to a configured stdin decoder, if any. */
	private heldReason(state: DecoderState): "tuner-scanning" | null {
		if (state.owner !== "config" || state.decoder.caps.input === "external")
			return null
		const sourceId = this.selectedSourceId(state)
		return sourceId !== undefined && this.isSourceHeld(sourceId)
			? "tuner-scanning"
			: null
	}

	private assertNotHeld(state: DecoderState): void {
		if (this.heldReason(state) === null) return
		throw new WaveKitError(
			`Source ${this.selectedSourceId(state)} is held by a scanner sweep; decoder ${state.config.id} can start when the sweep ends`,
			"SOURCE_HELD_BY_SCANNER",
		)
	}

	/**
	 * Starts a decoder by ID.
	 * Wires the decoder to a fanout branch for audio input.
	 *
	 * @param id - The decoder ID to start
	 * @param intent - Start mode to record; omitted keeps the current mode
	 *   (internal restarts), "operator" ignores the band check
	 * @throws Error if decoder not found
	 */
	async startDecoder(id: string, intent?: DecoderStartIntent): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			throw new Error(`Decoder not found: ${id}`)
		}

		// Consumed by this start whatever happens next.
		const keepFailureAccounting = state.keepFailureAccounting
		state.keepFailureAccounting = false

		if (state.decoder.getStatus().running) {
			this.log.warn({ decoderId: id }, "Decoder already running")
			return
		}
		if (intent?.refuseIfHeld === true) this.assertNotHeld(state)

		// WG8: staged options apply here, as if WaveKit booted with them.
		if (state.stagedOptions) await this.rebuildIfPending(state)

		if (intent) state.startMode = intent.startMode
		this.log.info(
			{ decoderId: id, startMode: state.startMode },
			"Starting decoder",
		)

		// Reset restart tracking
		state.intentionallyStopped = false
		state.desiredRunning = true
		state.rateGeneration++
		// A channel-invalidation restart is not a new start: crash accounting
		// survives it, so a flapping source still reaches maxRestarts/faulted.
		if (!keepFailureAccounting) {
			state.restartCount = 0
			state.consecutiveFailures = 0
			state.lastError = null
			state.currentDelay = this.config.restartDelay
		}
		this.cancelScheduledRestart(state)

		// Intent is recorded separately from eligibility: an unusable source
		// rate, or a band covering none of its targets, suspends the instance
		// instead of spawning a pipeline that cannot decode.
		if (state.decoder.caps.input !== "external") {
			const sourceId = this.selectedSourceId(state)
			const eligibility = this.assessEligibility(
				state,
				(sourceId ? this.sourceManager?.getCaps(sourceId) : undefined) ?? null,
			)
			state.ratePlan = eligibility.rate
			state.bandPlan = eligibility.band
			if (eligibility.blockedBy !== null) {
				state.suspension = {
					reasonCode: eligibility.blockedBy,
					since: state.suspension?.since ?? new Date(),
				}
				state.transition = null
				try {
					this.reserveSource(state)
				} catch (err) {
					state.suspension = null
					state.lastError = createDecoderLastError(err, "error")
					this.updateDecoderHealth(state, "faulted")
					this.emitStatusChanged(state)
					throw err
				}
				this.log.info(
					{ decoderId: id, reasonCode: state.suspension.reasonCode },
					"Start recorded; decoder suspended (see reasonCode)",
				)
				this.emitStatusChanged(state)
				return
			}
		}
		state.suspension = null
		state.transition = null

		try {
			const outcome = await this.wireDecoderToFanout(state)
			if (!outcome.wired) {
				if (!outcome.superseded) this.holdForChannel(state, outcome)
				return
			}
			await state.decoder.start()
		} catch (err) {
			state.lastError = createDecoderLastError(err, "error")
			this.unwireDecoderFromFanout(state)
			this.updateDecoderHealth(state, "faulted")
			throw err
		}
		this.recheckStaleChannel(this.selectedSourceId(state), state)
	}

	/**
	 * Stops a decoder by ID.
	 * Cleans up the fanout branch and cancels any pending restart.
	 *
	 * @param id - The decoder ID to stop
	 * @throws Error if decoder not found
	 */
	async stopDecoder(id: string): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			throw new Error(`Decoder not found: ${id}`)
		}

		this.log.info({ decoderId: id }, "Stopping decoder")

		// Mark as intentionally stopped to prevent auto-restart
		state.intentionallyStopped = true
		state.stopRevision++
		state.desiredRunning = false
		state.startMode = "auto"
		state.rateGeneration++
		const stopGeneration = state.rateGeneration
		state.suspension = null
		state.transition = null
		this.clearChannelRetry(this.selectedSourceId(state), true)

		// Cancel any pending restart; "restarting" no longer holds once the
		// operator stopped the decoder (a fault stays visible until a start).
		this.cancelScheduledRestart(state)
		this.cancelScannerChannelAttempt(state)
		// Scanner intake fences must run before stop/detach/release can deliver buffered data.
		if ((state.owner === "scanner" && state.channel) || state.endingChannel)
			this.dropChannel(state, true)
		if (state.lastHealth === "restarting")
			this.updateDecoderHealth(state, "running")

		// Stop the decoder process
		try {
			await state.decoder.stop()
		} finally {
			if (
				state.owner !== "scanner" ||
				(this.decoders.get(id) === state &&
					state.rateGeneration === stopGeneration)
			) {
				this.unwireDecoderFromFanout(state)
				this.emitStatusChanged(state)
			}
		}
	}

	/**
	 * Restarts a decoder by ID.
	 *
	 * @param id - The decoder ID to restart
	 * @throws Error if decoder not found
	 */
	async restartDecoder(
		id: string,
		opts: { refuseIfHeld?: boolean } = {},
	): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			throw new Error(`Decoder not found: ${id}`)
		}
		if (opts.refuseIfHeld === true) this.assertNotHeld(state)

		this.log.info({ decoderId: id }, "Restarting decoder")

		// Stop clears the start mode; a restart keeps it.
		const startMode = state.startMode
		// Stop first (this marks intentionallyStopped = true)
		const stopping = this.stopDecoder(id)
		const revision = state.stopRevision
		await stopping
		if (
			this.destroying ||
			this.decoders.get(id) !== state ||
			state.stopRevision !== revision
		)
			return

		// Reset the flag and start
		state.intentionallyStopped = false
		await this.startDecoder(id, { startMode })
	}

	/**
	 * Starts all enabled decoders.
	 */
	async startAll(): Promise<void> {
		this.log.info("Starting all enabled decoders")

		const startPromises: Promise<void>[] = []

		for (const [id, state] of this.decoders) {
			// Probes are started and owned by the scanner's probe pool (spec § 6.5).
			if (state.owner === "scanner") continue
			if (state.config.enabled) {
				startPromises.push(
					this.startDecoder(id, { startMode: "auto" }).catch(err => {
						this.log.error(
							{ err: safeErrorFields(err), decoderId: id },
							"Failed to start decoder",
						)
					}),
				)
			}
		}

		await Promise.all(startPromises)
	}

	/**
	 * Stops all running decoders.
	 */
	async stopAll(): Promise<void> {
		this.log.info("Stopping all decoders")

		const stopPromises: Promise<void>[] = []

		// Stop every instance so queued retries are cancelled even after a crash.
		for (const id of this.decoders.keys()) {
			stopPromises.push(
				this.stopDecoder(id).catch(err => {
					this.log.error(
						{ err: safeErrorFields(err), decoderId: id },
						"Failed to stop decoder",
					)
				}),
			)
		}

		await Promise.all(stopPromises)
	}

	/**
	 * WG8 (DecoderSettingsManagerPort): stages option values for the next start
	 * (`null` removes the key) and returns whether they differ from the
	 * instance's current options. Unknown ids and scanner probes: false and
	 * nothing staged. Never touches a running process.
	 */
	stageDecoderOptions(
		id: string,
		options: Readonly<Record<string, DecoderSettingValue | null>>,
	): boolean {
		const state = this.decoders.get(id)
		if (!state || state.owner !== "config") return false
		const staged: Record<string, DecoderSettingValue | null> = {
			...(state.stagedOptions ?? {}),
		}
		for (const [key, value] of Object.entries(options))
			staged[key] = value === null ? null : structuredClone(value)
		state.stagedOptions = staged
		if (!this.stagedDiffers(state)) state.stagedOptions = null
		return state.stagedOptions !== null
	}

	/** WG8: true while the instance does not yet run with its staged options. */
	isRestartPending(id: string): boolean {
		const state = this.decoders.get(id)
		if (!state || state.owner !== "config") return false
		return this.stagedDiffers(state)
	}

	private stagedDiffers(state: DecoderState): boolean {
		const staged = state.stagedOptions
		if (!staged) return false
		const current = state.config.options ?? {}
		for (const [key, value] of Object.entries(staged))
			if (!sameJsonValue(current[key], value)) return true
		return false
	}

	/**
	 * WG8: replaces a stopped instance with one built from the current config
	 * plus the staged options, wired as `registerDecoder` wires a new one.
	 * Without differing staged options it does nothing. A failure keeps the old
	 * instance, config and staging, stops the decoder and throws
	 * DecoderRebuildError.
	 */
	/** Returns true when a new adapter instance replaced the previous one. */
	private async rebuildIfPending(state: DecoderState): Promise<boolean> {
		if (state.owner !== "config" || !state.stagedOptions) return false
		if (!this.stagedDiffers(state)) {
			state.stagedOptions = null
			return false
		}
		if (state.decoder.getStatus().running) return false
		const id = state.config.id
		const options: Record<string, unknown> = { ...(state.config.options ?? {}) }
		for (const [key, value] of Object.entries(state.stagedOptions)) {
			if (value === null) delete options[key]
			else options[key] = structuredClone(value)
		}
		const config: DecoderConfig = { ...state.config, options }
		let decoder: Decoder
		try {
			decoder = this.registry.create(config, this.log)
			const declared = decoder.getRateRequirements?.()
			if (declared !== undefined) {
				try {
					validateDeclaredRateRequirements(
						declared,
						`decoders.${id}.rateRequirements`,
					)
				} catch (err) {
					decoder.removeAllListeners()
					throw err
				}
			}
		} catch (err) {
			this.log.error(
				{ decoderId: id, err: safeErrorFields(err) },
				"Decoder rebuild failed; previous instance kept",
			)
			const failure = new DecoderRebuildError()
			state.intentionallyStopped = true
			state.desiredRunning = false
			state.startMode = "auto"
			state.rateGeneration++
			state.suspension = null
			state.transition = null
			this.cancelScheduledRestart(state)
			this.unwireDecoderFromFanout(state)
			state.lastError = createDecoderLastError(failure, "error")
			this.updateDecoderHealth(state, "faulted")
			this.emitStatusChanged(state)
			throw failure
		}
		this.log.info(
			{ decoderId: id, type: config.type },
			"Rebuilding decoder with staged options",
		)
		// The old instance is stopped: drop its input and listeners.
		if (state.branchId !== null || state.channel !== null)
			this.detachBranch(state)
		const retired = state.decoder
		retired.removeAllListeners()
		state.decoder = decoder
		// Run the retired adapter's cleanup (timers, watchers) with its listeners
		// already detached; stop() is a no-op on an exited process.
		try {
			await retired.stop()
		} catch (err) {
			this.log.warn(
				{ decoderId: id, err: safeErrorFields(err) },
				"Retired decoder cleanup failed",
			)
		}
		state.config = config
		state.stagedOptions = null
		// Counters and derived views as on a fresh create.
		state.versionValidation = this.config.validateVersions
			? this.validateDecoderVersion(config)
			: undefined
		state.optionIssues = this.checkDecoderOptions(config)
		delete state.inputCaps
		state.restartCount = 0
		state.consecutiveFailures = 0
		state.currentDelay = this.config.restartDelay
		state.lastError = null
		state.lastOutputAt = null
		state.lastStartedAt = null
		this.updateDecoderHealth(state, "running")
		this.setupDecoderEventHandlers(state)
		this.refreshRatePlan(state)
		this.emit("decoder:created", id)
		return true
	}

	/**
	 * After a rebuild on an internal start path (crash restart, resume): the
	 * same eligibility decision startDecoder makes. Returns the blocking
	 * eligibility, or null when the rebuilt decoder may be wired and started.
	 */
	private blockedAfterRebuild(state: DecoderState): Eligibility | null {
		if (state.decoder.caps.input === "external") return null
		const sourceId = this.selectedSourceId(state)
		const eligibility = this.assessEligibility(
			state,
			(sourceId ? this.sourceManager?.getCaps(sourceId) : undefined) ?? null,
		)
		state.ratePlan = eligibility.rate
		state.bandPlan = eligibility.band
		return eligibility.blockedBy === null ? null : eligibility
	}

	/**
	 * Gets a decoder by ID.
	 *
	 * @param id - The decoder ID
	 * @returns The decoder instance or undefined if not found
	 */
	getDecoder(id: string): Decoder | undefined {
		return this.decoders.get(id)?.decoder
	}

	/**
	 * Gets all managed decoders.
	 *
	 * @returns Array of all decoder instances
	 */
	getAllDecoders(): Decoder[] {
		return Array.from(this.decoders.values()).map(state => state.decoder)
	}

	/**
	 * Configs of the config-owned decoders managed now (created at startup or later),
	 * in creation order. Scanner probes are left out: they record inside scanner storage.
	 */
	getConfiguredDecoderConfigs(): readonly DecoderConfig[] {
		const configs: DecoderConfig[] = []
		for (const state of this.decoders.values())
			if (state.owner === "config") configs.push(state.config)
		return configs
	}

	/**
	 * Gets the status of a decoder by ID (Requirement 4.5).
	 *
	 * @param id - The decoder ID
	 * @returns DecoderStatus or undefined if not found
	 */
	getStatus(id: string): DecoderStatus | undefined {
		const state = this.decoders.get(id)
		if (!state) return undefined
		return {
			...state.decoder.getStatus(),
			health: state.lastHealth,
			restartCount: state.restartCount,
			...(state.optionIssues !== undefined
				? { optionIssues: state.optionIssues.map(issue => ({ ...issue })) }
				: {}),
			...(state.ratePlan ? { rateAssessment: state.ratePlan } : {}),
			...(state.bandPlan ? { bandAssessment: state.bandPlan } : {}),
			...(state.nextRestartAt ? { nextRestartAt: state.nextRestartAt } : {}),
			desiredRunning: state.desiredRunning,
			suspended: state.suspension !== null,
			...publicSuspension(state.suspension),
			...(state.transition ? { transition: state.transition } : {}),
			...(state.desiredRunning ? { startMode: state.startMode } : {}),
			owner: state.owner,
			...(state.scannerJobId !== null
				? { scannerJobId: state.scannerJobId }
				: {}),
			...(state.owner === "scanner" ? { ephemeral: true as const } : {}),
			...describeDecoderStatusFields({
				config: state.config,
				caps: state.decoder.caps,
				assignedSourceId: state.assignedSourceId,
				lastError: state.lastError,
				idleTimeoutMs: this.config.idleTimeout,
			}),
		}
	}

	/**
	 * Rate plans for every decoder selecting `sourceId` as if that source ran
	 * at `sampleRateHz`. Pure: no tuner write, no caps change, no lifecycle.
	 * RTL-TCP sources reject rates librtlsdr cannot set.
	 */
	previewRates(sourceId: string, sampleRateHz: number): RatePreviewResult {
		const caps = this.sourceManager?.getCaps(sourceId)
		if (!caps) return { ok: false, reason: "source-not-found" }
		if (
			this.sourceManager?.isRtlTcpSource(sourceId) &&
			!isValidRtlSampleRate(sampleRateHz)
		)
			return { ok: false, reason: "unsupported-rate" }
		const items: RatePreviewItem[] = []
		for (const state of this.decoders.values()) {
			if (this.selectedSourceId(state) !== sourceId) continue
			if (state.decoder.caps.input === "external") continue
			items.push({
				decoderId: state.config.id,
				assessment: this.assessState(state, {
					...caps,
					sampleRate: sampleRateHz,
				}),
			})
		}
		return { ok: true, items }
	}

	/**
	 * Gets the status of all managed decoders (Requirement 4.5).
	 *
	 * @returns Array of DecoderStatus for all decoders
	 */
	getAllStatus(): DecoderStatus[] {
		return Array.from(this.decoders.keys()).map(id => this.getStatus(id)!)
	}

	/**
	 * Removes a decoder from management.
	 * Stops the decoder if running and cleans up resources.
	 *
	 * @param id - The decoder ID to remove
	 */
	async removeDecoder(id: string): Promise<void> {
		const state = this.decoders.get(id)
		if (!state) {
			return
		}

		this.log.info({ decoderId: id }, "Removing decoder")

		// Also cancel pending restarts when the process has already exited.
		// A probe is removed even when its stop fails: the probe pool cannot
		// retry a removal that would fail the same way (spec § 6.5).
		let stopFailed = false
		let stopError: unknown
		try {
			await this.stopDecoder(id)
		} catch (err) {
			if (state.owner !== "scanner") throw err
			stopFailed = true
			stopError = err
		}

		// Remove event listeners
		state.decoder.removeAllListeners()

		// Remove from map
		if (this.decoders.get(id) === state) {
			this.decoders.delete(id)
			this.emit("decoder:removed", id)
		}
		if (stopFailed) throw stopError
	}

	/**
	 * Destroys the manager and all managed decoders.
	 */
	async destroy(): Promise<void> {
		this.destroying = true
		for (const state of this.pendingScannerChannels.keys())
			this.cancelScannerChannelAttempt(state)
		this.log.info("Destroying DecoderManager")

		// Stop health checks
		this.stopHealthChecks()
		this.clearChannelRetries()

		// Unsubscribe from source caps changes
		this.unsubscribeFromSourceCapsChanges()

		if (this.sourceConnectedHandler && this.sourceManager) {
			this.sourceManager.off("connected", this.sourceConnectedHandler)
			this.sourceConnectedHandler = null
		}
		if (this.sourceRemovedHandler && this.sourceManager) {
			this.sourceManager.off("removed", this.sourceRemovedHandler)
			this.sourceRemovedHandler = null
		}
		if (this.sourceConnectedEvaluation && this.sourceManager) {
			this.sourceManager.off("connected", this.sourceConnectedEvaluation)
			this.sourceConnectedEvaluation = null
		}

		await this.stopAll()

		for (const id of this.decoders.keys()) {
			await this.removeDecoder(id)
		}
		// After the stops above, which release their channels through it.
		this.setChannelizer(null)
		if (this.ownsSourceRouting) this.sourceRouting?.destroy()
	}

	/**
	 * Sets up event handlers for a decoder to forward events and handle auto-restart.
	 * All handlers are wrapped in try-catch to ensure failure isolation (Requirement 10.1).
	 */
	private setupDecoderEventHandlers(state: DecoderState): void {
		const { decoder } = state

		// The manager consumes output via events. Drain the parallel stream so
		// unattended decoders do not retain every event for the lifetime of the app.
		decoder.getOutput().resume()

		// Forward output events (Requirement 4.4, 4.6)
		// Also track last output time for health checks (Requirement 20.1, 20.2)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("output", (output: DecoderOutput) => {
			try {
				state.lastOutputAt = new Date()
				state.currentDelay = this.config.restartDelay
				// Output proves the run is stable and ends any crash loop.
				state.consecutiveFailures = 0
				this.updateDecoderHealth(state, "running")
				this.emit("decoder:output", decoder.id, output)
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: decoder.id },
					"Error handling decoder output event, continuing operation",
				)
			}
			const publish = this.activityPublisher
			if (!publish) return
			try {
				publish(decoder.id, decoder.type, output)
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: decoder.id },
					"Activity publisher failed, continuing operation",
				)
			}
		})

		// Forward error events (Requirement 4.6)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("error", (error: Error) => {
			try {
				state.lastError = createDecoderLastError(error, "error")
				this.log.error(
					{ err: safeErrorFields(error), decoderId: decoder.id },
					"Decoder error",
				)
				this.emit("decoder:error", decoder.id, error)
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: decoder.id },
					"Error handling decoder error event, continuing operation",
				)
			}
		})

		// Handle started event
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("started", () => {
			try {
				state.lastOutputAt = null
				state.lastStartedAt = new Date()
				// Reset health to running when decoder starts (Requirement 20.1),
				// except that a crash loop stays faulted until a run proves stable.
				if (!this.inCrashLoop(state)) this.updateDecoderHealth(state, "running")
				this.emit("decoder:started", decoder.id)
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: decoder.id },
					"Error handling decoder started event, continuing operation",
				)
			}
		})

		// Handle stopped event
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("stopped", () => {
			try {
				this.emit("decoder:stopped", decoder.id)
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: decoder.id },
					"Error handling decoder stopped event, continuing operation",
				)
			}
		})

		// Forward health events from decoder (Requirement 20.4)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("health", (health: DecoderHealth) => {
			try {
				this.updateDecoderHealth(state, health)
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: decoder.id },
					"Error handling decoder health event, continuing operation",
				)
			}
		})

		// Handle exit for auto-restart (Requirement 4.2)
		// Wrapped in try-catch for failure isolation (Requirement 10.1)
		decoder.on("exit", (code: number | null, signal: string | null) => {
			try {
				this.handleDecoderExit(state, code, signal)
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: decoder.id, code, signal },
					"Error handling decoder exit event, continuing operation",
				)
			}
		})
	}

	/**
	 * Handles decoder process exit for auto-restart logic (Requirement 4.2).
	 * Also handles health state transitions (Requirements 20.3).
	 * Ensures failure isolation - errors here don't affect other decoders (Requirement 10.1).
	 */
	private handleDecoderExit(
		state: DecoderState,
		code: number | null,
		signal: string | null,
	): void {
		const { decoder } = state
		const now = Date.now()

		// A suspension stop is not a failure: keep the reservation, record no
		// lastError, schedule no restart and consume no budget.
		if (state.suspension !== null) {
			this.log.debug(
				{ decoderId: decoder.id, code, signal },
				"Decoder exited for rate suspension",
			)
			return
		}

		// Clean up fanout branch on exit - wrapped in try-catch for isolation (Requirement 10.1)
		try {
			this.unwireDecoderFromFanout(state)
		} catch (err) {
			this.log.error(
				{ err: safeErrorFields(err), decoderId: decoder.id },
				"Error unwiring decoder from fanout, continuing with exit handling",
			)
		}

		// Real exits carry a code or signal; (null, null) marks a failed restart
		// whose cause the restart path already recorded. An error from this same
		// run is more specific than the generic exit that follows it.
		const errorThisRun =
			state.lastError?.kind === "error" &&
			(state.lastStartedAt === null ||
				state.lastError.at.getTime() >= state.lastStartedAt.getTime())
		const realExit = code !== null || signal !== null
		if (!state.intentionallyStopped && realExit && !errorThisRun)
			state.lastError = createDecoderExitError(code, signal)
		// Probes are never restarted: their input is single-use and the probe
		// pool owns their lifecycle (spec § 6.5).
		if (state.owner === "scanner") {
			if (!state.intentionallyStopped) {
				state.desiredRunning = false
				this.updateDecoderHealth(state, "faulted")
			}
			this.emitStatusChanged(state)
			return
		}

		// Don't restart if intentionally stopped
		if (state.intentionallyStopped) {
			this.log.debug(
				{ decoderId: decoder.id },
				"Decoder stopped intentionally, not restarting",
			)
			this.emitStatusChanged(state)
			return
		}

		// A run that produced output or lasted stableRunMs ends any crash loop
		// and resets the backoff; (null, null) is a failed restart, not a run.
		const startedAt = state.lastStartedAt?.getTime()
		const stableRun =
			realExit &&
			startedAt !== undefined &&
			((state.lastOutputAt !== null &&
				state.lastOutputAt.getTime() >= startedAt) ||
				now - startedAt >= this.config.stableRunMs)
		if (stableRun) {
			// The exit ending a stable run is not itself an unstable run.
			state.consecutiveFailures = 0
			state.currentDelay = this.config.restartDelay
		} else {
			state.consecutiveFailures++
		}

		// Check if max restarts exceeded (Requirement 20.3)
		if (
			this.config.maxRestarts > 0 &&
			state.restartCount >= this.config.maxRestarts
		) {
			this.log.error(
				{ decoderId: decoder.id, restartCount: state.restartCount },
				"Max restarts exceeded, not restarting - other decoders continue operating",
			)
			// Set health to faulted when crash loop detected (Requirement 20.3)
			this.updateDecoderHealth(state, "faulted")
			this.emitStatusChanged(state)
			this.emit("decoder:max-restarts", decoder.id, state.restartCount)
			return
		}

		// Schedule restart with exponential backoff
		state.restartCount++
		const delay = state.currentDelay

		this.log.info(
			{
				decoderId: decoder.id,
				code,
				signal,
				attempt: state.restartCount,
				delay,
			},
			"Decoder exited unexpectedly, scheduling restart - other decoders continue operating",
		)

		state.nextRestartAt = new Date(now + delay)
		this.updateDecoderHealth(
			state,
			this.inCrashLoop(state) ? "faulted" : "restarting",
		)
		this.emitStatusChanged(state)
		this.emit("decoder:restarting", decoder.id, state.restartCount, delay)

		state.restartTimer = setTimeout(() => {
			state.restartTimer = null
			state.nextRestartAt = null

			// Use void to handle the promise without blocking
			void (async () => {
				try {
					// Wire to fanout and start
					if (state.intentionallyStopped) return
					if (state.stagedOptions && (await this.rebuildIfPending(state))) {
						const blocked = this.blockedAfterRebuild(state)
						if (blocked) {
							await this.suspend(state, blocked)
							return
						}
					}
					const outcome = await this.wireDecoderToFanout(state)
					if (state.intentionallyStopped) {
						this.unwireDecoderFromFanout(state)
						return
					}
					if (!outcome.wired) {
						if (!outcome.superseded) this.holdForChannel(state, outcome)
						return
					}
					await state.decoder.start()
					this.recheckStaleChannel(this.selectedSourceId(state), state)
				} catch (err) {
					// A failed rebuild already left the decoder stopped with its error.
					if (err instanceof DecoderRebuildError) return
					state.lastError = createDecoderLastError(err, "error")
					// Log failure but don't crash - failure isolation (Requirement 10.1)
					this.log.error(
						{ err: safeErrorFields(err), decoderId: decoder.id },
						"Failed to restart decoder - other decoders continue operating",
					)
					// Spawn failures do not emit exit, so retry them explicitly.
					if (!state.intentionallyStopped && !state.restartTimer) {
						this.handleDecoderExit(state, null, null)
					}
				}
			})()
		}, delay)

		// Calculate next delay with exponential backoff (Requirement 4.2)
		// Formula: min(2^N * baseDelay, maxDelay)
		state.currentDelay = Math.min(
			state.currentDelay * 2,
			this.config.maxRestartDelay,
		)
	}

	/**
	 * Wires a decoder to a fanout branch for audio input.
	 * Only wires decoders that accept audio/IQ via stdin (input type != "external").
	 */
	private async wireDecoderToFanout(state: DecoderState): Promise<WireOutcome> {
		const { decoder, config } = state

		// Skip wiring for decoders that manage their own input
		// (external SDR decoders and network producers using rtl_tcp, etc.)
		if (decoder.caps.input === "external") {
			this.log.debug(
				{ decoderId: decoder.id, input: decoder.caps.input },
				"Skipping fanout wiring for external input decoder",
			)
			return { wired: true }
		}

		const sourceId = config.sourceId ?? this.sourceRouting?.getDefaultSourceId()
		if (config.sourceId && !this.sourceRouting) {
			throw new Error(
				`Source routing is not configured for decoder ${config.id}`,
			)
		}
		let caps: SourceCaps | undefined
		if (sourceId && this.sourceManager) {
			caps = this.sourceManager.getCaps(sourceId)
			if (caps) {
				state.inputCaps = { ...caps }
				decoder.updateOptions({
					inputSampleRate: caps.sampleRate,
					...(caps.centerFreq !== undefined
						? { inputCenterFreq: caps.centerFreq }
						: {}),
				})
			}
			this.refreshRatePlan(state, caps ?? null)
			this.sourceManager.assignDecoder(config.id, sourceId, {
				input: decoder.caps.input,
				wantsExclusiveSource: decoder.caps.wantsExclusiveSource ?? false,
			})
			state.assignedSourceId = sourceId
		}
		// Scanner probes read pre-roll + live bytes from the probe pool;
		// createEphemeralDecoder attaches the input after the spawn.
		if (state.input) return { wired: true }
		const provider = this.channelizer
		// This wiring replaces whatever channel was invalidated.
		state.channelStale = false
		const request = this.channelRequestFor(state, caps)
		if (provider && sourceId && request)
			return this.wireDecoderToChannel(state, provider, sourceId, request)
		// Raw path again (no channel request now): the decoder reads CU8.
		if (config.useChannelizer === true)
			decoder.updateOptions({ inputIqFormat: "cu8" })
		const branchId = `decoder-${config.id}`
		const fanout = this.sourceRouting?.getFanout(sourceId) ?? this.fanout
		// Track resources before attaching so failed attachment is cleaned up too.
		state.branchId = branchId
		state.branchFanout = fanout
		const branch = fanout.addBranch({
			id: branchId,
			decoderId: config.id,
			...(sourceId ? { sourceId } : {}),
		})
		decoder.attachInput(branch)

		this.log.debug(
			{ decoderId: decoder.id, branchId },
			"Decoder wired to fanout branch",
		)
		return { wired: true }
	}

	/**
	 * Feeds the decoder a channelizer channel instead of a raw branch
	 * (addendum §4). Every await is followed by the rate-model identity,
	 * generation and intent checks plus the channel-generation check; a
	 * rejection is returned for the caller to hold as a suspension (§5).
	 */
	private async wireDecoderToChannel(
		state: DecoderState,
		provider: ChannelProvider,
		sourceId: string,
		request: DecoderChannelRequestResult,
		retried = false,
	): Promise<WireOutcome> {
		if ("invalid" in request)
			return {
				wired: false,
				superseded: false,
				reasonCode: "channel-request-invalid",
				detail: request.invalid,
			}
		const generation = state.rateGeneration
		let attempt: ScannerChannelAttempt | null = null
		if (state.owner === "scanner") {
			if (
				!this.stillWanted(state, generation) ||
				state.intentionallyStopped ||
				this.selectedSourceId(state) !== sourceId ||
				state.assignedSourceId !== sourceId
			)
				return { wired: false, superseded: true }
			this.cancelScannerChannelAttempt(state)
			attempt = {
				state,
				provider,
				sourceId,
				rateGeneration: generation,
				terminal: false,
				invalidated: new Set(),
			}
			state.scannerChannelAttempt = attempt
			this.pendingScannerChannels.set(state, attempt)
		}
		const result = await this.requestChannel(provider, sourceId, state, request)
		if (attempt && this.pendingScannerChannels.get(state) === attempt)
			this.pendingScannerChannels.delete(state)
		if (!this.stillWanted(state, generation)) {
			if (attempt) this.cancelScannerChannelAttempt(state, attempt)
			if (result.ok)
				await this.discardChannel(provider, result.stream, result.channelId)
			return { wired: false, superseded: true }
		}
		if (!result.ok) {
			if (attempt) this.cancelScannerChannelAttempt(state, attempt)
			return {
				wired: false,
				superseded: false,
				reasonCode: result.reasonCode,
				detail: result.detail,
			}
		}
		if (
			attempt &&
			(!this.scannerAttemptLive(attempt) ||
				attempt.invalidated.has(
					JSON.stringify([result.generation, result.channelId]),
				) ||
				result.stream.destroyed ||
				result.stream.readableEnded ||
				result.generation !==
					this.scannerProviderGeneration(provider, sourceId) ||
				!this.scannerAttemptLive(attempt))
		) {
			this.cancelScannerChannelAttempt(state, attempt)
			await this.discardChannel(provider, result.stream, result.channelId)
			return {
				wired: false,
				superseded: false,
				reasonCode: "channelizer-unavailable",
				detail: "scanner channel grant is no longer live",
			}
		}
		if (
			!attempt &&
			result.generation !== provider.currentGeneration(sourceId)
		) {
			// Invalidated while pending (Review Focus 3): retried with the
			// current caps, never parked and never attached.
			await this.discardChannel(provider, result.stream, result.channelId)
			if (!this.stillWanted(state, generation))
				return { wired: false, superseded: true }
			if (retried)
				return {
					wired: false,
					superseded: false,
					reasonCode: "channelizer-unavailable",
					detail: "channel generation changed during two requests",
					race: true,
				}
			const caps = this.sourceManager?.getCaps(sourceId)
			if (caps) {
				state.inputCaps = { ...caps }
				state.decoder.updateOptions({
					inputSampleRate: caps.sampleRate,
					...(caps.centerFreq !== undefined
						? { inputCenterFreq: caps.centerFreq }
						: {}),
				})
			}
			const next = this.channelRequestFor(state, caps)
			if (!next)
				return {
					wired: false,
					superseded: false,
					reasonCode: "channelizer-unavailable",
					detail: `source ${sourceId} has no caps for a channel`,
				}
			return this.wireDecoderToChannel(state, provider, sourceId, next, true)
		}
		state.branchId = result.channelId
		state.branchFanout = null
		const realised = Object.freeze({
			outputRateHz: result.realised.outputRateHz,
			format: result.realised.format,
			groupDelaySamples: result.realised.groupDelaySamples,
		})
		const ref: OpenChannelRef = {
			provider,
			channelId: result.channelId,
			sourceId,
			generation: result.generation,
			realised,
			stream: result.stream,
			binding: attempt
				? Object.freeze({
						decoderId: state.config.id,
						sourceId,
						channelId: result.channelId,
						generation: result.generation,
						realised,
					})
				: null,
			ending: null,
		}
		state.channel = ref
		state.channelStale = false
		attempt?.invalidated.clear()
		if (ref.binding) {
			const notified = this.notifyScannerChannel(
				"decoder:scanner-channel-granted",
				ref.binding,
			)
			if (!notified || !this.probeStartupLive(state, generation, ref)) {
				if (state.channel === ref) this.dropChannel(state, true)
				return { wired: false, superseded: true }
			}
		}
		this.channelizerUnavailableLogged = false
		// The channel is what stdin carries: its realised rate, its centre and
		// its sample format (cf32 tails skip the raw convert/shift/decimate).
		state.decoder.updateOptions({
			inputSampleRate: ref.realised.outputRateHz,
			inputCenterFreq: request.centerHz,
			inputIqFormat: ref.realised.format,
		})
		if (attempt && !this.probeStartupLive(state, generation, ref))
			return { wired: false, superseded: true }
		state.decoder.attachInput(result.stream)
		if (attempt && !this.probeStartupLive(state, generation, ref)) {
			if (state.channel === ref) this.dropChannel(state, true)
			else if (!state.channel && !state.branchId) state.decoder.detachInput()
			return { wired: false, superseded: true }
		}
		state.ratePlan = this.assessState(state)
		this.log.debug(
			{ decoderId: state.config.id, channelId: result.channelId },
			"Decoder wired to channelizer channel",
		)
		return { wired: true, ...(attempt ? { scannerChannel: ref } : {}) }
	}

	/** A provider that throws is unavailable, never a decoder failure. */
	private async requestChannel(
		provider: ChannelProvider,
		sourceId: string,
		state: DecoderState,
		request: DecoderChannelRequest,
	): Promise<ChannelRequestResult> {
		try {
			return await provider.requestChannel(
				sourceId,
				state.config.id,
				request,
				state.inputCaps,
			)
		} catch (err: unknown) {
			// The thrown message can carry paths or argv: only a safe code reaches
			// the status detail and its logs.
			const { code } = safeErrorFields(err)
			return {
				ok: false,
				reasonCode: "channelizer-unavailable",
				detail:
					code !== undefined
						? `channel request failed (${code})`
						: "channel request failed",
			}
		}
	}

	private async discardChannel(
		provider: ChannelProvider,
		stream: Readable,
		channelId: string,
	): Promise<void> {
		stream.destroy()
		try {
			await provider.releaseChannel(channelId)
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err), channelId },
				"Channel release failed",
			)
		}
	}

	/**
	 * The channel this instance wants for `caps`: only with a channelizer and
	 * `useChannelizer`. A throwing decoder is an invalid request, not a crash.
	 */
	private channelRequestFor(
		state: DecoderState,
		caps: SourceCaps | undefined,
	): DecoderChannelRequestResult | undefined {
		if (!this.channelizer || state.config.useChannelizer !== true || !caps)
			return undefined
		try {
			return state.decoder.getChannelRequest?.({
				sampleRateHz: caps.sampleRate,
				...(caps.centerFreq !== undefined ? { centerHz: caps.centerFreq } : {}),
			})
		} catch (err: unknown) {
			return { invalid: err instanceof Error ? err.message : String(err) }
		}
	}

	/** Releases the open channel, if any; call after detachInput (Review Focus 3). */
	private releaseChannelOf(state: DecoderState): void {
		const ref = state.channel
		if (!ref) return
		state.channel = null
		this.cancelScannerChannelAttempt(state)
		if (ref.binding)
			this.notifyScannerChannel(
				"decoder:scanner-channel-ended",
				ref.binding,
				"released",
			)
		this.releaseChannelRef(ref)
	}

	/** Notification failure is isolated per listener; cleanup and other bindings must proceed. */
	private notifyScannerChannel(
		event: "decoder:scanner-channel-granted" | "decoder:scanner-channel-ended",
		binding: ScannerDecoderChannelBinding,
		reason?: "invalidated" | "released",
	): boolean {
		let delivered = true
		for (const listener of this.rawListeners(event)) {
			try {
				Reflect.apply(
					listener,
					this,
					reason === undefined ? [binding] : [binding, reason],
				)
			} catch (err: unknown) {
				delivered = false
				this.log.error(
					{ err: safeErrorFields(err), event, decoderId: binding.decoderId },
					"Scanner channel listener threw",
				)
			}
		}
		return delivered
	}

	private releaseChannelRef(ref: OpenChannelRef): void {
		// This is resource release initiation, never a native closure/drain acknowledgement.
		try {
			void ref.provider.releaseChannel(ref.channelId).catch((err: unknown) => {
				this.log.warn(
					{ err: safeErrorFields(err), channelId: ref.channelId },
					"Channel release failed",
				)
			})
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err), channelId: ref.channelId },
				"Channel release failed",
			)
		} finally {
			ref.stream.destroy()
		}
	}

	/**
	 * Takes the channel off a wired decoder and marks it stale for the
	 * worker. Review Focus 3: detach first, so the decoder's stdin never sees
	 * the socket's EOF; `release` only when the provider is not already
	 * tearing the channel down.
	 */
	private dropChannel(state: DecoderState, release: boolean): void {
		const ref = state.channel ?? state.endingChannel
		if (!ref) return
		if (state.channel === ref) this.claimChannel(state, ref, release)
		this.finishChannelDrop(state, ref)
	}

	/** No callbacks: batch termination claims every old identity before notifying any. */
	private claimChannel(
		state: DecoderState,
		ref: OpenChannelRef,
		release: boolean,
	): void {
		if (state.channel !== ref) return
		ref.ending = { release, cleanupStarted: false }
		state.endingChannel = ref
		// Claim termination before callbacks. Reentrant removal cannot end/release this ref twice.
		state.channel = null
		state.branchId = null
		state.branchFanout = null
		state.inputAttached = false
		state.channelStale = true
		this.cancelScannerChannelAttempt(state)
	}

	/** Completes only a previously claimed ref; never clears a successor's ownership. */
	private finishChannelDrop(state: DecoderState, ref: OpenChannelRef): void {
		const ending = ref.ending
		if (!ending || ending.cleanupStarted) return
		ending.cleanupStarted = true
		if (state.endingChannel === ref) state.endingChannel = null
		if (ref.binding)
			this.notifyScannerChannel(
				"decoder:scanner-channel-ended",
				ref.binding,
				ending.release ? "released" : "invalidated",
			)
		try {
			// An ended callback may have already installed a replacement on this instance.
			if (!state.channel && !state.branchId) state.decoder.detachInput()
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err), decoderId: state.config.id },
				"detachInput failed while dropping a channel",
			)
		}
		if (ending.release) this.releaseChannelRef(ref)
	}

	/**
	 * A rejected channel is a suspension, never a failure (addendum §5,
	 * Property 11): no restart budget, no backoff, no lastError, `enabled`
	 * untouched. The source reservation from wiring is kept. `heldSince`
	 * carries the since of a suspension that a resume attempt cleared.
	 */
	private holdForChannel(
		state: DecoderState,
		outcome: ChannelHold,
		heldSince?: Date,
	): void {
		state.suspension = {
			reasonCode: outcome.reasonCode,
			since: state.suspension?.since ?? heldSince ?? new Date(),
		}
		state.transition = null
		if (state.lastHealth === "restarting")
			this.updateDecoderHealth(state, "running")
		const fields = {
			decoderId: state.config.id,
			reasonCode: outcome.reasonCode,
			detail: outcome.detail,
		}
		if (outcome.reasonCode === "channelizer-unavailable") {
			this.scheduleChannelRetry(this.selectedSourceId(state))
			if (outcome.race) {
				this.log.debug(fields, "Channel request raced a retune; will retry")
			} else {
				if (!this.channelizerUnavailableLogged)
					this.log.error(
						fields,
						"Channelizer unavailable; channelised decoders suspended",
					)
				this.channelizerUnavailableLogged = true
			}
		} else {
			this.log.info(fields, "Decoder suspended: channel not admitted")
		}
		this.emitStatusChanged(state)
	}

	/**
	 * Lets the serial worker restart decoders whose channel was invalidated:
	 * every stale decoder on the source, or only `state` when given (a start
	 * that was in flight when its channel went away).
	 */
	private recheckStaleChannel(
		sourceId: string | undefined,
		state?: DecoderState,
	): void {
		if (!sourceId || (state && !state.channelStale)) return
		this.enqueueSourceEvaluation(sourceId, {
			caps: this.sourceManager?.getCaps(sourceId) ?? null,
			adapt: false,
		})
	}

	/** A wanted decoder on `sourceId` is held because the channelizer is unavailable. */
	private heldForChannelizer(sourceId: string): boolean {
		for (const state of this.decoders.values())
			if (
				state.desiredRunning &&
				state.suspension?.reasonCode === "channelizer-unavailable" &&
				this.selectedSourceId(state) === sourceId
			)
				return true
		return false
	}

	/**
	 * PF6/A14: nothing else re-evaluates a source once ChannelizerManager's
	 * crash-loop window expires, so one bounded retry per source is kept
	 * while any decoder there is held for channelizer-unavailable.
	 */
	private scheduleChannelRetry(sourceId: string | undefined): void {
		if (!sourceId || this.destroying || this.channelRetryTimers.has(sourceId))
			return
		const timer = setTimeout(() => {
			this.channelRetryTimers.delete(sourceId)
			if (!this.heldForChannelizer(sourceId)) return
			this.enqueueSourceEvaluation(sourceId, {
				caps: this.sourceManager?.getCaps(sourceId) ?? null,
				adapt: false,
			})
		}, DecoderManager.CHANNELIZER_RETRY_MS)
		this.channelRetryTimers.set(sourceId, timer)
	}

	/** Cancels the source's retry; with `ifIdle`, only when nothing there is held. */
	private clearChannelRetry(
		sourceId: string | undefined,
		ifIdle = false,
	): void {
		if (!sourceId) return
		const timer = this.channelRetryTimers.get(sourceId)
		if (!timer || (ifIdle && this.heldForChannelizer(sourceId))) return
		clearTimeout(timer)
		this.channelRetryTimers.delete(sourceId)
	}

	private clearChannelRetries(): void {
		for (const timer of this.channelRetryTimers.values()) clearTimeout(timer)
		this.channelRetryTimers.clear()
	}

	/**
	 * Unwires a decoder from its fanout branch.
	 */
	private unwireDecoderFromFanout(state: DecoderState): void {
		this.cancelScannerChannelAttempt(state)
		if ((state.owner === "scanner" && state.channel) || state.endingChannel)
			this.dropChannel(state, true)
		const { decoder, branchId, branchFanout, assignedSourceId, inputAttached } =
			state
		try {
			if (branchId || inputAttached) decoder.detachInput()
		} finally {
			try {
				if (branchId) branchFanout?.removeBranch(branchId)
			} finally {
				this.releaseChannelOf(state)
				state.channelStale = false
				state.branchId = null
				state.branchFanout = null
				state.inputAttached = false
				state.assignedSourceId = null
				if (assignedSourceId && this.decoders.get(state.config.id) === state) {
					this.sourceManager?.unassignDecoder(state.config.id)
					this.sourceRouting?.releaseUnused(assignedSourceId)
				}
			}
		}
		if (branchId) {
			this.log.debug(
				{ decoderId: decoder.id, branchId },
				"Decoder unwired from fanout branch",
			)
		}
	}

	// ============================================================================
	// Dynamic Sample Rate Handling
	// ============================================================================

	/**
	 * Sets the source manager for dynamic sample rate handling.
	 * Should be called after creating the DecoderManager to enable auto-restart
	 * when source sample rates change via TunerRelay.
	 *
	 * @param sourceManager - The source manager instance
	 */
	setSourceManager(
		sourceManager: SourceManager,
		routing?: SourceFanoutRouter,
	): void {
		if (this.sourceConnectedHandler && this.sourceManager) {
			this.sourceManager.off("connected", this.sourceConnectedHandler)
		}
		if (this.sourceRemovedHandler && this.sourceManager) {
			this.sourceManager.off("removed", this.sourceRemovedHandler)
		}
		if (this.sourceConnectedEvaluation && this.sourceManager) {
			this.sourceManager.off("connected", this.sourceConnectedEvaluation)
		}
		this.unsubscribeFromSourceCapsChanges()
		if (this.ownsSourceRouting) this.sourceRouting?.destroy()
		this.sourceManager = sourceManager
		this.sourceRouting =
			routing ??
			new SourceFanoutRouter(
				sourceManager,
				this.fanout,
				this.log,
				sourceManager.getAllStatus()[0]?.id,
			)
		this.ownsSourceRouting = !routing
		this.sourceConnectedHandler = sourceId => {
			for (const state of this.decoders.values()) {
				const selected =
					state.config.sourceId ?? this.sourceRouting?.getDefaultSourceId()
				if (!state.branchId || selected !== sourceId) continue
				try {
					sourceManager.assignDecoder(state.config.id, sourceId, {
						input: state.decoder.caps.input,
						wantsExclusiveSource:
							state.decoder.caps.wantsExclusiveSource ?? false,
					})
					state.assignedSourceId = sourceId
				} catch (err) {
					this.log.error(
						{ err: safeErrorFields(err), decoderId: state.config.id, sourceId },
						"Source reassignment failed",
					)
					this.unwireDecoderFromFanout(state)
					void this.stopDecoder(state.config.id).catch(error => {
						this.log.error(
							{ err: safeErrorFields(error), decoderId: state.config.id },
							"Failed to stop decoder after source reassignment failure",
						)
					})
				}
			}
		}
		sourceManager.on("connected", this.sourceConnectedHandler)
		// Connect and removal are evaluated by the same serial worker as caps
		// changes; a removed source has no rate (plan unknown, never reassigned).
		const connectedEvaluation = (sourceId: string) =>
			this.enqueueSourceEvaluation(sourceId, {
				caps: sourceManager.getCaps(sourceId) ?? null,
				adapt: false,
			})
		sourceManager.on("connected", connectedEvaluation)
		this.sourceRemovedHandler = sourceId => {
			this.clearChannelRetry(sourceId)
			this.enqueueSourceEvaluation(sourceId, { caps: null, adapt: false })
		}
		this.sourceConnectedEvaluation = connectedEvaluation
		sourceManager.on("removed", this.sourceRemovedHandler)
		this.subscribeToSourceCapsChanges()
	}

	/**
	 * Subscribes to source caps changes and restarts affected decoders.
	 * This enables automatic pipeline adaptation when SDR++ users change sample rates.
	 * Uses debouncing to prevent rapid successive restarts.
	 */
	private subscribeToSourceCapsChanges(): void {
		if (!this.sourceManager || this.capsChangedHandler) return

		this.capsChangedHandler = (sourceId: string, caps: SourceCaps) =>
			this.enqueueSourceEvaluation(sourceId, { caps, adapt: true })

		this.sourceManager.on("caps-changed", this.capsChangedHandler)
		this.log.debug("Subscribed to source caps changes")
	}

	/**
	 * Queues a source evaluation for the serial worker. The latest caps per
	 * source win; a pending caps change keeps its pipeline adaptation.
	 */
	private enqueueSourceEvaluation(
		sourceId: string,
		evaluation: PendingSourceEvaluation,
	): void {
		if (!this.capsChangedHandler) return
		const previous = this.pendingCapsChanges.get(sourceId)
		this.pendingCapsChanges.set(sourceId, {
			caps: evaluation.caps,
			adapt:
				evaluation.caps !== null &&
				(evaluation.adapt || (previous?.adapt ?? false)),
		})

		// Debounce rapid changes - SDR++ may send multiple rate changes quickly
		if (this.capsChangeDebounceTimer) {
			clearTimeout(this.capsChangeDebounceTimer)
		}

		this.capsChangeDebounceTimer = setTimeout(() => {
			this.capsChangeDebounceTimer = null
			void this.drainCapsChanges()
		}, DecoderManager.CAPS_CHANGE_DEBOUNCE_MS)
	}

	/**
	 * Keep stop/start cycles serialized while retaining the latest tuning
	 * request. Resolves once every evaluation pending at call time is applied.
	 */
	private drainCapsChanges(): Promise<void> {
		this.capsWork = this.capsWork.then(() => this.runPendingCapsChanges())
		return this.capsWork
	}

	private async runPendingCapsChanges(): Promise<void> {
		try {
			while (this.capsChangedHandler && this.pendingCapsChanges.size > 0) {
				const pending = new Map(this.pendingCapsChanges)
				this.pendingCapsChanges.clear()
				for (const [id, evaluation] of pending) {
					await this.handleCapsChange(id, evaluation.caps, evaluation.adapt)
				}
			}
		} catch (err) {
			this.log.error(
				{ err: safeErrorFields(err) },
				"Failed to apply source tuning changes",
			)
		}
	}

	/**
	 * Handles a debounced caps change event.
	 */
	private async handleCapsChange(
		sourceId: string,
		caps: SourceCaps | null,
		adapt = true,
	): Promise<void> {
		const affectedDecoders: string[] = []

		// Every decoder selecting this source gets a fresh plan and, if the
		// operator wants it running, a suspend/resume decision (spec §4.3).
		// Only running stdin decoders are adapted to a caps change.
		for (const [decoderId, state] of [...this.decoders]) {
			if (this.decoders.get(decoderId) !== state) continue
			if (this.selectedSourceId(state) !== sourceId) continue
			// The probe pool stops and re-creates probes on every epoch (H5).
			if (state.owner === "scanner") continue
			const adapting = await this.evaluateRate(state, caps)
			// A decoder whose channel was invalidated is re-wired on any evaluation.
			if (adapting && caps && (adapt || state.channelStale))
				affectedDecoders.push(decoderId)
		}

		if (affectedDecoders.length === 0 || !caps) return

		this.log.info(
			{
				sourceId,
				newSampleRate: caps.sampleRate,
				affectedDecoders,
			},
			"Source caps changed, updating decoder options",
		)

		const restartDecoders = new Set<string>()
		// Update each decoder's inputSampleRate option BEFORE restart
		// This ensures the decoder rebuilds its pipeline with the correct sample rate
		for (const decoderId of affectedDecoders) {
			const state = this.decoders.get(decoderId)
			if (!state) continue

			const previous = state.inputCaps
			const inputChanged =
				!previous ||
				previous.sampleRate !== caps.sampleRate ||
				previous.format !== caps.format ||
				previous.kind !== caps.kind ||
				previous.channels !== caps.channels
			const passive =
				[
					"dsd-fme",
					"multimon-ng",
					"rtl433",
					"readsb",
					"acarsdec",
					"ais-catcher",
					"direwolf",
				].includes(state.config.type) ||
				(state.config.type === "lora-meshtastic" &&
					!state.config.options["followCenter"])
			if (inputChanged || !passive || state.channelStale)
				restartDecoders.add(decoderId)
			state.inputCaps = { ...caps }
			// An open channel keeps feeding the channel's rate and centre.
			if (state.channel) continue

			try {
				// Propagate the new sample rate to the decoder's options
				state.decoder.updateOptions({
					inputSampleRate: caps.sampleRate,
					...(caps.centerFreq !== undefined
						? { inputCenterFreq: caps.centerFreq }
						: {}),
				})
				this.log.debug(
					{
						decoderId,
						inputSampleRate: caps.sampleRate,
					},
					"Updated decoder inputSampleRate before restart",
				)
			} catch (err) {
				this.log.warn(
					{ decoderId, err: safeErrorFields(err) },
					"Failed to update decoder options before restart",
				)
			}
		}

		// Restart only pipelines whose input format/rate or tuned arguments changed.
		for (const decoderId of restartDecoders) {
			if (!this.capsChangedHandler || this.destroying) break
			const state = this.decoders.get(decoderId)
			if (state?.intentionallyStopped) continue
			if (state?.channelStale) state.keepFailureAccounting = true
			try {
				await this.restartDecoder(decoderId)
			} catch (err) {
				this.log.error(
					{ decoderId, err: safeErrorFields(err) },
					"Failed to restart decoder after sample rate change",
				)
			} finally {
				// Not carried into a later operator start if the restart bailed.
				if (state) state.keepFailureAccounting = false
			}
		}

		// Check for suboptimal sample rates and emit warnings
		for (const decoderId of affectedDecoders) {
			const state = this.decoders.get(decoderId)
			if (!state) continue

			const decoderCaps = state.decoder.caps
			if (decoderCaps?.preferredSampleRates?.length) {
				const preferred = decoderCaps.preferredSampleRates
				const current = caps.sampleRate
				if (!preferred.includes(current)) {
					this.log.warn(
						{
							decoderId,
							currentSampleRate: current,
							preferredRates: preferred,
						},
						"Decoder running with suboptimal sample rate",
					)
				}
			}
		}
	}

	/**
	 * Unsubscribes from source caps changes.
	 */
	private unsubscribeFromSourceCapsChanges(): void {
		this.pendingCapsChanges.clear()
		if (this.capsChangeDebounceTimer) {
			clearTimeout(this.capsChangeDebounceTimer)
			this.capsChangeDebounceTimer = null
			this.pendingCapsChanges.clear()
		}
		if (this.capsChangedHandler && this.sourceManager) {
			this.sourceManager.off("caps-changed", this.capsChangedHandler)
			this.capsChangedHandler = null
			this.log.debug("Unsubscribed from source caps changes")
		}
	}

	// ============================================================================
	// Reversible rate suspension (rate model B2)
	// ============================================================================

	/** Serialized rate-related status, to publish only on real changes. */
	private rateKey(state: DecoderState): string {
		return JSON.stringify([
			state.ratePlan,
			state.bandPlan,
			state.suspension,
			state.transition,
			state.desiredRunning,
		])
	}

	private publishIfRateChanged(state: DecoderState, before: string): void {
		if (this.rateKey(state) !== before) this.emitStatusChanged(state)
	}

	/** Still the same, wanted instance after an await in a transition. */
	private stillWanted(state: DecoderState, generation: number): boolean {
		return (
			!this.destroying &&
			this.decoders.get(state.config.id) === state &&
			state.rateGeneration === generation &&
			state.desiredRunning
		)
	}

	/**
	 * Applies one source evaluation to one decoder. Returns true when the
	 * decoder is running normally and the caller may adapt its pipeline.
	 */
	private async evaluateRate(
		state: DecoderState,
		caps: SourceCaps | null,
	): Promise<boolean> {
		const before = this.rateKey(state)
		const eligibility = this.assessEligibility(state, caps)
		const plan = eligibility.rate
		state.bandPlan = eligibility.band
		const external = state.decoder.caps.input === "external"
		const running = state.decoder.getStatus().running
		const terminalFault =
			!running && !state.restartTimer && state.lastHealth === "faulted"

		if (external || !state.desiredRunning || state.intentionallyStopped) {
			state.ratePlan = plan
			this.publishIfRateChanged(state, before)
			return false
		}

		if (state.suspension) {
			// Removal keeps a suspended decoder suspended on its own source.
			if (caps === null) {
				state.ratePlan = plan
				this.publishIfRateChanged(state, before)
			} else if (
				eligibility.blockedBy === null &&
				this.sameChannelAnswer(state, caps)
			) {
				// Review Focus 5: identical caps get the same admission answer.
				state.ratePlan = plan
				this.publishIfRateChanged(state, before)
			} else if (eligibility.blockedBy === null) {
				await this.resume(state, plan)
			} else if (state.transition === "suspending") {
				await this.suspend(state, eligibility) // retry a failed stop
			} else {
				state.ratePlan = plan
				state.suspension.reasonCode = eligibility.blockedBy
				// Removal drops assignments; a returning source is held again.
				this.ensureReservation(state)
				this.publishIfRateChanged(state, before)
			}
			return false
		}

		if (caps !== null && eligibility.blockedBy !== null && !terminalFault) {
			await this.suspend(state, eligibility)
			return false
		}

		// A removed source leaves running decoders running (today's behaviour).
		state.ratePlan = plan
		this.publishIfRateChanged(state, before)
		return running
	}

	/**
	 * A channel suspension that the same caps would only repeat (delta E10b).
	 * channelizer-unavailable is retried on every evaluation (plan A14, PF6).
	 */
	private sameChannelAnswer(state: DecoderState, caps: SourceCaps): boolean {
		const code = state.suspension?.reasonCode
		const previous = state.inputCaps
		return (
			(code === "channel-outside-capture" ||
				code === "channel-request-invalid") &&
			!state.channelStale &&
			previous !== undefined &&
			previous.sampleRate === caps.sampleRate &&
			previous.centerFreq === caps.centerFreq &&
			previous.format === caps.format &&
			previous.kind === caps.kind
		)
	}

	/**
	 * Stops the process and detaches its branch but keeps the source
	 * reservation and intent. A failed stop leaves transition "suspending"
	 * (the process may still run); the next evaluation retries.
	 */
	private async suspend(
		state: DecoderState,
		eligibility: Eligibility,
	): Promise<void> {
		const id = state.config.id
		state.rateGeneration++
		state.suspension = {
			reasonCode: eligibility.blockedBy ?? "unsupported-sample-rate",
			since: state.suspension?.since ?? new Date(),
		}
		state.transition = "suspending"
		state.ratePlan = eligibility.rate
		state.bandPlan = eligibility.band
		this.cancelScheduledRestart(state)
		if (state.lastHealth === "restarting")
			this.updateDecoderHealth(state, "running")
		this.log.info(
			{ decoderId: id, reasonCode: state.suspension.reasonCode },
			"Suspending decoder (see reasonCode)",
		)
		this.emitStatusChanged(state)

		try {
			if (state.decoder.getStatus().running) await state.decoder.stop()
		} catch (err) {
			this.log.error(
				{ err: safeErrorFields(err), decoderId: id },
				"Failed to stop decoder for rate suspension; will retry",
			)
			this.emitStatusChanged(state)
			return
		}
		// A stop/remove meanwhile owns cleanup (full unwire, intent cleared).
		if (
			this.destroying ||
			this.decoders.get(id) !== state ||
			!state.desiredRunning ||
			!state.suspension
		)
			return

		this.detachBranch(state)
		try {
			this.reserveSource(state)
		} catch (err) {
			this.log.warn(
				{ err: safeErrorFields(err), decoderId: id },
				"Could not keep the source reservation for a suspended decoder",
			)
		}
		state.transition = null
		this.emitStatusChanged(state)
	}

	/** Rewires and starts a suspended decoder whose source rate and band are usable again. */
	private async resume(
		state: DecoderState,
		plan: DecoderRateAssessment,
	): Promise<void> {
		const id = state.config.id
		const generation = ++state.rateGeneration
		state.ratePlan = plan
		// After a failed suspension stop the old process may still run with the
		// pre-suspension options. Stop it while still suspended, so its exit is
		// not treated as a crash, then start a fresh pipeline.
		if (state.decoder.getStatus().running) {
			try {
				await state.decoder.stop()
			} catch (err) {
				this.log.error(
					{ err: safeErrorFields(err), decoderId: id },
					"Failed to stop the surviving process before resuming; will retry",
				)
				this.emitStatusChanged(state)
				return
			}
			if (!this.stillWanted(state, generation) || !state.suspension) return
		}
		// A channel hold re-requests its channel on every evaluation (A14, PF6):
		// that is not a resume until the channel opens, and a repeated hold
		// keeps the suspension's since.
		const prior = state.suspension
		const channelRetry =
			prior !== null && isChannelAdmissionReason(prior.reasonCode)
		state.suspension = null
		state.transition = "resuming"
		this.clearChannelRetry(this.selectedSourceId(state), true)
		if (channelRetry)
			this.log.debug(
				{ decoderId: id, reasonCode: prior.reasonCode },
				"Re-requesting channel for a held decoder",
			)
		else
			this.log.info(
				{ decoderId: id },
				"Resuming decoder: source rate and band are usable",
			)
		this.emitStatusChanged(state)

		const abandon = async (startedProcess: boolean) => {
			if (state.transition === "resuming") state.transition = null
			if (this.decoders.get(id) !== state) return
			if (startedProcess) {
				try {
					await state.decoder.stop()
				} catch (err) {
					this.log.error(
						{ err: safeErrorFields(err), decoderId: id },
						"Failed to stop a decoder whose resume was superseded",
					)
				}
			}
			if (!state.desiredRunning) this.unwireDecoderFromFanout(state)
			this.emitStatusChanged(state)
		}

		try {
			if (state.stagedOptions && (await this.rebuildIfPending(state))) {
				const blocked = this.blockedAfterRebuild(state)
				if (blocked) {
					// Still ineligible with the rebuilt config: stay suspended.
					state.transition = null
					state.suspension = {
						reasonCode: blocked.blockedBy ?? "unsupported-sample-rate",
						since: prior?.since ?? new Date(),
					}
					await this.suspend(state, blocked)
					return
				}
			}
			const outcome = await this.wireDecoderToFanout(state)
			if (!this.stillWanted(state, generation)) return await abandon(false)
			if (!outcome.wired) {
				if (outcome.superseded) return await abandon(false)
				this.holdForChannel(state, outcome, prior?.since)
				return
			}
			await state.decoder.start()
		} catch (err) {
			if (err instanceof DecoderRebuildError) return await abandon(false)
			if (!this.stillWanted(state, generation)) return await abandon(false)
			state.transition = null
			// A real spawn failure: record it and use the normal backoff/budget.
			state.lastError = createDecoderLastError(err, "error")
			this.log.error(
				{ err: safeErrorFields(err), decoderId: id },
				"Failed to resume decoder",
			)
			this.handleDecoderExit(state, null, null)
			return
		}
		if (!this.stillWanted(state, generation)) return await abandon(true)
		if (channelRetry)
			this.log.info({ decoderId: id }, "Resuming decoder: channel opened")
		state.transition = null
		this.emitStatusChanged(state)
		this.recheckStaleChannel(this.selectedSourceId(state), state)
	}

	/** Re-reserves the selected source if the reservation was lost. */
	private ensureReservation(state: DecoderState): void {
		const sourceId = this.selectedSourceId(state)
		if (!sourceId || !this.sourceManager) return
		if (this.sourceManager.getAssignedSource(state.config.id) === sourceId)
			return
		try {
			this.reserveSource(state)
		} catch (err) {
			this.log.warn(
				{ err: safeErrorFields(err), decoderId: state.config.id, sourceId },
				"Could not restore the source reservation for a suspended decoder",
			)
		}
	}

	/** Reserves the selected source for this decoder without a fanout branch. */
	private reserveSource(state: DecoderState): void {
		const sourceId = this.selectedSourceId(state)
		if (!sourceId || !this.sourceManager) return
		if (state.decoder.caps.input === "external") return
		this.sourceManager.assignDecoder(state.config.id, sourceId, {
			input: state.decoder.caps.input,
			wantsExclusiveSource: state.decoder.caps.wantsExclusiveSource ?? false,
		})
		state.assignedSourceId = sourceId
	}

	/**
	 * Removes the fanout branch but keeps assignedSourceId and the source
	 * reservation (unlike unwireDecoderFromFanout, which releases both).
	 */
	private detachBranch(state: DecoderState): void {
		const { decoder, branchId, branchFanout, assignedSourceId } = state
		try {
			if (branchId) decoder.detachInput()
		} finally {
			try {
				if (branchId) branchFanout?.removeBranch(branchId)
			} finally {
				this.releaseChannelOf(state)
				state.channelStale = false
				state.branchId = null
				state.branchFanout = null
				if (branchId && assignedSourceId)
					this.sourceRouting?.releaseUnused(assignedSourceId)
			}
		}
	}

	// ============================================================================
	// Rate plan (reporting only; rate model B1)
	// ============================================================================

	private selectedSourceId(state: DecoderState): string | undefined {
		return state.config.sourceId ?? this.sourceRouting?.getDefaultSourceId()
	}

	/**
	 * Instance rate plan for `caps`: undefined resolves the pipeline's input
	 * caps, else the selected source's caps; null means the source rate is
	 * unknown (for example the source was removed). Never throws.
	 */
	private assessState(
		state: DecoderState,
		caps?: SourceCaps | null,
	): DecoderRateAssessment {
		const resolved = this.resolveCaps(state, caps)
		try {
			const requirements =
				state.decoder.getRateRequirements?.() ??
				state.decoder.caps.rateRequirements
			const adapter = resolved
				? state.decoder.getRateAdapter?.({ sampleRateHz: resolved.sampleRate })
				: undefined
			const context: DecoderRateContext = {
				...(resolved
					? {
							source: {
								// Recording pipelines are the IQ ones.
								kind: resolved.kind === "recording" ? "iq" : resolved.kind,
								rateHz: resolved.sampleRate,
							},
						}
					: {}),
				...(adapter ? { adapter } : {}),
			}
			const plan = assessDecoderRate(requirements, context)
			// Addendum §2: an open channel's realised rate replaces the raw
			// adapter; the source checks are the same as for every instance.
			const channel = state.channel
			return channel && resolved && plan.verdict !== "unusable"
				? channelisedRatePlan(requirements, context, channel.realised)
				: plan
		} catch (err) {
			this.log.error(
				{ err: safeErrorFields(err), decoderId: state.config.id },
				"Rate assessment failed; reporting unknown",
			)
			return { verdict: "unknown", reasonCode: "adaptation-unknown" }
		}
	}

	/**
	 * Caps to assess against: undefined resolves the pipeline's input caps,
	 * else the selected source's caps; null means unknown (source removed).
	 */
	private resolveCaps(
		state: DecoderState,
		caps?: SourceCaps | null,
	): SourceCaps | undefined {
		if (caps === null) return undefined
		const sourceId = this.selectedSourceId(state)
		// inputCaps describe the running pipeline only while it is wired; a
		// stopped decoder's old inputCaps must not outlive later caps changes.
		return (
			caps ??
			(state.branchId ? state.inputCaps : undefined) ??
			(sourceId ? this.sourceManager?.getCaps(sourceId) : undefined)
		)
	}

	/**
	 * Band check for `caps` (same resolution as assessState). The window is
	 * what the instance pipeline keeps around the centre. Never throws.
	 */
	private assessBand(
		state: DecoderState,
		caps?: SourceCaps | null,
	): DecoderBandAssessment {
		if (state.decoder.caps.input === "external")
			return { verdict: "unknown", reasonCode: "external-input" }
		const resolved = this.resolveCaps(state, caps)
		try {
			const adapter = resolved
				? state.decoder.getRateAdapter?.({ sampleRateHz: resolved.sampleRate })
				: undefined
			const channel = this.bandChannel(state, resolved)
			return assessDecoderBand(this.resolveBand(state).requirements, {
				centerHz: channel ? channel.centerHz : resolved?.centerFreq,
				sampleRateHz: resolved?.sampleRate,
				frontendRateHz: channel
					? channel.outputRateHz
					: adapter?.frontendRateHz,
			})
		} catch (err) {
			this.log.error(
				{ err: safeErrorFields(err), decoderId: state.config.id },
				"Band assessment failed; reporting unknown",
			)
			return { verdict: "unknown" }
		}
	}

	/**
	 * Delta E10c (PF13): a decoder with a valid channel request keeps only
	 * its channel, wherever it sits in the capture, so the band is assessed
	 * at the channel centre whether or not the channel is open. A
	 * centre-relative request with the capture centre unknown asks for 0 Hz,
	 * which the band check reports as centre unknown.
	 */
	private bandChannel(
		state: DecoderState,
		caps: SourceCaps | undefined,
	): DecoderChannelRequest | undefined {
		const request = this.channelRequestFor(state, caps)
		return request && !("invalid" in request) ? request : undefined
	}

	/**
	 * Scanner hold first (spec § 10.4), then rate, then band. Rate and band are
	 * still assessed for reporting while held.
	 */
	private assessEligibility(
		state: DecoderState,
		caps?: SourceCaps | null,
	): Eligibility {
		const rate = this.assessState(state, caps)
		const band = this.assessBand(state, caps)
		// An operator start (pin) and the per-decoder opt-out override only
		// the band check; an unusable rate still suspends. Probes are exempt.
		const bandSuspends =
			state.owner === "config" &&
			this.config.bandSuspension &&
			this.decoderBandSuspension(state) &&
			state.startMode !== "operator"
		const blockedBy =
			this.heldReason(state) ??
			(rate.verdict === "unusable"
				? (rate.reasonCode ?? "unsupported-sample-rate")
				: bandSuspends && band.verdict === "out-of-band"
					? "frequency-out-of-band"
					: null)
		return { rate, band, blockedBy }
	}

	/**
	 * The one band resolution (spec §3.2): declaration, config and API
	 * overrides, the region and the built-in table.
	 */
	private resolveBand(state: DecoderState): ResolvedBand {
		return resolveBandRequirements({
			type: state.config.type,
			declaration: state.decoder.getBandDeclaration?.(),
			configOverride: state.config.band,
			apiOverride: this.bandOverrides.get(state.config.id),
			region: this.config.bandRegion,
		})
	}

	/** Per-decoder `band.bandSuspension` (API over config); true when unset. */
	private decoderBandSuspension(state: DecoderState): boolean {
		try {
			return this.resolveBand(state).bandSuspension
		} catch (err) {
			this.log.error(
				{ err: safeErrorFields(err), decoderId: state.config.id },
				"Band resolution failed; band suspension stays enabled",
			)
			return true
		}
	}

	// ============================================================================
	// Start mode and band overrides (band defaults spec §1, §5)
	// ============================================================================

	/**
	 * Records the start mode of a decoder and re-evaluates it (spec §5.4):
	 * "operator" resumes a band-suspended decoder, "auto" may band-suspend a
	 * running one. Returns false when the decoder is unknown.
	 */
	setStartMode(id: string, mode: DecoderStartMode): boolean {
		const state = this.decoders.get(id)
		if (!state) return false
		state.startMode = mode
		this.log.info({ decoderId: id, startMode: mode }, "Decoder start mode set")
		this.reevaluateBand(state)
		return true
	}

	/** Band settings for GET /api/decoders/:id/band; undefined when unknown. */
	getBandSettings(id: string): DecoderBandSettings | undefined {
		const state = this.decoders.get(id)
		if (!state) return undefined
		return this.describeBandSettings(state, this.bandOverrides.isPersisted())
	}

	/** Replaces the API band layer, persists it and re-evaluates. */
	async setBandOverride(
		id: string,
		override: DecoderBandOverride,
	): Promise<DecoderBandSettings | undefined> {
		if (!this.decoders.has(id)) return undefined
		const { persisted } = await this.bandOverrides.set(id, override)
		const state = this.decoders.get(id)
		if (!state) return undefined
		this.log.info({ decoderId: id, override, persisted }, "Band override set")
		this.reevaluateBand(state)
		return this.describeBandSettings(state, persisted)
	}

	/** Removes the API band layer (idempotent), persists and re-evaluates. */
	async deleteBandOverride(
		id: string,
	): Promise<DecoderBandSettings | undefined> {
		if (!this.decoders.has(id)) return undefined
		const { persisted } = await this.bandOverrides.delete(id)
		const state = this.decoders.get(id)
		if (!state) return undefined
		this.log.info({ decoderId: id, persisted }, "Band override removed")
		this.reevaluateBand(state)
		return this.describeBandSettings(state, persisted)
	}

	private describeBandSettings(
		state: DecoderState,
		persisted: boolean,
	): DecoderBandSettings {
		const override = this.bandOverrides.get(state.config.id)
		const config = state.config.band
		const bandAssessment = state.bandPlan ?? this.assessBand(state)
		let region: DecoderBandRegion
		try {
			region = this.resolveBand(state).region
		} catch {
			region = { ...this.config.bandRegion }
		}
		return {
			decoderId: state.config.id,
			override: override ?? null,
			configOverride: config ? normalizeBandOverride(config) : null,
			region,
			persisted,
			bandAssessment: structuredClone(bandAssessment),
		}
	}

	/**
	 * Recomputes the band plan with the source's current caps and publishes
	 * at once; a wanted decoder then gets its suspend/resume decision from
	 * the serial caps worker, never inline.
	 */
	private reevaluateBand(state: DecoderState): void {
		const external = state.decoder.caps.input === "external"
		const sourceId = external ? undefined : this.selectedSourceId(state)
		const caps = sourceId ? this.sourceManager?.getCaps(sourceId) : undefined
		state.bandPlan = this.assessBand(state, caps)
		this.emitStatusChanged(state)
		if (state.desiredRunning && sourceId && caps)
			this.enqueueSourceEvaluation(sourceId, { caps, adapt: false })
	}

	private refreshRatePlan(state: DecoderState, caps?: SourceCaps | null): void {
		state.ratePlan = this.assessState(state, caps)
		state.bandPlan = this.assessBand(state, caps)
	}

	// ============================================================================
	// Version Validation (Requirements 27.1, 27.2, 27.3)
	// ============================================================================

	/**
	 * Validates a decoder's installed version against configured constraints.
	 * Requirements: 27.1, 27.2, 27.3
	 *
	 * @param config - Decoder configuration with version constraints
	 * @returns Version validation result
	 */
	private validateDecoderVersion(
		config: DecoderConfig,
	): VersionValidationResult {
		const { type, minVersion, maxVersion } = config

		// Skip validation if no constraints specified
		if (!minVersion && !maxVersion) {
			this.log.debug(
				{ decoderId: config.id, type },
				"No version constraints specified, skipping validation",
			)
			return { valid: true }
		}

		this.log.info(
			{ decoderId: config.id, type, minVersion, maxVersion },
			"Validating decoder version",
		)

		const result = validateDecoderVersion(type, minVersion, maxVersion)

		if (result.valid) {
			this.log.info(
				{
					decoderId: config.id,
					type,
					detectedVersion: result.detectedVersion,
					minVersion,
					maxVersion,
				},
				"Decoder version validation passed",
			)
		} else {
			// Log warning with upgrade instructions (Requirement 27.2)
			if (result.detectedVersion) {
				if (minVersion && result.detectedVersion) {
					const instructions = getUpgradeInstructions(
						type,
						result.detectedVersion,
						minVersion,
						true,
					)
					this.log.warn(
						{
							decoderId: config.id,
							type,
							detectedVersion: result.detectedVersion,
							minVersion,
							maxVersion,
							hasError: result.error !== undefined,
						},
						instructions,
					)
				} else if (maxVersion && result.detectedVersion) {
					const instructions = getUpgradeInstructions(
						type,
						result.detectedVersion,
						maxVersion,
						false,
					)
					this.log.warn(
						{
							decoderId: config.id,
							type,
							detectedVersion: result.detectedVersion,
							minVersion,
							maxVersion,
							hasError: result.error !== undefined,
						},
						instructions,
					)
				}
			} else {
				this.log.warn(
					{
						decoderId: config.id,
						type,
						hasError: result.error !== undefined,
					},
					`Failed to detect version for decoder ${type}. Version validation skipped.`,
				)
			}

			// Emit version mismatch event
			this.emit("decoder:version-mismatch", config.id, result)
		}

		return result
	}

	/**
	 * Gets the version validation result for a decoder.
	 *
	 * @param id - Decoder ID
	 * @returns Version validation result or undefined if not found
	 */
	getVersionValidation(id: string): VersionValidationResult | undefined {
		return this.decoders.get(id)?.versionValidation
	}

	/**
	 * Gets all version validation results.
	 *
	 * @returns Map of decoder ID to version validation result
	 */
	getAllVersionValidations(): Map<string, VersionValidationResult | undefined> {
		const validations = new Map<string, VersionValidationResult | undefined>()
		for (const [id, state] of this.decoders) {
			validations.set(id, state.versionValidation)
		}
		return validations
	}

	// ============================================================================
	// Health Monitoring (Requirements 20.1, 20.2, 20.3, 20.4)
	// ============================================================================

	/**
	 * Gets the health state of a decoder by ID (Requirements 20.1, 20.2, 20.3).
	 *
	 * @param id - The decoder ID
	 * @returns DecoderHealth or undefined if not found
	 */
	getHealth(id: string): DecoderHealth | undefined {
		const state = this.decoders.get(id)
		if (!state) {
			return undefined
		}
		return state.lastHealth
	}

	/**
	 * Gets the health state of all managed decoders (Requirements 20.1, 20.2, 20.3).
	 *
	 * @returns Map of decoder ID to health state
	 */
	getAllHealth(): Map<string, DecoderHealth> {
		const healthMap = new Map<string, DecoderHealth>()
		for (const [id, state] of this.decoders) {
			healthMap.set(id, state.lastHealth)
		}
		return healthMap
	}

	/**
	 * Starts periodic health checks for all decoders.
	 * Checks for idle state based on output timeout (Requirement 20.2).
	 */
	private startHealthChecks(): void {
		if (this.healthCheckTimer) {
			return
		}

		this.log.debug(
			{ interval: this.config.healthCheckInterval },
			"Starting health checks",
		)

		this.healthCheckTimer = setInterval(() => {
			this.performHealthChecks()
		}, this.config.healthCheckInterval)
	}

	/**
	 * Stops periodic health checks.
	 */
	private stopHealthChecks(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer)
			this.healthCheckTimer = null
			this.log.debug("Stopped health checks")
		}
	}

	/**
	 * Performs health checks on all running decoders.
	 * Transitions to idle state if no output received within timeout (Requirement 20.2).
	 * Transitions back to running state if output is received (Requirement 20.1).
	 * Wrapped in try-catch for failure isolation (Requirement 10.1).
	 */
	private performHealthChecks(): void {
		const now = Date.now()

		for (const [id, state] of this.decoders) {
			try {
				const { decoder, lastOutputAt, lastHealth } = state
				const status = decoder.getStatus()

				// A crash-loop retry that stayed up for stableRunMs is stable again.
				if (
					status.running &&
					lastHealth === "faulted" &&
					this.inCrashLoop(state) &&
					status.uptime * 1000 >= this.config.stableRunMs
				) {
					state.consecutiveFailures = 0
					state.currentDelay = this.config.restartDelay
					this.log.info(
						{ decoderId: id, uptime: status.uptime },
						"Decoder run is stable again, clearing crash-loop fault",
					)
					this.updateDecoderHealth(state, "running")
					this.emitStatusChanged(state)
					continue
				}

				// Skip if not running or already faulted
				if (!status.running || lastHealth === "faulted") {
					continue
				}

				// Check if decoder has produced output recently
				if (lastOutputAt) {
					const timeSinceOutput = now - lastOutputAt.getTime()

					if (timeSinceOutput > this.config.idleTimeout) {
						// No output for too long - transition to idle (Requirement 20.2)
						if (lastHealth !== "idle") {
							this.log.info(
								{
									decoderId: id,
									timeSinceOutput,
									timeout: this.config.idleTimeout,
								},
								"Decoder has not produced output, marking as idle (no signals detected)",
							)
							this.updateDecoderHealth(state, "idle")
						}
					} else if (lastHealth === "idle") {
						// Output received recently - transition back to running (Requirement 20.1)
						this.log.info(
							{ decoderId: id },
							"Decoder producing output again, marking as running",
						)
						this.updateDecoderHealth(state, "running")
					}
				} else {
					// No output ever received - check if decoder has been running long enough
					const uptime = status.uptime * 1000 // Convert to ms
					if (uptime > this.config.idleTimeout && lastHealth !== "idle") {
						this.log.info(
							{
								decoderId: id,
								uptime: status.uptime,
								timeout: this.config.idleTimeout,
							},
							"Decoder has never produced output, marking as idle (no signals detected)",
						)
						this.updateDecoderHealth(state, "idle")
					}
				}
			} catch (err) {
				// Log error but continue checking other decoders (Requirement 10.1)
				this.log.error(
					{ err: safeErrorFields(err), decoderId: id },
					"Error during health check for decoder, continuing with other decoders",
				)
			}
		}
	}

	/** Consecutive unstable runs reached the crash-loop threshold. */
	private inCrashLoop(state: DecoderState): boolean {
		return state.consecutiveFailures >= this.config.faultAfterFailures
	}

	private cancelScheduledRestart(state: DecoderState): void {
		if (state.restartTimer) {
			clearTimeout(state.restartTimer)
			state.restartTimer = null
		}
		state.nextRestartAt = null
	}

	/**
	 * Signals that a decoder's status settled after cleanup. Listener failures
	 * are isolated so they never interrupt stop or restart handling.
	 */
	private emitStatusChanged(state: DecoderState): void {
		try {
			this.emit("decoder:status-changed", state.decoder.id)
		} catch (err) {
			this.log.error(
				{ err: safeErrorFields(err), decoderId: state.decoder.id },
				"Error handling decoder status-changed event, continuing operation",
			)
		}
	}

	/**
	 * Updates the health state of a decoder and emits an event if changed (Requirement 20.4).
	 *
	 * @param state - The decoder state to update
	 * @param health - The new health state
	 */
	private updateDecoderHealth(
		state: DecoderState,
		health: DecoderHealth,
	): void {
		if (state.lastHealth !== health) {
			const previousHealth = state.lastHealth
			state.lastHealth = health

			this.log.info(
				{
					decoderId: state.decoder.id,
					previousHealth,
					newHealth: health,
				},
				"Decoder health changed",
			)

			// Emit health event (Requirement 20.4)
			this.emit("decoder:health", state.decoder.id, health)
		}
	}
}
