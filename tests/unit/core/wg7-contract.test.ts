/**
 * WG7 frozen contract (docs/specs/web-gaps-7, task 0.1): ambient-only scanner protocols and
 * identity kinds, ambient identify trial fields, band-plan skip ranges and the opt-in flag, the
 * decoded-elsewhere refresh timing, noise and tone squelch DTOs and config, receiver gain
 * tables, the stricter band-plan URL schema and stored group overrides. No behaviour beyond
 * defaults.
 */
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import {
	BANDPLAN_SCANNER_PROTOCOLS,
	BANDPLAN_SKIP_MAX_RANGES,
	BANDPLAN_SKIP_MAX_SOURCES,
	DCS_STANDARD_CODES,
	DECODED_ELSEWHERE_REFRESH_DEBOUNCE_MS,
	DECODED_ELSEWHERE_REFRESH_MIN_INTERVAL_MS,
	IDENTIFY_AMBIENT_MAX_TRIALS,
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_SQUELCH_MODES,
	LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT,
	LIVE_AUDIO_TONE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT,
	RTL_TUNER_GAIN_TABLES,
	RTL_TUNER_NAMES,
	SCANNER_AIS_CHANNEL_HZ,
	SCANNER_AMBIENT_DECODER_PROTOCOL,
	SCANNER_AMBIENT_PROTOCOLS,
	SCANNER_AMBIENT_TARGET_TOLERANCE_HZ,
	bandPlanImportUrlSchema,
	importedProvenanceSchema,
} from "@wavekit/api-types"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type * as Contract from "../../../src/core/activity/storage/contract.js"
import { familyOf } from "../../../src/core/scanner/classify/classifier.js"
import type {
	JobDriver,
	JobRecord,
} from "../../../src/core/scanner/job-runner.js"
import {
	PROTOCOL_DECODER,
	type PreviewContext,
} from "../../../src/core/scanner/plan/plan-preview.js"
import { ScannerProtocolSchema } from "../../../src/core/scanner/store/schemas.js"
import { NormalisedJobSpecSchema } from "../../../src/core/scanner/store/persistence.js"
import type * as Core from "../../../src/core/scanner/types.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value

const AMBIENT = ["ais", "acars", "vdl2", "lora"] as const

describe("WG7 contract", () => {
	it("adds the ambient-only protocols and identity kinds everywhere", () => {
		expect(same<Api.ScannerProtocol, Core.ScannerProtocol>(true)).toBe(true)
		expect(same<Api.IdentityKind, Core.IdentityKind>(true)).toBe(true)
		expect(SCANNER_AMBIENT_PROTOCOLS).toEqual(AMBIENT)
		for (const p of AMBIENT) {
			expect(ScannerProtocolSchema.safeParse(p).success, p).toBe(true)
			expect(
				(BANDPLAN_SCANNER_PROTOCOLS as readonly string[]).includes(p),
			).toBe(true)
			// No probe decoder: scan plans and cost estimates are unchanged (req 1.1).
			expect(PROTOCOL_DECODER[p], p).toBeNull()
			expect(familyOf(p), p).toBe("packet")
		}
		expect(BANDPLAN_SCANNER_PROTOCOLS).toHaveLength(21)
		expect(SCANNER_AMBIENT_DECODER_PROTOCOL).toEqual({
			"ais-catcher": "ais",
			acarsdec: "acars",
			dumpvdl2: "vdl2",
			"lora-meshtastic": "lora",
		})
		expect(SCANNER_AIS_CHANNEL_HZ).toEqual({ A: 161_975_000, B: 162_025_000 })
		expect(SCANNER_AMBIENT_TARGET_TOLERANCE_HZ).toBe(1_000)
		expect(IDENTIFY_AMBIENT_MAX_TRIALS).toBe(8)
	})

	it("freezes the ambient identify trial fields and the driver hook", () => {
		expect(
			same<
				Api.ScannerIdentifyTrial["transport"],
				// WG11 req 6.6: identify replay trials
				"offset" | "channel" | "ambient" | "replay" | null
			>(true),
		).toBe(true)
		expect(
			same<
				Api.ScannerIdentifyTrial["decoder"],
				| "dsd-fme"
				| "multimon-ng"
				| "direwolf"
				| "rtl433"
				| Api.ScannerAmbientDecoderType
				// WG10 req 3.2 widens the decoder with the live-audio analog evidence
				| "live-audio"
				| null
			>(true),
		).toBe(true)
		expect(
			same<
				JobDriver["onAmbientEvidence"],
				((observationId: string, ev: Core.DecodeEvidence) => void) | undefined
			>(true),
		).toBe(true)
	})

	it("freezes band-plan skip DTOs as copies, the bounds and the persisted flag", () => {
		expect(same<Api.BandPlanSkipRange, Core.BandPlanSkipRange>(true)).toBe(true)
		expect(same<Api.PlanPreview, Core.PlanPreview>(true)).toBe(true)
		expect(same<Api.ScanJobSpec, Core.ScanJobSpec>(true)).toBe(true)
		expect(same<Api.NormalisedJobSpec, Core.NormalisedJobSpec>(true)).toBe(true)
		expect(same<Api.PlanIssueCode, Core.PlanIssueCode>(true)).toBe(true)
		expect(
			same<
				PreviewContext["bandPlanSkips"],
				(() => readonly Core.BandPlanSkipSource[]) | undefined
			>(true),
		).toBe(true)
		expect(
			same<JobRecord["bandPlanSkips"], Core.BandPlanSkipRange[] | undefined>(
				true,
			),
		).toBe(true)
		expect(BANDPLAN_SKIP_MAX_SOURCES).toBe(1_024)
		expect(BANDPLAN_SKIP_MAX_RANGES).toBe(256)
		const shape = NormalisedJobSpecSchema.shape.skipBandPlanSkips
		expect(shape.safeParse(undefined).success).toBe(true)
		expect(shape.safeParse(false).success).toBe(true)
		expect(shape.safeParse("yes").success).toBe(false)
	})

	it("pins the decoded-elsewhere refresh timing", () => {
		expect(DECODED_ELSEWHERE_REFRESH_DEBOUNCE_MS).toBe(2_000)
		expect(DECODED_ELSEWHERE_REFRESH_MIN_INTERVAL_MS).toBe(30_000)
	})

	it("freezes squelch modes, the noise threshold and the tone squelch shape", () => {
		expect(LIVE_AUDIO_SQUELCH_MODES).toEqual(["manual", "auto", "noise"])
		expect(LIVE_AUDIO_NOISE_QUIETING_DB).toEqual({
			default: 6,
			min: 1,
			max: 30,
		})
		expect(LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS).toEqual(["nfm", "wfm"])
		expect(LIVE_AUDIO_TONE_SQUELCH_MODULATIONS).toEqual(["nfm"])
		expect(LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT).toBe(2)
		expect(LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT).toBe(2)
		expect(
			same<Api.LiveAudioToneSquelch, Api.SavedFrequency["tone"]>(true),
		).toBe(true)
		expect(
			same<
				Api.AnalogTransmissionPayload["squelchMode"],
				Contract.AnalogTransmissionPayload["squelchMode"]
			>(true),
		).toBe(true)
		expect(
			same<
				Api.AnalogTransmissionPayload["squelchMode"],
				Api.LiveAudioSquelchMode
			>(true),
		).toBe(true)
	})

	it("validates the live demod squelch config combinations", () => {
		const ok = (value: Record<string, unknown>): boolean =>
			LiveDemodConfigSchema.safeParse(value).success
		expect(ok({})).toBe(true)
		expect(ok({ squelchMode: "noise" })).toBe(true)
		expect(ok({ squelchMode: "noise", modulation: "wfm" })).toBe(true)
		expect(ok({ squelchMode: "noise", modulation: "am" })).toBe(false)
		expect(ok({ noiseQuietingDb: 1 })).toBe(true)
		expect(ok({ noiseQuietingDb: 30 })).toBe(true)
		expect(ok({ noiseQuietingDb: 0.5 })).toBe(false)
		expect(ok({ noiseQuietingDb: 31 })).toBe(false)
		expect(ok({ toneSquelch: { kind: "none" } })).toBe(true)
		expect(
			ok({ toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1000 } }),
		).toBe(true)
		expect(
			ok({ toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1001 } }),
		).toBe(false)
		expect(
			ok({ toneSquelch: { kind: "dcs", code: "023", polarity: "normal" } }),
		).toBe(true)
		expect(
			ok({ toneSquelch: { kind: "dcs", code: "024", polarity: "normal" } }),
		).toBe(false)
		expect(
			ok({
				modulation: "wfm",
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1000 },
			}),
		).toBe(false)
		expect(DCS_STANDARD_CODES.includes("023")).toBe(true)
		const parsed = LiveDemodConfigSchema.parse({})
		expect(parsed.squelchMode).toBeUndefined()
		expect(parsed.noiseQuietingDb).toBeUndefined()
		expect(parsed.toneSquelch).toBeUndefined()
	})

	it("pins the cited librtlsdr gain tables and tuner names", () => {
		expect(RTL_TUNER_NAMES).toEqual([
			"unknown",
			"E4000",
			"FC0012",
			"FC0013",
			"FC2580",
			"R820T",
			"R828D",
		])
		const lengths = Object.fromEntries(
			Object.entries(RTL_TUNER_GAIN_TABLES).map(([type, t]) => [
				type,
				t?.valuesTenthsDb.length,
			]),
		)
		expect(lengths).toEqual({ 1: 14, 2: 5, 3: 23, 5: 29, 6: 29 })
		expect(RTL_TUNER_GAIN_TABLES[4]).toBeUndefined()
		expect(RTL_TUNER_GAIN_TABLES[0]).toBeUndefined()
		for (const [type, table] of Object.entries(RTL_TUNER_GAIN_TABLES)) {
			expect(table?.tuner).toBe(RTL_TUNER_NAMES[Number(type)])
			const values = table?.valuesTenthsDb ?? []
			for (let i = 1; i < values.length; i++)
				expect(values[i]!).toBeGreaterThan(values[i - 1]!)
		}
		expect(RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb.at(-1)).toBe(496)
		expect(RTL_TUNER_GAIN_TABLES[1]?.valuesTenthsDb.at(-1)).toBe(420)
		expect(
			same<
				Api.ReceiverCapabilities["gainTable"],
				Api.ReceiverGainTable | undefined
			>(true),
		).toBe(true)
	})

	it("refuses explicit ports and any fragment in band-plan import URLs", () => {
		const ok = (url: string): boolean =>
			bandPlanImportUrlSchema.safeParse(url).success
		expect(ok("https://raw.githubusercontent.com/a/b/plan.json")).toBe(true)
		expect(ok("https://raw.githubusercontent.com/a/b/plan.json?x=1")).toBe(true)
		expect(ok("https://raw.githubusercontent.com:443/a/b/plan.json")).toBe(
			false,
		)
		expect(ok("https://raw.githubusercontent.com:/a/b/plan.json")).toBe(false)
		expect(ok("https://raw.githubusercontent.com/a/b/plan.json#")).toBe(false)
		expect(ok("https://raw.githubusercontent.com/a/b/plan.json#x")).toBe(false)
		expect(ok("https://raw.githubusercontent.com/a b/plan.json")).toBe(false)
		expect(ok(" https://raw.githubusercontent.com/a/b/plan.json")).toBe(false)
		expect(ok("https://u@raw.githubusercontent.com/a/b/plan.json")).toBe(false)
		expect(ok("http://raw.githubusercontent.com/a/b/plan.json")).toBe(false)
	})

	it("reads imported provenance with and without stored group overrides", () => {
		const base = {
			kind: "imported",
			trust: "community-unverified",
			format: "sdrpp-json",
			sourceName: "plan.json",
			author: null,
			licence: null,
			importedAt: "2026-10-16T12:00:00.000Z",
			sha256: "0".repeat(64),
		}
		expect(importedProvenanceSchema.safeParse(base).success).toBe(true)
		expect(
			importedProvenanceSchema.safeParse({
				...base,
				groupOverrides: [{ sourceType: "ham", group: "amateur" }],
			}).success,
		).toBe(true)
		expect(
			importedProvenanceSchema.safeParse({
				...base,
				groupOverrides: Array.from({ length: 65 }, (_, i) => ({
					sourceType: `t${i}`,
					group: "amateur",
				})),
			}).success,
		).toBe(false)
	})
})
