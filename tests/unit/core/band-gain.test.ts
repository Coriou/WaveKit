import { describe, expect, it } from "vitest"
import fc from "fast-check"
import pino from "pino"
import {
	BAND_GAIN_MAX_ENTRIES,
	BAND_GAIN_MAX_HZ,
	BAND_GAIN_MAX_TENTHS_DB,
	BAND_GAIN_MIN_HZ,
} from "@wavekit/api-types"
import type { BandGainEntry } from "@wavekit/api-types"
import {
	BandGainConfigSchema,
	BandGainSettingsSchema,
	DEFAULT_BAND_GAIN_ENTRIES,
	bandGainAt,
	nearestGainStep,
} from "../../../src/core/band-gain-schema.js"
import {
	BAND_GAIN_FILE_MAX_BYTES,
	BandGainSettingsError,
	BandGainSettingsService,
	type BandGainFs,
} from "../../../src/core/band-gain.js"
import { ConfigSchema } from "../../../src/config.js"

const logger = pino({ level: "silent" })
const R820T = [
	0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297,
	328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496,
]

function entries(n: number): BandGainEntry[] {
	// Disjoint 1 MHz ranges from 100 MHz up.
	return Array.from({ length: n }, (_, i) => ({
		minHz: 100_000_000 + i * 2_000_000,
		maxHz: 101_000_000 + i * 2_000_000,
		gain: 300,
	}))
}

function memoryFs(initial?: string) {
	const files = new Map<string, string>()
	let failWrite = false
	const fs: BandGainFs = {
		readFile: path => {
			const text = files.get(path)
			if (text === undefined)
				return Promise.reject(
					Object.assign(new Error("missing"), { code: "ENOENT" }),
				)
			return Promise.resolve(Buffer.from(text))
		},
		atomicWrite: (path, data) => {
			if (failWrite) return Promise.reject(new Error("disk full"))
			files.set(path, data)
			return Promise.resolve()
		},
	}
	if (initial !== undefined) files.set("/state/tuner-band-gain.json", initial)
	return {
		fs,
		files,
		setFailWrite: (v: boolean) => {
			failWrite = v
		},
	}
}

const configDefaults = BandGainConfigSchema.parse({})

describe("band gain schema", () => {
	it("defaults: 868/915 MHz ISM at an R820T step, ADS-B, 2 m and 70 cm keep, apply off", () => {
		expect(configDefaults.applyToMyTuning).toBe(false)
		expect(bandGainAt(configDefaults.entries, 868_100_000)).toBe(372)
		expect(bandGainAt(configDefaults.entries, 915_000_000)).toBe(372)
		expect(bandGainAt(configDefaults.entries, 1_090_000_000)).toBe("keep")
		expect(bandGainAt(configDefaults.entries, 145_500_000)).toBe("keep")
		expect(bandGainAt(configDefaults.entries, 433_920_000)).toBe("keep")
		// No entry keeps the gain too.
		expect(bandGainAt(configDefaults.entries, 455_500_000)).toBe("keep")
		expect(R820T).toContain(372)
		expect(BandGainSettingsSchema.safeParse(configDefaults).success).toBe(true)
	})

	it("the config schema carries the defaults under tuner.bandGain", () => {
		const config = ConfigSchema.parse({})
		expect(config.tuner.bandGain.entries).toEqual(
			DEFAULT_BAND_GAIN_ENTRIES.map(e => ({ ...e })),
		)
		expect(config.tuner.bandGain.applyToMyTuning).toBe(false)
	})

	it("ranges are inclusive at both ends", () => {
		const table: BandGainEntry[] = [
			{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
		]
		expect(bandGainAt(table, 863_000_000)).toBe(297)
		expect(bandGainAt(table, 870_000_000)).toBe(297)
		expect(bandGainAt(table, 862_999_999)).toBe("keep")
		expect(bandGainAt(table, 870_000_001)).toBe("keep")
		expect(bandGainAt(table, Number.NaN)).toBe("keep")
	})

	it("accepts BAND_GAIN_MAX_ENTRIES entries and refuses one more", () => {
		expect(
			BandGainSettingsSchema.safeParse({
				applyToMyTuning: false,
				entries: entries(BAND_GAIN_MAX_ENTRIES),
			}).success,
		).toBe(true)
		expect(
			BandGainSettingsSchema.safeParse({
				applyToMyTuning: false,
				entries: entries(BAND_GAIN_MAX_ENTRIES + 1),
			}).success,
		).toBe(false)
	})

	it("refuses min >= max, overlaps (shared edge included), out-of-range Hz and gain", () => {
		const bad = (entry: Partial<BandGainEntry>, extra: BandGainEntry[] = []) =>
			BandGainSettingsSchema.safeParse({
				applyToMyTuning: false,
				entries: [
					{ minHz: 400_000_000, maxHz: 410_000_000, gain: 300, ...entry },
					...extra,
				],
			}).success
		expect(bad({})).toBe(true)
		expect(bad({ maxHz: 400_000_000 })).toBe(false)
		expect(bad({ minHz: 420_000_000 })).toBe(false)
		expect(
			bad({}, [{ minHz: 410_000_000, maxHz: 420_000_000, gain: "keep" }]),
		).toBe(false)
		expect(
			bad({}, [{ minHz: 410_000_001, maxHz: 420_000_000, gain: "keep" }]),
		).toBe(true)
		expect(bad({ minHz: BAND_GAIN_MIN_HZ })).toBe(true)
		expect(bad({ minHz: BAND_GAIN_MIN_HZ - 1 })).toBe(false)
		expect(bad({ minHz: 1_000_000_000, maxHz: BAND_GAIN_MAX_HZ })).toBe(true)
		expect(bad({ minHz: 1_000_000_000, maxHz: BAND_GAIN_MAX_HZ + 1 })).toBe(
			false,
		)
		expect(bad({ gain: BAND_GAIN_MAX_TENTHS_DB })).toBe(true)
		expect(bad({ gain: BAND_GAIN_MAX_TENTHS_DB + 1 })).toBe(false)
		expect(bad({ gain: -1 })).toBe(false)
		expect(bad({ gain: 37.5 })).toBe(false)
		expect(bad({ gain: "auto" as never })).toBe(false)
		expect(bad({ label: "x".repeat(48) })).toBe(true)
		expect(bad({ label: "x".repeat(49) })).toBe(false)
		expect(bad({ label: "bad\u0000" })).toBe(false)
	})

	// Feature: per-band gain, Property 1: lookup is the unique containing entry or keep
	// Validates: Requirements R1 (first match, non-overlapping), R2 (keep/no match)
	it("a valid table answers the containing entry's gain, else keep", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 400 }), {
					maxLength: BAND_GAIN_MAX_ENTRIES,
				}),
				fc.integer({ min: 0, max: 900_000_000 }),
				(slots, offset) => {
					const table: BandGainEntry[] = slots.map(slot => ({
						minHz: 100_000_000 + slot * 2_000_000,
						maxHz: 100_000_000 + slot * 2_000_000 + 1_000_000,
						gain: slot % 3 === 0 ? "keep" : slot,
					}))
					expect(
						BandGainSettingsSchema.safeParse({
							applyToMyTuning: false,
							entries: table,
						}).success,
					).toBe(true)
					const hz = 100_000_000 + offset
					const hit = table.find(e => hz >= e.minHz && hz <= e.maxHz)
					expect(bandGainAt(table, hz)).toBe(hit ? hit.gain : "keep")
				},
			),
			{ numRuns: 200 },
		)
	})

	it("snaps to the nearest supported step (lower on a tie) and passes through without a table", () => {
		expect(nearestGainStep(380, R820T)).toBe(386)
		expect(nearestGainStep(379, R820T)).toBe(372)
		expect(nearestGainStep(500, R820T)).toBe(496)
		expect(nearestGainStep(10, [0, 20])).toBe(0)
		expect(nearestGainStep(380, null)).toBe(380)
		expect(nearestGainStep(380, [])).toBe(380)
		// A negative table step is clamped into the write range.
		expect(nearestGainStep(0, [-10, 15])).toBe(0)
	})
})

describe("BandGainSettingsService", () => {
	it("uses the config until a valid override is loaded or put, and persists the put", async () => {
		const m = memoryFs()
		const svc = new BandGainSettingsService({
			stateDir: "/state",
			config: configDefaults,
			logger,
			fs: m.fs,
		})
		await svc.load()
		expect(svc.view().provenance).toBe("config")
		const next = {
			applyToMyTuning: true,
			entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 }],
		}
		const view = await svc.put(next)
		expect(view.provenance).toBe("runtime")
		expect(view.settings).toEqual(next)
		expect(svc.gainAt(868_000_000)).toBe(297)
		expect(svc.applyToMyTuning()).toBe(true)
		const saved = m.files.get("/state/tuner-band-gain.json")
		expect(JSON.parse(saved ?? "")).toEqual({ version: 1, settings: next })

		const reloaded = new BandGainSettingsService({
			stateDir: "/state",
			config: configDefaults,
			logger,
			fs: m.fs,
		})
		await reloaded.load()
		expect(reloaded.view().provenance).toBe("runtime")
		expect(reloaded.settings()).toEqual(next)
	})

	it("a failed write keeps the previous settings", async () => {
		const m = memoryFs()
		const svc = new BandGainSettingsService({
			stateDir: "/state",
			config: configDefaults,
			logger,
			fs: m.fs,
		})
		m.setFailWrite(true)
		await expect(
			svc.put({ applyToMyTuning: true, entries: [] }),
		).rejects.toMatchObject({ code: "BAND_GAIN_WRITE_FAILED", statusCode: 500 })
		expect(svc.applyToMyTuning()).toBe(false)
		expect(svc.gainAt(868_000_000)).toBe(372)
	})

	it("an invalid put is a 400 naming fields and units without echoing values", async () => {
		const svc = new BandGainSettingsService({
			stateDir: "/state",
			config: configDefaults,
			logger,
			fs: memoryFs().fs,
		})
		const err: unknown = await svc
			.put({
				applyToMyTuning: true,
				entries: [{ minHz: 1, maxHz: 2, gain: "SECRET-VALUE", evil: 1 }],
			})
			.catch((e: unknown) => e)
		expect(err).toBeInstanceOf(BandGainSettingsError)
		const message = (err as BandGainSettingsError).message
		expect(message).toContain("entries.0.minHz")
		expect(message).toContain("tenths of a dB")
		expect(message).toContain("Hz")
		expect(message).not.toContain("SECRET-VALUE")
		expect(message).not.toContain("evil")
	})

	it("ignores a corrupt, invalid or oversized file (config applies)", async () => {
		for (const text of [
			"{not json",
			JSON.stringify({ version: 1, settings: { applyToMyTuning: "yes" } }),
			" ".repeat(BAND_GAIN_FILE_MAX_BYTES + 1),
		]) {
			const svc = new BandGainSettingsService({
				stateDir: "/state",
				config: configDefaults,
				logger,
				fs: memoryFs(text).fs,
			})
			await svc.load()
			expect(svc.view().provenance).toBe("config")
			expect(svc.gainAt(868_000_000)).toBe(372)
		}
	})

	it("a file at the byte cap is read", async () => {
		const body = JSON.stringify({
			version: 1,
			settings: { applyToMyTuning: true, entries: [] },
		})
		const text = body + " ".repeat(BAND_GAIN_FILE_MAX_BYTES - body.length)
		expect(Buffer.byteLength(text)).toBe(BAND_GAIN_FILE_MAX_BYTES)
		const svc = new BandGainSettingsService({
			stateDir: "/state",
			config: configDefaults,
			logger,
			fs: memoryFs(text).fs,
		})
		await svc.load()
		expect(svc.view().provenance).toBe("runtime")
	})
})
