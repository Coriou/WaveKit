import type {
	ExtendedSourceStatus,
	TunerRelayStatus,
	TunerState,
} from "@wavekit/api-types"
import {
	decoderBand,
	type BandSubject,
	type NominalBand,
} from "./nominal-bands.js"
import type { DecoderRow } from "./types.js"

export interface TunedWindow {
	sourceId: string
	centreHz: number
	sampleRate: number
	loHz: number
	hiHz: number
}

/** centre ± sampleRate/2. Centre: TunerState → caps.centerFreq → relay.lastFrequency. Rate: TunerState → caps. */
export function windowFor(
	sourceId: string,
	tuners: readonly TunerState[] | undefined,
	sources: readonly ExtendedSourceStatus[] | undefined,
	relay: TunerRelayStatus | undefined,
): TunedWindow | null {
	const t = tuners?.find(x => x.sourceId === sourceId)
	const s = sources?.find(x => x.id === sourceId)
	const relayFreq =
		relay && (relay.sourceId === undefined || relay.sourceId === sourceId)
			? relay.lastFrequency
			: undefined
	const centreHz = t?.frequency ?? s?.caps.centerFreq ?? relayFreq
	const sampleRate = t?.sampleRate ?? s?.caps.sampleRate
	if (centreHz === undefined || sampleRate === undefined || sampleRate <= 0)
		return null
	return {
		sourceId,
		centreHz,
		sampleRate,
		loHz: centreHz - sampleRate / 2,
		hiHz: centreHz + sampleRate / 2,
	}
}

/** The live assignment, else the decoder's declared sourceId (R15), else the single source when exactly one exists. */
export function decoderSourceId(
	decoderId: string,
	sources: readonly ExtendedSourceStatus[] | undefined,
	declared?: string,
): string | null {
	if (!sources) return null
	for (const s of sources)
		if (s.assignments.some(a => a.decoderId === decoderId)) return s.id
	if (declared !== undefined) return declared
	return sources.length === 1 ? (sources[0]?.id ?? null) : null
}

export type Membership = "in" | "out" | "?" | "—"

export function membership(
	band: NominalBand | undefined,
	win: TunedWindow | null,
): Membership {
	if (band?.kind === "tuned") return "in"
	if (!band || !win) return "?"
	const half = win.sampleRate / 2
	return band.channelsMHz.some(c => Math.abs(c * 1e6 - win.centreHz) <= half)
		? "in"
		: "out"
}

export function decoderMembership(
	d: DecoderRow,
	sources: readonly ExtendedSourceStatus[] | undefined,
	tuners: readonly TunerState[] | undefined,
	relay: TunerRelayStatus | undefined,
): Membership {
	const assigned =
		sources?.some(s => s.assignments.some(a => a.decoderId === d.id)) ?? false
	if (d.caps?.integrationPattern === "external_sdr" && !assigned) return "—"
	const band = decoderBand(d)?.band
	if (band?.kind === "tuned") return "in"
	const sid = decoderSourceId(d.id, sources, d.sourceId)
	if (sid === null) return "?"
	return membership(band, windowFor(sid, tuners, sources, relay))
}

export interface RetuneImpact {
	tuned: string[]
	enters: string[]
	leaves: string[]
}

export function retuneImpact(
	decoders: ReadonlyArray<{ id: string } & BandSubject>,
	from: TunedWindow | null,
	to: TunedWindow,
): RetuneImpact {
	const out: RetuneImpact = { tuned: [], enters: [], leaves: [] }
	for (const d of decoders) {
		const band = decoderBand(d)?.band
		if (band?.kind === "tuned") {
			out.tuned.push(d.id)
			continue
		}
		const before = membership(band, from) === "in"
		const after = membership(band, to) === "in"
		if (!before && after) out.enters.push(d.id)
		if (before && !after) out.leaves.push(d.id)
	}
	return out
}
