import { afterEach, describe, expect, it } from "vitest"
import { actionKey } from "../../../cli/source/data/types.js"
import type {
	AppState,
	Inbound,
	WriteIntent,
} from "../../../cli/source/data/types.js"
import {
	EMPTY_VIEW_CTX,
	VIEW_ORDER,
	VIEW_TITLES,
	isWrite,
	type Action,
} from "../../../cli/source/ui/actions.js"
import { cell, sp, textCell } from "../../../cli/source/ui/line.js"
import {
	ASCII_GLYPHS,
	UTF8_GLYPHS,
	detectColor,
	detectGlyphMode,
	glyphs,
	roleProps,
	setGlyphMode,
} from "../../../cli/source/ui/theme.js"
import {
	cellWidth,
	lineText,
	padLine,
	padStart,
} from "../../../cli/source/ui/text.js"
import { PRESET_ORDER, initialUi } from "../../../cli/source/ui/ui-state.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"
import { glyphSpan } from "../../../cli/source/ui/strip.js"
import { procRole } from "../../../cli/source/data/decoder-state.js"
import type { GlyphRole } from "../../../cli/source/data/types.js"

describe("data/types contracts", () => {
	it("keys write intents by their target", () => {
		const intents: Array<[WriteIntent, string]> = [
			[
				{ kind: "decoder", op: "restart", decoderId: "readsb" },
				"decoder:readsb",
			],
			[{ kind: "tuner", sourceId: "pi-iq", commands: [] }, "tuner:pi-iq"],
			[{ kind: "audio", op: "start" }, "audio"],
			[{ kind: "preset", name: "nfm", patch: { bandwidth: 12500 } }, "preset"],
		]
		for (const [intent, key] of intents) expect(actionKey(intent)).toBe(key)
	})
	it("type-checks the AppState and Inbound shapes under the root strict flags", () => {
		const inbound: Inbound = { kind: "ws:open", at: 1 }
		const partial: Pick<AppState, "now" | "effects"> = {
			now: 0,
			effects: { polls: [] },
		}
		expect(inbound.kind).toBe("ws:open")
		expect(partial.effects.polls).toEqual([])
	})
})

describe("ui/actions", () => {
	it("lists every view once, with a title", () => {
		expect(VIEW_ORDER).toEqual([
			"overview",
			"decoders",
			"messages",
			"receiver",
			"system",
		])
		for (const v of VIEW_ORDER) expect(VIEW_TITLES[v]).toBeTruthy()
		expect(EMPTY_VIEW_CTX).toEqual({
			hasSelection: false,
			decoderRunning: null,
			control: null,
			audioRunning: null,
			paused: false,
		})
	})
	it("treats only confirm-yes and audio-toggle as writes (T9, P20)", () => {
		const nonWrites: Action[] = [
			{ type: "quit" },
			{ type: "confirm-no" },
			{ type: "decoder-op", op: "restart" },
			{ type: "edit-review" },
			{ type: "control-toggle" },
			{ type: "preset-next" },
			{ type: "notice", text: "x" },
		]
		for (const a of nonWrites) expect(isWrite(a)).toBe(false)
		expect(isWrite({ type: "confirm-yes" })).toBe(true)
		expect(isWrite({ type: "audio-toggle" })).toBe(true)
	})
})

describe("ui/ui-state", () => {
	it("starts on the given view with empty per-view state", () => {
		const ui = initialUi("messages")
		expect(ui.view).toBe("messages")
		expect(ui.help).toBe(false)
		expect(ui.confirm).toBeNull()
		expect(ui.edit).toBeNull()
		expect(ui.quit).toBe(false)
		expect(ui.epoch).toBe(0)
		expect(Object.keys(ui.selected)).toEqual([...VIEW_ORDER])
		for (const v of VIEW_ORDER) {
			expect(ui.selected[v]).toBeNull()
			expect(ui.detail[v]).toEqual({ open: false, scroll: 0 })
		}
		expect(ui.messages).toEqual({
			following: true,
			pausedAtSeq: null,
			filterText: "",
			draft: null,
			preset: "all",
		})
		expect(PRESET_ORDER[0]).toBe(ui.messages.preset)
	})
	it("does not share per-view objects between views", () => {
		const ui = initialUi("overview")
		expect(ui.detail.overview).not.toBe(ui.detail.decoders)
	})
})

describe("ui/theme", () => {
	afterEach(() => setGlyphMode("utf8"))
	it("detects glyph mode from WAVEKIT_ASCII, then LC_ALL, LC_CTYPE, LANG", () => {
		expect(detectGlyphMode({})).toBe("utf8")
		expect(detectGlyphMode({ WAVEKIT_ASCII: "1", LANG: "en_US.UTF-8" })).toBe(
			"ascii",
		)
		expect(detectGlyphMode({ WAVEKIT_ASCII: "0", LANG: "en_US.UTF-8" })).toBe(
			"utf8",
		)
		expect(detectGlyphMode({ LC_ALL: "en_US.UTF-8", LANG: "C" })).toBe("utf8")
		expect(detectGlyphMode({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe("ascii")
		expect(detectGlyphMode({ LC_CTYPE: "de_DE.utf8", LANG: "C" })).toBe("utf8")
		expect(detectGlyphMode({ LANG: "POSIX" })).toBe("ascii")
	})
	it("skips empty locale variables", () => {
		expect(
			detectGlyphMode({ LC_ALL: "", LC_CTYPE: "C", LANG: "en_US.UTF-8" }),
		).toBe("ascii")
		expect(detectGlyphMode({ LC_ALL: "", LC_CTYPE: "", LANG: "" })).toBe("utf8")
		expect(detectGlyphMode({ WAVEKIT_ASCII: "", LANG: "C.UTF-8" })).toBe("utf8")
	})
	it("switches the glyph set", () => {
		expect(glyphs()).toBe(UTF8_GLYPHS)
		setGlyphMode("ascii")
		expect(glyphs()).toBe(ASCII_GLYPHS)
		for (const set of [UTF8_GLYPHS, ASCII_GLYPHS]) {
			expect(set.spark).toHaveLength(8)
			for (const g of [
				set.live,
				set.neutral,
				set.fault,
				set.attention,
				set.unknown,
				set.na,
				set.sep,
				set.confirm,
			]) {
				expect(cellWidth(g)).toBe(1)
			}
		}
	})
	it("drops colour for NO_COLOR or a non-TTY", () => {
		expect(detectColor({}, true)).toBe(true)
		expect(detectColor({}, false)).toBe(false)
		expect(detectColor({ NO_COLOR: "1" }, true)).toBe(false)
		expect(detectColor({ NO_COLOR: "" }, true)).toBe(true)
	})
	it("maps roles to Ink props and keeps bold, dim and inverse without colour", () => {
		expect(roleProps("live", true)).toEqual({ color: "green" })
		expect(roleProps("live", false)).toEqual({})
		expect(roleProps("label", false)).toEqual({ dimColor: true })
		expect(roleProps("selected", true)).toEqual({
			color: "cyan",
			inverse: true,
			bold: true,
		})
		expect(roleProps("selected", false)).toEqual({ inverse: true, bold: true })
		expect(roleProps("value", false, true)).toEqual({ bold: true })
		expect(roleProps("edit", true)).toEqual({ color: "magenta", bold: true })
	})
})

describe("ui/line and ui/text helpers", () => {
	it("builds spans and cells", () => {
		expect(sp("x")).toEqual({ text: "x", role: "value" })
		expect(sp("x", "label", true)).toEqual({
			text: "x",
			role: "label",
			bold: true,
		})
		expect(cell([sp("a")], [sp("ab")])).toEqual({
			variants: [[sp("a")], [sp("ab")]],
		})
		expect(textCell("—", "unknown")).toEqual({
			variants: [[{ text: "—", role: "unknown" }]],
		})
	})
	it("pads at the start and truncates when wider", () => {
		expect(padStart("42", 5)).toBe("   42")
		expect(padStart("漢", 3)).toBe(" 漢")
		expect(padStart("abcdef", 4)).toBe("abc…")
	})
	it("pads a span line to exactly w and joins its text", () => {
		const line = [sp("api ", "label"), sp("● 2s", "live")]
		const padded = padLine(line, 10)
		expect(lineText(padded)).toBe("api ● 2s  ")
		expect(padded[padded.length - 1]).toEqual({ text: "  ", role: "value" })
		expect(lineText(padLine(line, 5))).toBe("api …")
		expect(padLine(line, 8)).toBe(line)
		expect(lineText([])).toBe("")
	})
})

describe("test/scenario-types", () => {
	it("names fourteen scenarios (R43 adds iq-stale, iq-disconnected, decoder-faulted)", () => {
		expect(SCENARIO_NAMES).toHaveLength(14)
		expect(new Set(SCENARIO_NAMES).size).toBe(14)
	})
})

describe("R31: attention is a GlyphRole", () => {
	afterEach(() => setGlyphMode("utf8"))
	it("renders every glyph role, attention as ! in both glyph sets", () => {
		const roles: GlyphRole[] = [
			"live",
			"neutral",
			"attention",
			"unknown",
			"fault",
		]
		for (const r of roles) expect(glyphSpan(r).role).toBe(r)
		expect(glyphSpan("attention")).toEqual({ text: "!", role: "attention" })
		setGlyphMode("ascii")
		expect(glyphSpan("attention").text).toBe("!")
	})
	it("procRole returns a GlyphRole", () => {
		const r: GlyphRole = procRole("restarting")
		expect(r).toBe("attention")
	})
})
