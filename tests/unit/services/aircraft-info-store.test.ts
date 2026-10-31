/**
 * AircraftInfoStore: the tar1090-db import runs in a worker thread when its entry is
 * built, otherwise on the main thread in committed slices with a yield between each,
 * and is abortable either way. Structural checks only, no wall-clock thresholds.
 */

import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"
import { build } from "esbuild"
import type * as FsPromises from "node:fs/promises"
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest"
import {
	AIRCRAFT_DB_TABLE,
	AircraftInfoStore,
	IMPORT_SLICE_ROWS,
	type AircraftDbFile,
} from "../../../src/services/aircraft-info/store.js"
import type { SqliteDatabase } from "../../../src/core/activity/storage/sqlite.js"
import { WaveKitError } from "../../../src/utils/errors.js"

/** Milliseconds every fs.promises.rm waits before it runs (0: no delay). */
const fsDelay = vi.hoisted(() => ({ rmMs: 0 }))
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromises>()
	return {
		...actual,
		rm: async (...args: Parameters<typeof actual.rm>) => {
			if (fsDelay.rmMs > 0)
				await new Promise(resolve => setTimeout(resolve, fsDelay.rmMs))
			return actual.rm(...args)
		},
	}
})

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const roots: string[] = []
let workerUrl: URL

const hexOf = (i: number) =>
	(0x0a0b00 + i).toString(16).toUpperCase().padStart(6, "0")

/** n fictional rows: 0A0B00 upwards, registrations N0WK0, N0WK1, ... */
function csv(n: number, owner = "WaveKit Test"): string {
	const out: string[] = []
	for (let i = 0; i < n; i++) {
		const hex = hexOf(i)
		out.push(`${hex};N0WK${i};A320;0000;WAVEKIT TEST ${i};2005;${owner};`)
	}
	return out.join("\n") + "\n"
}

function dir(): string {
	const d = mkdtempSync(join(tmpdir(), "wk-aircraft-store-"))
	roots.push(d)
	return d
}

async function gz(at: string, n: number, owner?: string): Promise<string> {
	const file = join(at, "aircraft-db.csv.gz")
	await writeFile(file, gzipSync(csv(n, owner)))
	return file
}

function fileStore(at: string, worker?: URL): AircraftInfoStore {
	const file: AircraftDbFile = { path: join(at, "aircraft-db.sqlite") }
	if (worker) file.workerUrl = worker
	return new AircraftInfoStore(
		new DatabaseSync(
			join(at, "aircraft-info.sqlite"),
		) as unknown as SqliteDatabase,
		Date.now,
		undefined,
		undefined,
		file,
	)
}

beforeAll(async () => {
	// Placed in the repo so Node resolves the external @wavekit/shared, as
	// scripts/build-file.mjs emits workers: esm, packages external.
	const bundleDir = mkdtempSync(join(repository, ".tmp-aircraft-db-worker-"))
	roots.push(bundleDir)
	const outfile = join(bundleDir, "aircraft-db-worker.mjs")
	await build({
		absWorkingDir: repository,
		entryPoints: ["src/services/aircraft-info/aircraft-db-worker.ts"],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "error",
	})
	workerUrl = pathToFileURL(outfile)
})

const stores: AircraftInfoStore[] = []
afterEach(() => {
	fsDelay.rmMs = 0
	for (const s of stores.splice(0)) s.close()
})
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("AircraftInfoStore tar1090-db import", () => {
	it("builds the database in a worker thread and swaps the file in", async () => {
		const at = dir()
		const store = fileStore(at, workerUrl)
		stores.push(store)
		const first = await store.importAircraftDbFile(await gz(at, 3_000))
		expect(first).toEqual({ rows: 3_000, offThread: true })
		// nothing was inserted on this thread
		expect(store.slices).toBe(0)
		expect(store.localAircraftCount()).toBe(3_000)
		expect(store.localAircraft("0A0B05")?.registration).toBe("N0WK5")
		expect(store.hexForRegistration("N0WK5")).toBe("0A0B05")
		expect(existsSync(join(at, "aircraft-db.sqlite.next"))).toBe(false)
		// a refresh replaces the rows: the new owner, no row left from before
		const again = await store.importAircraftDbFile(
			await gz(at, 10, "WaveKit Second"),
		)
		expect(again).toEqual({ rows: 10, offThread: true })
		expect(store.localAircraftCount()).toBe(10)
		expect(store.localAircraft("0A0B05")?.owner).toBe("WaveKit Second")
		expect(store.localAircraft("0A0B20")).toBeUndefined()
		// a restart reads the swapped file
		store.close()
		stores.pop()
		const reopened = fileStore(at, workerUrl)
		stores.push(reopened)
		expect(reopened.localAircraftCount()).toBe(10)
		expect(reopened.hexForRegistration("N0WK9")).toBe("0A0B09")
	})

	it("aborting terminates the worker, deletes the unfinished file and keeps the old rows", async () => {
		const at = dir()
		const store = fileStore(at, workerUrl)
		stores.push(store)
		await store.importAircraftDbFile(await gz(at, 5))
		const abort = new AbortController()
		const running = store.importAircraftDbFile(await gz(at, 50_000), {
			signal: abort.signal,
		})
		abort.abort()
		await expect(running).rejects.toThrow()
		expect(existsSync(join(at, "aircraft-db.sqlite.next"))).toBe(false)
		expect(store.localAircraftCount()).toBe(5)
		expect(store.localAircraft("0A0B04")?.registration).toBe("N0WK4")
	})

	it("without a built worker, imports on the main thread in committed slices that yield", async () => {
		const at = dir()
		const missing = pathToFileURL(join(at, "no-such-worker.js"))
		const store = fileStore(at, missing)
		stores.push(store)
		// rows past one slice: at least ceil(1,201 / 500) = 3 slices
		const rows = IMPORT_SLICE_ROWS * 2 + 201
		let ticks = 0
		const timer = setInterval(() => ticks++, 0)
		const done = await store.importAircraftDbFile(await gz(at, rows))
		clearInterval(timer)
		expect(done).toEqual({ rows, offThread: false })
		expect(store.slices).toBeGreaterThanOrEqual(3)
		// the event loop ran timers while the import was under way
		expect(ticks).toBeGreaterThan(0)
		expect(store.localAircraftCount()).toBe(rows)
		expect(store.hexForRegistration("N0WK1200")).toBe(hexOf(1200))
		expect(existsSync(join(at, "aircraft-db.sqlite.next"))).toBe(false)
	})

	it("slices hold at most sliceRows rows, at and past the bound", async () => {
		const at = dir()
		const store = fileStore(at)
		stores.push(store)
		// exactly 2 x 4 rows: 2 slices; one more row: a third
		await store.importAircraftDbFile(await gz(at, 8), { sliceRows: 4 })
		expect(store.slices).toBe(2)
		await store.importAircraftDbFile(await gz(at, 9), { sliceRows: 4 })
		expect(store.slices).toBe(2 + 3)
		expect(store.localAircraftCount()).toBe(9)
	})

	it("aborting between main-thread slices keeps the old rows", async () => {
		const at = dir()
		const store = fileStore(at)
		stores.push(store)
		await store.importAircraftDbFile(await gz(at, 3))
		const abort = new AbortController()
		const file = await gz(at, 100)
		const running = store.importAircraftDbFile(file, {
			signal: abort.signal,
			sliceRows: 10,
		})
		setImmediate(() => abort.abort())
		await expect(running).rejects.toThrow()
		expect(store.localAircraftCount()).toBe(3)
		expect(existsSync(join(at, "aircraft-db.sqlite.next"))).toBe(false)
	})

	it("without a file, swaps a side table and alternates its index name", async () => {
		const store = new AircraftInfoStore(
			new DatabaseSync(":memory:") as unknown as SqliteDatabase,
		)
		stores.push(store)
		async function* lines(text: string) {
			for (const line of text.split("\n")) yield line
		}
		for (const n of [4, 6, 2]) {
			expect(
				await store.replaceAircraftDb(lines(csv(n)), { sliceRows: 3 }),
			).toBe(n)
			expect(store.localAircraftCount()).toBe(n)
			expect(store.hexForRegistration(`N0WK${n - 1}`)).toBe(hexOf(n - 1))
		}
	})

	it("reads the file only after its async setup: a slow cleanup still imports every row", async () => {
		const at = dir()
		const store = fileStore(at)
		stores.push(store)
		fsDelay.rmMs = 50
		const done = await store.importAircraftDbFile(await gz(at, 1))
		expect(done).toEqual({ rows: 1, offThread: false })
		expect(store.localAircraft("0A0B00")?.registration).toBe("N0WK0")
	})

	it("without a file, a large leftover side table is dropped before the file is read", async () => {
		const at = dir()
		const db = new DatabaseSync(":memory:")
		const store = new AircraftInfoStore(db as unknown as SqliteDatabase)
		stores.push(store)
		db.exec(AIRCRAFT_DB_TABLE("main", "aircraft_db_next"))
		db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19999)
INSERT INTO aircraft_db_next (hex, reg) SELECT printf('%06X', 0x0A0000 + i), 'ZZ-WK' || i FROM n`)
		expect(
			db.prepare("SELECT count(*) AS n FROM aircraft_db_next").get()?.["n"],
		).toBe(20_000)
		const done = await store.importAircraftDbFile(await gz(at, 3))
		expect(done).toEqual({ rows: 3, offThread: false })
		expect(store.localAircraftCount()).toBe(3)
		expect(store.hexForRegistration("N0WK2")).toBe("0A0B02")
	})

	it("a missing download rejects with a WaveKitError on every import path", async () => {
		const at = dir()
		const missing = join(at, "no-such-file.csv.gz")
		const memory = new AircraftInfoStore(
			new DatabaseSync(":memory:") as unknown as SqliteDatabase,
		)
		const slices = fileStore(at)
		const worker = fileStore(dir(), workerUrl)
		stores.push(memory, slices, worker)
		for (const store of [memory, slices, worker])
			await expect(store.importAircraftDbFile(missing)).rejects.toBeInstanceOf(
				WaveKitError,
			)
		expect(existsSync(join(at, "aircraft-db.sqlite.next"))).toBe(false)
		expect(memory.localAircraftCount()).toBe(0)
	})
})
