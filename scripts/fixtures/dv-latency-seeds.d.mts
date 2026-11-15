import type { DvScene, SentOver } from "./dv-plan.mjs"
export const LINE_LATENCY_MS: number
export const DV_SEED_FREQUENCY_HZ: number
export const DV_SEED_SCENES: string[]
export interface DvSeed {
	version: 1
	provisional: boolean
	note: string
	scene: string
	protocol: "dmr"
	frequencyHz: number
	overs: (Omit<SentOver, "ids"> & { clear: boolean; ids: SentOver["ids"] })[]
	lines: { atMs: number; text: string }[]
}
export function dmrSeed(scene: DvScene): DvSeed
export function dvSeeds(): { file: string; seed: DvSeed }[]
