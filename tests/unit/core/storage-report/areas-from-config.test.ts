import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { STORAGE_AREA_IDS } from "@wavekit/api-types"
import {
	activityRetentionFromStats,
	dsdFmeRecordingDir,
	liveStorageReportSources,
	storageActivityLimits,
	type StorageScannerStorage,
	storageAreasFromConfig,
	type StorageAreaInputs,
} from "../../../../src/core/storage-report/areas-from-config.js"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import { scanStorageAreas } from "../../../../src/core/storage-report/scan.js"
import type { StorageScanFs } from "../../../../src/core/storage-report/scan.js"
import {
	disjointStorageAreas,
	isPathInside,
} from "../../../../src/core/storage-report/roots.js"
import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"

/** Every path exists: `.json` names are files, the rest directories; no realpath (text). */
const everyPathFs: StorageScanFs = {
	lstat: p =>
		Promise.resolve({
			size: 1,
			isFile: () => p.endsWith(".json"),
			isDirectory: () => !p.endsWith(".json"),
			isSymbolicLink: () => false,
		}),
	readdir: () => Promise.resolve([]),
}

const disjoint = (areas: StorageAreaSource[]) =>
	disjointStorageAreas(areas, everyPathFs)
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
				paths: [
					join(stateDir, "operator-data"),
					join(stateDir, "recording-keeps.json"),
				],
				capBytes: null,
			},
			{ id: "access", paths: ["/run/wavekit/access"], capBytes: null },
			{
				id: "decoder-overrides",
				paths: [
					join(stateDir, "decoder-band-overrides.json"),
					join(stateDir, "decoder-settings.json"),
				],
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

	it("collects every recording dsd-fme dir once; those inside the scanner dir are excluded from it", async () => {
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
		const walked = await disjoint(areas)
		expect(walked[1]?.exclude).toEqual([inside])
		const none = storageAreasFromConfig(inputs())
		expect(none[2]).toEqual({
			id: "digital-voice-wav",
			paths: [],
			capBytes: null,
		})
		expect((await disjoint(none))[1]).not.toHaveProperty("exclude")
	})

	it("treats names starting with .. as inside, the parent and siblings as outside", async () => {
		expect(isPathInside("/s/scanner/..calls", "/s/scanner")).toBe(true)
		expect(isPathInside("/s/scanner/...", "/s/scanner")).toBe(true)
		expect(isPathInside("/s/scanner", "/s/scanner")).toBe(true)
		expect(isPathInside("/s", "/s/scanner")).toBe(false)
		expect(isPathInside("/s/scanner2", "/s/scanner")).toBe(false)
		expect(isPathInside("/s/other/x", "/s/scanner")).toBe(false)
		const dotted = join(stateDir, "scanner", "..calls")
		const areas = await disjoint(
			storageAreasFromConfig(
				inputs({
					decoders: [
						{ type: "dsd-fme", options: { output: "wav", wavDir: dotted } },
					],
				}),
			),
		)
		expect(areas[1]?.exclude).toEqual([dotted])
	})

	it("collapses nested roots of one area and excludes roots nested in another area", async () => {
		const areas = await disjoint(
			storageAreasFromConfig(
				inputs({
					decoders: [
						{
							type: "dsd-fme",
							options: { output: "wav", wavDir: "/d/wav/nested" },
						},
						{ type: "dsd-fme", options: { output: "wav", wavDir: "/d/wav" } },
					],
					accessDirectory: join(stateDir, "operator-data", "access"),
					logsDir: join(stateDir, "activity", "logs"),
				}),
			),
		)
		const byId = new Map(areas.map(a => [a.id, a]))
		expect(byId.get("digital-voice-wav")?.paths).toEqual(["/d/wav"])
		expect(byId.get("operator-data")?.exclude).toEqual([
			join(stateDir, "operator-data", "access"),
		])
		expect(byId.get("activity")?.exclude).toEqual([
			join(stateDir, "activity", "logs"),
		])
		// logging.dir = stateDir: every other area under it is excluded from logs.
		const wide = await disjoint(
			storageAreasFromConfig(inputs({ logsDir: stateDir })),
		)
		expect(wide.find(a => a.id === "logs")?.exclude).toEqual([
			join(stateDir, "activity"),
			join(stateDir, "scanner"),
			join(stateDir, "bandplans"),
			join(stateDir, "operator-data"),
			join(stateDir, "recording-keeps.json"),
			join(stateDir, "decoder-band-overrides.json"),
			join(stateDir, "decoder-settings.json"),
			join(stateDir, "station.json"),
		])
		// A shared root belongs to the later area only.
		const shared = await disjoint(
			storageAreasFromConfig(
				inputs({
					scannerStorage: { dir: "/d/wav", maxRecordingsMb: 1 },
					decoders: [
						{ type: "dsd-fme", options: { output: "wav", wavDir: "/d/wav" } },
					],
				}),
			),
		)
		expect(shared[1]?.exclude).toEqual(["/d/wav"])
		expect(shared[2]).not.toHaveProperty("exclude")
	})

	it("counts every file once on a real tree with nested and symlinked roots", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-areas-"))
		try {
			const state = join(dir, "state")
			const write = async (path: string, bytes: number) => {
				await mkdir(join(path, ".."), { recursive: true })
				await writeFile(path, Buffer.alloc(bytes))
			}
			await write(join(dir, "wav", "nested", "call.wav"), 10)
			await write(join(state, "activity", "logs", "wavekit.log"), 7)
			await write(join(state, "activity", "activity.db"), 5)
			await write(join(state, "operator-data", "access", "key"), 3)
			await write(join(state, "scanner", "..calls", "a.wav"), 2)
			await symlink(join(dir, "wav"), join(state, "scanner", "link"))
			const areas = storageAreasFromConfig(
				inputs({
					stateDir: state,
					decoders: [
						{
							type: "dsd-fme",
							options: { output: "wav", wavDir: join(dir, "wav") },
						},
						{
							type: "dsd-fme",
							options: { output: "wav", wavDir: join(dir, "wav", "nested") },
						},
						{
							type: "dsd-fme",
							options: {
								output: "wav",
								wavDir: join(state, "scanner", "..calls"),
							},
						},
					],
					accessDirectory: join(state, "operator-data", "access"),
					logsDir: join(state, "activity", "logs"),
				}),
			)
			const scans = await scanStorageAreas(areas)
			const byId = new Map(scans.map(scan => [scan.id, scan]))
			expect(byId.get("digital-voice-wav")).toMatchObject({
				bytes: 12,
				files: 2,
			})
			expect(byId.get("activity")).toMatchObject({ bytes: 5, files: 1 })
			expect(byId.get("logs")).toMatchObject({ bytes: 7, files: 1 })
			expect(byId.get("access")).toMatchObject({ bytes: 3, files: 1 })
			expect(byId.get("operator-data")).toMatchObject({ bytes: 0, files: 0 })
			// The symlink counts as one entry of its own size and is not followed.
			expect(byId.get("scanner-evidence")?.files).toBe(1)
			const total = scans.reduce((sum, scan) => sum + scan.files, 0)
			expect(total).toBe(6)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("resolves roots by real path: a symlinked alias neither drops nor double-counts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-areas-"))
		try {
			await mkdir(join(dir, "wav", "nested"), { recursive: true })
			await writeFile(join(dir, "wav", "nested", "call.wav"), Buffer.alloc(10))
			await symlink(join(dir, "wav"), join(dir, "alias"))
			const wavArea = (paths: string[]): StorageAreaSource[] => [
				{ id: "digital-voice-wav", paths, capBytes: null },
			]
			const count = async (paths: string[]) => {
				const [scan] = await scanStorageAreas(wavArea(paths))
				return { files: scan?.files, bytes: scan?.bytes }
			}
			const link = (await lstat(join(dir, "alias"))).size
			// alias is a symlink: its walk counts the link only, so alias/nested stays.
			expect(
				await count([join(dir, "alias"), join(dir, "alias", "nested")]),
			).toEqual({ files: 2, bytes: link + 10 })
			// wav's walk reaches alias/nested (same real directory): counted once.
			expect(
				await count([join(dir, "wav"), join(dir, "alias", "nested")]),
			).toEqual({ files: 1, bytes: 10 })
			// Across areas: the scanner dir reached through the alias is excluded from wav.
			const [wav, scanner] = await scanStorageAreas([
				{ id: "digital-voice-wav", paths: [join(dir, "wav")], capBytes: null },
				{
					id: "scanner-evidence",
					paths: [join(dir, "alias", "nested")],
					capBytes: null,
				},
			])
			expect(wav).toMatchObject({ files: 0, bytes: 0, exists: true })
			expect(scanner).toMatchObject({ files: 1, bytes: 10, exists: true })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("a symlink root inside another root counts its link entry once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-areas-"))
		try {
			await mkdir(join(dir, "d"))
			await mkdir(join(dir, "target"))
			await writeFile(join(dir, "d", "f"), Buffer.alloc(4))
			await writeFile(join(dir, "target", "t"), Buffer.alloc(10))
			await symlink(join(dir, "target"), join(dir, "d", "alias"))
			const link = (await lstat(join(dir, "d", "alias"))).size
			const [scanner, wav] = await scanStorageAreas([
				{ id: "scanner-evidence", paths: [join(dir, "d")], capBytes: null },
				{
					id: "digital-voice-wav",
					paths: [join(dir, "d", "alias")],
					capBytes: null,
				},
			])
			expect(scanner).toMatchObject({ files: 1, bytes: 4 })
			expect(wav).toMatchObject({ files: 1, bytes: link })
			// In one area the nested link root collapses into its parent's walk.
			const [both] = await scanStorageAreas([
				{
					id: "digital-voice-wav",
					paths: [join(dir, "d"), join(dir, "d", "alias")],
					capBytes: null,
				},
			])
			expect(both).toMatchObject({ files: 2, bytes: 4 + link })
			// The same link listed twice by two areas counts in the later one.
			const [first, second] = await scanStorageAreas([
				{
					id: "scanner-evidence",
					paths: [join(dir, "d", "alias")],
					capBytes: null,
				},
				{
					id: "digital-voice-wav",
					paths: [join(dir, "d", "alias")],
					capBytes: null,
				},
			])
			expect(first).toMatchObject({ files: 0, exists: true })
			expect(second).toMatchObject({ files: 1, bytes: link })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("collapses case aliases on a case-insensitive filesystem", async ctx => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-areas-"))
		try {
			await mkdir(join(dir, "Wav", "nested"), { recursive: true })
			await writeFile(join(dir, "Wav", "nested", "call.wav"), Buffer.alloc(10))
			const insensitive = await lstat(join(dir, "wav")).then(
				() => true,
				() => false,
			)
			if (!insensitive) ctx.skip()
			const [scan] = await scanStorageAreas([
				{
					id: "digital-voice-wav",
					paths: [
						join(dir, "WAV"),
						join(dir, "wav", "NESTED"),
						join(dir, "Wav"),
					],
					capBytes: null,
				},
			])
			expect(scan).toMatchObject({ files: 1, bytes: 10 })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("an excluded root that exists reports exists: true", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-areas-"))
		try {
			await mkdir(join(dir, "shared"))
			await writeFile(join(dir, "shared", "a"), Buffer.alloc(4))
			const [scanner, wav] = await scanStorageAreas([
				{
					id: "scanner-evidence",
					paths: [join(dir, "shared")],
					capBytes: null,
				},
				{
					id: "digital-voice-wav",
					paths: [join(dir, "shared")],
					capBytes: null,
				},
			])
			expect(scanner).toMatchObject({ exists: true, files: 0, bytes: 0 })
			expect(wav).toMatchObject({ exists: true, files: 1, bytes: 4 })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("reports no scanner cap when the scanner is not running", () => {
		const areas = storageAreasFromConfig(inputs({ scannerEnabled: false }))
		expect(areas[1]).toMatchObject({ id: "scanner-evidence", capBytes: null })
		expect(storageAreasFromConfig(inputs())[1]?.capBytes).toBe(512 * MiB)
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

describe("liveStorageReportSources (WG5: areas follow runtime changes)", () => {
	const MiB = 1024 * 1024
	const configured: StorageScannerStorage = {
		dir: "/cfg/scanner",
		maxRecordingsMb: 10,
		minFreeDiskMb: 100,
	}

	it("reads the scanner settings and decoders at each call", async () => {
		let storage: StorageScannerStorage = { ...configured }
		let running = true
		const scanner = { settings: () => ({ storage }) }
		let decoders: StorageAreaInputs["decoders"] = []
		const sources = liveStorageReportSources({
			stateDir: "/state",
			activityMaxDbBytes: 5,
			scannerStorage: configured,
			scanner: () => (running ? scanner : null),
			decoders: () => decoders,
			accessDirectory: null,
		})
		const area = (id: StorageAreaSource["id"]) =>
			sources.areas().find(a => a.id === id)
		expect(area("scanner-evidence")).toMatchObject({
			paths: [resolve("/cfg/scanner")],
			capBytes: 10 * MiB,
		})
		expect(area("digital-voice-wav")?.paths).toEqual([])
		expect(sources.minFreeBytes()).toBe(100 * MiB)

		// Runtime scanner settings and a new recording decoder show on the next call.
		storage = { dir: "/run/scanner", maxRecordingsMb: 20, minFreeDiskMb: 7 }
		decoders = [
			{ type: "dsd-fme", options: { output: "wav", wavDir: "/run/wav" } },
		]
		expect(area("scanner-evidence")).toMatchObject({
			paths: [resolve("/run/scanner")],
			capBytes: 20 * MiB,
		})
		expect(area("digital-voice-wav")?.paths).toEqual([resolve("/run/wav")])
		expect(sources.minFreeBytes()).toBe(7 * MiB)

		// The scanner gone: configured dir, no cap, no low-space threshold.
		running = false
		expect(area("scanner-evidence")).toMatchObject({
			paths: [resolve("/cfg/scanner")],
			capBytes: null,
		})
		expect(sources.minFreeBytes()).toBeNull()

		// Through the reporter: one provider read per scan, cached in between.
		running = true
		let t = 0
		const reporter = createStorageReporter(
			{
				stateDir: "/state",
				areas: sources.areas,
				minFreeBytes: sources.minFreeBytes,
				now: () => t,
			},
			{
				cacheMs: 1_000,
				statfs: () =>
					Promise.resolve({ blocks: 1, bfree: 1, bavail: 1, bsize: 1 }),
				scan: areas =>
					Promise.resolve(
						areas.map(a => ({
							id: a.id,
							bytes: 0,
							files: 0,
							exists: false,
							partialReason: null,
						})),
					),
			},
		)
		const cap = async () =>
			(await reporter.report()).areas.find(a => a.id === "scanner-evidence")
				?.cap
		expect(await cap()).toEqual({ bytes: 20 * MiB })
		storage = { ...storage, maxRecordingsMb: 30, minFreeDiskMb: 9 }
		expect(await cap()).toEqual({ bytes: 20 * MiB })
		t = 1_000
		expect(await cap()).toEqual({ bytes: 30 * MiB })
		expect((await reporter.report()).lowSpace.minFreeBytes).toBe(9 * MiB)
	})
})
