import { describe, expect, it } from "vitest"
import { decoderCoversHz } from "../../../../src/api/routes/decoder-summary.js"
import { assessDecoderBand } from "../../../../src/decoders/band-resolver.js"
import type { DecoderBandRequirements } from "../../../../src/decoders/band-resolver.js"
import { BAND_REGIONS } from "../../../../src/decoders/band-region.js"
import { LORA_REGION_RANGES_HZ } from "../../../../src/decoders/band-defaults.js"
import {
	CATALOGUE_DEFAULT_OPTIONS,
	catalogueLoraSlots,
} from "../../../../src/decoders/enablement/catalogue.js"
import {
	TUNED_CLUSTER_MAX_GAP_HZ,
	TUNED_TARGET_TOLERANCE_HZ,
	bandContainsTuned,
	clusterHolds,
} from "../../../../src/decoders/enablement/tuned-band.js"
import type { DecoderStatus } from "../../../../src/decoders/types.js"

const REACH = TUNED_TARGET_TOLERANCE_HZ

const lora = (band: DecoderStatus["bandAssessment"]): DecoderStatus => ({
	id: "lora-meshtastic",
	type: "lora-meshtastic",
	running: false,
	health: "running",
	uptime: 0,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
	...(band ? { bandAssessment: band } : {}),
})

/** The catalogue LoRa decoder's targets in a band-plan region: every regional slot, else its one channel. */
function catalogueTargets(region: (typeof BAND_REGIONS)[number]): number[] {
	const options = CATALOGUE_DEFAULT_OPTIONS(region)["lora-meshtastic"]
	const slots = catalogueLoraSlots(options["region"])
	return slots ? slots.map(s => s.frequency) : [options["frequency"] as number]
}

describe("the catalogue LoRa decoder covers only its own regional slots", () => {
	for (const region of BAND_REGIONS) {
		const targets = catalogueTargets(region)
		const status = lora({
			verdict: "out-of-band",
			targetsHz: targets,
			basis: "configured",
		})
		it(`${region}: at each slot's edge and not past it`, () => {
			for (const t of targets) {
				expect(decoderCoversHz(status, t)).toBe(true)
				expect(decoderCoversHz(status, t - REACH)).toBe(true)
				expect(decoderCoversHz(status, t + REACH)).toBe(true)
				expect(decoderCoversHz(status, t - REACH - 1)).toBe(false)
				expect(decoderCoversHz(status, t + REACH + 1)).toBe(false)
			}
		})
	}

	it("EU: the 433 and 869 MHz slots are two bands, not one span between them", () => {
		const status = lora({
			verdict: "out-of-band",
			targetsHz: catalogueTargets("EU"),
			basis: "configured",
		})
		expect(catalogueTargets("EU")).toEqual([869_525_000, 433_875_000])
		// a PMR446 channel, a UHF land mobile frequency and 868 MHz ISM between the slots
		for (const hz of [446_524_920, 446_000_000, 600_000_000, 868_300_000])
			expect(decoderCoversHz(status, hz)).toBe(false)
	})
})

describe("a follow-centre LoRa decoder covers its Meshtastic region's range", () => {
	for (const [region, range] of Object.entries(LORA_REGION_RANGES_HZ)) {
		it(`${region}: at the range edges widened by the reach, not past them`, () => {
			const status = lora({
				verdict: "out-of-band",
				rangesHz: [range],
				basis: "decoder-default",
			})
			expect(decoderCoversHz(status, range.minHz - REACH)).toBe(true)
			expect(decoderCoversHz(status, range.maxHz + REACH)).toBe(true)
			expect(decoderCoversHz(status, range.minHz - REACH - 1)).toBe(false)
			expect(decoderCoversHz(status, range.maxHz + REACH + 1)).toBe(false)
		})
	}

	it("no EU LoRa range holds 446.5 MHz", () => {
		for (const region of ["EU_433", "EU_868"] as const)
			expect(
				decoderCoversHz(
					lora({
						verdict: "out-of-band",
						rangesHz: [LORA_REGION_RANGES_HZ[region]],
						basis: "decoder-default",
					}),
					446_524_920,
				),
			).toBe(false)
	})
})

describe("the tuned-band channel cluster", () => {
	it("still holds the span of a cluster such as VDL2's", () => {
		const vdl2 = [136_650_000, 136_700_000, 136_975_000]
		expect(
			bandContainsTuned({ targetsHz: vdl2, basis: "configured" }, 136_850_000),
		).toBe(true)
	})

	it("joins neighbours at the widest gap and splits them just past it", () => {
		const lo = 100_000_000
		const mid = lo + TUNED_CLUSTER_MAX_GAP_HZ / 2
		expect(clusterHolds([lo, lo + TUNED_CLUSTER_MAX_GAP_HZ], mid, REACH)).toBe(
			true,
		)
		expect(
			clusterHolds([lo, lo + TUNED_CLUSTER_MAX_GAP_HZ + 1], mid, REACH),
		).toBe(false)
	})

	it("holds within each cluster of two separate clusters, never between them", () => {
		const targets = [100_000_000, 101_000_000, 500_000_000, 501_000_000]
		expect(clusterHolds(targets, 100_500_000, REACH)).toBe(true)
		expect(clusterHolds(targets, 500_500_000, REACH)).toBe(true)
		expect(clusterHolds(targets, 300_000_000, REACH)).toBe(false)
	})
})

describe("a follow-centre decoder holds its whole declared span as tuned", () => {
	const ctx = { sampleRateHz: 2_400_000 }
	/** The band the manager resolves, and the status its assessment at `hz` reports to the summary. */
	const follow = (targetsHz: number[]): DecoderBandRequirements => ({
		targetsHz,
		basis: "configured",
		followCenter: true,
	})
	const statusAt = (band: DecoderBandRequirements, hz: number) =>
		lora(assessDecoderBand(band, { ...ctx, centerHz: hz }))

	for (const [region, lo, hi] of [
		["US", 902_000_000, 928_000_000],
		["CN", 470_000_000, 510_000_000],
	] as const) {
		it(`${region}: tuned anywhere between the declared edges and at them, not past them`, () => {
			const band = follow([lo, hi])
			for (const hz of [lo, (lo + hi) / 2, hi, lo - REACH, hi + REACH]) {
				expect(assessDecoderBand(band, { ...ctx, centerHz: hz }).verdict).toBe(
					"in-band",
				)
				expect(bandContainsTuned(band, hz), String(hz)).toBe(true)
				expect(decoderCoversHz(statusAt(band, hz), hz), String(hz)).toBe(true)
			}
			for (const hz of [lo - REACH - 1, hi + REACH + 1]) {
				expect(bandContainsTuned(band, hz), String(hz)).toBe(false)
				expect(decoderCoversHz(statusAt(band, hz), hz), String(hz)).toBe(false)
			}
		})
	}

	it("reports followCenter in the assessment, only when the band follows the centre", () => {
		const centre = { ...ctx, centerHz: 915_000_000 }
		expect(
			assessDecoderBand(follow([902_000_000, 928_000_000]), centre),
		).toMatchObject({ verdict: "in-band", followCenter: true })
		expect(
			assessDecoderBand(
				{ targetsHz: [902_000_000, 928_000_000], basis: "configured" },
				centre,
			),
		).not.toHaveProperty("followCenter")
	})

	it("a follow-centre channel list wider than one cluster gap (dumpvdl2 style) holds its span", () => {
		const targets = [131_525_000, 136_975_000]
		expect(targets[1]! - targets[0]!).toBeGreaterThan(TUNED_CLUSTER_MAX_GAP_HZ)
		const band = follow(targets)
		expect(bandContainsTuned(band, 134_000_000)).toBe(true)
		expect(decoderCoversHz(statusAt(band, 134_000_000), 134_000_000)).toBe(true)
		// The same list without followCenter is two separate channels.
		const fixed = { targetsHz: targets, basis: "configured" as const }
		expect(bandContainsTuned(fixed, 134_000_000)).toBe(false)
		expect(
			decoderCoversHz(lora({ verdict: "in-band", ...fixed }), 134_000_000),
		).toBe(false)
	})

	it("the catalogue EU LoRa decoder (fixed slots) still never holds 446.5 MHz", () => {
		const band = {
			targetsHz: catalogueTargets("EU"),
			basis: "configured" as const,
		}
		expect(bandContainsTuned(band, 446_524_920)).toBe(false)
		expect(decoderCoversHz(statusAt(band, 446_524_920), 446_524_920)).toBe(
			false,
		)
	})
})
