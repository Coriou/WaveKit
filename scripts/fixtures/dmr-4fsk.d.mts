import type { PulseShape } from "./fsk-iq.mjs"
export interface DmrCall {
	colourCode?: number
	talkgroup: number
	source: number
	superframes?: number
	headers?: number
	settle?: number
	seed?: number
}
export const DMR_DATA_TYPE: {
	voiceLcHeader: number
	terminatorLc: number
	idle: number
}
export function hamming74(data: number[]): number[]
export function golay208(data: number[]): number[]
export function qr167(data: number[]): number[]
export function rs129Parity(bytes: number[]): number[]
export function dmrGroupVoiceLc(call: {
	talkgroup: number
	source: number
}): number[]
export function bptc19696(bits96: number[]): number[]
export function embeddedLcFragments(lcBytes: number[]): number[][]
export function cachBits(slot: number): number[]
export function dataBurstBits(burst: {
	colourCode: number
	dataType: number
	info96: number[]
	sync?: number
}): number[]
export function lcInfoBits(lcBytes: number[], mask: number): number[]
export function voiceBurstBits(burst: {
	index: number
	colourCode: number
	fragments: number[][]
	random: () => number
	sync?: number
}): number[]
export function dmrCallDibits(call: DmrCall): number[]
export function dmrFrequency(
	call: DmrCall,
	options?: { rateHz?: number; shape?: PulseShape },
): Float64Array
export const DMR_DIRECT_BURST_SYMBOLS: number
export const DMR_DIRECT_FRAME_SYMBOLS: number
export const DMR_KEYED_OFF: number
export function dmrDirectCallDibits(call: Omit<DmrCall, "settle">): number[]
export function dmrDirectFrequency(
	call: Omit<DmrCall, "settle">,
	options?: { rateHz?: number; shape?: PulseShape },
): Float64Array
export function dmrDirectEnvelope(
	call: Omit<DmrCall, "settle">,
	options?: { rateHz?: number; rampSeconds?: number; padSymbols?: number },
): Float64Array
