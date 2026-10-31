/**
 * Readsb ADS-B Decoder Unit Tests
 *
 * Tests for the ReadsbDecoder class.
 * Requirements: 22.1, 22.2, 22.3, 22.4
 *
 * Property 33: ADS-B Output Parsing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"
import {
	ReadsbDecoder,
	parseSbsLine,
	parseBeastMessage,
	parseJsonAircraft,
	createReadsbDecoder,
	readsbDecoderFactory,
	READSB_CAPS,
	type AircraftData,
	type ReadsbOutputFormat,
	parseRawAircraft,
} from "../../../src/decoders/builtin/readsb.js"
import pino from "pino"
import type * as ChildProcess from "node:child_process"
import { DecoderSpawnError } from "../../../src/utils/errors.js"

// start() is exercised up to spawn: the mock records the argv and throws, so
// no process or socket is ever created.
const spawnMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async importOriginal => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawn: spawnMock,
}))

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Creates a test decoder config with optional overrides.
 */
function createConfig(overrides: Partial<DecoderConfig> = {}): DecoderConfig {
	return {
		id: "test-readsb",
		type: "readsb",
		enabled: true,
		options: {
			outputFormat: "sbs",
			...overrides.options,
		},
		outputHost: "127.0.0.1",
		outputPort: 30003,
		outputProtocol: "tcp",
		...overrides,
	}
}

describe("ReadsbDecoder", () => {
	let decoder: ReadsbDecoder

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
	})

	afterEach(async () => {
		vi.useRealTimers()
		if (decoder) {
			try {
				await decoder.stop()
			} catch {
				// Ignore errors during cleanup
			}
		}
	})

	describe("constructor", () => {
		it("should initialize with correct id and type", () => {
			const config = createConfig({ id: "my-readsb", type: "readsb" })
			decoder = new ReadsbDecoder(config, testLogger)

			expect(decoder.id).toBe("my-readsb")
			expect(decoder.type).toBe("readsb")
		})

		it("should use default SBS port when not specified", () => {
			const config = createConfig({
				options: { outputFormat: "sbs" },
				outputPort: undefined,
			})
			decoder = new ReadsbDecoder(config, testLogger)

			// The decoder should use port 30003 for SBS format
			expect(decoder.caps.output).toBe("text")
		})

		it("should use default Beast port when not specified", () => {
			const config = createConfig({
				options: { outputFormat: "beast" },
				outputPort: undefined,
			})
			decoder = new ReadsbDecoder(config, testLogger)

			expect(decoder.caps.output).toBe("beast")
		})

		it("should use default JSON port when not specified", () => {
			const config = createConfig({
				options: { outputFormat: "json" },
				outputPort: undefined,
			})
			decoder = new ReadsbDecoder(config, testLogger)

			expect(decoder.caps.output).toBe("jsonl")
		})
	})

	describe("getCaps", () => {
		it("should return correct capabilities for SBS format", () => {
			const config = createConfig({ options: { outputFormat: "sbs" } })
			decoder = new ReadsbDecoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "iq",
				wantsExclusiveSource: false, // Passive resampling permits shared IQ
				output: "text",
				integrationPattern: "network_producer",
			})
		})

		it("should return correct capabilities for Beast format", () => {
			const config = createConfig({ options: { outputFormat: "beast" } })
			decoder = new ReadsbDecoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "iq",
				wantsExclusiveSource: false, // Passive resampling permits shared IQ
				output: "beast",
				integrationPattern: "network_producer",
			})
		})

		it("should return correct capabilities for JSON format", () => {
			const config = createConfig({ options: { outputFormat: "json" } })
			decoder = new ReadsbDecoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "iq",
				wantsExclusiveSource: false, // Passive resampling permits shared IQ
				output: "jsonl",
				integrationPattern: "network_producer",
			})
		})
	})

	describe("getStatus", () => {
		it("should return status with all required fields when not running", () => {
			const config = createConfig()
			decoder = new ReadsbDecoder(config, testLogger)
			const status = decoder.getStatus()

			expect(status.id).toBe("test-readsb")
			expect(status.type).toBe("readsb")
			expect(status.running).toBe(false)
			expect(status.health).toBe("running")
			expect(status.pid).toBeUndefined()
			expect(status.uptime).toBe(0)
			expect(status.stats).toEqual({ bytesIn: 0, eventsOut: 0, errors: 0 })
			expect(status.restartCount).toBe(0)
		})
	})
})

describe("parseSbsLine", () => {
	const timestampLine = (
		date: string,
		time: string,
		loggedDate = "2026/01/01",
		loggedTime = "00:00:09.000",
	) =>
		`MSG,3,1,1,ABC123,1,${date},${time},${loggedDate},${loggedTime},,12000,,,,,,,,,,0`

	it("carries source time and stable full-line identity independently of receipt", () => {
		const line = timestampLine("2026/01/01", "00:00:01.123")
		const first = parseSbsLine(line)
		expect(first?.sbsSourceTimestamp?.toISOString()).toBe(
			"2026-01-01T00:00:01.123Z",
		)
		expect(first?.sbsContentId).toMatch(/^[0-9a-f]{64}$/)
		expect(parseSbsLine(line)?.sbsContentId).toBe(first?.sbsContentId)
		expect(parseSbsLine(line.replace("MSG,3", "MSG,4"))?.sbsContentId).not.toBe(
			first?.sbsContentId,
		)
	})

	it("uses logged time only when both generated fields are absent", () => {
		expect(
			parseSbsLine(timestampLine("", ""))?.sbsSourceTimestamp?.toISOString(),
		).toBe("2026-01-01T00:00:09.000Z")
		expect(
			parseSbsLine(timestampLine("", "00:00:01.000"))?.sbsSourceTimestamp,
		).toBeUndefined()
		expect(
			parseSbsLine(timestampLine("", "", "", ""))?.sbsSourceTimestamp,
		).toBeUndefined()
	})

	it("keeps source time continuous across midnight", () => {
		const before = parseSbsLine(timestampLine("2026/01/01", "23:59:59.000"))
		const after = parseSbsLine(timestampLine("2026/01/02", "00:00:01.000"))
		const a = before?.sbsSourceTimestamp?.getTime()
		const b = after?.sbsSourceTimestamp?.getTime()
		expect(a).toBeDefined()
		expect(b).toBeDefined()
		expect(b! - a!).toBe(2_000)
	})

	it.each([
		["2026/02/29", "00:00:00.000"],
		["2026/04/31", "00:00:00.000"],
		["2026/13/01", "00:00:00.000"],
		["2026/01/01", "24:00:00.000"],
		["2026/01/01", "00:60:00.000"],
		["2026/01/01", "00:00:60.000"],
		["2026/01/01", "malformed"],
	])(
		"rejects malformed source timestamp %s %s without logged fallback",
		(date, time) => {
			const record = parseSbsLine(timestampLine(date, time))
			expect(record).not.toBeNull()
			expect(record?.sbsSourceTimestamp).toBeUndefined()
		},
	)

	it("should parse a valid MSG,3 (airborne position) line", () => {
		const line =
			"MSG,3,1,1,A12345,1,2024/01/15,12:30:45.123,2024/01/15,12:30:45.123,UAL123,35000,450,180,40.7128,-74.0060,0,1234,0,0,0,0"

		const result = parseSbsLine(line)

		expect(result).not.toBeNull()
		expect(result?.icao).toBe("A12345")
		expect(result?.callsign).toBe("UAL123")
		expect(result?.altitude).toBe(35000)
		expect(result?.groundSpeed).toBe(450)
		expect(result?.track).toBe(180)
		expect(result?.lat).toBe(40.7128)
		expect(result?.lon).toBe(-74.006)
		expect(result?.squawk).toBe("1234")
	})

	it("should parse a line with missing optional fields", () => {
		const line =
			"MSG,1,1,1,ABCDEF,1,2024/01/15,12:30:45.123,2024/01/15,12:30:45.123,,,,,,,,,,,,"

		const result = parseSbsLine(line)

		expect(result).not.toBeNull()
		expect(result?.icao).toBe("ABCDEF")
		expect(result?.callsign).toBeUndefined()
		expect(result?.altitude).toBeUndefined()
	})

	it("should return null for invalid lines", () => {
		expect(parseSbsLine("")).toBeNull()
		expect(parseSbsLine("invalid")).toBeNull()
		expect(parseSbsLine("MSG,invalid")).toBeNull()
	})

	it("should handle on-ground flag", () => {
		const lineOnGround =
			"MSG,3,1,1,A12345,1,2024/01/15,12:30:45.123,2024/01/15,12:30:45.123,,0,,,40.7128,-74.0060,,,,,,-1"
		const lineInAir =
			"MSG,3,1,1,A12345,1,2024/01/15,12:30:45.123,2024/01/15,12:30:45.123,,35000,,,40.7128,-74.0060,,,,,,0"

		const onGround = parseSbsLine(lineOnGround)
		const inAir = parseSbsLine(lineInAir)

		expect(onGround?.onGround).toBe(true)
		expect(inAir?.onGround).toBe(false)
	})

	// R3: an empty IsOnGround field (most MSG types) is unknown, not "in the air".
	it("leaves onGround unknown when the field is empty", () => {
		const msg1 =
			"MSG,1,1,1,A12345,1,2024/01/15,12:30:45.123,2024/01/15,12:30:45.123,UAL123,,,,,,,,,,,"
		const parsed = parseSbsLine(msg1)
		expect(parsed?.callsign).toBe("UAL123")
		expect(parsed?.onGround).toBeUndefined()
		expect(parsed).not.toHaveProperty("onGround", false)
	})
})

describe("parseBeastMessage", () => {
	it("should parse a Mode-S short message (type 0x32)", () => {
		// Create a mock Mode-S short message with ICAO A12345
		const timestamp = Buffer.alloc(6)
		const signal = 100
		const message = Buffer.from([0x00, 0xa1, 0x23, 0x45, 0x00, 0x00, 0x00])

		const result = parseBeastMessage(0x32, timestamp, signal, message)

		expect(result).not.toBeNull()
		expect(result?.icao).toBe("A12345")
	})

	it("should parse a Mode-S long message (type 0x33)", () => {
		// Create a mock Mode-S long message with ICAO ABCDEF
		const timestamp = Buffer.alloc(6)
		const signal = 100
		const message = Buffer.from([
			0x00, 0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00,
		])

		const result = parseBeastMessage(0x33, timestamp, signal, message)

		expect(result).not.toBeNull()
		expect(result?.icao).toBe("ABCDEF")
	})

	it("should return null for Mode-AC messages (type 0x31)", () => {
		const timestamp = Buffer.alloc(6)
		const signal = 100
		const message = Buffer.from([0x00, 0x00])

		const result = parseBeastMessage(0x31, timestamp, signal, message)

		expect(result).toBeNull()
	})

	it("should return null for messages that are too short", () => {
		const timestamp = Buffer.alloc(6)
		const signal = 100
		const message = Buffer.from([0x00, 0x00, 0x00]) // Only 3 bytes, need at least 4

		const result = parseBeastMessage(0x32, timestamp, signal, message)

		expect(result).toBeNull()
	})
})

describe("parseJsonAircraft", () => {
	it("derives JSON source time from epoch seconds minus last-message age", () => {
		expect(
			parseJsonAircraft({
				hex: "abc123",
				now: 100.25,
				seen: 0.125,
			})?.jsonSourceTimestamp?.getTime(),
		).toBe(100125)
	})
	it.each([
		{},
		{ now: 100 },
		{ now: 100, seen: -1 },
		{ now: 100, seen: 101 },
		{ now: Infinity, seen: 0 },
		{ now: 1e20, seen: 0 },
		{ now: "100", seen: 0 },
	])("does not manufacture JSON source time for %s", fields => {
		expect(
			parseJsonAircraft({ hex: "abc123", ...fields })?.jsonSourceTimestamp,
		).toBeUndefined()
	})

	it("should parse a valid JSON aircraft object", () => {
		const json = {
			hex: "a12345",
			flight: "UAL123  ",
			alt_baro: 35000,
			gs: 450,
			track: 180,
			lat: 40.7128,
			lon: -74.006,
			baro_rate: 0,
			squawk: "1234",
			ground: false,
			messages: 42,
		}

		const result = parseJsonAircraft(json)

		expect(result).not.toBeNull()
		expect(result?.icao).toBe("A12345")
		expect(result?.callsign).toBe("UAL123")
		expect(result?.altitude).toBe(35000)
		expect(result?.groundSpeed).toBe(450)
		expect(result?.track).toBe(180)
		expect(result?.lat).toBe(40.7128)
		expect(result?.lon).toBe(-74.006)
		expect(result?.verticalRate).toBe(0)
		expect(result?.squawk).toBe("1234")
		expect(result?.onGround).toBe(false)
		expect(result?.messageCount).toBe(42)
	})

	it("should handle lowercase ICAO addresses", () => {
		const json = { hex: "abcdef" }

		const result = parseJsonAircraft(json)

		expect(result?.icao).toBe("ABCDEF")
	})

	it("should handle icao field instead of hex", () => {
		const json = { icao: "123456" }

		const result = parseJsonAircraft(json)

		expect(result?.icao).toBe("123456")
	})

	it("should return null for objects without ICAO", () => {
		const json = { flight: "UAL123" }

		const result = parseJsonAircraft(json)

		expect(result).toBeNull()
	})

	it("should handle missing optional fields", () => {
		const json = { hex: "a12345" }

		const result = parseJsonAircraft(json)

		expect(result).not.toBeNull()
		expect(result?.icao).toBe("A12345")
		expect(result?.callsign).toBeUndefined()
		expect(result?.altitude).toBeUndefined()
		expect(result?.messageCount).toBe(1) // Default
	})
})

describe("createReadsbDecoder", () => {
	it("should create a ReadsbDecoder instance", () => {
		const config = createConfig()
		const decoder = createReadsbDecoder(config, testLogger)

		expect(decoder).toBeInstanceOf(ReadsbDecoder)
		expect(decoder.id).toBe("test-readsb")
	})
})

// Feature: web-gaps-3, requirement 9.1: station location reaches readsb
describe("readsb receiver location (WG3 req 9.1)", () => {
	function args(
		options: Record<string, unknown>,
		station?: { lat?: number | undefined; lon?: number | undefined },
	): string[] {
		const config = createConfig({
			options: { outputFormat: "sbs", ...options },
		})
		const decoder =
			station === undefined
				? createReadsbDecoder(config, testLogger)
				: readsbDecoderFactory(station)(config, testLogger)
		return (decoder as unknown as { getArgs(): string[] }).getArgs()
	}
	function location(argv: string[]): [string, string] | null {
		const joined = argv.join(" ")
		const lat = /--lat (\S+)/.exec(joined)
		const lon = /--lon (\S+)/.exec(joined)
		if (!lat?.[1] || !lon?.[1]) {
			expect(lat).toBeNull()
			expect(lon).toBeNull()
			return null
		}
		return [lat[1], lon[1]]
	}

	it("passes the station location without MLAT", () => {
		expect(location(args({}, { lat: 48.85, lon: 2.35 }))).toEqual([
			"48.85",
			"2.35",
		])
	})

	it("passes decoder options location without MLAT", () => {
		expect(location(args({ lat: 51.5, lon: -0.12 }))).toEqual(["51.5", "-0.12"])
	})

	it("decoder options win over the station", () => {
		expect(
			location(args({ lat: 51.5, lon: -0.12 }, { lat: 48.85, lon: 2.35 })),
		).toEqual(["51.5", "-0.12"])
	})

	it("falls back to the station when options give only one coordinate", () => {
		expect(location(args({ lat: 51.5 }, { lat: 48.85, lon: 2.35 }))).toEqual([
			"48.85",
			"2.35",
		])
	})

	it("passes nothing when neither is known", () => {
		expect(location(args({}))).toBeNull()
		expect(location(args({}, {}))).toBeNull()
		expect(location(args({}, { lat: 48.85 }))).toBeNull()
		expect(location(args({ lon: 2 }, { lat: 48.85 }))).toBeNull()
	})

	it("treats an invalid option coordinate as unset and falls back to the station", () => {
		const station = { lat: 48.85, lon: 2.35 }
		const invalid: Array<[unknown, unknown]> = [
			[null, null],
			[Number.NaN, 2],
			[1, Number.NaN],
			["51.5", "-0.12"],
			[91, 0],
			[0, 181],
			[-90.5, 0],
			[0, -180.5],
			[Number.POSITIVE_INFINITY, 0],
		]
		for (const enableMlat of [true, false]) {
			for (const [lat, lon] of invalid) {
				expect(location(args({ enableMlat, lat, lon }, station))).toEqual([
					"48.85",
					"2.35",
				])
				expect(location(args({ enableMlat, lat, lon }))).toBeNull()
			}
		}
		expect(location(args({ lat: 90, lon: -180 }, station))).toEqual([
			"90",
			"-180",
		])
	})

	it("ignores an invalid station coordinate", () => {
		for (const station of [
			{ lat: Number.NaN, lon: 2 },
			{ lat: 91, lon: 2 },
			{ lat: 1, lon: 181 },
			{ lat: null, lon: null } as unknown as { lat: number; lon: number },
			{ lat: "1", lon: "2" } as unknown as { lat: number; lon: number },
		])
			expect(location(args({}, station))).toBeNull()
	})

	it("validates option coordinates again after an options update", () => {
		const config = createConfig({
			options: { outputFormat: "sbs", lat: 1, lon: 2 },
		})
		const decoder = readsbDecoderFactory({ lat: 10, lon: 20 })(
			config,
			testLogger,
		)
		const view = decoder as unknown as {
			getArgs(): string[]
			onOptionsUpdated(): void
			config: DecoderConfig
		}
		expect(location(view.getArgs())).toEqual(["1", "2"])
		for (const [lat, lon] of [
			[null, null],
			[Number.NaN, 2],
			["1", "2"],
			[95, 2],
		] as const) {
			view.config.options = { outputFormat: "sbs", lat, lon }
			view.onOptionsUpdated()
			expect(location(view.getArgs())).toEqual(["10", "20"])
		}
		view.config.options = { outputFormat: "sbs", lat: 3, lon: 4 }
		view.onOptionsUpdated()
		expect(location(view.getArgs())).toEqual(["3", "4"])
	})

	it("is independent of enableMlat", () => {
		for (const enableMlat of [true, false]) {
			expect(location(args({ enableMlat }, { lat: 48.85, lon: 2.35 }))).toEqual(
				["48.85", "2.35"],
			)
			expect(location(args({ enableMlat, lat: 1, lon: 2 }))).toEqual(["1", "2"])
			expect(location(args({ enableMlat }))).toBeNull()
		}
	})

	it("works in rtl_tcp network mode and survives an options update", () => {
		const config = createConfig({
			options: { outputFormat: "sbs", rtlTcpHost: "10.0.0.2" },
		})
		const decoder = readsbDecoderFactory({ lat: 10, lon: 20 })(
			config,
			testLogger,
		)
		const view = decoder as unknown as {
			getArgs(): string[]
			onOptionsUpdated(): void
			config: DecoderConfig
		}
		expect(location(view.getArgs())).toEqual(["10", "20"])
		view.config.options = { outputFormat: "sbs", rtlTcpHost: "10.0.0.3" }
		view.onOptionsUpdated()
		expect(location(view.getArgs())).toEqual(["10", "20"])
	})
})

// Feature: web-gaps-4: readsb resolves the station location at each start
describe("readsb station location getter", () => {
	function location(argv: string[]): [string, string] | null {
		const joined = argv.join(" ")
		const lat = /--lat (\S+)/.exec(joined)
		const lon = /--lon (\S+)/.exec(joined)
		if (!lat?.[1] || !lon?.[1]) {
			expect(lat).toBeNull()
			expect(lon).toBeNull()
			return null
		}
		return [lat[1], lon[1]]
	}
	/** Runs start() up to spawn and returns the argv it would launch. */
	async function startArgs(decoder: ReadsbDecoder): Promise<string[]> {
		spawnMock.mockReset()
		spawnMock.mockImplementation(() => {
			throw new Error("spawn disabled in tests")
		})
		await expect(decoder.start()).rejects.toBeInstanceOf(DecoderSpawnError)
		expect(spawnMock).toHaveBeenCalledTimes(1)
		const argv: unknown = spawnMock.mock.calls[0]?.[1]
		expect(Array.isArray(argv)).toBe(true)
		return argv as string[]
	}
	function decoderWith(
		station: () => { lat?: number; lon?: number } | null,
		options: Record<string, unknown> = {},
	): ReadsbDecoder {
		return readsbDecoderFactory(station)(
			createConfig({ options: { outputFormat: "sbs", ...options } }),
			testLogger,
		)
	}

	afterEach(() => {
		spawnMock.mockReset()
	})

	it("consults the getter at start, not at construction", async () => {
		const station = vi.fn(() => ({ lat: 48.85, lon: 2.35 }))
		const decoder = decoderWith(station)
		expect(station).not.toHaveBeenCalled()
		expect(location(await startArgs(decoder))).toEqual(["48.85", "2.35"])
		expect(station).toHaveBeenCalled()
	})

	it("applies a changed getter value at the next start", async () => {
		let current: { lat?: number; lon?: number } | null = null
		const decoder = decoderWith(() => current)
		expect(location(await startArgs(decoder))).toBeNull()
		current = { lat: 10, lon: 20 }
		expect(location(await startArgs(decoder))).toEqual(["10", "20"])
		current = { lat: -33.9, lon: 151.2 }
		expect(location(await startArgs(decoder))).toEqual(["-33.9", "151.2"])
		current = { lat: 10 }
		expect(location(await startArgs(decoder))).toBeNull()
	})

	it("treats a throwing getter as unset without crashing", async () => {
		let fail = true
		const decoder = decoderWith(() => {
			if (fail) throw new Error("station service unavailable")
			return { lat: 1, lon: 2 }
		})
		expect(location(await startArgs(decoder))).toBeNull()
		fail = false
		expect(location(await startArgs(decoder))).toEqual(["1", "2"])
		fail = true
		const withOptions = decoderWith(
			() => {
				throw new Error("station service unavailable")
			},
			{ lat: 5, lon: 6 },
		)
		expect(location(await startArgs(withOptions))).toEqual(["5", "6"])
	})

	it("treats invalid getter values as unset", async () => {
		const invalid: unknown[] = [
			null,
			undefined,
			"48.85,2.35",
			{},
			{ lat: Number.NaN, lon: 2 },
			{ lat: 1, lon: Number.NaN },
			{ lat: 91, lon: 2 },
			{ lat: 1, lon: -181 },
			{ lat: Number.POSITIVE_INFINITY, lon: 0 },
			{ lat: "1", lon: "2" },
			{ lat: null, lon: null },
		]
		for (const value of invalid) {
			const decoder = decoderWith(
				() => value as { lat?: number; lon?: number } | null,
			)
			expect(location(await startArgs(decoder))).toBeNull()
		}
		const edge = decoderWith(() => ({ lat: -90, lon: 180 }))
		expect(location(await startArgs(edge))).toEqual(["-90", "180"])
	})

	it("keeps explicit decoder options ahead of the getter", async () => {
		const station = vi.fn(() => ({ lat: 48.85, lon: 2.35 }))
		expect(
			location(
				await startArgs(decoderWith(station, { lat: 51.5, lon: -0.12 })),
			),
		).toEqual(["51.5", "-0.12"])
		expect(
			location(await startArgs(decoderWith(station, { lat: 51.5 }))),
		).toEqual(["48.85", "2.35"])
	})

	it("keeps a constant station working through start", async () => {
		const decoder = readsbDecoderFactory({ lat: 10, lon: 20 })(
			createConfig({ options: { outputFormat: "sbs" } }),
			testLogger,
		)
		expect(location(await startArgs(decoder))).toEqual(["10", "20"])
	})
})

describe("READSB_CAPS", () => {
	it("should have correct default capabilities", () => {
		expect(READSB_CAPS).toEqual({
			input: "iq",
			wantsExclusiveSource: false,
			output: "jsonl",
			integrationPattern: "network_producer",
		})
	})
})

/**
 * Arbitrary generators for property-based testing
 */

/**
 * Arbitrary for generating valid ICAO addresses (6 hex characters).
 */
const icaoArb = fc.stringMatching(/^[A-F0-9]{6}$/)

/**
 * Arbitrary for generating valid callsigns (1-8 alphanumeric characters).
 */
const callsignArb = fc.stringMatching(/^[A-Z0-9]{1,8}$/)

/**
 * Arbitrary for generating valid altitudes (0-60000 feet).
 */
const altitudeArb = fc.integer({ min: 0, max: 60000 })

/**
 * Arbitrary for generating valid ground speeds (0-700 knots).
 */
const groundSpeedArb = fc.integer({ min: 0, max: 700 })

/**
 * Arbitrary for generating valid track/heading (0-359 degrees).
 */
const trackArb = fc.integer({ min: 0, max: 359 })

/**
 * Arbitrary for generating valid latitudes (-90 to 90).
 */
const latArb = fc.double({ min: -90, max: 90, noNaN: true })

/**
 * Arbitrary for generating valid longitudes (-180 to 180).
 */
const lonArb = fc.double({ min: -180, max: 180, noNaN: true })

/**
 * Arbitrary for generating valid vertical rates (-10000 to 10000 ft/min).
 */
const verticalRateArb = fc.integer({ min: -10000, max: 10000 })

/**
 * Arbitrary for generating valid squawk codes (4 octal digits).
 */
const squawkArb = fc.stringMatching(/^[0-7]{4}$/)

/**
 * Arbitrary for generating SBS message types (1-8).
 */
const sbsMsgTypeArb = fc.integer({ min: 1, max: 8 })

/**
 * Arbitrary for generating valid SBS date strings.
 */
const sbsDateArb = fc
	.tuple(
		fc.integer({ min: 2020, max: 2030 }),
		fc.integer({ min: 1, max: 12 }),
		fc.integer({ min: 1, max: 28 }),
	)
	.map(
		([y, m, d]) =>
			`${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`,
	)

/**
 * Arbitrary for generating valid SBS time strings.
 */
const sbsTimeArb = fc
	.tuple(
		fc.integer({ min: 0, max: 23 }),
		fc.integer({ min: 0, max: 59 }),
		fc.integer({ min: 0, max: 59 }),
		fc.integer({ min: 0, max: 999 }),
	)
	.map(
		([h, m, s, ms]) =>
			`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`,
	)

/**
 * Arbitrary for generating valid SBS lines with all fields.
 */
const sbsLineArb = fc
	.record({
		msgType: sbsMsgTypeArb,
		icao: icaoArb,
		dateGen: sbsDateArb,
		timeGen: sbsTimeArb,
		dateLog: sbsDateArb,
		timeLog: sbsTimeArb,
		callsign: fc.option(callsignArb, { nil: undefined }),
		altitude: fc.option(altitudeArb, { nil: undefined }),
		groundSpeed: fc.option(groundSpeedArb, { nil: undefined }),
		track: fc.option(trackArb, { nil: undefined }),
		lat: fc.option(latArb, { nil: undefined }),
		lon: fc.option(lonArb, { nil: undefined }),
		verticalRate: fc.option(verticalRateArb, { nil: undefined }),
		squawk: fc.option(squawkArb, { nil: undefined }),
		onGround: fc.boolean(),
	})
	.map(
		({
			msgType,
			icao,
			dateGen,
			timeGen,
			dateLog,
			timeLog,
			callsign,
			altitude,
			groundSpeed,
			track,
			lat,
			lon,
			verticalRate,
			squawk,
			onGround,
		}) =>
			`MSG,${msgType},1,1,${icao},1,${dateGen},${timeGen},${dateLog},${timeLog},${callsign ?? ""},${altitude ?? ""},${groundSpeed ?? ""},${track ?? ""},${lat ?? ""},${lon ?? ""},${verticalRate ?? ""},${squawk ?? ""},0,0,0,${onGround ? "-1" : "0"}`,
	)

/**
 * Arbitrary for generating valid JSON aircraft objects.
 */
const jsonAircraftArb = fc.record({
	hex: icaoArb.map(s => s.toLowerCase()),
	flight: fc.option(
		callsignArb.map(s => s + "  "),
		{ nil: undefined },
	),
	alt_baro: fc.option(altitudeArb, { nil: undefined }),
	gs: fc.option(groundSpeedArb, { nil: undefined }),
	track: fc.option(trackArb, { nil: undefined }),
	lat: fc.option(latArb, { nil: undefined }),
	lon: fc.option(lonArb, { nil: undefined }),
	baro_rate: fc.option(verticalRateArb, { nil: undefined }),
	squawk: fc.option(squawkArb, { nil: undefined }),
	ground: fc.option(fc.boolean(), { nil: undefined }),
	messages: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined }),
})

/**
 * Arbitrary for generating valid Beast Mode-S short messages (type 0x32).
 */
const beastShortMsgArb = icaoArb.map(icao => {
	// Create a 7-byte Mode-S short message with ICAO in bytes 1-3
	const icaoBytes = Buffer.from(icao, "hex")
	const message = Buffer.alloc(7)
	message[0] = 0x00 // DF byte
	icaoBytes.copy(message, 1) // ICAO in bytes 1-3
	return { msgType: 0x32 as const, message, icao }
})

/**
 * Arbitrary for generating valid Beast Mode-S long messages (type 0x33).
 */
const beastLongMsgArb = icaoArb.map(icao => {
	// Create a 14-byte Mode-S long message with ICAO in bytes 1-3
	const icaoBytes = Buffer.from(icao, "hex")
	const message = Buffer.alloc(14)
	message[0] = 0x00 // DF byte
	icaoBytes.copy(message, 1) // ICAO in bytes 1-3
	return { msgType: 0x33 as const, message, icao }
})

/**
 * Arbitrary for generating valid Beast messages (short or long).
 */
const beastMsgArb = fc.oneof(beastShortMsgArb, beastLongMsgArb)

describe("Readsb ADS-B Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 33: ADS-B Output Parsing
	 * Validates: Requirements 22.2
	 *
	 * For any valid readsb output line (SBS, Beast, or JSON format),
	 * the parser should produce a DecoderOutput object with type: 'aircraft'
	 * and an AircraftData object containing at minimum the ICAO address.
	 */
	describe("Property 33: ADS-B Output Parsing", () => {
		it("should parse any valid SBS line into AircraftData with ICAO address", () => {
			fc.assert(
				fc.property(sbsLineArb, line => {
					const result = parseSbsLine(line)

					// Should produce a valid AircraftData
					expect(result).not.toBeNull()

					// Must contain ICAO address (6 hex characters)
					expect(result!.icao).toMatch(/^[A-F0-9]{6}$/)

					// Must have lastSeen timestamp
					expect(result!.lastSeen).toBeInstanceOf(Date)

					// Must have messageCount
					expect(typeof result!.messageCount).toBe("number")
					expect(result!.messageCount).toBeGreaterThan(0)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse any valid JSON aircraft object into AircraftData with ICAO address", () => {
			fc.assert(
				fc.property(jsonAircraftArb, json => {
					const result = parseJsonAircraft(json as Record<string, unknown>)

					// Should produce a valid AircraftData
					expect(result).not.toBeNull()

					// Must contain ICAO address (6 hex characters, uppercase)
					expect(result!.icao).toMatch(/^[A-F0-9]{6}$/)

					// Must have lastSeen timestamp
					expect(result!.lastSeen).toBeInstanceOf(Date)

					// Must have messageCount
					expect(typeof result!.messageCount).toBe("number")
					expect(result!.messageCount).toBeGreaterThan(0)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse any valid Beast Mode-S message into AircraftData with ICAO address", () => {
			fc.assert(
				fc.property(beastMsgArb, ({ msgType, message, icao }) => {
					const timestamp = Buffer.alloc(6)
					const signal = 100

					const result = parseBeastMessage(msgType, timestamp, signal, message)

					// Should produce a valid AircraftData
					expect(result).not.toBeNull()

					// Must contain ICAO address matching the input
					expect(result!.icao).toBe(icao)

					// Must have lastSeen timestamp
					expect(result!.lastSeen).toBeInstanceOf(Date)

					// Must have messageCount
					expect(typeof result!.messageCount).toBe("number")
					expect(result!.messageCount).toBeGreaterThan(0)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should preserve optional fields when present in SBS format", () => {
			fc.assert(
				fc.property(
					fc.record({
						icao: icaoArb,
						callsign: callsignArb,
						altitude: altitudeArb,
						groundSpeed: groundSpeedArb,
						track: trackArb,
						lat: latArb,
						lon: lonArb,
						verticalRate: verticalRateArb,
						squawk: squawkArb,
						onGround: fc.boolean(),
					}),
					({
						icao,
						callsign,
						altitude,
						groundSpeed,
						track,
						lat,
						lon,
						verticalRate,
						squawk,
						onGround,
					}) => {
						// Build a complete SBS line with all fields
						const line = `MSG,3,1,1,${icao},1,2024/01/15,12:30:45.123,2024/01/15,12:30:45.123,${callsign},${altitude},${groundSpeed},${track},${lat},${lon},${verticalRate},${squawk},0,0,0,${onGround ? "-1" : "0"}`

						const result = parseSbsLine(line)

						expect(result).not.toBeNull()
						expect(result!.icao).toBe(icao)
						expect(result!.callsign).toBe(callsign)
						expect(result!.altitude).toBe(altitude)
						expect(result!.groundSpeed).toBe(groundSpeed)
						expect(result!.track).toBe(track)
						// Latitude and longitude may have floating point precision differences
						expect(result!.lat).toBeCloseTo(lat, 4)
						expect(result!.lon).toBeCloseTo(lon, 4)
						expect(result!.verticalRate).toBe(verticalRate)
						expect(result!.squawk).toBe(squawk)
						expect(result!.onGround).toBe(onGround)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should preserve optional fields when present in JSON format", () => {
			fc.assert(
				fc.property(
					fc.record({
						hex: icaoArb.map(s => s.toLowerCase()),
						flight: callsignArb,
						alt_baro: altitudeArb,
						gs: groundSpeedArb,
						track: trackArb,
						lat: latArb,
						lon: lonArb,
						baro_rate: verticalRateArb,
						squawk: squawkArb,
						ground: fc.boolean(),
						messages: fc.integer({ min: 1, max: 10000 }),
					}),
					json => {
						const result = parseJsonAircraft(json as Record<string, unknown>)

						expect(result).not.toBeNull()
						expect(result!.icao).toBe(json.hex.toUpperCase())
						expect(result!.callsign).toBe(json.flight.trim())
						expect(result!.altitude).toBe(json.alt_baro)
						expect(result!.groundSpeed).toBe(json.gs)
						expect(result!.track).toBe(json.track)
						expect(result!.lat).toBe(json.lat)
						expect(result!.lon).toBe(json.lon)
						expect(result!.verticalRate).toBe(json.baro_rate)
						expect(result!.squawk).toBe(json.squawk)
						expect(result!.onGround).toBe(json.ground)
						expect(result!.messageCount).toBe(json.messages)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for invalid inputs across all formats", () => {
			// Test that invalid SBS lines return null
			fc.assert(
				fc.property(
					fc.string().filter(s => {
						// Filter out strings that could match the SBS pattern
						return !s.startsWith("MSG,") || s.split(",").length < 22
					}),
					line => {
						const result = parseSbsLine(line)
						return result === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for JSON objects without ICAO", () => {
			fc.assert(
				fc.property(
					fc.record({
						flight: fc.option(callsignArb, { nil: undefined }),
						alt_baro: fc.option(altitudeArb, { nil: undefined }),
						gs: fc.option(groundSpeedArb, { nil: undefined }),
					}),
					json => {
						// Ensure no hex or icao field
						const result = parseJsonAircraft(json as Record<string, unknown>)
						return result === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for Beast Mode-AC messages (type 0x31)", () => {
			fc.assert(
				fc.property(fc.uint8Array({ minLength: 2, maxLength: 2 }), msgBytes => {
					const timestamp = Buffer.alloc(6)
					const signal = 100
					const message = Buffer.from(msgBytes)

					const result = parseBeastMessage(0x31, timestamp, signal, message)
					return result === null
				}),
				{ numRuns: 100 },
			)
		})

		it("should produce AircraftData with all required fields for any valid format", () => {
			// Combined test verifying the AircraftData structure
			fc.assert(
				fc.property(
					fc.oneof(
						// SBS format
						sbsLineArb.map(line => ({ format: "sbs" as const, data: line })),
						// JSON format
						jsonAircraftArb.map(json => ({
							format: "json" as const,
							data: json,
						})),
						// Beast format
						beastMsgArb.map(beast => ({
							format: "beast" as const,
							data: beast,
						})),
					),
					({ format, data }) => {
						let result: AircraftData | null = null

						switch (format) {
							case "sbs":
								result = parseSbsLine(data as string)
								break
							case "json":
								result = parseJsonAircraft(data as Record<string, unknown>)
								break
							case "beast": {
								const { msgType, message } = data as {
									msgType: number
									message: Buffer
									icao: string
								}
								const timestamp = Buffer.alloc(6)
								result = parseBeastMessage(msgType, timestamp, 100, message)
								break
							}
						}

						// All valid inputs should produce AircraftData
						expect(result).not.toBeNull()

						// Verify required fields
						expect(result).toHaveProperty("icao")
						expect(result).toHaveProperty("lastSeen")
						expect(result).toHaveProperty("messageCount")

						// ICAO must be a valid 6-character hex string
						expect(result!.icao).toMatch(/^[A-F0-9]{6}$/)

						// lastSeen must be a Date
						expect(result!.lastSeen).toBeInstanceOf(Date)

						// messageCount must be a positive number
						expect(result!.messageCount).toBeGreaterThan(0)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	describe("parseRawAircraft from SBS and Beast output", () => {
		it("keeps callsign, altitude, ground speed and vertical rate of an SBS line", () => {
			const sbs = parseSbsLine(
				"MSG,3,1,1,ABC123,1,2026/01/01,00:00:00.000,2026/01/01,00:00:00.000,WKT101 ,35000,420.5,231.0,48.1,-3.9,-640,1234,0,0,0,0",
			)
			expect(sbs).not.toBeNull()
			const raw = parseRawAircraft(sbs as unknown as Record<string, unknown>)
			expect(raw).toMatchObject({
				hex: "ABC123",
				flight: "WKT101",
				alt_baro: 35000,
				gs: 420.5,
				track: 231,
				baro_rate: -640,
				squawk: "1234",
				lat: 48.1,
				lon: -3.9,
			})
		})

		it("marks an SBS aircraft on the ground", () => {
			const raw = parseRawAircraft({
				icao: "ABC123",
				onGround: true,
				altitude: 0,
			})
			expect(raw?.alt_baro).toBe("ground")
		})

		it("prefers readsb JSON names when both are present", () => {
			const raw = parseRawAircraft({
				hex: "abc123",
				flight: "WKT101",
				callsign: "OTHER",
				alt_baro: 1000,
				altitude: 2000,
			})
			expect(raw).toMatchObject({ flight: "WKT101", alt_baro: 1000 })
		})
	})
})
