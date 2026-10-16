import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { SCANNER_AIS_CHANNEL_HZ } from "@wavekit/api-types"
import {
	resolveAmbientTargets,
	type AmbientTargetDeps,
} from "../../../../src/core/scanner/probes/ambient-target.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"

type OldTarget = {
	sourceId: string
	hz: number
	nxdn?: "nxdn48" | "nxdn96"
}

/**
 * Oracle: ScannerService.ambientTarget at cccf665f
 * (src/core/scanner/scanner-service.ts:3119-3143), with deps inlined.
 */
function oracle(
	cfg: DecoderConfig,
	defaultSourceId: string | null,
	centre: number | undefined,
): OldTarget | null {
	const sourceId = cfg.sourceId ?? defaultSourceId
	if (!sourceId) return null
	const nxdn =
		cfg.type === "dsd-fme"
			? cfg.options["mode"] === "nxdn48"
				? ("nxdn48" as const)
				: ("nxdn96" as const)
			: undefined
	const withNxdn = (hz: number): OldTarget =>
		nxdn ? { sourceId, hz, nxdn } : { sourceId, hz }
	const listed =
		cfg.frequencies?.[0] ??
		(typeof cfg.options["frequency"] === "number"
			? cfg.options["frequency"]
			: undefined)
	if (listed !== undefined) return withNxdn(listed)
	if (centre === undefined) return null
	const offset =
		typeof cfg.options["offsetHz"] === "number" ? cfg.options["offsetHz"] : 0
	return withNxdn(centre + offset)
}

const deps = (
	defaultSourceId: string | null,
	centre: number | undefined,
	external = false,
): AmbientTargetDeps => ({
	defaultSourceId: () => defaultSourceId,
	caps: () => (centre === undefined ? undefined : { centerFreq: centre }),
	inputKind: () => (external ? "external" : "iq"),
})

const cfgOf = (
	type: string,
	extra: Partial<DecoderConfig> = {},
	options: Record<string, unknown> = {},
): DecoderConfig => ({ id: "d1", type, enabled: true, options, ...extra })

describe("resolveAmbientTargets", () => {
	it("equals today's ambientTarget for the existing types", () => {
		const hz = fc.integer({ min: 1, max: 2_000_000_000 })
		fc.assert(
			fc.property(
				fc.constantFrom("dsd-fme", "multimon-ng", "direwolf", "rtl433"),
				fc.option(fc.constantFrom("rtl", "sdrpp"), { nil: undefined }),
				fc.option(fc.constant("dflt"), { nil: null }),
				fc.option(fc.array(hz, { maxLength: 3 }), { nil: undefined }),
				fc.option(fc.oneof(hz, fc.constant("x")), { nil: undefined }),
				fc.option(fc.integer({ min: -50_000, max: 50_000 }), {
					nil: undefined,
				}),
				fc.option(fc.constantFrom("nxdn48", "nxdn96", "dmr"), {
					nil: undefined,
				}),
				fc.option(hz, { nil: undefined }),
				fc.boolean(),
				(type, sourceId, dflt, freqs, freq, offset, mode, centre, ext) => {
					const options: Record<string, unknown> = {}
					if (freq !== undefined) options["frequency"] = freq
					if (offset !== undefined) options["offsetHz"] = offset
					if (mode !== undefined) options["mode"] = mode
					const cfg = cfgOf(
						type,
						{
							...(sourceId !== undefined ? { sourceId } : {}),
							...(freqs !== undefined ? { frequencies: freqs } : {}),
						},
						options,
					)
					const want = oracle(cfg, dflt, centre)
					const got = resolveAmbientTargets(cfg, deps(dflt, centre, ext))
					if (want === null) expect(got).toBeNull()
					else
						expect(got).toEqual({
							...want,
							targetsHz: [want.hz],
							external: ext,
						})
				},
			),
			{ numRuns: 200 },
		)
	})

	it("lists every configured frequency of a new type, hz first", () => {
		const t = resolveAmbientTargets(
			cfgOf("dumpvdl2", {
				sourceId: "rtl",
				frequencies: [136_975_000, 136_650_000],
			}),
			deps(null, undefined),
		)
		expect(t).toEqual({
			sourceId: "rtl",
			hz: 136_975_000,
			targetsHz: [136_975_000, 136_650_000],
			external: false,
		})
	})

	it("falls back to options.frequencies, then options.frequency", () => {
		expect(
			resolveAmbientTargets(
				cfgOf("acarsdec", {}, { frequencies: [131_550_000] }),
				deps("rtl", undefined),
			)?.targetsHz,
		).toEqual([131_550_000])
		expect(
			resolveAmbientTargets(
				cfgOf("acarsdec", {}, { frequency: 131_125_000 }),
				deps("rtl", undefined),
			)?.targetsHz,
		).toEqual([131_125_000])
	})

	it("uses the adapter protocol defaults", () => {
		const d = deps("rtl", undefined)
		expect(resolveAmbientTargets(cfgOf("ais-catcher"), d)?.targetsHz).toEqual(
			Object.values(SCANNER_AIS_CHANNEL_HZ),
		)
		expect(resolveAmbientTargets(cfgOf("acarsdec"), d)?.targetsHz).toEqual([
			131_550_000, 131_725_000,
		])
		expect(resolveAmbientTargets(cfgOf("dumpvdl2"), d)?.targetsHz).toEqual([
			136_650_000, 136_700_000, 136_975_000,
		])
	})

	it("uses the LoRa tuned frequency, and the centre when it follows", () => {
		const d = deps("rtl", 869_000_000)
		expect(
			resolveAmbientTargets(
				cfgOf("lora-meshtastic", {}, { frequency: 869_525_000 }),
				d,
			)?.targetsHz,
		).toEqual([869_525_000])
		expect(
			resolveAmbientTargets(
				cfgOf(
					"lora-meshtastic",
					{},
					{ frequency: 869_525_000, followCenter: true },
				),
				d,
			)?.targetsHz,
		).toEqual([869_000_000])
		expect(resolveAmbientTargets(cfgOf("lora-meshtastic"), d)).toBeNull()
	})

	it("marks external-input decoders and needs a source", () => {
		expect(
			resolveAmbientTargets(cfgOf("ais-catcher"), deps("rtl", undefined, true))
				?.external,
		).toBe(true)
		expect(
			resolveAmbientTargets(cfgOf("ais-catcher"), deps(null, undefined)),
		).toBeNull()
	})
})
