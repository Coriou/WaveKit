/**
 * Band defaults spec §5.3: the persisted API band override store.
 */
import { afterEach, describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import {
	BAND_OVERRIDE_FILE_NAME,
	BandOverrideStore,
} from "../../../src/decoders/band-override-store.js"
import { BAND_REGIONS } from "../../../src/decoders/band-region.js"
import type { DecoderBandOverride } from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const dirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "wavekit-band-store-"))
	dirs.push(dir)
	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		try {
			chmodSync(dir, 0o755)
		} catch {
			// already gone
		}
		rmSync(dir, { recursive: true, force: true })
	}
})

const override: DecoderBandOverride = {
	rangesHz: [{ minHz: 433_050_000, maxHz: 434_790_000 }],
	bandSuspension: false,
}

describe("BandOverrideStore", () => {
	it("starts empty without a file and creates it on the first write", async () => {
		const dir = join(tempDir(), "nested", "state")
		const store = new BandOverrideStore({ stateDir: dir, logger })
		await store.load()
		expect(store.get("dec")).toBeUndefined()
		expect(store.isPersisted()).toBe(true)
		expect(await store.set("dec", override)).toEqual({ persisted: true })
		const file = join(dir, BAND_OVERRIDE_FILE_NAME)
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			version: 1,
			overrides: { dec: override },
		})
		// tmp then rename: no temporary file is left behind.
		expect(readdirSync(dir)).toEqual([BAND_OVERRIDE_FILE_NAME])
		expect(await store.delete("dec")).toEqual({ persisted: true })
		expect(await store.delete("dec")).toEqual({ persisted: true })
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			version: 1,
			overrides: {},
		})
	})

	it("serializes concurrent writes in call order", async () => {
		const dir = tempDir()
		const store = new BandOverrideStore({ stateDir: dir, logger })
		await store.load()
		await Promise.all([
			store.set("a", { targetsHz: [1] }),
			store.set("b", { targetsHz: [2] }),
			store.delete("a"),
		])
		const fresh = new BandOverrideStore({ stateDir: dir, logger })
		await fresh.load()
		expect(fresh.get("a")).toBeUndefined()
		expect(fresh.get("b")).toEqual({ targetsHz: [2] })
	})

	it("keeps entries for unknown decoders in the file", async () => {
		const dir = tempDir()
		writeFileSync(
			join(dir, BAND_OVERRIDE_FILE_NAME),
			JSON.stringify({ version: 1, overrides: { gone: { targetsHz: [5] } } }),
		)
		const store = new BandOverrideStore({ stateDir: dir, logger })
		await store.load()
		await store.set("dec", override)
		const saved = JSON.parse(
			readFileSync(join(dir, BAND_OVERRIDE_FILE_NAME), "utf8"),
		) as { overrides: Record<string, unknown> }
		expect(Object.keys(saved.overrides).sort()).toEqual(["dec", "gone"])
	})

	it("never overwrites a file of an unknown version", async () => {
		const dir = tempDir()
		const file = join(dir, BAND_OVERRIDE_FILE_NAME)
		const newer = JSON.stringify({ version: 2, overrides: { x: { y: 1 } } })
		writeFileSync(file, newer)
		const store = new BandOverrideStore({ stateDir: dir, logger })
		await store.load()
		expect(store.get("x")).toBeUndefined()
		expect(store.isPersisted()).toBe(false)
		expect(await store.set("dec", override)).toEqual({ persisted: false })
		expect(store.get("dec")).toEqual(override)
		expect(readFileSync(file, "utf8")).toBe(newer)
	})

	it("an unwritable directory keeps the override in memory only", async () => {
		const dir = tempDir()
		chmodSync(dir, 0o500)
		const store = new BandOverrideStore({ stateDir: dir, logger })
		await store.load()
		const result = await store.set("dec", override)
		// Root ignores directory permissions; only assert when they apply.
		if (process.getuid?.() !== 0) {
			expect(result).toEqual({ persisted: false })
			expect(store.isPersisted()).toBe(false)
		}
		expect(store.get("dec")).toEqual(override)
	})

	it("an in-memory store reports persisted: false and never touches the disk", async () => {
		const store = BandOverrideStore.inMemory(logger)
		await store.load()
		expect(store.getFilePath()).toBeNull()
		expect(await store.set("dec", override)).toEqual({ persisted: false })
		expect(store.get("dec")).toEqual(override)
		expect(store.isPersisted()).toBe(false)
	})

	const hz = fc.integer({ min: 1, max: 6_000_000_000 })
	const overrideArb: fc.Arbitrary<DecoderBandOverride> = fc
		.record(
			{
				rangesHz: fc.array(
					fc
						.tuple(hz, fc.integer({ min: 0, max: 100_000_000 }))
						.map(([minHz, width]) => ({ minHz, maxHz: minHz + width })),
					{ minLength: 1, maxLength: 4 },
				),
				targetsHz: fc.array(hz, { minLength: 1, maxLength: 4 }),
				region: fc.constantFrom(...BAND_REGIONS),
				bandSuspension: fc.boolean(),
			},
			{ requiredKeys: [] },
		)
		.filter(o => Object.keys(o).length > 0)

	it("round-trips any valid map and loads any bytes without throwing", async () => {
		// Feature: decoder-band-defaults, Property 7: Store round-trip and robustness
		// Validates: §5.3
		const dir = tempDir()
		const file = join(dir, BAND_OVERRIDE_FILE_NAME)
		await fc.assert(
			fc.asyncProperty(
				fc.dictionary(
					fc
						.string({ minLength: 1, maxLength: 12 })
						.filter(
							key => !["__proto__", "constructor", "prototype"].includes(key),
						),
					overrideArb,
					{ maxKeys: 4 },
				),
				fc.uint8Array({ maxLength: 64 }),
				async (map, bytes) => {
					rmSync(file, { force: true })
					const store = new BandOverrideStore({ stateDir: dir, logger })
					await store.load()
					for (const [id, value] of Object.entries(map))
						await store.set(id, value)
					const fresh = new BandOverrideStore({ stateDir: dir, logger })
					await fresh.load()
					for (const [id, value] of Object.entries(map))
						expect(fresh.get(id)).toEqual(value)

					writeFileSync(file, bytes)
					const robust = new BandOverrideStore({ stateDir: dir, logger })
					await expect(robust.load()).resolves.toBeUndefined()
				},
			),
			{ numRuns: 100 },
		)
		expect(existsSync(dir)).toBe(true)
	}, 60_000) // every set is a real fsync + rename; slow under full-suite load
})
