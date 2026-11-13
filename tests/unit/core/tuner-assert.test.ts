/**
 * Assert (tuning trust step 2) through the production wiring: the real SourceManager, its tuning
 * ledger, TunerController, TunerRelay and TunerArbiter on wireTunerControl, against the stamped
 * fake rtl_tcp on an ephemeral loopback port. Every check reads the frames the fake received, the
 * ledger's receipts, and the stamps of the samples (what the receiver was tuned to).
 */
import { once } from "node:events"
import * as net from "node:net"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { TunerArbiter } from "../../../src/core/scanner/tuner-arbiter.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type { TuningReceipt } from "../../../src/core/tuning-ledger.js"
import { createLogger } from "../../../src/utils/logger.js"
import { FakeClock } from "../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"
import {
	startStampedRtlTcp,
	type StampedRtlTcp,
} from "../../mocks/stamped-rtl-tcp.js"

const logger = createLogger({ level: "fatal" })
const cleanups: (() => unknown)[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 250 ksps U8 IQ: 500 kB/s, which the fake delivers (2500 B every 5 ms): rate truth agrees. */
const RATE = 250_000
const CHUNK = 2_500
/** Declared (config caps) centre, an operator's, and a scanner hop's. */
const F0 = 100_000_000
const F1 = 101_000_000
const HOP = 145_000_000
const SET_FREQUENCY = 0x01
const SET_SAMPLE_RATE = 0x02
const SET_GAIN = 0x04

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

async function freePort(): Promise<number> {
	const server = net.createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as net.AddressInfo
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

function config(port: number): SourceConfig {
	return {
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
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
}

/** The production wiring on a stamped fake. */
async function harness(
	opts: { writeDeclared?: boolean; reconnectPolicy?: "restore" | "reset" } = {},
) {
	// The shortest reconnect backoff (equal jitter at its floor).
	vi.spyOn(Math, "random").mockReturnValue(0)
	const fake = await startStampedRtlTcp({
		initialHz: F0,
		initialRate: RATE,
		chunkBytes: CHUNK,
	})
	cleanups.push(() => fake.close())
	// 4 KiB settle (8 ms of payload): proof comes from positions, not from test time.
	const manager = new SourceManager(logger, {
		tuningSettleMs: () => 0,
		tuningInFlightBytes: 4096,
	})
	cleanups.push(() => manager.disconnectAll())
	manager.on("error", () => undefined)
	const controller = new TunerController(logger, manager, {
		...(opts.writeDeclared === false
			? { writeDeclaredTuningOnConnect: false }
			: {}),
		...(opts.reconnectPolicy ? { reconnectPolicy: opts.reconnectPolicy } : {}),
	})
	controller.on("error", () => undefined)
	const fanout = new FanoutManager(logger)
	cleanups.push(() => fanout.destroy())
	const relay = new TunerRelay(logger, manager, fanout, {
		enabled: true,
		host: "127.0.0.1",
		port: await freePort(),
		sourceId: "rtl",
		controlPolicy: "exclusive",
	})
	cleanups.push(() => relay.stop())
	await relay.start()
	controller.initializeSource("rtl", config(fake.port).caps, "rtl_tcp")
	wireTunerControl({
		log: logger,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: relay,
		relayEnabled: true,
	})
	const clock = new FakeClock()
	const arbiter = new TunerArbiter({
		tuner: controller,
		sources: manager,
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
		logger: pino({ level: "silent" }),
	})
	cleanups.push(() => arbiter.dispose())
	/** Every receipt of every session, in order (the ledger keeps only the live session's). */
	const receipts: TuningReceipt[] = []
	manager.tuningLedger.subscribe((id, change) => {
		if (id === "rtl" && change.kind === "receipt") receipts.push(change.receipt)
	})
	const stream = await manager.connect(config(fake.port))
	stream.resume()
	fanout.attachSource(stream)
	const ledger = manager.tuningLedger
	const session = () => ledger.position("rtl")?.session ?? 0
	/** Waits for session `n` and `bytes` of its payload. */
	const sessionFlowing = async (n: number, bytes = 64 * 1024) => {
		await until(
			() => session() === n && (ledger.position("rtl")?.pos ?? 0) > bytes,
		)
	}
	const proofOf = () => controller.getState("rtl")!.proof!
	const sessionReceipts = (n: number) => receipts.filter(r => r.session === n)
	/** The frames the fake read from index `from` on, as [cmd, value]. */
	const framesFrom = (from: number) => fake.frames.slice(from)
	return {
		fake,
		manager,
		controller,
		relay,
		arbiter,
		clock,
		ledger,
		session,
		sessionFlowing,
		proofOf,
		sessionReceipts,
		framesFrom,
		receipts,
	}
}

/** The newest live payload carries the stamps of `hz` (receiver really there). */
function stampedAt(fake: StampedRtlTcp, hz: number): boolean {
	return fake.tuning().centre === hz
}

describe("assert on a fresh parked core", () => {
	it("writes the declared rate and centre to the first session, which the ledger then proves", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		// Rate before centre, both by assert, both declared.
		expect(h.sessionReceipts(1).map(r => [r.field, r.value, r.writer])).toEqual(
			[
				["sampleRate", RATE, "assert"],
				["frequency", F0, "assert"],
			],
		)
		expect(h.fake.frames).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F0],
		])
		const [rate, centre] = h.sessionReceipts(1)
		const lastOf = (r: TuningReceipt) => ({
			seq: r.seq,
			pos: r.pos,
			at: new Date(r.at).toISOString(),
		})
		expect(h.proofOf()).toEqual({
			frequency: {
				state: "commanded",
				writer: "assert",
				session: 1,
				lastReceipt: lastOf(centre!),
			},
			sampleRate: {
				state: "commanded",
				writer: "assert",
				session: 1,
				lastReceipt: lastOf(rate!),
			},
		})
		expect(h.ledger.trustNow("rtl")).toMatchObject({
			trust: "commanded",
			frequency: F0,
			sampleRate: RATE,
		})
	}, 30_000)

	it("with tuner.writeDeclaredTuningOnConnect false writes nothing and says why", async () => {
		const h = await harness({ writeDeclared: false })
		await h.sessionFlowing(1)
		await wait(100)
		expect(h.fake.frames).toEqual([])
		expect(h.proofOf()).toEqual({
			frequency: {
				state: "unverified",
				writer: null,
				session: 1,
				reason: "declared-write-off",
				blocked: "declared-write-off",
			},
			sampleRate: {
				state: "unverified",
				writer: null,
				session: 1,
				reason: "declared-write-off",
				blocked: "declared-write-off",
			},
		})
		// An accepted value is still written: the switch is only for the declared fallback.
		await h.controller.setFrequency("rtl", F1, { origin: "rest" })
		const from = h.fake.frames.length
		h.manager.tuningLedger.raiseDoubt("rtl", "frequency", "test")
		await until(() => h.framesFrom(from).length > 0)
		expect(h.framesFrom(from)).toEqual([[SET_FREQUENCY, F1]])
	}, 30_000)
})

describe("each new session asserts the held value", () => {
	it.each([
		["a blip (socket drop, receiver keeps its tuning)", "blip"],
		["a listener restart (rtlmux replays its cache)", "keep"],
		["a replug (new header, receiver back on its default)", "replug"],
	] as const)(
		"%s",
		async (_name, kind) => {
			const h = await harness()
			await h.sessionFlowing(1)
			await h.controller.setFrequency("rtl", F1, { origin: "rest" })
			await until(() => h.proofOf().frequency.state === "commanded")
			await until(() => stampedAt(h.fake, F1))
			const from = h.fake.frames.length
			if (kind === "blip") h.fake.dropConnections()
			else if (kind === "keep") h.fake.restart({ keepTuning: true })
			else h.fake.restart({ keepTuning: false, tunerType: 6 })
			await h.sessionFlowing(2)
			await until(() => h.proofOf().frequency.state === "commanded")
			// The new session's centre and rate came from assert: the accepted centre, never config.
			expect(
				h.sessionReceipts(2).map(r => [r.field, r.value, r.writer]),
			).toEqual([
				["sampleRate", RATE, "assert"],
				["frequency", F1, "assert"],
			])
			expect(h.framesFrom(from)).not.toContainEqual([SET_FREQUENCY, F0])
			await until(() => stampedAt(h.fake, F1))
			expect(h.ledger.trustNow("rtl")).toMatchObject({
				trust: "commanded",
				frequency: F1,
			})
		},
		30_000,
	)

	it("a web retune then a blip asserts the retuned value, never the config", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await h.controller.configure(
			"rtl",
			{ frequency: F1 },
			{ origin: "rest", actor: "web" },
		)
		await until(() => stampedAt(h.fake, F1))
		const from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(2)
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
	}, 30_000)
})

describe("a tuner relay client", () => {
	it("gets no core frame on a new session; its frame proves as relay; its detach asserts", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		const client = net.connect(h.relay.getStatus().port, "127.0.0.1")
		cleanups.push(() => client.destroy())
		client.on("data", () => undefined)
		client.on("error", () => undefined)
		await once(client, "connect")
		await until(() => h.relay.getStatus().clientsConnected === 1)
		const from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(2)
		await wait(200)
		// Rule 1: the receiver is the relay client's; nothing from the core.
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency).toMatchObject({
			state: "unverified",
			reason: "relay-attached",
		})
		client.write(
			Buffer.concat([frame(SET_SAMPLE_RATE, RATE), frame(SET_FREQUENCY, HOP)]),
		)
		await until(() => h.proofOf().frequency.state === "relay")
		expect(h.proofOf().sampleRate.state).toBe("relay")
		await until(() => stampedAt(h.fake, HOP))
		// The relay client leaves: assert writes nothing while the relay's frames still prove.
		const beforeDetach = h.fake.frames.length
		client.destroy()
		await until(() => h.relay.getStatus().clientsConnected === 0)
		await wait(100)
		expect(h.framesFrom(beforeDetach)).toEqual([])
		// A doubt now leaves the field unproven with nobody attached: assert writes the held
		// (last accepted: the relay's) centre and the ledger proves it commanded.
		h.ledger.raiseDoubt("rtl", "both", "test")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(beforeDetach)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, HOP],
		])
		expect(h.proofOf().frequency.writer).toBe("assert")
	}, 30_000)

	it("a detach with the field unproven asserts at once", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		const client = net.connect(h.relay.getStatus().port, "127.0.0.1")
		cleanups.push(() => client.destroy())
		client.on("data", () => undefined)
		client.on("error", () => undefined)
		await once(client, "connect")
		await until(() => h.relay.getStatus().clientsConnected === 1)
		const from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(2)
		expect(h.proofOf().frequency.reason).toBe("relay-attached")
		client.destroy()
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F0],
		])
	}, 30_000)
})

describe("a scanner lease across a flap (RS gate 1 M1)", () => {
	it("re-sends the hop off the config centre: no config frame, the lease survives", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		const got = h.arbiter.acquire("job-1", "rtl", 50)
		if (!got.ok) throw new Error("no lease")
		const lease = got.lease
		const lost: string[] = []
		h.arbiter.on("lease-lost", (_l: unknown, why: string) => lost.push(why))
		await h.arbiter.retune(lease, {
			centreHz: HOP,
			gainTenthsDb: null,
			sampleRateHz: null,
		})
		// A scanner write the controller does not accept as held, too (accept: false).
		await h.controller.setFrequency("rtl", HOP, {
			origin: "scanner",
			jobId: "job-1",
			accept: false,
		})
		await until(() => stampedAt(h.fake, HOP))
		const from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(2)
		await until(() => h.sessionReceipts(2).some(r => r.field === "frequency"))
		const first = h.sessionReceipts(2).find(r => r.field === "frequency")!
		expect(first).toMatchObject({
			value: HOP,
			writer: "scanner",
			jobId: "job-1",
		})
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.proofOf().sampleRate.state).toBe("commanded")
		expect(h.framesFrom(from)).not.toContainEqual([SET_FREQUENCY, F0])
		expect(h.framesFrom(from)).toContainEqual([SET_SAMPLE_RATE, RATE])
		expect(h.arbiter.holder("rtl")).toBe(lease)
		expect(lost).toEqual([])
		await until(() => stampedAt(h.fake, HOP))
		expect(h.ledger.trustNow("rtl")).toMatchObject({
			trust: "commanded",
			frequency: HOP,
		})
	}, 30_000)
})

describe("the skip rule and doubts", () => {
	it("a tune naming the held values after a doubt writes them (unverified is never skipped)", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await h.controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		const from = h.fake.frames.length
		// Same tick: the tune runs before assert's deferred check.
		h.ledger.raiseDoubt("rtl", "both", "test")
		await h.controller.applyTune(
			"rtl",
			{ sampleRate: RATE, frequency: F1 },
			{ origin: "rest" },
			() => undefined,
		)
		await until(() => h.proofOf().frequency.state === "commanded")
		await wait(50)
		// Written once each. The tune wrote the rate at once; while it awaited that frame,
		// assert's deferred check may write the held centre first, and the tune then finds it
		// queued at its value and skips it: never a second frame of either.
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
		const after = h.receipts.slice(-2)
		expect(after.map(r => [r.field, r.value])).toEqual([
			["sampleRate", RATE],
			["frequency", F1],
		])
		expect(after[0]!.writer).toBe("operator")
		expect(["operator", "assert"]).toContain(after[1]!.writer)
	}, 30_000)

	it("a gain write during a doubt goes out, and assert still writes the two fields", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		const from = h.fake.frames.length
		h.ledger.raiseDoubt("rtl", "both", "test")
		await h.controller.setGain("rtl", 300, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_GAIN, 300],
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F0],
		])
		expect(h.proofOf().sampleRate.writer).toBe("assert")
	}, 30_000)

	it("skips a second identical write while it settles or is proven; after a doubt it writes", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		const from = h.fake.frames.length
		await h.controller.configure("rtl", { frequency: F1 }, { origin: "rest" })
		// Straight after: settling (or queued) at F1.
		await h.controller.configure("rtl", { frequency: F1 }, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		await h.controller.configure("rtl", { frequency: F1 }, { origin: "rest" })
		await wait(50)
		expect(h.framesFrom(from)).toEqual([[SET_FREQUENCY, F1]])
		h.ledger.raiseDoubt("rtl", "frequency", "test")
		await h.controller.configure("rtl", { frequency: F1 }, { origin: "rest" })
		await wait(50)
		expect(h.framesFrom(from)).toEqual([
			[SET_FREQUENCY, F1],
			[SET_FREQUENCY, F1],
		])
	}, 30_000)
})

describe("an operator naming the value a scanner hop left in place (fix round 1)", () => {
	it.each(["applyTune", "configure"] as const)(
		"%s: skipped, yet the value is accepted and asserted on the next session",
		async call => {
			const h = await harness()
			await h.sessionFlowing(1)
			await until(() => h.proofOf().frequency.state === "commanded")
			// A hop left in place (no restore): written, not accepted.
			await h.controller.setFrequency("rtl", HOP, {
				origin: "scanner",
				accept: false,
			})
			await until(() => h.proofOf().frequency.state === "commanded")
			await until(() => stampedAt(h.fake, HOP))
			const before = h.fake.frames.length
			if (call === "applyTune")
				await h.controller.applyTune(
					"rtl",
					{ frequency: HOP },
					{ origin: "rest" },
					() => undefined,
				)
			else
				await h.controller.configure(
					"rtl",
					{ frequency: HOP },
					{ origin: "rest" },
				)
			await wait(50)
			// The skip rule: proven at that value, no frame.
			expect(h.framesFrom(before)).not.toContainEqual([SET_FREQUENCY, HOP])
			const from = h.fake.frames.length
			h.fake.dropConnections()
			await h.sessionFlowing(2)
			await until(() => h.proofOf().frequency.state === "commanded")
			const first = h.sessionReceipts(2).find(r => r.field === "frequency")!
			expect(first).toMatchObject({ value: HOP, writer: "assert" })
			expect(h.framesFrom(from)).not.toContainEqual([SET_FREQUENCY, F0])
			const accepted = (
				h.controller as unknown as {
					acceptedTuning: Map<string, { frequency?: number }>
				}
			).acceptedTuning.get("rtl")
			expect(accepted?.frequency).toBe(HOP)
		},
		30_000,
	)
})

describe("a plain resume of a paused feed", () => {
	it("holds: no assert on its sessions, with the reason shown", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await h.controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		await h.manager.pause("rtl")
		const from = h.fake.frames.length
		await h.manager.resume("rtl")
		await h.sessionFlowing(2)
		await wait(200)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency).toMatchObject({
			state: "unverified",
			reason: "plain-resume",
		})
		// A doubt is no trigger under the hold either.
		h.ledger.raiseDoubt("rtl", "both", "test")
		await wait(100)
		expect(h.framesFrom(from)).toEqual([])
	}, 30_000)

	it("holds only the declared fallback: a centre the operator sets after the resume is asserted on a dropout (Main gate M1)", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await h.controller.setFrequency("rtl", HOP, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		await h.manager.pause("rtl")
		await h.manager.resume("rtl")
		await h.sessionFlowing(2)
		// After the resume the operator sets a centre and a gain.
		await h.controller.setFrequency("rtl", HOP + 1_000_000, { origin: "rest" })
		await h.controller.setGain("rtl", 400, { origin: "rest" })
		await until(() => stampedAt(h.fake, HOP + 1_000_000))
		const from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(3)
		await until(() => h.proofOf().frequency.state === "commanded")
		const frames = h.framesFrom(from)
		// The operator's centre goes back (by assert); the gain is replayed; the declared rate
		// (nothing accepted it after the resume) and the pre-pause centre are never written.
		expect(frames).toContainEqual([SET_FREQUENCY, HOP + 1_000_000])
		expect(frames).toContainEqual([SET_GAIN, 400])
		expect(frames.some(([cmd]) => cmd === SET_SAMPLE_RATE)).toBe(false)
		expect(frames).not.toContainEqual([SET_FREQUENCY, HOP])
		expect(frames).not.toContainEqual([SET_FREQUENCY, F0])
		expect(
			h.sessionReceipts(3).find(r => r.field === "frequency"),
		).toMatchObject({ value: HOP + 1_000_000, writer: "assert" })
		// The rate stays unverified under the hold, with the hold's reason.
		expect(h.proofOf().sampleRate).toMatchObject({
			state: "unverified",
			reason: "plain-resume",
		})
	}, 30_000)
})

describe("the plain-resume hold's one decision point", () => {
	it("plainResumeTakesTuningBack alone decides whether the hold blocks the held tuning (false while the receiver's clients are unknown)", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await h.controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		const decision = vi.spyOn(h.controller, "plainResumeTakesTuningBack")
		await h.manager.pause("rtl")
		const from = h.fake.frames.length
		await h.manager.resume("rtl")
		await h.sessionFlowing(2)
		await wait(200)
		// No sdr-host here (clients unknown): consulted, false, nothing written, the hold's reason shown.
		expect(decision).toHaveBeenCalledWith("rtl")
		expect(decision.mock.results.every(r => r.value === false)).toBe(true)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency).toMatchObject({
			state: "unverified",
			reason: "plain-resume",
		})
		// Flipping that one predicate (nothing else) gives the tuning back as a restore would: assert
		// writes the rate and the centre accepted before the resume (U1: accepted, else declared),
		// and they prove.
		decision.mockReturnValue(true)
		h.ledger.raiseDoubt("rtl", "both", "test")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
		expect(h.sessionReceipts(2).map(r => [r.field, r.value, r.writer])).toEqual(
			[
				["sampleRate", RATE, "assert"],
				["frequency", F1, "assert"],
			],
		)
	}, 30_000)
})

describe("a fight with a client retuning past the relay (Main gate minor 3)", () => {
	it("counts each assert frame an untracked-retune doubt caused, never other doubts", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.proofOf().assertFights).toBeUndefined()
		// Another doubt: assert writes, no fight counted.
		h.ledger.raiseDoubt("rtl", "both", "pipeline-error")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.proofOf().assertFights).toBeUndefined()
		// Two untracked retunes of the centre: two fights, no rate limit.
		for (const n of [1, 2]) {
			const from = h.fake.frames.length
			h.ledger.raiseDoubt("rtl", "frequency", "untracked-retune")
			await until(() => h.proofOf().frequency.state === "commanded")
			expect(h.framesFrom(from)).toEqual([[SET_FREQUENCY, F0]])
			expect(h.proofOf().assertFights).toBe(n)
		}
		// GET /api/tuner shows it on the published state.
		expect(h.controller.getAllStates()[0]?.proof?.assertFights).toBe(2)
	}, 30_000)
})

describe("proof status per field (step 4)", () => {
	it("names the last receipt, and the block beside a doubt's reason", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		const last = h
			.sessionReceipts(1)
			.filter(r => r.field === "frequency")
			.at(-1)!
		expect(h.proofOf().frequency).toEqual({
			state: "commanded",
			writer: "assert",
			session: 1,
			lastReceipt: {
				seq: last.seq,
				pos: last.pos,
				at: new Date(last.at).toISOString(),
			},
		})
		// A relay client attached, then a doubt: the doubt is the reason, the block says why
		// nothing is written back.
		const client = net.connect(h.relay.getStatus().port, "127.0.0.1")
		cleanups.push(() => client.destroy())
		client.on("data", () => undefined)
		client.on("error", () => undefined)
		await once(client, "connect")
		await until(() => h.relay.getStatus().clientsConnected === 1)
		h.ledger.raiseDoubt("rtl", "frequency", "untracked-retune")
		await wait(100)
		expect(h.proofOf().frequency).toMatchObject({
			state: "unverified",
			reason: "untracked-retune",
			blocked: "relay-attached",
			lastReceipt: { seq: last.seq, pos: last.pos },
		})
	}, 30_000)
})

describe("reconnectPolicy reset (another operator may own the receiver)", () => {
	it("writes no declared value and asserts only what was accepted on the current connection", async () => {
		const h = await harness({ reconnectPolicy: "reset" })
		await h.sessionFlowing(1)
		await wait(200)
		// No declared write on the first connection: centre and rate stay unverified.
		expect(
			h.fake.frames.filter(
				([cmd]) => cmd === SET_FREQUENCY || cmd === SET_SAMPLE_RATE,
			),
		).toEqual([])
		expect(h.proofOf().frequency).toMatchObject({
			state: "unverified",
			reason: "reset-policy",
		})
		// A centre accepted on this connection is asserted after a doubt on it.
		await h.controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		const doubtFrom = h.fake.frames.length
		h.ledger.raiseDoubt("rtl", "both", "test")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(doubtFrom)).toEqual([[SET_FREQUENCY, F1]])
		// A new connection: the earlier connection's centre is not asserted, nor anything declared.
		const from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(2)
		await wait(200)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency).toMatchObject({
			state: "unverified",
			reason: "reset-policy",
		})
		expect(h.proofOf().sampleRate).toMatchObject({
			state: "unverified",
			reason: "reset-policy",
		})
	}, 30_000)
})

describe("source manager fixes beside assert", () => {
	it("a frame on a socket that is not the live attempt's raises an unledgered-write doubt", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await until(() => h.proofOf().frequency.state === "commanded")
		const state = (
			h.manager as unknown as {
				sources: Map<string, { attempt: { socket: unknown } | null }>
			}
		).sources.get("rtl")!
		const attempt = state.attempt!
		const socket = attempt.socket
		attempt.socket = null
		try {
			h.manager.writeToSource("rtl", frame(SET_GAIN, 100), {
				writer: "operator",
			})
			// A second frame on the same socket raises no second doubt (no loop with assert).
			h.manager.writeToSource("rtl", frame(SET_GAIN, 110), {
				writer: "assert",
			})
		} finally {
			attempt.socket = socket
		}
		expect(h.ledger.doubts("rtl").at(-1)).toMatchObject({
			field: "both",
			reason: "unledgered-write",
		})
		expect(
			h.ledger.doubts("rtl").filter(d => d.reason === "unledgered-write"),
		).toHaveLength(1)
		expect(h.ledger.receipts("rtl").some(r => r.field === "gain")).toBe(false)
	}, 30_000)

	it("stops advancing the position once the source stream is destroyed", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		h.manager.getStream("rtl")!.destroy()
		await wait(50)
		const at = h.ledger.position("rtl")
		await wait(200)
		const later = h.ledger.position("rtl")
		// The session stays open (the socket still delivers) and its position stands still.
		expect(at).not.toBeNull()
		expect(later).toEqual(at)
	}, 30_000)
})
