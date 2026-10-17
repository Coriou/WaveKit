/**
 * WG6 frozen contract (docs/specs/web-gaps-6, task 0.1): decoded-elsewhere ranges and the
 * opt-in skip flag, per-hit duration, decoder option issues and descriptors, the DCS tone field
 * and code table, band-plan URL import DTOs and error codes, config export constants and the
 * receiver sample-rate presets. No behaviour beyond defaults.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import {
	BANDPLAN_URL_IMPORT_HOSTS,
	BANDPLANS_ERROR_DEFINITIONS,
	BANDPLANS_LIMITS,
	BANDPLANS_URL_LIMITS,
	CONFIG_EXPORT_OPTION_ALLOWLIST,
	CONFIG_EXPORT_REDACTED,
	CONFIG_EXPORT_REQUIRES_ACCESS,
	CONFIG_EXPORT_ROUTE,
	CONFIG_EXPORT_SECRET_KEY_PATTERN,
	DCS_BIT_RATE_BPS,
	DCS_CODE_SET,
	DCS_MIN_AUDIO_SECONDS,
	DCS_MIN_WORDS,
	DCS_STANDARD_CODES,
	DECODED_ELSEWHERE_MAX_DECODERS,
	DECODED_ELSEWHERE_MAX_RANGES,
	DECODED_ELSEWHERE_MAX_TARGETS,
	DECODED_ELSEWHERE_TARGET_HALF_WIDTH_HZ,
	DECODER_OPTION_ISSUE_TEXT_MAX,
	DECODER_OPTION_ISSUES_MAX,
	DECODER_OPTIONS_ENFORCE,
	RECEIVER_SAMPLE_RATE_PRESETS_HZ,
	bandPlanImportUrlSchema,
	bandPlansErrorCodeSchema,
	importCommitFieldsSchema,
	importedProvenanceSchema,
	importUrlPreviewRequestSchema,
} from "@wavekit/api-types"
import type * as Contract from "../../../src/core/activity/storage/contract.js"
import type {
	BandPlanService,
	BandPlanServiceOptions,
	BandPlanUrlFetcher,
} from "../../../src/core/bandplans/contract.js"
import type { PreviewContext } from "../../../src/core/scanner/plan/plan-preview.js"
import { NormalisedJobSpecSchema } from "../../../src/core/scanner/store/persistence.js"
import type * as Core from "../../../src/core/scanner/types.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")

// --- DCS reference encoder (TIA-603 word layout) used only to pin the table's properties ---
const MASK23 = (1 << 23) - 1
function golayWord(code: number): number {
	const data = code | (0b100 << 9)
	let r = data << 11
	for (let i = 22; i >= 11; i--) if (r & (1 << i)) r ^= 0xc75 << (i - 11)
	return ((data << 11) | r) & MASK23
}
const rotate = (w: number, k: number): number =>
	((w >>> k) | (w << (23 - k))) & MASK23
const codeByWord = new Map<number, number>()
for (let c = 0; c < 512; c++) codeByWord.set(golayWord(c), c)

describe("WG6 contract", () => {
	it("freezes decoded-elsewhere DTOs as copies and the K bounds", () => {
		expect(
			same<Api.DecodedElsewhereRange, Core.DecodedElsewhereRange>(true),
		).toBe(true)
		expect(same<Api.PlanPreview, Core.PlanPreview>(true)).toBe(true)
		expect(same<Api.ScanJobSpec, Core.ScanJobSpec>(true)).toBe(true)
		expect(same<Api.NormalisedJobSpec, Core.NormalisedJobSpec>(true)).toBe(true)
		expect(
			same<
				PreviewContext["decoderCoverage"],
				(() => readonly Core.DecoderCoverageView[]) | undefined
			>(true),
		).toBe(true)
		expect(
			same<Api.ScanJobHit["lastDurationMs"], number | null | undefined>(true),
		).toBe(true)
		expect(DECODED_ELSEWHERE_TARGET_HALF_WIDTH_HZ).toBe(6_250)
		expect(DECODED_ELSEWHERE_MAX_DECODERS).toBe(64)
		expect(DECODED_ELSEWHERE_MAX_TARGETS).toBe(32)
		expect(DECODED_ELSEWHERE_MAX_RANGES).toBe(256)
	})

	it("reads persisted job specs with and without skipDecodedElsewhere", () => {
		const shape = NormalisedJobSpecSchema.shape.skipDecodedElsewhere
		expect(shape.safeParse(undefined).success).toBe(true)
		expect(shape.safeParse(true).success).toBe(true)
		expect(shape.safeParse("yes").success).toBe(false)
	})

	it("freezes decoder option issues report-only", () => {
		expect(DECODER_OPTIONS_ENFORCE).toBe(false)
		expect(DECODER_OPTION_ISSUES_MAX).toBe(32)
		expect(DECODER_OPTION_ISSUE_TEXT_MAX).toBe(256)
		expect(
			same<DecoderStatus["optionIssues"], Api.DecoderOptionIssue[] | undefined>(
				true,
			),
		).toBe(true)
		expect(
			same<
				Api.DecoderStatus["optionIssues"],
				Api.DecoderOptionIssue[] | undefined
			>(true),
		).toBe(true)
	})

	it("keeps the Activity tone copy identical and adds an optional dcs", () => {
		expect(
			same<
				Api.AnalogTransmissionPayload["tone"],
				Contract.AnalogTransmissionPayload["tone"]
			>(true),
		).toBe(true)
		expect(
			same<
				NonNullable<Api.AnalogTransmissionTone["dcs"]>,
				Api.AnalogTransmissionDcs
			>(true),
		).toBe(true)
	})

	it("pins the DCS constants and the 104-code standard table", () => {
		expect(DCS_BIT_RATE_BPS).toBe(134.4)
		expect(DCS_MIN_WORDS).toBe(3)
		expect(DCS_MIN_AUDIO_SECONDS).toBe(0.75)
		expect(DCS_CODE_SET).toBe("standard")
		expect(DCS_STANDARD_CODES).toHaveLength(104)
		expect(new Set(DCS_STANDARD_CODES).size).toBe(104)
		expect([...DCS_STANDARD_CODES].sort()).toEqual(DCS_STANDARD_CODES)
		for (const code of DCS_STANDARD_CODES) expect(code).toMatch(/^[0-7]{3}$/)
		const listed = new Set(DCS_STANDARD_CODES.map(c => Number.parseInt(c, 8)))
		for (const c of listed) {
			const word = golayWord(c)
			// No listed code is a cyclic rotation of another listed code.
			for (let k = 1; k < 23; k++) {
				const other = codeByWord.get(rotate(word, k))
				if (other !== undefined && other !== c)
					expect(
						listed.has(other),
						`${c.toString(8)} ~ ${other.toString(8)}`,
					).toBe(false)
			}
			// Exactly one listed inverted twin (023 normal = 047 inverted).
			const inverted = ~word & MASK23
			const twins = new Set<number>()
			for (let k = 0; k < 23; k++) {
				const other = codeByWord.get(rotate(inverted, k))
				if (other !== undefined && listed.has(other)) twins.add(other)
			}
			expect(twins.size, c.toString(8)).toBe(1)
		}
		const twinOf023 = new Set<number>()
		const inv = ~golayWord(0o23) & MASK23
		for (let k = 0; k < 23; k++) {
			const other = codeByWord.get(rotate(inv, k))
			if (other !== undefined && listed.has(other)) twinOf023.add(other)
		}
		expect([...twinOf023]).toEqual([0o47])
	})

	it("freezes band-plan URL import bounds, schemas and error codes", () => {
		expect(BANDPLAN_URL_IMPORT_HOSTS).toEqual(["raw.githubusercontent.com"])
		expect(BANDPLANS_URL_LIMITS).toEqual({
			urlChars: 2048,
			responseBytes: BANDPLANS_LIMITS.importFileBytes,
			totalTimeoutMs: 10_000,
			inFlight: 1,
		})
		const ok = "https://raw.githubusercontent.com/o/r/main/plan.json"
		expect(bandPlanImportUrlSchema.safeParse(ok).success).toBe(true)
		for (const bad of [
			"http://raw.githubusercontent.com/o/r/main/plan.json",
			"https://user:pw@raw.githubusercontent.com/plan.json",
			"https://raw.githubusercontent.com:8443/plan.json",
			"https://raw.githubusercontent.com/plan.json#x",
			"file:///etc/passwd",
			"not a url",
			`https://raw.githubusercontent.com/${"a".repeat(2048)}`,
		])
			expect(bandPlanImportUrlSchema.safeParse(bad).success, bad).toBe(false)
		expect(
			importUrlPreviewRequestSchema.safeParse({
				url: ok,
				format: "sdrpp-json",
				groupOverrides: [],
			}).success,
		).toBe(true)
		const provenance = {
			kind: "imported",
			trust: "community-unverified",
			format: "sdrpp-json",
			sourceName: "plan.json",
			author: null,
			licence: null,
			importedAt: "2026-10-16T00:00:00.000Z",
			sha256: "a".repeat(64),
		}
		expect(importedProvenanceSchema.safeParse(provenance).success).toBe(true)
		expect(
			importedProvenanceSchema.safeParse({ ...provenance, sourceUrl: ok })
				.success,
		).toBe(true)
		expect(
			importedProvenanceSchema.safeParse({
				...provenance,
				sourceUrl: "http://x/y",
			}).success,
		).toBe(false)
		expect(
			importCommitFieldsSchema.shape.sourceUrl.safeParse(undefined).success,
		).toBe(true)
		expect(
			importCommitFieldsSchema.shape.sourceUrl.safeParse(null).success,
		).toBe(true)
		expect(BANDPLANS_ERROR_DEFINITIONS.BANDPLANS_URL_IMPORT_DISABLED[0]).toBe(
			403,
		)
		expect(BANDPLANS_ERROR_DEFINITIONS.BANDPLANS_URL_REFUSED[0]).toBe(422)
		expect(BANDPLANS_ERROR_DEFINITIONS.BANDPLANS_URL_FETCH_FAILED[0]).toBe(502)
		expect(BANDPLANS_ERROR_DEFINITIONS.BANDPLANS_URL_TIMEOUT[0]).toBe(504)
		expect([...bandPlansErrorCodeSchema.options].sort()).toEqual(
			Object.keys(BANDPLANS_ERROR_DEFINITIONS).sort(),
		)
		expect(
			same<
				BandPlanServiceOptions["urlFetcher"],
				BandPlanUrlFetcher | undefined
			>(true),
		).toBe(true)
		expect(
			same<
				BandPlanService["previewImportUrl"],
				((request: unknown) => Promise<Api.ImportUrlPreview>) | undefined
			>(true),
		).toBe(true)
	})

	it("freezes the config export switches (E2 recommended default)", () => {
		expect(CONFIG_EXPORT_ROUTE).toBe("/api/config/export")
		expect(CONFIG_EXPORT_REQUIRES_ACCESS).toBe(true)
		expect(CONFIG_EXPORT_REDACTED).toBe("<redacted>")
		for (const key of [
			"channelKey",
			"psk",
			"password",
			"apiToken",
			"bpKey",
			"secret",
			"credentials",
		])
			expect(CONFIG_EXPORT_SECRET_KEY_PATTERN.test(key), key).toBe(true)
		for (const key of ["frequency", "sampleRate", "gain", "region", "preset"])
			expect(CONFIG_EXPORT_SECRET_KEY_PATTERN.test(key), key).toBe(false)
		for (const key of CONFIG_EXPORT_OPTION_ALLOWLIST)
			expect(CONFIG_EXPORT_SECRET_KEY_PATTERN.test(key), key).toBe(false)
	})

	it("keeps the receiver sample-rate presets equal to the CLI list", () => {
		const cli = readFileSync(join(root, "cli/source/ui/tuner-edit.ts"), "utf8")
		const block = /VALID_SAMPLE_RATES[^=]*=\s*\[([^\]]*)\]/.exec(cli)
		expect(block).not.toBeNull()
		const cliRates = [...(block?.[1] ?? "").matchAll(/[\d_]+/g)].map(m =>
			Number(m[0].replaceAll("_", "")),
		)
		expect(RECEIVER_SAMPLE_RATE_PRESETS_HZ).toEqual(cliRates)
		expect(RECEIVER_SAMPLE_RATE_PRESETS_HZ).toHaveLength(11)
	})
})
