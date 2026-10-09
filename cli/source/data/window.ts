import type {
	ExtendedSourceStatus,
	TunerRelayStatus,
	TunerState,
} from "@wavekit/api-types"
import {
	bandFor,
	decoderBand,
	type BandSubject,
	type NominalBand,
} from "./nominal-bands.js"
import type { BandAssessment, DecoderRow } from "./types.js"

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
	// A tuner that reports 0 does not know its frequency (R44), nor does one that lists
	// the field in unknownFields (a placeholder, R86): fall through.
	const unknown = new Set<string>(t?.unknownFields ?? [])
	const centreHz = [
		unknown.has("frequency") ? undefined : t?.frequency,
		s?.caps.centerFreq,
		relayFreq,
	].find(positive)
	const sampleRate = [
		unknown.has("sampleRate") ? undefined : t?.sampleRate,
		s?.caps.sampleRate,
	].find(positive)
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
	if (band.kind === "ranges")
		return band.rangesHz.some(
			r => win.centreHz >= r.minHz - half && win.centreHz <= r.maxHz + half,
		)
			? "in"
			: "out"
	return band.channelsMHz.some(c => Math.abs(c * 1e6 - win.centreHz) <= half)
		? "in"
		: "out"
}

const VERDICT: Readonly<Record<BandAssessment["verdict"], Membership>> = {
	"in-band": "in",
	"out-of-band": "out",
	unknown: "?",
}

/**
 * Older cores only (no bandAssessment): a tuned type demodulates the window
 * centre (R40). Under core's assessment every type is placed by core (R90).
 */
export function followsCentre(d: BandSubject): boolean {
	return d.bandAssessment === undefined && bandFor(d.type)?.kind === "tuned"
}

/** Core's usable fraction of a window (src/decoders/band-resolver.ts USABLE_WINDOW_FRACTION). */
const USABLE_FRACTION = 0.8

/**
 * Core's usable half-width at the draft rate, or null when it cannot be
 * placed. Same rate: core's value. A capture-limited half-width (0.4 × the
 * old rate) scales down with a lower rate, but never up: core takes
 * min(rate, frontend) and the API does not send the frontend. A narrower,
 * frontend-limited one stays, capped by the new capture. Anything else is
 * unknown (R90 I3, final M1).
 */
function coreHalfWidth(
	half: number | undefined,
	from: TunedWindow | null,
	to: TunedWindow,
): number | null {
	if (half === undefined || !from) return null
	if (to.sampleRate === from.sampleRate) return half
	const capture = (rate: number) => (rate * USABLE_FRACTION) / 2
	if (Math.abs(half - capture(from.sampleRate)) <= 1)
		return to.sampleRate < from.sampleRate ? capture(to.sampleRate) : null
	if (half < capture(from.sampleRate))
		return Math.min(half, capture(to.sampleRate))
	return null
}

/**
 * Membership at a draft window by core's own targets and usable half-width
 * (R84), never by ±rate/2: `?` when they are missing or cannot be placed.
 * Between targets is `?` too: a followCenter decoder is in band across its
 * targets' span, and the API does not say which decoders follow the centre.
 */
function coreMembershipAt(
	a: BandAssessment,
	from: TunedWindow | null,
	to: TunedWindow,
): Membership {
	const t = a.targetsHz
	const ranges = a.rangesHz
	const half = coreHalfWidth(a.windowHalfWidthHz, from, to)
	if ((!t && !ranges) || half === null) return "?"
	// R100: in band near any target, or with the centre within half of any range.
	if (t?.some(hz => Math.abs(hz - to.centreHz) <= half)) return "in"
	if (
		ranges?.some(
			r => to.centreHz >= r.minHz - half && to.centreHz <= r.maxHz + half,
		)
	)
		return "in"
	if (!t) return "out"
	const lo = Math.min(...t) - half
	const hi = Math.max(...t) + half
	return to.centreHz >= lo && to.centreHz <= hi ? "?" : "out"
}

/** R84: core's bandAssessment verdict when present (tuned types too); the nominal table otherwise. */
export function decoderMembership(
	d: DecoderRow,
	sources: readonly ExtendedSourceStatus[] | undefined,
	tuners: readonly TunerState[] | undefined,
	relay: TunerRelayStatus | undefined,
): Membership {
	if (offSharedSource(d, sources)) return "—"
	if (d.bandAssessment) return VERDICT[d.bandAssessment.verdict]
	const band = decoderBand(d)?.band
	if (band?.kind === "tuned") return "in"
	const sid = rowSourceId(d, sources)
	if (sid === null) return "?"
	return membership(band, windowFor(sid, tuners, sources, relay))
}

export interface RetuneImpact {
	/** Tuned types under an older core: they follow the centre, whatever their configured targets (R40, `followsCentre`). */
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
		// R90: core's verdict now and core's targets for the draft, for every type.
		if (followsCentre(d)) {
			out.tuned.push(d.id)
			continue
		}
		const a = d.bandAssessment
		const band = decoderBand(d)?.band
		const before = a ? VERDICT[a.verdict] : membership(band, from)
		const after = a ? coreMembershipAt(a, from, to) : membership(band, to)
		if (before === "?" || after === "?") out.unknown.push(d.id)
		else if (before === "out" && after === "in") out.enters.push(d.id)
		else if (before === "in" && after === "out") out.leaves.push(d.id)
	}
	return out
}
