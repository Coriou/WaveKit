import { describe, expect, it } from "vitest"
import {
	CAPACITY_MEASUREMENTS,
	CPU_COST,
	DESCRIPTIVE_CAPACITY_COSTS,
	SPEC_COSTS,
	deriveCosts,
	maxChannelProbesFor,
	probeCores,
} from "../../../../src/core/scanner/plan/cost.js"
import { WaveKitError } from "../../../../src/utils/errors.js"

describe("descriptive channelizer cost fit", () => {
	it("fits native cores without a second percent conversion and charges the process base", () => {
		const costs = deriveCosts(CAPACITY_MEASUREMENTS)
		expect(costs.channelBase).toBeCloseTo(0.08, 12)
		expect(costs.nativeBase).toBeCloseTo(0.14, 12)
		expect(costs.nativeBase + costs.channelBase).toBeCloseTo(0.22, 12)
		expect(costs.nativeBase + 8 * costs.channelBase).toBeCloseTo(0.78, 12)
		expect(costs.nativeBase + 4 * costs.channelBase).not.toBeCloseTo(0.56, 2)
		expect(costs).toEqual(DESCRIPTIVE_CAPACITY_COSTS)
	})

	it("keeps provenance and conditional scope explicit", () => {
		expect(CAPACITY_MEASUREMENTS.source).toBe(
			"docs/CAPACITY-2026-10-10-CHANNELIZER.md",
		)
		expect(CAPACITY_MEASUREMENTS.sampleRateHz).toBe(2_048_000)
		expect(CAPACITY_MEASUREMENTS.outputRateHz).toBe(384_000)
		expect(CAPACITY_MEASUREMENTS.scope).toEqual({
			fixture: "AIS",
			playback: "paced",
			placement: "spread",
			cpuQuotaCores: 4,
			hostNoiseCores: 0.3,
			n8Verdict: "conditional",
			n8InputGapPercent: [1.39, 2.04],
			piMeasured: false,
			combinedScannerSustained: false,
		})
		expect(CAPACITY_MEASUREMENTS.decoderCores).toEqual({})
	})

	it("keeps probe decoder estimates distinct from measured values", () => {
		const costs = deriveCosts({
			...CAPACITY_MEASUREMENTS,
			decoderCores: { rtl433: 0.08 },
		})
		expect(costs.decoder).toEqual({ ...SPEC_COSTS.decoder, rtl433: 0.08 })
		expect(costs.decoderBasis.rtl433).toBe("measurement")
		expect(costs.decoderBasis["dsd-fme"]).toBe("estimate")
		expect(DESCRIPTIVE_CAPACITY_COSTS.decoderBasis.rtl433).toBe("estimate")
		expect(costs.engine).toBe(SPEC_COSTS.engine)
		expect(costs.offsetProbe).toBe(SPEC_COSTS.offsetProbe)
	})

	it("preserves existing runtime costing", () => {
		expect(CPU_COST).toEqual({
			engine: 0.08,
			offsetProbe: 0.5,
			channelBase: 0.05,
			decoder: {
				"dsd-fme": 0.045,
				"multimon-ng": 0.03,
				direwolf: 0.05,
				rtl433: 0.1,
				acarsdec: 0.05,
			},
		})
		for (const type of [
			"dsd-fme",
			"multimon-ng",
			"direwolf",
			"rtl433",
		] as const) {
			expect(probeCores("channel", type)).toBe(
				CPU_COST.channelBase + CPU_COST.decoder[type],
			)
			expect(probeCores("offset", type)).toBe(0.5)
		}
		expect(probeCores("channel", "unknown")).toBeCloseTo(0.15)
	})

	it("returns zero when unaffordable and reserves engine, offset and native base", () => {
		const costs = DESCRIPTIVE_CAPACITY_COSTS
		expect(maxChannelProbesFor(0, costs)).toBe(0)
		expect(maxChannelProbesFor(0.5, costs)).toBe(0)
		expect(maxChannelProbesFor(0.8, costs)).toBe(0)
		expect(maxChannelProbesFor(1, costs)).toBe(2)
		expect(maxChannelProbesFor(10, costs)).toBe(8)
		const fixed = costs.engine + costs.offsetProbe + costs.nativeBase
		const per = costs.channelBase + costs.decoder["dsd-fme"]
		expect(maxChannelProbesFor(fixed + per - 1e-6, costs)).toBe(0)
		expect(maxChannelProbesFor(fixed + per + 1e-6, costs)).toBe(1)
	})

	it("rejects invalid measurement numbers, provenance and cost inputs", () => {
		for (const value of [NaN, Infinity, -1]) {
			expect(() =>
				deriveCosts({
					...CAPACITY_MEASUREMENTS,
					nativeProcessCores: { oneChannel: value, eightChannels: 0.78 },
				}),
			).toThrow(WaveKitError)
			expect(() =>
				deriveCosts({
					...CAPACITY_MEASUREMENTS,
					decoderCores: { rtl433: value },
				}),
			).toThrow(WaveKitError)
			expect(() => maxChannelProbesFor(value, SPEC_COSTS)).toThrow(WaveKitError)
			expect(() =>
				maxChannelProbesFor(1, { ...SPEC_COSTS, nativeBase: value }),
			).toThrow(WaveKitError)
		}
		for (const sampleRateHz of [0, -1, 2_048_000.5])
			expect(() =>
				deriveCosts({ ...CAPACITY_MEASUREMENTS, sampleRateHz }),
			).toThrow(WaveKitError)
		expect(() =>
			deriveCosts({ ...CAPACITY_MEASUREMENTS, source: " " }),
		).toThrow(WaveKitError)
		expect(() =>
			deriveCosts({ ...CAPACITY_MEASUREMENTS, outputRateHz: 3_000_000 }),
		).toThrow(WaveKitError)
		expect(() =>
			deriveCosts({
				...CAPACITY_MEASUREMENTS,
				nativeProcessCores: { oneChannel: 1, eightChannels: 0.5 },
			}),
		).toThrow(WaveKitError)
		expect(() =>
			deriveCosts({
				...CAPACITY_MEASUREMENTS,
				nativeProcessCores: { oneChannel: 0.1, eightChannels: 1 },
			}),
		).toThrow(WaveKitError)
		expect(() =>
			maxChannelProbesFor(1, {
				...SPEC_COSTS,
				channelBase: 0,
				decoder: { ...SPEC_COSTS.decoder, "dsd-fme": 0 },
			}),
		).toThrow(WaveKitError)
	})
})
