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
export function dstarSlowDataBits(
	header: DstarHeader,
	options?: { badFcs?: boolean },
): number[]
export function dstarBits(
	header: DstarHeader,
	options?: { superframes?: number; badFirstSlowData?: boolean },
): number[]
export function dstarSpecBits(
	header: DstarHeader,
	options?: { superframes?: number; text?: string },
): number[]
export function dstarFrequency(
	header: DstarHeader,
	options?: {
		superframes?: number
		badFirstSlowData?: boolean
		deviationHz?: number
		rateHz?: number
	},
): Float64Array
export function dstarOversFrequency(
	overs: {
		header: DstarHeader
		superframes?: number
		badFirstSlowData?: boolean
	}[],
	options?: { deviationHz?: number; rateHz?: number },
): Float64Array
export function dstarSpecFrequency(
	header: DstarHeader,
	options?: { superframes?: number; deviationHz?: number; rateHz?: number },
): Float64Array
