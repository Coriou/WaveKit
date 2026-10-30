import { describe, expect, it } from "vitest"
import type { BandGainSettings } from "@wavekit/api-types"
import {
	BAND_GAIN_LIMITS,
	BandGainStore,
	bandGainFromDraft,
	bandGainStore,
	draftOf,
	type BandGainDraft,
	type BandGainDraftRow,
} from "../../src/data/receiver-band-gain.ts"
import { json, scripted } from "./fake-fetch.ts"

const settings: BandGainSettings = {
	applyToMyTuning: false,
	entries: [
		{ minHz: 144_000_000, maxHz: 148_000_000, gain: "keep", label: "2 m" },
		{ minHz: 863_000_000, maxHz: 870_000_000, gain: 372, label: "868 MHz ISM" },
		{ minHz: 902_000_000, maxHz: 928_000_000, gain: 372 },
	],
}
const view = (s: BandGainSettings, provenance = "config") => ({
	settings: s,
	provenance,
	limits: BAND_GAIN_LIMITS,
})

const row = (patch: Partial<BandGainDraftRow>): BandGainDraftRow => ({
	key: "r",
	minMHz: "863",
	maxMHz: "870",
	keep: false,
	gainDb: "37.2",
	label: "",
	...patch,
})
const draft = (...rows: BandGainDraftRow[]): BandGainDraft => ({
	applyToMyTuning: true,
	rows,
})

describe("band gain data", () => {
	it("loads the table once for concurrent callers and shares one store per client", async () => {
		const { api, calls } = scripted(() => json(200, view(settings)))
		const store = bandGainStore(api)
		expect(bandGainStore(api)).toBe(store)
		await Promise.all([store.load(), store.load()])
		expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
			"GET /api/tuner-band-gain",
		])
		expect(store.get()).toMatchObject({
			loaded: true,
			unavailable: false,
			error: null,
		})
		expect(store.get().view?.settings).toEqual(settings)
	})

	it("treats a core without the route as unavailable, and a bad answer as an error", async () => {
		const missing = new BandGainStore(
			scripted(() => json(404, { code: "NOT_FOUND", message: "Route" })).api,
		)
		await missing.load()
		expect(missing.get()).toMatchObject({ unavailable: true, view: null })
		const bad = new BandGainStore(
			scripted(() => json(200, { settings: { entries: "no" } })).api,
		)
		await bad.load()
		expect(bad.get().view).toBeNull()
		expect(bad.get().error).toMatch(
			/Unexpected answer from \/api\/tuner-band-gain/,
		)
	})

	it("PUTs the whole table and keeps the core's answer", async () => {
		const next = { ...settings, applyToMyTuning: true }
		const { api, calls } = scripted(call =>
			json(200, view(call.method === "PUT" ? next : settings, "runtime")),
		)
		const store = new BandGainStore(api)
		await store.load()
		expect(await store.save(next)).toEqual({ ok: true })
		expect(calls[1]).toMatchObject({
			method: "PUT",
			url: "/api/tuner-band-gain",
			body: next,
		})
		expect(store.get().view).toMatchObject({
			settings: next,
			provenance: "runtime",
		})
		expect(store.get().saving).toBe(false)
	})

	it("answers the core's 400 message and keeps the table it had", async () => {
		const message = "Invalid band gain settings at entries.1.maxHz; expected …"
		const { api } = scripted(call =>
			call.method === "PUT"
				? json(400, {
						error: "BandGainSettingsError",
						code: "BAND_GAIN_INVALID",
						message,
					})
				: json(200, view(settings)),
		)
		const store = new BandGainStore(api)
		await store.load()
		const result = await store.save({ ...settings, entries: [] })
		expect(result).toEqual({ ok: false, message })
		expect(store.get().view?.settings).toEqual(settings)
	})
})

describe("band gain draft", () => {
	it("round-trips the core's table through the editor's text", () => {
		const d = draftOf(settings)
		expect(
			d.rows.map(r => [r.minMHz, r.maxMHz, r.keep, r.gainDb, r.label]),
		).toEqual([
			["144", "148", true, "", "2 m"],
			["863", "870", false, "37.2", "868 MHz ISM"],
			["902", "928", false, "37.2", ""],
		])
		expect(new Set(d.rows.map(r => r.key)).size).toBe(3)
		expect(bandGainFromDraft(d)).toEqual({ settings })
	})

	it("turns MHz and dB as typed into whole Hz and tenths of a dB", () => {
		expect(
			bandGainFromDraft(
				draft(
					row({
						minMHz: " 433,05 ",
						maxMHz: "434.79 MHz",
						gainDb: "29.7 dB",
						label: " LPD ",
					}),
					row({
						key: "b",
						minMHz: "1085",
						maxMHz: "1095",
						keep: true,
						gainDb: "x",
					}),
				),
			),
		).toEqual({
			settings: {
				applyToMyTuning: true,
				entries: [
					{ minHz: 433_050_000, maxHz: 434_790_000, gain: 297, label: "LPD" },
					{ minHz: 1_085_000_000, maxHz: 1_095_000_000, gain: "keep" },
				],
			},
		})
	})

	it("marks each field the core would refuse", () => {
		const result = bandGainFromDraft(
			draft(
				row({ key: "a", minMHz: "abc", maxMHz: "2000", gainDb: "50.1" }),
				row({ key: "b", minMHz: "500", maxMHz: "400", gainDb: "" }),
				row({ key: "c", label: "x".repeat(49) }),
				row({ key: "d", minMHz: "900", maxMHz: "901", label: "café" }),
			),
		)
		expect("errors" in result && result.errors).toEqual({
			rows: {
				a: {
					minMHz: "Type MHz, for example 868",
					maxMHz: "From 24 to 1900 MHz",
					gainDb: "A gain from 0 to 50 dB, or Keep",
				},
				b: {
					maxMHz: "The end must be above the start",
					gainDb: "A gain from 0 to 50 dB, or Keep",
				},
				c: { label: "At most 48 characters" },
				d: { label: "Letters, digits and plain punctuation only" },
			},
			table: null,
		})
	})

	it("treats ranges as inclusive: touching ends overlap", () => {
		const result = bandGainFromDraft(
			draft(
				row({ key: "a", label: "868 MHz ISM" }),
				row({ key: "b", minMHz: "870", maxMHz: "876" }),
				row({ key: "c", minMHz: "870.000001", maxMHz: "871" }),
			),
		)
		expect("errors" in result && result.errors.rows).toEqual({
			b: { minMHz: "Overlaps 868 MHz ISM" },
			c: { minMHz: "Overlaps 870–876 MHz" },
		})
	})

	it("refuses more bands than the core keeps", () => {
		const rows = Array.from({ length: 33 }, (_, i) =>
			row({ key: `k${i}`, minMHz: String(100 + i), maxMHz: `${100 + i}.5` }),
		)
		const result = bandGainFromDraft(draft(...rows))
		expect("errors" in result && result.errors).toEqual({
			rows: {},
			table: "At most 32 bands",
		})
	})
})
