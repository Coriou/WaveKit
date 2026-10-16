import { join, resolve } from "node:path"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { STORAGE_AREA_IDS } from "@wavekit/api-types"
import {
	activityRetentionFromStats,
	dsdFmeRecordingDir,
	storageActivityLimits,
	storageAreasFromConfig,
	type StorageAreaInputs,
} from "../../../../src/core/storage-report/areas-from-config.js"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import { createDsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { ACTIVITY_LIMIT_DEFAULTS } from "../../../../src/core/activity/storage/limits.js"
import type { ActivityStoreStats } from "../../../../src/core/activity/storage/contract.js"

const MiB = 1024 * 1024
const stateDir = "/var/lib/wavekit"

function inputs(overrides: Partial<StorageAreaInputs> = {}): StorageAreaInputs {
	return {
		stateDir,
		activityMaxDbBytes: 256 * MiB,
		scannerStorage: { dir: null, maxRecordingsMb: 512 },
		decoders: [],
		accessDirectory: null,
		...overrides,
	}
}

describe("storageAreasFromConfig (WG4 req 3)", () => {
	it("lists every area in STORAGE_AREA_IDS order with its paths and caps", () => {
		const areas = storageAreasFromConfig(
			inputs({
				accessDirectory: "/run/wavekit/access",
				logsDir: "/var/log/wavekit",
				decoders: [
					{ type: "dsd-fme", options: { output: "wav", wavDir: "/data/wav" } },
				],
			}),
		)
		expect(areas.map(a => a.id)).toEqual(STORAGE_AREA_IDS)
		expect(areas).toEqual([
			{
				id: "activity",
				paths: [join(stateDir, "activity")],
				capBytes: 256 * MiB,
			},
			{
				id: "scanner-evidence",
				paths: [join(stateDir, "scanner")],
				capBytes: 512 * MiB,
			},
			{ id: "digital-voice-wav", paths: ["/data/wav"], capBytes: null },
			{ id: "bandplans", paths: [join(stateDir, "bandplans")], capBytes: null },
			{
				id: "operator-data",
				paths: [join(stateDir, "operator-data")],
				capBytes: null,
			},
			{ id: "access", paths: ["/run/wavekit/access"], capBytes: null },
			{
				id: "decoder-overrides",
				paths: [join(stateDir, "decoder-band-overrides.json")],
				capBytes: null,
			},
			{
				id: "station",
				paths: [join(stateDir, "station.json")],
				capBytes: null,
			},
			{ id: "logs", paths: ["/var/log/wavekit"], capBytes: null },
		])
		expect(() =>
			createStorageReporter({ stateDir, areas, minFreeBytes: null }),
		).not.toThrow()
	})

	it("omits access without a directory and logs without logging.dir", () => {
		for (const accessDirectory of [null, ""]) {
			const ids = storageAreasFromConfig(inputs({ accessDirectory })).map(
				a => a.id,
			)
			expect(ids).not.toContain("access")
			expect(ids).not.toContain("logs")
		}
		expect(
			storageAreasFromConfig(inputs({ logsDir: "" })).map(a => a.id),
		).not.toContain("logs")
	})

	it("uses a configured scanner dir and a null Activity cap", () => {
		const areas = storageAreasFromConfig(
			inputs({
				activityMaxDbBytes: null,
				scannerStorage: { dir: "/srv/scanner", maxRecordingsMb: 3 },
			}),
		)
		expect(areas[0]).toMatchObject({ id: "activity", capBytes: null })
		expect(areas[1]).toEqual({
			id: "scanner-evidence",
			paths: ["/srv/scanner"],
			capBytes: 3 * MiB,
		})
	})

	it("collects every recording dsd-fme dir once and excludes those inside the scanner dir", () => {
		const scannerDir = join(stateDir, "scanner")
		const inside = join(scannerDir, "recordings", "dv")
		const areas = storageAreasFromConfig(
			inputs({
				decoders: [
					{ type: "dsd-fme", options: { output: "wav", wavDir: inside } },
					{ type: "dsd-fme", options: { enablePerCallRecording: true } },
					{ type: "dsd-fme", options: { output: "wav", wavDir: "/data/wav" } },
					{ type: "dsd-fme", options: { output: "wav", wavDir: "/data/wav" } },
					{ type: "dsd-fme", options: { output: "udp" } },
					{ type: "dsd-fme" },
					{ type: "multimon-ng", options: { output: "wav", wavDir: "/x" } },
				],
			}),
		)
		const byId = new Map(areas.map(a => [a.id, a]))
		expect(byId.get("digital-voice-wav")?.paths).toEqual([
			inside,
			"/app/decoded_calls",
			"/data/wav",
		])
		expect(byId.get("scanner-evidence")?.exclude).toEqual([inside])
		const none = storageAreasFromConfig(inputs())
		expect(none[2]).toEqual({
			id: "digital-voice-wav",
			paths: [],
			capBytes: null,
		})
		expect(none[1]).not.toHaveProperty("exclude")
	})

	it("resolves relative paths to absolute", () => {
		const areas = storageAreasFromConfig(
			inputs({ stateDir: "state", logsDir: "logs" }),
		)
		for (const area of areas)
			for (const path of area.paths) expect(path.startsWith("/")).toBe(true)
		expect(areas[0]?.paths).toEqual([resolve("state", "activity")])
	})
})

describe("dsdFmeRecordingDir matches the adapter", () => {
	const cases: Array<Record<string, unknown>> = [
		{},
		{ output: "null" },
		{ output: "udp", enablePerCallRecording: true },
		{ output: "wav" },
		{ output: "wav", wavDir: "/data/wav" },
		{ output: "wav", perCallRecordingDir: "/data/calls" },
		{ output: "wav", wavDir: "/data/wav", perCallRecordingDir: "/data/calls" },
		{ enablePerCallRecording: true, perCallRecordingDir: "/data/calls" },
		{ enablePerCallRecording: true, wavDir: "/data/wav" },
		{ enablePerCallRecording: false },
	]
	it.each(cases)("options %j", options => {
		const decoder = createDsdFmeDecoder(
			{ id: "dv", type: "dsd-fme", enabled: true, options },
			pino({ level: "silent" }),
		)
		const adapter = (
			decoder as unknown as { recordingDir(): string | null }
		).recordingDir()
		expect(dsdFmeRecordingDir(options)).toBe(adapter)
	})
})

describe("Activity retention mapping", () => {
	const stats = {
		rows: 1200,
		oldestReceivedAt: "2026-10-01T00:00:00.000Z",
		retention: {
			policy: "fair-share",
			effective: "oldest-first",
			shares: [
				{
					key: "decoder:adsb",
					rows: 1000,
					bytes: 5000,
					oldestReceivedAt: null,
				},
			],
			sharesTruncated: true,
			prefixFallbackSteps: 2,
		},
	} as unknown as ActivityStoreStats

	it("resolves the configured limits like the store", () => {
		expect(storageActivityLimits(undefined)).toEqual({
			retentionPolicy: ACTIVITY_LIMIT_DEFAULTS.retentionPolicy,
			maxRows: ACTIVITY_LIMIT_DEFAULTS.maxRows,
			maxDbBytes: ACTIVITY_LIMIT_DEFAULTS.maxDbBytes,
			maxAgeMs: ACTIVITY_LIMIT_DEFAULTS.maxAgeMs,
		})
		expect(
			storageActivityLimits({
				maxRows: 5000,
				maxDbBytes: 32 * MiB,
				maxAgeMs: 1000,
				policy: "oldest-first",
			}),
		).toEqual({
			retentionPolicy: "oldest-first",
			maxRows: 5000,
			maxDbBytes: 32 * MiB,
			maxAgeMs: 1000,
		})
		expect(storageActivityLimits({ maxRows: 1 })).toBeNull()
	})

	it("maps the store stats and limits to the report block", () => {
		const limits = storageActivityLimits({ maxRows: 5000 })!
		expect(activityRetentionFromStats(stats, limits)).toEqual({
			policy: "fair-share",
			effective: "oldest-first",
			maxRows: 5000,
			maxDbBytes: limits.maxDbBytes,
			maxAgeMs: limits.maxAgeMs,
			rows: 1200,
			oldestReceivedAt: "2026-10-01T00:00:00.000Z",
			shares: [
				{
					key: "decoder:adsb",
					rows: 1000,
					bytes: 5000,
					oldestReceivedAt: null,
				},
			],
			sharesTruncated: true,
		})
	})

	it("reports the configured policy and no shares before the writer reports retention", () => {
		const limits = storageActivityLimits({ policy: "oldest-first" })!
		const { retention: _omit, ...early } = stats as unknown as Record<
			string,
			unknown
		>
		expect(
			activityRetentionFromStats(
				early as unknown as ActivityStoreStats,
				limits,
			),
		).toMatchObject({
			policy: "oldest-first",
			effective: null,
			shares: [],
			sharesTruncated: false,
		})
	})
})
