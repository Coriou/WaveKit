// Scanner discovery tags on the plot (docs/web/canvas/Spectrum.dc.html `discTags`; DESIGN.md "Scanner, decisions
// before design": "Auto band map = discoveries"): a third, quieter tier under the saved-frequency tags. Bright when
// active, dim when heard in the last hour, muted when older; a locked-out (Ignored) discovery is never tagged, and one
// already saved is not tagged again (saved wins). Pure layout with the saved tags' yielding rules.
import type { Discovery } from "@wavekit/api-types"

import {
	confidenceRank,
	confidenceText,
	discoveryTitle,
	formatWait,
	identityText,
	isVerified,
	whatIsThis,
} from "../data/scanner-format.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import type { SignalLabelsMode } from "./label-gate.ts"

export type DiscoveryTier = "active" | "recent" | "older"

/** Which discoveries are tagged: all of them, or the decoded ones. */
export type DiscoveryTagFilter = "all" | "decoded"

/** Settings › Signal labels drives the discovery row too: Named shows only what is identified (decoded). */
export function discoveryTagFilter(mode: SignalLabelsMode): DiscoveryTagFilter {
	return mode === "named" ? "decoded" : "all"
}

export interface PlacedDiscoveryTag {
	/** The representative's id (a group's key). */
	id: string
	/** Where the tag sits: the cluster's lowest member's frequency (a group tag sits at its first member). */
	hz: number
	/** "DMR · CC 1", "Maybe FM voice", "Heard"; a group adds " +n-1". */
	label: string
	/** The representative's name alone (the label without the count): the part that may ellipsise. */
	name: string
	tier: DiscoveryTier
	/** Decoded: the dot is filled (else a ring). */
	solid: boolean
	/** Only heard (activity): grey instead of the accent while not active. */
	heard: boolean
	/**
	 * Left edge in CSS px: the dot sits on the frequency, 7 px into the chip (board); a tag at the very
	 * edge of the view (or under an edge marker) is moved inside, so it is never clipped.
	 */
	x: number
	/** Width used for collisions, CSS px. */
	width: number
	/** The label is drawn (else the dot alone, and a group's "+n-1": no room before the next tag). */
	labelled: boolean
	/** A group's count text ("+5") shown beside the dot even without the label; null for one discovery. */
	count: string | null
	/** Tooltip and accessible name: label · frequency · when; a group "n signals, low-high MHz". */
	title: string
	/** Every member in frequency order (one for a single tag); the group popover lists them all. */
	members: Discovery[]
	/** The representative (first by tier, confidence, recency, id). */
	rep: Discovery
}

export interface DiscoveryTagOptions {
	widthPx: number
	/** Discovery ids with an active observation now (layer.scanner activeNow). */
	activeNow: ReadonlySet<string>
	/** Clock (ms since the epoch) for the last-hour tier. */
	now: number
	/** Saved frequencies (Hz): a discovery within half its bandwidth of one is not tagged. */
	savedHz?: readonly number[]
	/** "decoded": decoded discoveries only (Signal labels › Named). Default all. */
	only?: DiscoveryTagFilter
	/** Board metrics: 11 px text ≈ 5.9 px a character, padding + dot + gap 22 px; a dot-only chip 15 px. */
	charPx?: number
	chromePx?: number
	bareWidthPx?: number
	gapPx?: number
	maxLabelPx?: number
	/** Room kept free at the left / right edge (an edge marker plus its gap), CSS px. Default 0. */
	reserveLeftPx?: number
	reserveRightPx?: number
}

export const RECENT_MS = 60 * 60 * 1000
export const DISCOVERY_TAG_MAX_LABEL_PX = 140
/** The dot's centre from the chip's left edge (board: left: calc(x% - 7px)). */
export const DISCOVERY_DOT_PX = 7

/** The tier of a discovery: active now, heard in the last hour, or older. */
export function discoveryTier(
	d: Pick<Discovery, "id" | "lastSeenAt">,
	activeNow: ReadonlySet<string>,
	now: number,
): DiscoveryTier {
	if (activeNow.has(d.id)) return "active"
	const seen = Date.parse(d.lastSeenAt)
	return Number.isFinite(seen) && now - seen <= RECENT_MS ? "recent" : "older"
}

/** Whether the spectrum tags this discovery at all (Ignore is the core's lockout: never). */
export function taggable(
	d: Pick<Discovery, "operator" | "confidence">,
	only: DiscoveryTagFilter = "all",
): boolean {
	if (d.operator?.lockout) return false
	return only === "all" || d.confidence === "decoded"
}

const TIER_RANK: Readonly<Record<DiscoveryTier, number>> = {
	active: 2,
	recent: 1,
	older: 0,
}

function whenText(tier: DiscoveryTier, d: Discovery, now: number): string {
	if (tier === "active") return "active now"
	const seen = Date.parse(d.lastSeenAt)
	return Number.isFinite(seen)
		? `heard ${formatWait(Math.max(0, now - seen))} ago`
		: "heard earlier"
}

interface Candidate {
	d: Discovery
	tier: DiscoveryTier
	seen: number
}

/** The existing tag order: active first, then by confidence, then the most recent, then id. */
function byRank(a: Candidate, b: Candidate): number {
	return (
		TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
		confidenceRank(b.d.confidence) - confidenceRank(a.d.confidence) ||
		b.seen - a.seen ||
		(a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0)
	)
}

function byFrequency(a: Discovery, b: Discovery): number {
	return (
		a.frequencyHz - b.frequencyHz || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	)
}

/** Whether a discovery counts for the tags at all (taggable and not already a saved frequency). */
function counted(
	d: Discovery,
	only: DiscoveryTagFilter,
	saved: readonly number[],
): boolean {
	if (!Number.isFinite(d.frequencyHz)) return false
	if (!taggable(d, only)) return false
	const half = Math.max(1000, (d.bandwidthHz || 12_500) / 2)
	return !saved.some(hz => Math.abs(hz - d.frequencyHz) <= half)
}

export interface ClusterOptions {
	widthPx: number
	/** A dot-only chip, CSS px (15). */
	bareWidthPx?: number
	/** Room kept between two tags, CSS px (4). */
	gapPx?: number
	/** Dot positions are clamped into [minDotPx, maxDotPx] before grouping (tags stay inside the row). */
	minDotPx?: number
	maxDotPx?: number
}

/**
 * Groups discoveries in view into emitter clusters (band inspection UX req 1.1): in frequency order, one
 * joins the current cluster when it lies less than bare + gap px after the cluster's last member, or within
 * max(1 kHz, half the wider bandwidth) of it. Chaining is unbounded, which is what keeps tags apart. Out of
 * view (or a non-finite frequency): left out. Each cluster's members are in frequency order.
 */
export function clusterDiscoveries(
	items: Iterable<Discovery>,
	view: SpectrumViewSpan,
	options: ClusterOptions,
): Discovery[][] {
	const span = view.endHz - view.startHz
	const w = options.widthPx
	if (!(span > 0) || !(w > 0)) return []
	const reach = (options.bareWidthPx ?? 15) + (options.gapPx ?? 4)
	const lo = options.minDotPx ?? -Infinity
	const hi = options.maxDotPx ?? Infinity
	const x = (hz: number) =>
		Math.min(hi, Math.max(lo, ((hz - view.startHz) / span) * w))
	const inView = [...items]
		.filter(
			d =>
				Number.isFinite(d.frequencyHz) &&
				d.frequencyHz >= view.startHz &&
				d.frequencyHz <= view.endHz,
		)
		.sort(byFrequency)
	const out: Discovery[][] = []
	let current: Discovery[] | null = null
	for (const d of inView) {
		const p = current?.[current.length - 1]
		if (current && p) {
			const bw = (q: Discovery) => q.bandwidthHz || 12_500
			const near =
				x(d.frequencyHz) - x(p.frequencyHz) < reach ||
				d.frequencyHz - p.frequencyHz <=
					Math.max(1000, Math.max(bw(d), bw(p)) / 2)
			if (near) {
				current.push(d)
				continue
			}
		}
		current = [d]
		out.push(current)
	}
	return out
}

function mhz(hz: number, digits = 4): string {
	return (hz / 1e6).toFixed(digits)
}

/** A group's count beside its dot: about 6.6 px a character of "+n" at 11 px bold, plus 6 px. */
const COUNT_CHAR_PX = 6.6

/**
 * Places the discovery tags in view (band inspection UX req 1.1, 1.2). Co-located discoveries form one
 * group tag at the cluster's lowest member, named by its representative (active first, then by
 * confidence, then the most recent) with "+n-1"; a group too tight for its label still shows "+n-1".
 * Every tag lies inside [reserveLeftPx, widthPx - reserveRightPx] (a tag at the view's edge moves in, so
 * it is never clipped or under an edge marker), and tags never overlap: a tag that would touch the one
 * before it joins that group. So every discovery in view is on exactly one tag. Then each label where it
 * fits before the next tag, as the saved tags do.
 */
export function placeDiscoveryTags(
	items: Iterable<Discovery>,
	view: SpectrumViewSpan,
	options: DiscoveryTagOptions,
): PlacedDiscoveryTag[] {
	const span = view.endHz - view.startHz
	const w = options.widthPx
	if (!(span > 0) || !(w > 0)) return []
	const charPx = options.charPx ?? 5.9
	const chrome = options.chromePx ?? 22
	const bare = options.bareWidthPx ?? 15
	const gap = options.gapPx ?? 4
	const maxLabel = options.maxLabelPx ?? DISCOVERY_TAG_MAX_LABEL_PX
	const only = options.only ?? "all"
	const saved = options.savedHz ?? []
	const minX = Math.max(0, options.reserveLeftPx ?? 0)
	const maxX = w - Math.max(0, options.reserveRightPx ?? 0)
	if (maxX - minX < bare) return []
	const candidates = new Map<string, Candidate>()
	for (const d of items) {
		if (!counted(d, only, saved)) continue
		candidates.set(d.id, {
			d,
			tier: discoveryTier(d, options.activeNow, options.now),
			seen: Date.parse(d.lastSeenAt) || 0,
		})
	}
	const dotX = (hz: number) =>
		Math.min(
			maxX - bare + DISCOVERY_DOT_PX,
			Math.max(minX + DISCOVERY_DOT_PX, ((hz - view.startHz) / span) * w),
		)
	const build = (members: Discovery[]): PlacedDiscoveryTag | null => {
		const first = members[0]
		const top = members
			.map(d => candidates.get(d.id))
			.filter((c): c is Candidate => c !== undefined)
			.sort(byRank)[0]
		if (!first || !top) return null
		const { d: rep, tier } = top
		const n = members.length
		const name = discoveryTitle(rep)
		const count = n > 1 ? `+${n - 1}` : null
		const label = count ? `${name} ${count}` : name
		const last = members[n - 1] ?? first
		const width = count
			? Math.round(bare + 6 + count.length * COUNT_CHAR_PX)
			: bare
		return {
			id: rep.id,
			hz: first.frequencyHz,
			label,
			name,
			tier,
			solid: rep.confidence === "decoded",
			heard: rep.confidence === "activity" || rep.protocol === "unknown",
			x: Math.min(
				maxX - width,
				Math.max(minX, dotX(first.frequencyHz) - DISCOVERY_DOT_PX),
			),
			width,
			labelled: false,
			count,
			title:
				n > 1
					? `${n} signals, ${mhz(first.frequencyHz)}-${mhz(last.frequencyHz)} MHz`
					: `${label} · ${mhz(rep.frequencyHz)} MHz · ${whenText(tier, rep, options.now)}`,
			members,
			rep,
		}
	}
	const clusters = clusterDiscoveries(
		[...candidates.values()].map(c => c.d),
		view,
		{
			widthPx: w,
			bareWidthPx: bare,
			gapPx: gap,
			minDotPx: minX + DISCOVERY_DOT_PX,
			maxDotPx: maxX - bare + DISCOVERY_DOT_PX,
		},
	)
	// A group's count widens its chip: a tag that would now touch the one before joins it (repeat).
	const placed: PlacedDiscoveryTag[] = []
	for (const members of clusters) {
		let t = build(members)
		while (t) {
			const prev = placed[placed.length - 1]
			if (!prev || prev.x + prev.width + gap <= t.x) break
			placed.pop()
			t = build([...prev.members, ...t.members])
		}
		if (t) placed.push(t)
	}
	placed.forEach((t, i) => {
		// the count never shrinks: its room comes on top of the (capped) name
		const full = Math.round(
			chrome +
				Math.min(maxLabel, [...t.name].length * charPx) +
				(t.count ? 4 + t.count.length * COUNT_CHAR_PX : 0),
		)
		const next = placed[i + 1]
		if (t.x + full <= maxX && (!next || t.x + full + gap <= next.x)) {
			t.width = full
			t.labelled = true
		}
	})
	return placed
}

export interface TagPopoverRow {
	id: string
	/** "433.9200". */
	freq: string
	/** The operator's label, else the protocol slot ("Maybe ISM", "Heard"). */
	name: string
	/** The protocol slot under a label (null without a label). */
	protocol: string | null
	/** "likely ISM device" (muted), or null. */
	likely: string | null
	/** The next step (req 1.3 table); null once verified. */
	next: string | null
	tuneHz: number
}

/** What a tag's popover lists, one row per member (a single discovery too): "what is this" and a Tune action. */
export function tagPopoverRows(
	tag: Pick<PlacedDiscoveryTag, "members">,
): TagPopoverRow[] {
	return tag.members.map(d => {
		const what = whatIsThis(d)
		const label = d.operator?.label?.trim() ?? ""
		return {
			id: d.id,
			freq: mhz(d.frequencyHz),
			name: label || what.protocol,
			protocol: label ? what.protocol : null,
			likely: what.likely,
			next: isVerified(d) ? null : what.next,
			tuneHz: d.frequencyHz,
		}
	})
}

/** Where focus goes back when a popover closes from the keyboard or Cancel: the control that opened it. */
export class TriggerFocus {
	private trigger: { focus(options?: FocusOptions): void } | null = null

	remember(trigger: { focus(options?: FocusOptions): void } | null): void {
		this.trigger = trigger
	}

	/** Focuses the remembered trigger (once) and forgets it. */
	restore(): void {
		const t = this.trigger
		this.trigger = null
		t?.focus({ preventScroll: true })
	}

	forget(): void {
		this.trigger = null
	}
}

/** An edge marker's width for `count`: border, padding, arrow, gap and the digits at 11 px. */
export function edgeMarkerWidth(count: number): number {
	return 27 + 7 * String(count).length
}

/** The edge markers sit this far from the row's ends. */
export const EDGE_MARKER_INSET_PX = 2

export interface DiscoveryRowLayout {
	tags: PlacedDiscoveryTag[]
	outside: OutsideView
	/** Where each marker is drawn (CSS px), null without one on that side. */
	markers: {
		left: { x: number; width: number } | null
		right: { x: number; width: number } | null
	}
}

/**
 * The whole discovery row (req 1.1, 1.2): edge markers first, then the tags in the room between them, so
 * no tag is ever under a marker.
 */
export function discoveryRowLayout(
	items: Iterable<Discovery>,
	view: SpectrumViewSpan,
	options: DiscoveryTagOptions,
): DiscoveryRowLayout {
	const all = [...items]
	const outside = outsideView(all, view, options)
	const gap = options.gapPx ?? 4
	const w = options.widthPx
	const left = outside.left
		? { x: EDGE_MARKER_INSET_PX, width: edgeMarkerWidth(outside.left.count) }
		: null
	const right = outside.right
		? {
				x: w - EDGE_MARKER_INSET_PX - edgeMarkerWidth(outside.right.count),
				width: edgeMarkerWidth(outside.right.count),
			}
		: null
	const tags = placeDiscoveryTags(all, view, {
		...options,
		reserveLeftPx: left ? left.x + left.width + gap : 0,
		reserveRightPx: right ? w - right.x + gap : 0,
	})
	return { tags, outside, markers: { left, right } }
}

export interface OutsideSide {
	/** Taggable discoveries on this side within the fetched span. */
	count: number
	/** The one closest to the view. */
	nearestHz: number
}

export interface OutsideView {
	left: OutsideSide | null
	right: OutsideSide | null
}

/**
 * Discoveries just outside the view (band inspection UX req 1.2), counted per side among those the
 * fetch could have loaded (the view plus half a view each side, discoveryFetchSpan): never drawn,
 * one edge marker per side. Anything beyond that span (a stale cache from another band) is not counted.
 */
export function outsideView(
	items: Iterable<Discovery>,
	view: SpectrumViewSpan,
	options: Pick<DiscoveryTagOptions, "only" | "savedHz">,
): OutsideView {
	const span = view.endHz - view.startHz
	if (!(span > 0)) return { left: null, right: null }
	const only = options.only ?? "all"
	const saved = options.savedHz ?? []
	const lo = view.startHz - span / 2
	const hi = view.endHz + span / 2
	const left = { count: 0, nearestHz: -Infinity }
	const right = { count: 0, nearestHz: Infinity }
	for (const d of items) {
		if (!counted(d, only, saved)) continue
		const f = d.frequencyHz
		if (f < view.startHz && f >= lo) {
			left.count += 1
			left.nearestHz = Math.max(left.nearestHz, f)
		} else if (f > view.endHz && f <= hi) {
			right.count += 1
			right.nearestHz = Math.min(right.nearestHz, f)
		}
	}
	return {
		left: left.count > 0 ? left : null,
		right: right.count > 0 ? right : null,
	}
}

/** Whether any discovery in `byId` could be tagged (the row shows, so the layout keeps it while panning). */
export function hasTaggable(
	byId: ReadonlyMap<string, Pick<Discovery, "operator" | "confidence">>,
	only: DiscoveryTagFilter = "all",
): boolean {
	for (const d of byId.values()) if (taggable(d, only)) return true
	return false
}

/**
 * The decoded discovery on a spectrum signal, or null: Signal labels name the signal by what was identified there
 * ("DMR · CC 1") before a saved frequency or the band plan does. The closest within max(3 kHz, half the signal's
 * width); an Ignored (locked-out) one never names it.
 */
export function identifiedAt(
	items: Iterable<Discovery>,
	hz: number,
	widthHz: number,
): Discovery | null {
	const tol = Math.max(3000, widthHz / 2)
	let best: Discovery | null = null
	for (const d of items) {
		if (d.confidence !== "decoded" || d.operator?.lockout) continue
		const off = Math.abs(d.frequencyHz - hz)
		if (off <= tol && (!best || off < Math.abs(best.frequencyHz - hz))) best = d
	}
	return best
}

/** What a signal chip says for an identified signal: the decoder's words ("DMR · CC 1"), not a name someone gave it. */
export function identifiedLabel(d: Discovery): string {
	const what = confidenceText(d)
	const id = identityText(d.identity)
	return id ? `${what} · ${id}` : what
}

export interface FetchedSpan {
	startHz: number
	endHz: number
	at: number
}

/**
 * The span to fetch discoveries for when the view shows `view`, or null when the last fetch still
 * covers it and is fresher than `maxAgeMs`. The fetched span reaches half a view beyond each edge,
 * so small pans and zooms do not refetch.
 */
export function discoveryFetchSpan(
	view: SpectrumViewSpan,
	last: FetchedSpan | null,
	now: number,
	maxAgeMs = 60_000,
): { startHz: number; endHz: number } | null {
	const span = view.endHz - view.startHz
	if (!(span > 0)) return null
	if (
		last &&
		now - last.at < maxAgeMs &&
		last.startHz <= view.startHz &&
		last.endHz >= view.endHz
	)
		return null
	return {
		startHz: Math.max(0, Math.floor(view.startHz - span / 2)),
		endHz: Math.ceil(view.endHz + span / 2),
	}
}
