export interface AcarsBlock {
	mode?: string
	address?: string
	label?: string
	blockId?: string
	text?: string
}
export function oddParity(c: number): number
export function acarsCrc(bytes: readonly number[]): number
export function acarsBytes(options?: AcarsBlock): number[]
export function acarsAudio(
	options?: AcarsBlock,
	rate?: number,
	leadSeconds?: number,
): Float32Array
export function acarsS16(options?: AcarsBlock): Buffer
export function acarsCf32(
	options?: AcarsBlock,
	offsetHz?: number,
	amplitude?: number,
): Buffer
