/**
 * One user-facing reason while a source's tuning is unproven, through production wiring and
 * Fastify serialisation: a real SourceManager (tuning ledger), TunerController on
 * wireTunerControl and the stamped fake rtl_tcp on an ephemeral loopback port. A plain resume
 * leaves the centre and rate unproven: GET /api/sources names `plain-resume` with its message,
 * fix, start and the refusals since, agent status carries the compact `tuning` code; once the
 * operator sets the tuning, both are gone.
 */
import {
	agentStatusSchema,
	type ExtendedSourceStatus,
} from "@wavekit/api-types"
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { agentStatusRoutes } from "../../../src/api/routes/agent-status.js"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import type { SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { createLogger } from "../../../src/utils/logger.js"
import { startStampedRtlTcp } from "../../mocks/stamped-rtl-tcp.js"

const logger = createLogger({ level: "fatal" })
const cleanups: (() => unknown)[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 250 ksps U8 IQ: the fake delivers 2500 B every 5 ms (500 kB/s), so rate truth agrees. */
const RATE = 250_000
const F0 = 100_000_000
const F1 = 101_000_000

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

describe("tuningUnproven on GET /api/sources and agent status", () => {
	it("a plain resume: one reason with its fix and refusal counts, serialised; gone once the tuning is set", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const fake = await startStampedRtlTcp({
			initialHz: F0,
			initialRate: RATE,
			chunkBytes: 2_500,
		})
		cleanups.push(() => fake.close())
		const config = {
			id: "rtl",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: fake.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: RATE,
				centerFreq: F0,
				exclusive: false,
			},
		} as SourceConfig
		const manager = new SourceManager(logger, {
			tuningSettleMs: () => 0,
			tuningInFlightBytes: 4096,
		})
		manager.on("error", () => undefined)
		cleanups.push(() => manager.disconnectAll())
		const controller = new TunerController(logger, manager)
		controller.on("error", () => undefined)
		controller.initializeSource("rtl", config.caps, "rtl_tcp")
		wireTunerControl({
			log: logger,
			sourceManager: manager,
			tunerController: controller,
			tunerRelay: new TunerRelay(logger, manager, new FanoutManager(logger), {
				enabled: false,
				host: "127.0.0.1",
				port: 1,
				controlPolicy: "shared",
			}),
			relayEnabled: false,
		})
		const stream = await manager.connect(config)
		stream.resume()
		const ledger = manager.tuningLedger
		const flowing = async (session: number) =>
			until(
				() =>
					ledger.position("rtl")?.session === session &&
					(ledger.position("rtl")?.pos ?? 0) > 64 * 1024,
			)
		const proof = () => controller.getState("rtl")!.proof!
		await flowing(1)
		await until(() => proof().frequency.state === "commanded")
		const app = Fastify()
		cleanups.push(() => app.close())
		await app.register(sourceRoutes, { sourceManager: manager })
		await app.register(agentStatusRoutes, {
			decoderManager: { getAllStatus: () => [] },
			sourceManager: manager,
			tunerController: controller,
			activity: { enabled: false },
		})
		const sources = async () => {
			const res = await app.inject("/api/sources")
			expect(res.statusCode).toBe(200)
			return res.json<ExtendedSourceStatus[]>()
		}
		const agentRow = async () => {
			const res = await app.inject("/api/agent/status")
			expect(res.statusCode).toBe(200)
			const body: unknown = res.json()
			// The serialised body is exactly the DTO: the response schema drops nothing.
			expect(agentStatusSchema.parse(body)).toEqual(body)
			return agentStatusSchema.parse(body).sources[0]!
		}
		// Proven: nothing to say.
		expect((await sources())[0]!.tuningUnproven).toBeUndefined()
		expect((await agentRow()).tuning).toBeUndefined()

		// The operator retunes, pauses and resumes without restore.
		await controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(() => proof().frequency.state === "commanded")
		await manager.pause("rtl")
		const before = Date.now()
		await manager.resume("rtl")
		await flowing(2)
		await wait(100)
		expect(fake.tuning().centre).toBe(F1)
		// What the recorder and identification report while it stands.
		manager.tuningUnproven.noteRefusal("rtl", "recording")
		manager.tuningUnproven.noteRefusal("rtl", "recording")
		manager.tuningUnproven.noteRefusal("rtl", "identification")
		const held = (await sources())[0]!.tuningUnproven!
		expect(held).toEqual({
			code: "tuning-unproven",
			cause: "plain-resume",
			fields: ["frequency", "sampleRate"],
			message:
				"Tuning not proven since a resume without restore: recordings and identification are paused until the tuning is set or restored (GET /api/tuner/:sourceId `resumeOutcome` says why the core left it as found)",
			fix: "Take the tuning back in one call (POST /api/tuner/:sourceId/take-back writes the held centre and rate), or set it (POST /api/tuner/:sourceId/tune)",
			since: held.since,
			refusals: { recording: 2, identification: 1 },
		})
		expect(Date.parse(held.since)).toBeGreaterThanOrEqual(before - 1000)
		expect((await agentRow()).tuning).toBe("plain-resume")
		// A later read keeps the period and its counts.
		await wait(50)
		expect((await sources())[0]!.tuningUnproven).toEqual(held)

		// The operator sets the tuning: proven, the reason is gone everywhere.
		await controller.setSampleRate("rtl", RATE, { origin: "rest" })
		await controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(
			() =>
				proof().frequency.state === "commanded" &&
				proof().sampleRate.state === "commanded",
		)
		expect((await sources())[0]!.tuningUnproven).toBeUndefined()
		expect((await agentRow()).tuning).toBeUndefined()
	}, 30_000)
})
