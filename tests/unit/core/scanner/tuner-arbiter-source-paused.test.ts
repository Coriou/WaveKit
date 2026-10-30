/**
 * A receiver feed paused during a scanner hop (SourceManager.pause): the arbiter sees the
 * source go down like any dropout, a release while paused cannot write and re-queues its
 * restore, and the resume's first payload puts the operator's exact gain back. A job paused
 * by the feed waits in paused(source-down) and runs again on source-up; it never fails.
 * Real SourceManager on a fake rtl_tcp server (ephemeral loopback port); fake tuner.
 */
import * as net from "node:net"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { BandGainEntry } from "@wavekit/api-types"
import { SourceManager } from "../../../../src/core/source-manager.js"
import {
	TunerArbiter,
	type ArbiterDeps,
} from "../../../../src/core/scanner/tuner-arbiter.js"
import { transition } from "../../../../src/core/scanner/job-state.js"
import { bandGainAt } from "../../../../src/core/band-gain-schema.js"
import {
	ArbiterFakeTuner,
	FakeClock,
} from "../../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })
const ISM = 868_100_000
const TABLE: BandGainEntry[] = [
	{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
]

async function fakeRtlTcp() {
	const sockets: net.Socket[] = []
	const server = net.createServer(socket => {
		sockets.push(socket)
		socket.on("error", () => undefined)
		socket.on("end", () => socket.end())
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		const iq = setInterval(() => {
			if (socket.writable) socket.write(Buffer.alloc(512, 127))
		}, 20)
		socket.on("close", () => clearInterval(iq))
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as net.AddressInfo).port,
		sockets,
		close: async () => {
			for (const s of sockets) s.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting")
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("feed paused during a scanner hop", () => {
	it("restores the operator's gain on resume after a release that could not write while paused", async () => {
		const upstream = await fakeRtlTcp()
		cleanups.push(() => upstream.close())
		const sources = new SourceManager(logger)
		cleanups.push(() => sources.disconnectAll())

		const tuner = new ArbiterFakeTuner()
		tuner.addSource("rtl")
		const state = tuner.states.get("rtl")!
		state.gainMode = "manual"
		state.gain = 496
		Object.assign(tuner, {
			bandGainFor: (_id: string, hz: number) => {
				const g = bandGainAt(TABLE, hz)
				return g === "keep" ? null : g
			},
		})
		const clock = new FakeClock()
		const deps: ArbiterDeps = {
			tuner: tuner as never,
			sources: sources as never,
			epochs: id => (id === "rtl" ? clock : undefined),
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
		}
		const arbiter = new TunerArbiter(deps)
		const events: string[] = []
		arbiter.on("source-down", () => events.push("down"))
		arbiter.on("source-up", () => events.push("up"))

		await sources.connect({
			id: "rtl",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: upstream.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 2_048_000,
				centerFreq: 446_100_000,
				exclusive: false,
			},
		})
		await waitFor(() => events.includes("up"))

		const r = arbiter.acquire("job", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await arbiter.retune(r.lease, {
			centreHz: ISM,
			gainTenthsDb: null,
			sampleRateHz: null,
		})
		expect(state.gain).toBe(297)

		// Mid-hop pause: the arbiter sees the source go down, as on a dropout.
		await sources.pause("rtl")
		await waitFor(() => events.includes("down"))

		// The job ends while paused: the tuner is unreachable, so the restore is re-queued.
		tuner.failAll = new Error("Source not connected")
		await arbiter.release(r.lease, { restore: true })
		expect(state.gain).toBe(297)

		tuner.failAll = null
		await sources.resume("rtl")
		await waitFor(() => events.filter(e => e === "up").length === 2)
		await waitFor(() => state.gain === 496)
		expect(state).toMatchObject({ gainMode: "manual", gain: 496 })
	})

	it("a job paused by the feed waits in paused(source-down) and runs again on source-up", () => {
		for (const active of ["running", "holding"] as const) {
			const down = transition({ state: active }, { type: "source-down" })
			expect(down).toMatchObject({
				state: "paused",
				reason: "source-down",
				actions: ["stop-probes"],
			})
			const up = transition(
				{ state: "paused", reason: "source-down" },
				{ type: "source-up" },
			)
			expect(up).toMatchObject({ state: "running", actions: ["resend-hop"] })
		}
	})
})
