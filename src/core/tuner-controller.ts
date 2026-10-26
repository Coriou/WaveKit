/**
 * Tuner Controller - Primary RTL-TCP tuner control interface.
 *
 * Provides direct tuning control for rtl_tcp/rtlmux sources and supports
 * releasing control to external tuner clients (e.g., SDR++ via TunerRelay).
 */

import type { RatePolicy } from "./rate-policy-contract.js"
import { safeErrorFields } from "../decoders/safe-error-fields.js"
import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import type {
	SourceCaps,
	SourceConfig,
	SourceManager,
} from "./source-manager.js"
import type { SourceTunerConfig } from "../config.js"
import { configuredTuningFrames } from "./tuner-config-gain.js"
import type {
	TunerState,
	TunerStateField,
	TunerGainMode,
	TunerDirectSampling,
	TunerControlMode,
	TunerCommandOrigin,
	TunerRatePolicyEventData,
} from "@wavekit/api-types"

/**
 * Optional last argument of every write. `origin` is reported on
 * "command-sent" (signal discovery spec § 10.3). `accept: false` writes the
 * command and updates state and caps, marks the field known (inferred) and
 * records no desired field; a field accepted earlier is still replayed with
 * its current value. Test mode is never a desired field, so it is never replayed.
 */
export interface TunerWriteOptions {
	origin?: TunerCommandOrigin
	accept?: boolean
}

/**
 * Sample rates the RTL2832U accepts. librtlsdr's rtlsdr_set_sample_rate()
 * rejects 300 001-900 000 Hz, so the overall 225 001-3 200 000 bound is not
 * enough: a gap rate would be recorded in caps and replayed on reconnect
 * while the dongle keeps its previous rate.
 */
export const RTL_SAMPLE_RATE_RANGES = [
	{ min: 225_001, max: 300_000 },
	{ min: 900_001, max: 3_200_000 },
] as const

/** True when librtlsdr can set `hz` (an integer in one of the RTL ranges). */
export function isValidRtlSampleRate(hz: number): boolean {
	return (
		Number.isInteger(hz) &&
		RTL_SAMPLE_RATE_RANGES.some(range => hz >= range.min && hz <= range.max)
	)
}

// Validation constants
const VALIDATION = {
	frequency: { min: 24_000_000, max: 1_900_000_000 },
	/** Outer bound only; see RTL_SAMPLE_RATE_RANGES for the gap. */
	sampleRate: { min: 225_001, max: 3_200_000 },
	gain: { min: 0, max: 500 },
	ppm: { min: -500, max: 500 },
	uint32: { min: 0, max: 0xffffffff },
	uint16: { min: 0, max: 0xffff },
} as const

const DEFAULT_FREQUENCY = 100_000_000
const DEFAULT_SAMPLE_RATE = 2_400_000

// RTL-TCP commands (mirrored from tuner-relay.ts for consistency)
const RTL_TCP_COMMANDS = {
	SET_FREQUENCY: 0x01,
	SET_SAMPLE_RATE: 0x02,
	SET_GAIN_MODE: 0x03,
	SET_GAIN: 0x04,
	SET_FREQ_CORRECTION: 0x05,
	SET_IF_GAIN: 0x06,
	SET_TEST_MODE: 0x07,
	SET_AGC_MODE: 0x08,
	SET_DIRECT_SAMPLING: 0x09,
	SET_OFFSET_TUNING: 0x0a,
	SET_RTL_XTAL: 0x0b,
	SET_TUNER_XTAL: 0x0c,
	SET_TUNER_GAIN_INDEX: 0x0d,
	SET_BIAS_TEE: 0x0e,
	SET_TUNER_IF_GAIN: 0x0f,
} as const

function freezeRestPolicy<T extends readonly object[]>(rows: T): T {
	for (const row of rows) Object.freeze(row)
	Object.freeze(rows)
	return rows
}

/** The admitted REST argument policy, independent of receiver qualification. */
export const TUNER_REST_COMMAND_POLICY = freezeRestPolicy([
	{
		id: "frequency",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_FREQUENCY,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.frequency }),
	},
	{
		id: "sampleRate",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_SAMPLE_RATE,
		rule: Object.freeze({
			kind: "integer-ranges",
			ranges: Object.freeze([
				Object.freeze({ ...RTL_SAMPLE_RATE_RANGES[0] }),
				Object.freeze({ ...RTL_SAMPLE_RATE_RANGES[1] }),
			] as const),
		}),
	},
	{
		id: "gainMode",
		unit: "enum",
		opcode: RTL_TCP_COMMANDS.SET_GAIN_MODE,
		rule: Object.freeze({
			kind: "enum",
			values: Object.freeze(["manual", "agc"]),
		}),
	},
	{
		id: "gain",
		unit: "tenthsDb",
		opcode: RTL_TCP_COMMANDS.SET_GAIN,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.gain }),
	},
	{
		id: "ppm",
		unit: "ppm",
		opcode: RTL_TCP_COMMANDS.SET_FREQ_CORRECTION,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.ppm }),
	},
	{
		id: "ifGain",
		unit: "rawInteger",
		opcode: RTL_TCP_COMMANDS.SET_IF_GAIN,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "testMode",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_TEST_MODE,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "agcMode",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_AGC_MODE,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "directSampling",
		unit: "enum",
		opcode: RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING,
		rule: Object.freeze({
			kind: "enum",
			values: Object.freeze(["off", "i", "q"]),
		}),
	},
	{
		id: "offsetTuning",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_OFFSET_TUNING,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "rtlXtal",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_RTL_XTAL,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "tunerXtal",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_TUNER_XTAL,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "gainIndex",
		unit: "index",
		opcode: RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "biasTee",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_BIAS_TEE,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "tunerIfGain",
		unit: "stageRawPair",
		opcode: RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN,
		rule: Object.freeze({ kind: "uint16-pair" }),
	},
] as const)

// Command names for logging (matches tuner-relay.ts)
const COMMAND_NAMES: Record<number, string> = {
	0x01: "set-frequency",
	0x02: "set-sample-rate",
	0x03: "set-gain-mode",
	0x04: "set-gain",
	0x05: "set-freq-correction",
	0x06: "set-if-gain",
	0x07: "set-test-mode",
	0x08: "set-agc-mode",
	0x09: "set-direct-sampling",
	0x0a: "set-offset-tuning",
	0x0b: "set-rtl-xtal",
	0x0c: "set-tuner-xtal",
	0x0d: "set-tuner-gain-index",
	0x0e: "set-bias-tee",
	0x0f: "set-tuner-if-gain",
}

/** Tuner fields that can hold an accepted (commanded) desired value. */
type DesiredField =
	| "frequency"
	| "sampleRate"
	| "gainMode"
	| "gain"
	| "ppm"
	| "ifGain"
	| "agcMode"
	| "directSampling"
	| "offsetTuning"
	| "rtlXtal"
	| "tunerXtal"
	| "tunerGainIndex"
	| "biasTee"
	| "tunerIfGain"

const COMMAND_FIELDS: Record<number, DesiredField> = {
	[RTL_TCP_COMMANDS.SET_FREQUENCY]: "frequency",
	[RTL_TCP_COMMANDS.SET_SAMPLE_RATE]: "sampleRate",
	[RTL_TCP_COMMANDS.SET_GAIN_MODE]: "gainMode",
	[RTL_TCP_COMMANDS.SET_GAIN]: "gain",
	[RTL_TCP_COMMANDS.SET_FREQ_CORRECTION]: "ppm",
	[RTL_TCP_COMMANDS.SET_IF_GAIN]: "ifGain",
	[RTL_TCP_COMMANDS.SET_AGC_MODE]: "agcMode",
	[RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING]: "directSampling",
	[RTL_TCP_COMMANDS.SET_OFFSET_TUNING]: "offsetTuning",
	[RTL_TCP_COMMANDS.SET_RTL_XTAL]: "rtlXtal",
	[RTL_TCP_COMMANDS.SET_TUNER_XTAL]: "tunerXtal",
	[RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX]: "tunerGainIndex",
	[RTL_TCP_COMMANDS.SET_BIAS_TEE]: "biasTee",
	[RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN]: "tunerIfGain",
}

/** Relay commands from which applyExternalCommand infers manual gain mode. */
const MANUAL_GAIN_COMMANDS: ReadonlySet<number> = new Set([
	RTL_TCP_COMMANDS.SET_GAIN,
	RTL_TCP_COMMANDS.SET_IF_GAIN,
	RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX,
	RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN,
])

/** Placeholder-capable fields, in TunerState order, for `unknownFields`. */
const STATE_FIELDS: readonly TunerStateField[] = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"ppm",
	"agcMode",
	"biasTee",
	"directSampling",
	"offsetTuning",
	"ifGain",
	"tunerIfGain",
	"testMode",
]

/**
 * Reconnect replay order (librtlsdr semantics): sampling path, xtals and PPM
 * first, rate before center, then front-end toggles, then the gain group in
 * acceptance order.
 */
const REPLAY_PHASES: ReadonlyArray<{
	fields: readonly DesiredField[]
	byAcceptance: boolean
}> = [
	{
		fields: ["directSampling", "offsetTuning", "rtlXtal", "tunerXtal", "ppm"],
		byAcceptance: false,
	},
	{ fields: ["sampleRate", "frequency"], byAcceptance: false },
	{ fields: ["biasTee", "agcMode"], byAcceptance: false },
	{
		fields: ["gainMode", "gain", "tunerGainIndex", "ifGain", "tunerIfGain"],
		byAcceptance: true,
	},
]

/**
 * What happens to accepted tuner state when an rtl_tcp source reconnects:
 * "restore" re-sends it, "reset" discards it and falls back to the configured
 * baseline without writing anything to the receiver.
 */
export type TunerReconnectPolicy = "restore" | "reset"

/** Outcome of synchronizing a source after it (re)connects. */
export interface TunerConnectSyncResult {
	policy: TunerReconnectPolicy
	/** Command names written upstream, in wire order (no hardware acknowledgement). */
	commands: string[]
	/** True when accepted state was discarded under the "reset" policy. */
	reset: boolean
	/** Write failure that stopped the replay; the next connection replays again. */
	error?: string
}

export interface TunerControllerEvents {
	"rate-policy": (event: TunerRatePolicyEventData) => void
	"state-changed": (sourceId: string, state: TunerState) => void
	"command-sent": (
		sourceId: string,
		command: string,
		value: number,
		origin?: TunerCommandOrigin,
	) => void
	"control-mode-changed": (sourceId: string, mode: TunerControlMode) => void
	/** WG5: the source's tuner state is gone (removeSource); getState now returns undefined. */
	"source-removed": (sourceId: string) => void
	error: (sourceId: string, error: Error) => void
}

export interface TunerControllerConfig {
	defaultFrequency?: number
	defaultSampleRate?: number
	/** Reconnect behaviour for accepted tuner state (default "restore"). */
	reconnectPolicy?: TunerReconnectPolicy
}

type ControlModeOrigin = "user" | "relay"

export class TunerControllerError extends Error {
	public readonly statusCode: number
	public readonly code: string

	constructor(message: string, code: string, statusCode: number) {
		super(message)
		this.name = "TunerControllerError"
		this.code = code
		this.statusCode = statusCode
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor)
		}
	}
}

export class TunerSourceNotFoundError extends TunerControllerError {
	constructor(sourceId: string) {
		super(`Tuner source not found: ${sourceId}`, "TUNER_SOURCE_NOT_FOUND", 404)
		this.name = "TunerSourceNotFoundError"
	}
}

export class TunerControlModeError extends TunerControllerError {
	constructor(sourceId: string) {
		super(
			`Cannot send commands: control released to external tuner for ${sourceId}`,
			"TUNER_CONTROL_EXTERNAL",
			409,
		)
		this.name = "TunerControlModeError"
	}
}

export class TunerValidationError extends TunerControllerError {
	constructor(message: string) {
		super(message, "TUNER_VALIDATION_ERROR", 400)
		this.name = "TunerValidationError"
	}
}

/** The reported TunerState field a command writes, if it has one (rtlXtal, tunerXtal and tunerGainIndex do not). */
function stateFieldOf(cmd: number): TunerStateField | undefined {
	if (cmd === RTL_TCP_COMMANDS.SET_TEST_MODE) return "testMode"
	const field = COMMAND_FIELDS[cmd]
	return STATE_FIELDS.find(known => known === field)
}

export class TunerController extends EventEmitter {
	private withoutCommand<T>(work: () => T): T {
		// Small transport fakes need only implement the write boundary.
		return this.sourceManager?.withoutTunerCommand
			? this.sourceManager.withoutTunerCommand(work)
			: work()
	}

	override emit(event: string | symbol, ...args: unknown[]): boolean {
		return this.withoutCommand(() => super.emit(event, ...args))
	}

	private beforeOperatorRetune: RatePolicy["beforeOperatorRetune"] | null = null
	private onOperatorSampleRate: RatePolicy["onOperatorSampleRate"] | null = null
	private onRelayRetune: RatePolicy["onRelayRetune"] | null = null
	private ratePolicyRecordFor: RatePolicy["recordFor"] | null = null

	setBeforeOperatorRetune(
		hook: RatePolicy["beforeOperatorRetune"] | null,
	): void {
		this.beforeOperatorRetune = hook
	}

	hasBeforeOperatorRetune(): boolean {
		return this.beforeOperatorRetune !== null
	}

	setOnOperatorSampleRate(
		hook: RatePolicy["onOperatorSampleRate"] | null,
	): void {
		this.onOperatorSampleRate = hook
	}

	setOnRelayRetune(hook: RatePolicy["onRelayRetune"] | null): void {
		this.onRelayRetune = hook
	}

	setRatePolicyRecordFor(hook: RatePolicy["recordFor"] | null): void {
		this.ratePolicyRecordFor = hook
	}

	emitRatePolicy(event: TunerRatePolicyEventData): void {
		this.emit("rate-policy", event)
	}

	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly config: TunerControllerConfig
	private tunerStates: Map<string, TunerState> = new Map()
	private controlModeOrigins: Map<string, ControlModeOrigin> = new Map()
	/** Accepted desired fields per source, keyed to their acceptance sequence. */
	private desiredFields: Map<string, Map<DesiredField, number>> = new Map()
	/** Fields inferred from observed relay commands (known, never replayed). */
	private inferredFields: Map<string, Set<TunerStateField>> = new Map()
	/**
	 * WG5: frequency/sampleRate a relay client set to a value the controller ignored
	 * (the relay forwards raw bytes upstream before validation, so the receiver may be
	 * there). Unknown until the next accepted or written value.
	 */
	private ignoredRelayFields: Map<string, Set<TunerStateField>> = new Map()
	private acceptanceSeq = 0
	/**
	 * WG9 req 3.2: frequency/sampleRate written on the current connection, by this core
	 * (an API write or a reconnect replay) or by an accepted relay command. Cleared when a
	 * new connection is synchronised, so a value proven on an earlier connection and not
	 * re-sent on this one never backs a `commanded` or `relay` label.
	 */
	private connectionTuningWrites: Map<string, Set<TunerStateField>> = new Map()
	/**
	 * WG10 req 2.8: sources whose held sample rate an operator frequency write already
	 * proved on the current connection. Reset with `connectionTuningWrites`.
	 */
	private rateProvedOnConnection: Set<string> = new Set()
	/** In-flight proof write per source, tagged with the connection epoch it serves. */
	private rateProofInFlight: Map<
		string,
		{ epoch: number; promise: Promise<boolean> }
	> = new Map()
	/** Per-source connection epoch, advanced where the proof flag resets. */
	private rateProofEpoch: Map<string, number> = new Map()
	/** Caps metadata as first registered, before any accepted command. */
	private baselineCaps: Map<string, SourceCaps | undefined> = new Map()
	/**
	 * WG11 req 4.1, 4.2: configured gain/AGC per source (`sources[].tuner`), with its
	 * frames in write order. The source's baseline for gainMode, gain and agcMode.
	 */
	private configuredTuning: Map<
		string,
		{
			tuner: SourceTunerConfig
			frames: ReadonlyArray<readonly [number, number]>
		}
	> = new Map()
	/**
	 * WG11 req 4.2: sources whose current connection has not had its configured
	 * frames considered yet. Set on `connected`, consumed by the next
	 * synchronizeOnConnect, so a repeated payload-started writes them once.
	 */
	private configWriteDue: Set<string> = new Set()
	/**
	 * WG11 req 4.5: gain fields whose configured value was written (every frame of
	 * the set succeeded) on the current connection. Known while it lasts.
	 */
	private configProvenFields: Map<string, Set<TunerStateField>> = new Map()

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		config: TunerControllerConfig = {},
	) {
		super()
		this.log = createComponentLogger(logger, "TunerController")
		this.sourceManager = sourceManager
		this.config = config
	}

	// === Lifecycle ===

	initializeSource(
		sourceId: string,
		caps?: SourceCaps,
		sourceType?: SourceConfig["type"],
	): void {
		if (this.tunerStates.has(sourceId)) {
			this.log.debug({ sourceId }, "Tuner source already initialized")
			return
		}

		const isRtlTcp =
			sourceType !== undefined
				? sourceType === "rtl_tcp"
				: this.sourceManager.isRtlTcpSource(sourceId)

		if (!isRtlTcp) {
			this.log.debug({ sourceId }, "Skipping tuner init for non-RTL-TCP source")
			return
		}

		// Default state: sensible defaults for immediate use
		const state: TunerState = {
			sourceId,
			frequency: DEFAULT_FREQUENCY,
			sampleRate: DEFAULT_SAMPLE_RATE,
			gainMode: "agc",
			gain: 0,
			ppm: 0,
			agcMode: true,
			biasTee: false,
			directSampling: "off",
			offsetTuning: false,
			ifGain: 0,
			tunerIfGain: null,
			testMode: false,
			controlMode: "internal",
			commandCount: 0,
		}
		this.applyBaselineFields(state, caps)

		this.baselineCaps.set(sourceId, caps ? { ...caps } : undefined)
		this.tunerStates.set(sourceId, state)
		this.controlModeOrigins.set(sourceId, "user")
		this.log.info({ sourceId }, "Tuner source initialized")
		this.emitStateChanged(sourceId)
	}

	removeSource(sourceId: string): void {
		// WG11: configured tuning belongs to the removed source's config; a source
		// re-added under the same id brings its own (resolved on `connected`).
		this.configuredTuning.delete(sourceId)
		this.configWriteDue.delete(sourceId)
		this.configProvenFields.delete(sourceId)
		if (!this.tunerStates.has(sourceId)) return
		this.tunerStates.delete(sourceId)
		this.controlModeOrigins.delete(sourceId)
		this.desiredFields.delete(sourceId)
		this.inferredFields.delete(sourceId)
		this.ignoredRelayFields.delete(sourceId)
		this.connectionTuningWrites.delete(sourceId)
		this.rateProvedOnConnection.delete(sourceId)
		this.rateProofInFlight.delete(sourceId)
		this.rateProofEpoch.set(
			sourceId,
			(this.rateProofEpoch.get(sourceId) ?? 0) + 1,
		)
		this.baselineCaps.delete(sourceId)
		this.configWriteDue.delete(sourceId)
		this.configProvenFields.delete(sourceId)
		this.log.info({ sourceId }, "Tuner source removed")
		this.emit("source-removed", sourceId)
	}

	// === Configured gain and AGC (WG11 req 4) ===

	/**
	 * Stores the configured gain/AGC of a source (undefined clears it). The values
	 * become the source's baseline: gain fields not accepted or observed in this
	 * process take them now (still unknown until written), the `reset` policy
	 * returns to them, and each new connection writes them (synchronizeOnConnect).
	 * Writes nothing itself.
	 */
	setConfiguredTuning(
		sourceId: string,
		tuner: SourceTunerConfig | undefined,
	): void {
		if (tuner === undefined) this.configuredTuning.delete(sourceId)
		else
			this.configuredTuning.set(sourceId, {
				tuner: { ...tuner },
				frames: configuredTuningFrames(tuner),
			})
		// A changed configuration is not what was written on this connection.
		this.configProvenFields.delete(sourceId)
		const state = this.tunerStates.get(sourceId)
		if (!state) return
		const baseline = this.gainBaseline(sourceId)
		const held = (field: TunerStateField) =>
			this.isOperatorHeld(sourceId, field)
		if (!held("gainMode")) state.gainMode = baseline.gainMode
		if (!held("gain")) state.gain = baseline.gain
		if (!held("agcMode")) state.agcMode = baseline.agcMode
		this.emitStateChanged(sourceId)
	}

	/**
	 * Applies the source's current configured tuning (from its live config, so a
	 * source added or replaced at runtime is followed) only when it differs from
	 * the stored one, so an unchanged config does not churn state or proof.
	 */
	syncConfiguredTuning(
		sourceId: string,
		tuner: SourceTunerConfig | undefined,
	): void {
		const current = this.configuredTuning.get(sourceId)?.tuner
		const key = (t: SourceTunerConfig | undefined) =>
			t === undefined ? "" : JSON.stringify([t.gainMode, t.gainDb, t.agcMode])
		if (key(current) === key(tuner)) return
		this.setConfiguredTuning(sourceId, tuner)
	}

	/**
	 * A new connection of the source opened (wired to SourceManager `connected`):
	 * its first synchronizeOnConnect writes the configured frames. Writes nothing.
	 */
	noteSourceConnected(sourceId: string): void {
		this.configWriteDue.add(sourceId)
		// Proof is per connection: nothing is written on the new one yet.
		if (this.configProvenFields.delete(sourceId))
			this.emitStateChanged(sourceId)
	}

	// === Control Mode ===

	setControlMode(
		sourceId: string,
		mode: TunerControlMode,
		origin: ControlModeOrigin = "user",
	): void {
		const state = this.validateSource(sourceId)
		if (state.controlMode === mode) {
			this.controlModeOrigins.set(sourceId, origin)
			return
		}

		state.controlMode = mode
		if (mode === "internal" && this.onRelayRetune) {
			try {
				this.withoutCommand(() =>
					this.onRelayRetune?.(sourceId, state.frequency),
				)
			} catch (err) {
				this.log.warn(
					{ sourceId, err: safeErrorFields(err) },
					"Relay rate policy hook failed",
				)
			}
		}
		this.controlModeOrigins.set(sourceId, origin)
		this.log.info({ sourceId, mode }, "Control mode changed")
		this.emit("control-mode-changed", sourceId, mode)
		this.emitStateChanged(sourceId)
	}

	/**
	 * Synchronize control mode with external relay activity.
	 *
	 * - When external control is active, switch to "external" if currently internal.
	 * - When external control ends, return to "internal" only if relay set the mode.
	 */
	syncExternalControl(sourceId: string, active: boolean): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) {
			this.log.warn({ sourceId }, "Relay control ignored (tuner not found)")
			return
		}

		const origin = this.controlModeOrigins.get(sourceId)
		if (active) {
			if (state.controlMode !== "external") {
				this.setControlMode(sourceId, "external", "relay")
			}
			return
		}

		if (state.controlMode === "external" && origin === "relay") {
			this.setControlMode(sourceId, "internal", "relay")
		}
	}

	/**
	 * Apply an external RTL-TCP command to local tuner state without forwarding.
	 */
	applyExternalCommand(sourceId: string, command: number, value: number): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) {
			this.log.warn({ sourceId, command, value }, "External command ignored")
			return
		}

		if (state.controlMode === "internal") {
			this.setControlMode(sourceId, "external", "relay")
		}

		const cmdName = COMMAND_NAMES[command] ?? `cmd-0x${command.toString(16)}`
		const now = new Date().toISOString()
		let updated = false

		switch (command) {
			case RTL_TCP_COMMANDS.SET_FREQUENCY:
				if (this.isWithinRange(value, VALIDATION.frequency)) {
					state.frequency = value
					this.sourceManager.updateSourceCaps(sourceId, { centerFreq: value })
					updated = true
				} else {
					this.markIgnoredRelayField(sourceId, "frequency")
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range frequency from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_SAMPLE_RATE:
				if (isValidRtlSampleRate(value)) {
					state.sampleRate = value
					updated = true
					try {
						this.sourceManager.updateSourceCaps(sourceId, {
							sampleRate: value,
						})
					} catch (err) {
						this.log.warn(
							{ sourceId, err },
							"Failed to update sample rate from relay",
						)
					}
				} else {
					this.markIgnoredRelayField(sourceId, "sampleRate")
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range sample rate from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_GAIN_MODE:
				if (value === 0 || value === 1) {
					state.gainMode = value === 1 ? "manual" : "agc"
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring unknown gain mode from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_GAIN:
				if (this.isWithinRange(value, VALIDATION.gain)) {
					state.gain = value
					state.gainMode = "manual"
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range gain from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_FREQ_CORRECTION: {
				const ppm = this.decodeSignedInt32(value)
				if (this.isWithinRange(ppm, VALIDATION.ppm)) {
					state.ppm = ppm
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value: ppm },
						"Ignoring out-of-range PPM from relay",
					)
				}
				break
			}
			case RTL_TCP_COMMANDS.SET_IF_GAIN:
				if (this.isWithinRange(value, VALIDATION.uint32)) {
					state.ifGain = value
					state.gainMode = "manual"
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range IF gain from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_TEST_MODE:
				state.testMode = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_AGC_MODE:
				state.agcMode = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING: {
				// librtlsdr rtlsdr_set_direct_sampling: 0 off, 1 the I branch, any value
				// above 1 the Q branch.
				const nextMode: TunerDirectSampling | null =
					value === 0
						? "off"
						: value === 1
							? "i"
							: value >= 2 && value <= 0xffffffff
								? "q"
								: null
				if (nextMode) {
					state.directSampling = nextMode
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring unknown direct sampling mode from relay",
					)
				}
				break
			}
			case RTL_TCP_COMMANDS.SET_OFFSET_TUNING:
				state.offsetTuning = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_RTL_XTAL:
				if (this.isWithinRange(value, VALIDATION.uint32)) {
					state.rtlXtal = value
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range RTL XTAL from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_TUNER_XTAL:
				if (this.isWithinRange(value, VALIDATION.uint32)) {
					state.tunerXtal = value
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range tuner XTAL from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX:
				if (this.isWithinRange(value, VALIDATION.uint16)) {
					state.tunerGainIndex = value
					state.gainMode = "manual"
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range tuner gain index from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_BIAS_TEE:
				state.biasTee = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN: {
				const stage = (value >>> 16) & 0xffff
				const gain = value & 0xffff
				if (
					this.isWithinRange(stage, VALIDATION.uint16) &&
					this.isWithinRange(gain, VALIDATION.uint16)
				) {
					state.tunerIfGain = { stage, gain }
					state.gainMode = "manual"
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range tuner IF gain from relay",
					)
				}
				break
			}
			default:
				this.log.debug(
					{ sourceId, command: cmdName, value },
					"Unhandled relay command",
				)
				break
		}

		state.commandCount += 1
		state.lastCommandAt = now

		if (updated) {
			try {
				if (command === RTL_TCP_COMMANDS.SET_FREQUENCY)
					this.withoutCommand(() => this.onRelayRetune?.(sourceId, value))
				if (command === RTL_TCP_COMMANDS.SET_SAMPLE_RATE)
					this.withoutCommand(() => this.onOperatorSampleRate?.(sourceId))
			} catch (err) {
				this.log.warn(
					{ sourceId, err: safeErrorFields(err) },
					"Relay rate policy hook failed",
				)
			}
			if (command === RTL_TCP_COMMANDS.SET_TEST_MODE) {
				this.markWrittenNotAccepted(sourceId, command)
			} else {
				this.markAccepted(sourceId, command)
				this.markConnectionWrite(sourceId, command)
			}
			// Gain commands imply manual mode on the relay path (state above).
			if (
				command !== RTL_TCP_COMMANDS.SET_GAIN_MODE &&
				state.gainMode === "manual" &&
				MANUAL_GAIN_COMMANDS.has(command)
			)
				this.markInferred(sourceId, "gainMode")
			delete state.lastError
			this.log.debug(
				{ sourceId, command: cmdName, value },
				"Applied relay command update",
			)
		}

		this.emitStateChanged(sourceId)
	}

	// === Tuning Commands (only when controlMode === "internal") ===

	async setFrequency(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("frequency", hz, VALIDATION.frequency)
		if (opts.origin === "rest" && this.beforeOperatorRetune) {
			// Awaited hook work belongs to this command, including its continuations.
			await this.beforeOperatorRetune(sourceId, hz, opts)
			await this.proveSampleRateForFrequency(sourceId, opts, hz)
		}
		await this.writeFrequency(sourceId, hz, opts, state)
	}

	private async writeFrequency(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions,
		state: TunerState,
	): Promise<void> {
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_FREQUENCY, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		state.frequency = hz
		this.sourceManager.updateSourceCaps(sourceId, { centerFreq: hz })
		this.emitStateChanged(sourceId)
	}

	/**
	 * WG10 req 2.8: before an operator frequency write, writes the sample rate the core
	 * already holds (value unchanged, origin from `opts`, normally `rest`), so the trust
	 * label can become `commanded`. Writes only in internal control, when the held rate is
	 * known (not unknown/placeholder, not an ignored relay value, a valid RTL rate) and
	 * unproven on this connection (declared only, or not written on it), and at most once
	 * per connection epoch. Returns true when it wrote. A failed write throws the tuner
	 * error of `setSampleRate` (the caller then writes no frequency) and leaves the
	 * epoch unproven. The scanner path never calls this (WG9 hop rule unchanged).
	 * `frequencyHz`, when given, is the frequency about to be written: outside the
	 * frequency range nothing is written (the frequency write then fails as today).
	 */
	async proveSampleRateForFrequency(
		sourceId: string,
		opts: TunerWriteOptions = {},
		frequencyHz?: number,
	): Promise<boolean> {
		this.sourceManager.assertTunerCommandActive()
		const state = this.tunerStates.get(sourceId)
		if (!state || state.controlMode !== "internal") return false
		if (
			frequencyHz !== undefined &&
			!(
				Number.isInteger(frequencyHz) &&
				frequencyHz >= VALIDATION.frequency.min &&
				frequencyHz <= VALIDATION.frequency.max
			)
		)
			return false
		if (this.rateProvedOnConnection.has(sourceId)) return false
		const proof = this.fieldProof(sourceId)
		if (proof.unknownFields.includes("sampleRate")) return false
		const hz = state.sampleRate
		if (
			!Number.isInteger(hz) ||
			hz < VALIDATION.sampleRate.min ||
			hz > VALIDATION.sampleRate.max ||
			!isValidRtlSampleRate(hz)
		)
			return false
		const writtenHere =
			this.connectionTuningWrites.get(sourceId)?.has("sampleRate") === true
		if (!proof.declaredOnlyFields.includes("sampleRate") && writtenHere) {
			this.rateProvedOnConnection.add(sourceId)
			return false
		}
		// Concurrent callers on the same connection share one write (and its failure).
		const epoch = this.rateProofEpoch.get(sourceId) ?? 0
		const pending = this.rateProofInFlight.get(sourceId)
		if (pending !== undefined && pending.epoch === epoch) {
			await pending.promise
			return false
		}
		const promise = this.withoutCommand(async () => {
			try {
				await this.setSampleRate(sourceId, hz, opts)
				this.sourceManager.assertTunerCommandActive()
				if ((this.rateProofEpoch.get(sourceId) ?? 0) === epoch)
					this.rateProvedOnConnection.add(sourceId)
				return true
			} finally {
				if (this.rateProofInFlight.get(sourceId)?.epoch === epoch)
					this.rateProofInFlight.delete(sourceId)
			}
		})
		this.rateProofInFlight.set(sourceId, { epoch, promise })
		return promise
	}

	async setSampleRate(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("sampleRate", hz, VALIDATION.sampleRate)
		if (!isValidRtlSampleRate(hz)) {
			throw new TunerValidationError(
				`sampleRate ${hz} is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)`,
			)
		}
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_SAMPLE_RATE, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		state.sampleRate = hz
		if (opts.origin === "rest")
			this.withoutCommand(() => this.onOperatorSampleRate?.(sourceId))
		try {
			this.sourceManager.updateSourceCaps(sourceId, { sampleRate: hz })
		} catch (err) {
			this.log.warn({ sourceId, err }, "Failed to update source caps")
		}
		this.emitStateChanged(sourceId)
	}

	async setGainMode(
		sourceId: string,
		mode: TunerGainMode,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "manual" ? 1 : 0
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_GAIN_MODE,
			value,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.gainMode = mode
		this.emitStateChanged(sourceId)
	}

	async setGain(
		sourceId: string,
		tenthsDb: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("gain", tenthsDb, VALIDATION.gain)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_GAIN, tenthsDb, opts)
		this.sourceManager.assertTunerCommandActive()
		state.gain = tenthsDb
		this.emitStateChanged(sourceId)
	}

	async setPpm(
		sourceId: string,
		ppm: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("ppm", ppm, VALIDATION.ppm)
		const value = this.encodeSignedInt32(ppm)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_FREQ_CORRECTION,
			value,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.ppm = ppm
		this.emitStateChanged(sourceId)
	}

	async setIfGain(
		sourceId: string,
		gain: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("ifGain", gain)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_IF_GAIN, gain, opts)
		this.sourceManager.assertTunerCommandActive()
		state.ifGain = gain
		this.emitStateChanged(sourceId)
	}

	/**
	 * RTL2832 test mode (counter samples). Used by the scanner as a retune
	 * marker; never accepted state, so reconnect replay cannot re-send it
	 * (signal discovery spec § 4.6). The reported state still follows it.
	 */
	async setTestMode(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_TEST_MODE,
			enabled ? 1 : 0,
			{ ...opts, accept: false },
		)
		this.sourceManager.assertTunerCommandActive()
		state.testMode = enabled
		this.emitStateChanged(sourceId)
	}

	async setAgcMode(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_AGC_MODE,
			enabled ? 1 : 0,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.agcMode = enabled
		this.emitStateChanged(sourceId)
	}

	async setDirectSampling(
		sourceId: string,
		mode: TunerDirectSampling,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "off" ? 0 : mode === "i" ? 1 : 2
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING,
			value,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.directSampling = mode
		this.emitStateChanged(sourceId)
	}

	async setOffsetTuning(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_OFFSET_TUNING,
			enabled ? 1 : 0,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.offsetTuning = enabled
		this.emitStateChanged(sourceId)
	}

	async setRtlXtal(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("rtlXtal", hz)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_RTL_XTAL, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		state.rtlXtal = hz
		this.emitStateChanged(sourceId)
	}

	async setTunerXtal(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("tunerXtal", hz)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_TUNER_XTAL, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		state.tunerXtal = hz
		this.emitStateChanged(sourceId)
	}

	async setTunerGainIndex(
		sourceId: string,
		index: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("tunerGainIndex", index)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX,
			index,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.tunerGainIndex = index
		this.emitStateChanged(sourceId)
	}

	async setBiasTee(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_BIAS_TEE,
			enabled ? 1 : 0,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.biasTee = enabled
		this.emitStateChanged(sourceId)
	}

	async setTunerIfGain(
		sourceId: string,
		stage: number,
		gain: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint16("tunerIfGain.stage", stage)
		this.validateUint16("tunerIfGain.gain", gain)
		const value = (stage << 16) | (gain & 0xffff)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN,
			value,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.tunerIfGain = { stage, gain }
		this.emitStateChanged(sourceId)
	}

	// === Bulk Update ===

	async configure(
		sourceId: string,
		updates: Partial<TunerState>,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSource(sourceId)
		const hasCommandUpdates = this.hasCommandUpdates(updates)

		if (hasCommandUpdates && state.controlMode === "external") {
			if (updates.controlMode !== "internal") {
				throw new TunerControlModeError(sourceId)
			}
		}

		// WG10 R1 m2: every field is validated before anything is written (the rate proof
		// below included), so an invalid field writes nothing and changes no mode.
		this.validateUpdates(updates)

		if (updates.controlMode === "internal") {
			this.sourceManager.assertTunerCommandActive()
			this.setControlMode(sourceId, "internal")
		}

		const policyBulk =
			opts.origin === "rest" && this.beforeOperatorRetune !== null
		if (updates.frequency !== undefined && updates.sampleRate === undefined) {
			if (policyBulk) {
				await this.beforeOperatorRetune?.(sourceId, updates.frequency, opts)
				this.sourceManager.assertTunerCommandActive()
				this.emitStateChanged(sourceId)
			}
			await this.proveSampleRateForFrequency(sourceId, opts, updates.frequency)
		}

		const proof = this.fieldProof(sourceId)
		const unproven = new Set<TunerStateField>([
			...proof.declaredOnlyFields,
			...proof.unknownFields,
		])
		if (
			updates.frequency !== undefined &&
			(updates.frequency !== state.frequency || unproven.has("frequency"))
		) {
			if (policyBulk)
				await this.writeFrequency(sourceId, updates.frequency, opts, state)
			else await this.setFrequency(sourceId, updates.frequency, opts)
		}
		if (
			updates.sampleRate !== undefined &&
			(updates.sampleRate !== state.sampleRate || unproven.has("sampleRate"))
		) {
			await this.setSampleRate(sourceId, updates.sampleRate, opts)
		} else if (
			updates.sampleRate !== undefined &&
			opts.origin === "rest" &&
			this.onOperatorSampleRate
		) {
			this.sourceManager.assertTunerCommandActive()
			this.withoutCommand(() => this.onOperatorSampleRate?.(sourceId))
			this.emitStateChanged(sourceId)
		}
		if (updates.gainMode !== undefined && updates.gainMode !== state.gainMode) {
			await this.setGainMode(sourceId, updates.gainMode, opts)
		}
		if (updates.gain !== undefined && updates.gain !== state.gain) {
			await this.setGain(sourceId, updates.gain, opts)
		}
		if (updates.ppm !== undefined && updates.ppm !== state.ppm) {
			await this.setPpm(sourceId, updates.ppm, opts)
		}
		if (updates.ifGain !== undefined && updates.ifGain !== state.ifGain) {
			await this.setIfGain(sourceId, updates.ifGain, opts)
		}
		if (updates.testMode !== undefined && updates.testMode !== state.testMode) {
			await this.setTestMode(sourceId, updates.testMode, opts)
		}
		if (updates.agcMode !== undefined && updates.agcMode !== state.agcMode) {
			await this.setAgcMode(sourceId, updates.agcMode, opts)
		}
		if (updates.biasTee !== undefined && updates.biasTee !== state.biasTee) {
			await this.setBiasTee(sourceId, updates.biasTee, opts)
		}
		if (
			updates.directSampling !== undefined &&
			updates.directSampling !== state.directSampling
		) {
			await this.setDirectSampling(sourceId, updates.directSampling, opts)
		}
		if (
			updates.offsetTuning !== undefined &&
			updates.offsetTuning !== state.offsetTuning
		) {
			await this.setOffsetTuning(sourceId, updates.offsetTuning, opts)
		}
		if (updates.rtlXtal !== undefined && updates.rtlXtal !== state.rtlXtal) {
			await this.setRtlXtal(sourceId, updates.rtlXtal, opts)
		}
		if (
			updates.tunerXtal !== undefined &&
			updates.tunerXtal !== state.tunerXtal
		) {
			await this.setTunerXtal(sourceId, updates.tunerXtal, opts)
		}
		if (
			updates.tunerGainIndex !== undefined &&
			updates.tunerGainIndex !== state.tunerGainIndex
		) {
			await this.setTunerGainIndex(sourceId, updates.tunerGainIndex, opts)
		}
		if (
			updates.tunerIfGain !== undefined &&
			!this.isSameTunerIfGain(updates.tunerIfGain, state.tunerIfGain)
		) {
			if (updates.tunerIfGain === null) {
				this.sourceManager.assertTunerCommandActive()
				state.tunerIfGain = null
				this.desiredFields.get(sourceId)?.delete("tunerIfGain")
				this.emitStateChanged(sourceId)
			} else {
				await this.setTunerIfGain(
					sourceId,
					updates.tunerIfGain.stage,
					updates.tunerIfGain.gain,
					opts,
				)
			}
		}

		if (updates.controlMode === "external") {
			this.sourceManager.assertTunerCommandActive()
			this.setControlMode(sourceId, "external")
		}
	}

	// === Reconnect Synchronization ===

	/**
	 * Synchronize tuner state and source metadata for a new source session.
	 * Wired to the session's first payload (see core/tuner-wiring.ts).
	 *
	 * rtl_tcp cannot report the receiver's rate or center, so after a reconnect
	 * the receiver may be at its own defaults. Policy (config `tuner.reconnectPolicy`):
	 * - "restore": re-send fields accepted through the API or relay (never config
	 *   defaults). Frames are written synchronously before any event fires, so a
	 *   later API/relay command is always written after the batch and wins.
	 * - "reset": write nothing; discard accepted state and fall back to the
	 *   configured baseline, exactly as after a fresh start.
	 * Either way source caps are then reconciled with what the tuner state can
	 * back, so stale metadata is never kept silently. Success means "written",
	 * never "applied": rtl_tcp has no acknowledgement or readback.
	 */
	synchronizeOnConnect(sourceId: string): TunerConnectSyncResult {
		const policy = this.config.reconnectPolicy ?? "restore"
		const state = this.tunerStates.get(sourceId)
		if (!state) return { policy, commands: [], reset: false }
		const desired = this.desiredFields.get(sourceId)
		// A new connection: nothing is written on it yet (WG9 req 3.2).
		this.connectionTuningWrites.delete(sourceId)
		this.rateProvedOnConnection.delete(sourceId)
		this.rateProofInFlight.delete(sourceId)
		this.rateProofEpoch.set(
			sourceId,
			(this.rateProofEpoch.get(sourceId) ?? 0) + 1,
		)
		// WG11 req 4.2: the configured frames are considered once per connection.
		const configDue = this.configWriteDue.delete(sourceId)
		if (configDue) this.configProvenFields.delete(sourceId)

		if (policy === "reset") {
			const reset = desired !== undefined && desired.size > 0
			// Inferred or ignored-relay fields alone are no reset, but their proof is gone too.
			const forgot =
				(this.inferredFields.get(sourceId)?.size ?? 0) > 0 ||
				(this.ignoredRelayFields.get(sourceId)?.size ?? 0) > 0
			this.desiredFields.delete(sourceId)
			this.inferredFields.delete(sourceId)
			this.ignoredRelayFields.delete(sourceId)
			// With nothing accepted every non-baseline value came from an inferred write or
			// relay command, so a forget also returns the values to the baseline (WG5 R2).
			if (reset || forgot)
				this.applyBaselineFields(state, this.baselineCaps.get(sourceId))
			if (reset) {
				this.log.warn(
					{ sourceId },
					"Source reconnected: discarded accepted tuner state (reconnectPolicy=reset); receiver state unconfirmed",
				)
			}
			// Accepted fields are gone, so every configured field is written.
			const configured = configDue
				? this.writeConfiguredTuning(sourceId, state)
				: undefined
			const capsChanged = this.reconcileCaps(sourceId, state)
			if (reset || forgot || capsChanged || configured?.attempted === true)
				this.emitStateChanged(sourceId)
			const commands = configured?.commands ?? []
			return configured?.error !== undefined
				? { policy, commands, reset, error: configured.error }
				: { policy, commands, reset }
		}

		// An inferred (written, not accepted) centre or rate is never replayed, so after a
		// reconnect the receiver may be elsewhere: drop its proof and, unless an accepted
		// value is replayed below, return it to the baseline (WG5 R2).
		const forgotTuning = this.forgetInferredTuning(sourceId, state, desired)

		// WG11 req 4.2, 4.3: configured fields not held by the operator, before the
		// restore; a failed configured write stops the restore too (today's failure).
		const configured = configDue
			? this.writeConfiguredTuning(sourceId, state)
			: undefined
		if (configured?.error !== undefined) {
			const capsChanged = this.reconcileCaps(sourceId, state)
			if (configured.attempted || capsChanged || forgotTuning)
				this.emitStateChanged(sourceId)
			return {
				policy,
				commands: configured.commands,
				reset: false,
				error: configured.error,
			}
		}

		const written: Array<{ value: number; name: string }> = []
		let failure: Error | undefined
		const plan = desired ? this.buildReplayPlan(state, desired) : []
		for (const [cmd, value] of plan) {
			try {
				this.sourceManager.writeToSource(sourceId, this.encodeFrame(cmd, value))
			} catch (err) {
				failure =
					err instanceof Error
						? err
						: new WaveKitError(String(err), "TUNER_RESTORE_FAILED")
				break
			}
			const name = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
			written.push({ value, name })
			this.markConnectionWrite(sourceId, cmd)
			const field = stateFieldOf(cmd)
			if (field !== undefined) this.clearIgnoredRelayField(sourceId, field)
		}

		if (written.length > 0) {
			state.commandCount += written.length
			state.lastCommandAt = new Date().toISOString()
		}
		if (failure) {
			state.lastError = `Tuner state restore failed: ${failure.message}`
		} else if (written.length > 0) {
			delete state.lastError
		}

		const capsChanged = this.reconcileCaps(sourceId, state)

		const replayed = written.map(entry => entry.name)
		const commands = [...(configured?.commands ?? []), ...replayed]
		if (failure) {
			this.log.warn(
				{ sourceId, commands: replayed, err: failure.message },
				"Tuner state restore interrupted; will retry on next connection",
			)
		} else if (replayed.length > 0) {
			this.log.info(
				{ sourceId, commands: replayed },
				"Restored desired tuner state",
			)
		}

		for (const { name, value } of written) {
			this.emit("command-sent", sourceId, name, value, "replay")
		}
		if (failure) this.emit("error", sourceId, failure)
		if (
			plan.length > 0 ||
			capsChanged ||
			forgotTuning ||
			configured?.attempted === true
		)
			this.emitStateChanged(sourceId)

		return failure
			? {
					policy,
					commands,
					reset: false,
					error: state.lastError ?? failure.message,
				}
			: { policy, commands, reset: false }
	}

	/**
	 * Align source caps with what the tuner state backs: accepted values for
	 * commanded fields, otherwise the configured baseline. One caps-changed at
	 * most, and none when metadata already matches (no decoder restart storm).
	 */
	private reconcileCaps(sourceId: string, state: TunerState): boolean {
		const desired = this.desiredFields.get(sourceId)
		const baseline = this.baselineCaps.get(sourceId)
		const current = this.sourceManager.getCaps(sourceId)
		if (!current) return false

		const sampleRate = desired?.has("sampleRate")
			? state.sampleRate
			: (baseline?.sampleRate ?? current.sampleRate)
		const centerFreq = desired?.has("frequency")
			? state.frequency
			: baseline
				? baseline.centerFreq
				: current.centerFreq
		if (current.sampleRate === sampleRate && current.centerFreq === centerFreq)
			return false

		this.log.warn(
			{
				sourceId,
				staleSampleRate: current.sampleRate,
				staleCenterFreq: current.centerFreq,
				sampleRate,
				centerFreq,
			},
			"Reconciling source tuning metadata after reconnect",
		)
		try {
			this.sourceManager.setTuningCaps(sourceId, { sampleRate, centerFreq })
		} catch (err) {
			this.log.warn({ sourceId, err }, "Failed to reconcile source caps")
			return false
		}
		return true
	}

	/**
	 * WG11 req 4.2-4.5: writes the configured frames of a new connection, in order
	 * gain mode, gain, AGC, skipping each field the operator holds (accepted or
	 * observed in this process; a gain is also skipped when the gain mode is held,
	 * since an rtl_tcp gain write switches the tuner to manual). Internal control
	 * only. The written fields are known (and state shows the configured values)
	 * only when every frame of the set was written; a failure claims none, warns,
	 * sets lastError and is retried on the next connection. Emits `command-sent`
	 * with origin `config`. `attempted` is false when nothing was tried.
	 */
	private writeConfiguredTuning(
		sourceId: string,
		state: TunerState,
	): { attempted: boolean; commands: string[]; error?: string } {
		const configured = this.configuredTuning.get(sourceId)
		if (!configured || state.controlMode !== "internal")
			return { attempted: false, commands: [] }
		const held = (field: TunerStateField) =>
			this.isOperatorHeld(sourceId, field)
		// A held tuner gain index is replayed after the configured frames and sets
		// the tuner gain itself: a configured gain or gain mode would be claimed
		// (and proven) but overridden.
		const indexHeld =
			this.desiredFields.get(sourceId)?.has("tunerGainIndex") === true
		const frames = configured.frames.filter(([cmd]) => {
			if (cmd === RTL_TCP_COMMANDS.SET_GAIN)
				return !held("gain") && !held("gainMode") && !indexHeld
			// A held gain is replayed as SET_GAIN, which switches the tuner to
			// manual: a configured gain mode would be claimed but overridden.
			if (cmd === RTL_TCP_COMMANDS.SET_GAIN_MODE)
				return !held("gainMode") && !held("gain") && !indexHeld
			const field = stateFieldOf(cmd)
			return field !== undefined && !held(field)
		})
		if (frames.length === 0) return { attempted: false, commands: [] }

		const written: Array<{ cmd: number; value: number; name: string }> = []
		let failure: Error | undefined
		for (const [cmd, value] of frames) {
			try {
				this.sourceManager.writeToSource(sourceId, this.encodeFrame(cmd, value))
			} catch (err) {
				failure =
					err instanceof Error
						? err
						: new WaveKitError(String(err), "TUNER_RESTORE_FAILED")
				break
			}
			written.push({
				cmd,
				value,
				name: COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`,
			})
		}
		const commands = written.map(entry => entry.name)
		if (written.length > 0) {
			state.commandCount += written.length
			state.lastCommandAt = new Date().toISOString()
		}

		if (failure) {
			state.lastError = `Tuner state restore failed: ${failure.message}`
			this.log.warn(
				{ sourceId, commands, err: failure.message },
				"Tuner state restore interrupted; will retry on next connection",
			)
		} else {
			const proven = new Set<TunerStateField>()
			for (const { cmd, value } of written) {
				if (cmd === RTL_TCP_COMMANDS.SET_GAIN_MODE) {
					state.gainMode = value === 1 ? "manual" : "agc"
					proven.add("gainMode")
				} else if (cmd === RTL_TCP_COMMANDS.SET_GAIN) {
					state.gain = value
					proven.add("gain")
				} else if (cmd === RTL_TCP_COMMANDS.SET_AGC_MODE) {
					state.agcMode = value !== 0
					proven.add("agcMode")
				}
			}
			this.configProvenFields.set(sourceId, proven)
			delete state.lastError
			this.log.info(
				{ sourceId, commands },
				"Wrote configured tuner gain on connect",
			)
		}

		for (const { name, value } of written)
			this.emit("command-sent", sourceId, name, value, "config")
		if (failure) {
			this.emit("error", sourceId, failure)
			return {
				attempted: true,
				commands,
				error: state.lastError ?? failure.message,
			}
		}
		return { attempted: true, commands }
	}

	/** A gain field accepted (REST or relay) or observed (inferred) in this process. */
	private isOperatorHeld(sourceId: string, field: TunerStateField): boolean {
		const desired: ReadonlyMap<string, number> | undefined =
			this.desiredFields.get(sourceId)
		return (
			desired?.has(field) === true ||
			this.inferredFields.get(sourceId)?.has(field) === true
		)
	}

	/** gainMode, gain and agcMode of the baseline: configured, else the built-in. */
	private gainBaseline(sourceId: string): {
		gainMode: TunerGainMode
		gain: number
		agcMode: boolean
	} {
		const tuner = this.configuredTuning.get(sourceId)?.tuner
		if (!tuner) return { gainMode: "agc", gain: 0, agcMode: true }
		return {
			gainMode: tuner.gainMode,
			gain:
				tuner.gainMode === "manual" && tuner.gainDb !== undefined
					? Math.round(tuner.gainDb * 10)
					: 0,
			agcMode: tuner.agcMode ?? true,
		}
	}

	// === State Accessors ===

	/**
	 * WG9 req 3.2: true only when both frequency and sample rate were written on the
	 * current connection (an API write, a reconnect replay, or an accepted relay command).
	 * A caps change from reconnect reconciliation with no such write is `unverified`.
	 */
	tuningWrittenOnConnection(sourceId: string): boolean {
		const written = this.connectionTuningWrites.get(sourceId)
		return (
			written !== undefined &&
			written.has("frequency") &&
			written.has("sampleRate")
		)
	}

	private markConnectionWrite(sourceId: string, cmd: number): void {
		const field =
			cmd === RTL_TCP_COMMANDS.SET_FREQUENCY
				? "frequency"
				: cmd === RTL_TCP_COMMANDS.SET_SAMPLE_RATE
					? "sampleRate"
					: undefined
		if (field === undefined || !this.tunerStates.has(sourceId)) return
		let written = this.connectionTuningWrites.get(sourceId)
		if (!written) {
			written = new Set()
			this.connectionTuningWrites.set(sourceId, written)
		}
		written.add(field)
	}

	getState(sourceId: string): TunerState | undefined {
		const state = this.tunerStates.get(sourceId)
		return state ? this.cloneState(state) : undefined
	}

	getAllStates(): TunerState[] {
		return Array.from(this.tunerStates.values()).map(state =>
			this.cloneState(state),
		)
	}

	getRtlTcpSourceIds(): string[] {
		return Array.from(this.tunerStates.keys())
	}

	// === Private Helpers ===

	private hasCommandUpdates(updates: Partial<TunerState>): boolean {
		return (
			updates.frequency !== undefined ||
			updates.sampleRate !== undefined ||
			updates.gainMode !== undefined ||
			updates.gain !== undefined ||
			updates.ppm !== undefined ||
			updates.ifGain !== undefined ||
			updates.testMode !== undefined ||
			updates.agcMode !== undefined ||
			updates.biasTee !== undefined ||
			updates.directSampling !== undefined ||
			updates.offsetTuning !== undefined ||
			updates.rtlXtal !== undefined ||
			updates.tunerXtal !== undefined ||
			updates.tunerGainIndex !== undefined ||
			updates.tunerIfGain !== undefined
		)
	}

	private validateSource(sourceId: string): TunerState {
		const state = this.tunerStates.get(sourceId)
		if (!state) {
			throw new TunerSourceNotFoundError(sourceId)
		}
		return state
	}

	private validateSourceForControl(sourceId: string): TunerState {
		const state = this.validateSource(sourceId)
		if (state.controlMode === "external") {
			throw new TunerControlModeError(sourceId)
		}
		return state
	}

	/** The setters' own value checks, for a bulk update before its first write. */
	private validateUpdates(updates: Partial<TunerState>): void {
		if (updates.frequency !== undefined)
			this.validateRange("frequency", updates.frequency, VALIDATION.frequency)
		if (updates.sampleRate !== undefined) {
			this.validateRange(
				"sampleRate",
				updates.sampleRate,
				VALIDATION.sampleRate,
			)
			if (!isValidRtlSampleRate(updates.sampleRate))
				throw new TunerValidationError(
					`sampleRate ${updates.sampleRate} is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)`,
				)
		}
		if (updates.gain !== undefined)
			this.validateRange("gain", updates.gain, VALIDATION.gain)
		if (updates.ppm !== undefined)
			this.validateRange("ppm", updates.ppm, VALIDATION.ppm)
		if (updates.ifGain !== undefined)
			this.validateUint32("ifGain", updates.ifGain)
		if (updates.rtlXtal !== undefined)
			this.validateUint32("rtlXtal", updates.rtlXtal)
		if (updates.tunerXtal !== undefined)
			this.validateUint32("tunerXtal", updates.tunerXtal)
		if (updates.tunerGainIndex !== undefined)
			this.validateUint32("tunerGainIndex", updates.tunerGainIndex)
		if (updates.tunerIfGain !== undefined && updates.tunerIfGain !== null) {
			this.validateUint16("tunerIfGain.stage", updates.tunerIfGain.stage)
			this.validateUint16("tunerIfGain.gain", updates.tunerIfGain.gain)
		}
	}

	private validateRange(
		name: string,
		value: number,
		range: { min: number; max: number },
	): void {
		this.validateInteger(name, value)
		if (value < range.min || value > range.max) {
			throw new TunerValidationError(
				`${name} out of range: ${value} (expected ${range.min}-${range.max})`,
			)
		}
	}

	private isWithinRange(
		value: number,
		range: { min: number; max: number },
	): boolean {
		return (
			Number.isFinite(value) &&
			Number.isInteger(value) &&
			value >= range.min &&
			value <= range.max
		)
	}

	private validateInteger(name: string, value: number): void {
		if (!Number.isFinite(value) || !Number.isInteger(value)) {
			throw new TunerValidationError(`${name} must be an integer`)
		}
	}

	private validateUint32(name: string, value: number): void {
		this.validateRange(name, value, VALIDATION.uint32)
	}

	private validateUint16(name: string, value: number): void {
		this.validateRange(name, value, VALIDATION.uint16)
	}

	private encodeSignedInt32(value: number): number {
		if (!Number.isFinite(value)) {
			throw new TunerValidationError("ppm must be a finite number")
		}
		return value < 0 ? 0xffffffff + value + 1 : value
	}

	private decodeSignedInt32(value: number): number {
		return value > 0x7fffffff ? value - 0x100000000 : value
	}

	/** Drops inferred frequency/sampleRate proof; true when one was dropped. */
	private forgetInferredTuning(
		sourceId: string,
		state: TunerState,
		desired: ReadonlyMap<DesiredField, number> | undefined,
	): boolean {
		const inferred = this.inferredFields.get(sourceId)
		if (!inferred) return false
		const caps = this.baselineCaps.get(sourceId)
		let forgot = false
		if (inferred.delete("frequency")) {
			forgot = true
			if (!desired?.has("frequency"))
				state.frequency =
					this.config.defaultFrequency ?? caps?.centerFreq ?? DEFAULT_FREQUENCY
		}
		if (inferred.delete("sampleRate")) {
			forgot = true
			if (!desired?.has("sampleRate"))
				state.sampleRate =
					this.config.defaultSampleRate ??
					caps?.sampleRate ??
					DEFAULT_SAMPLE_RATE
		}
		return forgot
	}

	/** Reset tunable fields to the startup baseline (control mode/counters kept). */
	private applyBaselineFields(state: TunerState, caps?: SourceCaps): void {
		state.frequency =
			this.config.defaultFrequency ?? caps?.centerFreq ?? DEFAULT_FREQUENCY
		state.sampleRate =
			this.config.defaultSampleRate ?? caps?.sampleRate ?? DEFAULT_SAMPLE_RATE
		const gain = this.gainBaseline(state.sourceId)
		state.gainMode = gain.gainMode
		state.gain = gain.gain
		state.ppm = 0
		state.agcMode = gain.agcMode
		state.biasTee = false
		state.directSampling = "off"
		state.offsetTuning = false
		state.ifGain = 0
		state.tunerIfGain = null
		state.testMode = false
		delete state.rtlXtal
		delete state.tunerXtal
		delete state.tunerGainIndex
	}

	private markIgnoredRelayField(
		sourceId: string,
		field: TunerStateField,
	): void {
		let ignored = this.ignoredRelayFields.get(sourceId)
		if (!ignored) {
			ignored = new Set()
			this.ignoredRelayFields.set(sourceId, ignored)
		}
		ignored.add(field)
	}

	private clearIgnoredRelayField(
		sourceId: string,
		field: TunerStateField,
	): void {
		this.ignoredRelayFields.get(sourceId)?.delete(field)
	}

	private markInferred(sourceId: string, field: TunerStateField): void {
		this.clearIgnoredRelayField(sourceId, field)
		let inferred = this.inferredFields.get(sourceId)
		if (!inferred) {
			inferred = new Set()
			this.inferredFields.set(sourceId, inferred)
		}
		inferred.add(field)
	}

	private markAccepted(sourceId: string, cmd: number): void {
		const field = COMMAND_FIELDS[cmd]
		if (!field) return
		const stateField = stateFieldOf(cmd)
		if (stateField !== undefined)
			this.clearIgnoredRelayField(sourceId, stateField)
		let desired = this.desiredFields.get(sourceId)
		if (!desired) {
			desired = new Map()
			this.desiredFields.set(sourceId, desired)
		}
		desired.set(field, ++this.acceptanceSeq)
	}

	/**
	 * A written but not accepted value (`accept: false`, every test-mode write, a
	 * relay TEST_MODE) is known: the state shows it. It is not a desired field.
	 */
	private markWrittenNotAccepted(sourceId: string, cmd: number): void {
		const field = stateFieldOf(cmd)
		if (field !== undefined) this.markInferred(sourceId, field)
	}

	private buildReplayPlan(
		state: TunerState,
		desired: ReadonlyMap<DesiredField, number>,
	): Array<[number, number]> {
		const plan: Array<[number, number]> = []
		for (const phase of REPLAY_PHASES) {
			const fields = phase.fields.filter(field => desired.has(field))
			if (phase.byAcceptance) {
				fields.sort((a, b) => (desired.get(a) ?? 0) - (desired.get(b) ?? 0))
			}
			for (const field of fields) {
				const frame = this.encodeDesiredField(state, field)
				if (frame) plan.push(frame)
			}
		}
		return plan
	}

	private encodeDesiredField(
		state: TunerState,
		field: DesiredField,
	): [number, number] | null {
		const flag = (enabled: boolean) => (enabled ? 1 : 0)
		switch (field) {
			case "frequency":
				return [RTL_TCP_COMMANDS.SET_FREQUENCY, state.frequency]
			case "sampleRate":
				return [RTL_TCP_COMMANDS.SET_SAMPLE_RATE, state.sampleRate]
			case "gainMode":
				return [
					RTL_TCP_COMMANDS.SET_GAIN_MODE,
					flag(state.gainMode === "manual"),
				]
			case "gain":
				return [RTL_TCP_COMMANDS.SET_GAIN, state.gain]
			case "ppm":
				return [
					RTL_TCP_COMMANDS.SET_FREQ_CORRECTION,
					this.encodeSignedInt32(state.ppm),
				]
			case "ifGain":
				return [RTL_TCP_COMMANDS.SET_IF_GAIN, state.ifGain]
			case "agcMode":
				return [RTL_TCP_COMMANDS.SET_AGC_MODE, flag(state.agcMode)]
			case "directSampling":
				return [
					RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING,
					state.directSampling === "off"
						? 0
						: state.directSampling === "i"
							? 1
							: 2,
				]
			case "offsetTuning":
				return [RTL_TCP_COMMANDS.SET_OFFSET_TUNING, flag(state.offsetTuning)]
			case "biasTee":
				return [RTL_TCP_COMMANDS.SET_BIAS_TEE, flag(state.biasTee)]
			case "rtlXtal":
				return state.rtlXtal === undefined
					? null
					: [RTL_TCP_COMMANDS.SET_RTL_XTAL, state.rtlXtal]
			case "tunerXtal":
				return state.tunerXtal === undefined
					? null
					: [RTL_TCP_COMMANDS.SET_TUNER_XTAL, state.tunerXtal]
			case "tunerGainIndex":
				return state.tunerGainIndex === undefined
					? null
					: [RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX, state.tunerGainIndex]
			case "tunerIfGain":
				return state.tunerIfGain === null
					? null
					: [
							RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN,
							(state.tunerIfGain.stage << 16) |
								(state.tunerIfGain.gain & 0xffff),
						]
		}
	}

	private encodeFrame(cmd: number, value: number): Buffer {
		const buf = Buffer.alloc(5)
		buf.writeUInt8(cmd, 0)
		buf.writeUInt32BE(value >>> 0, 1)
		return buf
	}

	private async sendCommand(
		sourceId: string,
		cmd: number,
		value: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		this.sourceManager.assertTunerCommandActive()
		try {
			this.sourceManager.writeToSource(sourceId, this.encodeFrame(cmd, value))
			if (opts.accept === false) this.markWrittenNotAccepted(sourceId, cmd)
			else this.markAccepted(sourceId, cmd)
			this.markConnectionWrite(sourceId, cmd)
			const state = this.tunerStates.get(sourceId)
			if (state) {
				state.commandCount++
				state.lastCommandAt = new Date().toISOString()
				delete state.lastError
			}
			const cmdName = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
			this.emit("command-sent", sourceId, cmdName, value, opts.origin)
			this.log.debug(
				{ sourceId, command: cmdName, value, origin: opts.origin },
				"Command sent",
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const state = this.tunerStates.get(sourceId)
			if (state) {
				state.lastError = message
			}
			this.log.error({ sourceId, err: message }, "Failed to send tuner command")
			this.emit(
				"error",
				sourceId,
				err instanceof Error ? err : new Error(message),
			)
			this.emitStateChanged(sourceId)
			throw err
		}
	}

	private emitStateChanged(sourceId: string): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) return
		this.emit("state-changed", sourceId, this.cloneState(state))
	}

	private cloneState(state: TunerState): TunerState {
		const {
			unknownFields: _stale,
			declaredOnlyFields: _staleDeclared,
			...fields
		} = state
		const { unknownFields, declaredOnlyFields } = this.fieldProof(
			state.sourceId,
		)
		const ratePolicy = this.ratePolicyRecordFor?.(state.sourceId)
		return {
			...fields,
			...(ratePolicy ? { ratePolicy } : {}),
			tunerIfGain: state.tunerIfGain
				? { ...state.tunerIfGain }
				: state.tunerIfGain,
			...(unknownFields.length > 0 ? { unknownFields } : {}),
			...(declaredOnlyFields.length > 0 ? { declaredOnlyFields } : {}),
		}
	}

	/**
	 * `unknownFields`: fields backed by nothing: not commanded through the API, not
	 * seen in a relay client's command (both tracked as accepted desired fields), and
	 * for frequency/sampleRate not declared by config or the source caps; plus a
	 * frequency/sampleRate whose last relay value was ignored (WG5).
	 * `declaredOnlyFields` (WG5): frequency/sampleRate known only from that declared
	 * baseline, never written by WaveKit or seen from a relay client since the start or
	 * the last reset reconnect, so the receiver may be elsewhere.
	 */
	private fieldProof(sourceId: string): {
		unknownFields: TunerStateField[]
		declaredOnlyFields: TunerStateField[]
	} {
		const accepted: ReadonlyMap<string, number> | undefined =
			this.desiredFields.get(sourceId)
		const inferred = this.inferredFields.get(sourceId)
		const ignored = this.ignoredRelayFields.get(sourceId)
		const baseline = this.baselineCaps.get(sourceId)
		const declared = new Set<TunerStateField>()
		if (
			this.config.defaultFrequency !== undefined ||
			baseline?.centerFreq !== undefined
		)
			declared.add("frequency")
		if (
			this.config.defaultSampleRate !== undefined ||
			baseline?.sampleRate !== undefined
		)
			declared.add("sampleRate")
		const configWritten = this.configProvenFields.get(sourceId)
		const proven = (field: TunerStateField): boolean =>
			accepted?.has(field) === true ||
			inferred?.has(field) === true ||
			configWritten?.has(field) === true
		return {
			unknownFields: STATE_FIELDS.filter(
				field =>
					ignored?.has(field) === true ||
					(!declared.has(field) && !proven(field)),
			),
			declaredOnlyFields: STATE_FIELDS.filter(
				field =>
					declared.has(field) && !proven(field) && ignored?.has(field) !== true,
			),
		}
	}

	private isSameTunerIfGain(
		left: TunerState["tunerIfGain"],
		right: TunerState["tunerIfGain"],
	): boolean {
		if (left === right) return true
		if (!left || !right) return false
		return left.stage === right.stage && left.gain === right.gain
	}
}
