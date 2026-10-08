import { VIEW_TITLES } from "../ui/actions.js"
import { footerHints, type KeyContext } from "../ui/keymap.js"
import { sp, type Line } from "../ui/line.js"
import { padEnd, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

const BOX_WIDTH = 60

function boxChars(): {
	tl: string
	tr: string
	bl: string
	br: string
	h: string
	v: string
} {
	return glyphs().ellipsis === "…"
		? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
		: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
}

function entries(ctx: KeyContext): Array<[string, string]> {
	const base: KeyContext = {
		...ctx,
		help: false,
		confirm: null,
		input: false,
		edit: false,
	}
	const seen = new Set<string>()
	const out: Array<[string, string]> = []
	const add = (k: string, l: string): void => {
		if (seen.has(k)) return
		seen.add(k)
		out.push([k, l])
	}
	for (const c of [
		{ ...base, detail: false },
		{ ...base, detail: true },
		{ ...base, edit: ctx.view === "receiver" },
	]) {
		for (const h of footerHints(c))
			if (h.mode !== "global") add(h.hint.keys, h.hint.rich ?? h.hint.label)
	}
	return out
}

/** Spec §6.6: centred 60-column box; current view keys, then global keys, then the legend. */
export function helpLines(
	ctx: KeyContext,
	width: number,
	height: number,
	diag: { invalidFrames: number; rejectedItems: number },
): Line[] {
	const b = boxChars()
	const g = glyphs()
	const w = Math.min(BOX_WIDTH, width)
	const inner = w - 3
	const half = Math.floor((inner - 1) / 2)
	const left = " ".repeat(Math.max(0, Math.floor((width - w) / 2)))
	const pair = (
		a: [string, string] | undefined,
		c: [string, string] | undefined,
	): string =>
		padEnd(a ? `${padEnd(a[0], 10)} ${a[1]}` : "", half) +
		" " +
		(c ? `${padEnd(c[0], 8)} ${c[1]}` : "")
	const body: string[] = []
	const view = entries(ctx)
	for (let i = 0; i < view.length; i += 2) body.push(pair(view[i], view[i + 1]))
	body.push("")
	const global: Array<[string, string]> = [
		["1-5 Tab", "views"],
		["r", "reconnect + refetch"],
		["?", "this help"],
		["q", "quit"],
	]
	for (let i = 0; i < global.length; i += 2)
		body.push(pair(global[i], global[i + 1]))
	body.push("")
	body.push(
		`${g.live} live  ${g.neutral} idle or off  ${g.fault} fault  ${g.attention} now  ${g.unknown} unknown`,
	)
	body.push(`dim  older than 15 s      ${g.na} not applicable`)
	body.push("nominal  band from WaveKit's built-in table, not the API")
	body.push(
		`frames rejected ${diag.invalidFrames} ${g.sep} items rejected ${diag.rejectedItems}`,
	)
	const title = `${b.h} keys ${g.sep} ${VIEW_TITLES[ctx.view]} `
	const top = `${b.tl}${title}${b.h.repeat(Math.max(0, w - 2 - title.length))}${b.tr}`
	const rows = body.map(
		t => `${b.v} ${padEnd(truncate(t, inner), inner)}${b.v}`,
	)
	const bottom = `${b.bl}${b.h.repeat(w - 2)}${b.br}`
	const maxBody = Math.max(0, height - 2)
	const shown =
		rows.length > maxBody
			? [
					...rows.slice(0, Math.max(0, maxBody - 1)),
					`${b.v} ${padEnd(g.ellipsis, inner)}${b.v}`,
				]
			: rows
	return [top, ...shown, bottom].map(t => [sp(left + t, "label")])
}
