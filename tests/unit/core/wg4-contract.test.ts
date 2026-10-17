/**
 * WG4 frozen contract (docs/specs/web-gaps-4, task 0.1): additive DTOs, the live-demod `agc`
 * key without a default, the station origins accessor, the station write constant and the
 * provider slots. No behaviour beyond defaults.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as Api from "@wavekit/api-types"
import {
	ACTIVITY_TRAILS_DEFAULT_WINDOW_MS,
	ACTIVITY_TRAILS_MAX_ENTITIES,
	ACTIVITY_TRAILS_MAX_ENTITY_KEYS,
	ACTIVITY_TRAILS_MAX_POINTS,
	ACTIVITY_TRAILS_MAX_POINTS_PER_ENTITY,
	ACTIVITY_TRAILS_MAX_WINDOW_MS,
	ACTIVITY_TRAILS_SCAN_ROWS,
	LIVE_AUDIO_AGC_MODES,
	STATION_ESTIMATE_CACHE_MS,
	STATION_ESTIMATE_MIN_UNCERTAINTY_KM,
	STATION_ESTIMATE_ROUNDING_DEG,
	STATION_ESTIMATE_UNCERTAINTY_STEP_KM,
	STATION_FIELDS,
	STORAGE_AREA_CLASS,
	STORAGE_AREA_IDS,
	STORAGE_REPORT_CACHE_MS,
	STORAGE_SCAN_MAX_DEPTH,
	STORAGE_SCAN_MAX_ENTRIES,
	STORAGE_SCAN_MAX_WALL_MS,
} from "@wavekit/api-types"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import {
	ConfigSchema,
	LiveDemodConfigSchema,
	loadConfig,
	stationIdentity,
	stationOrigins,
} from "../../../src/config.js"
import type { Config } from "../../../src/config.js"
import { inertActivityService } from "../../../src/core/activity/runtime.js"
import type * as Contract from "../../../src/core/activity/storage/contract.js"
import {
	STATION_ESTIMATE_MAX_POINTS,
	STATION_ESTIMATE_MIN_DIRECT,
	STATION_ESTIMATE_MIN_ENTITIES,
	STATION_ESTIMATE_WEIGHTS,
} from "../../../src/core/station-estimate/contract.js"
import type { StationEstimateProvider } from "../../../src/core/station-estimate/contract.js"
import {
	STATION_COVERAGE_RESET_M,
	STATION_STORE_FILE,
	STATION_STORE_MAX_BYTES,
	STATION_STORE_SCHEMA_VERSION,
	STATION_WRITE_REQUIRES_ACCESS,
} from "../../../src/core/station/contract.js"
import type { StationService } from "../../../src/core/station/contract.js"
import { STORAGE_SCAN_FS_CONCURRENCY } from "../../../src/core/storage-report/contract.js"
import type { StorageReportProvider } from "../../../src/core/storage-report/contract.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
const same = <A, B>(value: Same<A, B>): Same<A, B> => value

describe("WG4 contract", () => {
	let directory: string
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "wg4-contract-"))
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(directory, { recursive: true, force: true })
	})

	it("keeps the trails DTO copies identical and the bounds pinned", () => {
		// Feature: web-gaps-4, requirement 1.3 and 1.4
		expect(
			same<Api.ActivityTrailsQuery, Contract.ActivityTrailsQuery>(true),
		).toBe(true)
		expect(
			same<Api.ActivityTrailPoint, Contract.ActivityTrailPoint>(true),
		).toBe(true)
		expect(same<Api.ActivityTrail, Contract.ActivityTrail>(true)).toBe(true)
		expect(same<Api.ActivityTrails, Contract.ActivityTrails>(true)).toBe(true)
		expect(
			same<Api.ActivityTrailsTruncation, Contract.ActivityTrailsTruncation>(
				true,
			),
		).toBe(true)
		// "time-limit" was added after the freeze (additive): the reader's wall budget
		expect(
			same<
				Api.ActivityTrailsTruncation,
				"scan-rows" | "points" | "entities" | "per-entity" | "time-limit"
			>(true),
		).toBe(true)
		expect(ACTIVITY_TRAILS_DEFAULT_WINDOW_MS).toBe(3_600_000)
		expect(ACTIVITY_TRAILS_MAX_WINDOW_MS).toBe(86_400_000)
		expect(ACTIVITY_TRAILS_MAX_POINTS).toBe(20_000)
		expect(ACTIVITY_TRAILS_MAX_ENTITIES).toBe(2_000)
		expect(ACTIVITY_TRAILS_MAX_POINTS_PER_ENTITY).toBe(1_440)
		expect(ACTIVITY_TRAILS_SCAN_ROWS).toBe(200_000)
		expect(ACTIVITY_TRAILS_MAX_ENTITY_KEYS).toBe(64)
	})

	it("requires a trails method that the inert service rejects", async () => {
		const service = inertActivityService()
		expect(service.trails).toBeTypeOf("function")
		await expect(service.trails({})).rejects.toMatchObject({
			code: "ACTIVITY_UNAVAILABLE",
		})
	})

	it("parses liveDemod.agc without a default", () => {
		// Feature: web-gaps-4, requirement 4.1 and 4.2
		expect(LiveDemodConfigSchema.parse({}).agc).toBeUndefined()
		expect(LiveDemodConfigSchema.parse({ agc: "slow" }).agc).toBe("slow")
		expect(LiveDemodConfigSchema.safeParse({ agc: "medium" }).success).toBe(
			false,
		)
		expect([...LIVE_AUDIO_AGC_MODES]).toEqual(["off", "slow", "fast"])
		const parsed = ConfigSchema.parse({ liveDemod: {} })
		expect(parsed.liveDemod?.agc).toBeUndefined()
		expect(
			same<
				NonNullable<Config["liveDemod"]>["agc"],
				Api.LiveAudioAgcMode | undefined
			>(true),
		).toBe(true)
	})

	it("exports station origins and keeps the field list in step with the schema", () => {
		// Feature: web-gaps-4, requirement 6.3
		expect(same<keyof Config["station"], Api.StationField>(true)).toBe(true)
		expect([...STATION_FIELDS]).toEqual([
			"name",
			"lat",
			"lon",
			"altM",
			"callsign",
			"country",
		])
		expect(stationOrigins(ConfigSchema.parse({}))).toEqual({})
		expect(
			stationOrigins(ConfigSchema.parse({ station: { name: "Home" } })),
		).toEqual({ name: "yaml" })
		const path = join(directory, "config.yaml")
		writeFileSync(path, "station: {name: Home, lat: 48.5, lon: 2.5}\n")
		vi.stubEnv("WAVEKIT_STATION__LAT", "45")
		const loaded = loadConfig(path)
		expect(stationOrigins(loaded)).toEqual({
			name: "yaml",
			lat: "env",
			lon: "yaml",
		})
		// stationIdentity is unchanged: it never reports the ui layer itself.
		expect(stationIdentity(loaded, "EU").lat).toEqual({
			value: 45,
			provenance: "env",
		})
		const provenance: Api.StationProvenance = "ui"
		expect(provenance).toBe("ui")
	})

	it("pins the station write constants", () => {
		// Feature: web-gaps-4, requirement 6.9 (E1 decided: protected-only)
		expect(STATION_WRITE_REQUIRES_ACCESS).toBe(true)
		expect(STATION_STORE_FILE).toBe("station.json")
		expect(STATION_STORE_SCHEMA_VERSION).toBe(1)
		expect(STATION_STORE_MAX_BYTES).toBe(4096)
		expect(STATION_COVERAGE_RESET_M).toBe(1_000)
	})

	it("pins the estimate and storage constants", () => {
		expect(STATION_ESTIMATE_ROUNDING_DEG).toBe(0.05)
		expect(STATION_ESTIMATE_MIN_UNCERTAINTY_KM).toBe(10)
		expect(STATION_ESTIMATE_UNCERTAINTY_STEP_KM).toBe(5)
		expect(STATION_ESTIMATE_CACHE_MS).toBe(60_000)
		expect(STATION_ESTIMATE_WEIGHTS).toEqual({
			meshDirect: 4,
			meshRelayed: 1,
			aprsDirect: 2,
			aprsRelayed: 1,
			vessel: 1,
			aircraft: 1,
		})
		expect(STATION_ESTIMATE_MIN_ENTITIES).toBe(10)
		expect(STATION_ESTIMATE_MIN_DIRECT).toBe(3)
		expect(STATION_ESTIMATE_MAX_POINTS).toBe(8_000)
		expect(Object.keys(STORAGE_AREA_CLASS).sort()).toEqual(
			[...STORAGE_AREA_IDS].sort(),
		)
		expect(STORAGE_SCAN_MAX_ENTRIES).toBe(50_000)
		expect(STORAGE_SCAN_MAX_DEPTH).toBe(16)
		expect(STORAGE_SCAN_MAX_WALL_MS).toBe(2_000)
		expect(STORAGE_REPORT_CACHE_MS).toBe(30_000)
		expect(STORAGE_SCAN_FS_CONCURRENCY).toBe(8)
	})

	it("keeps every WG4 DTO field and server slot optional", () => {
		const position: Pick<Api.MeshPosition, "fixAt"> = {}
		const host: Pick<Api.SdrHostStatus, "version"> = {}
		const audio: Pick<Api.LiveAudioConfig, "agc"> = {}
		const status: Pick<Api.LiveAudioStatus, "agc"> = {}
		const station: Pick<Api.StationIdentity, "revision" | "writable"> = {}
		const slots: Pick<
			ApiServerDependencies,
			"storageReport" | "stationEstimate" | "stationService"
		> = {}
		expect([position, host, audio, status, station, slots]).toEqual([
			{},
			{},
			{},
			{},
			{},
			{},
		])
		expect(
			same<
				ApiServerDependencies["storageReport"],
				StorageReportProvider | undefined
			>(true),
		).toBe(true)
		expect(
			same<
				ApiServerDependencies["stationEstimate"],
				StationEstimateProvider | undefined
			>(true),
		).toBe(true)
		expect(
			same<ApiServerDependencies["stationService"], StationService | undefined>(
				true,
			),
		).toBe(true)
	})
})
