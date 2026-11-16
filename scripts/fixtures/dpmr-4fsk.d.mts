import type { PulseShape } from "./fsk-iq.mjs"
export interface DpmrCall {
	calledId: string
	callingId: string
	colourCode: number
	superframes?: number
	seed?: number
	/** A true key-up: no pre-roll (dv-plan.mjs). */
	coldKeyUp?: boolean
}
export function dpmrAirId(digits: string): number
export function dpmrCrc7(bits: number[]): number[]
export function dpmrCchBits(cch: { fn: number; idPart: number }): number[]
export function dpmrCallDibits(call: DpmrCall): number[]
export function dpmrFrequency(
	call: DpmrCall,
	options?: { rateHz?: number; shape?: PulseShape },
): Float64Array
