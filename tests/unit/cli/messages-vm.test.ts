import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import { reduce } from "../../../cli/source/data/reducers.js"
import {
	createRing,
	ringNewestSeq,
	ringPush,
} from "../../../cli/source/data/ring-buffer.js"
import type { AppState, MessageEntry } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { lineText } from "../../../cli/source/ui/text.js"
import {
	initialUi,
	type MessagesUi,
	type UiState,
} from "../../../cli/source/ui/ui-state.js"
import {
	feedView,
	inputLine,
	messageDetail,
	messagesHeader,
	messagesModel,
} from "../../../cli/source/view-models/messages.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const deps = { summarize: formatMessage }

const entry = (decoderId: string): Omit<MessageEntry, "seq"> => ({
	decoderId,
	type: "t",
	receivedAt: 0,
	output: { type: "t", decoder: decoderId, timestamp: "x", data: null },
	formatted: {
		protocol: "T",
		category: decoderId === "d1" ? "aircraft" : "data",
		segments: [],
		fields: [],
		emergency: false,
		searchText: decoderId,
	},
})

const withMessages = (patch: Partial<MessagesUi>): UiState => {
	const ui = initialUi("messages")
	return { ...ui, messages: { ...ui.messages, ...patch } }
}
const listText = (s: AppState, ui: UiState, w = 119, h = 35): string =>
	messagesModel(s, ui, w, h, true).list.map(lineText).join("\n")

describe("feedView", () => {
	// Feature: cli-dashboard-overhaul, Property 11: pause
	// Validates: spec §6.3
	it("P11: while paused, visible rows ⊆ rows at pause time; new = matching appends", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom("d1", "d2", "d3"), {
					minLength: 1,
					maxLength: 60,
				}),
				fc.array(fc.constantFrom("d1", "d2", "d3"), { maxLength: 60 }),
				fc.constantFrom("", "d1", "d2,d3"),
				(before, after, filterText) => {
					const ring = createRing()
					for (const d of before) ringPush(ring, entry(d))
					const mu: MessagesUi = {
						following: false,
						pausedAtSeq: ringNewestSeq(ring),
						filterText,
						draft: null,
						preset: "all",
					}
					const atPause = new Set(feedView(ring, mu).visible.map(e => e.seq))
					for (const d of after) ringPush(ring, entry(d))
					const later = feedView(ring, mu)
					for (const e of later.visible) expect(atPause.has(e.seq)).toBe(true)
					const alts = filterText === "" ? null : filterText.split(",")
					expect(later.newCount).toBe(
						after.filter(d => alts === null || alts.includes(d)).length,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("messages header and states", () => {
	const s = scenarioState("burst", deps)
	it("shows pause, filter and counts", () => {
		const mu: MessagesUi = {
			following: false,
			pausedAtSeq: -1,
			filterText: "readsb,ais",
			draft: null,
			preset: "all",
		}
		const fv = feedView(s.messages.ring, mu)
		// Every readsb and ais-catcher row of the fixture (4 + 3) arrived after seq -1.
		expect(fv.newCount).toBe(7)
		expect(lineText(messagesHeader(s, mu, fv, 119))).toBe(
			`MESSAGES  paused · 7 new · filter readsb,ais · ${fv.matching} of ${fv.total}`,
		)
	})
	it("adds aircraft tracker stats for the aircraft preset", () => {
		const mu: MessagesUi = {
			following: true,
			pausedAtSeq: null,
			filterText: "",
			draft: null,
			preset: "aircraft",
		}
		expect(
			lineText(messagesHeader(s, mu, feedView(s.messages.ring, mu), 119)),
		).toContain("preset aircraft · 14 tracked · 9 with position")
	})
	it("explains an empty filter result and an empty feed", () => {
		expect(
			listText(s, withMessages({ filterText: "nothing-matches" })),
		).toMatch(/0 of \d+ match "nothing-matches"/)
		const idle = scenarioState("idle", deps)
		expect(listText(idle, initialUi("messages"))).toMatch(
			/^no decodes since \d\d:\d\d \(.+\) · 2 of 9 decoders in window · rx 445\.971 MHz$/m,
		)
	})
	it("fits the empty-feed line to a 60-column frame, dropping the window count first", () => {
		const idle = scenarioState("idle", deps)
		const text = listText(idle, initialUi("messages"), 59, 12)
		expect([...text].length).toBeLessThanOrEqual(59)
		expect(text).toMatch(
			/^no decodes since \d\d:\d\d \(.+\) · rx 445\.971 MHz$/,
		)
	})
	it("never claims a quiet live feed when the socket is down or never opened", () => {
		const idle = scenarioState("idle", deps)
		const closed: AppState = reduce(
			idle,
			[
				{
					kind: "ws:close",
					at: idle.now,
					code: 1006,
					reason: "",
					nextRetryAt: idle.now + 1000,
				},
			],
			idle.now,
			deps,
		)
		const lines = listText(closed, initialUi("messages")).split("\n")
		// The open gap row keeps its place at the top; the explanation follows.
		expect(lines[0]).toMatch(/^── gap since /)
		expect(lines[1]).toMatch(
			/^no decodes cached · feed stopped \d\d:\d\d:\d\d$/,
		)
		// A fresh state: reduce() mutates the ring in place, so `idle` now holds a gap.
		const fresh = scenarioState("idle", deps)
		const never: AppState = {
			...fresh,
			conn: {
				...fresh.conn,
				ws: { ...fresh.conn.ws, state: "connecting", since: null },
			},
		}
		expect(listText(never, initialUi("messages"))).toMatch(
			/^no decodes · live feed connecting/,
		)
		// Failed connects leave the socket "closed" too, but it never ran: not "stopped".
		const failed: AppState = {
			...never,
			conn: {
				...never.conn,
				ws: { ...never.conn.ws, state: "closed", since: never.now - 5000 },
			},
		}
		expect(listText(failed, initialUi("messages"))).toMatch(
			/^no decodes · live feed connecting/,
		)
	})
	it("renders the aircraft detail with label/value rows and bounded JSON", () => {
		const e = s.messages.ring.entries.find(x => x.decoderId === "readsb")!
		const lines = messageDetail(e, 119, 20, 0).map(lineText)
		expect(lines[0]).toMatch(/^readsb · aircraft · \d\d:\d\d:\d\d\.\d{3}$/)
		expect(lines.join("\n")).toContain("squawk !7700 emergency")
		// Core's readsb wire shape (R33): `icao`, not readsb's own `hex`.
		expect(lines.some(l => l.includes('"icao": "4CA9D2"'))).toBe(true)
		expect(lines.length).toBeLessThanOrEqual(20)
	})
	it("detail scroll is clamped so the last page stays full", () => {
		const e = s.messages.ring.entries.find(x => x.decoderId === "readsb")!
		const all = messageDetail(e, 119, 1000, 0)
		const last = messageDetail(e, 119, 6, 10_000).map(lineText)
		expect(last).toHaveLength(6)
		expect(last.slice(1)).toEqual(all.slice(-5).map(lineText))
	})
})

describe("detail placement", () => {
	it("a bottom detail under a short list takes the rows the list leaves free", () => {
		const s = scenarioState("burst", deps)
		const mu = { filterText: "readsb,ais", following: false, pausedAtSeq: 1e9 }
		const fv = feedView(s.messages.ring, {
			...initialUi("messages").messages,
			...mu,
		})
		const first = fv.visible[0]!
		const base = withMessages(mu)
		const ui: UiState = {
			...base,
			selected: { ...base.selected, messages: String(first.seq) },
			detail: { ...base.detail, messages: { open: true, scroll: 0 } },
		}
		const m = messagesModel(s, ui, 119, 35, true)
		expect(m.placement.kind).toBe("bottom")
		const full = messageDetail(first, 119, 1000, 0)
		// 7 list rows + 1 blank leave 26 of the 34 body rows: the whole detail fits.
		expect(m.list).toHaveLength(7)
		expect(m.detail?.map(lineText)).toEqual(full.map(lineText))
		expect(m.list.length + 1 + (m.detail?.length ?? 0)).toBeLessThanOrEqual(34)
	})
})

describe("hostile text (review focus 4)", () => {
	const s = scenarioState("burst", deps)
	it("sanitises the draft, the applied filter and the empty-result echo", () => {
		const evil = "a\u001b[2J\u0007b\u009bc"
		const draft = lineText(inputLine(evil, 40))
		expect(draft).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
		expect(draft.startsWith("/ ")).toBe(true)
		const ui = withMessages({ filterText: evil })
		const fv = feedView(s.messages.ring, ui.messages)
		expect(lineText(messagesHeader(s, ui.messages, fv, 119))).not.toMatch(
			/[\u0000-\u001f\u007f-\u009f]/,
		)
		expect(listText(s, ui)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
	})
	it("keeps the input line inside its width", () => {
		const line = inputLine("x".repeat(500), 40)
		expect([...lineText(line)].length).toBeLessThanOrEqual(40)
	})
})

describe("gaps", () => {
	it("an open gap sits at the top of the feed while the socket is down", () => {
		const live = scenarioState("live", deps)
		const down = reduce(
			live,
			[
				{
					kind: "ws:close",
					at: live.now,
					code: 1006,
					reason: "",
					nextRetryAt: live.now + 1000,
				},
			],
			live.now + 1,
			deps,
		)
		const first = listText(down, initialUi("messages")).split("\n")[0]
		expect(first).toMatch(/^── gap since \d\d:\d\d:\d\d · /)
	})
})

const close = (s: AppState, at: number): AppState =>
	reduce(
		s,
		[{ kind: "ws:close", at, code: 1006, reason: "", nextRetryAt: at + 1000 }],
		at,
		deps,
	)
const headerOf = (s: AppState, mu: MessagesUi, width = 119): string =>
	lineText(messagesHeader(s, mu, feedView(s.messages.ring, mu), width))
const following = initialUi("messages").messages

describe("T40 fix round 1: header truth", () => {
	it("I1: a feed that never went live shows its state, not 0 in 60s", () => {
		const idle = scenarioState("idle", deps)
		const never: AppState = {
			...idle,
			conn: {
				...idle.conn,
				ws: { ...idle.conn.ws, state: "connecting", since: null },
			},
		}
		const h = headerOf(never, following)
		expect(h).toBe("MESSAGES  live feed connecting")
	})
	it("I1/I2: a feed that ran empty and stopped says when it stopped, from the gap", () => {
		const idle = scenarioState("idle", deps)
		const stopped = close(idle, idle.now - 30_000)
		const from = stopped.messages.ring.gaps.at(-1)!.from
		// A later failed retry moves ws.since; the stop time must not move with it.
		const retried = close(stopped, idle.now)
		expect(retried.conn.ws.since).toBe(idle.now)
		const clock = new Date(from).toISOString().slice(11, 19)
		expect(headerOf(retried, following)).toBe(
			`MESSAGES  feed stopped ${clock} · 0 cached`,
		)
	})
	it("I4: a full ring whose oldest entry is under 60 s old reads 1000+", () => {
		const s = scenarioState("idle", deps)
		for (let i = 0; i < 1001; i++)
			ringPush(s.messages.ring, { ...entry("d2"), receivedAt: s.now - 1000 })
		expect(headerOf(s, following)).toMatch(
			/^MESSAGES {2}1000\+ in 60s · \d+ total$/,
		)
	})
	it("M6: a long filter never pushes the counts off a fitted header", () => {
		const s = scenarioState("burst", deps)
		const mu = { ...following, filterText: "readsb ".repeat(30).trim() }
		const h = headerOf(s, mu, 59)
		expect([...h].length).toBeLessThanOrEqual(59)
		expect(h).toMatch(/\d+ of \d+$/)
	})
})

describe("T40 fix round 1: pause", () => {
	it("I3: a paused slice with only newer matches says so instead of 0 of N", () => {
		const s = scenarioState("burst", deps)
		const mu = { ...following, following: false, pausedAtSeq: -1 }
		expect(listText(s, withMessages(mu))).toMatch(
			/^nothing before the pause · 12 new · G newest$/,
		)
	})
	it("M4: pausing an empty list freezes it (header and rows agree)", () => {
		const ring = createRing()
		const mu = { ...following, following: false, pausedAtSeq: null }
		for (const d of ["d1", "d2"]) ringPush(ring, entry(d))
		const fv = feedView(ring, mu)
		expect(fv.visible).toEqual([])
		expect(fv.newCount).toBe(2)
	})
	it("M5: a gap newer than the pause point stays out of the frozen slice", () => {
		const ring = createRing()
		for (const d of ["d1", "d2", "d3"]) ringPush(ring, entry(d))
		ring.gaps.push({ afterSeq: 2, from: 10, to: null })
		ring.gaps.push({ afterSeq: 0, from: 5, to: 6 })
		const fv = feedView(ring, {
			...following,
			following: false,
			pausedAtSeq: 1,
		})
		expect(
			fv.rows
				.filter(r => r.kind === "gap")
				.map(r => r.kind === "gap" && r.gap.afterSeq),
		).toEqual([0])
	})
})

describe("T40 fix round 1: input and detail", () => {
	it("I5: a 100 KB paste is clipped in linear time and keeps its tail", () => {
		const big = "a".repeat(100_000) + "TAIL"
		const t0 = performance.now()
		const line = inputLine(big, 60)
		expect(performance.now() - t0).toBeLessThan(250)
		const text = lineText(line)
		expect([...text].length).toBeLessThanOrEqual(60)
		expect(text.endsWith("TAIL▏")).toBe(true)
	})
	it("I7: the detail wraps the text body and long JSON values instead of cutting them", () => {
		const s = scenarioState("long-text", deps)
		const e = [...s.messages.ring.entries].sort(
			(a, b) =>
				(b.formatted.text?.length ?? 0) - (a.formatted.text?.length ?? 0),
		)[0]!
		expect(e.formatted.text!.length).toBeGreaterThan(2 * 59)
		const lines = messageDetail(e, 59, 10_000, 0).map(lineText)
		for (const l of lines) expect([...l].length).toBeLessThanOrEqual(59)
		const joined = lines.join(" ").replace(/\s+/g, " ")
		const words = e.formatted.text!.split(/\s+/).filter(w => w !== "")
		for (const w of words.slice(0, 50)) expect(joined).toContain(w)
		// The JSON string holding the same text is wrapped, not cut with an ellipsis.
		expect(lines.filter(l => l.endsWith("…")).length).toBe(0)
	})
})
