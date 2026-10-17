import { describe, expect, it } from "vitest"
import type {
	ActivityRecord,
	ActivitySummary,
	DecodeField,
	JsonValue,
} from "@wavekit/api-types"

import {
	mapIdOf,
	messageView,
	positionPlot,
	positionText,
	protocolLabel,
} from "../../src/features/messages/card.ts"
import {
	humanize,
	labelOf,
	mergeFields,
} from "../../src/features/messages/humanize.ts"
import {
	jsonLines,
	jsonMeta,
	MAX_LINES,
	tokenize,
} from "../../src/features/messages/json.ts"

const summary = (over: Partial<ActivitySummary> = {}): ActivitySummary => ({
	eventId: "e1",
	commitSeq: "1",
	kind: "decoder-reception",
	producedAt: "2026-10-17T12:02:39.000Z",
	receivedAt: "2026-10-17T12:02:39.000Z",
	decoderId: "d",
	sourceId: "rtl-0",
	protocol: "pocsag",
	category: "paging",
	frequencyHz: 160_450_000,
	entityKey: null,
	title: "Capcode 1234567",
	fields: [],
	...over,
})

const reception = (
	item: ActivitySummary,
	decodedData: JsonValue,
	fields: readonly DecodeField[] = item.fields,
): ActivityRecord => ({
	version: 1,
	eventId: item.eventId,
	commitSeq: item.commitSeq,
	producedAt: item.producedAt,
	receivedAt: item.receivedAt,
	kind: "decoder-reception",
	payload: {
		version: 1,
		eventId: item.eventId,
		producedAt: item.producedAt,
		receivedAt: item.receivedAt,
		decoderId: item.decoderId ?? "d",
		outputType: "message",
		protocol: item.protocol,
		category: item.category,
		entityKey: item.entityKey,
		title: item.title,
		fields,
		provenance: { sourceId: item.sourceId, frequency: null },
		decodedData,
	},
})

describe("humanize", () => {
	it("reads units from rtl_433 key suffixes and flags as words", () => {
		const out = humanize({
			time: "2026-10-17 14:01:40",
			model: "Toyota",
			id: "a1b2c3d4",
			pressure_kPa: 232.456,
			temperature_C: 21,
			battery_ok: 0,
			wind_avg_km_h: 18,
			humidity: 61,
			mic: "CRC",
		})
		expect(out).toEqual([
			{ key: "pressure_kPa", label: "Pressure", value: 232.46, unit: "kPa" },
			{ key: "temperature_C", label: "Temperature", value: 21, unit: "°C" },
			{ key: "battery_ok", label: "Battery", value: "Low" },
			{ key: "wind_avg_km_h", label: "Wind", value: 18, unit: "km/h" },
			{ key: "humidity", label: "Humidity", value: 61, unit: "%" },
		])
	})

	it("flattens one level, joins short scalar lists and skips positions", () => {
		const out = humanize({
			via: ["WIDE1-1", "WIDE2-1"],
			lat: 48.1,
			lon: -4.2,
			weather: { pressure_hPa: 1012.4, deep: { x: 1 } },
			cmd: 5,
			tristate: "ZZX0FX10ZZ",
		})
		expect(out.map(f => [f.key, f.label, f.value])).toEqual([
			["via", "Via", "WIDE1-1, WIDE2-1"],
			["weather.pressure_hPa", "Pressure", 1012.4],
			["cmd", "Cmd", 5],
			["tristate", "Tristate", "ZZX0FX10ZZ"],
		])
	})

	it("reads camelCase units and angles by name", () => {
		const out = humanize({
			speedKmh: 52,
			course: 112,
			temperatureC: 14.2,
			altitudeFt: 1200,
			cmdC: 3,
		})
		expect(out.map(f => [f.label, f.value, f.unit])).toEqual([
			["Speed", 52, "km/h"],
			["Course", 112, "°"],
			["Temperature", 14.2, "°C"],
			["Altitude", 1200, "ft"],
			["Cmd c", 3, undefined],
		])
	})

	it("returns nothing for scalars and arrays", () => {
		expect(humanize("text")).toEqual([])
		expect(humanize([1, 2])).toEqual([])
		expect(humanize(undefined)).toEqual([])
	})

	it("labels keys in any case and keeps acronyms upper case", () => {
		expect(labelOf("rxSnr")).toBe("SNR")
		expect(labelOf("signal_rssi")).toBe("Signal RSSI")
		expect(labelOf("hopStart")).toBe("Hop start")
		expect(labelOf("co2")).toBe("CO₂")
	})

	it("merges: the core's fields first, JSON extras without repeats", () => {
		const core: DecodeField[] = [
			{ key: "temperature_C", label: "Temperature", value: 21, unit: "°C" },
		]
		const data = { temperature_C: 21, pressure_kPa: 232.5, status: 128 }
		expect(mergeFields(core, data, true).map(f => f.label)).toEqual([
			"Temperature",
			"Pressure",
			"Status",
		])
		expect(mergeFields(core, data, false)).toEqual(core)
	})
})

describe("message card view", () => {
	it("names wire protocols and applications", () => {
		expect(
			protocolLabel(summary(), { protocol: "POCSAG1200", address: 1 }),
		).toBe("POCSAG 1200")
		expect(
			protocolLabel(summary({ protocol: "vdl2", category: "aviation-data" }), {
				app: "CPDLC",
			}),
		).toBe("VDL2 · CPDLC")
		expect(
			protocolLabel(summary({ protocol: "aprs", category: "aprs" }), {
				weather: { temperature_C: 14 },
			}),
		).toBe("APRS weather")
		expect(protocolLabel(summary({ protocol: "ism" }), undefined)).toBe(
			"rtl_433",
		)
	})

	it("shows an unknown rtl_433 model from its JSON alone", () => {
		const item = summary({
			protocol: "ism",
			category: "sensors",
			title: "Generic-Remote 4128",
			frequencyHz: 433_920_000,
		})
		const v = messageView(
			item,
			reception(item, {
				time: "x",
				model: "Generic-Remote",
				id: 4128,
				cmd: 5,
				tristate: "ZZX0FX10ZZ",
			}),
		)
		expect(v.protocol).toBe("rtl_433")
		expect(v.fields.map(f => `${f.label}=${String(f.value)}`)).toEqual([
			"Cmd=5",
			"Tristate=ZZX0FX10ZZ",
		])
		expect(v.raw).toMatchObject({ model: "Generic-Remote" })
	})

	it("reads battery_ok from the core as OK or Low", () => {
		const item = summary({
			protocol: "ism",
			category: "sensors",
			title: "Acurite-Tower 12345",
			fields: [{ key: "battery_ok", label: "Battery", value: 1 }],
		})
		expect(messageView(item).fields).toEqual([
			{ key: "battery_ok", label: "Battery", value: "OK" },
		])
	})

	it("sets machine text in mono and keeps the message out of the grid", () => {
		const numeric = summary({
			fields: [
				{ key: "address", label: "Capcode", value: "1234567" },
				{ key: "message", label: "Message", value: "0612 44 18" },
			],
		})
		const v = messageView(numeric)
		expect(v.text).toBe("0612 44 18")
		expect(v.mono).toBe(true)
		// the capcode is in the title
		expect(v.fields).toEqual([])
		const alpha = summary({
			fields: [{ key: "message", label: "Message", value: "Test page" }],
		})
		expect(messageView(alpha).mono).toBe(false)
		const acars = summary({
			protocol: "acars",
			category: "aviation-data",
			title: "F-HBXA",
			fields: [{ key: "text", label: "Text", value: "POS N48467 W003275" }],
		})
		expect(messageView(acars).mono).toBe(true)
	})

	it("marks pages with no body as tone only", () => {
		const v = messageView(
			summary({ fields: [{ key: "function", label: "Function", value: 1 }] }),
		)
		expect(v.toneOnly).toBe(true)
		expect(v.text).toBeNull()
	})

	it("turns encryption into a badge and AIS message types into a tag", () => {
		const p25 = summary({
			protocol: "p25p1",
			category: "voice",
			title: "TG 1201",
			fields: [
				{ key: "talkgroup", label: "Talkgroup", value: 1201 },
				{ key: "encrypted", label: "Encrypted", value: true },
				{ key: "algorithm", label: "Algorithm", value: "AES-256" },
			],
		})
		const v = messageView(p25)
		expect(v.protocol).toBe("P25")
		expect(v.badges).toEqual([{ label: "Encrypted", variant: "amber" }])
		expect(v.fields.map(f => f.key)).toEqual(["algorithm"])
		expect(v.large).toBe(true)

		const ship = summary({
			protocol: "ais",
			category: "marine",
			title: "Kerlouan",
			entityKey: "mmsi:227006760",
		})
		const s = messageView(
			ship,
			reception(ship, { mmsi: 227006760, msgType: 1 }),
		)
		expect(s.badges).toEqual([{ label: "Type 1", variant: "neutral" }])
		expect(s.mapId).toBe("v:227006760")
	})

	it("drops the protocol and the frequency from the subtitle", () => {
		const v = messageView(
			summary({
				protocol: "dmr",
				category: "voice",
				title: "TG 2081",
				fields: [
					{ key: "talkgroup", label: "Talkgroup", value: 2081 },
					{ key: "source", label: "Source", value: 2081045 },
					{ key: "slot", label: "Slot", value: 1 },
				],
			}),
		)
		expect(v.sub).toBe("Source 2081045")
		expect(v.fields.map(f => f.key)).toEqual(["slot"])
	})

	it("reads an analog transmission", () => {
		const v = messageView(
			summary({
				kind: "analog-transmission",
				protocol: "analog",
				category: "voice",
				title: null,
				fields: [
					{ key: "durationMs", label: "Duration", value: 9000 },
					{ key: "modulation", label: "Mode", value: "nfm" },
					{ key: "ctcssHz", label: "CTCSS", value: 88.5, unit: "Hz" },
				],
			}),
		)
		expect(v.protocol).toBe("NFM voice")
		expect(v.sub).toBe("CTCSS 88.5 Hz")
		expect(v.large).toBe(false)
	})

	it("maps entity keys to Map items", () => {
		expect(mapIdOf("icao:3944ef")).toBe("a:3944EF")
		expect(mapIdOf("callsign:F4ABC-9")).toBe("p:callsign:F4ABC-9")
		expect(mapIdOf("aprs-object:LIGHT")).toBe("p:aprs-object:LIGHT")
		expect(mapIdOf("node:!a3f2c1d4")).toBe("m:!a3f2c1d4")
		expect(mapIdOf("capcode:1234567")).toBeNull()
		expect(mapIdOf(null)).toBeNull()
		expect(mapIdOf("icao:")).toBeNull()
	})

	it("places a position on its bearing from the station", () => {
		const home = { lat: 48.72, lon: -3.98 }
		const north = positionPlot(home, { lat: 48.9, lon: -3.98 })
		expect(north.dx).toBeCloseTo(0, 1)
		expect(north.dy).toBeCloseTo(-30, 1)
		expect(north.from).toMatch(/^20 km N$/)
		const east = positionPlot(home, { lat: 48.72, lon: -3.7 })
		expect(east.dx).toBeGreaterThan(29)
		expect(positionPlot(null, home)).toEqual({ dx: 0, dy: 0, from: null })
		expect(positionPlot(home, home).from).toBe("At the station")
		expect(positionText({ lat: 48.7312, lon: -3.4627 })).toBe(
			"48.7312° N  3.4627° W",
		)
	})
})

describe("JSON viewer", () => {
	it("tokenizes keys, strings, numbers, literals and punctuation", () => {
		expect(tokenize('"temperature_C": 18.4,')).toEqual([
			{ s: '"temperature_C"', k: "key" },
			{ s: ":", k: "punc" },
			{ s: " ", k: "punc" },
			{ s: "18.4", k: "num" },
			{ s: ",", k: "punc" },
		])
		expect(tokenize('"ok": true').map(t => t.k)).toEqual([
			"key",
			"punc",
			"punc",
			"lit",
		])
		expect(tokenize('"a \\"b\\""').map(t => t.k)).toEqual(["str"])
	})

	it("numbers lines, keeps indents and caps what it draws", () => {
		const text = JSON.stringify({ a: { b: 1 } }, null, 2)
		const { lines, total } = jsonLines(text)
		expect(total).toBe(5)
		expect(lines.map(l => [l.n, l.indent])).toEqual([
			[1, 0],
			[2, 2],
			[3, 4],
			[4, 2],
			[5, 0],
		])
		const big = JSON.stringify(
			Array.from({ length: MAX_LINES + 10 }, (_, i) => i),
			null,
			2,
		)
		const capped = jsonLines(big)
		expect(capped.lines).toHaveLength(MAX_LINES)
		expect(capped.total).toBe(MAX_LINES + 12)
		expect(jsonMeta("{}", 1)).toBe("1 line · 2 B")
		expect(jsonMeta("é", 3)).toBe("3 lines · 2 B")
	})
})
