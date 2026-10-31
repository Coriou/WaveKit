export interface AcarsBlock {
	mode?: string
	address?: string
	label?: string
	blockId?: string
	msgno?: string
	flight?: string
	text?: string
}
/** Fictional blocks for `--message`: the default H1 downlink, a `_d` link test, an uplink. */
export const ACARS_PRESETS: Readonly<
	Record<"h1" | "link-test" | "uplink", AcarsBlock>
>
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
