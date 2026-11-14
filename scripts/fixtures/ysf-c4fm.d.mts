export interface YsfCall {
	dest: string
	src: string
	dgid?: number
	frames?: number
}
export function golay2412(data: number[]): number[]
export function ysfCrc(bits: number[]): number[]
export function pn95(n: number): number[]
export function conv5Dibits(bits: number[]): number[]
export function ysfFichDibits(fich: {
	fi: number
	cm?: number
	bn?: number
	bt?: number
	fn?: number
	ft?: number
	dt?: number
	vp?: number
	mr?: number
	dgid?: number
}): number[]
export function ysfHeaderDibits(frame: {
	fi: number
	dest: string
	src: string
	dgid?: number
}): number[]
export function ysfVd2Dibits(frame: {
	fn: number
	ft: number
	dest: string
	src: string
	dgid?: number
	seed?: number
}): number[]
export function ysfCallDibits(call: YsfCall): number[]
export function ysfFrequency(
	call: YsfCall,
	options?: { rateHz?: number },
): Float64Array
