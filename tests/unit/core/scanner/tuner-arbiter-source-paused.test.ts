/**
 * A receiver feed paused during a scanner hop (SourceManager.pause): the arbiter sees the
 * source go down like any dropout, and a release while paused cannot write and re-queues its
 * restore. A restore resume's first payload puts the operator's exact gain back; a plain
 * resume writes no tuning (another client may have retuned the receiver during the pause): the
 * queued recovery settles without writing, so the source is free for the next job, and a held
 * lease forgets its pre-pause snapshot. A job paused by the feed waits in paused(source-down) and
 * runs again on source-up; it never fails.
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

async function pausedMidHop() {
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
	const persisted: Array<string | null> = []
	const deps: ArbiterDeps = {
		tuner: tuner as never,
		sources: sources as never,
		epochs: id => (id === "rtl" ? clock : undefined),
		settings: () => testSettings(),
		link: () => "network",
		persistLease: (_id, lease) => {
			persisted.push(lease ? lease.jobId : null)
			return Promise.resolve()
		},
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
	const ups: unknown[] = []
	arbiter.on("source-up", (_id: string, info?: unknown) => {
		events.push("up")
		ups.push(info)
	})
	const recovered: unknown[] = []
	arbiter.on("recovered", (_id, result) => recovered.push(result))

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
	// The band gain of the hop is on the tuner.
	expect(state.gain).toBe(297)

	// Mid-hop pause: the arbiter sees the source go down, as on a dropout.
	await sources.pause("rtl")
	await waitFor(() => events.includes("down"))
	return {
		sources,
		tuner,
		state,
		arbiter,
		events,
		recovered,
		persisted,
		ups,
		lease: r.lease,
	}
}

/** The tuning writes (not TEST_MODE markers) sent from index `from` on. */
const tuningWrites = (tuner: ArbiterFakeTuner, from: number) =>
	tuner.sent.slice(from).filter(c => c.name !== "set-test-mode")

describe("feed paused during a scanner hop", () => {
	it("a restore resume puts the operator's gain back after a release that could not write while paused", async () => {
		const { sources, tuner, state, arbiter, events, ups, lease } =
			await pausedMidHop()

		// The job ends while paused: the tuner is unreachable, so the restore is re-queued.
		tuner.failAll = new Error("Source not connected")
		await arbiter.release(lease, { restore: true })
		expect(state.gain).toBe(297)

		tuner.failAll = null
		await sources.resume("rtl", { restoreTuning: true })
		await waitFor(() => events.filter(e => e === "up").length === 2)
		await waitFor(() => state.gain === 496)
		expect(state).toMatchObject({ gainMode: "manual", gain: 496 })
		// A restore resume is an ordinary source-up: a waiting sweep hops again.
		expect(ups.at(-1)).toBeUndefined()
	})

	it("a plain resume settles the queued recovery without writing, and the source is free for the next job", async () => {
		const {
			sources,
			tuner,
			state,
			arbiter,
			events,
			recovered,
			persisted,
			lease,
		} = await pausedMidHop()
		tuner.failAll = new Error("Source not connected")
		await arbiter.release(lease, { restore: true })
		tuner.failAll = null
		const sent = tuner.sent.length

		await sources.resume("rtl")
		await waitFor(() => events.filter(e => e === "up").length === 2)
		await waitFor(() => recovered.length === 1)
		// Nothing tuned: neither the snapshot (centre, gain) nor the operator's gain went back.
		expect(tuningWrites(tuner, sent)).toEqual([])
		expect(state.gain).toBe(297)
		expect(recovered[0]).toMatchObject({ restored: [] })
		expect((recovered[0] as { unrestorable: string[] }).unrestorable).toContain(
			"frequency",
		)
		// The record is cleared, so the next job acquires instead of waiting on "recovery-pending".
		expect(persisted.at(-1)).toBeNull()
		const next = arbiter.acquire("job-2", "rtl", 50)
		expect(next.ok).toBe(true)
	})

	it("a plain resume keeps the holding job's lease but forgets its pre-pause snapshot, and says so on source-up", async () => {
		const { sources, tuner, state, arbiter, events, ups, lease } =
			await pausedMidHop()
		const sent = tuner.sent.length

		await sources.resume("rtl")
		await waitFor(() => events.filter(e => e === "up").length === 2)
		expect(tuningWrites(tuner, sent)).toEqual([])
		// The scanner holds the sweep in paused(resumed-without-retune) on this flag.
		expect(ups.at(-1)).toEqual({ plainResume: true })
		expect(arbiter.holder("rtl")).toBeDefined()
		expect(lease.snapshot).toEqual({})

		// Resume scan: the job's own next hop writes as usual; its release cannot put back a tuning it no
		// longer knows, so the band gain is not followed by the pre-pause operator gain.
		await arbiter.retune(lease, {
			centreHz: ISM + 200_000,
			gainTenthsDb: null,
			sampleRateHz: null,
		})
		const released = await arbiter.release(lease, { restore: true })
		expect(released.restored).toEqual([])
		expect(state.gain).toBe(297)
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
