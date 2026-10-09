import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	VIEW_ORDER,
	isWrite,
	type ViewId,
} from "../../../cli/source/ui/actions.js"
import {
	RECEIVER_EXTERNAL_NOTICE,
	RECEIVER_UNKNOWN_NOTICE,
	footerHints,
	footerLine,
	keyName,
	resolveKey,
	type KeyContext,
} from "../../../cli/source/ui/keymap.js"
import { lineText } from "../../../cli/source/ui/text.js"

const base: KeyContext = {
	view: "overview",
	confirm: null,
	help: false,
	input: false,
	edit: false,
	detail: false,
	heightClass: "roomy",
	rows: 3,
	v: {
		hasSelection: false,
		decoderRunning: null,
		control: null,
		audioRunning: null,
		paused: false,
	},
}

describe("keyName", () => {
	it("normalises Ink keys; Backspace and Delete are the same key", () => {
		expect(keyName("", { backspace: false, delete: true })).toBe("<backspace>")
		expect(keyName("", { backspace: true })).toBe("<backspace>")
		expect(keyName("c", { ctrl: true })).toBe("<ctrl-c>")
		expect(keyName("", { escape: true, meta: true })).toBe("<esc>")
		expect(keyName("", { tab: true, shift: true })).toBe("<shift-tab>")
		expect(keyName(" ", {})).toBe("<space>")
		expect(keyName("q", {})).toBe("q")
	})
})

describe("resolveKey", () => {
	it("walks confirm → help → input → edit → detail → list → global", () => {
		expect(resolveKey({ ...base, confirm: "decoder" }, "1")).toBeUndefined()
		expect(resolveKey({ ...base, confirm: "decoder" }, "y")).toEqual({
			type: "confirm-yes",
		})
		expect(
			resolveKey({ ...base, confirm: "decoder" }, "<enter>"),
		).toBeUndefined()
		expect(resolveKey({ ...base, help: true }, "x")).toEqual({
			type: "help-close",
		})
		expect(resolveKey({ ...base, view: "messages", input: true }, "q")).toEqual(
			{ type: "filter-type", text: "q" },
		)
		expect(
			resolveKey({ ...base, view: "messages", input: true }, "<ctrl-c>"),
		).toEqual({ type: "quit" })
		expect(resolveKey({ ...base, view: "receiver", edit: true }, "7")).toEqual({
			type: "edit-key",
			key: "7",
		})
		expect(
			resolveKey({ ...base, view: "decoders", detail: true }, "<esc>"),
		).toEqual({ type: "escape" })
		expect(resolveKey(base, "3")).toEqual({ type: "view", view: "messages" })
		expect(resolveKey(base, "q")).toEqual({ type: "quit" })
	})
	it("gates decoder controls on selection and running state", () => {
		const d = {
			...base,
			view: "decoders" as ViewId,
			v: { ...base.v, hasSelection: true, decoderRunning: true },
		}
		expect(resolveKey(d, "x")).toEqual({ type: "decoder-op", op: "stop" })
		expect(resolveKey(d, "s")).toBeUndefined()
		expect(
			resolveKey({ ...d, v: { ...d.v, decoderRunning: false } }, "s"),
		).toEqual({ type: "decoder-op", op: "start" })
		expect(resolveKey(d, "R")).toEqual({ type: "decoder-op", op: "restart" })
	})
	it("reports external control on e instead of editing", () => {
		const r = {
			...base,
			view: "receiver" as ViewId,
			v: { ...base.v, control: "external" as const },
		}
		expect(resolveKey(r, "e")).toEqual({
			type: "notice",
			text: "controlled externally · c to take control",
		})
		expect(
			resolveKey({ ...r, v: { ...r.v, control: "internal" } }, "e"),
		).toEqual({ type: "edit-open" })
	})
})

describe("fix round 1", () => {
	const receiver = (control: KeyContext["v"]["control"]): KeyContext => ({
		...base,
		view: "receiver",
		v: { ...base.v, control },
	})
	it("says control is unknown on e, naming no key, while control is unknown", () => {
		expect(resolveKey(receiver(null), "e")).toEqual({
			type: "notice",
			text: RECEIVER_UNKNOWN_NOTICE,
		})
		expect(RECEIVER_UNKNOWN_NOTICE).not.toMatch(/\bc\b/)
		expect(resolveKey(receiver(null), "c")).toBeUndefined()
		expect(resolveKey(receiver("external"), "e")).toEqual({
			type: "notice",
			text: RECEIVER_EXTERNAL_NOTICE,
		})
		expect(lineText(footerLine(receiver(null), 119))).toBe(
			"r reconnect  q quit  ? help",
		)
	})
	it("hints Enter only when there is a row to open", () => {
		const empty = { ...base, view: "decoders" as ViewId, rows: 0 }
		expect(resolveKey(empty, "<enter>")).toBeUndefined()
		expect(lineText(footerLine(empty, 119))).not.toContain("Enter")
	})
	it("hints G only when it would change something", () => {
		const m = { ...base, view: "messages" as ViewId }
		expect(resolveKey(m, "G")).toBeUndefined()
		expect(lineText(footerLine(m, 119))).not.toContain("newest")
		const paused = { ...m, v: { ...m.v, paused: true } }
		expect(resolveKey(paused, "G")).toEqual({ type: "newest" })
		expect(lineText(footerLine(paused, 119))).toContain("G newest")
	})
	it("gives the Overview decoder list g, G, PgUp and PgDn (§7)", () => {
		expect(resolveKey(base, "g")).toEqual({ type: "top" })
		expect(resolveKey(base, "G")).toEqual({ type: "newest" })
		expect(resolveKey(base, "<pgup>")).toEqual({ type: "page", delta: -1 })
		expect(resolveKey(base, "<pgdn>")).toEqual({ type: "page", delta: 1 })
	})
})

describe("B5 fix round 1", () => {
	it("I4: PgUp/PgDn scroll the Decoders detail; the §6.2 footer is unchanged", () => {
		const d = {
			...base,
			view: "decoders" as ViewId,
			detail: true,
			v: { ...base.v, hasSelection: true, decoderRunning: true },
		}
		expect(resolveKey(d, "<pgdn>")).toEqual({ type: "detail-scroll", delta: 1 })
		expect(resolveKey(d, "<pgup>")).toEqual({
			type: "detail-scroll",
			delta: -1,
		})
		expect(lineText(footerLine(d, 119))).toBe(
			"↑↓ select  Esc close  x stop  R restart  r reconnect  q quit  ? help",
		)
	})
})

describe("footer", () => {
	it("matches the spec footers", () => {
		expect(lineText(footerLine(base, 119))).toBe(
			"↑↓ select decoder  Enter open  r reconnect  q quit  ? help",
		)
		expect(lineText(footerLine({ ...base, heightClass: "compact" }, 79))).toBe(
			"Overview · 1-5 views  ↑↓ select  Enter open  r reconnect  q quit  ? help",
		)
		const d = {
			...base,
			view: "decoders" as ViewId,
			detail: true,
			v: { ...base.v, hasSelection: true, decoderRunning: true },
		}
		expect(lineText(footerLine(d, 119))).toBe(
			"↑↓ select  Esc close  x stop  R restart  r reconnect  q quit  ? help",
		)
		const r = {
			...base,
			view: "receiver" as ViewId,
			v: { ...base.v, control: "external" as const },
		}
		expect(lineText(footerLine(r, 119))).toBe(
			"c take control  r reconnect  q quit  ? help",
		)
		const e = { ...base, view: "receiver" as ViewId, edit: true }
		expect(lineText(footerLine(e, 119))).toBe(
			"←→ digit  ↑↓ change  0-9 type  Tab next field  Space toggle  Enter review  Esc discard",
		)
		const i = { ...base, view: "messages" as ViewId, input: true }
		expect(lineText(footerLine(i, 119))).toBe(
			"Enter apply  Esc cancel  space = and  , = or  !emerg = emergencies only",
		)
	})
})

const arbCtx: fc.Arbitrary<KeyContext> = fc.record({
	view: fc.constantFrom(...VIEW_ORDER),
	confirm: fc.constantFrom(
		null,
		"decoder",
		"tuner",
		"control",
		"preset",
	) as fc.Arbitrary<KeyContext["confirm"]>,
	help: fc.boolean(),
	input: fc.boolean(),
	edit: fc.boolean(),
	detail: fc.boolean(),
	rows: fc.integer({ min: 0, max: 3 }),
	heightClass: fc.constantFrom("roomy", "compact") as fc.Arbitrary<
		KeyContext["heightClass"]
	>,
	v: fc.record({
		hasSelection: fc.boolean(),
		decoderRunning: fc.constantFrom(null, true, false),
		control: fc.constantFrom(null, "internal", "external") as fc.Arbitrary<
			KeyContext["v"]["control"]
		>,
		audioRunning: fc.constantFrom(null, true, false),
		paused: fc.boolean(),
	}),
})
const NAV = [
	"<up>",
	"<down>",
	"<left>",
	"<right>",
	"<pgup>",
	"<pgdn>",
	"<tab>",
	"<shift-tab>",
	"<enter>",
	"<esc>",
	"<space>",
	"<backspace>",
	"g",
	"G",
	"j",
	"k",
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
]
const ALL = [
	...NAV,
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ?/!,.",
]

describe("P20", () => {
	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7
	it("P20: in input mode every printable key types", () => {
		fc.assert(
			fc.property(
				arbCtx,
				fc
					.string({ minLength: 1, maxLength: 4 })
					.filter(
						s =>
							!/[\u0000-\u001f\u007f-\u009f]/.test(s) &&
							!(s.startsWith("<") && s.endsWith(">")),
					),
				(ctx, s) => {
					const c = { ...ctx, confirm: null, help: false, input: true }
					const a = resolveKey(c, keyName(s, {}))
					expect(a).toEqual({ type: "filter-type", text: s })
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7
	it("P20: no navigation key resolves to a write in any mode", () => {
		fc.assert(
			fc.property(arbCtx, fc.constantFrom(...NAV), (ctx, key) => {
				const a = resolveKey(ctx, key)
				expect(a === undefined || !isWrite(a)).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7, T9
	it("P20: writes come only from confirm y (and audio a in System list mode)", () => {
		fc.assert(
			fc.property(arbCtx, fc.constantFrom(...ALL), (ctx, key) => {
				const a = resolveKey(ctx, key)
				if (!a || !isWrite(a)) return
				const modal = ctx.confirm !== null || ctx.help || ctx.input || ctx.edit
				if (a.type === "confirm-yes")
					expect(ctx.confirm !== null && key === "y").toBe(true)
				else
					expect(
						a.type === "audio-toggle" &&
							key === "a" &&
							ctx.view === "system" &&
							!modal,
					).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7
	it("P20: every footer hint resolves to its own binding's action", () => {
		fc.assert(
			fc.property(arbCtx, ctx => {
				for (const h of footerHints(ctx))
					expect(resolveKey(ctx, h.key)).toEqual(h.action)
			}),
			{ numRuns: 100 },
		)
	})
})
