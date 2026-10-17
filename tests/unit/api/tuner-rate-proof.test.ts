/**
 * WG10 req 2.8: the operator frequency routes prove the held sample rate once
 * per connection in internal control; external and relay control answer as
 * the frozen code did (goldens recorded at 1e5b4c1f).
 */
import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

const SET_FREQUENCY = 0x01
const SET_SAMPLE_RATE = 0x02

interface Harness {
	app: FastifyInstance
	controller: TunerController
	frames: Buffer[]
	failNext: { cmd: number | null }
}

async function harness(): Promise<Harness> {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const frames: Buffer[] = []
	const failNext = { cmd: null as number | null }
	const transport = {
		writeToSource: (_id: string, frame: Buffer) => {
			if (failNext.cmd !== null && frame[0] === failNext.cmd)
				throw new Error("socket closed")
			frames.push(Buffer.from(frame))
			return true
		},
		isRtlTcpSource: () => true,
		updateSourceCaps: (_id: string, updates: Partial<SourceCaps>) =>
			Object.assign(caps, updates),
		getCaps: () => ({ ...caps }),
		setTuningCaps: () => caps,
	}
	const controller = new TunerController(
		createLogger({ level: "fatal" }),
		transport as unknown as SourceManager,
	)
	controller.initializeSource("rtl-1", { ...caps }, "rtl_tcp")
	controller.on("error", () => undefined)
	const app = Fastify({ logger: false })
	await app.register(tunerRoutes, {
		tunerController: controller,
	} as Parameters<typeof tunerRoutes>[1])
	return { app, controller, frames, failNext }
}

const cmds = (frames: Buffer[]) =>
	frames.map(f => [f[0], f.readUInt32BE(1)] as const)

describe("tuner routes prove the rate (WG10 req 2.8)", () => {
	let h: Harness
	afterEach(async () => {
		await h.app.close()
	})

	it("POST frequency: declared-only rate written once (rest), then never", async () => {
		h = await harness()
		const origins: unknown[] = []
		h.controller.on("command-sent", (...args: unknown[]) =>
			origins.push(args[3]),
		)
		let res = await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 446_000_000 },
		})
		expect(res.statusCode).toBe(200)
		expect(cmds(h.frames)).toEqual([
			[SET_SAMPLE_RATE, 2_048_000],
			[SET_FREQUENCY, 446_000_000],
		])
		expect(origins).toEqual(["rest", "rest"])
		expect(h.controller.tuningWrittenOnConnection("rtl-1")).toBe(true)
		expect(res.json()).toMatchObject({ sampleRate: 2_048_000 })
		res = await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 446_100_000 },
		})
		expect(res.statusCode).toBe(200)
		expect(cmds(h.frames).slice(2)).toEqual([[SET_FREQUENCY, 446_100_000]])
	})

	it("PATCH config with frequency only proves the rate; with sampleRate it does not add a write", async () => {
		h = await harness()
		let res = await h.app.inject({
			method: "PATCH",
			url: "/api/tuner/rtl-1/config",
			payload: { frequency: 145_000_000 },
		})
		expect(res.statusCode).toBe(200)
		expect(cmds(h.frames)).toEqual([
			[SET_SAMPLE_RATE, 2_048_000],
			[SET_FREQUENCY, 145_000_000],
		])
		h.frames.length = 0
		h.controller.synchronizeOnConnect("rtl-1")
		h.frames.length = 0
		res = await h.app.inject({
			method: "PATCH",
			url: "/api/tuner/rtl-1/config",
			payload: { frequency: 145_100_000, sampleRate: 2_400_000 },
		})
		expect(res.statusCode).toBe(200)
		expect(cmds(h.frames)).toEqual([
			[SET_FREQUENCY, 145_100_000],
			[SET_SAMPLE_RATE, 2_400_000],
		])
	})

	it("a failed rate write fails the request with today's error and no frequency write", async () => {
		h = await harness()
		h.failNext.cmd = SET_SAMPLE_RATE
		const res = await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 446_000_000 },
		})
		expect(res.statusCode).toBe(500)
		// Today's tuner error: the same reply a failed frequency write gives.
		expect(res.json()).toEqual({
			error: "Error",
			code: "TUNER_ERROR",
			message: "socket closed",
		})
		expect(h.frames).toEqual([])
		expect(h.controller.getState("rtl-1")?.frequency).toBe(100_000_000)
		// Not proven yet: the next request tries again.
		h.failNext.cmd = null
		await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 446_000_000 },
		})
		expect(cmds(h.frames)).toEqual([
			[SET_SAMPLE_RATE, 2_048_000],
			[SET_FREQUENCY, 446_000_000],
		])
		h.failNext.cmd = SET_FREQUENCY
		const freqFail = await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 446_200_000 },
		})
		expect([freqFail.statusCode, freqFail.json()]).toEqual([
			res.statusCode,
			res.json(),
		])
	})

	it("an out-of-range frequency writes no rate and fails as today", async () => {
		h = await harness()
		const res = await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 23_999_999 },
		})
		expect(res.statusCode).toBe(400)
		expect(res.json()).toMatchObject({ code: "TUNER_VALIDATION_ERROR" })
		expect(h.frames).toEqual([])
	})

	for (const mode of ["external", "relay"] as const) {
		it(`${mode} control: response equals the frozen-code golden, nothing written`, async () => {
			h = await harness()
			if (mode === "relay")
				h.controller.setControlMode("rtl-1", "external", "relay")
			else h.controller.setControlMode("rtl-1", "external")
			const post = await h.app.inject({
				method: "POST",
				url: "/api/tuner/rtl-1/frequency",
				payload: { hz: 446_000_000 },
			})
			const patch = await h.app.inject({
				method: "PATCH",
				url: "/api/tuner/rtl-1/config",
				payload: { frequency: 145_000_000 },
			})
			const golden = {
				post: [post.statusCode, post.body],
				patch: [patch.statusCode, patch.body],
			}
			if (process.env["WG10_PRINT_GOLDEN"])
				console.info(`GOLDEN ${mode} ${JSON.stringify(golden)}`)
			expect(golden).toEqual(FROZEN[mode])
			expect(h.frames).toEqual([])
		})
	}
})

const FROZEN: Record<string, unknown> = {
	external: {
		post: [
			409,
			'{"error":"TunerControlModeError","code":"TUNER_CONTROL_EXTERNAL","message":"Cannot send commands: control released to external tuner for rtl-1"}',
		],
		patch: [
			409,
			'{"error":"TunerControlModeError","code":"TUNER_CONTROL_EXTERNAL","message":"Cannot send commands: control released to external tuner for rtl-1"}',
		],
	},
	relay: {
		post: [
			409,
			'{"error":"TunerControlModeError","code":"TUNER_CONTROL_EXTERNAL","message":"Cannot send commands: control released to external tuner for rtl-1"}',
		],
		patch: [
			409,
			'{"error":"TunerControlModeError","code":"TUNER_CONTROL_EXTERNAL","message":"Cannot send commands: control released to external tuner for rtl-1"}',
		],
	},
}
