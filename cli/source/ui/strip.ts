import type { ApiView, GlyphRole, IqView } from "../data/types.js"
import { fitGroupsDetailed } from "./fit.js"
import {
	formatAge,
	formatClockShort,
	formatHalfSpan,
	formatMHz,
	formatPercent,
	formatRate,
} from "./format.js"
import type { Group, Line, Role, Span } from "./line.js"
import { glyphs } from "./theme.js"

export interface StripDecoders {
	up: number
	total: number
	failing: number
	/** R46: decoders restarting after a crash (attention, not a fault); optional for older producers. */
	restarting?: number
	inWindow: number | null
}

export interface StripRx {
	centreHz: number
	halfSpanHz: number | null
	control: "internal" | "external" | null
}

export interface StripInput {
	api: ApiView
	iq: IqView
	decoders: StripDecoders | null
	drops: { ratio: number | null; backpressure: boolean }
	rx: StripRx | null
	clockMs: number
	old: { iq: boolean; decoders: boolean; rx: boolean }
}

const GLYPH_ROLE: Readonly<Record<GlyphRole, Role>> = {
	live: "live",
	neutral: "neutral",
	fault: "fault",
	attention: "attention",
	unknown: "unknown",
}

export function glyphSpan(role: GlyphRole): Span {
	const g = glyphs()
	const text =
		role === "live"
			? g.live
			: role === "fault"
				? g.fault
				: role === "neutral"
					? g.neutral
					: role === "attention"
						? g.attention
						: g.unknown
	return { text, role: GLYPH_ROLE[role] }
}

const label = (text: string): Span => ({ text, role: "label" })
const value = (text: string, old = false, role: Role = "value"): Span =>
	old ? { text, role: "old" } : { text, role, bold: true }

function apiGroup(a: ApiView): Group {
	switch (a.kind) {
		case "connecting":
			return {
				priority: 1,
				variants: [[label("api "), glyphSpan("neutral"), value(" connecting")]],
			}
		case "ok":
			return {
				priority: 1,
				variants: [
					[
						label("api "),
						glyphSpan("live"),
						value(` ${formatAge(a.restAgeMs)}`),
					],
				],
			}
		case "split":
			return {
				priority: 1,
				variants: [
					[
						label("api ws "),
						glyphSpan(a.ws ? "live" : "fault"),
						label(" rest "),
						glyphSpan(a.rest ? "live" : "fault"),
						value(` ${formatAge(a.restAgeMs)}`),
					],
				],
			}
		case "down":
			return {
				priority: 1,
				variants: [
					[
						label("api "),
						glyphSpan("fault"),
						value(` ${formatAge(a.sinceMs)}`),
					],
				],
			}
	}
}

function iqGroup(iq: IqView, old: boolean): Group {
	const word =
		iq.word === "no samples" ? `no samples ${formatAge(iq.ageMs)}` : iq.word
	const base: Line = [label("iq "), glyphSpan(iq.glyph), value(` ${word}`, old)]
	const variants: Line[] = [base]
	// A rate beside a stalled or dropped lane reads as flow, so it shows only while live.
	if (iq.rateBytesPerSec !== null && iq.glyph === "live") {
		variants.push([
			...base,
			label(` ${glyphs().sep} `),
			value(formatRate(iq.rateBytesPerSec), old),
		])
	}
	return { priority: 2, variants }
}

function decodersGroup(
	d: StripDecoders | null,
	old: boolean,
	bare = false,
): Group {
	if (d === null)
		return {
			priority: 3,
			variants: [[label("decoders "), { text: "?", role: "unknown" }]],
		}
	const sep = ` ${glyphs().sep} `
	const up = `${d.up}/${d.total} up`
	// Failing (fault) then restarting (attention, R46): same priority, so they
	// stay in every variant together.
	const issues: Line = []
	if (d.failing > 0) issues.push(value(`${d.failing} failing`, old, "fault"))
	const restarting = d.restarting ?? 0
	if (restarting > 0) {
		if (issues.length > 0) issues.push(label(sep))
		issues.push(value(`${restarting} restarting`, old, "attention"))
	}
	if (issues.length === 0) {
		const minimal: Line = [label("decoders "), value(up, old)]
		const rich: Line =
			d.inWindow !== null
				? [...minimal, label(sep), value(`${d.inWindow} in window`, old)]
				: minimal
		return { priority: 3, variants: [minimal, rich] }
	}
	const named: Line = [label("decoders "), ...issues]
	const mid: Line = [label("decoders "), value(up, old), label(sep), ...issues]
	const rich: Line =
		d.inWindow !== null
			? [...mid, label(sep), value(`${d.inWindow} in window`, old)]
			: mid
	// R75 `bare`: the count words alone (`1 restarting`) as the minimal variant,
	// used only when the named lane would cost the drops lane (see stripLine).
	return {
		priority: 3,
		variants: bare ? [issues, named, mid, rich] : [named, mid, rich],
	}
}

function dropsGroup(d: StripInput["drops"]): Group {
	// Backpressure is current evidence even when the ratio cannot be computed
	// (§4.1); it is said in words beside the unknown ratio (R32).
	if (d.ratio === null) {
		const unknown: Line = [label("drops "), { text: "?", role: "unknown" }]
		return {
			priority: 4,
			variants: d.backpressure
				? [
						[
							...unknown,
							label(` ${glyphs().sep} `),
							{ text: "backpressure", role: "attention", bold: true },
						],
					]
				: [unknown],
		}
	}
	const pct = formatPercent(d.ratio)
	const v: Span = d.backpressure
		? { text: `${glyphs().attention}${pct}`, role: "attention", bold: true }
		: value(pct)
	// R65 M8 (T4): a drop figure is always labelled `now`; the strip fits by
	// shortening or dropping other lanes, never by losing the word.
	// The minimal variant says "drop" so `drop !34% now` still fits the 60-column strip.
	return {
		priority: 4,
		variants: [
			[label("drop "), v, label(" now")],
			[label("drops "), v, label(" now")],
		],
	}
}

function rxGroup(rx: StripRx, old: boolean): Group {
	const base: Line = [label("rx "), value(formatMHz(rx.centreHz), old)]
	const mid: Line =
		rx.halfSpanHz !== null
			? [...base, value(` ${formatHalfSpan(rx.halfSpanHz * 2)}`, old)]
			: base
	const owner =
		rx.control === "external"
			? "external control"
			: rx.control === "internal"
				? "wavekit control"
				: null
	const rich: Line = owner
		? [...mid, label(` ${glyphs().sep} `), value(owner, old)]
		: mid
	return { priority: 5, variants: [base, mid, rich] }
}

/** Display order: api, iq, rx, decoders, drops, clock (spec §4). */
export function stripGroups(input: StripInput, bareDecoders = false): Group[] {
	const groups: Group[] = [apiGroup(input.api), iqGroup(input.iq, input.old.iq)]
	if (input.rx) groups.push(rxGroup(input.rx, input.old.rx))
	groups.push(
		decodersGroup(input.decoders, input.old.decoders, bareDecoders),
		dropsGroup(input.drops),
	)
	groups.push({
		priority: 6,
		variants: [[label(formatClockShort(input.clockMs))]],
	})
	return groups
}

const DROPS_PRIORITY = 4

/**
 * Fit the strip. When the decoders lane names its issues and that would drop
 * the drops lane, retry with the bare count words (`1 restarting`, R75): a
 * shorter label is better than losing the current drop figure.
 */
export function stripLine(input: StripInput, width: number): Line {
	const opts = { rightAlignLast: true }
	const groups = stripGroups(input)
	const fit = fitGroupsDetailed(groups, width, opts)
	const dropsLost = groups.some(
		(g, i) => g.priority === DROPS_PRIORITY && !fit.present[i],
	)
	if (!dropsLost) return fit.line
	const bare = fitGroupsDetailed(stripGroups(input, true), width, opts)
	const kept = bare.present.every((p, i) => p || !fit.present[i])
	return kept ? bare.line : fit.line
}
