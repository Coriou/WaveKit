/**
 * WG8 frozen contract (docs/specs/web-gaps-8, task 0.1): decoder settings DTOs, bounds, error
 * codes and the patchable descriptor field; the recordings inventory DTOs, id pattern and
 * bounds; the spectrum bins cap setting, budgets and limits. No behaviour beyond defaults.
 */
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import {
	DECODER_SETTINGS_BODY_MAX_BYTES,
	DECODER_SETTINGS_ERROR_STATUS,
	DECODER_SETTINGS_FILE_MAX_BYTES,
	DECODER_SETTINGS_FILE_NAME,
	DECODER_SETTINGS_MAX_DECODERS,
	DECODER_SETTINGS_MAX_KEYS,
	DECODER_SETTINGS_PATCHABLE_TYPES,
	DECODER_SETTINGS_REQUIRES_ACCESS,
	RECORDING_INVENTORY_ID,
	RECORDING_INVENTORY_KINDS,
	RECORDINGS_CURSOR_MAX_LENGTH,
	RECORDINGS_HEADER_READ_BYTES,
	RECORDINGS_IN_PROGRESS_MS,
	RECORDINGS_PAGE_LIMIT_DEFAULT,
	RECORDINGS_PAGE_LIMIT_MAX,
	RECORDINGS_REQUIRES_ACCESS,
	RECORDINGS_SCAN_CONCURRENCY,
	RECORDINGS_SCAN_MAX_FILES,
	SPECTRUM_BINS_BUDGET,
	SPECTRUM_BINS_CAP_CEILING,
	SPECTRUM_BINS_CAP_CHOICES,
	SPECTRUM_BINS_CAP_FLOOR,
	SPECTRUM_BINS_CAP_SETTINGS,
	SPECTRUM_SUMMARY_BINS_MAX,
} from "@wavekit/api-types"
import { ConfigSchema, ScannerConfigSchema } from "../../../src/config.js"
import { redactConfig } from "../../../src/core/config-export/export.js"
import type * as Core from "../../../src/core/scanner/types.js"
import {
	PROFILE_BINS_CEILING,
	PROFILE_BINS_FLOOR,
	PROFILE_LIMITS,
} from "../../../src/core/spectrum/subscribe-options.js"
import { BAND_OVERRIDE_FILE_NAME } from "../../../src/decoders/band-override-store.js"
import { RECORDING_IN_PROGRESS_MS } from "../../../src/decoders/builtin/call-recordings.js"
import {
	DECODER_OPTION_SCHEMAS,
	decoderOptionDescriptors,
} from "../../../src/decoders/options/index.js"
import {
	DecoderSettingsError,
	type DecoderSettingsManagerPort,
	type DecoderSettingsService,
} from "../../../src/decoders/settings/contract.js"
import { STATION_STORE_FILE } from "../../../src/core/station/contract.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value

/** Meanings that are never patchable (requirement 2.3), matched on the key. */
const NEVER_PATCHABLE_KEY =
	/(path|file|dir|host|addr|port|device|serial|url|callsign|^lat$|^lon$|^output|^udp|record|prune|debug|inputIqFormat|extraArgs|voiceSlot)/i

describe("WG8 contract", () => {
	it("freezes the decoder settings bounds, access switch and error statuses", () => {
		expect(DECODER_SETTINGS_REQUIRES_ACCESS).toBe(true)
		expect(DECODER_SETTINGS_FILE_NAME).toBe("decoder-settings.json")
		expect(DECODER_SETTINGS_FILE_NAME).not.toBe(BAND_OVERRIDE_FILE_NAME)
		expect(DECODER_SETTINGS_FILE_NAME).not.toBe(STATION_STORE_FILE)
		expect(DECODER_SETTINGS_FILE_MAX_BYTES).toBe(262_144)
		expect(DECODER_SETTINGS_MAX_DECODERS).toBe(256)
		expect(DECODER_SETTINGS_MAX_KEYS).toBe(64)
		expect(DECODER_SETTINGS_BODY_MAX_BYTES).toBe(16_384)
		expect([...DECODER_SETTINGS_PATCHABLE_TYPES]).toEqual([
			"boolean",
			"integer",
			"number",
			"enum",
			"string-list",
			"number-list",
		])
		expect(DECODER_SETTINGS_ERROR_STATUS).toEqual({
			DECODER_OPTIONS_INVALID: 400,
			DECODER_OPTION_NOT_PATCHABLE: 400,
			DECODER_SETTINGS_REVISION_MISMATCH: 412,
			DECODER_SETTINGS_STORE_UNAVAILABLE: 503,
			DECODER_SETTINGS_LIMIT: 413,
		})
		// Every schema fits the per-entry key bound.
		for (const type of Object.keys(DECODER_OPTION_SCHEMAS))
			expect((decoderOptionDescriptors(type) ?? []).length).toBeLessThanOrEqual(
				DECODER_SETTINGS_MAX_KEYS,
			)
	})

	it("keeps patchable an allowlist by meaning (absent = false)", () => {
		for (const type of Object.keys(DECODER_OPTION_SCHEMAS)) {
			for (const d of decoderOptionDescriptors(type) ?? []) {
				if (d.patchable !== true) continue
				expect(d.secret).toBe(false)
				expect(d.key).not.toMatch(NEVER_PATCHABLE_KEY)
				expect(
					(DECODER_SETTINGS_PATCHABLE_TYPES as readonly string[]).includes(
						d.type,
					),
				).toBe(true)
				if (d.type === "string-list")
					expect(d.enumValues?.length ?? 0).toBeGreaterThan(0)
			}
		}
		const descriptor: Api.DecoderOptionDescriptor = {
			key: "k",
			type: "number",
			default: null,
			secret: false,
			effect: "restart",
			description: "",
		}
		expect(descriptor.patchable).toBeUndefined()
	})

	it("builds settings error bodies without submitted values", () => {
		const err = new DecoderSettingsError(
			"DECODER_OPTION_NOT_PATCHABLE",
			"Option not patchable",
			{ keys: ["wavDir"], unknownKeys: 2 },
		)
		expect(err.statusCode).toBe(400)
		expect(err.toBody()).toEqual({
			error: "Bad Request",
			code: "DECODER_OPTION_NOT_PATCHABLE",
			message: "Option not patchable",
			keys: ["wavDir"],
			unknownKeys: 2,
		})
		expect(
			new DecoderSettingsError("DECODER_SETTINGS_REVISION_MISMATCH", "m")
				.statusCode,
		).toBe(412)
		expect(
			new DecoderSettingsError("DECODER_SETTINGS_LIMIT", "m").toBody().error,
		).toBe("Payload Too Large")
		// The ports are types only; compile-time shape checks.
		const port: DecoderSettingsManagerPort = {
			getStatus: () => undefined,
			stageDecoderOptions: () => false,
			isRestartPending: () => false,
		}
		expect(port.stageDecoderOptions("x", { gain: null })).toBe(false)
		expect(
			same<
				Awaited<ReturnType<DecoderSettingsService["update"]>>,
				Api.DecoderSettingsUpdateResult
			>(true),
		).toBe(true)
	})

	it("freezes the recordings inventory bounds and the opaque id pattern", () => {
		expect(RECORDINGS_REQUIRES_ACCESS).toBe(true)
		expect(RECORDINGS_PAGE_LIMIT_DEFAULT).toBe(50)
		expect(RECORDINGS_PAGE_LIMIT_MAX).toBe(200)
		expect(RECORDINGS_CURSOR_MAX_LENGTH).toBe(512)
		expect(RECORDINGS_SCAN_MAX_FILES).toBe(2000)
		expect(RECORDINGS_HEADER_READ_BYTES).toBe(4096)
		expect(RECORDINGS_SCAN_CONCURRENCY).toBe(8)
		expect(RECORDINGS_IN_PROGRESS_MS).toBe(RECORDING_IN_PROGRESS_MS)
		expect(RECORDING_INVENTORY_KINDS).toEqual([
			"dsd-fme-call",
			"scanner-dv",
			"scanner-analog",
		])
		for (const ok of [
			"dsd:0~20261016_120000_01234_1_GROUP_TGT_100_SRC_2001.wav",
			"dsd:12~20261016_120000_01234_BEE00_PRIVATE_TGT_7_SRC_8.wav",
			"scan:d_abc123~call-1.wav",
		])
			expect(RECORDING_INVENTORY_ID.test(ok)).toBe(true)
		for (const bad of [
			"dsd:01~20261016_120000_01234_1_GROUP_TGT_1_SRC_2.wav",
			"dsd:10000~20261016_120000_01234_1_GROUP_TGT_1_SRC_2.wav",
			"dsd:0~TEMP_20261016_120000_ABCD.wav",
			"dsd:0~../20261016_120000_01234_1_GROUP_TGT_1_SRC_2.wav",
			"dsd:0~20261016_120000_01234_a/b.wav",
			"dsd:0~20261016_120000_01234_a b.wav",
			"scan:d_abc~../../etc/passwd.wav",
			"scan:probe-1~x.wav",
			"scan:d_abc~x.WAV",
			"/app/decoded_calls/x.wav",
			"",
		])
			expect(RECORDING_INVENTORY_ID.test(bad)).toBe(false)
		const item: Api.RecordingInventoryItem = {
			id: "scan:d_a~b.wav",
			kind: "scanner-analog",
			decoderId: null,
			discoveryId: "d_a",
			startedAtLocal: null,
			modifiedAt: "2026-10-16T00:00:00.000Z",
			bytes: 44,
			durationMs: 0,
			callType: null,
			talkgroup: null,
			source: null,
			frequencyHz: null,
		}
		expect(Object.keys(item)).toHaveLength(12)
	})

	it("freezes the bins cap setting and budgets without changing today's limits", () => {
		expect(SPECTRUM_BINS_CAP_SETTINGS).toEqual(["auto", 2048, 4096, 8192])
		expect(SPECTRUM_BINS_CAP_CHOICES).toEqual([2048, 4096, 8192])
		expect(SPECTRUM_BINS_CAP_FLOOR).toBe(2048)
		expect(SPECTRUM_BINS_CAP_CEILING).toBe(8192)
		expect(SPECTRUM_SUMMARY_BINS_MAX).toBe(8192)
		expect(SPECTRUM_BINS_BUDGET).toEqual({
			summaryBytesPerSecond: 524_288,
			cloneMsPerSecond: 10,
			profileMsPerSecond: 5,
			margin: 1.5,
			benchWallMs: 200,
		})
		expect(PROFILE_LIMITS.bins).toEqual({ min: 128, max: 2048 })
		expect(PROFILE_BINS_FLOOR).toBe(PROFILE_LIMITS.bins.max)
		expect(PROFILE_BINS_CEILING).toBe(SPECTRUM_BINS_CAP_CEILING)

		const ws = ScannerConfigSchema.parse({}).ws
		// Absent means "auto": no default is filled in, so the parsed config is unchanged.
		expect(ws.spectrumBinsCap).toBeUndefined()
		expect("spectrumBinsCap" in ws).toBe(false)
		// The default profile keeps 128..2048 and 512 (CLI guard, web default); the summary
		// budget default stays 2048 and never exceeds the ceiling.
		expect(ws.spectrumBins).toBe(512)
		expect(ws.spectrumSummaryBins).toBe(2048)
		expect(() =>
			ScannerConfigSchema.parse({ ws: { spectrumBins: 2049 } }),
		).toThrow()
		expect(() =>
			ScannerConfigSchema.parse({
				ws: { spectrumSummaryBins: SPECTRUM_SUMMARY_BINS_MAX + 1 },
			}),
		).toThrow()
		for (const v of ["auto", 2048, 4096, 8192] as const)
			expect(
				ScannerConfigSchema.parse({ ws: { spectrumBinsCap: v } }).ws
					.spectrumBinsCap,
			).toBe(v)
		for (const v of ["AUTO", 1024, 16384, 3000, null, "4096"])
			expect(() =>
				ScannerConfigSchema.parse({ ws: { spectrumBinsCap: v } }),
			).toThrow()

		expect(
			same<
				NonNullable<Api.ScannerSettingsValues["ws"]["spectrumBinsCap"]>,
				Api.SpectrumBinsCapSetting
			>(true),
		).toBe(true)
		expect(
			same<
				Api.ScannerSettingsValues["ws"]["spectrumBinsCap"],
				Core.ScannerSettings["ws"]["spectrumBinsCap"]
			>(true),
		).toBe(true)
		const limits: Api.SpectrumLimits = {
			maxProfiles: 4,
			hz: { min: 0.5, max: 25, step: 0.5 },
			bins: { min: 128, max: 2048 },
			averaging: { min: 1, max: 32 },
			backfill: { maxMs: 10_000, maxFrames: 64, maxBytes: 524_288 },
		}
		expect(limits.binsCap).toBeUndefined()
	})

	it("exports the bins cap setting (closed set) in the redacted config", () => {
		const config = ConfigSchema.parse({
			scanner: { ws: { spectrumBinsCap: 4096 } },
		})
		const redacted = redactConfig(config) as {
			scanner?: { ws?: { spectrumBinsCap?: unknown } }
		}
		expect(redacted.scanner?.ws?.spectrumBinsCap).toBe(4096)
		const auto = redactConfig(
			ConfigSchema.parse({ scanner: { ws: { spectrumBinsCap: "auto" } } }),
		) as { scanner?: { ws?: { spectrumBinsCap?: unknown } } }
		expect(auto.scanner?.ws?.spectrumBinsCap).toBe("auto")
		const plain = redactConfig(ConfigSchema.parse({})) as {
			scanner?: { ws?: Record<string, unknown> }
		}
		expect(plain.scanner?.ws && "spectrumBinsCap" in plain.scanner.ws).toBe(
			false,
		)
	})
})
