import {
	DECODER_MAX_BANDPLAN_CHANNELS,
	placementCostCores,
	placementKey,
} from "./contract.js"
import type {
	PlannerDecoder,
	PlannerSource,
	PlacementPlanner,
	BandplanChannelLookup,
	WantedPlacement,
} from "./contract.js"
import {
	ADSB_FREQUENCY_HZ,
	READSB_REACH_HZ,
} from "../../core/rate-policy-contract.js"

const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0
const nonnegative = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n >= 0

function windowValid(s: PlannerSource): boolean {
	return (
		s != null &&
		positive(s.centreHz) &&
		positive(s.sampleRateHz) &&
		positive(s.usableFraction) &&
		s.usableFraction <= 1
	)
}

// These are internal contract inputs, not a second config parser. Reject missing
// policy facts rather than accidentally treating them as permission to place.
function validSource(s: PlannerSource): boolean {
	return (
		s != null &&
		typeof s.id === "string" &&
		s.id.length > 0 &&
		Number.isFinite(s.order) &&
		typeof s.dedicatedScanner === "boolean" &&
		typeof s.held === "boolean" &&
		typeof s.channelizerAvailable === "boolean" &&
		(s.reservedBy === null || typeof s.reservedBy === "string")
	)
}

function validDecoder(d: PlannerDecoder): boolean {
	return (
		d != null &&
		typeof d.id === "string" &&
		d.id.length > 0 &&
		typeof d.type === "string" &&
		Number.isFinite(d.order) &&
		(d.origin === "config" || d.origin === "catalogue") &&
		(d.startMode === "auto" || d.startMode === "operator") &&
		(d.configuredSourceId === null ||
			typeof d.configuredSourceId === "string") &&
		typeof d.unavailable === "boolean" &&
		typeof d.ownDevice === "boolean" &&
		typeof d.channelPlacements === "boolean" &&
		Array.isArray(d.configuredChannelsHz) &&
		Array.isArray(d.protocols) &&
		(d.reach === "raw" || d.reach === "centre" || d.reach === "channel")
	)
}

function lookupChannels(
	lookup: BandplanChannelLookup,
	window: Parameters<BandplanChannelLookup>[0],
	protocols: readonly string[],
): readonly number[] {
	try {
		const result = lookup(window, protocols)
		return Array.isArray(result) ? result : []
	} catch {
		return []
	}
}

/** Physical reach only: mode, band policy and source ownership are separate terms. */
export function fitsReach(
	d: PlannerDecoder,
	s: PlannerSource,
	channelHz: number | null,
): boolean {
	if (!d || !windowValid(s)) return false
	const centre = s.centreHz!
	if (d.reach === "raw") {
		return (
			d.type !== "readsb" ||
			Math.abs(ADSB_FREQUENCY_HZ - centre) <= READSB_REACH_HZ
		)
	}
	if (d.reach === "centre") {
		const slot = d.centreSlotHz
		return (
			!!slot &&
			positive(slot.minHz) &&
			positive(slot.maxHz) &&
			slot.minHz <= slot.maxHz &&
			positive(d.centrePassbandHz) &&
			slot.minHz >= centre - d.centrePassbandHz / 2 &&
			slot.maxHz <= centre + d.centrePassbandHz / 2
		)
	}
	return (
		d.reach === "channel" &&
		positive(channelHz) &&
		positive(d.channelBandwidthHz) &&
		nonnegative(d.channelTransitionHz) &&
		Math.abs(channelHz - centre) +
			d.channelBandwidthHz / 2 +
			d.channelTransitionHz <=
			(s.sampleRateHz! * s.usableFraction) / 2
	)
}

function bandFits(d: PlannerDecoder, hz: number, halfWidth = 0): boolean {
	if (d.mode === "always" || d.startMode === "operator" || d.band === undefined)
		return true
	const targets = Array.isArray(d.band?.targetsHz) ? d.band.targetsHz : []
	const ranges = Array.isArray(d.band?.rangesHz) ? d.band.rangesHz : []
	if (targets.some(f => positive(f) && Math.abs(f - hz) <= halfWidth))
		return true
	if (
		d.band?.followCenter === true &&
		targets.length > 0 &&
		targets.every(positive) &&
		hz >= Math.min(...targets) - halfWidth &&
		hz <= Math.max(...targets) + halfWidth
	)
		return true
	return ranges.some(
		r =>
			r != null &&
			positive(r.minHz) &&
			positive(r.maxHz) &&
			r.minHz <= r.maxHz &&
			hz >= r.minHz - halfWidth &&
			hz <= r.maxHz + halfWidth,
	)
}

type Candidate = {
	source: PlannerSource
	hz: number | null
	reach: WantedPlacement["reach"]
	origin: WantedPlacement["origin"]
	index: number
}
const originOrder = { configured: 0, band: 1, vfo: 2, bandplan: 3, fallback: 4 }
const decoderClass = (d: PlannerDecoder) =>
	d.startMode === "operator" ? 0 : d.mode === "always" ? 1 : 2

export const planPlacements: PlacementPlanner = input => {
	const wanted: WantedPlacement[] = []
	const unplaced = new Map<
		string,
		"decoder-unavailable" | "channelizer-unavailable" | "frequency-out-of-band"
	>()
	const decoders = input.decoders
		.filter(validDecoder)
		.sort((a, b) => decoderClass(a) - decoderClass(b) || a.order - b.order)
	for (const d of decoders) {
		if (d.mode === "off" || d.ownDevice) continue
		if (d.unavailable) {
			unplaced.set(d.id, "decoder-unavailable")
			continue
		}
		if (d.mode !== "auto" && d.mode !== "always") continue
		const sources = input.sources.filter(
			s =>
				validSource(s) &&
				(d.configuredSourceId !== null
					? s.id === d.configuredSourceId
					: s.dedicatedScanner === false &&
						(s.reservedBy === null || s.reservedBy === d.id)) &&
				windowValid(s),
		)
		const candidates: Candidate[] = []
		let channelizerMissing = false
		for (const s of sources) {
			const centre = s.centreHz!
			const half = (s.sampleRateHz! * s.usableFraction) / 2
			const local: Candidate[] = []
			const add = (
				hz: number | null,
				origin: Candidate["origin"],
				index = 0,
				bandChannels?: readonly number[],
			) => {
				if (
					fitsReach(d, s, hz) &&
					(bandChannels
						? bandChannels.every(f => bandFits(d, f))
						: bandFits(d, hz ?? centre, d.reach === "channel" ? 0 : half))
				)
					local.push({ source: s, hz, reach: d.reach, origin, index })
			}
			if (
				d.reach === "channel" &&
				(d.channelPlacements !== true || s.channelizerAvailable !== true)
			) {
				if (d.origin === "config") {
					if (bandFits(d, centre, half))
						local.push({
							source: s,
							hz: null,
							reach: "raw",
							origin: "configured",
							index: 0,
						})
				} else channelizerMissing = true
			} else if (d.reach !== "channel") {
				add(null, "band")
			} else {
				const configured = d.configuredChannelsHz.filter(positive)
				if (d.type === "ais-catcher") add(162_000_000, "band")
				else if (d.type === "dumpvdl2" && configured.length)
					add(
						(Math.min(...configured) + Math.max(...configured)) / 2,
						"configured",
						0,
						configured,
					)
				else if (d.type === "rtl433") {
					for (const r of Array.isArray(d.band?.rangesHz)
						? d.band.rangesHz
						: []) {
						if (
							!r ||
							!positive(r.minHz) ||
							!positive(r.maxHz) ||
							r.minHz > r.maxHz
						)
							continue
						const min = Math.max(r.minHz, centre - half)
						const max = Math.min(r.maxHz, centre + half)
						if (min <= max) add((min + max) / 2, "band")
					}
				} else if (d.type === "direwolf") {
					configured.forEach((hz, i) => add(hz, "configured", i))
					for (const hz of Array.isArray(d.band?.targetsHz)
						? d.band.targetsHz
						: [])
						add(hz, "band")
				} else configured.forEach((hz, i) => add(hz, "configured", i))
				if (d.type === "dsd-fme" || d.type === "multimon-ng") {
					const cap =
						Number.isInteger(input.maxBandplanChannels) &&
						input.maxBandplanChannels >= 0
							? Math.min(
									input.maxBandplanChannels,
									DECODER_MAX_BANDPLAN_CHANNELS,
								)
							: 0
					const channels = [
						...new Set(
							lookupChannels(
								input.bandplanChannels,
								{ sourceId: s.id, minHz: centre - half, maxHz: centre + half },
								d.protocols,
							),
						),
					]
						.filter(
							hz => positive(hz) && fitsReach(d, s, hz) && bandFits(d, hz),
						)
						.sort(
							(a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b,
						)
					if (input.vfo?.sourceId === s.id) {
						const hz = input.vfo.frequencyHz
						// The lookup exposes channels, not scanner-range bounds, and a
						// declared band is no proof of a pager range: auto pager VFOs need
						// an exact listed-channel match.
						if (
							d.type !== "multimon-ng" ||
							d.mode === "always" ||
							d.startMode === "operator" ||
							channels.includes(hz)
						)
							add(hz, "vfo")
					}
					channels.slice(0, cap).forEach((hz, i) => add(hz, "bandplan", i))
				}
			}
			candidates.push(...local)
		}
		if (
			!candidates.length &&
			d.reach === "channel" &&
			(d.mode === "always" || d.startMode === "operator")
		) {
			for (const s of [...sources].sort(
				(a, b) => Number(a.held) - Number(b.held) || a.order - b.order,
			)) {
				if (s.channelizerAvailable !== true || d.channelPlacements !== true)
					continue
				const hz =
					(d.type === "dsd-fme" || d.type === "multimon-ng") &&
					input.vfo?.sourceId === s.id
						? input.vfo.frequencyHz
						: s.centreHz!
				if (!fitsReach(d, s, hz)) continue
				candidates.push({
					source: s,
					hz,
					reach: "channel",
					origin: "fallback",
					index: 0,
				})
				break
			}
		}
		const chosen = new Map<string, Candidate>()
		const hasChannel = candidates.some(c => c.reach === "channel")
		for (const c of candidates) {
			if (hasChannel && c.reach === "raw") continue
			const key = c.hz === null ? c.reach : String(c.hz)
			const old = chosen.get(key)
			const distance = (c: Candidate) => {
				const target =
					c.hz ??
					(d.type === "readsb"
						? ADSB_FREQUENCY_HZ
						: d.centreSlotHz
							? (d.centreSlotHz.minHz + d.centreSlotHz.maxHz) / 2
							: c.source.centreHz!)
				return Math.abs(target - c.source.centreHz!)
			}
			const preference = (a: Candidate, b: Candidate) =>
				Number(a.source.held) - Number(b.source.held) ||
				distance(a) - distance(b) ||
				a.source.order - b.source.order ||
				originOrder[a.origin] - originOrder[b.origin] ||
				a.index - b.index
			if (!old) chosen.set(key, c)
			else {
				const preferred = preference(c, old) < 0 ? c : old
				const first =
					originOrder[c.origin] < originOrder[old.origin] ||
					(c.origin === old.origin && c.index < old.index)
						? c
						: old
				chosen.set(key, {
					...preferred,
					origin: first.origin,
					index: first.origin === "bandplan" ? preferred.index : first.index,
				})
			}
		}
		const sorted = [...chosen.values()].sort(
			(a, b) =>
				originOrder[a.origin] - originOrder[b.origin] ||
				(a.origin === "band" ? (a.hz ?? 0) - (b.hz ?? 0) : a.index - b.index) ||
				a.source.order - b.source.order,
		)
		sorted.forEach((c, i) =>
			wanted.push({
				key: placementKey(d.id, c.source.id, c.reach, c.hz),
				decoderId: d.id,
				sourceId: c.source.id,
				channelHz: c.hz,
				reach: c.reach,
				origin: c.origin,
				primary: i === 0,
				costCores: placementCostCores(d.type, c.reach),
				sampleRateHz: c.source.sampleRateHz!,
			}),
		)
		if (!sorted.length) {
			if (channelizerMissing) unplaced.set(d.id, "channelizer-unavailable")
			else if (
				sources.length &&
				d.mode !== "always" &&
				d.startMode !== "operator"
			)
				unplaced.set(d.id, "frequency-out-of-band")
		}
	}
	return { wanted, unplaced }
}
