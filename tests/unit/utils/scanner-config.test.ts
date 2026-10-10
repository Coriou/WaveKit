import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
	ConfigSchema,
	ScannerConfigSchema,
	SourceConfigSchema,
	loadConfig,
	sourceScannerConfig,
} from "../../../src/config.js"
import type { ScannerSettings } from "../../../src/core/scanner/types.js"

const SPEC_DEFAULTS: ScannerSettings = {
	enabled: true,
	passive: { enabled: true, offsetProbes: false },
	cpuBudgetCores: 1,
	cpuGuardPercent: 90,
	maxProbes: { offset: 1, channel: 4 },
	ringSeconds: 3,
	detection: {
		fftSize: "auto",
		integrationMs: 50,
		sensitivity: "normal",
		faTargetPerMhzMin: 1,
		dcGuardHz: 1500,
		ppmMargin: 2,
		clipFraction: 0.001,
		hysteresisDb: 3,
		minSurfaceBlocks: 2,
		shortIntegrationMs: 5,
		overlap: 0,
	},
	sweep: {
		markers: true,
		markerTimeoutMs: 2000,
		pllSettleMs: 5,
		settleMs: { local: 300, network: 1000 },
		revisitShare: 0.3,
	},
	hold: { maxHoldMs: 60000, hangMs: 2000, preRollMs: 300 },
	storage: {
		dir: null,
		maxRecordingsMb: 512,
		maxEvidenceMb: 64,
		maxJournalMb: 64,
		maxAgeDays: 30,
		discoveryMaxAgeDays: 180,
		minFreeDiskMb: 2048,
		maxDiscoveries: 10000,
		maxCapturesMb: 256,
	},
	ws: {
		maxMessagesPerSecond: 10,
		spectrumHz: 10,
		spectrumBins: 512,
		spectrumSummaryBins: 2048,
		spectrumMaxProfiles: 4,
	},
}

const source = {
	id: "rtl",
	type: "rtl_tcp",
	host: "localhost",
	port: 1234,
	caps: { kind: "iq", format: "U8_IQ", sampleRate: 2048000 },
}

describe("scanner config section (spec § 12.3)", () => {
	it("an empty section yields exactly the spec defaults, typed as ScannerSettings", () => {
		const parsed: ScannerSettings = ScannerConfigSchema.parse({})
		expect(parsed).toEqual(SPEC_DEFAULTS)
	})

	it("a config without a scanner key gets the defaults", () => {
		expect(ConfigSchema.parse({}).scanner).toEqual(SPEC_DEFAULTS)
	})

	it("keeps sibling defaults when one nested key is set", () => {
		const parsed = ScannerConfigSchema.parse({
			detection: { integrationMs: 20 },
		})
		expect(parsed.detection).toEqual({
			...SPEC_DEFAULTS.detection,
			integrationMs: 20,
		})
		expect(parsed.sweep).toEqual(SPEC_DEFAULTS.sweep)
	})

	it("accepts a power-of-two fftSize in 512..16384 and rejects others", () => {
		expect(
			ScannerConfigSchema.parse({ detection: { fftSize: 4096 } }).detection
				.fftSize,
		).toBe(4096)
		for (const bad of [256, 3000, 32768, -2048])
			expect(
				ScannerConfigSchema.safeParse({ detection: { fftSize: bad } }).success,
			).toBe(false)
	})

	it("rejects a pre-roll longer than the IQ ring", () => {
		const result = ScannerConfigSchema.safeParse({
			ringSeconds: 1,
			hold: { preRollMs: 1500 },
		})
		expect(result.success).toBe(false)
		expect(
			ScannerConfigSchema.safeParse({
				ringSeconds: 2,
				hold: { preRollMs: 1500 },
			}).success,
		).toBe(true)
	})

	it("rejects out-of-range budgets and an unknown sensitivity", () => {
		expect(ScannerConfigSchema.safeParse({ cpuBudgetCores: 0 }).success).toBe(
			false,
		)
		expect(
			ScannerConfigSchema.safeParse({ cpuGuardPercent: 101 }).success,
		).toBe(false)
		expect(
			ScannerConfigSchema.safeParse({ maxProbes: { offset: -1 } }).success,
		).toBe(false)
		expect(
			ScannerConfigSchema.safeParse({ detection: { sensitivity: "max" } })
				.success,
		).toBe(false)
	})

	it("bounds the config-only spectrum keys", () => {
		const parsed = ScannerConfigSchema.parse({})
		expect(parsed.ws.spectrumSummaryBins).toBe(2048)
		expect(parsed.ws.spectrumMaxProfiles).toBe(4)
		for (const bad of [4096, 256])
			expect(
				ScannerConfigSchema.safeParse({ ws: { spectrumSummaryBins: bad } })
					.success,
			).toBe(false)
		for (const bad of [0, 17])
			expect(
				ScannerConfigSchema.safeParse({ ws: { spectrumMaxProfiles: bad } })
					.success,
			).toBe(false)
	})
})

describe("sources[i].scanner (spec § 10.7)", () => {
	it("defaults to a shared, passive source when absent", () => {
		const parsed = SourceConfigSchema.parse(source)
		expect(parsed.scanner).toBeUndefined()
		expect(sourceScannerConfig(parsed)).toEqual({
			role: "shared",
			passive: true,
		})
	})

	it("parses a dedicated non-passive source and rejects an unknown role", () => {
		const parsed = SourceConfigSchema.parse({
			...source,
			scanner: { role: "dedicated", passive: false },
		})
		expect(sourceScannerConfig(parsed)).toEqual({
			role: "dedicated",
			passive: false,
		})
		expect(
			SourceConfigSchema.safeParse({
				...source,
				scanner: { role: "exclusive" },
			}).success,
		).toBe(false)
	})
})

describe("WAVEKIT_SCANNER__ environment overrides", () => {
	let tempDir: string
	let originalEnv: NodeJS.ProcessEnv
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-scanner-config-"))
		originalEnv = { ...process.env }
	})
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
		process.env = originalEnv
	})

	it("override nested scanner keys and an indexed source's scanner role", () => {
		const configPath = path.join(tempDir, "scanner.yaml")
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				sources: [source, { ...source, id: "spare" }],
				decoders: [
					{
						id: "dmr",
						type: "dsd-fme",
						enabled: true,
						sourceId: "rtl",
						options: {},
					},
				],
				scanner: { cpuBudgetCores: 2 },
			}),
		)
		process.env["WAVEKIT_SCANNER__CPU_BUDGET_CORES"] = "0.5"
		process.env["WAVEKIT_SCANNER__PASSIVE__ENABLED"] = "false"
		process.env["WAVEKIT_SCANNER__MAX_PROBES__OFFSET"] = "2"
		process.env["WAVEKIT_SCANNER__DETECTION__FFT_SIZE"] = "4096"
		process.env["WAVEKIT_SCANNER__STORAGE__DIR"] = "/var/lib/wavekit/scanner"
		process.env["WAVEKIT_SOURCES__1__SCANNER__ROLE"] = "dedicated"
		const config = loadConfig(configPath)
		expect(config.scanner.cpuBudgetCores).toBe(0.5)
		expect(config.scanner.passive).toEqual({
			enabled: false,
			offsetProbes: false,
		})
		expect(config.scanner.maxProbes).toEqual({ offset: 2, channel: 4 })
		expect(config.scanner.detection.fftSize).toBe(4096)
		expect(config.scanner.storage.dir).toBe("/var/lib/wavekit/scanner")
		expect(config.sources.map(s => sourceScannerConfig(s))).toEqual([
			{ role: "shared", passive: true },
			{ role: "dedicated", passive: true },
		])
	})
})
