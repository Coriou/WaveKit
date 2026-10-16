import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	ConfigSchema,
	loadConfig,
	stationIdentity,
} from "../../../src/config.js"

describe("station configuration", () => {
	let directory: string
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "station-test-"))
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(directory, { recursive: true })
	})
	it("preserves YAML values and distinguishes unknown defaults", () => {
		const path = join(directory, "config.yaml")
		writeFileSync(
			path,
			"station: {name: Home, lat: 48.5, lon: 2.5, altM: 50, callsign: F1ABC, country: FR}\n",
		)
		const result = stationIdentity(loadConfig(path), "EU")
		expect(result.name).toEqual({ value: "Home", provenance: "yaml" })
		expect(result.lat).toEqual({ value: 48.5, provenance: "yaml" })
		expect(result.effectiveCountry).toBe("FR")
		expect(stationIdentity(ConfigSchema.parse({}), "EU").country).toEqual({
			value: null,
			provenance: "default",
		})
	})
	it("applies nested env overrides and locks country with the alias", () => {
		const path = join(directory, "config.yaml")
		writeFileSync(path, "station: {country: FR, name: Home}\n")
		vi.stubEnv("WAVEKIT_COUNTRY", "CA")
		vi.stubEnv("WAVEKIT_STATION__COUNTRY", "US")
		vi.stubEnv("WAVEKIT_STATION__NAME", "123")
		vi.stubEnv("WAVEKIT_STATION__LAT", "45")
		vi.stubEnv("WAVEKIT_STATION__LON", "-75")
		vi.stubEnv("WAVEKIT_STATION__ALT_M", "100")
		vi.stubEnv("WAVEKIT_STATION__CALLSIGN", "VE3ABC")
		const result = stationIdentity(loadConfig(path), "EU")
		expect(result.country).toEqual({ value: "CA", provenance: "env" })
		expect(result.name).toEqual({ value: "123", provenance: "env" })
		expect(result.lat.value).toBe(45)
		expect(result.lon.value).toBe(-75)
		expect(result.altM.value).toBe(100)
		expect(result.callsign.value).toBe("VE3ABC")
		expect(result.region).toBe("EU")
		vi.stubEnv("WAVEKIT_COUNTRY", "FR")
		expect(result.country).toEqual({ value: "CA", provenance: "env" })
	})
	it.each(["ZZ", "EU", "fr", "USA", "", "XK"])(
		"rejects invalid country %s",
		country => {
			expect(ConfigSchema.safeParse({ station: { country } }).success).toBe(
				false,
			)
		},
	)
	it("rejects an invalid alias at load time", () => {
		const path = join(directory, "config.yaml")
		writeFileSync(path, "station: {country: FR}\n")
		vi.stubEnv("WAVEKIT_COUNTRY", "ZZ")
		expect(() => loadConfig(path)).toThrow()
	})
	it.each([{ lat: 91 }, { lon: -181 }, { altM: Infinity }])(
		"rejects invalid coordinates %j",
		station => {
			expect(ConfigSchema.safeParse({ station }).success).toBe(false)
		},
	)
})
