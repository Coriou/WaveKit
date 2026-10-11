import { describe, expect, it } from "vitest"
import { ScannerConfigSchema } from "../../../../src/config.js"
import {
	SCANNER_SETTINGS_BOUNDS,
	ScannerSettingsPatchSchema,
	applySettingsPatch,
	mergeScannerSettings,
} from "../../../../src/core/scanner/settings.js"
import { RuntimeSettingsOverridesSchema } from "../../../../src/core/scanner/store/persistence.js"

const defaults = ScannerConfigSchema.parse({})
const sources = [
	{ id: "rtl" },
	{ id: "spare", scanner: { role: "dedicated" as const, passive: false } },
]

describe("mergeScannerSettings (spec § 12.1 settings, D4)", () => {
	it("reports every leaf as default when nothing is configured or overridden", () => {
		const merged = mergeScannerSettings({
			config: defaults,
			sources: [],
			overrides: {},
		})
		expect(merged.settings).toEqual(defaults)
		expect(merged.provenance["detection.integrationMs"]).toBe("default")
		expect(merged.provenance["storage.dir"]).toBe("default")
		expect(Object.values(merged.provenance).every(p => p === "default")).toBe(
			true,
		)
	})

	it("marks configured values as config and runtime overrides as runtime, override winning", () => {
		const config = ScannerConfigSchema.parse({
			cpuBudgetCores: 2,
			detection: { integrationMs: 20 },
		})
		const merged = mergeScannerSettings({
			config,
			sources: [],
			overrides: { detection: { integrationMs: 100 }, ws: { spectrumHz: 1 } },
		})
		expect(merged.settings.cpuBudgetCores).toBe(2)
		expect(merged.provenance["cpuBudgetCores"]).toBe("config")
		expect(merged.settings.detection.integrationMs).toBe(100)
		expect(merged.provenance["detection.integrationMs"]).toBe("runtime")
		expect(merged.settings.ws.spectrumHz).toBe(1)
		expect(merged.provenance["ws.spectrumHz"]).toBe("runtime")
		expect(merged.settings.detection.hysteresisDb).toBe(3)
		expect(config.detection.integrationMs).toBe(20) // input not mutated
	})

	it("resolves passive per source: runtime > source config > default, gated by passive.enabled", () => {
		const merged = mergeScannerSettings({
			config: defaults,
			sources,
			overrides: { passive: { spare: true } },
		})
		expect(merged.passiveBySource).toEqual({ rtl: true, spare: true })
		expect(merged.provenance["passiveBySource.rtl"]).toBe("default")
		expect(merged.provenance["passiveBySource.spare"]).toBe("runtime")
		const configured = mergeScannerSettings({
			config: defaults,
			sources,
			overrides: {},
		})
		expect(configured.passiveBySource).toEqual({ rtl: true, spare: false })
		expect(configured.provenance["passiveBySource.spare"]).toBe("config")
		const off = ScannerConfigSchema.parse({ passive: { enabled: false } })
		const gated = mergeScannerSettings({
			config: off,
			sources,
			overrides: { passive: { spare: true } },
		})
		expect(gated.passiveBySource).toEqual({ rtl: false, spare: false })
	})

	it("keys per-source passive provenance apart from passive.enabled", () => {
		const config = ScannerConfigSchema.parse({ passive: { enabled: false } })
		const merged = mergeScannerSettings({
			config,
			sources: [{ id: "enabled" }],
			overrides: { passive: { enabled: true } },
		})
		expect(merged.provenance["passive.enabled"]).toBe("config")
		expect(merged.provenance["passiveBySource.enabled"]).toBe("runtime")
		expect(merged.passiveBySource).toEqual({ enabled: false })
	})

	it("treats source ids containing dots as one key", () => {
		const merged = mergeScannerSettings({
			config: defaults,
			sources: [{ id: "pi.lab" }],
			overrides: { passive: { "pi.lab": false } },
		})
		expect(merged.passiveBySource).toEqual({ "pi.lab": false })
	})
})

describe("applySettingsPatch", () => {
	it("merges nested keys without dropping siblings and merges passive maps", () => {
		const first = applySettingsPatch(
			{},
			{ detection: { integrationMs: 20 }, passive: { rtl: false } },
		)
		const next = applySettingsPatch(first, {
			detection: { hysteresisDb: 4 },
			passive: { spare: true },
		})
		expect(next).toEqual({
			detection: { integrationMs: 20, hysteresisDb: 4 },
			passive: { rtl: false, spare: true },
		})
	})

	it("rejects out-of-bound or unknown keys", () => {
		expect(() => applySettingsPatch({}, { cpuBudgetCores: 0 })).toThrow()
		expect(
			ScannerSettingsPatchSchema.safeParse({ storage: { dir: "/tmp" } })
				.success,
		).toBe(false)
		expect(
			ScannerSettingsPatchSchema.safeParse({ detection: { fftSize: 4096 } })
				.success,
		).toBe(false)
		// cpuGuardPercent is config-only (spec § 12.1 lists no runtime row for it)
		expect(
			ScannerSettingsPatchSchema.safeParse({ cpuGuardPercent: 80 }).success,
		).toBe(false)
	})

	it("rejects a PATCH of the config-only spectrum keys", () => {
		expect(
			ScannerSettingsPatchSchema.safeParse({
				ws: { spectrumSummaryBins: 1024 },
			}).success,
		).toBe(false)
		expect(
			ScannerSettingsPatchSchema.safeParse({ ws: { spectrumMaxProfiles: 4 } })
				.success,
		).toBe(false)
	})
})

describe("one override schema for PATCH and settings.json (Task 16)", () => {
	it("is the persistence schema itself, so a loaded settings.json always accepts later patches", () => {
		expect(ScannerSettingsPatchSchema).toBe(RuntimeSettingsOverridesSchema)
		const loaded = RuntimeSettingsOverridesSchema.parse({
			passive: { rtl: false },
			cpuBudgetCores: 2,
			storage: { maxCapturesMb: 512 },
		})
		expect(applySettingsPatch(loaded, { ws: { spectrumHz: 2 } })).toEqual({
			passive: { rtl: false },
			cpuBudgetCores: 2,
			storage: { maxCapturesMb: 512 },
			ws: { spectrumHz: 2 },
		})
	})
})

describe("SCANNER_SETTINGS_BOUNDS agree with the config schema", () => {
	const numeric = Object.entries(SCANNER_SETTINGS_BOUNDS).filter(
		([, b]) => b.type === "number" || b.type === "integer",
	)
	it.each(numeric)(
		"%s accepts its min and max and rejects just outside",
		(key, bounds) => {
			const patch = (value: number) => {
				const parts = key.split(".")
				const leaf = parts.pop()!
				const root: Record<string, unknown> = {}
				let node = root
				for (const part of parts) {
					const child: Record<string, unknown> = {}
					node[part] = child
					node = child
				}
				node[leaf] = value
				return root
			}
			const step = bounds.type === "integer" ? 1 : 0.001
			expect(
				ScannerSettingsPatchSchema.safeParse(patch(bounds.min!)).success,
			).toBe(true)
			expect(
				ScannerSettingsPatchSchema.safeParse(patch(bounds.max!)).success,
			).toBe(true)
			expect(
				ScannerSettingsPatchSchema.safeParse(patch(bounds.min! - step)).success,
			).toBe(false)
			expect(
				ScannerSettingsPatchSchema.safeParse(patch(bounds.max! + step)).success,
			).toBe(false)
			expect(ScannerConfigSchema.safeParse(patch(bounds.min!)).success).toBe(
				true,
			)
			expect(ScannerConfigSchema.safeParse(patch(bounds.max!)).success).toBe(
				true,
			)
		},
	)
})
