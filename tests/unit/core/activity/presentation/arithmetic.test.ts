import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import { openStore, roots, stores } from "../storage/helpers.js"
import { decoderOutput, presentationGrowth } from "./measure.js"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

const ROWS = 5_000
const LIMITS = {
	positionCoalesceMs: 0,
	globalRatePerSec: 1_000_000,
	globalBurst: 1_000_000,
	decoderRatePerSec: 100_000,
	decoderBurst: 1_000_000,
	queueMaxItems: 20_000,
	queueMaxBytes: 64 * 1024 * 1024,
	batchMaxItems: 250,
	batchMaxBytes: 8 * 1024 * 1024,
	batchWindowMs: 60_000,
	maxRows: 20_000,
	maxDbBytes: 64 * 1024 * 1024,
}

function fixture(index: number): DecoderOutput {
	const slot = index % 20
	if (slot < 14) {
		const icao = (index % 0x1000000).toString(16).padStart(6, "0")
		return decoderOutput(
			"aircraft",
			{
				icao,
				altitude: 35_000,
				lat: 51 + (index % 40) / 100,
				lon: -0.1,
				lastSeen: "2026-10-13T00:00:00.000Z",
				messageCount: 1 + (index % 5),
			},
			"readsb",
		)
	}
	if (slot < 16) {
		return decoderOutput(
			"aircraft",
			{
				icao: "a1b2c3",
				callsign: "UAL123",
				squawk: "7000",
				altitude: 35_000,
				gs: 430,
				track: 270,
				baro_rate: -128,
				lat: 40.64,
				lon: -73.78,
			},
			"readsb",
		)
	}
	if (slot < 18) {
		return decoderOutput(
			"ship",
			{
				mmsi: "244660000",
				messageType: 19,
				name: "EVER GIVEN",
				callsign: "3EVE4",
				sog: 12.4,
				cog: 81,
				shipType: 70,
				lat: 51.95,
				lon: 4.14,
			},
			"ais",
		)
	}
	if (slot === 18) {
		return decoderOutput(
			"aprs",
			{
				source: "N0CALL-1",
				dataType: "Position",
				lat: 51.5,
				lon: -0.12,
				comment: "mobile",
				symbol: "/>",
				course: 40,
				speed: 18,
			},
			"direwolf",
		)
	}
	return decoderOutput(
		"message",
		{
			protocol: "POCSAG1200",
			address: 1_234_567,
			function: 0,
			messageType: "alpha",
			message: "test page",
		},
		"pocsag",
	)
}

function bucket(index: number): string {
	const slot = index % 20
	if (slot < 14) return "adsb-position"
	if (slot < 16) return "adsb-full"
	if (slot < 18) return "ais"
	if (slot === 18) return "aprs"
	return "page"
}

function asEnvelope(
	output: DecoderOutput,
	index: number,
	presented: boolean,
): DecodeEnvelope {
	const context = {
		eventId: `evt-${index}`,
		receivedAt: new Date(Date.parse("2026-10-13T00:00:00.000Z") + index),
		decoderId: output.decoder,
		decoderType: "measure",
		provenance: { sourceId: null, frequency: null },
	}
	if (!presented) return createDecodeEnvelope(output, context)
	const view = presentDecoderOutput(output, "measure")
	return view === undefined
		? createDecodeEnvelope(output, context)
		: createDecodeEnvelope(output, context, view)
}

describe("presentation built-row and on-disk arithmetic", () => {
	it("keeps 1.6 growth within 240 bytes and any reception within 1100", () => {
		const bounds: Array<[string, DecoderOutput, number]> = [
			[
				"adsb-position",
				decoderOutput("aircraft", {
					icao: "abc123",
					altitude: 35_000,
					lat: 51.5,
					lon: 4.2,
					lastSeen: "2026-10-13T00:00:00.000Z",
					messageCount: 4,
				}),
				240,
			],
			[
				"ais-position",
				decoderOutput("ship", {
					mmsi: "244660000",
					messageType: 1,
					lat: 51,
					lon: 4,
					cog: 10,
					sog: 12,
				}),
				240,
			],
			[
				"aprs-position",
				decoderOutput("aprs", {
					source: "N0CALL",
					destination: "APRS",
					dataType: "Position",
					lat: 51,
					lon: 4,
					course: 90,
					speed: 12,
					raw: "!call",
				}),
				240,
			],
			[
				"mesh-position",
				decoderOutput("meshtastic", {
					from: 42,
					to: 0xffffffff,
					portnum: 3,
					hopLimit: 3,
					payloadB64: "AA==",
					rxRssi: -90,
					rxSnr: 8,
				}),
				240,
			],
			[
				"adsb-full",
				decoderOutput("aircraft", {
					icao: "a1b2c3",
					callsign: "UNITED123",
					squawk: "7700",
					altitude: 35_000,
					gs: 430,
					track: 270,
					baro_rate: -64,
					lat: 40.6,
					lon: -73.7,
				}),
				1_100,
			],
			[
				"aprs-short",
				decoderOutput("aprs", {
					source: "N0CALL",
					objectName: "BALLOON".padEnd(70, "X"),
					objectKind: "object",
					dataType: "Object",
					symbol: "/>",
					comment: "c".repeat(400),
					message: "m".repeat(400),
					course: 180,
					speed: 12,
					lat: 51.25,
					lon: -0.5,
				}),
				1_100,
			],
			[
				"aprs-long",
				decoderOutput("aprs", {
					source: "N0CALL",
					objectName: "BALLOON".padEnd(70, "X"),
					objectKind: "object",
					dataType: "Object",
					symbol: "/>",
					comment: "c".repeat(4_000),
					message: "m".repeat(4_000),
					course: 180,
					speed: 12,
					lat: 51.25,
					lon: -0.5,
				}),
				1_100,
			],
			[
				"page-worst",
				decoderOutput("message", {
					protocol: "POCSAG1200",
					address: "9".repeat(40),
					function: 0,
					messageType: "alphanumeric",
					message: "p".repeat(4_000),
				}),
				1_100,
			],
			[
				"acars-worst",
				decoderOutput("acars", {
					tail: `N${"1".repeat(40)}`,
					flight: "UA100",
					label: "H1",
					text: "t".repeat(4_000),
				}),
				1_100,
			],
			[
				"vdl2-worst",
				decoderOutput("vdl2", {
					tail: `G${"A".repeat(40)}`,
					flight: "BA100",
					label: "H1",
					msgType: "ATS",
					text: "t".repeat(4_000),
				}),
				1_100,
			],
		]
		const measured = bounds.map(([name, output, limit]) => {
			const growth = presentationGrowth(output)
			return { name, ...growth, limit }
		})
		for (const row of measured)
			expect(row.growth).toBeLessThanOrEqual(row.limit)
	})

	it("measures on-disk bytes for 5000 mixed rows with and without presentation", async () => {
		const plainEnvelopes: DecodeEnvelope[] = []
		const presentedEnvelopes: DecodeEnvelope[] = []
		for (let index = 0; index < ROWS; index++) {
			const output = fixture(index)
			const name = bucket(index)
			const growth = presentationGrowth(output)
			plainEnvelopes.push(asEnvelope(output, index, false))
			presentedEnvelopes.push(asEnvelope(output, index, true))
			expect(growth.growth).toBeLessThanOrEqual(
				name === "adsb-position" ? 240 : 1_100,
			)
		}
		const empty = await openStore({ limits: LIMITS })
		const emptyStats = empty.stats()
		await empty.close()
		async function load(envelopes: readonly DecodeEnvelope[]) {
			const store = await openStore({ limits: LIMITS })
			let rejected = 0
			for (const envelope of envelopes) {
				const result = store.admit(envelope)
				if (!result.admitted) rejected++
			}
			await store.close()
			const stats = store.stats()
			return {
				rejected,
				dbBytes: stats.dbBytes,
				walBytes: stats.walBytes,
				rows: stats.rows,
			}
		}
		const plain = await load(plainEnvelopes)
		const presented = await load(presentedEnvelopes)
		expect(plain.dbBytes).toBeGreaterThan(emptyStats.dbBytes)
		expect(plain.rejected).toBe(0)
		expect(presented.rejected).toBe(0)
		expect(plain.rows).toBe(ROWS)
		expect(presented.rows).toBe(ROWS)
		expect(presented.dbBytes).toBeGreaterThan(plain.dbBytes)
	}, 60_000)
})
