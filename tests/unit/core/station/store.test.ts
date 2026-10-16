import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readdir, readFile, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	loadStationStore,
	seedStationRevision,
	STATION_STORE_TMP_SWEEP_MAX,
	writeStationStore,
} from "../../../../src/core/station/store.js"
import { makeTmp, removeTmp, stubLogger } from "./helpers.js"

const at = "2026-10-16T10:00:00.000Z"
let dir: string

beforeEach(async () => {
	dir = await makeTmp()
})
afterEach(async () => {
	await removeTmp(dir)
})

function file(fields: Record<string, unknown>, extra: object = {}): string {
	return JSON.stringify({ schemaVersion: 1, revision: 3, fields, ...extra })
}

async function corruptCopies(): Promise<string[]> {
	return (await readdir(dir)).filter(name =>
		name.startsWith("station.json.corrupt-"),
	)
}

describe("station store load", () => {
	it("missing file is an empty layer", async () => {
		const { logger, warn } = stubLogger()
		expect(await loadStationStore(dir, logger)).toEqual({
			revision: 0,
			fields: {},
		})
		expect(warn).not.toHaveBeenCalled()
	})

	it("loads a valid file", async () => {
		await writeFile(
			join(dir, "station.json"),
			file({
				name: { value: "Home", provenance: "ui", updatedAt: at },
				lat: { value: 51.5, provenance: "ui", updatedAt: at },
				lon: { value: -0.1, provenance: "ui", updatedAt: at },
			}),
		)
		const state = await loadStationStore(dir, stubLogger().logger)
		expect(state.revision).toBe(3)
		expect(state.fields.name?.value).toBe("Home")
		expect(state.fields.lat?.value).toBe(51.5)
	})

	it.each([
		["corrupt JSON", "{not json"],
		["5000-byte file", `${file({})}${" ".repeat(5000)}`],
		[
			"schemaVersion 2",
			JSON.stringify({ schemaVersion: 2, revision: 1, fields: {} }),
		],
		["array", "[]"],
	])("%s: warns once, quarantines, loads empty", async (_label, body) => {
		await writeFile(join(dir, "station.json"), body)
		const { logger, warn } = stubLogger()
		const state = await loadStationStore(dir, logger, () => 1234)
		// Seeded from the clock × 1000 (the lost file's revision is 3 or 1, both lower).
		expect(state).toEqual({ revision: 1_234_000, fields: {} })
		expect(warn).toHaveBeenCalledTimes(1)
		expect(await readdir(dir)).toEqual(["station.json.corrupt-1234"])
	})

	it("keeps at most one corrupt copy", async () => {
		await writeFile(join(dir, "station.json.corrupt-1"), "x")
		await writeFile(join(dir, "station.json.corrupt-2"), "y")
		await writeFile(join(dir, "station.json"), "garbage")
		await loadStationStore(dir, stubLogger().logger, () => 99)
		expect(await corruptCopies()).toEqual(["station.json.corrupt-99"])
	})

	it("ignores a stored lat without lon", async () => {
		await writeFile(
			join(dir, "station.json"),
			file({
				lat: { value: 51.5, provenance: "ui", updatedAt: at },
				callsign: { value: "G0ABC", provenance: "ui", updatedAt: at },
			}),
		)
		const state = await loadStationStore(dir, stubLogger().logger)
		expect(state.fields).toEqual({
			callsign: { value: "G0ABC", provenance: "ui", updatedAt: at },
		})
		expect(await corruptCopies()).toEqual([])
	})

	it("ignores a stored value failing validation", async () => {
		await writeFile(
			join(dir, "station.json"),
			file({
				country: { value: "XX", provenance: "ui", updatedAt: at },
				altM: { value: "high", provenance: "ui", updatedAt: at },
				name: { value: "ok", provenance: "yaml", updatedAt: at },
				callsign: { value: "G0ABC", provenance: "ui", updatedAt: at },
			}),
		)
		const state = await loadStationStore(dir, stubLogger().logger)
		expect(Object.keys(state.fields)).toEqual(["callsign"])
		expect(state.revision).toBe(3)
	})

	it("removes only stale leftover .tmp files of other processes", async () => {
		const old = new Date(Date.now() - 120_000)
		const leftover = async (name: string, stale: boolean) => {
			await writeFile(join(dir, name), "x")
			if (stale) await utimes(join(dir, name), old, old)
		}
		// The active-writer case: a live write of this process, and a fresh one of another.
		await leftover(`station.json.${process.pid}.tmp`, true)
		await leftover("station.json.4242.tmp", false)
		await leftover("station.json.4243.tmp", true)
		await leftover("station.json.abc.tmp", true)
		await leftover("other.json.1.tmp", true)
		const { logger, warn } = stubLogger()
		expect(await loadStationStore(dir, logger)).toEqual({
			revision: 0,
			fields: {},
		})
		expect(warn).not.toHaveBeenCalled()
		expect((await readdir(dir)).sort()).toEqual(
			[
				"other.json.1.tmp",
				`station.json.${process.pid}.tmp`,
				"station.json.4242.tmp",
				"station.json.abc.tmp",
			].sort(),
		)
	})

	it("removes at most STATION_STORE_TMP_SWEEP_MAX leftovers per open", async () => {
		const old = new Date(Date.now() - 120_000)
		const count = STATION_STORE_TMP_SWEEP_MAX + 4
		for (let index = 0; index < count; index += 1) {
			const name = join(dir, `station.json.${process.pid + 1 + index}.tmp`)
			await writeFile(name, "x")
			await utimes(name, old, old)
		}
		await loadStationStore(dir, stubLogger().logger)
		expect(await readdir(dir)).toHaveLength(4)
	})

	it("seeds max(now x 1000, lost + 1), falling back to now x 1000 when unsafe", () => {
		expect(seedStationRevision(1_000, undefined)).toBe(1_000_000)
		expect(seedStationRevision(1, 5_000)).toBe(5_001)
		expect(seedStationRevision(9, 3)).toBe(9_000)
		expect(seedStationRevision(9, Number.MAX_SAFE_INTEGER)).toBe(9_000)
		expect(seedStationRevision(9, 1e300)).toBe(9_000)
		const now = Date.now()
		expect(seedStationRevision(now, undefined)).toBe(now * 1_000)
		expect(Number.isSafeInteger(now * 1_000)).toBe(true)
	})

	it("seeds the revision after corruption and again on the next start", async () => {
		// The lost file's revision is still readable and above the clock seed: past it.
		await writeFile(
			join(dir, "station.json"),
			JSON.stringify({ schemaVersion: 2, revision: 5_000, fields: {} }),
		)
		const first = await loadStationStore(dir, stubLogger().logger, () => 1)
		expect(first.revision).toBe(5_001)
		// Second restart with no write in between: station.json is missing, the
		// quarantined copy is left, so the seed is the same rather than 0.
		expect(await readdir(dir)).toEqual(["station.json.corrupt-1"])
		const second = await loadStationStore(dir, stubLogger().logger, () => 2)
		expect(second.revision).toBe(5_001)
		// Unparseable: the clock seeds it.
		await writeFile(join(dir, "station.json"), "{garbage")
		const clock = await loadStationStore(dir, stubLogger().logger, () => 9)
		expect(clock.revision).toBe(9_000)
		const again = await loadStationStore(dir, stubLogger().logger, () => 10)
		expect(again.revision).toBe(10_000)
		// A lost revision at the counter's end does not exhaust the fresh layer.
		await writeFile(
			join(dir, "station.json"),
			JSON.stringify({
				schemaVersion: 1,
				revision: Number.MAX_SAFE_INTEGER,
				fields: [],
			}),
		)
		const max = await loadStationStore(dir, stubLogger().logger, () => 11)
		expect(max.revision).toBe(11_000)
	})
})

describe("station store write", () => {
	it("creates the directory, writes atomically and round-trips", async () => {
		const nested = join(dir, "a", "b")
		const state = {
			revision: 7,
			fields: {
				name: { value: "N", provenance: "ui" as const, updatedAt: at },
			},
		}
		await writeStationStore(nested, state)
		expect(await readdir(nested)).toEqual(["station.json"])
		const parsed = JSON.parse(
			await readFile(join(nested, "station.json"), "utf8"),
		) as unknown
		expect(parsed).toEqual({ schemaVersion: 1, ...state })
		expect(await loadStationStore(nested, stubLogger().logger)).toEqual(state)
	})
})
