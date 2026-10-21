import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import Fastify from "fastify"
import type {
	DecoderSuspensionReasonCode,
	TunerCommandOrigin,
	ResourceAlert,
} from "@wavekit/api-types"
import * as c from "../../../src/decoders/enablement/contract.js"
import * as r from "../../../src/core/rate-policy-contract.js"
import { DecoderConfigSchema, ConfigSchema } from "../../../src/config.js"
import { decoderStatusSchema } from "../../../src/api/routes/decoder-status-schemas.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { decoderFacts } from "../../../cli/source/view-models/decoder-rows.js"
import { decoderDetail } from "../../../cli/source/view-models/decoders.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { guardAlert } from "../../../cli/source/data/guards.js"

const shipped = () =>
	ConfigSchema.parse(parse(readFileSync("config/default.yaml", "utf8")))
const baseConfig = {
	sources: [],
	decoders: [],
	audio: {
		tcpPort: 8080,
		format: "S16LE",
		sampleRate: 48000,
		monitoring: false,
	},
	tunerRelay: {
		enabled: false,
		host: "0.0.0.0",
		port: 1234,
		controlPolicy: "exclusive",
		commandHistoryLimit: 200,
	},
	tuner: {
		reconnectPolicy: "restore",
	},
	liveDemod: {
		enabled: false,
		httpPort: 8081,
		modulation: "nfm",
		bandwidth: 12500,
		squelch: 0,
		noiseReduction: "off",
		lowPass: 0,
		highPass: 0,
		gain: 2,
		deEmphasis: false,
		deEmphasisTau: 50,
		audioFormat: "s16le",
		iqDcBlock: false,
		offsetHz: 0,
	},
	digitalVoice: {
		enabled: true,
		httpPort: 8082,
		voiceSlot: "both",
		jitterBufferMs: 400,
		maxBufferMs: 1000,
	},
	api: {
		host: "0.0.0.0",
		port: 3000,
	},
	access: {
		mode: "legacy",
	},
	logging: {
		level: "info",
	},
	resources: {
		enabled: true,
		containerMonitor: {
			enabled: true,
			pollIntervalMs: 2000,
		},
		sdrHostPoller: {
			enabled: true,
			pollIntervalMs: 3000,
			timeoutMs: 2000,
		},
		broadcastIntervalMs: 2000,
	},
	csdr: {
		boundedBuffers: true,
		bufferElements: 65536,
	},
	channelizer: {
		enabled: false,
		binaryPath: "wavekit-chan",
		socketDir: "/var/run/wavekit/chan",
		usableFraction: 0.8,
		channelQueueMs: 250,
		inputHighWaterMark: 262144,
		blockSamples: 16384,
	},
	scanner: {
		enabled: true,
		channelTier: {
			enabled: false,
			minMs: 500,
		},
		passive: {
			enabled: true,
			offsetProbes: false,
		},
		cpuBudgetCores: 1,
		cpuGuardPercent: 90,
		maxProbes: {
			offset: 1,
			channel: 4,
		},
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
			settleMs: {
				local: 300,
				network: 1000,
			},
			revisitShare: 0.3,
		},
		hold: {
			maxHoldMs: 60000,
			hangMs: 2000,
			preRollMs: 300,
		},
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
	},
	station: {},
	activity: {
		enabled: true,
	},
	stateDir: "data",
}

describe("decoder enablement contract", () => {
	it("pins constants with their arithmetic", () => {
		expect(c.CHANNELIZER_AUTO_ACCEPTED).toBe(false)
		expect(c.DECODER_MAX_BANDPLAN_CHANNELS).toBe(4)
		expect(c.VFO_SETTLE_MS).toBe(1000)
		expect(c.EFFICIENCY_SAMPLE_MS).toBe(2000)
		expect(c.EFFICIENCY_DROP_WINDOW_MS).toBe(10000)
		expect(c.EFFICIENCY_CLEAR_MS).toBe(60000)
		expect(c.EFFICIENCY_PROBATION_MS).toBe(30000)
		expect(c.EFFICIENCY_RETRY_MS).toBe(300000)
		expect(c.EFFICIENCY_RETRY_MAX_MS).toBe(1800000)
		expect(c.EFFICIENCY_BUDGET_X64).toBe(1.5)
		expect(c.EFFICIENCY_BUDGET_ARM64).toBe(0.75)
		expect(c.EFFICIENCY_CPU_GUARD_PERCENT).toBe(90)
		expect(c.CHANNELIZER_IDLE_STOP_MS).toBe(60000)
		expect(c.CHANNEL_MARGINAL_CORES).toBe(0.11)
		expect(c.CHANNELIZER_BASE_CORES_2048K).toBe(0.22)
		expect(c.CHANNELIZER_BASE_CORES_2400K).toBe(0.26)
		expect(c.DECODER_COST_UNKNOWN_CORES).toBe(0.6)

		expect(r.READSB_REACH_HZ).toBe(200_000)
		expect(r.ADSB_FREQUENCY_HZ).toBe(1_090_000_000)
		expect(r.LINK_SUSTAINED_WINDOW_MS).toBe(10_000)
		expect(r.LINK_SHORTFALL_PERCENT).toBe(1)
		expect(r.LINK_UPSTREAM_DROPS_BYTES_PER_SECOND).toBe(10_000)
		expect(r.READSB_SAMPLE_RATE * 2).toBe(4_800_000)
		expect(
			4 * (c.CHANNEL_MARGINAL_CORES + c.DECODER_COSTS["dsd-fme"].cores),
		).toBeCloseTo(0.62, 2)
		expect(c.EFFICIENCY_DROP_WINDOW_MS / c.EFFICIENCY_SAMPLE_MS).toBe(5)
		expect(c.EFFICIENCY_BUDGET_ARM64 * 4).toBe(3)
		const windowC =
			c.channelizerBaseCores(2_400_000) +
			c.DECODER_COSTS["lora-meshtastic"].cores +
			c.placementCostCores("rtl433", "channel") +
			c.placementCostCores("dsd-fme", "channel") +
			c.placementCostCores("multimon-ng", "channel")
		expect(windowC).toBeCloseTo(1.365, 3)
		expect(windowC).toBeLessThan(c.EFFICIENCY_BUDGET_X64)
	})
	it("pins catalogue costs, protocols, reach and placement keys", () => {
		expect(c.CATALOGUE_TYPES).toEqual([
			"readsb",
			"ais-catcher",
			"acarsdec",
			"dumpvdl2",
			"rtl433",
			"direwolf",
			"multimon-ng",
			"dsd-fme",
			"lora-meshtastic",
		])
		expect(c.CHANNEL_CAPABLE_TYPES).toEqual([
			"ais-catcher",
			"acarsdec",
			"dumpvdl2",
			"rtl433",
			"direwolf",
			"multimon-ng",
			"dsd-fme",
		])
		expect(c.DECODER_PROTOCOLS).toEqual({
			"dsd-fme": [
				"dmr",
				"p25p1",
				"p25p2",
				"ysf",
				"dstar",
				"nxdn48",
				"nxdn96",
				"dpmr",
			],
			"multimon-ng": ["pocsag", "flex"],
		})
		expect(c.DECODER_COSTS).toEqual({
			readsb: { cores: 0.25, basis: "estimate" },
			"ais-catcher": { cores: 0.1, basis: "measurement" },
			acarsdec: { cores: 0.05, basis: "estimate" },
			dumpvdl2: { cores: 0.15, basis: "estimate" },
			rtl433: { cores: 0.1, basis: "estimate" },
			direwolf: { cores: 0.05, basis: "estimate" },
			"multimon-ng": { cores: 0.03, basis: "estimate" },
			"dsd-fme": { cores: 0.045, basis: "estimate" },
			"lora-meshtastic": { cores: 0.6, basis: "estimate" },
		})
		expect(c.placementKey("d", "s", "channel", 123)).toBe("d#123@s")
		expect(c.placementKey("d", "s", "raw", null)).toBe("d#raw@s")
		expect(c.placementKey("d", "s", "centre", null)).toBe("d#centre@s")
		expect(c.placementCostCores("lora-meshtastic", "centre")).toBe(0.6)
	})
	// Validates: Requirements 1.5, 2.1, 4.1, 5.2, 6.1
	it("accepts only bounded optional policy keys without filling defaults", () => {
		const config = baseConfig
		expect(
			ConfigSchema.parse({
				...config,
				decoderPolicy: {},
				channelizer: { ...config.channelizer, auto: false },
			}).decoderPolicy,
		).toEqual({})
		expect(
			ConfigSchema.parse({
				...config,
				decoderPolicy: {
					catalogue: false,
					rateRaise: false,
					efficiency: {
						cpuBudgetCores: 64,
						cpuGuardPercent: 100,
						maxBandplanChannels: 16,
					},
				},
			}).decoderPolicy?.efficiency?.maxBandplanChannels,
		).toBe(16)
		for (const efficiency of [
			{ cpuBudgetCores: 0 },
			{ cpuBudgetCores: 65 },
			{ cpuGuardPercent: 0 },
			{ cpuGuardPercent: 101 },
			{ maxBandplanChannels: -1 },
			{ maxBandplanChannels: 17 },
			{ maxBandplanChannels: 1.5 },
			{ unknown: true },
		]) {
			expect(
				ConfigSchema.safeParse({ ...config, decoderPolicy: { efficiency } })
					.success,
			).toBe(false)
		}
		expect(
			ConfigSchema.safeParse({ ...config, decoderPolicy: { unknown: true } })
				.success,
		).toBe(false)
		const decoder = { id: "fake", type: "fake", enabled: false, options: {} }
		expect(DecoderConfigSchema.parse(decoder)).not.toHaveProperty("mode")
		for (const mode of ["auto", "always", "off"])
			expect(DecoderConfigSchema.parse({ ...decoder, mode }).mode).toBe(mode)
		expect(
			DecoderConfigSchema.safeParse({ ...decoder, mode: "invalid" }).success,
		).toBe(false)
	})

	it("placementCostCores charges channel marginal only for channel reach and the unknown cost for unknown types", () => {
		expect(c.placementCostCores("ais-catcher", "channel")).toBeCloseTo(0.21)
		expect(c.placementCostCores("readsb", "raw")).toBe(0.25)
		expect(c.placementCostCores("my-yaml-type", "raw")).toBe(0.6)
		expect(c.placementCostCores("toString", "channel")).toBeCloseTo(0.71)
	})
	it("channelizerBaseCores bound", () => {
		expect(c.channelizerBaseCores(2_048_000)).toBe(0.22)
		expect(c.channelizerBaseCores(2_048_001)).toBe(0.26)
	})
	it("channelizer is never composed while auto is not accepted", () => {
		for (const auto of [undefined, true, false]) {
			expect(
				c.channelizerComposition(
					{ enabled: false, auto },
					c.CHANNELIZER_AUTO_ACCEPTED,
				),
			).toBeNull()
			expect(c.channelizerComposition({ enabled: true, auto }, false)).toBe(
				"enabled",
			)
			expect(c.channelizerComposition({ enabled: true, auto }, true)).toBe(
				"enabled",
			)
			expect(c.channelizerComposition({ enabled: false, auto }, true)).toBe(
				auto === false ? null : "auto",
			)
		}
		expect(
			c.channelizerComposition(
				shipped().channelizer,
				c.CHANNELIZER_AUTO_ACCEPTED,
			),
		).toBeNull()
	})
	it("defaultCpuBudgetCores", () => {
		expect(c.defaultCpuBudgetCores("x64", 8)).toBe(1.5)
		expect(c.defaultCpuBudgetCores("arm64", 4)).toBe(0.75)
		expect(c.defaultCpuBudgetCores("arm64", 5)).toBe(1.5)
	})
	it("unions widened", () => {
		const reasons: DecoderSuspensionReasonCode[] = [
			"efficiency-budget",
			"decoder-unavailable",
		]
		const origin: TunerCommandOrigin = "decoder-rate"
		const alert: ResourceAlert["type"] = "link-capacity"
		expect([reasons, origin, alert]).toEqual([
			["efficiency-budget", "decoder-unavailable"],
			"decoder-rate",
			"link-capacity",
		])
	})
	it("parsed shipped config is unchanged", () => {
		const config = shipped()
		expect(config).not.toHaveProperty("decoderPolicy")
		expect(config.channelizer).not.toHaveProperty("auto")
		expect(config).toEqual(baseConfig)
	})
	it("Fastify status schema keeps the new optional fields", async () => {
		const app = Fastify()
		const extra = {
			mode: "auto",
			modeSource: "default",
			origin: "catalogue",
			placements: [
				{
					sourceId: "fake",
					channelHz: 100,
					reach: "channel",
					origin: "vfo",
					primary: true,
					running: false,
					costCores: 0.21,
					probation: true,
					suspension: {
						reasonCode: "efficiency-budget",
						since: "2026-10-20T00:00:00.000Z",
					},
					efficiencyDetail: "budget",
				},
			],
			efficiency: { detail: "budget", retryAt: "2026-10-20T00:05:00.000Z" },
		}
		app.get(
			"/",
			{ schema: { response: { 200: decoderStatusSchema } } },
			() => ({
				id: "fake",
				type: "ais-catcher",
				running: false,
				health: "idle",
				uptime: 0,
				stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
				restartCount: 0,
				...extra,
			}),
		)
		try {
			expect((await app.inject("/")).json()).toMatchObject(extra)
		} finally {
			await app.close()
		}
	})
	it("CLI words", () => {
		for (const [reasonCode, words] of [
			["efficiency-budget", "over the efficiency budget"],
			["decoder-unavailable", "not installed"],
		]) {
			const state = scenarioState("live")
			const fact = decoderFacts(state)[0]
			expect(fact).toBeDefined()
			if (!fact) return
			fact.row.running = false
			fact.row.suspended = true
			fact.row.suspension = {
				reasonCode: reasonCode ?? "",
				since: new Date(state.now).toISOString(),
			}
			expect(
				decoderDetail(state, fact, 160, state.now).map(lineText).join("\n"),
			).toContain(words)
		}

		expect(
			guardAlert({
				type: "link-capacity",
				severity: "warning",
				message: "capacity",
				timestamp: "2026-10-20T00:00:00.000Z",
			})?.type,
		).toBe("link-capacity")
	})
})
