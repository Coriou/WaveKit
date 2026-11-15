import type { PulseShape } from "./fsk-iq.mjs"
export interface NxdnCall {
	ran: number
	source: number
	destination: number
	superframes?: number
	release?: boolean
	seed?: number
}
export function nxdnCrc6(bits: number[]): number[]
export function nxdnCrc12(bits: number[]): number[]
export function nxdnSacchBits(sacch: {
	sf: number
	ran: number
	fragment: number[]
}): number[]
export function nxdnVcallBits(call: {
	source: number
	destination: number
	callType?: number
	voiceOption?: number
	messageType?: number
}): number[]
export function nxdnFacch1Bits(message: number[]): number[]
export function nxdnScramble(dibits: number[]): number[]
export function nxdnCallDibits(call: NxdnCall): number[]
export const NXDN_RATES: Record<
	"nxdn48" | "nxdn96",
	{ symbolRate: number; outerHz: number }
>
export function nxdnCallsDibits(
	calls: NxdnCall[],
	options?: { gapSymbols?: number },
): number[]
export function nxdnCallsFrequency(
	calls: NxdnCall[],
	options?: {
		variant?: "nxdn48" | "nxdn96"
		rateHz?: number
		shape?: PulseShape
		gapSymbols?: number
	},
): Float64Array
export function nxdnFrequency(
	call: NxdnCall,
	options?: {
		variant?: "nxdn48" | "nxdn96"
		rateHz?: number
		shape?: PulseShape
	},
): Float64Array
