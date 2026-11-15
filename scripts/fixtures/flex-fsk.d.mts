export interface FlexPage {
	capcode: number
	message: string
	cycle?: number
	frame?: number
}
export function flexCodeword(data21: number): number
export function flexPageWords(page: FlexPage): number[]
export function flexFrameBits(page: FlexPage): number[]
export function flexFrequency(
	page: FlexPage,
	options?: { deviationHz?: number; rateHz?: number },
): Float64Array
