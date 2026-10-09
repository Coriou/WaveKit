import { describe, expect, it } from "vitest"
import type { DecoderRow } from "../../../cli/source/data/types.js"
import {
	guardCoreStatus,
	guardDecoder,
	guardFanout,
	guardList,
	guardPresets,
	guardResources,
	guardSource,
	parseServerMessage,
	readHostSampling,
} from "../../../cli/source/data/guards.js"

const decoder = {
	id: "readsb",
	type: "readsb",
	running: true,
	health: "idle",
	pid: 1531,
	uptime: 51,
	stats: { bytesIn: 570600000, eventsOut: 0, errors: 6 },
	lastOutputAt: null,
	restartCount: 0,
	caps: {
		input: "iq",
		output: "jsonl",
		integrationPattern: "network_producer",
	},
}

describe("guardDecoder", () => {
	it("keeps required and well-typed optional fields", () => {
		expect(guardDecoder(decoder)).toMatchObject({
			id: "readsb",
			pid: 1531,
			lastOutputAt: null,
		})
	})
	it("drops a malformed optional field instead of rejecting", () => {
		const g = guardDecoder({ ...decoder, pid: "x", caps: { input: "??" } })
		expect(g).toBeDefined()
		expect(g && "pid" in g).toBe(false)
		expect(g && "caps" in g).toBe(false)
	})
	it("rejects a missing or mistyped required field", () => {
		expect(guardDecoder({ ...decoder, running: "yes" })).toBeUndefined()
		expect(guardDecoder(null)).toBeUndefined()
	})
	it("filters arrays element by element and counts rejects", () => {
		expect(
			guardList([decoder, { id: 1 }, decoder], guardDecoder),
		).toMatchObject({
			rejected: 1,
			value: [{ id: "readsb" }, { id: "readsb" }],
		})
		expect(guardList({}, guardDecoder)).toBeUndefined()
	})
})

describe("guardFanout", () => {
	it("accepts snapshots without totalBytesWritten (older core)", () => {
		const snap = {
			timestamp: "2026-10-08T18:07:49.000Z",
			branches: [
				{
					id: "decoder-readsb",
					decoderId: "readsb",
					backpressureActive: true,
					backpressureEnterCount: 121,
					droppedBytesTotal: 5,
					droppedChunksTotal: 1,
					bufferBytes: 389120,
					highWaterMark: 262144,
				},
			],
			backpressureActiveCount: 1,
			droppedBytesTotal: 5,
			droppedChunksTotal: 1,
		}
		const g = guardFanout(snap)
		expect(g?.branches[0]?.totalBytesWritten).toBeUndefined()
		expect(g?.totalBytesWritten).toBeUndefined()
	})
})

describe("readHostSampling", () => {
	const sampling = {
		state: "streaming",
		reason: null,
		timeoutMs: 5000,
		lastSampleAt: "2026-10-08T18:07:49.800Z",
		sampleAgeMs: 200,
		upstream: {
			bytesTotal: 1,
			bytesPerSec: 4096000,
			windowMs: 2000,
			expectedBytesPerSec: 4096000,
			rateBasis: "configured",
			rateStatus: "nominal",
		},
		epoch: {
			rtlmuxPid: 63,
			rtlTcpPid: 58,
			startedAt: null,
			resets: 0,
			lastResetReason: null,
		},
		stats: { state: "ok", observedAt: null, ageMs: 200, lastError: null },
	}
	it("accepts a valid SdrHostSampling and rejects partial ones", () => {
		expect(readHostSampling(sampling)?.state).toBe("streaming")
		expect(readHostSampling({ ...sampling, upstream: null })).toBeUndefined()
		expect(readHostSampling(undefined)).toBeUndefined()
	})
	it("is carried on resource hosts only when present and valid", () => {
		const host = {
			available: true,
			sourceId: "pi-iq",
			apiUrl: "http://192.0.2.23:8080",
			uptime: 291,
			rtlTcp: null,
			rtlmux: null,
			dongle: null,
			warnings: [],
			errors: [],
			lastFetchedAt: null,
			fetchError: null,
		}
		const container = {
			available: true,
			cpuUsagePercent: 240,
			cpuThrottledPercent: null,
			memoryUsageBytes: 1,
			memoryLimitBytes: null,
			memoryUsagePercent: null,
			oomKillCount: 0,
			cgroupVersion: "v2",
		}
		const r = guardResources({
			timestamp: "t",
			container,
			sdrHosts: [host, { ...host, sampling }],
			sourceBackpressure: [],
		})
		expect(r?.sdrHosts[0]?.sampling).toBeUndefined()
		expect(r?.sdrHosts[1]?.sampling?.state).toBe("streaming")
	})
})

describe("guardCoreStatus and guardPresets", () => {
	it("flattens non-decoder components", () => {
		const s = guardCoreStatus({
			status: "degraded",
			uptime: 460,
			version: "1.0.0",
			sources: [],
			decoders: {},
			health: {
				status: "degraded",
				timestamp: "t",
				uptime: 460,
				components: {
					api: { status: "up" },
					sdrpp: { status: "down", message: "no route" },
					decoders: { x: { status: "up" } },
					source: { status: "up" },
				},
			},
		})
		expect(s?.components.map(c => c.name)).toEqual(["api", "sdrpp", "source"])
		expect(s?.components[1]).toEqual({
			name: "sdrpp",
			status: "down",
			message: "no route",
		})
	})
	it("keeps presets with a numeric bandwidth", () => {
		expect(
			guardPresets({
				nfm: { bandwidth: 12500 },
				wfm: { bandwidth: 200000, deEmphasis: true, deEmphasisTau: 50 },
				bad: {},
			}),
		).toEqual({
			nfm: { bandwidth: 12500 },
			wfm: { bandwidth: 200000, deEmphasis: true, deEmphasisTau: 50 },
		})
	})
})

describe("parseServerMessage", () => {
	it("maps the subscribe ack and server errors", () => {
		expect(
			parseServerMessage({
				type: "subscribed",
				data: { channels: ["decoders"] },
			}),
		).toEqual({ type: "subscribed", channels: ["decoders"] })
		expect(
			parseServerMessage({ type: "error", data: { message: "Invalid JSON" } }),
		).toEqual({ type: "server-error", message: "Invalid JSON" })
	})
	it("parses decoder:health without previousHealth", () => {
		expect(
			parseServerMessage({
				type: "decoder:health",
				channel: "health",
				data: { decoderId: "readsb", health: "idle" },
			}),
		).toEqual({ type: "decoder:health", decoderId: "readsb", health: "idle" })
	})
	it("follows the broadcaster for aircraft:lost ({icao, aircraft})", () => {
		expect(
			parseServerMessage({
				type: "aircraft:lost",
				channel: "aircraft",
				data: { icao: "4ca9d2", aircraft: { icao: "4ca9d2" } },
			}),
		).toEqual({ type: "aircraft:lost", icao: "4ca9d2" })
	})
	it("uses branchId on backpressure events", () => {
		expect(
			parseServerMessage({
				type: "fanout:backpressure",
				channel: "fanout",
				data: {
					branchId: "decoder-readsb",
					bufferedBytes: 389120,
					timestamp: "t",
				},
			}),
		).toMatchObject({ branchId: "decoder-readsb" })
	})
	it("tolerates extra keys on live-audio frames", () => {
		const config = {
			enabled: true,
			httpPort: 8081,
			modulation: "nfm",
			bandwidth: 12500,
			squelch: 0,
			noiseReduction: "off",
			lowPass: 0,
			highPass: 0,
			gain: 10,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: true,
			extra: 1,
		}
		expect(
			parseServerMessage({
				type: "live-audio:config",
				channel: "live-audio",
				data: config,
			}),
		).toMatchObject({ type: "live-audio:config" })
	})
	it("rejects unknown types and malformed data", () => {
		expect(
			parseServerMessage({ type: "nope", channel: "x", data: {} }),
		).toBeUndefined()
		expect(
			parseServerMessage({
				type: "metrics",
				channel: "metrics",
				data: { sourceId: "pi-iq" },
			}),
		).toBeUndefined()
		expect(parseServerMessage("x")).toBeUndefined()
	})
})

describe("R13: rateAssessment", () => {
	it("is dropped from decoder rows (the CLI prints no verdicts)", () => {
		const g = guardDecoder({
			...decoder,
			rateAssessment: {
				verdict: "unusable",
				reasonCode: "insufficient-sample-rate",
			},
		})
		expect(g).toBeDefined()
		expect(g && "rateAssessment" in g).toBe(false)
	})
})

describe("R15: optional decoder status fields", () => {
	const extra = {
		sourceId: "pi-iq",
		deviceSerial: "00000001",
		targetFrequenciesHz: [1090000000],
		lastError: {
			kind: "exit",
			message: "Process exited unexpectedly (code 1)",
			at: "2026-10-08T18:07:00.000Z",
		},
		idleTimeoutMs: 30000,
	}
	it("keeps well-typed optional fields", () => {
		expect(guardDecoder({ ...decoder, ...extra })).toMatchObject(extra)
	})
	it("drops malformed optional fields without rejecting the row", () => {
		const g = guardDecoder({
			...decoder,
			sourceId: 1,
			deviceSerial: null,
			targetFrequenciesHz: "1090000000",
			lastError: { kind: "crash", message: "x", at: "t" },
			idleTimeoutMs: "30s",
		})
		expect(g).toBeDefined()
		for (const k of Object.keys(extra)) expect(g && k in g).toBe(false)
	})
	it("keeps target frequencies only when every one is a positive number", () => {
		const targets = (t: unknown) =>
			guardDecoder({ ...decoder, targetFrequenciesHz: t })
		expect(targets([446525000, 1090000000])?.targetFrequenciesHz).toEqual([
			446525000, 1090000000,
		])
		for (const bad of [[446525000, "x", null], [], [0], [-1], [446525000, 0]]) {
			expect(targets(bad)).toBeDefined()
			expect(targets(bad)).not.toHaveProperty("targetFrequenciesHz")
		}
	})
	it("rejects a lastError with a missing message or time", () => {
		expect(
			guardDecoder({ ...decoder, lastError: { kind: "error", at: "t" } }),
		).not.toHaveProperty("lastError")
		expect(
			guardDecoder({ ...decoder, lastError: { kind: "error", message: "m" } }),
		).not.toHaveProperty("lastError")
	})
})

describe("R15: status events", () => {
	it("parses decoder:status as one decoder row, without rateAssessment", () => {
		const data = {
			...decoder,
			running: false,
			health: "running",
			restartCount: 8,
			rateAssessment: { verdict: "unknown" },
		}
		const e = parseServerMessage({
			type: "decoder:status",
			channel: "decoders",
			data,
		})
		expect(e).toMatchObject({
			type: "decoder:status",
			decoder: { id: "readsb", running: false, restartCount: 8 },
		})
		expect(e?.type === "decoder:status" && "rateAssessment" in e.decoder).toBe(
			false,
		)
		expect(
			parseServerMessage({
				type: "decoder:status",
				channel: "decoders",
				data: { id: "readsb" },
			}),
		).toBeUndefined()
	})
	it("parses source:status as one source item including activity", () => {
		const data = {
			id: "pi-iq",
			connected: true,
			consumers: 2,
			bytesReceived: 847000000,
			dataRate: 4800,
			reconnectAttempts: 0,
			available: true,
			caps: {
				kind: "iq",
				sampleRate: 2400000,
				format: "U8_IQ",
				exclusive: false,
			},
			assignments: [
				{
					decoderId: "dmr",
					sourceId: "pi-iq",
					assignedAt: "2026-10-08T11:00:00.000Z",
				},
			],
			activity: {
				state: "stale",
				lastSampleAt: "2026-10-08T12:00:00.000Z",
				sampleAgeMs: 12400,
				timeoutMs: 10000,
			},
		}
		expect(
			parseServerMessage({ type: "source:status", channel: "sources", data }),
		).toMatchObject({
			type: "source:status",
			source: { id: "pi-iq", activity: { state: "stale", sampleAgeMs: 12400 } },
		})
		expect(
			parseServerMessage({
				type: "source:status",
				channel: "sources",
				data: { id: "pi-iq" },
			}),
		).toBeUndefined()
	})
})

describe("A1 fix round 1", () => {
	it("R13 at compile time: DecoderRow has no rateAssessment", () => {
		const row: DecoderRow | undefined = guardDecoder(decoder)
		// @ts-expect-error DecoderRow omits rateAssessment (spec §2, R13)
		expect(row?.rateAssessment).toBeUndefined()
	})
	it("ignores a __proto__ preset key instead of reassigning the prototype", () => {
		const raw: unknown = JSON.parse(
			'{"__proto__": {"bandwidth": 1}, "nfm": {"bandwidth": 12500}}',
		)
		const p = guardPresets(raw)
		expect(p).toEqual({ nfm: { bandwidth: 12500 } })
		expect(Object.getPrototypeOf(p)).toBe(Object.prototype)
		expect(Object.keys(p ?? {})).toEqual(["nfm"])
	})
	describe("source activity: absent vs present but unrecognised", () => {
		const src = {
			id: "pi-iq",
			connected: true,
			consumers: 2,
			bytesReceived: 1,
			dataRate: 4800,
			reconnectAttempts: 0,
			available: true,
			caps: {
				kind: "iq",
				sampleRate: 2400000,
				format: "U8_IQ",
				exclusive: false,
			},
			assignments: [],
		}
		it("leaves the flag unset when activity is absent (older core)", () => {
			const g = guardSource(src)
			expect(g).toBeDefined()
			expect(g && "activity" in g).toBe(false)
			expect(g && "activityUnrecognised" in g).toBe(false)
		})
		it("flags an unknown state or malformed activity (newer core)", () => {
			for (const activity of [
				{
					state: "buffering",
					lastSampleAt: null,
					sampleAgeMs: null,
					timeoutMs: 10000,
				},
				{ state: "streaming" },
				null,
				"streaming",
			]) {
				const g = guardSource({ ...src, activity })
				expect(g).toBeDefined()
				expect(g && "activity" in g).toBe(false)
				expect(g?.activityUnrecognised).toBe(true)
			}
		})
		it("keeps valid activity without the flag", () => {
			const g = guardSource({
				...src,
				activity: {
					state: "stale",
					lastSampleAt: null,
					sampleAgeMs: 12400,
					timeoutMs: 10000,
				},
			})
			expect(g?.activity?.state).toBe("stale")
			expect(g && "activityUnrecognised" in g).toBe(false)
		})
		it("carries the flag through source:status", () => {
			const e = parseServerMessage({
				type: "source:status",
				channel: "sources",
				data: { ...src, activity: { state: "warming-up" } },
			})
			expect(e).toMatchObject({
				type: "source:status",
				source: { activityUnrecognised: true },
			})
		})
	})
})

describe("A8 / R70: core's proposed health and suspension contracts", () => {
	it("keeps a row whose health is restarting, carrying nextRestartAt", () => {
		const g = guardDecoder({
			...decoder,
			running: false,
			health: "restarting",
			restartCount: 3,
			nextRestartAt: "2026-10-08T18:08:04.000Z",
		})
		expect(g).toMatchObject({
			id: "readsb",
			health: "restarting",
			nextRestartAt: "2026-10-08T18:08:04.000Z",
		})
	})
	it("never drops a row for an unknown health string; it becomes unknown", () => {
		for (const health of ["frobnicating", "degraded", 42, null, undefined]) {
			const g = guardDecoder({ ...decoder, health })
			expect(g).toBeDefined()
			expect(g?.health).toBe("unknown")
		}
		expect(
			guardList(
				[decoder, { ...decoder, id: "x", health: "frobnicating" }],
				guardDecoder,
			),
		).toMatchObject({ rejected: 0 })
	})
	it("carries the suspension fields when well-typed", () => {
		const g = guardDecoder({
			...decoder,
			running: false,
			desiredRunning: true,
			suspended: true,
			suspension: {
				reasonCode: "insufficient-sample-rate",
				since: "2026-10-08T18:00:00.000Z",
			},
			transition: "suspending",
		})
		expect(g).toMatchObject({
			desiredRunning: true,
			suspended: true,
			suspension: {
				reasonCode: "insufficient-sample-rate",
				since: "2026-10-08T18:00:00.000Z",
			},
			transition: "suspending",
		})
	})
	it("drops malformed suspension fields and maps an unknown transition", () => {
		const g = guardDecoder({
			...decoder,
			desiredRunning: "yes",
			suspended: 1,
			suspension: { reasonCode: 5 },
			nextRestartAt: 12,
			transition: "teleporting",
		})
		expect(g).toBeDefined()
		for (const k of [
			"desiredRunning",
			"suspended",
			"suspension",
			"nextRestartAt",
		])
			expect(g && k in g).toBe(false)
		expect(g?.transition).toBe("unknown")
	})
	it("decoder:health frames keep restarting and map unknown values", () => {
		const frame = (health: unknown) =>
			parseServerMessage({
				type: "decoder:health",
				channel: "health",
				data: { decoderId: "readsb", health },
			})
		expect(frame("restarting")).toEqual({
			type: "decoder:health",
			decoderId: "readsb",
			health: "restarting",
		})
		expect(frame("frobnicating")).toEqual({
			type: "decoder:health",
			decoderId: "readsb",
			health: "unknown",
		})
	})
	it("decoder:status with a new health value still parses", () => {
		const e = parseServerMessage({
			type: "decoder:status",
			channel: "decoders",
			data: { ...decoder, health: "restarting", running: false },
		})
		expect(e).toMatchObject({
			type: "decoder:status",
			decoder: { health: "restarting" },
		})
	})
})
