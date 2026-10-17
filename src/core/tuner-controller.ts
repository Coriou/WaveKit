/**
 * Tuner Controller - Primary RTL-TCP tuner control interface.
 *
 * Provides direct tuning control for rtl_tcp/rtlmux sources and supports
 * releasing control to external tuner clients (e.g., SDR++ via TunerRelay).
 */

import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import type {
	SourceCaps,
	SourceConfig,
	SourceManager,
} from "./source-manager.js"
import type {
	TunerState,
	TunerStateField,
	TunerGainMode,
	TunerDirectSampling,
	TunerControlMode,
	TunerCommandOrigin,
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
	/** Caps metadata as first registered, before any accepted command. */
	private baselineCaps: Map<string, SourceCaps | undefined> = new Map()

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
		if (!this.tunerStates.has(sourceId)) return
		this.tunerStates.delete(sourceId)
		this.controlModeOrigins.delete(sourceId)
		this.desiredFields.delete(sourceId)
		this.inferredFields.delete(sourceId)
		this.ignoredRelayFields.delete(sourceId)
		this.baselineCaps.delete(sourceId)
		this.log.info({ sourceId }, "Tuner source removed")
		this.emit("source-removed", sourceId)
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
			if (command === RTL_TCP_COMMANDS.SET_TEST_MODE) {
				this.markWrittenNotAccepted(sourceId, command)
			} else {
				this.markAccepted(sourceId, command)
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
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_FREQUENCY, hz, opts)
		state.frequency = hz
		this.sourceManager.updateSourceCaps(sourceId, { centerFreq: hz })
		this.emitStateChanged(sourceId)
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
		state.sampleRate = hz
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

		if (updates.controlMode === "internal") {
			this.setControlMode(sourceId, "internal")
		}

		// A declared-only or unknown centre/rate equal to the request is still written, so
		// a bulk PUT can prove it (WG5 R2); a proven equal value is skipped as before.
		const proof = this.fieldProof(sourceId)
		const unproven = new Set<TunerStateField>([
			...proof.declaredOnlyFields,
			...proof.unknownFields,
		])
		if (
			updates.frequency !== undefined &&
			(updates.frequency !== state.frequency || unproven.has("frequency"))
		) {
			await this.setFrequency(sourceId, updates.frequency, opts)
		}
		if (
			updates.sampleRate !== undefined &&
			(updates.sampleRate !== state.sampleRate || unproven.has("sampleRate"))
		) {
			await this.setSampleRate(sourceId, updates.sampleRate, opts)
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
			const capsChanged = this.reconcileCaps(sourceId, state)
			if (reset || forgot || capsChanged) this.emitStateChanged(sourceId)
			return { policy, commands: [], reset }
		}

		// An inferred (written, not accepted) centre or rate is never replayed, so after a
		// reconnect the receiver may be elsewhere: drop its proof and, unless an accepted
		// value is replayed below, return it to the baseline (WG5 R2).
		const forgotTuning = this.forgetInferredTuning(sourceId, state, desired)

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

		const commands = written.map(entry => entry.name)
		if (failure) {
			this.log.warn(
				{ sourceId, commands, err: failure.message },
				"Tuner state restore interrupted; will retry on next connection",
			)
		} else if (commands.length > 0) {
			this.log.info({ sourceId, commands }, "Restored desired tuner state")
		}

		for (const { name, value } of written) {
			this.emit("command-sent", sourceId, name, value, "replay")
		}
		if (failure) this.emit("error", sourceId, failure)
		if (plan.length > 0 || capsChanged || forgotTuning)
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

	// === State Accessors ===

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
		state.gainMode = "agc"
		state.gain = 0
		state.ppm = 0
		state.agcMode = true
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
		try {
			this.sourceManager.writeToSource(sourceId, this.encodeFrame(cmd, value))
			if (opts.accept === false) this.markWrittenNotAccepted(sourceId, cmd)
			else this.markAccepted(sourceId, cmd)
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
		return {
			...fields,
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
		const proven = (field: TunerStateField): boolean =>
			accepted?.has(field) === true || inferred?.has(field) === true
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
