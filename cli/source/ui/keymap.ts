import {
	VIEW_ORDER,
	VIEW_TITLES,
	type Action,
	type EditKey,
	type ViewId,
	type ViewKeyCtx,
} from "./actions.js"
import { fitGroups } from "./fit.js"
import type { Group, HeightClass, Line } from "./line.js"
import { glyphs } from "./theme.js"
import type { ConfirmKind } from "./ui-state.js"

export interface KeyFlags {
	upArrow?: boolean
	downArrow?: boolean
	leftArrow?: boolean
	rightArrow?: boolean
	pageUp?: boolean
	pageDown?: boolean
	return?: boolean
	escape?: boolean
	ctrl?: boolean
	shift?: boolean
	tab?: boolean
	backspace?: boolean
	delete?: boolean
	meta?: boolean
}

/** Ink parses one key per stdin chunk; Backspace (0x7f) arrives as key.delete, so both map to <backspace>. */
export function keyName(input: string, k: KeyFlags): string {
	if (k.escape === true) return "<esc>"
	if (k.upArrow === true) return "<up>"
	if (k.downArrow === true) return "<down>"
	if (k.leftArrow === true) return "<left>"
	if (k.rightArrow === true) return "<right>"
	if (k.pageUp === true) return "<pgup>"
	if (k.pageDown === true) return "<pgdn>"
	if (k.return === true) return "<enter>"
	if (k.tab === true) return k.shift === true ? "<shift-tab>" : "<tab>"
	if (k.backspace === true || k.delete === true) return "<backspace>"
	if (k.ctrl === true) return `<ctrl-${input}>`
	if (k.meta === true) return `<meta-${input}>`
	if (input === " ") return "<space>"
	return input
}

const isNamed = (key: string): boolean =>
	key.length > 2 && key.startsWith("<") && key.endsWith(">")

export function isPrintable(key: string): boolean {
	return (
		key.length > 0 && !isNamed(key) && !/[\u0000-\u001f\u007f-\u009f]/.test(key)
	)
}

export interface KeyContext {
	view: ViewId
	confirm: ConfirmKind | null
	help: boolean
	input: boolean
	edit: boolean
	detail: boolean
	heightClass: HeightClass
	v: ViewKeyCtx
}

export type ModeName =
	| "confirm"
	| "help"
	| "input"
	| "edit"
	| "detail"
	| "list"
	| "global"

export interface Hint {
	keys: string
	label: string
	rich?: string
}

export interface Binding {
	mode: ModeName
	views?: readonly ViewId[]
	/** Key names; "*any" matches every key, "*printable" every printable key. */
	keys: readonly string[]
	action: (key: string, ctx: KeyContext) => Action
	hint?: (ctx: KeyContext) => Hint | null
	when?: (ctx: KeyContext) => boolean
}

export const RECEIVER_EXTERNAL_NOTICE =
	"controlled externally · c to take control"
const ANY = "*any"
const PRINTABLE = "*printable"
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const
const LIST_VIEWS: readonly ViewId[] = ["overview", "decoders", "messages"]
const DETAIL_VIEWS: readonly ViewId[] = ["decoders", "messages"]

const ud = (): string => `${glyphs().up}${glyphs().down}`
const lr = (): string => (glyphs().up === "↑" ? "←→" : "<>")
const hint = (keys: string, label: string) => (): Hint => ({ keys, label })
const edit = (key: EditKey): Action => ({ type: "edit-key", key })

export const BINDINGS: readonly Binding[] = [
	// confirm (modal)
	{ mode: "confirm", keys: ["y"], action: () => ({ type: "confirm-yes" }) },
	{
		mode: "confirm",
		keys: ["n", "<esc>"],
		action: () => ({ type: "confirm-no" }),
	},
	{
		mode: "confirm",
		keys: ["P"],
		when: c => c.confirm === "preset",
		action: () => ({ type: "preset-next" }),
	},
	// help (modal)
	{ mode: "help", keys: [ANY], action: () => ({ type: "help-close" }) },
	// input: Messages filter (modal)
	{
		mode: "input",
		keys: ["<enter>"],
		action: () => ({ type: "filter-apply" }),
		hint: hint("Enter", "apply"),
	},
	{
		mode: "input",
		keys: ["<esc>"],
		action: () => ({ type: "filter-cancel" }),
		hint: hint("Esc", "cancel"),
	},
	{
		mode: "input",
		keys: ["<backspace>"],
		action: () => ({ type: "filter-backspace" }),
	},
	{
		mode: "input",
		keys: ["<space>"],
		action: () => ({ type: "filter-type", text: " " }),
	},
	{
		mode: "input",
		keys: [PRINTABLE],
		action: key => ({ type: "filter-type", text: key }),
	},
	// edit: Receiver tuner (modal)
	{
		mode: "edit",
		keys: ["<left>"],
		action: () => edit("left"),
		hint: () => ({ keys: lr(), label: "digit" }),
	},
	{ mode: "edit", keys: ["<right>"], action: () => edit("right") },
	{
		mode: "edit",
		keys: ["<up>"],
		action: () => edit("up"),
		hint: () => ({ keys: ud(), label: "change" }),
	},
	{ mode: "edit", keys: ["<down>"], action: () => edit("down") },
	{
		mode: "edit",
		keys: DIGITS,
		action: key => edit(key as EditKey),
		hint: hint("0-9", "type"),
	},
	{
		mode: "edit",
		keys: ["<tab>"],
		action: () => edit("tab"),
		hint: hint("Tab", "next field"),
	},
	{
		mode: "edit",
		keys: ["<space>"],
		action: () => edit("space"),
		hint: hint("Space", "toggle"),
	},
	{ mode: "edit", keys: ["<backspace>"], action: () => edit("backspace") },
	{
		mode: "edit",
		keys: ["<enter>"],
		action: () => ({ type: "edit-review" }),
		hint: hint("Enter", "review"),
	},
	{
		mode: "edit",
		keys: ["<esc>"],
		action: () => ({ type: "edit-discard" }),
		hint: hint("Esc", "discard"),
	},
	// detail: Decoders / Messages with the detail open
	{
		mode: "detail",
		views: DETAIL_VIEWS,
		keys: ["<up>", "k"],
		action: () => ({ type: "move", delta: -1 }),
		hint: () => ({ keys: ud(), label: "select" }),
	},
	{
		mode: "detail",
		views: DETAIL_VIEWS,
		keys: ["<down>", "j"],
		action: () => ({ type: "move", delta: 1 }),
	},
	{
		mode: "detail",
		views: ["messages"],
		keys: ["<pgup>"],
		action: () => ({ type: "detail-scroll", delta: -1 }),
		hint: hint("PgUp PgDn", "scroll"),
	},
	{
		mode: "detail",
		views: ["messages"],
		keys: ["<pgdn>"],
		action: () => ({ type: "detail-scroll", delta: 1 }),
	},
	{
		mode: "detail",
		views: ["messages"],
		keys: ["y"],
		action: () => ({ type: "copy-json" }),
		hint: hint("y", "copy JSON"),
	},
	{
		mode: "detail",
		views: DETAIL_VIEWS,
		keys: ["<esc>"],
		action: () => ({ type: "escape" }),
		hint: hint("Esc", "close"),
	},
	// list
	{
		mode: "list",
		views: LIST_VIEWS,
		keys: ["<up>", "k"],
		action: () => ({ type: "move", delta: -1 }),
		hint: c => ({
			keys: ud(),
			label: "select",
			...(c.view === "overview" && c.heightClass === "roomy"
				? { rich: "select decoder" }
				: {}),
		}),
	},
	{
		mode: "list",
		views: LIST_VIEWS,
		keys: ["<down>", "j"],
		action: () => ({ type: "move", delta: 1 }),
	},
	{
		mode: "list",
		views: DETAIL_VIEWS,
		keys: ["<pgup>"],
		action: () => ({ type: "page", delta: -1 }),
	},
	{
		mode: "list",
		views: DETAIL_VIEWS,
		keys: ["<pgdn>"],
		action: () => ({ type: "page", delta: 1 }),
	},
	{
		mode: "list",
		views: DETAIL_VIEWS,
		keys: ["g"],
		action: () => ({ type: "top" }),
	},
	{
		mode: "list",
		views: LIST_VIEWS,
		keys: ["<enter>"],
		when: c => !c.detail,
		action: () => ({ type: "open" }),
		hint: hint("Enter", "open"),
	},
	{
		mode: "list",
		views: LIST_VIEWS,
		keys: ["<esc>"],
		action: () => ({ type: "escape" }),
	},
	{
		mode: "list",
		views: ["messages"],
		keys: ["/"],
		action: () => ({ type: "filter-open" }),
		hint: hint("/", "filter"),
	},
	{
		mode: "list",
		views: ["messages"],
		keys: ["p"],
		action: () => ({ type: "pause-toggle" }),
		hint: c => ({ keys: "p", label: c.v.paused ? "resume" : "pause" }),
	},
	{
		mode: "list",
		views: ["messages"],
		keys: ["G"],
		action: () => ({ type: "newest" }),
		hint: hint("G", "newest"),
	},
	{
		mode: "list",
		views: ["decoders"],
		keys: ["G"],
		action: () => ({ type: "newest" }),
	},
	{
		mode: "list",
		views: ["messages"],
		keys: ["F"],
		action: () => ({ type: "preset-cycle" }),
		hint: hint("F", "preset"),
	},
	{
		mode: "list",
		views: ["decoders"],
		keys: ["s"],
		when: c => c.v.hasSelection && c.v.decoderRunning === false,
		action: () => ({ type: "decoder-op", op: "start" }),
		hint: hint("s", "start"),
	},
	{
		mode: "list",
		views: ["decoders"],
		keys: ["x"],
		when: c => c.v.hasSelection && c.v.decoderRunning === true,
		action: () => ({ type: "decoder-op", op: "stop" }),
		hint: hint("x", "stop"),
	},
	{
		mode: "list",
		views: ["decoders"],
		keys: ["R"],
		when: c => c.v.hasSelection,
		action: () => ({ type: "decoder-op", op: "restart" }),
		hint: hint("R", "restart"),
	},
	{
		mode: "list",
		views: ["receiver"],
		keys: ["e"],
		when: c => c.v.control === "internal",
		action: () => ({ type: "edit-open" }),
		hint: hint("e", "edit tuner"),
	},
	{
		mode: "list",
		views: ["receiver"],
		keys: ["e"],
		when: c => c.v.control !== "internal",
		action: () => ({ type: "notice", text: RECEIVER_EXTERNAL_NOTICE }),
	},
	{
		mode: "list",
		views: ["receiver"],
		keys: ["c"],
		when: c => c.v.control !== null,
		action: () => ({ type: "control-toggle" }),
		hint: c => ({
			keys: "c",
			label: c.v.control === "internal" ? "release control" : "take control",
		}),
	},
	{
		mode: "list",
		views: ["system"],
		keys: ["a"],
		when: c => c.v.audioRunning !== null,
		action: () => ({ type: "audio-toggle" }),
		hint: c => ({
			keys: "a",
			label: c.v.audioRunning === true ? "stop audio" : "start audio",
		}),
	},
	{
		mode: "list",
		views: ["system"],
		keys: ["P"],
		action: () => ({ type: "preset-open" }),
		hint: hint("P", "preset"),
	},
	// global
	{
		mode: "global",
		keys: ["1", "2", "3", "4", "5"],
		action: key => ({
			type: "view",
			view: VIEW_ORDER[Number(key) - 1] ?? "overview",
		}),
	},
	{
		mode: "global",
		keys: ["<tab>"],
		action: () => ({ type: "view-step", delta: 1 }),
	},
	{
		mode: "global",
		keys: ["<shift-tab>"],
		action: () => ({ type: "view-step", delta: -1 }),
	},
	{
		mode: "global",
		keys: ["r"],
		action: () => ({ type: "reconnect" }),
		hint: hint("r", "reconnect"),
	},
	{
		mode: "global",
		keys: ["q"],
		action: () => ({ type: "quit" }),
		hint: hint("q", "quit"),
	},
	{
		mode: "global",
		keys: ["?"],
		action: () => ({ type: "help-open" }),
		hint: hint("?", "help"),
	},
]

export function modeChain(ctx: KeyContext): ModeName[] {
	if (ctx.confirm !== null) return ["confirm"]
	if (ctx.help) return ["help"]
	if (ctx.input) return ["input"]
	if (ctx.edit) return ["edit"]
	return ctx.detail ? ["detail", "list", "global"] : ["list", "global"]
}

function applies(b: Binding, ctx: KeyContext): boolean {
	if (b.views && !b.views.includes(ctx.view)) return false
	return b.when ? b.when(ctx) : true
}

function matches(b: Binding, key: string): boolean {
	if (b.keys.includes(key)) return true
	if (b.keys.includes(ANY)) return true
	return b.keys.includes(PRINTABLE) && isPrintable(key)
}

/** Ctrl-C always quits; otherwise the first binding in the active mode chain wins. */
export function resolveKey(ctx: KeyContext, key: string): Action | undefined {
	if (key === "<ctrl-c>") return { type: "quit" }
	for (const mode of modeChain(ctx)) {
		for (const b of BINDINGS) {
			if (b.mode !== mode || !applies(b, ctx) || !matches(b, key)) continue
			return b.action(key, ctx)
		}
	}
	return undefined
}

export interface FooterHint {
	key: string
	hint: Hint
	mode: ModeName
}

export function footerHints(ctx: KeyContext): FooterHint[] {
	const out: FooterHint[] = []
	const seen = new Set<string>()
	for (const mode of modeChain(ctx)) {
		for (const b of BINDINGS) {
			if (b.mode !== mode || !b.hint || !applies(b, ctx)) continue
			const h = b.hint(ctx)
			const key = b.keys[0]
			if (!h || key === undefined || seen.has(h.keys)) continue
			seen.add(h.keys)
			out.push({ key, hint: h, mode })
		}
	}
	return out
}

const GLOBAL_PRIORITY: Readonly<Record<string, number>> = { "?": 0, q: 3, r: 4 }
const FILTER_LEGEND = [
	"space = and",
	", = or",
	"!emerg = emergencies only",
] as const

function hintLine(keys: string, label: string): Line {
	return [
		{ text: keys, role: "value" },
		{ text: ` ${label}`, role: "label" },
	]
}

/** Footer priorities (spec §7): ? help 0, mode keys 1, switcher (compact) 2, q quit 3, r reconnect 4. */
export function footerGroups(ctx: KeyContext): Group[] {
	const groups: Group[] = []
	const modal = ctx.confirm !== null || ctx.help || ctx.input || ctx.edit
	if (ctx.heightClass === "compact" && !modal) {
		groups.push({
			priority: 2,
			variants: [
				[
					{
						text: `${VIEW_TITLES[ctx.view]} ${glyphs().sep} 1-5 views`,
						role: "label",
					},
				],
			],
		})
	}
	const hints = footerHints(ctx)
	const mode = hints.filter(h => h.mode !== "global")
	const global = ["r", "q", "?"].flatMap(k =>
		hints.filter(h => h.mode === "global" && h.key === k),
	)
	for (const h of mode) {
		const variants = [hintLine(h.hint.keys, h.hint.label)]
		if (h.hint.rich !== undefined)
			variants.push(hintLine(h.hint.keys, h.hint.rich))
		groups.push({ priority: 1, variants })
	}
	if (ctx.input)
		for (const l of FILTER_LEGEND)
			groups.push({ priority: 5, variants: [[{ text: l, role: "label" }]] })
	for (const h of global)
		groups.push({
			priority: GLOBAL_PRIORITY[h.key] ?? 4,
			variants: [hintLine(h.hint.keys, h.hint.label)],
		})
	return groups
}

export function footerLine(ctx: KeyContext, width: number): Line {
	return fitGroups(footerGroups(ctx), width)
}
