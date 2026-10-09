import { VIEW_TITLES, type Action } from "../ui/actions.js"
import { BINDINGS, type KeyContext, type ModeName } from "../ui/keymap.js"
import { sp, type Line } from "../ui/line.js"
import { cellWidth, padEnd, truncate } from "../ui/text.js"
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

const ASKS = " (asks to confirm)"

/** What a binding does, in help words; null = not listed (typing keys, notices). */
function labelOf(a: Action, mode: ModeName): string | null {
	switch (a.type) {
		case "move":
			return "select"
		case "page":
			return "page"
		case "top":
			return "top"
		case "newest":
			return "newest"
		case "open":
			return "open detail"
		case "escape":
			return mode === "detail" ? "close detail" : "back"
		case "detail-scroll":
			return "scroll detail"
		case "copy-json":
			return "copy JSON"
		case "filter-open":
			return "filter"
		case "filter-apply":
			return "apply filter"
		case "filter-cancel":
			return "cancel filter"
		case "pause-toggle":
			return "pause / resume"
		case "preset-cycle":
			return "filter preset"
		case "decoder-op":
			return `${a.op}${ASKS}`
		case "edit-open":
			return "edit tuner"
		case "control-toggle":
			return `take / release control${ASKS}`
		case "audio-toggle":
			return "start / stop audio"
		case "preset-open":
			return `audio preset${ASKS}`
		case "edit-key":
			switch (a.key) {
				case "left":
				case "right":
					return "digit"
				case "up":
				case "down":
					return "change"
				case "tab":
					return "next field"
				case "space":
					return "toggle"
				case "backspace":
					return "delete digit"
				default:
					return "type digit"
			}
		case "edit-review":
			return `review${ASKS}`
		case "edit-discard":
			return "discard"
		case "view":
			return "views"
		case "view-step":
			return a.delta > 0 ? "next view" : "previous view"
		case "reconnect":
			return "reconnect + refetch"
		case "quit":
			return "quit"
		case "help-open":
			return "this help"
		default:
			return null
	}
}

function keyText(keys: readonly string[]): string {
	const g = glyphs()
	const ascii = g.up !== "↑"
	const named: Readonly<Record<string, string>> = {
		"<up>": g.up,
		"<down>": g.down,
		"<left>": ascii ? "<" : "←",
		"<right>": ascii ? ">" : "→",
		"<pgup>": "PgUp",
		"<pgdn>": "PgDn",
		"<enter>": "Enter",
		"<esc>": "Esc",
		"<tab>": "Tab",
		"<shift-tab>": "Shift-Tab",
		"<space>": "Space",
		"<backspace>": "Bksp",
	}
	const digits = keys.filter(k => /^[0-9]$/.test(k))
	if (digits.length >= 3 && digits.length === keys.length) {
		return `${digits[0]}-${digits[digits.length - 1]}`
	}
	const arrows: string[] = []
	const words: string[] = []
	const letters: string[] = []
	for (const k of keys) {
		const n = named[k]
		if (n !== undefined) {
			if (k === "<up>" || k === "<down>" || k === "<left>" || k === "<right>")
				arrows.push(n)
			else words.push(n)
		} else letters.push(k)
	}
	letters.sort((a, b) => a.localeCompare(b, "en", { caseFirst: "lower" }))
	return [arrows.join(""), ...words, ...letters].filter(x => x !== "").join(" ")
}

/** M11: every binding of the view (not filtered by `when`), grouped by label, from the keymap. */
function entries(
	ctx: KeyContext,
	section: "view" | "global",
): Array<[string, string]> {
	const modes: readonly ModeName[] =
		section === "global"
			? ["global"]
			: [
					"list",
					"detail",
					...(ctx.view === "messages" ? (["input"] as const) : []),
					...(ctx.view === "receiver" ? (["edit"] as const) : []),
				]
	const order: string[] = []
	const keysBy = new Map<string, string[]>()
	for (const mode of modes) {
		for (const b of BINDINGS) {
			if (b.mode !== mode) continue
			if (b.views && !b.views.includes(ctx.view)) continue
			const first = b.keys[0]
			if (first === undefined) continue
			const label = labelOf(b.action(first, ctx), mode)
			if (label === null) continue
			const list = keysBy.get(label)
			if (!list) {
				order.push(label)
				keysBy.set(label, [...b.keys])
			} else for (const k of b.keys) if (!list.includes(k)) list.push(k)
		}
	}
	return order.map(label => [keyText(keysBy.get(label) ?? []), label])
}

/** Spec §6.6: centred 60-column box; current view keys, then global keys, then the legend. */
export function helpLines(
	ctx: KeyContext,
	width: number,
	height: number,
): Line[] {
	const b = boxChars()
	const g = glyphs()
	const w = Math.min(BOX_WIDTH, width)
	const inner = w - 3
	const half = Math.floor((inner - 1) / 2)
	const left = " ".repeat(Math.max(0, Math.floor((width - w) / 2)))
	const entry = (e: [string, string]): string => `${padEnd(e[0], 10)} ${e[1]}`
	/** Two entries share a row only when both fit their half; long labels are never cut. */
	const pack = (list: Array<[string, string]>): string[] => {
		const out: string[] = []
		for (let i = 0; i < list.length; i++) {
			const a = list[i]
			const c = list[i + 1]
			if (!a) continue
			if (
				c &&
				cellWidth(entry(a)) <= half &&
				cellWidth(entry(c)) <= inner - half - 1
			) {
				out.push(`${padEnd(entry(a), half)} ${entry(c)}`)
				i++
			} else out.push(entry(a))
		}
		return out
	}
	const body: string[] = [
		...pack(entries(ctx, "view")),
		"",
		...pack(entries(ctx, "global")),
	]
	body.push("")
	body.push(
		`${g.live} live  ${g.neutral} idle or off  ${g.fault} fault  ${g.attention} now  ${g.unknown} unknown`,
	)
	body.push(`dim  older than 15 s      ${g.na} not applicable`)
	body.push(
		`band  core's targets or WaveKit's table ${glyphs().sep} * configured`,
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
