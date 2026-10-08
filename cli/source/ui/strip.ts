import type { ApiView, GlyphRole, IqView } from "../data/types.js"
import { fitGroups } from "./fit.js"
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

function decodersGroup(d: StripDecoders | null, old: boolean): Group {
	if (d === null)
		return {
			priority: 3,
			variants: [[label("decoders "), { text: "?", role: "unknown" }]],
		}
	const sep = ` ${glyphs().sep} `
	const up = `${d.up}/${d.total} up`
	const minimal: Line =
		d.failing > 0
			? [label("decoders "), value(`${d.failing} failing`, old, "fault")]
			: [label("decoders "), value(up, old)]
	const mid: Line =
		d.failing > 0
			? [
					label("decoders "),
					value(up, old),
					label(sep),
					value(`${d.failing} failing`, old, "fault"),
				]
			: minimal
	const rich: Line =
		d.inWindow !== null
			? [...mid, label(sep), value(`${d.inWindow} in window`, old)]
			: mid
	return { priority: 3, variants: [minimal, mid, rich] }
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
	return {
		priority: 4,
		variants: [
			[label("drops "), v],
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
export function stripGroups(input: StripInput): Group[] {
	const groups: Group[] = [apiGroup(input.api), iqGroup(input.iq, input.old.iq)]
	if (input.rx) groups.push(rxGroup(input.rx, input.old.rx))
	groups.push(
		decodersGroup(input.decoders, input.old.decoders),
		dropsGroup(input.drops),
	)
	groups.push({
		priority: 6,
		variants: [[label(formatClockShort(input.clockMs))]],
	})
	return groups
}

export function stripLine(input: StripInput, width: number): Line {
	return fitGroups(stripGroups(input), width, { rightAlignLast: true })
}
