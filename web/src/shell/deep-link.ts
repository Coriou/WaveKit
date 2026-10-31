// Deep links: the address bar's hash names what is on screen, and a link opens it again. `#/map`, `#/messages`,
// `#/activity?t=talkgroup:1201&cat=voice&range=today&audio=1`, `#/activity/<eventId>`, `#/scanner/<discoveryId>`,
// `#/recordings`, `#/settings/<settingId>` (the setting is highlighted, as from ⌘K). With a drawer over the map or
// Messages, `view=` keeps the view. A hash never reaches the core, so a link works from any path the app is served
// at and the service worker's shell answers it offline. The bar is rewritten in place (no history entry per click).
import type { DrawerId, ViewId } from "./store.ts"
import { DRAWERS, VIEWS } from "./store.ts"
import type {
	CategoryChipId,
	SearchToken,
	TokenKind,
} from "../features/activity/search.ts"
import {
	CATEGORY_CHIPS,
	decoderToken,
	token,
} from "../features/activity/search.ts"
import type { PresetRangeId, TimeRange } from "../features/activity/scope.ts"
import { ANY_TIME, TIME_RANGES } from "../features/activity/scope.ts"

export interface ActivityLink {
	tokens: readonly SearchToken[]
	chip: CategoryChipId | null
	range: TimeRange
	audio: boolean
	openId: string | null
}

export interface LinkState {
	view: ViewId
	drawer: DrawerId | null
	/** With the Activity drawer: its search, scope and open event. */
	activity?: ActivityLink
	/** With the Scanner drawer: the open discovery. */
	discoveryId?: string | null
	/** With the Settings drawer, read only: the setting to highlight. */
	settingId?: string | null
}

const TOKEN_KINDS = new Set<TokenKind>([
	"talkgroup",
	"capcode",
	"mmsi",
	"icao",
	"callsign",
	"frequency",
	"ctcss",
	"dcs",
	"entity",
	"decoder",
	"text",
])

const isDrawer = (x: string): x is DrawerId =>
	(DRAWERS as readonly string[]).includes(x)
const isView = (x: string): x is ViewId =>
	(VIEWS as readonly string[]).includes(x)

/** The longest decoder display name a link carries; a longer one is left out (the chip shows the id). */
export const DECODER_NAME_MAX = 64
const DECODER_LABEL = "Decoder "

// A decoder token is `decoder:<id>~<name>`, both percent-encoded with "~" as %7E, so an id holding "~" stays
// unambiguous; the name is the chip's display name, left out when it adds nothing.
const encodePart = (s: string): string =>
	encodeURIComponent(s).replace(/~/g, "%7E")

function decodePart(s: string): string | null {
	try {
		return decodeURIComponent(s)
	} catch {
		return null
	}
}

function decoderName(t: SearchToken): string | null {
	if (!t.label.startsWith(DECODER_LABEL)) return null
	if (t.label === token("decoder", t.value).label) return null
	const name = t.label.slice(DECODER_LABEL.length).trim()
	return name !== "" && name.length <= DECODER_NAME_MAX ? name : null
}

function formatToken(t: SearchToken): string {
	if (t.kind === "decoder") {
		const name = decoderName(t)
		return `decoder:${encodePart(t.value)}${name === null ? "" : `~${encodePart(name)}`}`
	}
	const span =
		t.kind === "frequency" && t.spanHz !== undefined ? `~${t.spanHz}` : ""
	return `${t.kind}:${t.value}${span}`
}

function parseToken(raw: string): SearchToken | null {
	const colon = raw.indexOf(":")
	if (colon <= 0) return null
	const kind = raw.slice(0, colon) as TokenKind
	let value = raw.slice(colon + 1)
	if (!TOKEN_KINDS.has(kind) || value.trim() === "") return null
	if (kind === "frequency") {
		const [hz, span] = value.split("~")
		const n = Number(hz)
		if (!Number.isFinite(n) || n <= 0) return null
		value = String(Math.round(n))
		const s = span === undefined ? Number.NaN : Number(span)
		return token(kind, value, Number.isFinite(s) && s > 0 ? { spanHz: s } : {})
	}
	if (kind === "decoder") {
		const tilde = value.indexOf("~")
		const id = decodePart(tilde < 0 ? value : value.slice(0, tilde))
		if (id === null || id.trim() === "") return null
		const name = tilde < 0 ? null : decodePart(value.slice(tilde + 1))?.trim()
		return decoderToken(
			id,
			name && name.length <= DECODER_NAME_MAX ? name : undefined,
		)
	}
	return token(kind, value)
}

function formatRange(r: TimeRange): string | null {
	if (r.kind === "any") return null
	if (r.kind !== "custom") return r.kind
	const from = new Date(r.from).toISOString()
	return `${from}..${r.to === null ? "" : new Date(r.to).toISOString()}`
}

function parseRange(raw: string | null): TimeRange {
	if (raw === null) return ANY_TIME
	if (TIME_RANGES.some(x => x.id === raw)) return { kind: raw as PresetRangeId }
	const [a, b] = raw.split("..")
	const from = a ? Date.parse(a) : Number.NaN
	if (!Number.isFinite(from)) return ANY_TIME
	const to = b ? Date.parse(b) : null
	if (to !== null && (!Number.isFinite(to) || to <= from)) return ANY_TIME
	return { kind: "custom", from, to }
}

/** The hash for a state ("" for the bare spectrum). */
export function formatLink(s: LinkState): string {
	const path: string[] = []
	const q = new URLSearchParams()
	if (s.drawer !== null) {
		path.push(s.drawer)
		if (s.view !== "spectrum") q.set("view", s.view)
		if (s.drawer === "activity" && s.activity) {
			const a = s.activity
			if (a.openId !== null) path.push(a.openId)
			for (const t of a.tokens) q.append("t", formatToken(t))
			if (a.chip !== null) q.set("cat", a.chip)
			const range = formatRange(a.range)
			if (range !== null) q.set("range", range)
			if (a.audio) q.set("audio", "1")
		} else if (s.drawer === "scanner" && s.discoveryId) path.push(s.discoveryId)
		else if (s.drawer === "settings" && s.settingId) path.push(s.settingId)
	} else if (s.view !== "spectrum") path.push(s.view)
	if (path.length === 0) return ""
	const query = q.toString()
	return `#/${path.map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`
}

/** A hash back to a state; null when it names nothing this app knows (the hash is left alone). */
export function parseLink(hash: string): LinkState | null {
	const raw = hash.startsWith("#") ? hash.slice(1) : hash
	if (raw === "" || raw === "/") return { view: "spectrum", drawer: null }
	if (!raw.startsWith("/")) return null
	const qAt = raw.indexOf("?")
	const pathPart = qAt < 0 ? raw.slice(1) : raw.slice(1, qAt)
	const q = new URLSearchParams(qAt < 0 ? "" : raw.slice(qAt + 1))
	let path: string[]
	try {
		path = pathPart.split("/").filter(Boolean).map(decodeURIComponent)
	} catch {
		return null
	}
	const head = path[0] ?? ""
	const item = path[1] ?? null
	if (isView(head) && !isDrawer(head)) return { view: head, drawer: null }
	if (!isDrawer(head)) return null
	const viewParam = q.get("view")
	const view: ViewId =
		viewParam !== null && isView(viewParam) ? viewParam : "spectrum"
	const out: LinkState = { view, drawer: head }
	if (head === "activity") {
		const tokens: SearchToken[] = []
		for (const t of q.getAll("t")) {
			const parsed = parseToken(t)
			if (
				parsed &&
				!tokens.some(x => x.kind === parsed.kind && x.value === parsed.value)
			)
				tokens.push(parsed)
		}
		const cat = q.get("cat")
		out.activity = {
			tokens,
			chip: CATEGORY_CHIPS.find(c => c.id === cat)?.id ?? null,
			range: parseRange(q.get("range")),
			audio: q.get("audio") === "1",
			openId: item,
		}
	} else if (head === "scanner") out.discoveryId = item
	else if (head === "settings") out.settingId = item
	return out
}
