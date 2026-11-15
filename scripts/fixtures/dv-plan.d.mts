import type { PulseShape } from "./fsk-iq.mjs"
export const KEYED_OFF: number
export const PAD_SYMBOLS: number
export type DvProtocol = "dmr" | "dstar" | "ysf" | "p25" | "nxdn48" | "dpmr"
export const DV_PROTOCOLS: DvProtocol[]
/** Identities of an over: DMR, P25, NXDN and dPMR talkgroup/source; YSF src; D-STAR my. */
export interface DvIds {
	talkgroup?: number
	source?: number
	src?: string
	my?: string
}
export interface PlanOver {
	startMs: number
	durationMs: number
	/** DMR only. */
	slot?: 1 | 2
	ids?: DvIds
	terminator?: boolean
	/** DMR only. */
	headers?: number
	/** DMR only: the voice burst it starts at (0 = A). */
	lateEntry?: number
}
/** An over as sent: the truth the harness scores against. */
export interface SentOver {
	index: number
	protocol: DvProtocol
	slot: 1 | 2 | null
	startMs: number
	endMs: number
	ids: DvIds
	frames: number
	terminator: boolean
}
export interface TransmissionPlan {
	protocol: DvProtocol
	symbolRate: number
	symbols: number[]
	freq: Float64Array
	envelope: Float64Array
	overs: SentOver[]
	durationMs: number
}
export function keyedEnvelope(
	symbols: number[],
	options: {
		symbolRate: number
		rateHz?: number
		rampSeconds?: number
		padSymbols?: number
	},
): Float64Array
export function transmissionPlan(
	overs: PlanOver[],
	options: {
		protocol: DvProtocol
		dmrMode?: "direct" | "repeater"
		hangMs?: number
		tailMs?: number
		rateHz?: number
		shape?: Partial<PulseShape> & { shaping?: string; bt?: number }
		trace?: boolean
	},
): TransmissionPlan
export const DV_OVER_MS: number[]
export const DV_GAPS_MS: number[]
export const DV_LEAD_MS: number
export const DV_APART_MS: number
export const DV_HANG_MS: number
export const DV_OTHER: { talkgroup: number; source: number }
export interface DvScene {
	name: string
	protocol: DvProtocol
	dmrMode?: "direct" | "repeater"
	hangMs?: number
	tailMs?: number
	overs: PlanOver[]
}
export const DV_SCENES: DvScene[]
export function scenePlan(
	scene: DvScene,
	options?: {
		rateHz?: number
		shape?: Partial<PulseShape> & { shaping?: string; bt?: number }
		trace?: boolean
	},
): TransmissionPlan
