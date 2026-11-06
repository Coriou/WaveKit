/**
 * "Who did what and why", read through the real routes: a protected ApiServer with the real tuner
 * controller, real access principals, the real arbiter and the real status poller parser.
 */
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type {
	AgentStatus,
	ExtendedSourceStatus,
	SdrHostStatus,
	TunerState,
} from "@wavekit/api-types"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { TunerArbiter } from "../../../src/core/scanner/tuner-arbiter.js"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import type {
	SourceCaps,
	SourceManager,
	SourceStatus,
} from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"
import { NoopClock } from "../core/scanner/tuner-arbiter-noop-harness.js"

const logger = pino({ level: "silent" })
const host = "receiver.lan:9000"
const origin = "http://receiver.lan:9000"
const browser = { host, origin }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step()
})

function realTuner(sourceId = "rtl-1") {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const transport = {
		assertTunerCommandActive: () => {},
		writeToSource: () => true,
		isRtlTcpSource: () => true,
		updateSourceCaps: (_id: string, updates: Partial<SourceCaps>) =>
			Object.assign(caps, updates),
		getCaps: () => ({ ...caps }),
		setTuningCaps: () => caps,
	}
	const controller = new TunerController(
		logger,
		transport as unknown as SourceManager,
	)
	controller.initializeSource(sourceId, { ...caps }, "rtl_tcp")
	return controller
}

function sourceStatus(patch: Partial<SourceStatus> = {}): SourceStatus {
	return {
		id: "rtl-1",
		connected: true,
		activity: {
			state: "stale",
			lastSampleAt: null,
			sampleAgeMs: null,
			timeoutMs: 5_000,
		},
		bytesReceived: 0,
		dataRate: 0,
		reconnectAttempts: 0,
		caps: {
			kind: "iq",
			sampleRate: 2_048_000,
			format: "U8_IQ",
			exclusive: false,
		},
		...patch,
	}
}

function deps(
	controller: TunerController,
	extra: Partial<ApiServerDependencies> = {},
	source: SourceStatus = sourceStatus(),
): ApiServerDependencies {
	return {
		logger,
		tunerController: controller,
		sourceManager: Object.assign(new EventEmitter(), {
			getAllStatus: () => [source],
			getStatus: () => source,
			getSourceAssignments: () => [],
			isSourceAvailable: () => true,
			runTunerCommand: (_id: string, command: () => Promise<unknown>) =>
				command(),
		}),
		decoderManager: Object.assign(new EventEmitter(), {
			getAllDecoders: () => [],
			getAllStatus: () => [],
			getAllHealth: () => new Map(),
		}),
		fanoutManager: Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
		audioOutput: Object.assign(new EventEmitter(), {
			getConnectedClients: () => 0,
			getPort: () => 0,
		}),
		...extra,
	} as unknown as ApiServerDependencies
}

async function protectedServer(controller: TunerController) {
	const root = await fs.mkdtemp(join(tmpdir(), "agent-whys-"))
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
	const directory = join(root, "private")
	const options: NamedAccessRuntimeOptions = {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [host],
			allowedOrigins: [origin],
			externalAudioOrigins: [
				"http://receiver.lan:9001",
				"http://receiver.lan:9002",
			],
		},
		audio: {
			analog: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
	}
	const storage = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = storage.useMachineCredential(value => value)
	await storage.close()
	const access = await openAccessRuntime(options)
	cleanup.push(() => access.close())
	const server = new ApiServer(deps(controller, { access }), {
		host: "127.0.0.1",
		port: 0,
		accessBootstrap: options.bootstrap,
		publicOrigins: {
			api: origin,
			analogAudio: "http://receiver.lan:9001",
			digitalAudio: "http://receiver.lan:9002",
		},
	})
	cleanup.push(() => server.stop())
	await server.start()
	const app = server.getApp()
	const machine = { host, authorization: `Bearer ${token}` }
	const issued = await app.inject({
		method: "POST",
		url: "/api/access/pairing-codes",
		headers: machine,
	})
	expect(issued.statusCode).toBe(201)
	const paired = await app.inject({
		method: "POST",
		url: "/api/access/pair",
		headers: browser,
		payload: { code: issued.json<{ code: string }>().code },
	})
	expect(paired.statusCode).toBe(201)
	const cookie = paired.headers["set-cookie"]
	if (typeof cookie !== "string") throw new Error("Missing cookie")
	const session = {
		...browser,
		cookie: cookie.split(";")[0] ?? "",
		"x-wavekit-csrf": paired.json<{ csrfToken: string }>().csrfToken,
	}
	const lastChange = async () => {
		const list = await app.inject({ url: "/api/tuner", headers: machine })
		expect(list.statusCode).toBe(200)
		return list.json<TunerState[]>()[0]?.lastChange
	}
	return { app, machine, session, lastChange }
}

async function plainServer(
	controller: TunerController,
	extra: Partial<ApiServerDependencies> = {},
	source?: SourceStatus,
) {
	const server = new ApiServer(deps(controller, extra, source), {
		host: "127.0.0.1",
		port: 0,
	})
	cleanup.push(() => server.stop())
	await server.start()
	return server.getApp()
}

describe("GET /api/tuner lastChange", () => {
	it("tells a machine-token tune from a browser session tune", async () => {
		const env = await protectedServer(realTuner())
		expect(await env.lastChange()).toBeUndefined()
		const byToken = await env.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			headers: env.machine,
			payload: { hz: 145_000_000 },
		})
		expect(byToken.statusCode).toBe(200)
		// The write's own answer carries it too.
		expect(byToken.json<TunerState>().lastChange?.actor).toBe("agent")
		expect(await env.lastChange()).toMatchObject({
			actor: "agent",
			reason: "rest-command",
			fields: expect.arrayContaining(["frequency"]) as string[],
		})
		const bySession = await env.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			headers: env.session,
			payload: { hz: 146_000_000 },
		})
		expect(bySession.statusCode).toBe(200)
		expect(await env.lastChange()).toMatchObject({
			actor: "web",
			reason: "rest-command",
		})
	})

	it("never takes an actor from the client", async () => {
		const env = await protectedServer(realTuner())
		// A session's forged "agent", then a token's forged "web": the principal decides each.
		const asSession = await env.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			headers: { ...env.session, "x-wavekit-actor": "agent" },
			payload: { hz: 145_000_000, actor: "agent" },
		})
		expect(asSession.statusCode).toBe(200)
		expect((await env.lastChange())?.actor).toBe("web")
		const asToken = await env.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			headers: { ...env.machine, "x-wavekit-actor": "web" },
			payload: { hz: 146_000_000, actor: "web" },
		})
		expect(asToken.statusCode).toBe(200)
		expect((await env.lastChange())?.actor).toBe("agent")
	})

	it("reads unknown on a core without access, never a guess", async () => {
		const app = await plainServer(realTuner())
		const response = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/ppm",
			payload: { ppm: 2 },
		})
		expect(response.statusCode).toBe(200)
		const [state] = (await app.inject("/api/tuner")).json<TunerState[]>()
		expect(state?.lastChange).toMatchObject({
			actor: "unknown",
			reason: "rest-command",
			fields: ["ppm"],
		})
	})

	it("shows the job whose lease moved the tuner, then the restore", async () => {
		const controller = realTuner()
		const app = await plainServer(controller)
		const clock = new NoopClock()
		const arbiter = new TunerArbiter({
			tuner: controller as never,
			sources: Object.assign(new EventEmitter(), {
				isRtlTcpSource: (id: string) => id === "rtl-1",
			}) as never,
			epochs: () => clock,
			settings: () => testSettings(),
			link: () => "network",
			persistLease: () => Promise.resolve(),
			impactSources: {
				liveDemod: null,
				digitalVoice: null,
				decoders: { getAllStatus: () => [] },
			},
			scannerJobsOn: () => [],
			canHandOver: () => true,
			logger,
			now: () => 1,
		} as never)
		const acquired = arbiter.acquire("j_sweep", "rtl-1", 50)
		if (!acquired.ok) throw new Error(acquired.detail)
		await arbiter.retune(acquired.lease, {
			centreHz: 446_000_000,
			gainTenthsDb: null,
			sampleRateHz: null,
		})
		const read = async () =>
			(await app.inject("/api/tuner")).json<TunerState[]>()[0]?.lastChange
		const moved = await read()
		expect(moved).toMatchObject({
			actor: "scanner-job",
			reason: "scanner-hop",
			jobId: "j_sweep",
		})
		expect(moved?.fields).toContain("frequency")
		// A settle marker is no change.
		expect(moved?.fields).not.toContain("testMode")
		await arbiter.release(acquired.lease, { restore: true })
		expect(await read()).toMatchObject({
			actor: "restore",
			reason: "scanner-restore",
			jobId: "j_sweep",
		})
	})
})

/** A status body through the real poller, so a malformed one is what the verdict reads. */
async function polled(payload: unknown): Promise<SdrHostStatus> {
	const poller = new SdrHostPoller(
		logger,
		[{ sourceId: "rtl-1", apiUrl: "http://receiver.invalid:8080" }],
		{
			fetchFn: () =>
				Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
		},
	)
	const status = new Promise<SdrHostStatus>(resolve =>
		poller.once("status", resolve),
	)
	poller.start()
	try {
		return await status
	} finally {
		poller.stop()
	}
}

describe("GET /api/sources verdict, connected at rate 0", () => {
	const read = async (hosts: SdrHostStatus[]) => {
		const app = await plainServer(realTuner(), {
			resourceAggregator: Object.assign(new EventEmitter(), {
				getSdrHostStatuses: () => hosts,
			}) as unknown as ApiServerDependencies["resourceAggregator"],
		})
		const sources = await app.inject("/api/sources")
		expect(sources.statusCode).toBe(200)
		const agent = await app.inject("/api/agent/status")
		expect(agent.statusCode).toBe(200)
		return {
			verdict: sources.json<ExtendedSourceStatus[]>()[0]?.verdict,
			short: agent.json<AgentStatus>().sources[0]?.verdict,
		}
	}

	it("fresh facts of a device loss read as receiver-no-device", async () => {
		const host = await polled({
			dongle: { present: false },
			rtlTcp: { running: false },
		})
		expect(await read([host])).toEqual({
			verdict: {
				code: "receiver-no-device",
				message:
					"receiver reports no device; check USB and re-attach it if unplugged",
				deviceFacts: "absent",
			},
			short: "receiver-no-device",
		})
	})

	it("no poller for the source says only what is known", async () => {
		const { verdict, short } = await read([])
		expect(verdict).toEqual({
			code: "no-samples",
			message: "connected with no IQ",
			deviceFacts: "none",
		})
		expect(short).toBe("no-samples")
	})

	it("stale facts assert no device state", async () => {
		const host = await polled({ dongle: { present: false } })
		const { verdict } = await read([
			{ ...host, lastFetchedAt: new Date(Date.now() - 60_000).toISOString() },
		])
		expect(verdict?.code).toBe("no-samples")
		expect(verdict?.deviceFacts).toBe("stale")
		expect(verdict?.message).not.toMatch(/re-attach/)
	})

	it("an unreachable poller asserts no device state", async () => {
		const poller = new SdrHostPoller(
			logger,
			[{ sourceId: "rtl-1", apiUrl: "http://receiver.invalid:8080" }],
			{ fetchFn: () => Promise.reject(new Error("refused")) },
		)
		poller.on("error", () => {})
		const failed = new Promise(resolve => poller.once("error", resolve))
		poller.start()
		await failed
		poller.stop()
		const { verdict } = await read(poller.getAllStatuses())
		expect(verdict?.code).toBe("no-samples")
		expect(verdict?.deviceFacts).toBe("unreachable")
	})

	it.each([
		["an empty dongle object", { dongle: {} }],
		["a non-boolean present", { dongle: { present: "no" } }],
		["no dongle at all", {}],
		["a dongle of the wrong type", { dongle: "gone" }],
	])("malformed facts make no device claim: %s", async (_name, payload) => {
		const host = await polled(payload)
		const { verdict, short } = await read([host])
		expect(verdict?.code).toBe("no-samples")
		expect(verdict?.deviceFacts).toBe("malformed")
		expect(short).toBe("no-samples")
	})

	it("carries no receiver text into the message", async () => {
		const host = await polled({
			dongle: { present: false, product: "<injected>" },
			rtlTcp: { running: false },
			errors: ["<injected>"],
			warnings: ["<injected>"],
		})
		const app = await plainServer(realTuner(), {
			resourceAggregator: Object.assign(new EventEmitter(), {
				getSdrHostStatuses: () => [host],
			}) as unknown as ApiServerDependencies["resourceAggregator"],
		})
		const body = (await app.inject("/api/agent/status")).body
		expect(body).not.toContain("injected")
	})

	it("agent status omits an ok verdict, the sources route states it", async () => {
		const app = await plainServer(
			realTuner(),
			{
				resourceAggregator: Object.assign(new EventEmitter(), {
					getSdrHostStatuses: () => [],
				}) as unknown as ApiServerDependencies["resourceAggregator"],
			},
			sourceStatus({
				activity: {
					state: "streaming",
					lastSampleAt: null,
					sampleAgeMs: 1,
					timeoutMs: 5_000,
				},
			}),
		)
		const agent = (await app.inject("/api/agent/status")).json<AgentStatus>()
		expect(agent.sources[0]).not.toHaveProperty("verdict")
		const [row] = (await app.inject("/api/sources")).json<
			ExtendedSourceStatus[]
		>()
		expect(row?.verdict?.code).toBe("ok")
	})
})
