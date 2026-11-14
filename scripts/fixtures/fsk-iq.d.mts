export function rng(seed: number): () => number
export function shapeFrequency(
	symbols: number[],
	options: {
		symbolRate: number
		deviationHz: (symbol: number) => number
		rateHz?: number
		shaping?: "rc" | "gauss" | "rect"
		alpha?: number
		bt?: number
		padSymbols?: number
	},
): Float64Array
export function afskFrequency(
	bits: number[],
	options?: {
		baud?: number
		markHz?: number
		spaceHz?: number
		deviationHz?: number
		rateHz?: number
		padSeconds?: number
	},
): Float64Array
export function fmCu8(
	freqHz: Float64Array,
	options?: {
		freqRateHz?: number
		sampleRateHz?: number
		offsetHz?: number
		amplitude?: number
		noise?: number
		seed?: number
		leadSeconds?: number
	},
): Buffer
export function fmAudioS16(
	freqHz: Float64Array,
	options?: { rateHz?: number; gain?: number },
): Buffer
export function bitsOf(value: number, width: number): number[]
export function bytesToBits(bytes: number[]): number[]
export function bitsToDibits(bits: number[]): number[]
