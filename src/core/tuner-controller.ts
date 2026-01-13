/**
 * Tuner Controller - Primary RTL-TCP tuner control interface.
 *
 * Provides direct tuning control for rtl_tcp/rtlmux sources and supports
 * releasing control to external tuner clients (e.g., SDR++ via TunerRelay).
 */

import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import type {
	SourceCaps,
	SourceConfig,
	SourceManager,
} from "./source-manager.js"
import type {
	TunerState,
	TunerGainMode,
	TunerDirectSampling,
	TunerControlMode,
} from "@wavekit/api-types"

// Validation constants
const VALIDATION = {
	frequency: { min: 24_000_000, max: 1_900_000_000 },
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

export interface TunerControllerEvents {
	"state-changed": (sourceId: string, state: TunerState) => void
	"command-sent": (sourceId: string, command: string, value: number) => void
	"control-mode-changed": (sourceId: string, mode: TunerControlMode) => void
	error: (sourceId: string, error: Error) => void
}

export interface TunerControllerConfig {
	defaultFrequency?: number
	defaultSampleRate?: number
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

export class TunerController extends EventEmitter {
	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly config: TunerControllerConfig
	private tunerStates: Map<string, TunerState> = new Map()
	private controlModeOrigins: Map<string, ControlModeOrigin> = new Map()

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

		const defaultFrequency =
			this.config.defaultFrequency ?? caps?.centerFreq ?? DEFAULT_FREQUENCY
		const defaultSampleRate =
			this.config.defaultSampleRate ?? caps?.sampleRate ?? DEFAULT_SAMPLE_RATE

		// Default state: sensible defaults for immediate use
		const state: TunerState = {
			sourceId,
			frequency: defaultFrequency,
			sampleRate: defaultSampleRate,
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

		this.tunerStates.set(sourceId, state)
		this.controlModeOrigins.set(sourceId, "user")
		this.log.info({ sourceId }, "Tuner source initialized")
		this.emitStateChanged(sourceId)
	}

	removeSource(sourceId: string): void {
		if (!this.tunerStates.has(sourceId)) return
		this.tunerStates.delete(sourceId)
		this.controlModeOrigins.delete(sourceId)
		this.log.info({ sourceId }, "Tuner source removed")
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
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range frequency from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_SAMPLE_RATE:
				if (this.isWithinRange(value, VALIDATION.sampleRate)) {
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
				const nextMode: TunerDirectSampling | null =
					value === 0 ? "off" : value === 1 ? "i" : value === 2 ? "q" : null
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
			delete state.lastError
			this.log.debug(
				{ sourceId, command: cmdName, value },
				"Applied relay command update",
			)
		}

		this.emitStateChanged(sourceId)
	}

	// === Tuning Commands (only when controlMode === "internal") ===

	async setFrequency(sourceId: string, hz: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("frequency", hz, VALIDATION.frequency)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_FREQUENCY, hz)
		state.frequency = hz
		this.emitStateChanged(sourceId)
	}

	async setSampleRate(sourceId: string, hz: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("sampleRate", hz, VALIDATION.sampleRate)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_SAMPLE_RATE, hz)
		state.sampleRate = hz
		try {
			this.sourceManager.updateSourceCaps(sourceId, { sampleRate: hz })
		} catch (err) {
			this.log.warn({ sourceId, err }, "Failed to update source caps")
		}
		this.emitStateChanged(sourceId)
	}

	async setGainMode(sourceId: string, mode: TunerGainMode): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "manual" ? 1 : 0
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_GAIN_MODE, value)
		state.gainMode = mode
		this.emitStateChanged(sourceId)
	}

	async setGain(sourceId: string, tenthsDb: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("gain", tenthsDb, VALIDATION.gain)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_GAIN, tenthsDb)
		state.gain = tenthsDb
		this.emitStateChanged(sourceId)
	}

	async setPpm(sourceId: string, ppm: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("ppm", ppm, VALIDATION.ppm)
		const value = this.encodeSignedInt32(ppm)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_FREQ_CORRECTION,
			value,
		)
		state.ppm = ppm
		this.emitStateChanged(sourceId)
	}

	async setIfGain(sourceId: string, gain: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("ifGain", gain)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_IF_GAIN, gain)
		state.ifGain = gain
		this.emitStateChanged(sourceId)
	}

	async setTestMode(sourceId: string, enabled: boolean): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_TEST_MODE,
			enabled ? 1 : 0,
		)
		state.testMode = enabled
		this.emitStateChanged(sourceId)
	}

	async setAgcMode(sourceId: string, enabled: boolean): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_AGC_MODE,
			enabled ? 1 : 0,
		)
		state.agcMode = enabled
		this.emitStateChanged(sourceId)
	}

	async setDirectSampling(
		sourceId: string,
		mode: TunerDirectSampling,
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "off" ? 0 : mode === "i" ? 1 : 2
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING,
			value,
		)
		state.directSampling = mode
		this.emitStateChanged(sourceId)
	}

	async setOffsetTuning(sourceId: string, enabled: boolean): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_OFFSET_TUNING,
			enabled ? 1 : 0,
		)
		state.offsetTuning = enabled
		this.emitStateChanged(sourceId)
	}

	async setRtlXtal(sourceId: string, hz: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("rtlXtal", hz)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_RTL_XTAL, hz)
		state.rtlXtal = hz
		this.emitStateChanged(sourceId)
	}

	async setTunerXtal(sourceId: string, hz: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("tunerXtal", hz)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_TUNER_XTAL, hz)
		state.tunerXtal = hz
		this.emitStateChanged(sourceId)
	}

	async setTunerGainIndex(sourceId: string, index: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("tunerGainIndex", index)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX,
			index,
		)
		state.tunerGainIndex = index
		this.emitStateChanged(sourceId)
	}

	async setBiasTee(sourceId: string, enabled: boolean): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_BIAS_TEE,
			enabled ? 1 : 0,
		)
		state.biasTee = enabled
		this.emitStateChanged(sourceId)
	}

	async setTunerIfGain(
		sourceId: string,
		stage: number,
		gain: number,
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint16("tunerIfGain.stage", stage)
		this.validateUint16("tunerIfGain.gain", gain)
		const value = (stage << 16) | (gain & 0xffff)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN, value)
		state.tunerIfGain = { stage, gain }
		this.emitStateChanged(sourceId)
	}

	// === Bulk Update ===

	async configure(
		sourceId: string,
		updates: Partial<TunerState>,
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

		if (
			updates.frequency !== undefined &&
			updates.frequency !== state.frequency
		) {
			await this.setFrequency(sourceId, updates.frequency)
		}
		if (
			updates.sampleRate !== undefined &&
			updates.sampleRate !== state.sampleRate
		) {
			await this.setSampleRate(sourceId, updates.sampleRate)
		}
		if (updates.gainMode !== undefined && updates.gainMode !== state.gainMode) {
			await this.setGainMode(sourceId, updates.gainMode)
		}
		if (updates.gain !== undefined && updates.gain !== state.gain) {
			await this.setGain(sourceId, updates.gain)
		}
		if (updates.ppm !== undefined && updates.ppm !== state.ppm) {
			await this.setPpm(sourceId, updates.ppm)
		}
		if (updates.ifGain !== undefined && updates.ifGain !== state.ifGain) {
			await this.setIfGain(sourceId, updates.ifGain)
		}
		if (updates.testMode !== undefined && updates.testMode !== state.testMode) {
			await this.setTestMode(sourceId, updates.testMode)
		}
		if (updates.agcMode !== undefined && updates.agcMode !== state.agcMode) {
			await this.setAgcMode(sourceId, updates.agcMode)
		}
		if (updates.biasTee !== undefined && updates.biasTee !== state.biasTee) {
			await this.setBiasTee(sourceId, updates.biasTee)
		}
		if (
			updates.directSampling !== undefined &&
			updates.directSampling !== state.directSampling
		) {
			await this.setDirectSampling(sourceId, updates.directSampling)
		}
		if (
			updates.offsetTuning !== undefined &&
			updates.offsetTuning !== state.offsetTuning
		) {
			await this.setOffsetTuning(sourceId, updates.offsetTuning)
		}
		if (updates.rtlXtal !== undefined && updates.rtlXtal !== state.rtlXtal) {
			await this.setRtlXtal(sourceId, updates.rtlXtal)
		}
		if (
			updates.tunerXtal !== undefined &&
			updates.tunerXtal !== state.tunerXtal
		) {
			await this.setTunerXtal(sourceId, updates.tunerXtal)
		}
		if (
			updates.tunerGainIndex !== undefined &&
			updates.tunerGainIndex !== state.tunerGainIndex
		) {
			await this.setTunerGainIndex(sourceId, updates.tunerGainIndex)
		}
		if (
			updates.tunerIfGain !== undefined &&
			!this.isSameTunerIfGain(updates.tunerIfGain, state.tunerIfGain)
		) {
			if (updates.tunerIfGain === null) {
				state.tunerIfGain = null
				this.emitStateChanged(sourceId)
			} else {
				await this.setTunerIfGain(
					sourceId,
					updates.tunerIfGain.stage,
					updates.tunerIfGain.gain,
				)
			}
		}

		if (updates.controlMode === "external") {
			this.setControlMode(sourceId, "external")
		}
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

	private async sendCommand(
		sourceId: string,
		cmd: number,
		value: number,
	): Promise<void> {
		const buf = Buffer.alloc(5)
		buf.writeUInt8(cmd, 0)
		buf.writeUInt32BE(value >>> 0, 1)

		try {
			this.sourceManager.writeToSource(sourceId, buf)
			const state = this.tunerStates.get(sourceId)
			if (state) {
				state.commandCount++
				state.lastCommandAt = new Date().toISOString()
				delete state.lastError
			}
			const cmdName = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
			this.emit("command-sent", sourceId, cmdName, value)
			this.log.debug({ sourceId, command: cmdName, value }, "Command sent")
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
		return {
			...state,
			tunerIfGain: state.tunerIfGain
				? { ...state.tunerIfGain }
				: state.tunerIfGain,
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
