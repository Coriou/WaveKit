// The Map's selection card for aircraft: which live fields it shows and how (items.ts), how its parts draw
// them (SelectionParts.tsx), and that the card scrolls as one unit with nothing clipped (map.css).
// Every aircraft here is fictional.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createElement, Fragment } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"

import type { Aircraft } from "../../src/data/fleets.ts"
import { displayStore } from "../../src/features/display.ts"
import {
	aircraftDetails,
	aircraftEmergency,
	aircraftType,
	itemsOf,
	sameOperator,
	selectionInfo,
	type Field,
	type MapItem,
} from "../../src/features/map/items.ts"
import {
	AircraftIdentity,
	EmergencyAlert,
	PlannedRoute,
	SelectionFields,
} from "../../src/features/map/SelectionParts.tsx"

const NOW = 1_800_000_000_000
const STATION = { lat: 48.7, lon: -4.0 }

const ENRICHED: Aircraft = {
	icao: "3AFFE7",
	callsign: "WKA77",
	squawk: "4321",
	position: { lat: 48.95, lon: -4.3 },
	velocity: { gs: 452, track: 128.4 },
	altitude: { baro: 36000, baroRate: 1216 },
	identification: {
		registration: "F-ZWKA",
		typeCode: "A21N",
		typeDescription: "A321 251NXSL",
		manufacturer: "Airbus",
		operator: "WaveKit Air Lines",
		country: "France",
		year: 2021,
		airline: { name: "WaveKit Air", icao: "WKA" },
		route: {
			callsign: "WKA77",
			origin: {
				icao: "LFRB",
				iata: "BES",
				name: "Brest Bretagne",
				city: "Brest",
				lat: 48.45,
				lon: -4.42,
			},
			destination: {
				icao: "LFPO",
				iata: "ORY",
				name: "Paris-Orly",
				city: "Paris",
				lat: 48.72,
				lon: 2.38,
			},
			plausible: true,
		},
		photo: {
			thumbnailUrl: "https://example.invalid/t.jpg",
			photographer: "A. Spotter",
			link: "https://example.invalid/photo",
			source: "planespotters",
		},
	},
	signalQuality: { rssi: -12.44 },
	emergency: "none",
	seen: 0,
	messages: 1834,
	firstSeen: NOW - 600_000,
	lastUpdated: NOW - 1500,
}

const BARE: Aircraft = {
	icao: "39FA0B",
	position: { lat: 48.62, lon: -3.62 },
	seen: 0,
	messages: 1,
	firstSeen: NOW - 60_000,
	lastUpdated: NOW - 1500,
}

const empty = { status: "live" as const, error: null, revision: 1 }

function itemOf(a: Aircraft): MapItem {
	const items = itemsOf({
		aircraft: {
			...empty,
			entries: new Map([
				[
					a.icao,
					{
						value: a,
						heardAt: NOW - 1500,
						posAt: NOW - 1500,
						trail: [],
						trailFromCore: false,
					},
				],
			]),
		},
		vessels: { ...empty, entries: new Map() },
		aprs: { ...empty, entries: new Map() },
		mesh: { ...empty, entries: new Map() },
	})
	const it = items[0]
	if (!it) throw new Error("no item")
	return it
}

const field = (fields: readonly Field[], k: string) =>
	fields.find(f => f[0] === k)

afterEach(() => {
	displayStore.setLocal({ units: "metric" })
})

describe("aircraft selection fields", () => {
	it("keeps every live field for an enriched aircraft, in the panel's order", () => {
		displayStore.setLocal({ units: "nautical" })
		const info = selectionInfo(itemOf(ENRICHED), STATION, NOW)
		expect(info.fields.map(f => f[0])).toEqual([
			"Altitude",
			"Speed",
			"Vertical",
			"Track",
			"Squawk",
			"Signal",
			"From station",
			"Last heard",
		])
		expect(field(info.fields, "Altitude")).toEqual([
			"Altitude",
			"36 000 ft",
			{ unit: "ft" },
		])
		expect(field(info.fields, "Speed")).toEqual([
			"Speed",
			"452 kn",
			{ unit: "kn" },
		])
		expect(field(info.fields, "Vertical")).toEqual([
			"Vertical",
			"1 216 ft/min",
			{ unit: "ft/min", trend: "up" },
		])
		expect(field(info.fields, "Track")?.[1]).toBe("128°")
		expect(field(info.fields, "Squawk")).toEqual(["Squawk", "4321"])
		expect(field(info.fields, "Signal")?.[1]).toBe("-12.4 dBFS")
		expect(field(info.fields, "From station")?.[1]).toMatch(/^\d+ nm [NESW]+$/)
		expect(field(info.fields, "Last heard")?.[1]).toBe("2 s ago")
		expect(info.seen).toMatch(/^ADS-B · readsb · 1 834 messages · /)
		expect(info.alert).toBeNull()
	})

	it("follows Settings › Display › Units", () => {
		displayStore.setLocal({ units: "metric" })
		const info = selectionInfo(itemOf(ENRICHED), STATION, NOW)
		expect(field(info.fields, "Altitude")?.[1]).toBe("10 970 m")
		expect(field(info.fields, "Speed")?.[1]).toBe("837 km/h")
		expect(field(info.fields, "Vertical")).toEqual([
			"Vertical",
			"6.2 m/s",
			{ unit: "m/s", trend: "up" },
		])
		displayStore.setLocal({ units: "imperial" })
		const imp = selectionInfo(itemOf(ENRICHED), STATION, NOW)
		expect(field(imp.fields, "Speed")?.[1]).toBe("520 mph")
		expect(field(imp.fields, "From station")?.[1]).toMatch(/ mi [NESW]+$/)
	})

	it("shows a bare Mode S aircraft with dashes, never dropping a field", () => {
		const info = selectionInfo(itemOf(BARE), STATION, NOW)
		expect(info.title).toBe("39FA0B")
		expect(info.sub).toBe("ICAO 39FA0B")
		expect(info.fields).toHaveLength(8)
		for (const k of [
			"Altitude",
			"Speed",
			"Vertical",
			"Track",
			"Squawk",
			"Signal",
		])
			expect(field(info.fields, k)?.[1]).toBe("—")
		expect(info.seen).toMatch(/· 1 message · /)
		expect(info.aircraft?.ident).toEqual([])
		expect(info.aircraft?.photo).toBeNull()
		expect(info.aircraft?.route).toBeNull()
	})

	it("says on ground, without a climb rate", () => {
		const a: Aircraft = {
			...ENRICHED,
			velocity: { gs: 14, track: 270 },
			altitude: { baro: 250, onGround: true, baroRate: -400 },
		}
		const info = selectionInfo(itemOf(a), STATION, NOW)
		expect(field(info.fields, "Altitude")).toEqual(["Altitude", "On ground"])
		expect(field(info.fields, "Vertical")).toEqual(["Vertical", "—"])
		expect(field(info.fields, "Speed")?.[1]).toBe("26 km/h")
	})

	it("calls small rates level and descents down", () => {
		const level = { ...ENRICHED, altitude: { baro: 9000, baroRate: -64 } }
		expect(
			field(selectionInfo(itemOf(level), STATION, NOW).fields, "Vertical"),
		).toEqual(["Vertical", "Level"])
		const down = { ...ENRICHED, altitude: { baro: 9000, geomRate: -1800 } }
		expect(
			field(selectionInfo(itemOf(down), STATION, NOW).fields, "Vertical")?.[2],
		).toMatchObject({ trend: "down" })
	})

	it("flags emergency squawks and emergency states", () => {
		const sq = (squawk: string, emergency = "none") =>
			selectionInfo(itemOf({ ...ENRICHED, squawk, emergency }), STATION, NOW)
		expect(sq("7700").alert).toBe("Squawk 7700 · General emergency")
		expect(field(sq("7700").fields, "Squawk")).toEqual([
			"Squawk",
			"7700",
			{ alert: "General emergency" },
		])
		expect(sq("7600").alert).toBe("Squawk 7600 · Radio failure")
		expect(sq("7500").alert).toBe("Squawk 7500 · Unlawful interference")
		// the state names it better than the code when both are sent
		expect(sq("7700", "lifeguard").alert).toBe(
			"Squawk 7700 · Medical emergency",
		)
		expect(sq("2000", "minfuel").alert).toBe("Minimum fuel")
		expect(field(sq("2000", "minfuel").fields, "Squawk")).toEqual([
			"Squawk",
			"2000",
		])
		expect(aircraftEmergency({ ...BARE, emergency: "odd" })).toBe("Emergency")
		expect(aircraftEmergency(BARE)).toBeNull()
	})

	it("treats inherited property names as unknown emergency states and squawks", () => {
		for (const odd of ["__proto__", "constructor", "toString"]) {
			expect(
				aircraftEmergency({ ...ENRICHED, squawk: "4321", emergency: odd }),
			).toBe("Emergency")
			expect(
				aircraftEmergency({ ...ENRICHED, squawk: "7700", emergency: odd }),
			).toBe("Squawk 7700 · Emergency")
			expect(aircraftEmergency({ ...ENRICHED, squawk: odd })).toBeNull()
			const info = selectionInfo(
				itemOf({ ...ENRICHED, squawk: odd, emergency: odd }),
				STATION,
				NOW,
			)
			expect(info.alert).toBe("Emergency")
			expect(field(info.fields, "Squawk")).toEqual(["Squawk", odd])
		}
	})
})

describe("aircraft identity", () => {
	it("names who flies it once and the type once, with its ICAO code", () => {
		const d = aircraftDetails(ENRICHED)
		expect(d.about).toBe("WaveKit Air")
		expect(d.ident).toEqual([
			["Registration", "F-ZWKA"],
			["Type", "Airbus A321 251NXSL", "A21N"],
			["Country", "France"],
			["ICAO address", "3AFFE7"],
			["Built", "2021"],
		])
	})

	it("calls names one company only when they match after case, punctuation and generic words", () => {
		expect(sameOperator("WaveKit Air", "wavekit-air")).toBe(true)
		expect(sameOperator("WaveKit  Air", "WAVEKIT AIR")).toBe(true)
		expect(sameOperator("WaveKit", "WaveKit Airlines")).toBe(true)
		expect(sameOperator("WaveKit Airlines", "WaveKit")).toBe(true)
		expect(sameOperator("WaveKit Airways Ltd", "WaveKit")).toBe(true)
		expect(sameOperator("Air Northwind", "Northwind S.A.")).toBe(true)
		expect(sameOperator("Northwind S.A.", "Air Northwind")).toBe(true)
		expect(sameOperator("Northwind Aviation GmbH", "Northwind Air")).toBe(true)
		const brand = {
			...ENRICHED,
			identification: {
				...ENRICHED.identification,
				operator: "WaveKit Airlines Ltd",
			},
		}
		expect(aircraftDetails(brand).ident.map(r => r[0])).not.toContain(
			"Operator",
		)
	})

	it("shows the registry's operator only when it is another company", () => {
		expect(sameOperator("TAP Portugal", "TAP Air Portugal")).toBe(true)
		expect(sameOperator("WaveKit Air", "WaveKit Air Lines")).toBe(true)
		expect(sameOperator("WaveKit Air", "Northwind Leasing")).toBe(false)
		expect(sameOperator("Northwind Air", "Northwind Air Charter")).toBe(false)
		expect(sameOperator("Northwind Air Charter", "Northwind Air")).toBe(false)
		expect(sameOperator("Northwind", "Northwind Cargo")).toBe(false)
		expect(sameOperator("Air", "Airlines Ltd")).toBe(false)
		expect(sameOperator("", "")).toBe(false)
		const leasedSame = {
			...ENRICHED,
			identification: {
				...ENRICHED.identification,
				airline: { name: "Northwind Air", icao: "NWA" },
				operator: "Northwind Air Charter",
			},
		}
		expect(aircraftDetails(leasedSame).ident).toContainEqual([
			"Operator",
			"Northwind Air Charter",
		])
		const leased = {
			...ENRICHED,
			identification: {
				...ENRICHED.identification,
				operator: "Northwind Leasing",
			},
		}
		expect(aircraftDetails(leased).ident).toContainEqual([
			"Operator",
			"Northwind Leasing",
		])
	})

	it("falls back to the type, then the address, for the subtitle", () => {
		const noOperator = {
			...ENRICHED,
			identification: {
				typeCode: "RFAL",
				typeDescription: "Dassault Rafale M",
				registration: "M-01",
			},
		}
		const d = aircraftDetails(noOperator)
		// the subtitle keeps the ICAO type code the dropped Type row would have shown
		expect(d.about).toBe("Dassault Rafale M · RFAL")
		expect(d.ident.map(r => r[0])).not.toContain("Type")
		expect(
			aircraftDetails({
				...noOperator,
				identification: { typeCode: "RFAL" },
			}).about,
		).toBe("RFAL")
		expect(
			aircraftDetails({
				...noOperator,
				identification: { typeCode: "A320", typeDescription: "A320 214" },
			}).about,
		).toBe("A320 214")
		expect(aircraftType(noOperator.identification)).toEqual({
			model: "Dassault Rafale M",
			code: "RFAL",
		})
		expect(
			aircraftType({ typeCode: "A320", typeDescription: "A320 214" }),
		).toEqual({ model: "A320 214", code: null })
		expect(aircraftType({ typeCode: "B738" })).toEqual({
			model: "B738",
			code: null,
		})
		expect(aircraftType({ manufacturer: "Airbus" })).toBeNull()
		expect(aircraftDetails(BARE).about).toBe("ICAO 39FA0B")
	})
})

describe("selection card render", () => {
	it("draws the live fields as a labelled list, units small, arrows spoken", () => {
		displayStore.setLocal({ units: "metric" })
		const info = selectionInfo(
			itemOf({ ...ENRICHED, squawk: "7700", emergency: "general" }),
			STATION,
			NOW,
		)
		const html = renderToStaticMarkup(
			createElement(
				Fragment,
				null,
				info.alert ? createElement(EmergencyAlert, { text: info.alert }) : null,
				info.aircraft?.route
					? createElement(PlannedRoute, info.aircraft.route)
					: null,
				createElement(SelectionFields, {
					fields: info.fields,
					label: "Flight data",
				}),
				createElement(AircraftIdentity, { rows: info.aircraft?.ident ?? [] }),
			),
		)
		expect(html).toContain(
			'<p class="wkm-alert" role="alert"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">',
		)
		expect(html).toContain("Squawk 7700 · General emergency")
		expect(html).toContain('<dl class="wkm-fields" aria-label="Flight data">')
		expect(html).toContain(
			'<div><dt>Altitude</dt><dd>10 970<span class="wkm-unit"> m</span></dd></div>',
		)
		expect(html).toContain(
			'<dd><span class="wkm-trend" aria-hidden="true">↑</span><span class="wk-sr">Climbing </span>6.2<span class="wkm-unit"> m/s</span></dd>',
		)
		expect(html).toContain(
			'<div data-tone="danger"><dt>Squawk</dt><dd>7700<span class="wk-sr">, General emergency</span></dd></div>',
		)
		// every field is drawn
		expect(html.match(/<dt>/g)?.length).toBe(
			info.fields.length + (info.aircraft?.ident.length ?? 0),
		)
		expect(html).toContain('aria-label="Planned route from Brest to Paris"')
		expect(html).toContain(
			'<dd>Airbus A321 251NXSL <abbr class="wkm-code" title="ICAO type code">A21N</abbr></dd>',
		)
	})

	it("renders an aircraft whose emergency or squawk is an inherited property name", () => {
		for (const odd of ["__proto__", "constructor", "toString"]) {
			for (const a of [
				{ ...ENRICHED, squawk: "4321", emergency: odd },
				{ ...ENRICHED, squawk: odd, emergency: "none" },
				{ ...ENRICHED, squawk: odd, emergency: odd },
			]) {
				const info = selectionInfo(itemOf(a), STATION, NOW)
				const html = renderToStaticMarkup(
					createElement(
						Fragment,
						null,
						info.alert
							? createElement(EmergencyAlert, { text: info.alert })
							: null,
						createElement(SelectionFields, {
							fields: info.fields,
							label: "Flight data",
						}),
					),
				)
				expect(html).toContain(`<dt>Squawk</dt><dd>${a.squawk}</dd>`)
				expect(html).not.toContain('data-tone="danger"')
				if (a.emergency === "none") expect(html).not.toContain("wkm-alert")
				else expect(html).toContain("<span>Emergency</span>")
			}
		}
	})

	it("marks missing values and draws no identity section for a bare aircraft", () => {
		const info = selectionInfo(itemOf(BARE), STATION, NOW)
		const html = renderToStaticMarkup(
			createElement(
				Fragment,
				null,
				createElement(SelectionFields, {
					fields: info.fields,
					label: "Flight data",
				}),
				createElement(AircraftIdentity, { rows: info.aircraft?.ident ?? [] }),
			),
		)
		expect(html).toContain('<div data-empty=""><dt>Speed</dt><dd>—</dd></div>')
		expect(html).not.toContain("wkm-ident")
	})
})

// ---- the card's CSS: one scroller, nothing clipped, nothing shrinks

const css = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"../../src/features/map/map.css",
	),
	"utf8",
).replace(/\/\*[\s\S]*?\*\//g, "")

/** Every innermost rule: selector → declarations (property → value). */
function rules(): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>()
	for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		for (const sel of (m[1] ?? "").split(",")) {
			const key = sel.trim().replace(/\s+/g, " ")
			const decls = out.get(key) ?? new Map<string, string>()
			for (const d of (m[2] ?? "").split(";")) {
				const i = d.indexOf(":")
				if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim())
			}
			out.set(key, decls)
		}
	}
	return out
}

/** The card's sections and their boxes (the dt/dd text cells may ellipsise one line, never a box). */
const SECTIONS = [
	".wkm-sel-head",
	".wkm-note",
	".wkm-alert",
	".wkm-route",
	".wkm-route-ends",
	".wkm-fields",
	".wkm-fields > div",
	".wkm-ident",
	".wkm-ident dl",
	".wkm-ident dl > div",
	".wkm-story",
	".wkm-story ol",
	".wkm-seen",
	".wkm-msg",
	".wkm-actions",
]

describe("selection card CSS", () => {
	const all = rules()

	it("scrolls the card as one unit and never shrinks its sections", () => {
		expect(all.get(".wkm-sel")?.get("overflow-y")).toBe("auto")
		expect(all.get(".wkm-sel > *")?.get("flex")).toBe("none")
	})

	it("caps no section's height and lets none clip or scroll on its own", () => {
		for (const sel of SECTIONS) {
			const d = all.get(sel)
			if (!d) continue
			for (const [prop, value] of d) {
				expect(
					/^(max-)?height$/.test(prop),
					`${sel} sets ${prop}: ${value}`,
				).toBe(false)
				expect(/^overflow(-[xy])?$/.test(prop), `${sel} sets ${prop}`).toBe(
					false,
				)
				if (prop === "flex" || prop === "flex-shrink")
					expect(value, `${sel} ${prop}`).toMatch(/^(none|0)$/)
			}
		}
		expect(all.has(".wkm-fields")).toBe(true)
	})

	it("has no scroller inside the card but the card itself", () => {
		for (const [sel, d] of all) {
			if (
				!/\.wkm-(fields|ident|route|story|msg|alert|seen|actions|sel-head|photo|note)\b/.test(
					sel,
				)
			)
				continue
			for (const prop of ["overflow", "overflow-y", "overflow-x"])
				expect(
					/auto|scroll/.test(d.get(prop) ?? ""),
					`${sel} scrolls on its own`,
				).toBe(false)
		}
	})
})
