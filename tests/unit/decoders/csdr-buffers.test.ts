import { describe, expect, it, afterEach } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	CSDR_BUFFER_ENV,
	DISABLED_CSDR_BUFFER_POLICY,
	boundCsdrStage,
	boundCsdrStages,
	configureCsdrBuffers,
	csdrChildEnv,
	firDecimateMinimumElements,
	getCsdrBufferPolicy,
} from "../../../src/decoders/csdr-buffers.js"
import { CsdrConfigSchema, loadConfig } from "../../../src/config.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"

const on = { enabled: true, elements: 65536 } as const
const prefix = `${CSDR_BUFFER_ENV}=65536 `
const logger = pino({ level: "silent" })

afterEach(() => configureCsdrBuffers(DISABLED_CSDR_BUFFER_POLICY))

describe("csdr bounded ring policy (stage builder)", () => {
	it("leaves every stage untouched when disabled", () => {
		for (const stage of [
			"csdr convert -i char -o float",
			"csdr firdecimate 45 0.05",
			"csdr fmdemod",
		]) {
			expect(boundCsdrStage(stage, DISABLED_CSDR_BUFFER_POLICY)).toBe(stage)
		}
	})

	it("bounds the harness-validated streaming stages", () => {
		for (const stage of [
			"csdr convert -i char -o float",
			"csdr convert -i s16 -o float",
			"csdr convert -i float -o char",
			"csdr convert -i float -o s16",
			"csdr firdecimate 45 0.05",
			"csdr firdecimate 200 0.012 --cutoff 0.4",
			"csdr fmdemod",
			"csdr amdemod",
			"csdr agc -f float -p fast -r 0.8",
			"csdr agc -f complex -p slow -r 0.7",
			"csdr dcblock",
			"csdr gain 3",
			"csdr limit",
			"csdr realpart",
		]) {
			expect(boundCsdrStage(stage, on)).toBe(prefix + stage)
		}
	})

	it("keeps upstream defaults for stages the harness does not size", () => {
		for (const stage of [
			"csdr lowpass -f float 0.0625",
			"csdr bandpass --fft --low 0.0000 --high 0.1000 0.05",
			"csdr deemphasis 48000",
			"csdr deemphasis --nfm 48000",
			"csdr deemphasis --wfm 48000 0.00005",
			"csdr fft 4096 4096",
			"csdr shift 0.1",
			"csdr --async firdecimate 45 0.05",
			"csdr --async convert -i char -o float",
			"sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -",
			"tee /tmp/debug.raw",
			"rtl_433 -r cu8:-",
		]) {
			expect(boundCsdrStage(stage, on)).toBe(stage)
		}
	})

	it("matches the native firdecimate minimum (float transition, odd taps, read batch)", () => {
		// ceil(4/float(0.05)) = 80 → +1 +45 +1024
		expect(firDecimateMinimumElements(45, 0.05)).toBe(1150)
		// ceil(4/float(0.012)) = 334 → +1 +200 +1024
		expect(firDecimateMinimumElements(200, 0.012)).toBe(1559)
		expect(firDecimateMinimumElements(0, 0.05)).toBeNull()
		expect(firDecimateMinimumElements(45, 0)).toBeNull()
		expect(firDecimateMinimumElements(45, Number.NaN)).toBeNull()
	})

	it("falls back to the upstream ring when the configured ring is below a FIR's minimum", () => {
		const small = { enabled: true, elements: 2048 }
		expect(boundCsdrStage("csdr firdecimate 45 0.05", small)).toBe(
			`${CSDR_BUFFER_ENV}=2048 csdr firdecimate 45 0.05`,
		)
		// 4/0.002 = 2000 taps > 2048 - decimation - 1024
		expect(boundCsdrStage("csdr firdecimate 45 0.002", small)).toBe(
			"csdr firdecimate 45 0.002",
		)
		// Unparseable FIR arguments are never bounded.
		expect(boundCsdrStage("csdr firdecimate", on)).toBe("csdr firdecimate")
		expect(boundCsdrStage("csdr firdecimate x 0.05", on)).toBe(
			"csdr firdecimate x 0.05",
		)
	})

	it("only ever prefixes; stage arguments are preserved (property)", () => {
		// Feature: csdr-bounded-buffers, Property 1: prefix-only transformation
		const stage = fc.oneof(
			fc.constantFrom(
				"csdr convert -i char -o float",
				"csdr fmdemod",
				"csdr lowpass -f float 0.1",
				"csdr deemphasis 48000",
				"sox -t raw -",
			),
			fc
				.tuple(
					fc.integer({ min: 1, max: 5000 }),
					fc.double({ min: 0.0005, max: 0.5, noNaN: true }),
				)
				.map(([d, t]) => `csdr firdecimate ${d} ${t}`),
		)
		fc.assert(
			fc.property(
				fc.array(stage, { maxLength: 12 }),
				fc.integer({ min: 2048, max: 10485760 }),
				fc.boolean(),
				(stages, elements, enabled) => {
					const out = boundCsdrStages(stages, { enabled, elements })
					expect(out).toHaveLength(stages.length)
					out.forEach((value, index) => {
						const original = stages[index]!
						const envPrefix = `${CSDR_BUFFER_ENV}=${elements} `
						expect(value === original || value === envPrefix + original).toBe(
							true,
						)
						if (!enabled) expect(value).toBe(original)
					})
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("csdr child environment", () => {
	it("strips an inherited native setting so unlisted stages stay upstream", () => {
		const env = csdrChildEnv({ PATH: "/bin", [CSDR_BUFFER_ENV]: "2048" })
		expect(env).toEqual({ PATH: "/bin" })
	})
})

describe("csdr config schema", () => {
	it("defaults to off with a 65536-element ring", () => {
		expect(CsdrConfigSchema.parse({})).toEqual({
			boundedBuffers: false,
			bufferElements: 65536,
		})
	})

	it("rejects settings the native patch would reject", () => {
		for (const bufferElements of [0, 2047, 10485761, 1.5, -1]) {
			expect(CsdrConfigSchema.safeParse({ bufferElements }).success).toBe(false)
		}
	})

	it("is overridable from the environment", () => {
		const saved = { ...process.env }
		try {
			const dir = mkdtempSync(join(tmpdir(), "wavekit-csdr-config-"))
			const file = join(dir, "config.yaml")
			writeFileSync(file, "logging:\n  level: error\n")
			process.env["WAVEKIT_CSDR__BOUNDED_BUFFERS"] = "true"
			process.env["WAVEKIT_CSDR__BUFFER_ELEMENTS"] = "131072"
			const config = loadConfig(file)
			expect(config.csdr).toEqual({
				boundedBuffers: true,
				bufferElements: 131072,
			})
		} finally {
			process.env = saved
		}
	})
})

function decoderConfig(
	type: string,
	options: Record<string, unknown>,
): DecoderConfig {
	return { id: `${type}-test`, type, enabled: true, options }
}

describe("decoder pipelines honour the process-wide policy", () => {
	const build = (decoder: object): string =>
		(decoder as { buildPipelineCommand(): string }).buildPipelineCommand()

	it("rtl_433 IQ decimation: convert, FIR and convert are bounded", () => {
		const decoder = new Rtl433Decoder(
			decoderConfig("rtl_433", { inputSampleRate: 2_048_000 }),
			logger,
		)
		const legacy = build(decoder)
		configureCsdrBuffers(on)
		expect(getCsdrBufferPolicy()).toEqual(on)
		const bounded = build(decoder)
		expect(bounded.replaceAll(prefix, "")).toBe(legacy)
		expect(bounded).toContain(`${prefix}csdr convert -i char -o float |`)
		expect(bounded).toMatch(
			new RegExp(`${prefix}csdr firdecimate \\d+ 0\\.05 \\|`),
		)
		expect(bounded).toContain(`${prefix}csdr convert -i float -o char |`)
		expect(bounded).not.toContain(`${prefix}rtl_433`)
	})

	it("audio demod chains bound streaming stages but not deemphasis/lowpass", () => {
		for (const decoder of [
			new MultimonDecoder(decoderConfig("multimon-ng", {}), logger),
			new AcarsdecDecoder(decoderConfig("acarsdec", {}), logger),
		]) {
			configureCsdrBuffers(DISABLED_CSDR_BUFFER_POLICY)
			const legacy = build(decoder)
			configureCsdrBuffers(on)
			const bounded = build(decoder)
			expect(bounded.replaceAll(prefix, "")).toBe(legacy)
			for (const stage of bounded.split(" | ")) {
				const unbounded = /^csdr (lowpass|deemphasis|bandpass)/.test(stage)
				if (stage.startsWith("csdr ") || stage.startsWith(prefix)) {
					expect(stage.startsWith(prefix)).toBe(!unbounded)
				}
			}
			expect(bounded).toContain(`${prefix}csdr firdecimate`)
		}
	})

	it("dsd-fme's own pipeline builder is bounded too", () => {
		const decoder = new DsdFmeDecoder(decoderConfig("dsd-fme", {}), logger)
		const legacy = build(decoder)
		configureCsdrBuffers(on)
		const bounded = build(decoder)
		expect(bounded.replaceAll(prefix, "")).toBe(legacy)
		expect(bounded).toContain(`${prefix}csdr firdecimate`)
		expect(bounded).toContain(`${prefix}csdr fmdemod`)
		expect(bounded).toContain(`${prefix}csdr convert -i float -o s16`)
		expect(bounded).not.toContain(`${prefix}sox`)
	})
})
