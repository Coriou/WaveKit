import { EventEmitter } from "node:events"
import type {
	TunerCommandOrigin,
	TunerState,
	TunerStateField,
} from "@wavekit/api-types"
import {
	TunerControlModeError,
	type TunerWriteOptions,
} from "../../../src/core/tuner-controller.js"
import type {
	EpochClock,
	EngineEpoch,
} from "../../../src/core/spectrum/spectrum-engine.js"
import type { PendingEpoch } from "../../../src/core/spectrum/types.js"

export interface SentCommand {
	sourceId: string
	name: string
	value: number
	origin: TunerCommandOrigin | undefined
	accept: boolean
}

/** TunerController double implementing exactly what TunerArbiter uses. */
export class ArbiterFakeTuner extends EventEmitter {
	readonly sent: SentCommand[] = []
	readonly states = new Map<string, TunerState>()
	readonly known = new Map<string, Set<TunerStateField>>()
	/** WG9: frequency/sampleRate known only from the declared baseline until a write proves them. */
	readonly declared = new Map<string, Set<TunerStateField>>()
	/** WG9 req 3.2: tuning fields written on this connection; null = every field counts as written. */
	connectionWrites: Set<TunerStateField> | null = null
	failNext: Error | null = null
	/** Rejects every write while set (a dropped socket). */
	failAll: Error | null = null
	/** Runs once, right after the next TEST_MODE 1 write resolves (between two arbiter awaits). */
	afterTestModeOn: (() => void) | null = null

	addSource(sourceId: string, unknown: TunerStateField[] = []): void {
		this.states.set(sourceId, {
			sourceId,
			frequency: 446_100_000,
			sampleRate: 2_048_000,
			gainMode: "manual",
			gain: 296,
			ppm: 0,
			agcMode: false,
			biasTee: false,
			directSampling: "off",
			offsetTuning: false,
			ifGain: 0,
			tunerIfGain: null,
			testMode: false,
			controlMode: "internal",
			commandCount: 0,
		})
		const all: TunerStateField[] = [
			"frequency",
			"sampleRate",
			"gainMode",
			"gain",
			"agcMode",
		]
		this.known.set(sourceId, new Set(all.filter(f => !unknown.includes(f))))
	}

	getState(sourceId: string): TunerState | undefined {
		const s = this.states.get(sourceId)
		if (!s) return undefined
		const known = this.known.get(sourceId) ?? new Set()
		const unknownFields = (
			["frequency", "sampleRate", "gainMode", "gain", "agcMode"] as const
		).filter(f => !known.has(f))
		const declaredOnlyFields = [...(this.declared.get(sourceId) ?? [])]
		return {
			...s,
			...(unknownFields.length > 0
				? { unknownFields: [...unknownFields] }
				: {}),
			...(declaredOnlyFields.length > 0 ? { declaredOnlyFields } : {}),
		}
	}

	tuningWrittenOnConnection(_sourceId: string): boolean {
		const w = this.connectionWrites
		return w === null || (w.has("frequency") && w.has("sampleRate"))
	}

	setControl(sourceId: string, mode: "internal" | "external"): void {
		const s = this.states.get(sourceId)!
		if (s.controlMode === mode) return
		s.controlMode = mode
		this.emit("control-mode-changed", sourceId, mode)
	}

	/** An operator or replay write that did not come from the scanner. */
	external(
		sourceId: string,
		name: string,
		value: number,
		origin: TunerCommandOrigin | undefined,
	): void {
		this.emit("command-sent", sourceId, name, value, origin)
	}

	private write(
		sourceId: string,
		name: string,
		value: number,
		field: TunerStateField | null,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const s = this.states.get(sourceId)
		if (!s) return Promise.reject(new Error(`no source ${sourceId}`))
		if (s.controlMode === "external")
			return Promise.reject(new TunerControlModeError(sourceId))
		if (this.failAll) return Promise.reject(this.failAll)
		if (this.failNext) {
			const err = this.failNext
			this.failNext = null
			return Promise.reject(err)
		}
		const accept = name === "set-test-mode" ? false : (opts.accept ?? true)
		this.sent.push({ sourceId, name, value, origin: opts.origin, accept })
		if (field && accept) {
			this.known.get(sourceId)?.add(field)
			this.declared.get(sourceId)?.delete(field)
			this.connectionWrites?.add(field)
		}
		this.emit("command-sent", sourceId, name, value, opts.origin)
		return Promise.resolve()
	}

	setFrequency(
		sourceId: string,
		hz: number,
		opts?: TunerWriteOptions,
	): Promise<void> {
		return this.write(sourceId, "set-frequency", hz, "frequency", opts).then(
			() => {
				this.states.get(sourceId)!.frequency = hz
			},
		)
	}

	setSampleRate(
		sourceId: string,
		hz: number,
		opts?: TunerWriteOptions,
	): Promise<void> {
		return this.write(sourceId, "set-sample-rate", hz, "sampleRate", opts).then(
			() => {
				this.states.get(sourceId)!.sampleRate = hz
			},
		)
	}

	setGainMode(
		sourceId: string,
		mode: "agc" | "manual",
		opts?: TunerWriteOptions,
	): Promise<void> {
		return this.write(
			sourceId,
			"set-gain-mode",
			mode === "manual" ? 1 : 0,
			"gainMode",
			opts,
		).then(() => {
			this.states.get(sourceId)!.gainMode = mode
		})
	}

	setGain(
		sourceId: string,
		tenthsDb: number,
		opts?: TunerWriteOptions,
	): Promise<void> {
		return this.write(sourceId, "set-gain", tenthsDb, "gain", opts).then(() => {
			this.states.get(sourceId)!.gain = tenthsDb
		})
	}

	setAgcMode(
		sourceId: string,
		enabled: boolean,
		opts?: TunerWriteOptions,
	): Promise<void> {
		return this.write(
			sourceId,
			"set-agc-mode",
			enabled ? 1 : 0,
			"agcMode",
			opts,
		).then(() => {
			this.states.get(sourceId)!.agcMode = enabled
		})
	}

	setTestMode(
		sourceId: string,
		enabled: boolean,
		opts?: TunerWriteOptions,
	): Promise<void> {
		const after = enabled ? this.afterTestModeOn : null
		if (enabled) this.afterTestModeOn = null
		return this.write(
			sourceId,
			"set-test-mode",
			enabled ? 1 : 0,
			null,
			opts,
		).then(() => after?.())
	}
}

/** EpochClock double recording submitted epochs and the suppression depth. */
export class FakeClock implements EpochClock {
	readonly submitted: PendingEpoch[] = []
	suppressed = 0
	markerSupported: boolean | null = null
	private epoch = 0
	private sample = 0
	centreHz = 446_100_000

	sampleClock() {
		this.sample += 1000
		return {
			commandSample: this.sample,
			bufferedSamples: 64,
			sampleRateHz: 2_048_000,
		}
	}
	allocateEpoch(): number {
		this.epoch += 1
		return this.epoch
	}
	submitEpoch(p: PendingEpoch): void {
		this.submitted.push(p)
		this.centreHz = p.centreHz
	}
	suppressExternal(on: boolean): void {
		this.suppressed += on ? 1 : -1
	}
	currentEpoch(): EngineEpoch {
		return {
			stream: 0,
			epoch: this.epoch,
			startSample: 0,
			centreHz: this.centreHz,
			sampleRateHz: 2_048_000,
			gainKey: "m:296",
			tuningTrust: "commanded",
			settleMode: "marker",
		}
	}
}
