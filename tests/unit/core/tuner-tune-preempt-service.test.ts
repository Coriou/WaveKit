/**
 * POST /tune with `preempt: true` against the real ScannerService, TunerArbiter, TunerController and
 * SourceManager, over an in-process fake rtl_tcp on an ephemeral loopback port: a tune that asks for
 * what the tuner already has must still take the lease, or the sweep moves the tuner straight after.
 */
import { once } from "node:events"
import * as net from "node:net"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { createLogger } from "../../../src/utils/logger.js"
import { FakeFanout, testSettings } from "../../mocks/scanner/engine-fakes.js"
import {
	ServiceFakeDecoders,
	feedTone,
	settled,
} from "../../mocks/scanner/service-fakes.js"
import { makeTmpDir } from "../../helpers/tmp-dir.js"

const SET_FREQUENCY = 1
const SET_GAIN_MODE = 3
const SET_GAIN = 4
const SET_PPM = 5
const START_HZ = 446_100_000

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
})

const quiet = createLogger({ level: "fatal" })

/** Frames cross a real socket: a bound for what they reach, never a fixed sleep. */
const WAIT = { timeout: 5_000, interval: 5 }

/** More than one hop, so a job that kept its lease would leave the tuning at its next hop. */
const sweep = (priority: number, autoAfterIdleMs: number | null = 60_000) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 453_000_000 }],
	priority,
	takeover: true,
	name: "Night sweep",
	resume: { autoAfterIdleMs },
})

async function setup() {
	const frames: Array<{ cmd: number; value: number }> = []
	const sockets: net.Socket[] = []
	const server = net.createServer(socket => {
		sockets.push(socket)
		socket.on("error", () => {})
		let pending = Buffer.alloc(0)
		socket.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk])
			while (pending.length >= 5) {
				frames.push({
					cmd: pending.readUInt8(0),
					value: pending.readUInt32BE(1),
				})
				pending = pending.subarray(5)
			}
		})
		socket.write(Buffer.concat([Buffer.from("RTL0"), Buffer.alloc(16)]))
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => {
			server.close(() => resolve())
		})
	})
	const port = (server.address() as net.AddressInfo).port
	const caps = {
		kind: "iq" as const,
		sampleRate: 1_024_000,
		centerFreq: START_HZ,
		format: "U8_IQ" as const,
		exclusive: false,
	}
	const manager = new SourceManager(quiet)
	cleanup.push(() => manager.disconnectAll())
	manager.on("error", () => {})
	const controller = new TunerController(quiet, manager, {})
	controller.on("error", () => {})
	wireTunerControl({
		log: quiet,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: { handleSourceConnected: () => {} } as unknown as TunerRelay,
		relayEnabled: false,
	})
	const dir = makeTmpDir("wk-preempt-")
	const fanout = new FakeFanout()
	const service = new ScannerService({
		settings: testSettings(s => {
			s.sweep.markers = false
			s.sweep.settleMs.local = 50
			s.sweep.settleMs.network = 50
			s.passive.enabled = false
		}, dir),
		sourceConfigs: [
			{
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port,
				loop: false,
				playbackSpeed: 1,
				caps,
			},
		],
		decoderConfigs: [],
		region: "EU",
		stateDir: dir,
		sources: manager as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
		} as never,
		tuner: controller as never,
		decoders: new ServiceFakeDecoders() as never,
		digitalVoice: null,
		liveDemod: null,
		logger: pino({ level: "silent" }),
		engineHost: "inline",
		tickMs: 20,
	})
	const app = Fastify()
	await app.register(tunerRoutes, {
		tunerController: controller,
		sourceManager: manager,
		principalKind: () => "machine",
		scannerLeaseHolder: sourceId => service.tunerLeaseJob(sourceId),
	})
	await app.ready()
	cleanup.push(() => app.close())
	await service.start()
	cleanup.push(() => service.stop())
	const payload = once(manager, "payload-started")
	await manager.connect({
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: 0,
		caps,
	})
	await payload
	await settled(service)
	const post = (body: object) =>
		app.inject({ method: "POST", url: "/api/tuner/rtl/tune", payload: body })
	/** Samples are what move a sweep on: it stays on its hop until some come. */
	const feed = async (seconds: number, seed: number) => {
		feedTone(fanout, seconds, 0, 0, seed)
		await settled(service)
	}
	const running = async (id: string) => {
		for (let i = 0; i < 50 && service.getJob(id)?.state === "starting"; i++) {
			await settled(service)
			await feed(0.1, 20 + i)
		}
		await settled(service)
		expect(service.getJob(id)?.state).toBe("running")
		expect(controller.getState("rtl")?.frequency).not.toBe(START_HZ)
	}
	/** Everything written before now has arrived, in order: a later frame came through the same socket. */
	const drained = async () => {
		const mark = 100 + frames.length
		await controller.setPpm("rtl", mark, { origin: "rest" })
		await vi.waitFor(
			() => expect(frames).toContainEqual({ cmd: SET_PPM, value: mark }),
			WAIT,
		)
		return frames.filter(frame => frame.cmd !== SET_PPM)
	}
	return { controller, drained, frames, post, feed, running, service }
}

describe("preempt: true for a value already on the tuner", () => {
	it("a tune to the hop the sweep sits on takes the lease, and the tuner stays there", async () => {
		const h = await setup()
		const job = await h.service.createJob(sweep(50))
		await h.running(job.id)
		const hop = h.controller.getState("rtl")!.frequency
		await vi.waitFor(
			() => expect(h.frames).toContainEqual({ cmd: SET_FREQUENCY, value: hop }),
			WAIT,
		)
		h.frames.length = 0
		const res = await h.post({ frequencyHz: hop, preempt: true })
		expect(res.statusCode).toBe(200)
		expect(res.json().applied).toEqual(["frequencyHz"])
		expect(res.json().preempted).toMatchObject({
			jobId: job.id,
			jobName: "Night sweep",
			job: "paused",
			autoAfterIdleMs: 60_000,
			waiters: [],
		})
		await vi.waitFor(
			() => expect(h.frames).toContainEqual({ cmd: SET_FREQUENCY, value: hop }),
			WAIT,
		)
		await settled(h.service)
		expect(h.service.tunerLeaseHolder("rtl")).toBeNull()
		expect(h.service.getJob(job.id)).toMatchObject({
			state: "paused",
			reason: "preempted-operator",
		})
		await h.feed(1, 90)
		expect(h.controller.getState("rtl")?.frequency).toBe(hop)
	})

	it.each([
		["gain", { gain: 200 }, SET_GAIN],
		["gain mode", { gainMode: "manual" }, SET_GAIN_MODE],
		["gain mode and gain", { gainMode: "manual", gain: 200 }, SET_GAIN_MODE],
	])(
		"a %s already at its value takes the lease",
		async (_name, settings, frame) => {
			const h = await setup()
			await h.post({ gainMode: "manual", gain: 200 })
			const job = await h.service.createJob(sweep(50))
			await h.running(job.id)
			// Not `drained`: an operator write there would take the lease itself.
			const hop = h.controller.getState("rtl")!.frequency
			await vi.waitFor(
				() =>
					expect(h.frames).toContainEqual({ cmd: SET_FREQUENCY, value: hop }),
				WAIT,
			)
			h.frames.length = 0
			const res = await h.post({ ...settings, preempt: true })
			expect(res.statusCode).toBe(200)
			expect(res.json().preempted.jobId).toBe(job.id)
			await vi.waitFor(() => expect(h.frames[0]?.cmd).toBe(frame), WAIT)
			await settled(h.service)
			expect(h.service.tunerLeaseHolder("rtl")).toBeNull()
			expect(h.controller.getState("rtl")).toMatchObject({
				gainMode: "manual",
				gain: 200,
			})
		},
	)

	it("a temporary tune to the hop takes the lease too, and says no restore comes", async () => {
		const h = await setup()
		const job = await h.service.createJob(sweep(50))
		await h.running(job.id)
		const hop = h.controller.getState("rtl")!.frequency
		const res = await h.post({
			frequencyHz: hop,
			restoreAfterS: 5,
			preempt: true,
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().preempted.jobId).toBe(job.id)
		expect(res.json().preempted.message).toContain("No restore comes")
		expect(res.json().restore).toMatchObject({
			status: "cancelled",
			cancelledBy: {
				reason: "scanner-preempted",
				job: { jobId: job.id },
			},
		})
		await settled(h.service)
		expect(h.service.tunerLeaseHolder("rtl")).toBeNull()
	})

	it("with no lease held it sends nothing: consent to preempt is no reason to write", async () => {
		const h = await setup()
		await h.post({ frequencyHz: 120_000_000 })
		await h.drained()
		h.frames.length = 0
		const res = await h.post({ frequencyHz: 120_000_000, preempt: true })
		expect(res.statusCode).toBe(200)
		expect(res.json()).not.toHaveProperty("preempted")
		expect(await h.drained()).toEqual([])
	})

	it("without preempt it still answers 409 and sends nothing", async () => {
		const h = await setup()
		const job = await h.service.createJob(sweep(50))
		await h.running(job.id)
		const hop = h.controller.getState("rtl")!.frequency
		const before = h.frames.length
		const res = await h.post({ frequencyHz: hop })
		expect(res.statusCode).toBe(409)
		expect(res.json()).toMatchObject({
			code: "TUNER_LEASE_HELD",
			jobId: job.id,
		})
		expect(h.service.tunerLeaseHolder("rtl")).toBe(job.id)
		expect(h.frames.slice(before)).toEqual([])
	})
})

describe("what the answer says about the job and the jobs behind it", () => {
	it("a job its operator paused stays paused, whatever its own resume rule", async () => {
		const h = await setup()
		const job = await h.service.createJob(sweep(50, 300))
		await h.running(job.id)
		await h.service.pauseJob(job.id)
		await settled(h.service)
		expect(h.service.tunerLeaseHolder("rtl")).toBe(job.id)
		const res = await h.post({ frequencyHz: 120_000_000, preempt: true })
		expect(res.statusCode).toBe(200)
		expect(res.json().preempted).toMatchObject({
			job: "paused",
			autoAfterIdleMs: null,
		})
		expect(res.json().preempted.message).toContain("stays paused (operator)")
		expect(res.json().preempted.message).toContain(
			`POST /api/scanner/jobs/${job.id}/resume`,
		)
		expect(res.json().preempted.message).not.toContain("resumes by itself")
		await settled(h.service)
		expect(h.service.getJob(job.id)).toMatchObject({
			state: "paused",
			reason: "operator",
		})
	})

	it("names a waiting job that can take the tuner back, and only such a job", async () => {
		const h = await setup()
		const able = await h.service.createJob(sweep(30, 300))
		await h.running(able.id)
		const unable = await h.service.createJob(sweep(40, null))
		await h.running(unable.id)
		const holder = await h.service.createJob(sweep(60))
		await h.running(holder.id)
		await settled(h.service)
		const res = await h.post({ frequencyHz: 120_000_000, preempt: true })
		expect(res.statusCode).toBe(200)
		expect(res.json().preempted).toMatchObject({
			jobId: holder.id,
			waiters: [
				{ jobId: able.id, jobName: "Night sweep", autoAfterIdleMs: 300 },
			],
		})
		expect(res.json().preempted.message).toContain(`${able.id} after 300 ms`)
		expect(res.json().preempted.message).not.toContain(unable.id)
	})
})
