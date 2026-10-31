import Fastify from "fastify"
import { describe, expect, it } from "vitest"
import {
	AGENT_ACTIVITY_STATES,
	AGENT_SOURCE_STATES,
	AGENT_SOURCE_WARNINGS,
	AGENT_STATUS_LIMITS,
	AGENT_TUNER_OWNERS,
	DECODER_VERDICT_ACTIONS,
	DECODER_VERDICT_CODES,
	SOURCE_FEED_STATES,
	agentStatusSchema,
	jsonStringBytes,
	type AgentStatus,
	type ScanJob,
	type TunerState,
} from "@wavekit/api-types"
import {
	agentStatusRoutes,
	buildAgentStatus,
	clipJson,
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

type ScannerFake = NonNullable<AgentStatusRoutesOptions["scanner"]>

/** A scanner whose tuner leases are `holders` (source id to job id), as the arbiter keeps them. */
function scanner(
	jobs: ScanJob[],
	holders: Record<string, string> = {},
	enabled = true,
): ScannerFake {
	return {
		status: () => ({ enabled }) as ReturnType<ScannerFake["status"]>,
		listJobs: () => jobs,
		tunerLeaseHolder: sourceId => holders[sourceId] ?? null,
	}
}

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
		// The suspended decoder is a problem row, so it leads; the rest keep their order.
		expect(status.decoders).toEqual(
			[statuses[2]!, statuses[0]!, statuses[1]!].map(s => ({
				id: s.id,
				protocol: s.type,
				verdict: {
					code: decoderSummary(s, now).verdict.code,
					actions: decoderSummary(s, now).verdict.actions,
				},
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

	it("names the tuner owner from lease ownership, not job state", async () => {
		const spec = (kind: string, sourceId: string) =>
			({ kind, sourceId }) as ScanJob["spec"]
		const status = await buildAgentStatus(
			options({
				tunerController: {
					getAllStates: () => [
						tuner({ sourceId: "source-a" }),
						tuner({ sourceId: "source-b", controlMode: "external" }),
					],
				},
				scanner: scanner(
					[
						// External control wins over a lease.
						job({ id: "j1", spec: spec("discover", "source-b") }),
						// A running passive job never takes a lease.
						job({
							id: "j2",
							passive: true,
							spec: spec("discover", "source-a"),
						}),
					],
					{ "source-b": "j1" },
				),
			}),
			now,
		)
		expect(status.tuners.map(t => [t.sourceId, t.owner])).toEqual([
			["source-a", "wavekit"],
			["source-b", "external"],
		])
		expect(status.scanner).toMatchObject({ enabled: true, activeJobs: 2 })
	})

	it("keeps an operator-paused sweep as owner while it holds the lease", async () => {
		const paused = job({
			id: "j3",
			state: "paused",
			reason: "operator",
			spec: { kind: "discover", sourceId: "source-a" } as ScanJob["spec"],
		})
		const held = await buildAgentStatus(
			options({
				tunerController: { getAllStates: () => [tuner()] },
				scanner: scanner([paused], { "source-a": "j3" }),
			}),
			now,
		)
		expect(held.tuners[0]?.owner).toBe("scanner")
		// The same paused job once its lease is released: WaveKit owns the tuner again.
		const released = await buildAgentStatus(
			options({
				tunerController: { getAllStates: () => [tuner()] },
				scanner: scanner([paused]),
			}),
			now,
		)
		expect(released.tuners[0]?.owner).toBe("wavekit")
	})

	it("reports unknown tuner fields as null and flags config-only values", async () => {
		const tuners = async (states: TunerState[]) =>
			(
				await buildAgentStatus(
					options({ tunerController: { getAllStates: () => states } }),
					now,
				)
			).tuners
		expect(
			await tuners([
				tuner({
					unknownFields: ["gain"],
					declaredOnlyFields: ["frequency"],
				}),
				tuner({ sourceId: "b", gainMode: "agc" }),
			]),
		).toEqual([
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
		])
		expect(
			await tuners([
				tuner({ sourceId: "c", unknownFields: ["frequency", "gainMode"] }),
			]),
		).toEqual([
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
				feed: "live",
				tuningUnverified: false,
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
		const longName = "x".repeat(AGENT_STATUS_LIMITS.jobNameMaxBytes + 1)
		const status = await buildAgentStatus(
			options({
				scanner: scanner(
					[
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
					{},
					false,
				),
			}),
			now,
		)
		expect(status.scanner?.job?.id).toBe("new")
		expect(status.scanner?.job?.name).toHaveLength(
			AGENT_STATUS_LIMITS.jobNameMaxBytes,
		)
		// A shortened name alone does not mark the answer truncated.
		expect(status.truncated).toBe(false)
		const atBound = await buildAgentStatus(
			options({
				scanner: scanner([job({ name: longName.slice(1) })]),
			}),
			now,
		)
		expect(atBound.scanner?.job?.name).toBe(longName.slice(1))
	})

	it("reports a paused feed on the source row", async () => {
		const status = await buildAgentStatus(
			options({
				sourceManager: {
					getAllStatus: () => [
						source({
							connected: false,
							activity: {
								state: "paused",
								lastSampleAt: null,
								sampleAgeMs: null,
								timeoutMs: 5_000,
							},
							feed: { state: "paused", since: "2026-10-01T11:00:00.000Z" },
						}),
					],
				},
			}),
			now,
		)
		expect(status.sources[0]).toMatchObject({
			feed: "paused",
			tuningUnverified: false,
		})
		expect(agentStatusSchema.parse(status)).toEqual(status)
	})

	it("flags a plainly resumed source whose tuning is unverified", async () => {
		const resumed = (unknownFields: NonNullable<TunerState["unknownFields"]>) =>
			buildAgentStatus(
				options({
					sourceManager: {
						getAllStatus: () => [
							source({
								feed: { state: "live", since: "2026-10-01T11:59:00.000Z" },
							}),
							source({ id: "source-b" }),
						],
					},
					tunerController: {
						getAllStates: () => [
							tuner({ unknownFields }),
							tuner({ sourceId: "source-b", unknownFields: ["ppm"] }),
						],
					},
				}),
				now,
			)
		const status = await resumed(["frequency", "gain", "gainMode"])
		expect(status.sources).toEqual([
			expect.objectContaining({
				id: "source-a",
				state: "streaming",
				feed: "live",
				tuningUnverified: true,
			}),
			// Other unknown fields do not mean the receiver may be tuned elsewhere.
			expect.objectContaining({ id: "source-b", tuningUnverified: false }),
		])
		expect((await resumed(["sampleRate"])).sources[0]?.tuningUnverified).toBe(
			true,
		)
	})

	it("shows a held sweep even when a newer job exists", async () => {
		const status = await buildAgentStatus(
			options({
				scanner: scanner([
					job({
						id: "held",
						state: "paused",
						reason: "resumed-without-retune",
						updatedAt: "2026-10-01T10:00:00.000Z",
					} as Partial<ScanJob>),
					job({ id: "newer", updatedAt: "2026-10-01T11:59:00.000Z" }),
				]),
			}),
			now,
		)
		expect(status.scanner).toMatchObject({
			activeJobs: 2,
			heldJobs: 1,
			job: { id: "held", state: "paused", reason: "resumed-without-retune" },
		})
		const plain = await buildAgentStatus(
			options({ scanner: scanner([job()]) }),
			now,
		)
		expect(plain.scanner?.heldJobs).toBe(0)
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

	const longest = (values: readonly string[]) =>
		values.reduce((a, b) => (b.length > a.length ? b : a))
	// Every number at the longest a double serialises to (24 bytes signed, 23 unsigned).
	const signed = -1.2345678901234567e-300
	const unsigned = 1.2345678901234567e-300
	const count = 1.2345678901234567e300
	const isoMax = new Date(8.64e15).toISOString()
	const ascii = (char: string, bytes: number) => char.repeat(bytes)

	it("bounds the largest body the schema admits under the target (the limit arithmetic)", () => {
		const actions = [...DECODER_VERDICT_ACTIONS]
			.sort((a, b) => b.length - a.length)
			.slice(0, AGENT_STATUS_LIMITS.actionsMax)
		const worst: AgentStatus = {
			at: isoMax,
			truncated: false,
			tuners: Array.from({ length: AGENT_STATUS_LIMITS.sourcesMax }, () => ({
				sourceId: ascii("t", AGENT_STATUS_LIMITS.idMaxBytes),
				frequencyHz: unsigned,
				sampleRateHz: unsigned,
				gainMode: "manual" as const,
				gain: signed,
				owner: longest(
					AGENT_TUNER_OWNERS,
				) as AgentStatus["tuners"][number]["owner"],
				declaredOnly: false,
			})),
			sources: Array.from({ length: AGENT_STATUS_LIMITS.sourcesMax }, () => ({
				id: ascii("s", AGENT_STATUS_LIMITS.idMaxBytes),
				connected: false,
				state: longest(
					AGENT_SOURCE_STATES,
				) as AgentStatus["sources"][number]["state"],
				sampleAgeMs: unsigned,
				warnings: [...AGENT_SOURCE_WARNINGS],
				feed: longest(
					SOURCE_FEED_STATES,
				) as AgentStatus["sources"][number]["feed"],
				tuningUnverified: false,
			})),
			liveAudio: {
				running: false,
				health: "starting",
				sourceId: ascii("l", AGENT_STATUS_LIMITS.idMaxBytes),
				modulation: ascii("m", AGENT_STATUS_LIMITS.modulationMaxBytes),
				offsetHz: signed,
				clients: count,
				squelchOpen: false,
			},
			scanner: {
				enabled: false,
				activeJobs: count,
				heldJobs: count,
				job: {
					id: ascii("j", AGENT_STATUS_LIMITS.idMaxBytes),
					name: ascii("n", AGENT_STATUS_LIMITS.jobNameMaxBytes),
					kind: "identify",
					state: "completed",
					reason: ascii("r", AGENT_STATUS_LIMITS.reasonMaxBytes),
					sourceId: ascii("s", AGENT_STATUS_LIMITS.idMaxBytes),
				},
			},
			decoders: Array.from({ length: AGENT_STATUS_LIMITS.decodersMax }, () => ({
				id: ascii("d", AGENT_STATUS_LIMITS.idMaxBytes),
				protocol: ascii("p", AGENT_STATUS_LIMITS.protocolMaxBytes),
				verdict: {
					code: longest(
						DECODER_VERDICT_CODES,
					) as AgentStatus["decoders"][number]["verdict"]["code"],
					actions,
				},
			})),
			hiddenProblems: count,
			activity: {
				state: longest(
					AGENT_ACTIVITY_STATES,
				) as AgentStatus["activity"]["state"],
				rows: count,
			},
			lastDecode: Array.from(
				{ length: AGENT_STATUS_LIMITS.decodersMax },
				() => ({
					protocol: ascii("p", AGENT_STATUS_LIMITS.protocolMaxBytes),
					at: isoMax,
				}),
			),
		}
		expect(agentStatusSchema.parse(worst)).toEqual(worst)
		expect(Buffer.byteLength(JSON.stringify(worst))).toBeLessThan(
			AGENT_STATUS_LIMITS.targetBytes,
		)
		// One more row in any capped list, or one more byte in a string, is refused.
		const past = (patch: Partial<AgentStatus>) =>
			agentStatusSchema.safeParse({ ...worst, ...patch }).success
		expect(past({ decoders: [...worst.decoders, worst.decoders[0]!] })).toBe(
			false,
		)
		expect(past({ sources: [...worst.sources, worst.sources[0]!] })).toBe(false)
		expect(past({ tuners: [...worst.tuners, worst.tuners[0]!] })).toBe(false)
		expect(
			past({ lastDecode: [...worst.lastDecode, worst.lastDecode[0]!] }),
		).toBe(false)
		expect(
			past({
				sources: [
					{
						...worst.sources[0]!,
						id: ascii("s", AGENT_STATUS_LIMITS.idMaxBytes + 1),
					},
				],
			}),
		).toBe(false)
		// A byte cap counts JSON bytes: a 7-character id of quotes is 14 bytes.
		expect(
			past({
				sources: [{ ...worst.sources[0]!, id: '"'.repeat(21) }],
			}),
		).toBe(false)
	})

	/** Decoder statuses for `count` distinct protocols with `idOf(index)` ids. */
	function decoders(total: number, idOf: (index: number) => string) {
		return Array.from({ length: total }, (_, index) =>
			decoder({
				id: idOf(index),
				type: `${"p".repeat(20)}-${String(index).padStart(3, "0")}`,
				lastOutputAt: new Date(now - index * 1_000),
				suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
				efficiency: { detail: "budget" } as NonNullable<
					DecoderStatus["efficiency"]
				>,
			}),
		)
	}

	async function serve(o: AgentStatusRoutesOptions) {
		const app = Fastify()
		await app.register(agentStatusRoutes, o)
		try {
			const response = await app.inject("/api/agent/status")
			expect(response.statusCode).toBe(200)
			const body: unknown = response.json()
			// The serialized body is exactly the DTO: the JSON schema drops nothing.
			expect(agentStatusSchema.parse(body)).toEqual(body)
			return {
				bytes: Buffer.byteLength(response.body),
				body: agentStatusSchema.parse(body),
			}
		} finally {
			await app.close()
		}
	}

	function full(
		decoderStatuses: DecoderStatus[],
		sourceIds: string[],
		jobPatch: Partial<ScanJob>,
	): AgentStatusRoutesOptions {
		return options({
			decoderManager: { getAllStatus: () => decoderStatuses },
			sourceManager: {
				getAllStatus: () => sourceIds.map(id => source({ id })),
			},
			tunerController: {
				getAllStates: () => sourceIds.map(sourceId => tuner({ sourceId })),
			},
			liveDemod: { getStatus: () => liveStatus(true) },
			scanner: scanner([job(jobPatch)], { [sourceIds[0] ?? ""]: "job-a" }),
			activity: {
				enabled: true,
				stats: () => ({ rows: 123_456 }) as ActivityStoreStats,
			},
		})
	}

	it("serves a configuration at every cap whole, under the target, not truncated", async () => {
		const max = AGENT_STATUS_LIMITS.idMaxBytes
		const { bytes, body } = await serve(
			full(
				decoders(AGENT_STATUS_LIMITS.decodersMax, i =>
					`decoder-${i}-`.padEnd(max, "d"),
				),
				Array.from({ length: AGENT_STATUS_LIMITS.sourcesMax }, (_, i) =>
					`source-${i}-`.padEnd(max, "s"),
				),
				{
					id: "j_".padEnd(max, "J"),
					sourceId: "source-0-".padEnd(max, "s"),
				} as Partial<ScanJob>,
			),
		)
		expect(bytes).toBeLessThan(AGENT_STATUS_LIMITS.targetBytes)
		expect(body.truncated).toBe(false)
		expect(body.decoders).toHaveLength(AGENT_STATUS_LIMITS.decodersMax)
		expect(body.decoders.every(d => d.id.length === max)).toBe(true)
		expect(body.decoders[0]?.verdict.code).toBe("efficiency-budget")
		expect(body.lastDecode).toHaveLength(AGENT_STATUS_LIMITS.decodersMax)
		expect(body.tuners).toHaveLength(AGENT_STATUS_LIMITS.sourcesMax)
		expect(body.tuners[0]?.owner).toBe("scanner")
		expect(body.scanner?.job?.id).toHaveLength(max)
		expect(Object.keys(body)).toEqual([
			"at",
			"truncated",
			"tuners",
			"sources",
			"liveAudio",
			"scanner",
			"decoders",
			"hiddenProblems",
			"activity",
			"lastDecode",
		])
		expect(body.hiddenProblems).toBe(0)
	})

	it("cuts lists and ids past their caps and says so", async () => {
		// Escapes and multi-byte characters count at their JSON byte size.
		const huge = (tag: string, i: number) => `${tag}${i}"\\\u0001é😀`.repeat(40)
		const { bytes, body } = await serve(
			full(
				decoders(AGENT_STATUS_LIMITS.decodersMax + 3, i => huge("d", i)),
				Array.from({ length: AGENT_STATUS_LIMITS.sourcesMax + 2 }, (_, i) =>
					huge("s", i),
				),
				{
					id: huge("j", 0),
					name: huge("n", 0),
					sourceId: huge("s", 0),
				} as Partial<ScanJob>,
			),
		)
		expect(bytes).toBeLessThan(AGENT_STATUS_LIMITS.targetBytes)
		expect(body.truncated).toBe(true)
		expect(body.decoders).toHaveLength(AGENT_STATUS_LIMITS.decodersMax)
		expect(body.lastDecode).toHaveLength(AGENT_STATUS_LIMITS.decodersMax)
		expect(body.sources).toHaveLength(AGENT_STATUS_LIMITS.sourcesMax)
		expect(body.tuners).toHaveLength(AGENT_STATUS_LIMITS.sourcesMax)
		for (const row of [...body.decoders, ...body.sources])
			expect(jsonStringBytes(row.id)).toBeLessThanOrEqual(
				AGENT_STATUS_LIMITS.idMaxBytes,
			)
		// Cut at a code point: no lone surrogate is left behind.
		expect(body.decoders.every(d => d.id.isWellFormed())).toBe(true)
		expect(jsonStringBytes(body.scanner?.job?.name ?? "")).toBeLessThanOrEqual(
			AGENT_STATUS_LIMITS.jobNameMaxBytes,
		)
	})

	it("keeps a problem decoder listed when healthy rows pass the cap", async () => {
		// Twelve decoders in config order; only the last is failed.
		const statuses = Array.from({ length: 12 }, (_, index) =>
			decoder({ id: `decoder-${index}` }),
		)
		statuses[11] = decoder({
			id: "decoder-11",
			running: false,
			health: "faulted",
		})
		const status = await buildAgentStatus(
			options({ decoderManager: { getAllStatus: () => statuses } }),
			now,
		)
		const failedCode = decoderSummary(statuses[11]!, now).verdict.code
		expect(["decoding", "listening", "off"]).not.toContain(failedCode)
		expect(status.decoders).toHaveLength(AGENT_STATUS_LIMITS.decodersMax)
		expect(status.decoders[0]?.id).toBe("decoder-11")
		// Healthy rows follow in config order; the last three are cut.
		expect(status.decoders.slice(1).map(d => d.id)).toEqual(
			Array.from({ length: 8 }, (_, index) => `decoder-${index}`),
		)
		expect(status.truncated).toBe(true)
		expect(status.hiddenProblems).toBe(0)
	})

	it("counts the problem decoders the cap still cuts", async () => {
		const max = AGENT_STATUS_LIMITS.decodersMax
		const suspended = (index: number) =>
			decoder({
				id: `problem-${index}`,
				suspension: { reasonCode: "tuner-scanning", since: new Date(now) },
			})
		// At the cap: every problem shows, none hidden.
		const atCap = await buildAgentStatus(
			options({
				decoderManager: {
					getAllStatus: () => [
						decoder({ id: "healthy" }),
						...Array.from({ length: max }, (_, i) => suspended(i)),
					],
				},
			}),
			now,
		)
		expect(atCap.decoders.map(d => d.id)).toEqual(
			Array.from({ length: max }, (_, i) => `problem-${i}`),
		)
		expect(atCap.hiddenProblems).toBe(0)
		// Past the cap: the extra problem rows are counted.
		const past = await buildAgentStatus(
			options({
				decoderManager: {
					getAllStatus: () =>
						Array.from({ length: max + 2 }, (_, i) => suspended(i)),
				},
			}),
			now,
		)
		expect(past.decoders).toHaveLength(max)
		expect(past.hiddenProblems).toBe(2)
		expect(past.truncated).toBe(true)
	})

	it("cuts at a code point without exceeding the byte cap", () => {
		expect(clipJson("abc", 3)).toBe("abc")
		expect(clipJson("abcd", 3)).toBe("abc")
		expect(clipJson("a😀", 4)).toBe("a")
		expect(clipJson("a😀", 5)).toBe("a😀")
		expect(clipJson('a"', 2)).toBe("a")
		expect(clipJson("\u0001", 5)).toBe("")
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
				truncated: false,
				tuners: [],
				sources: [],
				liveAudio: null,
				scanner: null,
				decoders: [],
				hiddenProblems: 0,
				activity: { state: "disabled", rows: null },
				lastDecode: [],
			})
		} finally {
			await app.close()
		}
	})
})
