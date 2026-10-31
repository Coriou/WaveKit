import { describe, expect, it } from "vitest"
import type { DecoderInfo } from "@wavekit/api-types"

import { buildDecoderSummaries } from "../../mock/decoder-summary.ts"
import { BAND_SEEDS, toBand } from "../../mock/data.ts"
import { shouldAutoIdentify } from "../../src/features/tuned/auto-identify.ts"
import {
	bandTable,
	decodersLine,
	parseSummary,
	skipLine,
} from "../../src/features/tuned/band-table.ts"
import {
	decodersHere,
	decodersOnChannel,
} from "../../src/features/tuned/decoders.ts"

const NOW = Date.parse("2026-10-31T10:00:00Z")
/** The card's channel tolerance for a 12.5 kHz channel: max(bandwidth / 2, 3 kHz). */
const TOLERANCE_HZ = 6250
const ISM_HZ = 433_920_000

const status = (
	over: Partial<DecoderInfo> & Pick<DecoderInfo, "id" | "type">,
): DecoderInfo => ({
	running: true,
	health: "running",
	uptime: 600,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
	desiredRunning: true,
	suspended: false,
	mode: "auto",
	owner: "config",
	...over,
})

const rtl433 = status({
	id: "rtl433",
	type: "rtl433",
	targetFrequenciesHz: [ISM_HZ],
	bandAssessment: {
		verdict: "in-band",
		targetsHz: [ISM_HZ],
		basis: "protocol",
	},
})
const readsb = status({
	id: "readsb",
	type: "readsb",
	targetFrequenciesHz: [1_090_000_000],
	bandAssessment: {
		verdict: "in-band",
		targetsHz: [1_090_000_000],
		basis: "protocol",
	},
})

/** What the card computes at `hz`: the band rows, the decoders on the channel, its header line and auto-identify. */
function cardAt(decoders: readonly DecoderInfo[], hz: number) {
	const rows = bandTable(
		parseSummary(buildDecoderSummaries(decoders, NOW, hz)),
		decoders,
		hz,
		{ scanJobId: null, budget: null },
		NOW,
	)
	const here = decodersHere(decoders, new Set(rows.map(r => r.id)), hz)
	const onChannel = decodersOnChannel(here, hz, TOLERANCE_HZ)
	return {
		rows,
		onChannel: onChannel.map(d => d.id),
		line: decodersLine(rows, new Set(onChannel.map(d => d.id))),
		autoIdentify: shouldAutoIdentify({
			enabled: true,
			readOnly: false,
			onIt: true,
			heldByScan: false,
			transmitting: true,
			decodersHere: onChannel.length,
			identifyShown: false,
			known: false,
			triedHz: null,
			hz,
		}),
	}
}

describe("the tuned card decides at the channel, not the band", () => {
	it("an FM carrier at 434.000 MHz inside rtl433's band auto-identifies", () => {
		const card = cardAt([rtl433], 434_000_000)
		// "On this band" still lists ISM: its band holds the frequency
		expect(card.rows.map(r => r.id)).toEqual(["rtl433"])
		expect(card.onChannel).toEqual([])
		expect(card.autoIdentify).toBe(true)
		expect(card.line).toBe(
			"ISM decodes this band, not this channel. Identify finds out what it is.",
		)
	})

	it("on a decoder's fixed target: no auto-identify, and the header names it", () => {
		for (const hz of [ISM_HZ, ISM_HZ + TOLERANCE_HZ]) {
			const card = cardAt([rtl433], hz)
			expect(card.onChannel).toEqual(["rtl433"])
			expect(card.autoIdentify).toBe(false)
			expect(card.line).toBe("Decoded here by ISM. Nothing heard yet.")
		}
		// one hertz past the channel tolerance the carrier is not on its channel
		expect(cardAt([rtl433], ISM_HZ + TOLERANCE_HZ + 1).autoIdentify).toBe(true)
	})

	it("a decoder that only follows the tuner never counts on the channel", () => {
		const vfo = status({
			id: "rtl433",
			type: "rtl433",
			targetFrequenciesHz: [434_000_000],
			placements: [
				{
					sourceId: "rtl-0",
					channelHz: 434_000_000,
					reach: "centre",
					origin: "configured",
					primary: true,
					running: true,
					costCores: 0,
				},
			],
			bandAssessment: {
				verdict: "in-band",
				targetsHz: [ISM_HZ],
				basis: "protocol",
			},
		})
		expect(cardAt([vfo], 434_000_000).autoIdentify).toBe(true)
	})

	it("ADS-B fills its window: anywhere readsb covers is its channel", () => {
		const card = cardAt([readsb], 1_090_062_000)
		expect(card.onChannel).toEqual(["readsb"])
		expect(card.autoIdentify).toBe(false)
		expect(card.line).toBe("Decoded here by ADS-B. Nothing heard yet.")
	})

	it("in the ADS-B band past readsb's reach the header gives the band's skip reason", () => {
		const hz = 1_089_500_000
		const card = cardAt([readsb], hz)
		expect(card.rows).toEqual([])
		expect(card.line).toBeNull()
		const seed = BAND_SEEDS.find(b => b.id === "adsb")!
		const band = toBand(seed)
		expect(band.startHz <= hz && hz <= band.endHz).toBe(true)
		expect(skipLine("raw", band.skip)).toBe("Decoded elsewhere · readsb")
		// only a data band reads its skip reason as the line; a band without a skip has none
		expect(skipLine("wfm", band.skip)).toBeNull()
		expect(skipLine("raw", null)).toBeNull()
	})

	it("the mock's ADS-B band matches the core's: name, bandwidth and skip", () => {
		const band = toBand(BAND_SEEDS.find(b => b.id === "adsb")!)
		expect(band).toMatchObject({
			name: "ADS-B (1090 MHz)",
			startHz: 1_089_000_000,
			endHz: 1_091_000_000,
			mode: "raw",
			bandwidthHz: null,
			stepHz: null,
			skip: { reason: "Decoded elsewhere · readsb" },
		})
	})
})
