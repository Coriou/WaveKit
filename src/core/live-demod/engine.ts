import type { EngineFallbackReason, EngineName } from "./select-engine.js"

/**
 * One live-demodulator audio engine. The csdr chain stays inline in
 * `live-demodulator.ts` so that path is unchanged; `RustEngine` implements this.
 */
export interface DemodAudioUpdate {
	gain?: number
	deviationHz?: number
	deEmphasisUs?: 50 | 75 | null
	lowPassHz?: number | null
	highPassHz?: number | null
}

export interface DemodRetune {
	centerHz?: number
	bandwidthHz?: number
	modulation?: "nfm" | "am"
	audio?: DemodAudioUpdate
}

export interface DemodSquelch {
	mode: "off" | "power" | "noise"
	thresholdDbfs?: number
	hysteresisDb?: number
	hangMs?: number
	quietingDb?: number
	/**
	 * Tracked noise floor for the WG7 noise-tail rule. Absent leaves the
	 * native floor, `null` clears it, a finite number sets it.
	 */
	noiseFloorDbfs?: number | null
}

export interface LiveDemodEngineStatus {
	engine: EngineName
	engineFallback?: EngineFallbackReason
}

export interface LiveDemodEngine {
	applyRetune(update: DemodRetune): void
	applySquelch(update: DemodSquelch): void
	stop(): Promise<void>
	status(): LiveDemodEngineStatus
}
