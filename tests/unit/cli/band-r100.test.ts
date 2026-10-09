import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "../../../cli/source/data/api-client.js"
import type { FetchLike } from "../../../cli/source/data/config.js"
import { guardDecoder } from "../../../cli/source/data/guards.js"
import {
	bandLabel,
	decoderBand,
} from "../../../cli/source/data/nominal-bands.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import type { AppState, DecoderRow } from "../../../cli/source/data/types.js"
import { retuneImpact } from "../../../cli/source/data/window.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { EMPTY_VIEW_CTX, type ViewId } from "../../../cli/source/ui/actions.js"
import {
	footerLine,
	resolveKey,
	type KeyContext,
} from "../../../cli/source/ui/keymap.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"
import {
	decoderCells,
	decoderFacts,
	type DecoderFacts,
} from "../../../cli/source/view-models/decoder-rows.js"
import {
	corePins,
	decoderActionText,
	decoderConfirm,
	decoderDetail,
	suspensionKind,
} from "../../../cli/source/view-models/decoders.js"

const base = {
	id: "rtl433",
	type: "rtl433",
	running: true,
	health: "idle",
	uptime: 51,
	restartCount: 0,
	stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
}
const band = (b: Record<string, unknown>) =>
	guardDecoder({ ...base, bandAssessment: { verdict: "in-band", ...b } })
		?.bandAssessment

describe("R100 guards", () => {
	// Feature: cli-dashboard-overhaul, R100: band defaults are all or nothing
	it("keeps rangesHz only when every range is finite with minHz <= maxHz", () => {
		const range = fc.record({
			minHz: fc.double({ min: 1, max: 6e9, noNaN: true }),
			maxHz: fc.double({ min: 1, max: 6e9, noNaN: true }),
		})
		fc.assert(
			fc.property(fc.array(range, { minLength: 1, maxLength: 8 }), ranges => {
				const valid = ranges.every(r => r.minHz <= r.maxHz)
				const got = band({ rangesHz: ranges })?.rangesHz
				expect(got).toEqual(valid ? ranges : undefined)
			}),
			{ numRuns: 100 },
		)
	})
	it("drops the whole list for one malformed range", () => {
		const junk = fc.oneof(
			fc.constant(null),
			fc.constant({ minHz: Number.NaN, maxHz: 1 }),
			fc.constant({ minHz: 1, maxHz: Number.POSITIVE_INFINITY }),
			fc.constant({ minHz: "1", maxHz: 2 }),
			fc.constant({ minHz: 5, maxHz: 4 }),
			fc.string(),
		)
		fc.assert(
			fc.property(junk, fc.nat({ max: 3 }), (bad, at) => {
				const ranges: unknown[] = [
					{ minHz: 1e8, maxHz: 2e8 },
					{ minHz: 3e8, maxHz: 3e8 },
				]
				ranges.splice(at % 3, 0, bad)
				expect(band({ rangesHz: ranges })?.rangesHz).toBeUndefined()
			}),
			{ numRuns: 100 },
		)
		expect(band({ rangesHz: [] })?.rangesHz).toBeUndefined()
	})
	it("keeps region, overrideSource and startMode as text, and drops the wrong shapes", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), fc.string(), (code, source, m) => {
				const d = guardDecoder({
					...base,
					startMode: m,
					bandAssessment: {
						verdict: "in-band",
						region: { code, source },
						overrideSource: source,
					},
				})
				expect(d?.startMode).toBe(m)
				expect(d?.bandAssessment?.region).toEqual({ code, source })
				expect(d?.bandAssessment?.overrideSource).toBe(source)
			}),
			{ numRuns: 100 },
		)
		const d = guardDecoder({
			...base,
			startMode: 1,
			bandAssessment: { verdict: "in-band", region: { code: "EU" } },
		})
		expect(d).toBeDefined()
		expect(d?.startMode).toBeUndefined()
		expect(d?.bandAssessment?.region).toBeUndefined()
	})
})

describe("R100 band from ranges", () => {
	afterEach(() => setGlyphMode("utf8"))
	const ranges = [
		{ minHz: 433_050_000, maxHz: 434_790_000 },
		{ minHz: 868_000_000, maxHz: 870_000_000 },
	]
	const subject = (b: Record<string, unknown>) => ({
		type: "rtl433",
		bandAssessment: { verdict: "out-of-band" as const, ...b },
	})
	it("uses core's ranges when there are no targets, with the basis as origin", () => {
		const b = decoderBand(
			subject({ rangesHz: ranges, basis: "region-default" }),
		)
		expect(b?.origin).toBe("region-default")
		expect(b && bandLabel(b.band, "–")).toBe("433.050–434.790 +1")
		expect(
			decoderBand(subject({ rangesHz: ranges, basis: "override" }))?.origin,
		).toBe("override")
		// Targets win when both are sent.
		const both = decoderBand(
			subject({ rangesHz: ranges, targetsHz: [433_920_000] }),
		)
		expect(both && bandLabel(both.band, "–")).toBe("433.920")
	})
	it("places a draft centre by core's ranges and usable half-width", () => {
		const win = (centreHz: number) => ({
			sourceId: "pi-iq",
			centreHz,
			sampleRate: 2_048_000,
			loHz: centreHz - 1_024_000,
			hiHz: centreHz + 1_024_000,
		})
		const from = win(445_970_700)
		const d = {
			id: "rtl433",
			...subject({
				rangesHz: ranges,
				windowHalfWidthHz: 819_200,
				captureCenterHz: 445_970_700,
			}),
		}
		expect(retuneImpact([d], from, win(434_000_000)).enters).toEqual(["rtl433"])
		expect(retuneImpact([d], from, win(600_000_000)).unknown).toEqual([])
	})
})

describe("R100 view-model copy (band-defaults scenario)", () => {
	afterEach(() => setGlyphMode("utf8"))
	const s = scenarioState("band-defaults")
	const fact = (st: AppState, id: string): DecoderFacts => {
		const f = decoderFacts(st).find(x => x.row.id === id)
		if (!f) throw new Error(`no ${id}`)
		return f
	}
	const rowOf = (st: AppState, id: string, label: string): string =>
		decoderDetail(st, fact(st, id), 119, st.now)
			.map(lineText)
			.find(l => l.startsWith(label)) ?? ""
	const withRow = (id: string, patch: Partial<DecoderRow>): AppState => ({
		...s,
		decoders: {
			...s.decoders,
			value: (s.decoders.value ?? []).map(d =>
				d.id === id ? { ...d, ...patch } : d,
			),
		},
	})
	it("names every basis and region source", () => {
		expect(rowOf(s, "dsd-fme", "band")).toContain(
			"446.000–446.200 MHz (region default) · region EU · guessed from TZ",
		)
		expect(rowOf(s, "acarsdec", "band")).toContain(
			"131.500–131.900 MHz (override · api)",
		)
		expect(rowOf(s, "dumpvdl2", "band")).toContain(
			"136.975 MHz (override · config)",
		)
		expect(rowOf(s, "lora-meshtastic", "band")).toContain(
			"region EU · from decoder",
		)
		// A newer region source is quoted.
		expect(rowOf(s, "direwolf", "band")).toContain(
			'region EU · "guessed:moon-phase"',
		)
		const words: Array<[string, string]> = [
			["configured", "configured"],
			["guessed:intl-timezone", "guessed from time zone"],
			["guessed:locale-env", "guessed from locale"],
			["guessed:intl-locale", "guessed from locale"],
			["default", "default"],
		]
		const dsd = fact(s, "dsd-fme").row.bandAssessment
		for (const [source, text] of words) {
			const st = withRow("dsd-fme", {
				bandAssessment: { ...dsd!, region: { code: "US", source } },
			})
			expect(rowOf(st, "dsd-fme", "band")).toContain(`region US · ${text}`)
		}
		const over = fact(s, "acarsdec").row.bandAssessment!
		expect(
			rowOf(
				withRow("acarsdec", {
					bandAssessment: { ...over, overrideSource: "plugin" },
				}),
				"acarsdec",
				"band",
			),
		).toContain('(override · "plugin")')
		const { overrideSource: _o, ...noSource } = over
		expect(
			rowOf(
				withRow("acarsdec", { bandAssessment: noSource }),
				"acarsdec",
				"band",
			),
		).toContain("(override · ?)")
	})
	it("lists every range in the detail, in ASCII too", () => {
		expect(rowOf(s, "rtl433", "band")).toContain(
			"433.050–434.790, 868.000–870.000 MHz (region default)",
		)
		setGlyphMode("ascii")
		expect(rowOf(s, "rtl433", "band")).toContain(
			"433.050-434.790, 868.000-870.000 MHz (region default)",
		)
	})
	it("marks a pinned decoder in the row and the detail, never by colour alone", () => {
		const cells = (id: string) =>
			decoderCells(fact(s, id), s.now)["process"]?.variants.map(lineText)
		expect(cells("dsd-fme")).toEqual(["pinned", "up 52s · pinned"])
		expect(cells("rtl433")).toEqual([
			"pinned",
			"out of band · pinned",
			"up 51s · out of band · pinned",
		])
		expect(rowOf(s, "dsd-fme", "process")).toMatch(
			/^process {3}up 52s · pinned · /,
		)
		expect(rowOf(s, "rtl433", "process")).toMatch(
			/^process {3}up 51s · running out of band · pinned · /,
		)
		// A start mode this CLI does not know is quoted, never read as pinned.
		expect(rowOf(s, "direwolf", "process")).toContain('start mode "scheduled"')
		expect(cells("direwolf")?.join()).not.toContain("pinned")
	})
	it("says what a start, run anyway and return to auto do", () => {
		expect(corePins(s)).toBe(true)
		expect(decoderConfirm(s, "dumpvdl2", "start")?.prompt).toMatch(
			/^start dumpvdl2 · pinned against band suspension · /,
		)
		expect(decoderConfirm(s, "readsb", "start")).toMatchObject({
			prompt: "run readsb out of band · pinned · out of window",
			yes: "run",
		})
		expect(decoderConfirm(s, "rtl433", "unpin")).toMatchObject({
			yes: "return",
			intent: { kind: "decoder", op: "unpin", decoderId: "rtl433" },
		})
		expect(decoderConfirm(s, "rtl433", "unpin")?.prompt).toMatch(
			/^return rtl433 to auto · may suspend out of band · /,
		)
		expect(decoderConfirm(s, "dsd-fme", "unpin")?.prompt).toMatch(
			/^return dsd-fme to auto · up 52s · /,
		)
		// An older core (no startMode anywhere) claims nothing.
		const older = scenarioState("live")
		expect(corePins(older)).toBe(false)
		const stopped = {
			...older,
			decoders: {
				...older.decoders,
				value: (older.decoders.value ?? []).map(d =>
					d.id === "readsb" ? { ...d, running: false } : d,
				),
			},
		}
		expect(decoderConfirm(stopped, "readsb", "start")?.prompt).not.toContain(
			"pinned",
		)
	})
	it("fix 1: an older core's band suspension claims no pin and no run anyway", () => {
		const older = scenarioState("contracts")
		const dsd = fact(older, "dsd-fme")
		expect(dsd.row.startMode).toBeUndefined()
		expect(suspensionKind(dsd)).toBe("other")
		const c = decoderConfirm(older, "dsd-fme", "start")
		expect(c?.prompt).toMatch(/^start dsd-fme · /)
		expect(c?.prompt).not.toContain("pinned")
		expect(c?.prompt).not.toMatch(/^run /)
		expect(c?.yes).toBe("start")
		// The same suspension on a current core runs anyway.
		expect(suspensionKind(fact(s, "readsb"))).toBe("band")
	})
	it("fix 2: a suspension with a newer code claims no pin", () => {
		const odd = withRow("readsb", {
			suspension: { reasonCode: "solar-flare", since: "x" },
		})
		expect(corePins(odd)).toBe(true)
		expect(decoderConfirm(odd, "readsb", "start")?.prompt).not.toContain(
			"pinned",
		)
	})
	it("fix 3: a configured multi-range band keeps its * in every form", () => {
		const st = withRow("rtl433", {
			bandAssessment: {
				...fact(s, "rtl433").row.bandAssessment!,
				basis: "configured",
			},
		})
		const variants =
			decoderCells(fact(st, "rtl433"), st.now)["nominal"]?.variants.map(
				lineText,
			) ?? []
		expect(variants.length).toBeGreaterThan(1)
		for (const v of variants) expect(v.endsWith("*")).toBe(true)
	})
	it("sorts suspensions for the keymap", () => {
		expect(suspensionKind(fact(s, "readsb"))).toBe("band")
		expect(suspensionKind(fact(s, "ais-catcher"))).toBe("rate")
		expect(suspensionKind(fact(s, "dsd-fme"))).toBeNull()
		expect(suspensionKind(null)).toBeNull()
		const odd = withRow("readsb", {
			suspension: { reasonCode: "solar-flare", since: "x" },
		})
		expect(suspensionKind(fact(odd, "readsb"))).toBe("other")
	})
	it("reports a return to auto in its own words, confirmed by startMode auto", () => {
		const t0 = s.now
		const intent = {
			kind: "decoder",
			op: "unpin",
			decoderId: "rtl433",
		} as const
		let st = reduce(
			s,
			[{ kind: "action:sent", at: t0, id: 1, key: "decoder:rtl433", intent }],
			t0,
		)
		expect(decoderActionText(st, "rtl433", t0)).toMatch(/^return to auto sent /)
		st = reduce(
			st,
			[
				{
					kind: "action:result",
					id: 1,
					at: t0 + 50,
					key: "decoder:rtl433",
					outcomes: [
						{
							label: "unpin",
							result: { ok: true, outcome: "ok", status: 200, message: "ok" },
							at: t0 + 50,
						},
					],
				},
			],
			t0 + 50,
		)
		const row = fact(st, "rtl433").row
		// A running status with the old mode says nothing.
		st = reduce(
			st,
			[
				{
					kind: "ws",
					at: t0 + 100,
					event: { type: "decoder:status", decoder: row },
				},
			],
			t0 + 100,
		)
		expect(decoderActionText(st, "rtl433", t0 + 100)).toMatch(
			/^return to auto accepted /,
		)
		st = reduce(
			st,
			[
				{
					kind: "ws",
					at: t0 + 200,
					event: {
						type: "decoder:status",
						decoder: {
							...row,
							startMode: "auto",
							running: false,
							suspended: true,
						},
					},
				},
			],
			t0 + 200,
		)
		expect(decoderActionText(st, "rtl433", t0 + 200)).toMatch(
			/^returned to auto /,
		)
		const failed = reduce(
			reduce(
				s,
				[{ kind: "action:sent", at: t0, id: 2, key: "decoder:rtl433", intent }],
				t0,
			),
			[
				{
					kind: "action:result",
					id: 2,
					at: t0 + 10,
					key: "decoder:rtl433",
					outcomes: [
						{
							label: "unpin",
							result: {
								ok: false,
								outcome: "failed",
								status: 400,
								message: "Body must be { pin?: boolean }",
							},
							at: t0 + 10,
						},
					],
				},
			],
			t0 + 10,
		)
		expect(decoderActionText(failed, "rtl433", t0 + 20)).toBe(
			'return to auto failed · 400 · "Body must be { pin?: boolean }"',
		)
	})
})

describe("R100 keys", () => {
	const ctx = (v: Partial<KeyContext["v"]>): KeyContext => ({
		view: "decoders" as ViewId,
		confirm: null,
		help: false,
		input: false,
		edit: false,
		detail: false,
		heightClass: "roomy",
		rows: 9,
		v: { ...EMPTY_VIEW_CTX, hasSelection: true, ...v },
	})
	it("offers run anyway on a band suspension and no start on a rate suspension", () => {
		const bandCtx = ctx({ decoderRunning: false, decoderSuspension: "band" })
		expect(lineText(footerLine(bandCtx, 119))).toContain("s run anyway")
		expect(resolveKey(bandCtx, "s")).toEqual({
			type: "decoder-op",
			op: "start",
		})
		const rate = ctx({ decoderRunning: false, decoderSuspension: "rate" })
		expect(resolveKey(rate, "s")).toBeUndefined()
		expect(lineText(footerLine(rate, 119))).not.toMatch(/\bs (start|run)/)
		expect(lineText(footerLine(ctx({ decoderRunning: false }), 119))).toContain(
			"s start",
		)
	})
	it("offers u return to auto only on a pinned decoder", () => {
		const pinned = ctx({ decoderRunning: true, decoderPinned: true })
		expect(resolveKey(pinned, "u")).toEqual({
			type: "decoder-op",
			op: "unpin",
		})
		expect(lineText(footerLine(pinned, 119))).toContain("u return to auto")
		expect(resolveKey(ctx({ decoderRunning: true }), "u")).toBeUndefined()
	})
})

describe("R100 api-client", () => {
	it("sends { pin: false } for a return to auto and keeps a start bodiless", async () => {
		const fetchFn = vi.fn<FetchLike>(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve({ message: "ok" }),
			}),
		)
		const api = createApiClient({
			base: () => "http://127.0.0.1:9000",
			fetchFn,
			now: () => 1000,
		})
		await api.decoder("rtl433", "unpin")
		await api.decoder("rtl433", "start")
		const [unpinUrl, unpinInit] = fetchFn.mock.calls[0] ?? []
		expect(unpinUrl).toBe("http://127.0.0.1:9000/api/decoders/rtl433/start")
		expect(unpinInit).toMatchObject({ method: "POST", body: '{"pin":false}' })
		const [startUrl, startInit] = fetchFn.mock.calls[1] ?? []
		expect(startUrl).toBe("http://127.0.0.1:9000/api/decoders/rtl433/start")
		expect(startInit && "body" in startInit).toBe(false)
	})
})
