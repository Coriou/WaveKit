import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	MESH_POSITION_MAX_B64,
	meshPosition,
	presentMeshtastic,
} from "../../../../../src/core/activity/presentation/meshtastic.js"
import { MeshTracker } from "../../../../../src/core/mesh-tracker.js"
import {
	encodePosition,
	meshPacket,
} from "../../../../mocks/fixtures/meshtastic/encode.js"

const FROM = 0xabcdef12
const NODE = "!abcdef12"

function positionPacket(payloadB64: string, portnum = 3) {
	return { ...meshPacket({ from: FROM, portnum }), payloadB64 }
}

function b64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64")
}

const VALID = b64(
	encodePosition({
		latitudeI: 511_234_567,
		longitudeI: -1_234_567,
		altitudeM: 75,
	}),
)

describe("Meshtastic position (req 4.4)", () => {
	it("decodes lat, lon and altM from a portnum 3 payload", () => {
		const view = presentMeshtastic(positionPacket(VALID))
		expect(view?.position).toEqual({
			lat: 51.1234567,
			lon: -0.1234567,
			altM: 75,
		})
		expect(view?.title).toBe(`${NODE} Position`)
		expect(view?.entityKey).toBe(`node:${NODE}`)
	})

	it("omits altM out of range or absent, keeps lat/lon", () => {
		for (const altitudeM of [50_001, -501, undefined]) {
			const payload = b64(
				encodePosition({
					latitudeI: 100_000_000,
					longitudeI: 200_000_000,
					altitudeM,
				}),
			)
			expect(presentMeshtastic(positionPacket(payload))?.position).toEqual({
				lat: 10,
				lon: 20,
			})
		}
		const edge = b64(
			encodePosition({ latitudeI: 1, longitudeI: 1, altitudeM: 50_000 }),
		)
		expect(meshPosition(3, edge)?.altM).toBe(50_000)
	})

	it("accepts a 344-character payload (256 bytes) at the bound", () => {
		const head = encodePosition({
			latitudeI: 100_000_000,
			longitudeI: 200_000_000,
		})
		// Field 15 (unknown, length-delimited) pads to exactly 256 bytes.
		const padLen = 256 - head.length - 3
		const bytes = Uint8Array.from([
			...head,
			(15 << 3) | 2,
			0x80 | (padLen & 0x7f),
			padLen >> 7,
			...new Uint8Array(padLen),
		])
		expect(bytes.length).toBe(256)
		const text = b64(bytes)
		expect(text.length).toBe(MESH_POSITION_MAX_B64)
		expect(meshPosition(3, text)).toEqual({ lat: 10, lon: 20 })
	})

	it("fails closed on every hostile payload without throwing", () => {
		const bytes257 = new Uint8Array(257)
		bytes257.set(encodePosition({ latitudeI: 100_000_000, longitudeI: 1 }))
		const cases: Array<[string, unknown]> = [
			["empty", ""],
			["345 chars", "A".repeat(345)],
			["348 chars", "AAAA".repeat(87)],
			["257 bytes", b64(bytes257)],
			["unpadded", "QQ"],
			["trailing garbage", `${VALID}!`],
			["trailing quad", `${VALID}A`],
			["= in the middle", `${VALID.slice(0, 4)}=AAA${VALID.slice(8)}`],
			["non-canonical bits", "QR=="],
			["url alphabet", VALID.replace(/./, "-")],
			["whitespace", ` ${VALID.slice(1)}`],
			[
				"truncated",
				b64(encodePosition({ latitudeI: 100_000_000 }).subarray(0, 3)),
			],
			[
				"wrong wire type",
				b64(Uint8Array.from([(1 << 3) | 0, 5, (2 << 3) | 0, 5])),
			],
			[
				"(0, 0)",
				b64(encodePosition({ latitudeI: 0, longitudeI: 0, altitudeM: 10 })),
			],
			["no lat/lon", b64(encodePosition({ altitudeM: 10 }))],
			[
				"lat 91",
				b64(encodePosition({ latitudeI: 910_000_000, longitudeI: 1 })),
			],
			[
				"lon 181",
				b64(encodePosition({ latitudeI: 1, longitudeI: 1_810_000_000 })),
			],
			["number", 42],
			["null", null],
		]
		for (const [name, payloadB64] of cases) {
			const packet = { ...meshPacket({ from: FROM, portnum: 3 }), payloadB64 }
			let view: ReturnType<typeof presentMeshtastic>
			expect(() => (view = presentMeshtastic(packet)), name).not.toThrow()
			expect(view, name).toBeDefined()
			expect(view?.position, name).toBeUndefined()
			expect(view?.title, name).toBe(`${NODE} Position`)
			expect(view?.entityKey, name).toBe(`node:${NODE}`)
		}
	})

	it("has no position for another port carrying a valid Position payload", () => {
		const view = presentMeshtastic(positionPacket(VALID, 4))
		expect(view?.position).toBeUndefined()
		expect(view?.title).toBe(`${NODE} Node info`)
		expect(meshPosition("3", VALID)).toBeUndefined()
	})
})

function trackerPosition(payloadB64: string) {
	const tracker = new MeshTracker({}, pino({ level: "silent" }))
	tracker.processPacket(
		"mesh",
		positionPacket(payloadB64),
		new Date("2026-06-15T12:00:00Z"),
	)
	const position = tracker.get(NODE)?.position ?? null
	if (!position) return undefined
	return { lat: position.lat, lon: position.lon, altitudeM: position.altitudeM }
}

describe("mesh position property", () => {
	// Feature: web-gaps-5, Property 5: Mesh position agreement
	// Validates: Requirements 4.4, 4.6
	it("agrees with the mesh tracker on any Position payload of at most 256 bytes", () => {
		const coord = (limit: number) =>
			fc.oneof(
				fc.integer({ min: -limit, max: limit }),
				fc.integer({ min: -0x80000000, max: 0x7fffffff }),
				fc.constant(0),
			)
		const position = fc
			.record(
				{
					latitudeI: coord(900_000_000),
					longitudeI: coord(1_800_000_000),
					altitudeM: fc.oneof(
						fc.integer({ min: -1_000, max: 60_000 }),
						fc.integer({ min: -0x80000000, max: 0x7fffffff }),
					),
					timeS: fc.integer({ min: 0, max: 0xffffffff }),
				},
				{ requiredKeys: [] },
			)
			.map(fields => encodePosition(fields))
		const raw = fc.uint8Array({ maxLength: 256 })
		fc.assert(
			fc.property(fc.oneof(position, raw), bytes => {
				const text = b64(bytes)
				const presented = presentMeshtastic(positionPacket(text))?.position
				const tracked = trackerPosition(text)
				if (tracked === undefined) {
					expect(presented).toBeUndefined()
					return
				}
				expect(presented).toBeDefined()
				expect(presented?.lat).toBe(tracked.lat)
				expect(presented?.lon).toBe(tracked.lon)
				const alt = tracked.altitudeM
				const want =
					alt !== null && alt >= -500 && alt <= 50_000 ? alt : undefined
				expect(presented?.altM).toBe(want)
			}),
			{ numRuns: 300 },
		)
	})

	it("any other payloadB64 yields no position without throwing", () => {
		const base64ish = fc.string({
			unit: fc.constantFrom(..."ABCQRaz09+/=-_ !".split("")),
			maxLength: 400,
		})
		fc.assert(
			fc.property(fc.oneof(base64ish, fc.string({ maxLength: 400 })), text => {
				const canonical =
					text.length > 0 &&
					text.length <= MESH_POSITION_MAX_B64 &&
					/^[A-Za-z0-9+/]*={0,2}$/.test(text) &&
					text.length % 4 === 0 &&
					Buffer.from(text, "base64").toString("base64") === text
				let view: ReturnType<typeof presentMeshtastic>
				expect(
					() => (view = presentMeshtastic(positionPacket(text))),
				).not.toThrow()
				expect(view).toBeDefined()
				if (!canonical) expect(view?.position).toBeUndefined()
			}),
			{ numRuns: 300 },
		)
	})
})
