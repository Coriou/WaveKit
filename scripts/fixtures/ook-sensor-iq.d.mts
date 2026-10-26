export function sensorBits(frame: {
	id: number
	status: number
	tempC: number
	humidity: number
}): number[]
export function synthesizeOokSensor(options?: {
	sampleRateHz?: number
	offsetHz?: number
	id?: number
	status?: number
	tempC?: number
	humidity?: number
	repeats?: number
	leadSeconds?: number
	amplitude?: number
	noise?: number
	seed?: number
}): Float32Array
export function shortPulseBits(frame: {
	id: number
	channel: number
	tempC: number
	humidity: number
}): number[]
export function synthesizeShortPulseSensor(options?: {
	sampleRateHz?: number
	offsetHz?: number
	id?: number
	channel?: number
	tempC?: number
	humidity?: number
	repeats?: number
	leadSeconds?: number
	amplitude?: number
	noise?: number
	seed?: number
}): Float32Array
export function toCf32(samples: Float32Array): Buffer
export function toCu8(samples: Float32Array): Buffer
