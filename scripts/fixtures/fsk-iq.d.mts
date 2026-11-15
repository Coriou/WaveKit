export function rng(seed: number): () => number
export interface PulseShape {
	shaping: "rc" | "rrc" | "c4fm"
	alpha: number
	isinc?: boolean
}
export const AIR_SHAPES: {
	p25: PulseShape
	p25Rc: PulseShape
	dmr: PulseShape
	dpmr: PulseShape
	nxdn: PulseShape
	ysf: PulseShape
	ysfC4fm: PulseShape
}
export const EASY_SHAPE: PulseShape
export function pulseSpectrum(x: number, shape: PulseShape): number
export function receiveSpectrum(x: number, shape: PulseShape): number
export function pulseResponse(
	t: number,
	spectrum: (x: number) => number,
	alpha: number,
	steps?: number,
): number
export function noiseForCnr(options: {
	cnrDb: number
	sampleRateHz: number
	noiseBandwidthHz?: number
	rms?: number
}): { amplitude: number; noise: number }
export function shapeFrequency(
	symbols: number[],
	options: {
		symbolRate: number
		deviationHz: (symbol: number) => number
		rateHz?: number
		shaping?: "rc" | "rrc" | "c4fm" | "gauss" | "rect"
		alpha?: number
		isinc?: boolean
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
		cnrDb?: number
		noiseBandwidthHz?: number
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
