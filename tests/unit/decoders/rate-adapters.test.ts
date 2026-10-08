/**
 * Rate model B1: per-instance adapter truth and declarations.
 * Spec: docs/superpowers/specs/2026-10-08-rate-model-instances-and-suspension.md §1-2, §6
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import pino from "pino"
import { ConfigValidationError } from "@wavekit/shared"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import {
	LoraMeshtasticDecoder,
	PRESET_TABLE,
	type LoraPreset,
} from "../../../src/decoders/builtin/lora-meshtastic.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { assessDecoderRate } from "../../../src/decoders/rate-resolver.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderConfig,
	DecoderRateRequirements,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const RATES = [2_400_000, 2_048_000, 1_024_000, 240_000, 20_000]

function config(type: string, options: Record<string, unknown>): DecoderConfig {
	return { id: type, type, enabled: true, options }
}
function pipeline(decoder: Decoder): string {
	return (decoder as unknown as { getArgs(): string[] }).getArgs().join(" ")
}
function assess(decoder: Decoder, sampleRateHz: number) {
	const adapter = decoder.getRateAdapter?.({ sampleRateHz })
	return assessDecoderRate(decoder.getRateRequirements?.(), {
		source: { kind: "iq", rateHz: sampleRateHz },
		...(adapter ? { adapter } : {}),
	})
}

const audio = [
	{
		name: "multimon-ng",
		make: () =>
			new MultimonDecoder(
				config("multimon-ng", { modes: ["POCSAG1200"] }),
				logger,
			),
		demod: 48_000,
		stdin: { format: "s16le", rateHz: 22_050 },
	},
	{
		name: "direwolf",
		make: () =>
			new DirewolfDecoder(config("direwolf", { audioDevice: "stdin" }), logger),
		demod: 48_000,
		stdin: { format: "s16le", rateHz: 48_000 },
	},
	{
		name: "dsd-fme",
		make: () => new DsdFmeDecoder(config("dsd-fme", { mode: "dmr" }), logger),
		demod: 48_000,
		stdin: { format: "wav-s16le", rateHz: 48_000 },
	},
	{
		name: "acarsdec",
		make: () =>
			new AcarsdecDecoder(
				config("acarsdec", { frequencies: [131_550_000] }),
				logger,
			),
		demod: 24_000,
		stdin: { format: "s16le", rateHz: 12_000 },
	},
] as const

describe("audio-demod adapters (integer decimation)", () => {
	for (const instance of audio) {
		for (const fs of RATES) {
			it(`${instance.name} at ${fs} Hz reports what its pipeline runs`, () => {
				const decoder = instance.make()
				const k = Math.max(1, Math.round(fs / instance.demod))
				expect(decoder.getRateAdapter?.({ sampleRateHz: fs })).toEqual({
					adaptation: "integer-decimation",
					frontendRateHz: fs / k,
					decoderInputKind: "audio_pcm",
					decoderInputRateHz: instance.stdin.rateHz,
					decoderInputFormat: instance.stdin.format,
				})
				decoder.updateOptions({ inputSampleRate: fs })
				const command = pipeline(decoder)
				expect(command).toContain(`csdr firdecimate ${k} `)
				expect(command).not.toMatch(/firdecimate 0|Infinity|NaN/)
				if (fs / k !== instance.stdin.rateHz || instance.name === "dsd-fme") {
					expect(command).toContain(`sox -t raw -r ${fs / k} `)
					expect(command).toContain(`-r ${instance.stdin.rateHz} -`)
				}
			})
		}

		it(`${instance.name} is unusable below its demod rate (implementation basis)`, () => {
			const decoder = instance.make()
			expect(assess(decoder, instance.demod - 1)).toMatchObject({
				verdict: "unusable",
				reasonCode: "insufficient-sample-rate",
				requiredMinimumHz: instance.demod,
				requirementBasis: "implementation",
			})
			expect(assess(decoder, instance.demod).verdict).toBe("acceptable")
			expect(assess(decoder, 2_400_000).verdict).toBe("best")
			expect(assess(decoder, 2_048_000).verdict).toBe("acceptable")
		})
	}

	it("never builds firdecimate 0 below half the demod rate (regression: acarsdec crash loop)", () => {
		// round(10000 / 24000) === 0: the unclamped factor gave firdecimate 0 and sox -r Infinity.
		const decoder = new AcarsdecDecoder(
			config("acarsdec", {
				frequencies: [131_550_000],
				inputSampleRate: 10_000,
			}),
			logger,
		)
		expect(pipeline(decoder)).toContain("csdr firdecimate 1 ")
		expect(pipeline(decoder)).toContain("-r 10000 ")
	})
})

describe("IQ adapters", () => {
	it.each(RATES)("ais-catcher resamples exactly to 384 kHz from %i Hz", fs => {
		const decoder = new AisCatcherDecoder(config("ais-catcher", {}), logger)
		expect(decoder.getRateAdapter?.({ sampleRateHz: fs })).toEqual({
			adaptation: "resample",
			frontendRateHz: 384_000,
			decoderInputKind: "iq",
			decoderInputRateHz: 384_000,
			decoderInputFormat: "cu8",
		})
		decoder.updateOptions({ inputSampleRate: fs })
		expect(pipeline(decoder)).toContain(`-r ${fs} -`)
		expect(pipeline(decoder)).toContain("rate -h 384000")
		expect(pipeline(decoder)).toContain("-s 384000")
		expect(assess(decoder, fs)).toMatchObject({
			verdict: "unknown",
			sourceRateHz: fs,
			frontendRateHz: 384_000,
			decoderInputRateHz: 384_000,
		})
	})

	it.each(RATES)("dumpvdl2 resamples exactly to its target from %i Hz", fs => {
		const decoder = new Dumpvdl2Decoder(
			config("dumpvdl2", { frequencies: [136_975_000] }),
			logger,
		)
		expect(decoder.getRateAdapter?.({ sampleRateHz: fs })).toEqual({
			adaptation: "resample",
			frontendRateHz: 1_050_000,
			decoderInputKind: "iq",
			decoderInputRateHz: 1_050_000,
			decoderInputFormat: "u8",
		})
		decoder.updateOptions({ inputSampleRate: fs })
		expect(pipeline(decoder)).toContain(`-r ${fs} -`)
		expect(pipeline(decoder)).toContain("rate -h 1050000")
		expect(pipeline(decoder)).toContain("--oversample 10")
		expect(assess(decoder, fs).verdict).toBe("unknown")
		expect(assess(decoder, fs).decoderInputRateHz).toBe(1_050_000)
	})

	it.each(RATES)("rtl_433 decimates by an integer from %i Hz", fs => {
		const decoder = new Rtl433Decoder(config("rtl433", {}), logger)
		const k = Math.max(1, Math.round(fs / 1_000_000))
		expect(decoder.getRateAdapter?.({ sampleRateHz: fs })).toEqual({
			adaptation: k === 1 ? "none" : "integer-decimation",
			frontendRateHz: fs / k,
			decoderInputKind: "iq",
			decoderInputRateHz: fs / k,
			decoderInputFormat: "cu8",
		})
		decoder.updateOptions({ inputSampleRate: fs })
		expect(pipeline(decoder)).toContain(`-s ${fs / k}`)
		if (k > 1) expect(pipeline(decoder)).toContain(`csdr firdecimate ${k} `)
		else expect(pipeline(decoder)).not.toContain("csdr")
		expect(assess(decoder, fs)).toMatchObject({
			verdict: "unknown",
			sourceRateHz: fs,
			decoderInputRateHz: fs / k,
		})
	})

	it("rtl_433 honours a 250 kHz target with the actual integer rate", () => {
		const decoder = new Rtl433Decoder(
			config("rtl433", { targetSampleRate: 250_000 }),
			logger,
		)
		expect(
			decoder.getRateAdapter?.({ sampleRateHz: 2_048_000 })?.frontendRateHz,
		).toBe(256_000)
		expect(
			decoder.getRateAdapter?.({ sampleRateHz: 2_400_000 })?.frontendRateHz,
		).toBe(240_000)
	})

	it.each(Object.keys(PRESET_TABLE) as LoraPreset[])(
		"lora-meshtastic %s is unusable below its bandwidth and best at bw x os",
		preset => {
			const decoder = new LoraMeshtasticDecoder(
				config("lora-meshtastic", {
					region: "EU_868",
					preset,
					frequency: 869_525_000,
					channelKey: "AQ==",
				}),
				logger,
			)
			const bw = PRESET_TABLE[preset].bw
			const target = bw * 8
			expect(assess(decoder, bw - 1)).toMatchObject({
				verdict: "unusable",
				reasonCode: "insufficient-sample-rate",
				requiredMinimumHz: bw,
				requirementBasis: "implementation",
			})
			expect(assess(decoder, bw).verdict).toBe("acceptable")
			expect(assess(decoder, target)).toMatchObject({
				verdict: "best",
				adaptation: "none",
			})
			expect(assess(decoder, 2_400_000).verdict).toBe("acceptable")
			decoder.updateOptions({ inputSampleRate: 1_024_000 })
			expect(pipeline(decoder)).toContain(`--samp-rate ${target}`)
		},
	)

	it.each(RATES)("readsb stdin resamples to 2.4 Msps from %i Hz", fs => {
		const decoder = new ReadsbDecoder(
			config("readsb", { outputFormat: "sbs" }),
			logger,
		)
		expect(decoder.getRateAdapter?.({ sampleRateHz: fs })).toEqual({
			adaptation: fs === 2_400_000 ? "none" : "resample",
			frontendRateHz: 2_400_000,
			decoderInputKind: "iq",
			decoderInputRateHz: 2_400_000,
			decoderInputFormat: "uc8",
		})
		decoder.updateOptions({ inputSampleRate: fs })
		if (fs === 2_400_000) expect(pipeline(decoder)).not.toContain("sox")
		else expect(pipeline(decoder)).toContain(`-r ${fs} -`)
		expect(assess(decoder, fs)).toMatchObject({
			verdict: "unknown",
			sourceRateHz: fs,
			frontendRateHz: 2_400_000,
		})
	})

	it("readsb in rtlTcpHost mode owns its input: external, never fanned out", () => {
		const decoder = new ReadsbDecoder(
			config("readsb", { outputFormat: "sbs", rtlTcpHost: "pi.local" }),
			logger,
		)
		expect(decoder.caps.input).toBe("external")
		expect(decoder.getRateAdapter?.({ sampleRateHz: 2_048_000 })).toBe(
			undefined,
		)
		expect(
			assessDecoderRate(decoder.getRateRequirements?.(), {
				source: { kind: "iq", rateHz: 2_048_000 },
			}),
		).toMatchObject({ verdict: "unknown", reasonCode: "external-input" })
	})
})

describe("declaration validation", () => {
	const invalid = {
		version: 1,
		sourceKind: "iq",
		capture: {
			accepted: [{ kind: "range", minHz: 48_000 }],
			preferredHz: [10],
		},
		decoderInput: { kind: "iq" },
	} as DecoderRateRequirements
	const caps: DecoderCaps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	}

	it("rejects invalid type declarations at register", () => {
		const registry = new DecoderRegistry()
		expect(() =>
			registry.register("bad", vi.fn(), { ...caps, rateRequirements: invalid }),
		).toThrow(ConfigValidationError)
		expect(registry.has("bad")).toBe(false)
	})

	it("rejects invalid instance declarations at create", () => {
		const registry = new DecoderRegistry()
		registry.register(
			"bad",
			cfg => {
				const decoder = new MultimonDecoder(
					{ ...cfg, options: { modes: ["POCSAG1200"] } },
					logger,
				)
				Object.assign(decoder, { getRateRequirements: () => invalid })
				return decoder
			},
			caps,
		)
		const manager = new DecoderManager(
			registry,
			new FanoutManager(logger),
			logger,
			{ validateVersions: false },
		)
		try {
			expect(() => manager.createDecoder(config("bad", {}))).toThrow(
				ConfigValidationError,
			)
			expect(manager.getStatus("bad")).toBeUndefined()
		} finally {
			void manager.destroy()
		}
	})
})

class FakeSources extends EventEmitter {
	constructor(public caps: SourceCaps) {
		super()
	}
	getAllStatus() {
		return [{ id: "rtl", connected: true }]
	}
	getStatus(id: string) {
		return id === "rtl" ? { id, connected: true } : undefined
	}
	getCaps(id: string) {
		return id === "rtl" ? this.caps : undefined
	}
	getStream() {
		return new PassThrough()
	}
	assignDecoder() {}
	unassignDecoder() {}
}

describe("cached instance rate plan in manager status", () => {
	it("reports the instance plan and refreshes it on caps changes without spawning", async () => {
		const registry = new DecoderRegistry()
		registry.register("multimon-ng", cfg => new MultimonDecoder(cfg, logger), {
			input: "iq",
			output: "text",
			integrationPattern: "pure_consumer",
		})
		const caps: SourceCaps = {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 2_400_000,
			exclusive: false,
		}
		const sources = new FakeSources(caps)
		const manager = new DecoderManager(
			registry,
			new FanoutManager(logger),
			logger,
			{ validateVersions: false },
		)
		manager.setSourceManager(sources as unknown as SourceManager)
		try {
			manager.createDecoder(config("multimon-ng", { modes: ["POCSAG1200"] }))
			expect(manager.getStatus("multimon-ng")?.rateAssessment).toMatchObject({
				verdict: "best",
				sourceRateHz: 2_400_000,
				frontendRateHz: 48_000,
				decoderInputRateHz: 22_050,
			})
			sources.caps = { ...caps, sampleRate: 20_000 }
			sources.emit("caps-changed", "rtl", sources.caps)
			await vi.waitFor(() =>
				expect(manager.getStatus("multimon-ng")?.rateAssessment).toMatchObject({
					verdict: "unusable",
					reasonCode: "insufficient-sample-rate",
				}),
			)
			expect(manager.getStatus("multimon-ng")?.running).toBe(false)
			sources.emit("removed", "rtl")
			await vi.waitFor(() =>
				expect(manager.getStatus("multimon-ng")?.rateAssessment).toMatchObject({
					verdict: "unknown",
					reasonCode: "source-rate-unknown",
				}),
			)
		} finally {
			await manager.destroy()
		}
	})
})
