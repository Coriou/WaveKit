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

/**
 * centre ± sampleRate/2, each the first positive value of: centre TunerState →
 * caps.centerFreq → relay.lastFrequency; rate TunerState → caps. A 0 means unknown (R44).
 */
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
	const positive = (x: number | undefined): x is number =>
		x !== undefined && Number.isFinite(x) && x > 0
	// A tuner that reports 0 does not know its frequency (R44): fall through.
	const centreHz = [t?.frequency, s?.caps.centerFreq, relayFreq].find(positive)
	const sampleRate = [t?.sampleRate, s?.caps.sampleRate].find(positive)
	if (!positive(centreHz) || !positive(sampleRate)) return null
	return {
		sourceId,
		centreHz,
		sampleRate,
		loHz: centreHz - sampleRate / 2,
		hiHz: centreHz + sampleRate / 2,
	}
}

/**
 * The live assignment, else the decoder's declared sourceId (R15), else the
 * single source when exactly one exists. `declared` is required so callers
 * cannot forget it; prefer `rowSourceId` for a DecoderRow.
 */
export function decoderSourceId(
	decoderId: string,
	sources: readonly ExtendedSourceStatus[] | undefined,
	declared: string | undefined,
): string | null {
	if (!sources) return null
	for (const s of sources)
		if (s.assignments.some(a => a.decoderId === decoderId)) return s.id
	if (declared !== undefined) return declared
	return sources.length === 1 ? (sources[0]?.id ?? null) : null
}

/** The one source resolver for a decoder row; membership and retune impact both use it. */
export function rowSourceId(
	d: Pick<DecoderRow, "id" | "sourceId">,
	sources: readonly ExtendedSourceStatus[] | undefined,
): string | null {
	return decoderSourceId(d.id, sources, d.sourceId)
}

/** External input: the decoder owns its device (caps.input "external" or pattern "external_sdr"). */
export function isExternalDecoder(d: Pick<DecoderRow, "caps">): boolean {
	return (
		d.caps?.input === "external" ||
		d.caps?.integrationPattern === "external_sdr"
	)
}

function isAssigned(
	id: string,
	sources: readonly ExtendedSourceStatus[] | undefined,
): boolean {
	return (
		sources?.some(s => s.assignments.some(a => a.decoderId === id)) ?? false
	)
}

/** Not on a shared source: external and with no assignment (spec §10.9 `—`). */
function offSharedSource(
	d: DecoderRow,
	sources: readonly ExtendedSourceStatus[] | undefined,
): boolean {
	return isExternalDecoder(d) && !isAssigned(d.id, sources)
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
	if (offSharedSource(d, sources)) return "—"
	const band = decoderBand(d)?.band
	if (band?.kind === "tuned") return "in"
	const sid = rowSourceId(d, sources)
	if (sid === null) return "?"
	return membership(band, windowFor(sid, tuners, sources, relay))
}

export interface RetuneImpact {
	/** Tuned types: they follow the centre, whatever their configured targets (R40). */
	tuned: string[]
	enters: string[]
	leaves: string[]
	/** Membership unknown before or after (no band, or `from` is null): never claimed as entering or leaving. */
	unknown: string[]
}

/** The decoders a retune of `sourceId` can affect: on that source (rowSourceId) and on a shared source. */
export function retuneCandidates(
	decoders: readonly DecoderRow[],
	sources: readonly ExtendedSourceStatus[] | undefined,
	sourceId: string,
): DecoderRow[] {
	return decoders.filter(
		d => !offSharedSource(d, sources) && rowSourceId(d, sources) === sourceId,
	)
}

/**
 * Preconditions: `decoders` are the retuned source's candidates
 * (`retuneCandidates`), `from` is that source's current window or null when
 * unknown, and `to` is the proposed window.
 */
export function retuneImpact(
	decoders: ReadonlyArray<{ id: string } & BandSubject>,
	from: TunedWindow | null,
	to: TunedWindow,
): RetuneImpact {
	const out: RetuneImpact = { tuned: [], enters: [], leaves: [], unknown: [] }
	for (const d of decoders) {
		const band = decoderBand(d)?.band
		if (band?.kind === "tuned") {
			out.tuned.push(d.id)
			continue
		}
		const before = membership(band, from)
		const after = membership(band, to)
		if (before === "?" || after === "?") out.unknown.push(d.id)
		else if (before === "out" && after === "in") out.enters.push(d.id)
		else if (before === "in" && after === "out") out.leaves.push(d.id)
	}
	return out
}
