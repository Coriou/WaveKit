import Fastify from "fastify"
import { describe, expect, it } from "vitest"
import {
	AGENT_STATUS_LIMITS,
	agentStatusSchema,
	type ScanJob,
	type TunerState,
} from "@wavekit/api-types"
import {
	agentStatusRoutes,
	buildAgentStatus,
	type AgentStatusRoutesOptions,
} from "../../../src/api/routes/agent-status.js"
import { decoderSummary } from "../../../src/api/routes/decoder-summary.js"
import type { ActivityStoreStats } from "../../../src/core/activity/storage/contract.js"
import type { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import type { SourceStatus } from "../../../src/core/source-manager.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"

const now = Date.parse("2026-10-01T12:00:00Z")

const decoder = (patch: Partial<DecoderStatus> = {}): DecoderStatus => ({
	id: "decoder-a",
	type: "multimon-ng",
	running: true,
	health: "running",
	uptime: 1,
	stats: { bytesIn: 1, eventsOut: 3, errors: 0 },
	restartCount: 0,
	lastOutputAt: new Date(now - 5_000),
	...patch,
})

const tuner = (patch: Partial<TunerState> = {}): TunerState => ({
	sourceId: "source-a",
	frequency: 100_000_000,
	sampleRate: 2_400_000,
	gainMode: "manual",
	gain: 300,
	ppm: 0,
	agcMode: false,
	biasTee: false,
	directSampling: "off",
	offsetTuning: false,
	ifGain: 0,
	tunerIfGain: null,
	testMode: false,
	controlMode: "internal",
	commandCount: 1,
	...patch,
})

const source = (patch: Partial<SourceStatus> = {}): SourceStatus =>
	({
		id: "source-a",
		type: "rtl_tcp",
		connected: true,
		activity: {
			state: "streaming",
			lastSampleAt: new Date(now).toISOString(),
			sampleAgeMs: 12,
			timeoutMs: 5_000,
		},
		bytesReceived: 1,
		dataRate: 1,
		reconnectAttempts: 0,
		caps: {},
		lastError: "a detail that must not leak into the compact status",
		...patch,
	}) as SourceStatus

const job = (patch: Partial<ScanJob> = {}): ScanJob =>
	({
		id: "job-a",
		name: "a scan job",
		state: "running",
		spec: { kind: "discover", sourceId: "source-a" },
		createdAt: "2026-10-01T11:00:00.000Z",
		updatedAt: "2026-10-01T11:30:00.000Z",
		...patch,
	}) as ScanJob

const liveStatus = (running: boolean) =>
	({
		enabled: true,
		running,
		sourceId: "source-a",
		sourceConnected: true,
		sourceIqSampleRate: 2_400_000,
		config: { modulation: "nfm", offsetHz: 12_500 },
		effectiveSampleRate: 48_000,
		decimationFactor: 50,
		httpUrl: "http://example.invalid/audio",
		clientCount: 2,
		bytesStreamed: 1,
		pipelineHealth: running ? "running" : "stopped",
		squelchOpen: true,
	}) as unknown as ReturnType<LiveDemodulator["getStatus"]>

function options(
	patch: Partial<AgentStatusRoutesOptions> = {},
): AgentStatusRoutesOptions {
	return {
		decoderManager: { getAllStatus: () => [decoder()] },
		sourceManager: { getAllStatus: () => [source()] },
		activity: { enabled: false },
		...patch,
	}
}

describe("agent status", () => {
	it("reuses the decoder summary verdict instead of recomputing it", async () => {
		const statuses = [
			decoder(),
			decoder({ id: "decoder-b", mode: "off", running: false }),
			decoder({
				id: "decoder-c",
				type: "readsb",
				suspension: { reasonCode: "tuner-scanning", since: new Date(now) },
			}),
		]
		const status = await buildAgentStatus(
			options({ decoderManager: { getAllStatus: () => statuses } }),
			now,
		)
		expect(status.decoders).toEqual(
			statuses.map(s => ({
				id: s.id,
				protocol: s.type,
				verdict: decoderSummary(s, now).verdict,
			})),
		)
	})

	it("reports the newest decode per protocol, newest first", async () => {
		const status = await buildAgentStatus(
			options({
				decoderManager: {
					getAllStatus: () => [
						decoder({ id: "a", lastOutputAt: new Date(now - 60_000) }),
						decoder({ id: "b", lastOutputAt: new Date(now - 1_000) }),
						decoder({
							id: "c",
							type: "readsb",
							lastOutputAt: new Date(now - 30_000),
						}),
						decoder({ id: "d", type: "rtl433", lastOutputAt: undefined }),
					],
				},
			}),
			now,
		)
		expect(status.lastDecode).toEqual([
			{ protocol: "multimon-ng", at: new Date(now - 1_000).toISOString() },
			{ protocol: "readsb", at: new Date(now - 30_000).toISOString() },
		])
	})

	it("names the tuner owner: external control, then a holding scanner job, else WaveKit", async () => {
		const status = await buildAgentStatus(
			options({
				tunerController: {
					getAllStates: () => [
						tuner({ sourceId: "source-a" }),
						tuner({ sourceId: "source-b", controlMode: "external" }),
						tuner({ sourceId: "source-c" }),
						tuner({ sourceId: "source-d" }),
					],
				},
				scanner: {
					status: () =>
						({ enabled: true }) as ReturnType<
							NonNullable<AgentStatusRoutesOptions["scanner"]>["status"]
						>,
					listJobs: () => [
						job({
							id: "j1",
							spec: {
								kind: "discover",
								sourceId: "source-b",
							} as ScanJob["spec"],
						}),
						job({
							id: "j2",
							spec: {
								kind: "monitor",
								sourceId: "source-c",
							} as ScanJob["spec"],
						}),
						job({
							id: "j3",
							state: "paused",
							reason: "operator",
							spec: {
								kind: "discover",
								sourceId: "source-d",
							} as ScanJob["spec"],
						}),
						job({
							id: "j4",
							state: "completed",
							spec: {
								kind: "discover",
								sourceId: "source-a",
							} as ScanJob["spec"],
						}),
					],
				},
			}),
			now,
		)
		expect(status.tuners.map(t => [t.sourceId, t.owner])).toEqual([
			["source-a", "wavekit"],
			["source-b", "external"],
			["source-c", "scanner"],
			["source-d", "wavekit"],
		])
		expect(status.scanner).toMatchObject({ enabled: true, activeJobs: 3 })
	})

	it("reports unknown tuner fields as null and flags config-only values", async () => {
		const status = await buildAgentStatus(
			options({
				tunerController: {
					getAllStates: () => [
						tuner({
							unknownFields: ["gain"],
							declaredOnlyFields: ["frequency"],
						}),
						tuner({ sourceId: "b", gainMode: "agc" }),
						tuner({ sourceId: "c", unknownFields: ["frequency", "gainMode"] }),
					],
				},
			}),
			now,
		)
		expect(status.tuners).toEqual([
			{
				sourceId: "source-a",
				frequencyHz: 100_000_000,
				sampleRateHz: 2_400_000,
				gainMode: "manual",
				gain: null,
				owner: "wavekit",
				declaredOnly: true,
			},
			expect.objectContaining({ sourceId: "b", gainMode: "agc", gain: null }),
			expect.objectContaining({
				sourceId: "c",
				frequencyHz: null,
				gainMode: null,
				gain: null,
				declaredOnly: false,
			}),
		])
	})

	it("summarizes sources without free-text errors", async () => {
		const status = await buildAgentStatus(
			options({
				sourceManager: {
					getAllStatus: () => [
						source({
							rateMismatch: {} as SourceStatus["rateMismatch"],
							signalFlat: {} as SourceStatus["signalFlat"],
						}),
					],
				},
			}),
			now,
		)
		expect(status.sources).toEqual([
			{
				id: "source-a",
				connected: true,
				state: "streaming",
				sampleAgeMs: 12,
				warnings: ["rate-mismatch", "signal-flat"],
			},
		])
		expect(JSON.stringify(status)).not.toContain("must not leak")
	})

	it("reports live audio and hides squelch while stopped", async () => {
		const running = await buildAgentStatus(
			options({ liveDemod: { getStatus: () => liveStatus(true) } }),
			now,
		)
		expect(running.liveAudio).toEqual({
			running: true,
			health: "running",
			sourceId: "source-a",
			modulation: "nfm",
			offsetHz: 12_500,
			clients: 2,
			squelchOpen: true,
		})
		const stopped = await buildAgentStatus(
			options({ liveDemod: { getStatus: () => liveStatus(false) } }),
			now,
		)
		expect(stopped.liveAudio?.squelchOpen).toBeNull()
		expect((await buildAgentStatus(options(), now)).liveAudio).toBeNull()
	})

	it("picks the most recently updated live scanner job and cuts long names at the bound", async () => {
		const longName = "x".repeat(AGENT_STATUS_LIMITS.jobNameMaxLength + 1)
		const status = await buildAgentStatus(
			options({
				scanner: {
					status: () =>
						({ enabled: false }) as ReturnType<
							NonNullable<AgentStatusRoutesOptions["scanner"]>["status"]
						>,
					listJobs: () => [
						job({ id: "old", updatedAt: "2026-10-01T10:00:00.000Z" }),
						job({
							id: "new",
							name: longName,
							updatedAt: "2026-10-01T11:59:00.000Z",
						}),
						job({
							id: "done",
							state: "failed",
							updatedAt: "2026-10-01T11:59:59.000Z",
						}),
					],
				},
			}),
			now,
		)
		expect(status.scanner?.job?.id).toBe("new")
		expect(status.scanner?.job?.name).toHaveLength(
			AGENT_STATUS_LIMITS.jobNameMaxLength,
		)
		const atBound = await buildAgentStatus(
			options({
				scanner: {
					status: () =>
						({ enabled: true }) as ReturnType<
							NonNullable<AgentStatusRoutesOptions["scanner"]>["status"]
						>,
					listJobs: () => [job({ name: longName.slice(1) })],
				},
			}),
			now,
		)
		expect(atBound.scanner?.job?.name).toBe(longName.slice(1))
	})

	it.each([
		[{ enabled: false }, { state: "disabled", rows: null }],
		[
			{ enabled: false, unavailable: true },
			{ state: "unavailable", rows: null },
		],
		[{ enabled: true }, { state: "unavailable", rows: null }],
		[
			{ enabled: true, stats: () => ({ rows: 42 }) as ActivityStoreStats },
			{ state: "available", rows: 42 },
		],
		[
			{
				enabled: true,
				stats: () =>
					({
						rows: 0,
						lifecycle: { state: "retrying" },
					}) as unknown as ActivityStoreStats,
			},
			{ state: "retrying", rows: null },
		],
		[
			{
				enabled: true,
				stats: () => Promise.reject(new Error("store gone")),
			},
			{ state: "unavailable", rows: null },
		],
	] as const)("maps Activity %#", async (activity, expected) => {
		const status = await buildAgentStatus(options({ activity }), now)
		expect(status.activity).toEqual(expected)
	})

	it("serves a full configuration under the size target with a stable shape", async () => {
		// Every built-in decoder type, two pager and two LoRa instances, each with
		// the longest verdict (three actions) and a recent decode.
		const types = [
			"readsb",
			"ais-catcher",
			"acarsdec",
			"dumpvdl2",
			"rtl433",
			"direwolf",
			"multimon-ng",
			"multimon-ng",
			"dsd-fme",
			"lora-meshtastic",
			"lora-meshtastic",
			"lora-meshtastic",
		]
		const decoders = types.map((type, index) =>
			decoder({
				id: `${type}-decoder-${index}`,
				type,
				lastOutputAt: new Date(now - index * 1_000),
				suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
				efficiency: { detail: "budget" } as NonNullable<
					DecoderStatus["efficiency"]
				>,
			}),
		)
		const app = Fastify()
		await app.register(
			agentStatusRoutes,
			options({
				decoderManager: { getAllStatus: () => decoders },
				sourceManager: {
					getAllStatus: () => [source(), source({ id: "source-b-audio" })],
				},
				tunerController: {
					getAllStates: () => [
						tuner(),
						tuner({ sourceId: "source-b-audio", controlMode: "external" }),
					],
				},
				liveDemod: { getStatus: () => liveStatus(true) },
				scanner: {
					status: () =>
						({ enabled: true }) as ReturnType<
							NonNullable<AgentStatusRoutesOptions["scanner"]>["status"]
						>,
					listJobs: () => [
						job({ name: "y".repeat(100), reason: "preempted-operator" }),
					],
				},
				activity: {
					enabled: true,
					stats: () => ({ rows: 123_456 }) as ActivityStoreStats,
				},
			}),
		)
		try {
			const response = await app.inject("/api/agent/status")
			expect(response.statusCode).toBe(200)
			const bytes = Buffer.byteLength(response.body)
			expect(bytes).toBeLessThan(AGENT_STATUS_LIMITS.targetBytes)
			const body: unknown = response.json()
			// The serialized body is exactly the DTO: the JSON schema drops nothing.
			expect(agentStatusSchema.parse(body)).toEqual(body)
			expect(Object.keys(body as object)).toEqual([
				"at",
				"tuners",
				"sources",
				"liveAudio",
				"scanner",
				"decoders",
				"activity",
				"lastDecode",
			])
			const parsed = agentStatusSchema.parse(body)
			expect(parsed.decoders).toHaveLength(types.length)
			expect(parsed.decoders[0]?.verdict.code).toBe("efficiency-budget")
			expect(parsed.lastDecode).toHaveLength(new Set(types).size)
		} finally {
			await app.close()
		}
	})

	it("serves a minimal configuration that also matches the schema", async () => {
		const app = Fastify()
		await app.register(
			agentStatusRoutes,
			options({
				decoderManager: { getAllStatus: () => [] },
				sourceManager: { getAllStatus: () => [] },
			}),
		)
		try {
			const response = await app.inject("/api/agent/status")
			expect(response.statusCode).toBe(200)
			expect(agentStatusSchema.parse(response.json())).toEqual({
				at: expect.any(String),
				tuners: [],
				sources: [],
				liveAudio: null,
				scanner: null,
				decoders: [],
				activity: { state: "disabled", rows: null },
				lastDecode: [],
			})
		} finally {
			await app.close()
		}
	})
})
