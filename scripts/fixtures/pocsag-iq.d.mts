export function pocsagCodeword(data21: number): number
export function pocsagBits(page: {
	address: number
	func?: number
	message: string
}): number[]
export function synthesizePocsagCu8(options?: {
	sampleRateHz?: number
	offsetHz?: number
	baud?: number
	deviationHz?: number
	address?: number
	message?: string
	leadSeconds?: number
	noise?: number
	seed?: number
}): Buffer
