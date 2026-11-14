export interface P25Call {
	nac: number
	talkgroup: number
	source: number
	ldus?: number
}
export function p25NidBits(nac: number, duid: number): number[]
export function rs63Parity(data: number[], tt: number): number[]
export function hamming1063(hex: number): number[]
export function p25GroupVoiceLc(call: {
	talkgroup: number
	source: number
	serviceOptions?: number
}): number[]
export function p25Ldu1Dibits(frame: {
	nac: number
	lc: number[]
	seed?: number
}): number[]
export function p25TduDibits(frame: { nac: number }): number[]
export function p25CallDibits(call: P25Call): number[]
export const p25Deviation: (dibit: number) => number
export function p25Frequency(
	call: P25Call,
	options?: { rateHz?: number },
): Float64Array
