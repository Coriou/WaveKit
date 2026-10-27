import {
	ACARSDEC_CATALOGUE_MAX_CHANNELS,
	DECODER_MAX_BANDPLAN_CHANNELS,
	MULTIMON_PAGING_MAX_CHANNELS,
	RTL433_CHANNEL_MIN_RATE_HZ,
	RTL433_CHANNEL_TARGET_RATE_HZ,
	RTL433_WINDOW_MAX_RATE_HZ,
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
import { rasterChannelsBetween } from "./paging-plan.js"
import {
	ACTIVITY_MAX_CANDIDATES,
	quantiseObservedCentre,
} from "./activity-contract.js"
import type { ActivityQuery, ActivitySnapshot } from "./activity-contract.js"
import {
	ACTIVITY_MAX_SLOTS,
	ACTIVITY_MOVE_WINDOW_MS,
	activityOrder,
	allocateActivitySlots,
	isActivityDecoder,
	placementActivity,
	readySnapshot,
	selectChannels,
} from "./activity-plan.js"
import type {
	ActivityGroupView,
	ActivityMove,
	PlacementActivity,
} from "./activity-plan.js"

/** Single-channel audio adapters; AIS/VDL2 and rtl433 retain their protocol windows. */
export const VFO_CHANNEL_TYPES: readonly string[] = [
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"acarsdec",
]

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
		(d.followVfo === undefined || typeof d.followVfo === "boolean") &&
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

/**
 * 3.14: a band-free channelised decoder tried a selected channel (configured, VFO, band-plan or
 * the fallback) that does not fit: a fit failure the band policy cannot excuse, wherever the
 * channel lies (a retune or a wider capture would hold it). Raw reach never counts.
 */
function bypassedChannel(d: PlannerDecoder, hz: number | null): boolean {
	return bandFree(d) && d.reach === "channel" && positive(hz)
}

/** `always`, an operator start or a band-suspension opt-out skip the band policy. */
const bandFree = (d: PlannerDecoder): boolean =>
	d.mode === "always" ||
	d.startMode === "operator" ||
	d.bandSuspension === false

/** The band has at least one target or range (otherwise unknown). */
function bandKnown(d: PlannerDecoder): boolean {
	return (
		(Array.isArray(d.band?.targetsHz) && d.band.targetsHz.length > 0) ||
		(Array.isArray(d.band?.rangesHz) && d.band.rangesHz.length > 0)
	)
}

function bandFits(d: PlannerDecoder, hz: number, halfWidth = 0): boolean {
	if (bandFree(d) || d.band === undefined) return true
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

/**
 * rtl_433 channel arithmetic (design 2026-10-25, Property 17): the widest
 * channel, at most `target` and at least 250 kHz, that fits the usable window
 * around the overlap of each range with the window. Ranges in order; largest
 * rate wins, ties by order. `overlap` is true when some range overlaps.
 */
/**
 * True when rtl_433 can read a capture at `rateHz` whole (window reach):
 * at least the narrowest rate it accepts, at most RTL433_WINDOW_MAX_RATE_HZ.
 */
export function rtl433WindowFits(rateHz: number): boolean {
	return (
		Number.isFinite(rateHz) &&
		rateHz >= RTL433_CHANNEL_MIN_RATE_HZ &&
		rateHz <= RTL433_WINDOW_MAX_RATE_HZ
	)
}

export function rtl433ChannelCandidate(
	source: {
		centreHz: number | null
		sampleRateHz: number | null
		usableFraction: number
	},
	ranges: readonly ({ minHz: number; maxHz: number } | null | undefined)[],
	target: number = RTL433_CHANNEL_TARGET_RATE_HZ,
): { hz: number; rateHz: number } | { overlap: boolean } {
	const c = source.centreHz
	const fs = source.sampleRateHz
	const u = source.usableFraction
	if (!positive(c) || !positive(fs) || !positive(u) || !positive(target))
		return { overlap: false }
	const h = (fs * u) / 2
	const rMin = RTL433_CHANNEL_MIN_RATE_HZ
	let best: { hz: number; rateHz: number } | null = null
	let overlap = false
	for (const range of ranges) {
		if (
			!range ||
			!Number.isFinite(range.minHz) ||
			!Number.isFinite(range.maxHz) ||
			range.minHz > range.maxHz
		)
			continue
		const lo = Math.max(range.minHz, c - h)
		const hi = Math.min(range.maxHz, c + h)
		if (lo > hi) continue
		overlap = true
		if (h < rMin / 2) continue
		const hz = Math.min(
			Math.max((lo + hi) / 2, c - h + rMin / 2),
			c + h - rMin / 2,
		)
		const rateHz =
			Math.floor(Math.min(target, 2 * (h - Math.abs(hz - c))) / 1000) * 1000
		if (rateHz < rMin) continue
		if (!best || rateHz > best.rateHz) best = { hz, rateHz }
	}
	return best ?? { overlap }
}

/**
 * 3.18: the pager decoder's paging raster channels in this capture's usable
 * window (the channelizer's, `sampleRate x usableFraction`, not Nyquist),
 * inside its band, each passband (`fitsReach`) inside the window, nearest
 * the capture centre first (ties: lower first), at most
 * MULTIMON_PAGING_MAX_CHANNELS. A `vfoHz` that is one of the fitting raster
 * channels comes first and always counts within the cap, however far it is
 * from the centre. `misfit`: a raster channel of the band lies in the window
 * but its passband does not fit (a fit failure, 3.14). Empty unless the
 * decoder is multimon-ng with channel reach, no configured channels and a
 * paging raster, and the source has a channelizer.
 */
export function pagingChannels(
	d: PlannerDecoder,
	s: PlannerSource,
	vfoHz: number | null = null,
	limit: number = MULTIMON_PAGING_MAX_CHANNELS,
): { channels: number[]; misfit: boolean } {
	const none = { channels: [], misfit: false }
	if (
		!d ||
		d.type !== "multimon-ng" ||
		d.reach !== "channel" ||
		!Array.isArray(d.pagingRaster) ||
		d.pagingRaster.length === 0 ||
		d.configuredChannelsHz.length > 0 ||
		(d.origin === "config" && d.followVfo === false) ||
		!windowValid(s) ||
		s.channelizerAvailable !== true
	)
		return none
	const centre = s.centreHz!
	const half = (s.sampleRateHz! * s.usableFraction) / 2
	const inBand = rasterChannelsBetween(
		d.pagingRaster,
		centre - half,
		centre + half,
	).filter(hz => bandFits(d, hz))
	const fit = inBand.filter(hz => fitsReach(d, s, hz))
	const nearest = fit.sort(
		(a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b,
	)
	// Membership before the cap: an on-raster VFO is never cut for nearer ones.
	const ordered =
		vfoHz !== null && fit.includes(vfoHz)
			? [vfoHz, ...nearest.filter(hz => hz !== vfoHz)]
			: nearest
	return {
		channels: ordered.slice(0, limit),
		misfit: fit.length < inBand.length,
	}
}

/** A pager decoder's paging raster is in this window but no channel of it fits (3.14, 3.18). */
function pagingTooNarrow(d: PlannerDecoder, s: PlannerSource): boolean {
	const paging = pagingChannels(d, s)
	return paging.misfit && paging.channels.length === 0
}

/**
 * 3.20: catalogue acarsdec's channels in this capture's usable window
 * (`sampleRate x usableFraction`), inside its band, each passband fitting the
 * window, nearest the capture centre first (ties: lower first), at most
 * ACARSDEC_CATALOGUE_MAX_CHANNELS. Channels outside the window are not
 * candidates. `misfit`: a channel in the window whose passband does not fit
 * (a fit failure, 3.14). Empty unless the decoder is catalogue acarsdec with
 * channel reach.
 */
export function acarsCatalogueChannels(
	d: PlannerDecoder,
	s: PlannerSource,
): { channels: number[]; misfit: boolean } {
	const none = { channels: [], misfit: false }
	if (
		!d ||
		d.type !== "acarsdec" ||
		d.origin !== "catalogue" ||
		d.reach !== "channel" ||
		!windowValid(s)
	)
		return none
	const centre = s.centreHz!
	const half = (s.sampleRateHz! * s.usableFraction) / 2
	const inWindow = [...new Set(d.configuredChannelsHz.filter(positive))].filter(
		hz => Math.abs(hz - centre) <= half && bandFits(d, hz),
	)
	const fit = inWindow.filter(hz => fitsReach(d, s, hz))
	return {
		channels: fit
			.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b)
			.slice(0, ACARSDEC_CATALOGUE_MAX_CHANNELS),
		misfit: fit.length < inWindow.length,
	}
}

type Candidate = {
	source: PlannerSource
	options?: Readonly<Record<string, unknown>>
	hz: number | null
	reach: WantedPlacement["reach"]
	origin: WantedPlacement["origin"]
	index: number
	/**
	 * 3.18/3.20: a generated multi-channel candidate (paging raster, catalogue
	 * ACARS); every one but the primary is gated and admitted last.
	 */
	gatedSecondary?: true
}
// "activity" is assigned after ranking, never to a candidate.
const originOrder = {
	configured: 0,
	band: 1,
	vfo: 2,
	bandplan: 3,
	fallback: 4,
	activity: 5,
}
const decoderClass = (d: PlannerDecoder) =>
	d.startMode === "operator" ? 0 : d.mode === "always" ? 1 : 2

/** One (activity decoder, source) set of ranked channels. */
type ActivityGroup = {
	d: PlannerDecoder
	source: PlannerSource
	/** Every eligible channel of the group in today's order (the query's candidates). */
	candidatesHz: number[]
	/** Activity order (ranked or nearest), the primary removed. */
	order: number[]
	snapshot: ActivitySnapshot | null
}

export const planPlacements: PlacementPlanner = input => {
	const act = input.activity
	// Stage 1: with activity input the whole eligible set is ranked, then the
	// slot allocator slices it; without it today's caps apply.
	const unsliced = act !== undefined
	const groups: ActivityGroup[] = []
	const queries: ActivityQuery[] = []
	const wanted: WantedPlacement[] = []
	// 3.18/3.20: gated secondary placements, admitted after every decoder.
	const deferred: WantedPlacement[] = []
	const unplaced = new Map<
		string,
		| "decoder-unavailable"
		| "channelizer-unavailable"
		| "frequency-out-of-band"
		| "capture-too-narrow"
		| "no-channel-selected"
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
		// 3.14: the band fits some candidate but no placement fits the window.
		let tooNarrow = false
		// A band-plan decoder with its band in view but no channel chosen yet.
		let noChannel = false
		for (const s of sources) {
			const centre = s.centreHz!
			const half = (s.sampleRateHz! * s.usableFraction) / 2
			const local: Candidate[] = []
			// The band window assessBand uses (the pipeline's real frontend).
			// Centre reach (LoRa) is bounded by its own passband instead.
			const bandHalf =
				d.reach !== "centre" &&
				positive(d.bandHalfWidthHz) &&
				d.bandHalfWidthHz < half
					? d.bandHalfWidthHz
					: half
			// 3.14: "too narrow" only when the band reaches this capture window.
			const bandOverlapsWindow = !bandFree(d) && bandFits(d, centre, bandHalf)
			// 3.14: a fit failure is physical. It counts when the band reaches this window, and,
			// when `always`, an operator start or an opt-out bypasses the band policy, for any
			// selected channel that was tried. Raw reach (readsb) is a centre position, never a
			// width, so it never counts there.
			const fitFailureCounts = (hz: number | null): boolean =>
				bandOverlapsWindow || bypassedChannel(d, hz)
			const add = (
				hz: number | null,
				origin: Candidate["origin"],
				index = 0,
				bandChannels?: readonly number[],
			) => {
				const band = bandChannels
					? bandChannels.every(f => bandFits(d, f))
					: bandFits(d, hz ?? centre, d.reach === "channel" ? 0 : bandHalf)
				if (!band) return
				if (fitsReach(d, s, hz))
					local.push({ source: s, hz, reach: d.reach, origin, index })
				else if (fitFailureCounts(hz)) tooNarrow = true
			}
			const followsVfo =
				d.origin === "config" &&
				d.reach === "channel" &&
				VFO_CHANNEL_TYPES.includes(d.type) &&
				d.followVfo !== false &&
				d.configuredChannelsHz.length === 0
			if (followsVfo) {
				// One configured decoder follows one source, never extra capture centres.
				const selected =
					sources.find(source => source.id === input.vfo?.sourceId) ??
					sources[0]
				if (s !== selected) continue
				const vfo = input.vfo?.sourceId === s.id ? input.vfo : null
				// 3.18: a pager decoder takes every paging raster channel in view; a
				// VFO exactly on one of them is the primary, an off-raster one is dropped.
				const paging = pagingChannels(
					d,
					s,
					vfo?.frequencyHz ?? null,
					unsliced ? Infinity : MULTIMON_PAGING_MAX_CHANNELS,
				)
				// 3.14/3.18: raster channels in the window that all fail to fit are a
				// fit failure, never a fallback to an off-raster centre or VFO.
				if (paging.misfit && !paging.channels.length) {
					tooNarrow = true
					continue
				}
				if (paging.channels.length) {
					const onRaster =
						vfo !== null && paging.channels.includes(vfo.frequencyHz)
					paging.channels.forEach((hz, index) =>
						local.push(
							onRaster && hz === vfo.frequencyHz
								? { source: s, hz, reach: "channel", origin: "vfo", index: 0 }
								: {
										source: s,
										hz,
										reach: "channel",
										origin: "bandplan",
										index,
										gatedSecondary: true,
									},
						),
					)
					candidates.push(...local)
					continue
				}
				const hz = vfo ? vfo.frequencyHz : centre
				if (bandFits(d, hz, vfo ? 0 : bandHalf) && !fitsReach(d, s, hz)) {
					if (fitFailureCounts(hz)) tooNarrow = true
				} else if (bandFits(d, hz, vfo ? 0 : bandHalf))
					local.push({
						source: s,
						hz,
						reach: s.channelizerAvailable ? "channel" : "raw",
						origin: vfo ? "vfo" : "configured",
						index: 0,
					})
			} else if (
				d.type === "rtl433" &&
				d.origin === "catalogue" &&
				rtl433WindowFits(s.sampleRateHz!)
			) {
				// A wideband ISM decoder sees the whole capture: the band plan
				// decides whether it runs here, never which part it hears. The raw
				// stream reaches rtl_433 unresampled, edges included.
				if (bandFree(d) || bandOverlapsWindow)
					local.push({
						source: s,
						hz: null,
						reach: "raw",
						origin: "band",
						index: 0,
						options: { targetSampleRate: s.sampleRateHz! },
					})
			} else if (
				d.reach === "channel" &&
				(d.channelPlacements !== true || s.channelizerAvailable !== true)
			) {
				if (d.origin === "config") {
					if (bandFits(d, centre, bandHalf))
						local.push({
							source: s,
							hz: null,
							reach: "raw",
							origin: "configured",
							index: 0,
						})
				} else channelizerMissing = true
			} else if (d.reach === "centre" && d.centreSlots?.length) {
				// 3.17: each regional slot is a centre-reach candidate.
				d.centreSlots.forEach((slot, index) => {
					const one = { ...d, centreSlotHz: slot.slotHz }
					const mid = (slot.slotHz.minHz + slot.slotHz.maxHz) / 2
					if (!bandFits(d, centre, bandHalf)) return
					if (fitsReach(one, s, null))
						local.push({
							source: s,
							hz: null,
							reach: "centre",
							origin: "band",
							index,
							options: slot.options,
						})
					else if (Math.abs(mid - centre) <= half) tooNarrow = true
				})
			} else if (d.reach !== "channel") {
				add(null, "band")
			} else {
				const configured = d.configuredChannelsHz.filter(positive)
				if (d.type === "ais-catcher") {
					// One channel decodes both AIS frequencies: it fits the band when
					// every target lies inside its passband (and fitsReach keeps the
					// whole channel inside the usable window). Without targets the
					// band check is unchanged.
					const hz = 162_000_000
					const targets = (
						Array.isArray(d.band?.targetsHz) ? d.band.targetsHz : []
					).filter(positive)
					// `always` and operator starts skip the band policy (as bandFits
					// does) and keep the 162.000 MHz channel.
					if (bandFree(d) || targets.length === 0) add(hz, "band")
					else if (
						targets.every(f => Math.abs(f - hz) <= d.channelBandwidthHz / 2)
					)
						add(hz, "band", 0, targets)
				} else if (d.type === "acarsdec" && d.origin === "catalogue") {
					// 3.20: every catalogue ACARS channel in view, nearest first; the
					// VFO goes first only when it is exactly one of them.
					const acars = acarsCatalogueChannels(d, s)
					if (acars.misfit && !acars.channels.length) tooNarrow = true
					else if (!acars.channels.length && bandOverlapsWindow)
						noChannel = true
					const vfoHz =
						input.vfo?.sourceId === s.id ? input.vfo.frequencyHz : null
					const ordered =
						vfoHz !== null && acars.channels.includes(vfoHz)
							? [vfoHz, ...acars.channels.filter(hz => hz !== vfoHz)]
							: acars.channels
					ordered.forEach((hz, index) =>
						local.push({
							source: s,
							hz,
							reach: "channel",
							origin: hz === vfoHz ? "vfo" : "bandplan",
							index,
							gatedSecondary: true,
						}),
					)
				} else if (d.type === "dumpvdl2" && configured.length)
					add(
						(Math.min(...configured) + Math.max(...configured)) / 2,
						"configured",
						0,
						configured,
					)
				else if (d.type === "rtl433") {
					let found = rtl433ChannelCandidate(
						s,
						Array.isArray(d.band?.rangesHz) ? d.band.rangesHz : [],
						d.channelTargetRateHz,
					)
					// `always` and operator starts skip the band: the window itself.
					if (!("hz" in found) && bandFree(d))
						found = rtl433ChannelCandidate(
							s,
							[{ minHz: centre - half, maxHz: centre + half }],
							d.channelTargetRateHz,
						)
					if ("hz" in found)
						local.push({
							source: s,
							hz: found.hz,
							reach: "channel",
							origin: "band",
							index: 0,
							options: { targetSampleRate: found.rateHz },
						})
					else if (found.overlap) tooNarrow = true
				} else if (d.type === "direwolf") {
					configured.forEach((hz, i) => add(hz, "configured", i))
					for (const hz of Array.isArray(d.band?.targetsHz)
						? d.band.targetsHz
						: [])
						add(hz, "band")
				} else configured.forEach((hz, i) => add(hz, "configured", i))
				if (
					d.origin === "catalogue" &&
					(d.type === "dsd-fme" || d.type === "multimon-ng")
				) {
					const cap =
						Number.isInteger(input.maxBandplanChannels) &&
						input.maxBandplanChannels >= 0
							? unsliced && input.maxBandplanChannels > 0
								? Infinity
								: Math.min(
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
						.filter(hz => {
							if (!positive(hz) || !bandFits(d, hz)) return false
							if (fitsReach(d, s, hz)) return true
							// 3.14: a band-plan channel in the band whose passband the window
							// cannot hold is a fit failure, not an absent channel.
							if (fitFailureCounts(hz)) tooNarrow = true
							return false
						})
						.sort(
							(a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b,
						)
					const paging = pagingChannels(
						d,
						s,
						input.vfo?.sourceId === s.id ? input.vfo.frequencyHz : null,
						unsliced ? Infinity : MULTIMON_PAGING_MAX_CHANNELS,
					)
					if (paging.misfit && !paging.channels.length) tooNarrow = true
					const listed = channels.slice(0, cap)
					// 3.18: with the paging raster in view the VFO counts only when it is a
					// raster channel (then it goes first); the nearest raster channel is
					// primary otherwise, then the rest of the raster, then band-plan ones.
					const rasterInView = paging.channels.length > 0 || paging.misfit
					if (rasterInView) {
						const vfoHz =
							input.vfo?.sourceId === s.id ? input.vfo.frequencyHz : null
						if (vfoHz !== null && paging.channels.includes(vfoHz))
							add(vfoHz, "vfo")
						paging.channels.forEach((hz, i) => {
							const before = local.length
							add(hz, "bandplan", i)
							if (local.length > before)
								local[local.length - 1]!.gatedSecondary = true
						})
						listed
							.filter(hz => !paging.channels.includes(hz))
							.forEach((hz, i) =>
								add(hz, "bandplan", paging.channels.length + i),
							)
					} else if (input.vfo?.sourceId === s.id) {
						const hz = input.vfo.frequencyHz
						let inRange = false
						if (
							d.type === "multimon-ng" &&
							d.mode !== "always" &&
							d.startMode !== "operator" &&
							!channels.includes(hz)
						) {
							try {
								inRange =
									input.bandplanRangeContains?.(s.id, hz, d.protocols) === true
							} catch {
								inRange = false
							}
						}
						if (
							d.type !== "multimon-ng" ||
							d.mode === "always" ||
							d.startMode === "operator" ||
							channels.includes(hz) ||
							inRange
						)
							add(hz, "vfo")
					}
					if (!rasterInView) listed.forEach((hz, i) => add(hz, "bandplan", i))
					// 3.18: the cap holds after the VFO, band-plan and raster channels are
					// combined and deduplicated; earlier ones (higher priority) are kept.
					if (d.type === "multimon-ng" && !unsliced) {
						const kept = new Set<number | null>()
						for (let i = 0; i < local.length; ) {
							const hz = local[i]!.hz
							if (kept.has(hz) || kept.size < MULTIMON_PAGING_MAX_CHANNELS) {
								kept.add(hz)
								i++
							} else local.splice(i, 1)
						}
					}
				}
			}
			// A band-plan decoder with no channel here (no VFO, no band-plan
			// channel): nothing was tried, so it is not too narrow (3.14).
			if (
				!local.length &&
				bandOverlapsWindow &&
				d.origin === "catalogue" &&
				(d.type === "dsd-fme" || d.type === "multimon-ng")
			)
				noChannel = true
			// Digital voice is not confined to protocol-labelled band-plan channels.
			// Use scanner energy centres as extra candidates for unpinned dsd-fme,
			// preserving incumbent centres through burst gaps and health outages.
			const observed = act?.observed?.find(o => {
				const epoch = act.epochs.find(e => e.sourceId === s.id)
				return (
					epoch &&
					o.epoch.sourceId === s.id &&
					o.epoch.engineId === epoch.engineId &&
					o.epoch.epoch === epoch.epoch
				)
			})
			if (
				act &&
				act.observed !== undefined &&
				d.type === "dsd-fme" &&
				d.reach === "channel" &&
				s.channelizerAvailable &&
				(d.origin === "catalogue" || followsVfo) &&
				d.configuredChannelsHz.length === 0
			) {
				const addObserved = (actualHz: number, hz = actualHz) => {
					if (
						!Number.isInteger(actualHz) ||
						!positive(actualHz) ||
						!Number.isInteger(hz) ||
						!positive(hz)
					)
						return
					// A centre within bandwidth / 2 is already covered. Prefer existing
					// placements and listed channels to FFT jitter, preventing duplicates
					// and ambiguous ranker association within half a channel width.
					if (
						local.some(
							c =>
								c.hz !== null &&
								(c.hz === hz ||
									Math.abs(c.hz - actualHz) <= d.channelBandwidthHz / 2),
						)
					)
						return
					if (local.length >= ACTIVITY_MAX_CANDIDATES) return
					add(hz, "bandplan", local.length)
				}
				for (const inc of act.incumbents)
					if (inc.decoderId === d.id && inc.sourceId === s.id)
						addObserved(inc.hz)
				const centres = (
					observed?.centres ??
					(observed?.channelsHz ?? []).map(actualHz => ({
						actualHz,
						candidateHz: quantiseObservedCentre(actualHz),
					}))
				)
					.slice(0, ACTIVITY_MAX_CANDIDATES)
					.sort(
						(a, b) =>
							Math.abs(a.actualHz - centre) - Math.abs(b.actualHz - centre) ||
							a.actualHz - b.actualHz,
					)
				for (const c of centres) addObserved(c.actualHz, c.candidateHz)
			}
			candidates.push(...local)
		}
		// 3.20: catalogue ACARS stays on its channels, never the capture centre.
		const acarsCatalogue = d.type === "acarsdec" && d.origin === "catalogue"
		if (
			!candidates.length &&
			d.reach === "channel" &&
			bandFree(d) &&
			!acarsCatalogue
		) {
			for (const s of [...sources].sort(
				(a, b) => Number(a.held) - Number(b.held) || a.order - b.order,
			)) {
				if (
					s.channelizerAvailable !== true ||
					d.channelPlacements !== true ||
					d.type === "rtl433"
				)
					continue
				// 3.18: a paging raster in view that no channel fits is too narrow even
				// when the band policy is bypassed; never an off-raster VFO or centre.
				if (pagingTooNarrow(d, s)) {
					tooNarrow = true
					continue
				}
				const hz =
					(d.type === "dsd-fme" || d.type === "multimon-ng") &&
					input.vfo?.sourceId === s.id
						? input.vfo.frequencyHz
						: s.centreHz!
				if (!fitsReach(d, s, hz)) {
					if (bypassedChannel(d, hz)) tooNarrow = true
					continue
				}
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
			// 3.20: between generated multi-channel candidates (catalogue ACARS,
			// paging) of the same channel at the same distance, the one on the
			// VFO's own source wins, so the VFO stays the ungated primary. A tie
			// break only: it never overrides distance, nor applies to other types.
			const onVfo = (c: Candidate) =>
				c.gatedSecondary === true &&
				c.hz !== null &&
				input.vfo != null &&
				c.source.id === input.vfo.sourceId &&
				c.hz === input.vfo.frequencyHz
			const vfoTie = (a: Candidate, b: Candidate) =>
				a.gatedSecondary === true && b.gatedSecondary === true
					? Number(onVfo(b)) - Number(onVfo(a))
					: 0
			const preference = (a: Candidate, b: Candidate) =>
				Number(a.source.held) - Number(b.source.held) ||
				distance(a) - distance(b) ||
				vfoTie(a, b) ||
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
		const emit = (
			c: Candidate,
			i: number,
			activity?: PlacementActivity,
		): void => {
			;(c.gatedSecondary && i > 0 ? deferred : wanted).push({
				key: placementKey(d.id, c.source.id, c.reach, c.hz),
				decoderId: d.id,
				sourceId: c.source.id,
				channelHz: c.hz,
				reach: c.reach,
				origin: c.origin,
				primary: i === 0,
				costCores: placementCostCores(d.type, c.reach),
				sampleRateHz: c.source.sampleRateHz!,
				...(c.options ? { options: c.options } : {}),
				...(c.gatedSecondary && i > 0 ? { gated: true as const } : {}),
				...(activity ? { activity } : {}),
			})
		}
		// Stage 1: an activity decoder's paging raster and band-plan channels
		// are one ranked set per source; the configured, band and VFO channels
		// stay mandatory (3.18 VFO rules are applied above, before this).
		const ranked =
			act && isActivityDecoder(d.type)
				? sorted.filter(
						c =>
							c.origin === "bandplan" && c.reach === "channel" && c.hz !== null,
					)
				: []
		if (act && ranked.length) {
			const firm = sorted.filter(c => !ranked.includes(c))
			const local: ActivityGroup[] = []
			for (const c of ranked) {
				if (local.some(g => g.source === c.source)) continue
				const centre = c.source.centreHz!
				// Today's order (3.7, 3.18): the fallback equals it exactly.
				const candidatesHz = ranked
					.filter(r => r.source === c.source)
					.map(r => r.hz!)
				const epoch = act.epochs.find(e => e?.sourceId === c.source.id)
				let snapshot: ActivitySnapshot | null = null
				if (epoch) {
					const query: ActivityQuery = {
						epoch,
						decoderId: d.id,
						decoderType: d.type as ActivityQuery["decoderType"],
						protocols: d.protocols,
						centreHz: centre,
						candidatesHz,
						channelWidthHz: d.channelBandwidthHz,
					}
					queries.push(query)
					snapshot = readySnapshot(query, act.snapshots)
				}
				local.push({
					d,
					source: c.source,
					candidatesHz,
					order: activityOrder(candidatesHz, snapshot),
					snapshot,
				})
			}
			const info = (g: ActivityGroup, hz: number) =>
				placementActivity(g.snapshot?.channels.find(ch => ch.hz === hz))
			firm.forEach((c, i) => emit(c, i))
			if (!firm.length) {
				// The primary is not moved by ranking (that restarts the decoder's
				// own process): the incumbent primary channel while it is eligible,
				// otherwise the best-ranked channel of the preferred source.
				const incumbent = act.incumbents.find(
					i => i.decoderId === d.id && i.primary,
				)
				const primary =
					(incumbent &&
						ranked.find(
							c => c.hz === incumbent.hz && c.source.id === incumbent.sourceId,
						)) ??
					ranked.find(
						c => c.source === ranked[0]!.source && c.hz === local[0]!.order[0],
					)!
				const g = local.find(x => x.source === primary.source)!
				emit(primary, 0, info(g, primary.hz!))
				g.order = g.order.filter(hz => hz !== primary.hz)
			}
			groups.push(...local)
			continue
		}
		sorted.forEach((c, i) => emit(c, i))
		if (!sorted.length) {
			if (channelizerMissing) unplaced.set(d.id, "channelizer-unavailable")
			// 3.14: a fit failure is physical, so it holds when `always`, an operator start or an
			// opt-out bypasses the band policy too.
			else if (sources.length && tooNarrow)
				unplaced.set(d.id, "capture-too-narrow")
			else if (sources.length && !bandFree(d)) {
				// Only an empty candidate set of a known band is out of band (3.13, 3.14).
				if (noChannel) unplaced.set(d.id, "no-channel-selected")
				else if (bandKnown(d)) unplaced.set(d.id, "frequency-out-of-band")
			}
		}
	}
	if (!act) return { wanted: [...wanted, ...deferred], unplaced }
	// Global allocator (activity-plan.ts): every placement planned so far is
	// mandatory; activity slots get what remains of the budget.
	const mandatory = [...wanted, ...deferred]
	const keyOf = (g: ActivityGroup, hz: number) =>
		placementKey(g.d.id, g.source.id, "channel", hz)
	// Pending starts are capacity in use: deduplicated only against the
	// mandatory placements; a group's own pending candidates are prepaid slots.
	const plannedKeys = new Set(mandatory.map(p => p.key))
	const pendingKeys = new Set(
		(Array.isArray(act.pendingStarts) ? act.pendingStarts : []).map(
			p => p?.key,
		),
	)
	const prepaidOf = (g: ActivityGroup) =>
		g.order.filter(hz => pendingKeys.has(keyOf(g, hz))).length
	const slotsOf = (type: string) => {
		const n = isActivityDecoder(type) ? act.policy?.slots?.[type] : 0
		return Number.isInteger(n) && n! > 0 ? Math.min(n!, ACTIVITY_MAX_SLOTS) : 0
	}
	const allocation = allocateActivitySlots({
		budgetCores: act.policy?.budgetCores,
		replayAllowanceCores: act.policy?.replayAllowanceCores,
		mandatory,
		pending: Array.isArray(act.pendingStarts) ? act.pendingStarts : [],
		plannedKeys,
		groups: groups.map(g => ({
			sourceId: g.source.id,
			sampleRateHz: g.source.sampleRateHz!,
			perChannelCores: placementCostCores(g.d.type, "channel"),
			want: Math.min(slotsOf(g.d.type), g.order.length),
			prepaid: prepaidOf(g),
		})),
	})
	const now = act.nowMonoMs
	const maxMoves =
		Number.isInteger(act.policy?.maxMovesPerMinute) &&
		act.policy.maxMovesPerMinute >= 0
			? act.policy.maxMovesPerMinute
			: 0
	const dwellMs =
		Number.isFinite(act.policy?.dwellMs) && act.policy.dwellMs >= 0
			? act.policy.dwellMs
			: Infinity
	// Rolling window: moves in (now - 60 s, now] count against the source.
	const windowMoves = new Map<string, number[]>()
	for (const m of Array.isArray(act.recentMoves) ? act.recentMoves : [])
		if (
			Number.isFinite(m?.atMonoMs) &&
			m.atMonoMs > now - ACTIVITY_MOVE_WINDOW_MS &&
			m.atMonoMs <= now
		)
			windowMoves.set(m.sourceId, [
				...(windowMoves.get(m.sourceId) ?? []),
				m.atMonoMs,
			])
	const moves: ActivityMove[] = []
	const views: ActivityGroupView[] = []
	let next: number | null = null
	const later = (at: number | null | undefined) => {
		if (typeof at === "number" && Number.isFinite(at) && at > now)
			next = next === null ? at : Math.min(next, at)
	}
	groups.forEach((g, i) => {
		const times = (windowMoves.get(g.source.id) ?? []).sort((a, b) => a - b)
		const selection = selectChannels({
			order: g.order,
			ranked: g.snapshot !== null,
			activity: g.snapshot
				? new Map(g.snapshot.channels.map(c => [c.hz, c]))
				: null,
			count: allocation.given[i]!,
			incumbents: act.incumbents
				.filter(
					inc =>
						inc.decoderId === g.d.id &&
						inc.sourceId === g.source.id &&
						!inc.primary,
				)
				.map(inc => ({
					key: inc.key,
					hz: inc.hz,
					dwellSinceMonoMs: inc.dwellSinceMonoMs,
					...(pendingKeys.has(inc.key) ? { pinned: true } : {}),
				})),
			nowMonoMs: now,
			dwellMs,
			movesLeft: Math.max(0, maxMoves - times.length),
			moveWindowFreesMonoMs:
				times.length >= maxMoves && times.length > 0
					? times[times.length - maxMoves]! + ACTIVITY_MOVE_WINDOW_MS
					: null,
		})
		later(selection.blockedUntilMonoMs)
		later(g.snapshot?.nextEvaluationMonoMs)
		for (const c of selection.chosen) {
			const key = keyOf(g, c.hz)
			deferred.push({
				key,
				decoderId: g.d.id,
				sourceId: g.source.id,
				channelHz: c.hz,
				reach: "channel",
				origin: "activity",
				primary: false,
				costCores: placementCostCores(g.d.type, "channel"),
				sampleRateHz: g.source.sampleRateHz!,
				gated: true,
				...(c.movedFrom ? { movedFrom: c.movedFrom.key } : {}),
				activity: placementActivity(
					g.snapshot?.channels.find(ch => ch.hz === c.hz),
				),
			})
			if (c.movedFrom) {
				moves.push({
					decoderId: g.d.id,
					sourceId: g.source.id,
					fromKey: c.movedFrom.key,
					fromHz: c.movedFrom.hz,
					toKey: key,
					toHz: c.hz,
					atMonoMs: now,
				})
				times.push(now)
			}
		}
		windowMoves.set(g.source.id, times)
		views.push({
			decoderId: g.d.id,
			sourceId: g.source.id,
			ranking: g.snapshot ? "activity" : "nearest",
			wanted: Math.min(slotsOf(g.d.type), g.order.length),
			given: allocation.given[i]!,
		})
	})
	return {
		wanted: [...wanted, ...deferred],
		unplaced,
		activity: { queries, moves, groups: views, nextEvaluationMonoMs: next },
	}
}

/** The activity queries of one pass: the planner's groups, before any snapshot. */
export function activityQueries(
	input: Parameters<PlacementPlanner>[0],
): readonly ActivityQuery[] {
	if (!input.activity) return []
	return (
		planPlacements({ ...input, activity: { ...input.activity, snapshots: [] } })
			.activity?.queries ?? []
	)
}
