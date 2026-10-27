import { wmbusJsonLine } from "../../../../mocks/rtl433-wmbus.js"
import { resolveProvenance } from "../../../../../src/core/activity/provenance/resolve.js"
import { buildActivityRow } from "../../../../../src/core/activity/storage/row.js"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import { describe, expect, it } from "vitest"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import {
	FIELD_TEXT_BYTES,
	LONG_TEXT_BYTES,
	MAX_TITLE_CHARS,
} from "../../../../../src/core/activity/presentation/budget.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import { decoderOutput } from "./measure.js"

const at = new Date("2026-10-13T00:00:00.000Z")

function present(type: DecoderOutput["type"], data: unknown) {
	return presentDecoderOutput(decoderOutput(type, data), "adapter")
}

describe("activity presentation registry", () => {
	it("presents an aircraft with a canonical key and no duplicated callsign", () => {
		const view = present("aircraft", {
			icao: "abc123",
			callsign: "ual123",
			squawk: "1200",
			altitude: 35000,
			groundSpeed: 400,
			track: 90,
			verticalRate: -64,
			lat: 51.5,
			lon: -0.12,
			lastSeen: at,
			messageCount: 4,
		})
		expect(view).toMatchObject({
			category: "aircraft",
			protocol: "adsb",
			entityKey: "icao:ABC123",
			title: "ual123",
			position: { lat: 51.5, lon: -0.12 },
		})
		// WG5 req 4.1: barometric feet to whole metres.
		expect(view?.position?.altM).toBe(Math.round(35_000 * 0.3048))
		expect(view?.fields?.map(field => field.key)).toEqual([
			"squawk",
			"altitude",
			"groundSpeed",
			"track",
			"verticalRate",
		])
		expect(view?.fields?.find(field => field.key === "altitude")).toMatchObject(
			{
				unit: "ft",
				value: 35000,
			},
		)
	})

	it("drops fields on a position-only aircraft and rejects a non-hex or tilde address", () => {
		const bare = present("aircraft", {
			hex: "AbC123",
			altitude: 100,
			lat: 1,
			lon: 2,
			lastSeen: at.toISOString(),
			messageCount: 1,
		})
		expect(bare).toMatchObject({
			entityKey: "icao:ABC123",
			title: "ABC123",
			category: "aircraft",
			protocol: "adsb",
		})
		expect(bare?.fields).toBeUndefined()
		expect(
			present("aircraft", { hex: "~ABC123", lat: 1, lon: 2 })?.entityKey,
		).toBeUndefined()
		expect(present("aircraft", { icao: "ZZZZZZ" })?.entityKey).toBeUndefined()
		expect(present("aircraft", { icao: "ABC12" })?.entityKey).toBeUndefined()
		expect(
			present("aircraft", { icao: "AB\u0000C123" })?.entityKey,
		).toBeUndefined()
	})

	it("never places an aircraft at exactly (0, 0) or converts altitude", () => {
		const bare = present("aircraft", {
			icao: "abcdef",
			lat: 0,
			lon: 0,
			alt_baro: 500,
		})
		expect(bare?.position).toBeUndefined()
		expect(bare?.fields).toBeUndefined()
		const view = present("aircraft", {
			icao: "abcdef",
			lat: 0,
			lon: 0,
			alt_baro: 500,
			squawk: "7000",
		})
		expect(view?.position).toBeUndefined()
		expect(view?.fields?.find(field => field.key === "altitude")?.value).toBe(
			500,
		)
		expect(view?.fields?.find(field => field.key === "altitude")?.unit).toBe(
			"ft",
		)
		expect(
			present("aircraft", {
				icao: "abcdef",
				alt_baro: "ground",
				squawk: "7000",
			})?.fields?.find(field => field.key === "altitude"),
		).toBeUndefined()
	})

	it("pads an MMSI, titles a vessel by name, and hides fields on a bare position", () => {
		const named = present("ship", {
			mmsi: "12345",
			name: "Ever Given",
			callsign: "EVGV",
			navStatus: 0,
			sog: 12.5,
			cog: 180,
			shipType: 70,
			lat: 51,
			lon: 4,
			messageType: 5,
		})
		expect(named).toMatchObject({
			category: "marine",
			protocol: "ais",
			entityKey: "mmsi:000012345",
			title: "Ever Given",
			position: { lat: 51, lon: 4 },
		})
		expect(named?.fields?.map(field => field.key)).not.toContain("name")
		expect(named?.fields?.find(field => field.key === "sog")).toMatchObject({
			unit: "kn",
		})
		const bare = present("ship", {
			mmsi: 244660000,
			messageType: 1,
			lat: 51,
			lon: 4,
			cog: 10,
			sog: 8,
		})
		expect(bare?.entityKey).toBe("mmsi:244660000")
		expect(bare?.fields).toBeUndefined()
		expect(bare?.title).toBe("244660000")
		expect(present("ship", { mmsi: "1234567890" })?.entityKey).toBeUndefined()
	})

	it("canonicalises an APRS callsign and suppresses fields on a redundant position", () => {
		const view = present("aprs", {
			source: "n0call-0",
			destination: "APRS",
			path: ["WIDE1-1"],
			dataType: "Position",
			lat: 40,
			lon: -105,
			course: 12,
			speed: 3,
			raw: "!4000.00N/10500.00W>",
			timestamp: at.toISOString(),
		})
		expect(view).toMatchObject({
			category: "aprs",
			protocol: "aprs",
			entityKey: "callsign:N0CALL",
			title: "N0CALL Position",
			position: { lat: 40, lon: -105 },
		})
		expect(view?.fields).toBeUndefined()
		expect(present("aprs", { source: "not a call" })?.entityKey).toBeUndefined()
		expect(
			present("aprs", { source: "N0\u0000CALL", lat: 1, lon: 2 })?.entityKey,
		).toBeUndefined()
	})

	it("keeps an APRS comment and keys objects and items by name", () => {
		const commented = present("aprs", {
			source: "N0CALL-9",
			dataType: "Position",
			lat: 1,
			lon: 2,
			symbol: "/>",
			comment: "hello",
		})
		expect(commented?.entityKey).toBe("callsign:N0CALL-9")
		expect(commented?.fields?.map(field => field.key)).toEqual([
			"dataType",
			"symbol",
			"comment",
		])
		const object = present("aprs", {
			source: "N0CALL",
			dataType: "Object",
			objectName: " BALLOON ",
			objectKind: "object",
			lat: 10,
			lon: 20,
		})
		expect(object).toMatchObject({
			entityKey: "aprs-object:BALLOON",
			title: "BALLOON object",
			position: { lat: 10, lon: 20 },
		})
		const item = present("aprs", {
			objectName: "DOG",
			objectKind: "item",
			dataType: "Item",
		})
		expect(item?.entityKey).toBe("aprs-item:DOG")
		expect(item?.title).toBe("DOG item")
		expect(item?.position).toBeUndefined()
	})

	it("never keys an APRS object or item with an invalid name by its sending station (1.3)", () => {
		const controlled = present("aprs", {
			source: "N0CALL",
			dataType: "Object",
			objectKind: "object",
			objectName: "BAD\u0000NAME",
			lat: 10,
			lon: 20,
		})
		expect(controlled?.entityKey).toBeUndefined()
		expect(controlled?.title).toBe("BADNAME object")
		expect(controlled?.position).toEqual({ lat: 10, lon: 20 })
		const unnamed = present("aprs", {
			source: "N0CALL",
			dataType: "Item",
			objectKind: "item",
		})
		expect(unnamed?.entityKey).toBeUndefined()
		expect(unnamed?.title).toBe("item")
		const blank = present("aprs", {
			source: "N0CALL",
			dataType: "Object",
			objectKind: "object",
			objectName: "   ",
		})
		expect(blank?.entityKey).toBeUndefined()
		const station = present("aprs", {
			source: "N0CALL",
			dataType: "Position",
			objectName: "\u0007",
			lat: 10,
			lon: 20,
		})
		expect(station?.entityKey).toBeUndefined()
	})

	it("stores APRS messages and status text and does not map a weather packet as position-only", () => {
		const message = present("aprs", {
			source: "N0CALL",
			dataType: "Message",
			message: { addressee: "N0CALL", text: "ping" },
		})
		expect(message?.position).toBeUndefined()
		expect(message?.fields?.find(field => field.key === "message")?.value).toBe(
			"ping",
		)
		const status = present("aprs", {
			source: "N0CALL",
			dataType: "Status",
			comment: "on duty",
		})
		expect(
			status?.fields?.find(field => field.key === "comment"),
		).toMatchObject({
			label: "Status",
			value: "on duty",
		})
		const weather = present("aprs", {
			source: "N0CALL",
			dataType: "Position",
			lat: 1,
			lon: 2,
			weather: { temperature: 70 },
		})
		expect(weather?.fields?.length).toBeGreaterThan(0)
	})

	it("formats a mesh node id and hides fields on a position packet", () => {
		const position = present("meshtastic", {
			from: 42,
			to: 0xffffffff,
			id: 7,
			channel: 0,
			hopLimit: 3,
			hopStart: 3,
			wantAck: false,
			portnum: 3,
			payloadB64: "AA==",
			payloadLen: 1,
			rxRssi: -90,
			rxSnr: 9.5,
			rxTime: at.toISOString(),
			frequency: 906875000,
			bw: 250000,
			sf: 11,
			cr: 5,
		})
		expect(position).toMatchObject({
			category: "mesh",
			protocol: "meshtastic",
			entityKey: "node:!0000002a",
			title: "!0000002a Position",
		})
		expect(position?.position).toBeUndefined()
		expect(position?.fields).toBeUndefined()
		const located = present("meshtastic", {
			from: 42,
			portnum: 3,
			lat: 1,
			lon: 2,
		})
		expect(located?.position).toBeUndefined()
		expect(located?.fields?.some(field => field.key === "portnum")).toBe(true)
		const text = present("meshtastic", {
			from: 1,
			to: 2,
			portnum: 1,
			hopLimit: 2,
			rxSnr: -1,
		})
		expect(text?.title).toBe("!00000001 Text")
		expect(text?.fields?.map(field => field.key)).toEqual([
			"portnum",
			"to",
			"hops",
			"rxSnr",
		])
		expect(
			present("meshtastic", { from: -1, portnum: 1 })?.entityKey,
		).toBeUndefined()
		expect(
			present("meshtastic", { from: 1.5, portnum: 1 })?.entityKey,
		).toBeUndefined()
	})

	it("keys pages by capcode and leaves EAS, DTMF and FSK without a key", () => {
		const page = present("message", {
			protocol: "POCSAG1200",
			address: 1200,
			function: 0,
			messageType: "alpha",
			message: "hello",
		})
		expect(page).toMatchObject({
			category: "paging",
			protocol: "pocsag",
			entityKey: "capcode:1200",
		})
		expect(page?.title).toContain("POCSAG1200")
		expect(page?.title).toContain("hello")
		expect(page?.fields?.find(field => field.key === "function")?.value).toBe(0)
		const flex = present("decode", {
			protocol: "FLEX",
			capcode: "00123",
			message: "x",
		})
		expect(flex?.entityKey).toBe("capcode:123")
		expect(flex?.protocol).toBe("flex")
		expect(
			present("message", { protocol: "EAS", rawMessage: "ZCZC" }),
		).toMatchObject({
			category: "other",
			protocol: "eas",
			title: "EAS",
		})
		expect(
			present("decode", { protocol: "DTMF", digits: "123" }),
		).toMatchObject({
			protocol: "dtmf",
			category: "other",
			title: "DTMF",
		})
		expect(
			present("decode", { protocol: "FSK9600", rawData: "aa" })?.protocol,
		).toBe("fsk9600")
		expect(present("message", { protocol: "DTMF" })).toBeUndefined()
	})

	it("keys AFSK1200 by the from callsign", () => {
		expect(
			present("decode", { protocol: "AFSK1200", from: "n0call-0", to: "APRS" }),
		).toMatchObject({
			category: "aprs",
			protocol: "afsk1200",
			entityKey: "callsign:N0CALL",
			title: "n0call-0 → APRS",
		})
		expect(
			present("decode", { protocol: "AFSK1200", from: "bad call", to: "APRS" })
				?.entityKey,
		).toBeUndefined()
	})

	it("titles a digital call and prefers flat colour code over nested metadata", () => {
		const view = present("call_start", {
			protocol: "dmr",
			talkgroup: 2081,
			source: 3120001,
			slot: 1,
			encrypted: false,
			dmr: { cc: 3 },
		})
		expect(view).toMatchObject({
			category: "voice",
			protocol: "dmr",
			entityKey: "talkgroup:2081",
			title: "DMR TG 2081 from 3120001",
		})
		expect(view?.fields?.find(field => field.key === "colourCode")?.value).toBe(
			3,
		)
		expect(view?.fields?.find(field => field.key === "source")).toMatchObject({
			label: "Radio",
			value: 3120001,
		})
		const ended = present("call_end", {
			protocol: "p25p1",
			talkgroup: 0,
			duration: 1500,
			colourCode: 1,
			nac: "293",
			p25: { nac: "FFF" },
		})
		expect(ended?.entityKey).toBe("talkgroup:0")
		expect(ended?.title).toBe("P25P1 TG 0")
		expect(
			ended?.fields?.find(field => field.key === "colourCode")?.value,
		).toBe(1)
		expect(
			ended?.fields?.find(field => field.key === "duration"),
		).toMatchObject({
			value: 1500,
			unit: "ms",
		})
		expect(present("call", { protocol: "dmr" })?.entityKey).toBeUndefined()
		expect(
			present("call", { protocol: "dmr", talkgroup: -1 })?.entityKey,
		).toBeUndefined()
	})

	it("keys ACARS by registration and VDL2 by ICAO, then tail", () => {
		const acars = present("acars", {
			tail: "n.123ab",
			flight: "UA100",
			label: "H1",
			text: "hello",
		})
		expect(acars).toMatchObject({
			category: "aviation-data",
			protocol: "acars",
			entityKey: "reg:N123AB",
			title: "n.123ab H1",
		})
		expect(acars?.position).toBeUndefined()
		expect(acars?.fields?.find(field => field.key === "text")?.value).toBe(
			"hello",
		)
		const vdl2 = present("vdl2", {
			icao: "abcdef",
			msgType: "I",
			acars: { tail: "N1", flight: "BA1", label: "Q0", text: "hi" },
		})
		expect(vdl2).toMatchObject({
			entityKey: "icao:ABCDEF",
			protocol: "vdl2",
			title: "ABCDEF I",
		})
		expect(vdl2?.fields?.find(field => field.key === "flight")?.value).toBe(
			"BA1",
		)
		expect(
			present("vdl2", { msgType: "UI", acars: { tail: "g-abcd" } })?.entityKey,
		).toBe("reg:G-ABCD")
	})

	it("builds an rtl_433 sensor key and ignores a signal without a model", () => {
		const view = present("signal", {
			model: "Acurite 5n1",
			id: 42,
			channel: 1,
			temperature_C: 21.5,
			humidity: 40,
			battery_ok: 1,
			lat: 1,
			lon: 2,
		})
		expect(view).toMatchObject({
			category: "sensors",
			protocol: "rtl_433",
			entityKey: "sensor:Acurite_5n1-42-1",
			title: "Acurite 5n1 42",
		})
		expect(view?.position).toBeUndefined()
		expect(
			view?.fields?.find(field => field.key === "temperature_C"),
		).toMatchObject({
			unit: "°C",
			value: 21.5,
		})
		expect(
			present("signal", { model: "Bad:Model", id: "a" })?.entityKey,
		).toBeUndefined()
		expect(present("signal", { id: 1 })).toBeUndefined()
		expect(present("signal", { model: "   " })).toBeUndefined()
		expect(present("signal", { model: "Fine", id: 1 })?.entityKey).toBe(
			"sensor:Fine-1",
		)
		expect(
			present("signal", { model: "Fine", id: 1, channel: "bad:channel" })
				?.entityKey,
		).toBeUndefined()
		expect(
			present("acars", { tail: "N\u0000123", label: "Q0" })?.entityKey,
		).toBeUndefined()
	})

	it("returns no presentation for unknown types and non-objects", () => {
		expect(present("stats", { icao: "abc123" })).toBeUndefined()
		expect(present("error", { message: "x" })).toBeUndefined()
		expect(present("aircraft", null)).toBeUndefined()
		expect(present("aircraft", ["abc123"])).toBeUndefined()
		expect(present("message", { protocol: "MORSE" })).toBeUndefined()
	})

	it("caps fields, title and string bytes and strips control characters", () => {
		const message = `${"m".repeat(LONG_TEXT_BYTES + 40)}\u0001tail`
		const view = present("message", {
			protocol: "POCSAG512",
			address: 7,
			function: 1,
			messageType: "alpha",
			message,
		})
		const text = view?.fields?.find(field => field.key === "message")?.value
		expect(typeof text).toBe("string")
		expect(Buffer.byteLength(String(text), "utf8")).toBeLessThanOrEqual(
			LONG_TEXT_BYTES,
		)
		expect(String(text).endsWith("…")).toBe(true)
		expect(String(text)).not.toMatch(/[\u0000-\u001f]/)
		expect(view?.title?.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
		const wide = present("aircraft", {
			icao: "abcdef",
			callsign: "C".repeat(200),
			squawk: "1".repeat(FIELD_TEXT_BYTES + 10),
			altitude: 1,
			groundSpeed: 1,
			track: 1,
			verticalRate: 1,
			category: "A1",
			emergency: "none",
		})
		expect(wide?.fields?.length).toBeLessThanOrEqual(6)
		expect(wide?.title?.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
		for (const field of wide?.fields ?? []) {
			expect(field.label.length).toBeLessThanOrEqual(24)
			if (typeof field.value === "string")
				expect(Buffer.byteLength(field.value, "utf8")).toBeLessThanOrEqual(
					FIELD_TEXT_BYTES,
				)
		}
	})

	it("builds an envelope the schema accepts, including a wide title", () => {
		const output = decoderOutput("aircraft", {
			icao: "abcdef",
			callsign: "😀".repeat(40),
			squawk: "7700",
			lat: 1,
			lon: 2,
		})
		const view = presentDecoderOutput(output, "readsb")
		expect(view?.title?.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
		expect(() =>
			createDecodeEnvelope(
				output,
				{
					eventId: "evt-1",
					receivedAt: at,
					decoderId: "dec-1",
					provenance: { sourceId: null, frequency: null },
				},
				view,
			),
		).not.toThrow()
	})
})

it("stores a synthetic Wireless-MBus row as wmbus at the FSK carrier midpoint", () => {
	const data: unknown = JSON.parse(wmbusJsonLine)
	const output = decoderOutput("signal", data)
	const view = presentDecoderOutput(output, "rtl433")
	expect(view).toMatchObject({
		protocol: "wmbus",
		category: "sensors",
		entityKey: "sensor:Wireless-MBus-12345678",
	})
	expect(view?.fields).toEqual(
		expect.arrayContaining([
			{ key: "mode", label: "Mode", value: "C" },
			{ key: "M", label: "Manufacturer", value: "TST" },
		]),
	)
	const envelope = createDecodeEnvelope(
		output,
		{
			eventId: "synthetic-wmbus",
			receivedAt: at,
			decoderId: output.decoder,
			decoderType: "rtl433",
			provenance: resolveProvenance(output, {
				sourceId: "fake",
				targetFrequenciesHz: [868_900_000],
				inputSampleRateHz: 2_400_000,
				tuningTrust: "commanded",
			}),
		},
		view,
	)
	const row = buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId: envelope.eventId,
		commitSeq: "0",
		producedAt: envelope.producedAt,
		receivedAt: envelope.receivedAt,
		kind: "decoder-reception",
		payload: envelope,
	})
	expect(row).toMatchObject({ protocol: "wmbus", frequencyHz: 868_950_000 })
})

it.each([{ mode: 2 }, { version: "1.2" }, { M: 42, type_string: 3 }])(
	"preserves other rtl_433 presentations with model-specific fields %j",
	extra => {
		const view = presentDecoderOutput(
			decoderOutput("signal", {
				model: "Weather",
				id: 7,
				temperature_C: 21,
				...extra,
			}),
			"rtl433",
		)
		expect(view).toMatchObject({
			protocol: "rtl_433",
			entityKey: "sensor:Weather-7",
		})
		expect(view?.fields).toContainEqual({
			key: "temperature_C",
			label: "Temperature",
			unit: "°C",
			value: 21,
		})
	},
)
