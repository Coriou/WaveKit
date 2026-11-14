export interface DstarHeader {
	rpt2: string
	rpt1: string
	ur: string
	my: string
	suffix?: string
	flags?: number[]
}
export function dstarHeaderBytes(header: DstarHeader): number[]
export function dstarHeaderBits(header: DstarHeader): number[]
export function dstarSlowDataBits(header: DstarHeader): number[]
export function dstarBits(
	header: DstarHeader,
	options?: { superframes?: number },
): number[]
export function dstarFrequency(
	header: DstarHeader,
	options?: { superframes?: number; deviationHz?: number; rateHz?: number },
): Float64Array
