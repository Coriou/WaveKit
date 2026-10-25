import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

afterEach(() => vi.useRealTimers())

it("always skips only the band", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(1_000_000)
	// Feature: decoder-enablement, Property 3: Always skips only the band
	// Validates: Requirements 2.1, 3.9
	await fc.assert(
		fc.asyncProperty(
			fc.record({
				rate: fc.integer({ min: 10_000, max: 2_400_000 }),
				centre: fc.integer({ min: 160_000_000, max: 164_000_000 }),
				unavailable: fc.boolean(),
				held: fc.boolean(),
				gate: fc.boolean(),
			}),
			async facts => {
				const sources = new FakeSources()
				sources.caps.set("rtl", {
					...iqCaps(facts.rate),
					centerFreq: facts.centre,
				})
				const registry = new DecoderRegistry()
				registry.register(
					"rate-test",
					config => {
						const decoder = new RateDecoder(config.id, {
							input: "iq",
							output: "text",
							integrationPattern: "pure_consumer",
						})
						decoder.band = { targetsHz: [162_000_000], basis: "configured" }
						return decoder
					},
					{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
				)
				const logger = pino({ level: "silent" })
				const manager = new DecoderManager(
					registry,
					new FanoutManager(logger),
					logger,
					{
						validateVersions: false,
						enablement: {
							// Built-ins run only through placements; `gate` decides
							// whether the gate admits them.
							planner: () => ({
								wanted: ["always", "auto"].map(id => ({
									key: id + "#raw@rtl",
									decoderId: id,
									sourceId: "rtl",
									channelHz: null,
									reach: "raw" as const,
									origin: "configured" as const,
									primary: true,
									costCores: 0.1,
									sampleRateHz: facts.rate,
								})),
								unplaced: new Map(),
							}),
							gate: {
								record: () => {},
								probation: () => [],
								noteSuspended: () => {},
								forget: () => {},
								view: () => ({
									budgetCores: 0,
									cpuGuardPercent: 90,
									sources: [],
								}),
								admit: () =>
									facts.gate
										? {
												admit: false as const,
												detail: "budget" as const,
												retryAtMs: Date.now() + 300_000,
											}
										: { admit: true as const },
							},
							resolveMode: id => ({
								mode: id === "always" ? "always" : "auto",
								source: "settings",
							}),
							// The gate governs catalogue decoders only (requirement 4.9).
							isCatalogue: () => true,
							unavailable: () => facts.unavailable,
							recheckAvailable: async () => false,
							vfo: () => null,
							bandplanChannels: () => [],
							maxBandplanChannels: 4,
						},
					},
				)
				manager.setSourceManager(sources as unknown as SourceManager)
				try {
					for (const id of ["always", "auto"])
						manager.createDecoder({
							id,
							type: "rate-test",
							enabled: true,
							options: {},
						})
					if (facts.held)
						await manager.holdSource("rtl", "tuner-scanning", "scan")
					await manager.startAll()
					const always = manager.getStatus("always")!
					const auto = manager.getStatus("auto")!
					expect(always.suspension?.reasonCode).not.toBe(
						"frequency-out-of-band",
					)
					if (auto.suspension?.reasonCode !== "frequency-out-of-band")
						expect(always.suspension?.reasonCode).toBe(
							auto.suspension?.reasonCode,
						)
					if (facts.held)
						expect(always.suspension?.reasonCode).toBe("tuner-scanning")
					// 11.3: rate reasons rank above decoder-unavailable.
					else if (facts.rate < 48_000)
						expect(always.suspension?.reasonCode).toBe(
							"insufficient-sample-rate",
						)
					else if (facts.unavailable)
						expect(always.suspension?.reasonCode).toBe("decoder-unavailable")
					else if (facts.gate)
						expect(always.suspension?.reasonCode).toBe("efficiency-budget")
				} finally {
					await manager.destroy()
				}
			},
		),
		{ numRuns: 100 },
	)
})
