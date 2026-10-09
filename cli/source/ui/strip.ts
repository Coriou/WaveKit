import type { ApiView, GlyphRole, IqView } from "../data/types.js"
import { fitGroups } from "./fit.js"
import {
	formatAge,
	formatClockShort,
	formatHalfSpan,
	formatMHz,
	formatMHzBare,
	formatPercent,
	formatRate,
} from "./format.js"
import type { Group, Line, Role, Span } from "./line.js"
import { lineWidth } from "./text.js"
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

/** An age after a glyph, or nothing when there is no age to give (`rest ×`, not `rest × ?`). */
const ageSpan = (ms: number | null): Span[] =>
	ms === null ? [] : [value(` ${formatAge(ms)}`)]

function apiGroup(a: ApiView): Group {
	switch (a.kind) {
		case "connecting":
			return {
				priority: 1,
				variants: [[label("api "), glyphSpan("neutral"), value(" connecting")]],
			}
		case "ok": {
			// A healthy API's age is the first thing a narrow strip gives up (it returns first).
			const lane: Line = [label("api "), glyphSpan("live")]
			return {
				priority: 1,
				variants: [lane, [...lane, ...ageSpan(a.restAgeMs)]],
			}
		}
		case "split": {
			// The REST age is added back first (stripLine), so a narrow strip keeps rx.
			const lane: Line = [
				label("api ws "),
				glyphSpan(a.ws ? "live" : "fault"),
				label(" rest "),
				glyphSpan(a.rest ? "live" : "fault"),
			]
			const aged = [...lane, ...ageSpan(a.restAgeMs)]
			return {
				priority: 1,
				variants: aged.length > lane.length ? [lane, aged] : [lane],
			}
		}
		case "down":
			return {
				priority: 1,
				variants: [[label("api "), glyphSpan("fault"), ...ageSpan(a.sinceMs)]],
			}
	}
}

/** Live: `iq ●` → `iq ● streaming` → `… · 4.1 MB/s`. Other states keep their word (the glyph does not say which fault). */
function iqGroup(iq: IqView, old: boolean): Group {
	const head: Line = [label("iq "), glyphSpan(iq.glyph)]
	const named: Line = [...head, value(` ${iq.word}`, old)]
	if (iq.word === "no samples")
		return {
			priority: 2,
			variants: [
				named,
				[...head, value(` no samples ${formatAge(iq.ageMs)}`, old)],
			],
		}
	if (iq.glyph !== "live") return { priority: 2, variants: [named] }
	const variants: Line[] = [head, named]
	// A rate beside a stalled or dropped lane reads as flow, so it shows only while live.
	if (iq.rateBytesPerSec !== null)
		variants.push([
			...named,
			label(` ${glyphs().sep} `),
			value(formatRate(iq.rateBytesPerSec), old),
		])
	return { priority: 2, variants }
}

/** `dec 8/9 ×1 !1` → `decoders 8/9 up · 1 failing · 1 restarting` → `… · 2 in window` (M2: the up-count is the fact). */
function decodersGroup(d: StripDecoders | null, old: boolean): Group {
	if (d === null)
		return {
			priority: 3,
			variants: [
				[label("dec "), { text: "?", role: "unknown" }],
				[label("decoders "), { text: "?", role: "unknown" }],
			],
		}
	const g = glyphs()
	const sep = ` ${g.sep} `
	const restarting = d.restarting ?? 0
	const compact: Line = [label("dec "), value(`${d.up}/${d.total}`, old)]
	if (d.failing > 0)
		compact.push(label(" "), value(`${g.fault}${d.failing}`, old, "fault"))
	if (restarting > 0)
		compact.push(
			label(" "),
			value(`${g.attention}${restarting}`, old, "attention"),
		)
	const named: Line = [label("decoders "), value(`${d.up}/${d.total} up`, old)]
	if (d.failing > 0)
		named.push(label(sep), value(`${d.failing} failing`, old, "fault"))
	if (restarting > 0)
		named.push(label(sep), value(`${restarting} restarting`, old, "attention"))
	const variants: Line[] = [compact, named]
	if (d.inWindow !== null)
		variants.push([...named, label(sep), value(`${d.inWindow} in window`, old)])
	return { priority: 3, variants }
}

/**
 * `drops !21%` at every width (M15: the strip is "now" by definition; the
 * Receiver FANOUT row carries the word). Unknown under backpressure:
 * `drops ? !` → `drops ? · backpressure` (R32).
 */
function dropsGroup(d: StripInput["drops"]): Group {
	const g = glyphs()
	if (d.ratio === null) {
		const unknown: Line = [label("drops "), { text: "?", role: "unknown" }]
		return {
			priority: 4,
			variants: d.backpressure
				? [
						[
							...unknown,
							label(" "),
							{ text: g.attention, role: "attention", bold: true },
						],
						[
							...unknown,
							label(` ${g.sep} `),
							{ text: "backpressure", role: "attention", bold: true },
						],
					]
				: [unknown],
		}
	}
	const pct = formatPercent(d.ratio)
	const v: Span = d.backpressure
		? { text: `${g.attention}${pct}`, role: "attention", bold: true }
		: value(pct)
	return { priority: 4, variants: [[label("drops "), v]] }
}

/** `rx 445.971` → `rx 445.971 MHz` → `… ±1.024` → `… · external control`. */
function rxGroup(rx: StripRx, old: boolean): Group {
	const bare: Line = [label("rx "), value(formatMHzBare(rx.centreHz), old)]
	const unit: Line = [label("rx "), value(formatMHz(rx.centreHz), old)]
	const variants: Line[] = [bare, unit]
	const span: Line =
		rx.halfSpanHz !== null
			? [...unit, value(` ${formatHalfSpan(rx.halfSpanHz * 2)}`, old)]
			: unit
	if (span !== unit) variants.push(span)
	const owner =
		rx.control === "external"
			? "external control"
			: rx.control === "internal"
				? "wavekit control"
				: null
	if (owner)
		variants.push([...span, label(` ${glyphs().sep} `), value(owner, old)])
	return { priority: 5, variants }
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

const SEP_W = 2

/**
 * M2: every lane starts at its minimal form and only the clock may be removed,
 * so `rx` and `drops` stay at 60 columns. Room is then spent in a fixed order,
 * most useful first: the REST age, the rx span, the iq word, the drops words, the named
 * decoders lane, its in-window count, the iq rate, the rx owner, the clock.
 * Should even the minimal forms not fit, the priority fitter decides.
 */
export function stripLine(input: StripInput, width: number): Line {
	const groups = stripGroups(input)
	const n = groups.length
	const clock = n - 1
	const rx = input.rx ? 2 : -1
	const dec = input.rx ? 3 : 2
	const drops = dec + 1
	const variant = groups.map(() => 0)
	const present = groups.map(() => true)
	const widthOf = (i: number): number =>
		lineWidth(groups[i]?.variants[variant[i] ?? 0] ?? [])
	const total = (): number => {
		let w = 0
		let count = 0
		for (let i = 0; i < n; i++) {
			if (!present[i]) continue
			w += widthOf(i)
			count++
		}
		return w + Math.max(0, count - 1) * SEP_W
	}
	present[clock] = false
	if (total() > width) return fitGroups(groups, width, { rightAlignLast: true })
	const upgrade = (i: number, targets: readonly number[]): void => {
		if (i < 0) return
		const have = groups[i]?.variants.length ?? 0
		for (const t of targets) {
			if (t >= have || t <= (variant[i] ?? 0)) continue
			const before = variant[i] ?? 0
			variant[i] = t
			if (total() <= width) return
			variant[i] = before
		}
	}
	const rxVariants = rx >= 0 ? (groups[rx]?.variants.length ?? 0) : 0
	const rxOwnerIdx = input.rx?.control ? rxVariants - 1 : -1
	const rxSpanIdx = rxOwnerIdx >= 0 ? rxVariants - 2 : rxVariants - 1
	upgrade(0, [1])
	upgrade(rx, [rxSpanIdx, 1])
	upgrade(1, [1])
	upgrade(drops, [1])
	upgrade(dec, [1])
	upgrade(dec, [2])
	upgrade(1, [2])
	upgrade(rx, [rxOwnerIdx])
	present[clock] = true
	if (total() > width) present[clock] = false
	const parts: Line[] = []
	for (let i = 0; i < n; i++)
		if (present[i]) parts.push(groups[i]?.variants[variant[i] ?? 0] ?? [])
	const line: Line = []
	parts.forEach((p, k) => {
		if (k > 0) {
			const last = k === parts.length - 1 && present[clock]
			const pad = last ? Math.max(SEP_W, width - total() + SEP_W) : SEP_W
			line.push({ text: " ".repeat(pad), role: "label" })
		}
		line.push(...p)
	})
	return line
}
