// Scanner discovery tags on the plot (docs/web/canvas/Spectrum.dc.html `discTags`; DESIGN.md "Scanner, decisions
// before design": "Auto band map = discoveries"): a third, quieter tier under the saved-frequency tags. Bright when
// active, dim when heard in the last hour, muted when older; a locked-out (Ignored) discovery is never tagged, and one
// already saved is not tagged again (saved wins). Pure layout with the saved tags' yielding rules.
import type { Discovery } from "@wavekit/api-types"

import {
	confidenceRank,
	discoveryTitle,
	formatWait,
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
	id: string
	hz: number
	/** "DMR · CC 1", "Maybe FM voice", "Heard". */
	label: string
	tier: DiscoveryTier
	/** Decoded: the dot is filled (else a ring). */
	solid: boolean
	/** Only heard (activity): grey instead of the accent while not active. */
	heard: boolean
	/** Left edge in CSS px: the dot sits on the frequency, 7 px into the chip (board). */
	x: number
	/** Width used for collisions, CSS px. */
	width: number
	/** The label is drawn (else the dot alone: it lost its room to a tag placed before it). */
	labelled: boolean
	/** Tooltip and accessible name: label · frequency · when. */
	title: string
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

/**
 * Places the discovery tags in view. Order: active first, then by confidence, then the most recent;
 * first every dot that fits (a clashing one is not drawn), then each label where it fits before the next
 * tag, as the saved tags do. Two discoveries on the same Hz share one tag (the first in that order).
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
	const candidates: {
		d: Discovery
		tier: DiscoveryTier
		seen: number
	}[] = []
	for (const d of items) {
		if (d.frequencyHz < view.startHz || d.frequencyHz > view.endHz) continue
		if (!taggable(d, only)) continue
		const half = Math.max(1000, (d.bandwidthHz || 12_500) / 2)
		if (saved.some(hz => Math.abs(hz - d.frequencyHz) <= half)) continue
		candidates.push({
			d,
			tier: discoveryTier(d, options.activeNow, options.now),
			seen: Date.parse(d.lastSeenAt) || 0,
		})
	}
	candidates.sort(
		(a, b) =>
			TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
			confidenceRank(b.d.confidence) - confidenceRank(a.d.confidence) ||
			b.seen - a.seen ||
			(a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0),
	)
	const clash = (
		tags: readonly PlacedDiscoveryTag[],
		self: PlacedDiscoveryTag | null,
		a: number,
		b: number,
	) => tags.some(t => t !== self && a < t.x + t.width + gap && b > t.x - gap)
	const seenHz = new Set<number>()
	const placed: PlacedDiscoveryTag[] = []
	for (const { d, tier } of candidates) {
		const hz = Math.round(d.frequencyHz)
		if (seenHz.has(hz)) continue
		seenHz.add(hz)
		const x = ((d.frequencyHz - view.startHz) / span) * w - DISCOVERY_DOT_PX
		if (clash(placed, null, x, x + bare)) continue
		const label = discoveryTitle(d)
		placed.push({
			id: d.id,
			hz: d.frequencyHz,
			label,
			tier,
			solid: d.confidence === "decoded",
			heard: d.confidence === "activity" || d.protocol === "unknown",
			x,
			width: bare,
			labelled: false,
			title: `${label} · ${(d.frequencyHz / 1e6).toFixed(4)} MHz · ${whenText(tier, d, options.now)}`,
		})
	}
	for (const t of placed) {
		const full = Math.round(
			chrome + Math.min(maxLabel, [...t.label].length * charPx),
		)
		if (t.x + full <= w && !clash(placed, t, t.x, t.x + full)) {
			t.width = full
			t.labelled = true
		}
	}
	return placed.sort((a, b) => a.x - b.x)
}

/** Whether any discovery in `byId` could be tagged (the row shows, so the layout keeps it while panning). */
export function hasTaggable(
	byId: ReadonlyMap<string, Pick<Discovery, "operator" | "confidence">>,
	only: DiscoveryTagFilter = "all",
): boolean {
	for (const d of byId.values()) if (taggable(d, only)) return true
	return false
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
