export interface AprsPacket {
	source: string
	destination: string
	path?: string[]
	info: string
}
export function ax25Fcs(bytes: number[]): number
export function ax25UiFrame(packet: AprsPacket): number[]
export function ax25LineBits(
	frames: number[][],
	options?: { preambleFlags?: number; tailFlags?: number },
): number[]
export function aprsFrequency(
	packet: AprsPacket,
	options?: { deviationHz?: number; rateHz?: number },
): Float64Array
