/**
 * A plain resume on a free receiver (user decision U1-U4) through the production wiring: the real
 * SourceManager, its tuning ledger, TunerController, TunerRelay on wireTunerControl, the real
 * SdrHostPoller against an in-process fake sdr-host stats endpoint (127.0.0.1, port 0), and the
 * stamped fake rtl_tcp on an ephemeral loopback port. The core takes the tuning back only while
 * rtlmux lists this core's connection as its only client and no relay client is attached; the
 * take-back route re-proves centre and rate in one call.
 */
import * as http from "node:http"
import * as net from "node:net"
import { performance } from "node:perf_hooks"
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import type { SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type { TuningReceipt } from "../../../src/core/tuning-ledger.js"
import {
	receiverClientsMaxAgeMs,
	receiverClientsVerdict,
	SDR_HOST_LIST_MAX_AGE_MS,
} from "../../../src/core/tuning-ledger-receiver-free.js"
import type { ReceiverClientsReading } from "../../../src/core/sdr-host-poller.js"
import { createLogger } from "../../../src/utils/logger.js"
import { startStampedRtlTcp } from "../../mocks/stamped-rtl-tcp.js"

const logger = createLogger({ level: "fatal" })
const cleanups: (() => unknown)[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 250 ksps U8 IQ, as the stamped fake delivers it (rate truth agrees). */
const RATE = 250_000
const CHUNK = 2_500
/** Declared (config caps) centre and an operator's. */
const F0 = 100_000_000
const F1 = 101_000_000
const SET_FREQUENCY = 0x01
const SET_SAMPLE_RATE = 0x02
const SET_GAIN_MODE = 0x03
const SET_GAIN = 0x04
const POLL_MS = 40
const TIMEOUT_MS = 1000
/**
 * The sdr-host's stats request bound for these tests (SDR_HOST_LIST_FETCH_MS is 3 s): short, so a
 * list fresh at the answer counts a little after the session instead of 3 s later.
 */
const BOUNDS = { maxListAgeMs: SDR_HOST_LIST_MAX_AGE_MS, fetchMs: 100 }

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

type HostMode =
	| "free"
	| "second"
	| "down"
	| "nat"
	| "nat-second"
	| "cached-other"

/**
 * The fake sdr-host: GET /api/status lists rtlmux's clients (the core's connection by its local
 * port, and in `second` another one); `down` answers 500. `nat` lists the core's connection under
 * a rewritten port (as a NAT in front of rtlmux would), `nat-second` that and another client.
 * `cached-other` serves the list of a stats poll from before the core's connection: one other
 * client (SDR++ alone), the list `listAge` ms old. Every answer reports its list's age
 * (`sampling.stats.ageMs`, `listAge`: 0 by default, a list just read) as the sdr-host does.
 */
async function startFakeSdrHost(localPort: () => number | null) {
	let mode: HostMode = "free"
	let listAge = 0
	/** When the served list was taken (performance.now()): it ages with every answer, as a real cache does. */
	let listTakenAt = performance.now()
	/** While held, answers wait (a slow poll): `release` sends them in the mode of that time. */
	let held: (() => void)[] | null = null
	const server = http.createServer((req, res) => {
		if (held !== null) {
			held.push(() => answer(req, res))
			return
		}
		answer(req, res)
	})
	const answer = (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (req.url !== "/api/status" || mode === "down") {
			res.writeHead(req.url === "/api/status" ? 500 : 404)
			res.end()
			return
		}
		const own = mode === "cached-other" ? null : localPort()
		const nat = mode === "nat" || mode === "nat-second"
		const details = [
			...(own !== null
				? [
						{
							id: 0,
							// A NAT rewrites the port: never this connection's.
							address: `127.0.0.1:${nat ? 2 : own}`,
							bytesDropped: 0,
						},
					]
				: []),
			...(mode === "second" || mode === "nat-second" || mode === "cached-other"
				? [{ id: 1, address: "127.0.0.1:1", bytesDropped: 0 }]
				: []),
		]
		res.writeHead(200, { "content-type": "application/json" })
		res.end(
			JSON.stringify({
				rtlmux: {
					running: true,
					stats: {
						clients: details.length,
						bytesPerSec: 0,
						totalBytesSent: 0,
						clientDetails: details,
					},
				},
				sampling: {
					stats: {
						state: "ok",
						// A cached list ages with every answer; the other modes serve a list just read.
						ageMs:
							mode === "cached-other"
								? Math.round(listAge + performance.now() - listTakenAt)
								: listAge,
					},
				},
			}),
		)
	}
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as net.AddressInfo
	return {
		url: `http://127.0.0.1:${port}`,
		setMode: (m: HostMode, age = 0) => {
			mode = m
			listAge = age
			listTakenAt = performance.now()
		},
		hold: () => {
			held ??= []
		},
		release: () => {
			const waiting = held ?? []
			held = null
			for (const send of waiting) send()
		},
		heldCount: () => held?.length ?? 0,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	}
}

async function harness(
	opts: { configuredGain?: boolean; sdrHost?: boolean } = {},
) {
	vi.spyOn(Math, "random").mockReturnValue(0)
	const fake = await startStampedRtlTcp({
		initialHz: F0,
		initialRate: RATE,
		chunkBytes: CHUNK,
	})
	cleanups.push(() => fake.close())
	const manager = new SourceManager(logger, {
		tuningSettleMs: () => 0,
		tuningInFlightBytes: 4096,
	})
	cleanups.push(() => manager.disconnectAll())
	manager.on("error", () => undefined)
	const controller = new TunerController(logger, manager, {})
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
	// Configured gain rides on the source's config (the wiring syncs it at every connection).
	const source: SourceConfig = opts.configuredGain
		? ({
				...config(fake.port),
				tuner: { gainMode: "manual", gainDb: 30 },
			} as SourceConfig)
		: config(fake.port)
	controller.initializeSource("rtl", source.caps, "rtl_tcp")
	wireTunerControl({
		log: logger,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: relay,
		relayEnabled: true,
	})
	const host = await startFakeSdrHost(() => manager.connectionLocalPort("rtl"))
	cleanups.push(() => host.close())
	// The index.ts wiring of the poller to the controller.
	if (opts.sdrHost !== false) {
		const poller = new SdrHostPoller(
			logger,
			[{ sourceId: "rtl", apiUrl: host.url }],
			{ pollIntervalMs: POLL_MS, timeoutMs: TIMEOUT_MS },
		)
		const maxAge = receiverClientsMaxAgeMs(POLL_MS, TIMEOUT_MS)
		controller.setReceiverClientsView(id =>
			receiverClientsVerdict(
				poller.clientsReading(id),
				manager.connectionLocalPort(id),
				performance.now(),
				maxAge,
				BOUNDS,
			),
		)
		poller.on("status", status =>
			controller.noteReceiverClients(status.sourceId),
		)
		poller.on("error", () => undefined)
		poller.start()
		cleanups.push(() => poller.stop())
	}
	const receipts: TuningReceipt[] = []
	manager.tuningLedger.subscribe((id, change) => {
		if (id === "rtl" && change.kind === "receipt") receipts.push(change.receipt)
	})
	const stream = await manager.connect(source)
	stream.resume()
	fanout.attachSource(stream)
	const ledger = manager.tuningLedger
	const session = () => ledger.position("rtl")?.session ?? 0
	const sessionFlowing = async (n: number, bytes = 64 * 1024) => {
		await until(
			() => session() === n && (ledger.position("rtl")?.pos ?? 0) > bytes,
		)
	}
	const state = () => controller.getState("rtl")!
	const proofOf = () => state().proof!
	const sessionReceipts = (n: number) => receipts.filter(r => r.session === n)
	const framesFrom = (from: number) => fake.frames.slice(from)
	/** An operator centre, proven, then a pause and a plain resume; frames index after the pause. */
	const plainResume = async (): Promise<number> => {
		await sessionFlowing(1)
		await controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(() => proofOf().frequency.state === "commanded")
		await manager.pause("rtl")
		const from = fake.frames.length
		await manager.resume("rtl")
		await sessionFlowing(2)
		return from
	}
	return {
		fake,
		manager,
		controller,
		relay,
		host,
		ledger,
		session,
		sessionFlowing,
		state,
		proofOf,
		sessionReceipts,
		framesFrom,
		plainResume,
	}
}

describe("a plain resume on a free receiver (U1, U3)", () => {
	it("takes the tuning back: assert writes the rate and the centre accepted before the resume, and they prove", async () => {
		const h = await harness()
		const from = await h.plainResume()
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.proofOf().sampleRate.state).toBe("commanded")
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
		await until(() => h.fake.tuning().centre === F1)
		expect(h.state().resumeOutcome).toEqual({
			outcome: "restored",
			reason: "port-matched",
			message: "receiver free (only this connection): tuning restored",
		})
		expect(h.manager.tuningUnproven.view("rtl")).toBeNull()
	}, 30_000)

	it("behind a NAT that rewrites the port, one listed client is this connection: takes the tuning back as sole-client", async () => {
		const h = await harness()
		h.host.setMode("nat")
		const from = await h.plainResume()
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
		expect(h.state().resumeOutcome).toEqual({
			outcome: "restored",
			reason: "sole-client",
			message: "receiver free (one client, port not matched): tuning restored",
		})
	}, 30_000)

	it("behind a NAT with a second client leaves the tuning as found: another client (two listed, neither on this port)", async () => {
		const h = await harness()
		h.host.setMode("nat-second")
		const from = await h.plainResume()
		await wait(400)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency.state).toBe("unverified")
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "left-as-found",
			reason: "another-client",
		})
	}, 30_000)

	it("a cached list that names only another client (SDR++ from before this connection) holds, though every poll started after the session; its refreshed list takes the tuning back", async () => {
		const h = await harness()
		// The sdr-host's last stats poll predates the connection: it still lists SDR++ alone.
		h.host.setMode("cached-other", 1_500)
		const from = await h.plainResume()
		await wait(400)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency.state).toBe("unverified")
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "left-as-found",
			reason: "clients-unknown",
		})
		// SDR++ left; the sdr-host's next stats poll lists this connection alone (NAT: no port
		// match), read after the session: a genuine sole client.
		h.host.setMode("nat", 0)
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "restored",
			reason: "sole-client",
		})
	}, 30_000)

	it("with a second client on rtlmux leaves the tuning as found, and takes it back once that client is gone", async () => {
		const h = await harness()
		h.host.setMode("second")
		const from = await h.plainResume()
		await until(() => h.state().resumeOutcome?.reason === "another-client")
		await wait(300)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency).toMatchObject({
			state: "unverified",
			reason: "plain-resume",
		})
		expect(h.state().resumeOutcome).toEqual({
			outcome: "left-as-found",
			reason: "another-client",
			message: "another client on the receiver: tuning left as found",
		})
		const unproven = h.manager.tuningUnproven.view("rtl")!
		expect(unproven.cause).toBe("plain-resume")
		expect(unproven.fix).toContain("POST /api/tuner/:sourceId/take-back")
		// Level-triggered: the other client leaves, the next poll gives the tuning back.
		h.host.setMode("free")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
	}, 30_000)

	it("with the sdr-host's stats unavailable leaves the tuning as found", async () => {
		const h = await harness()
		h.host.setMode("down")
		const from = await h.plainResume()
		await wait(400)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.proofOf().frequency.state).toBe("unverified")
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "left-as-found",
			reason: "clients-unknown",
			message: "receiver clients unknown: tuning left as found",
		})
	}, 30_000)

	it("without an sdr-host poller (unknown clients) leaves the tuning as found", async () => {
		const h = await harness({ sdrHost: false })
		const from = await h.plainResume()
		await wait(300)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.state().resumeOutcome?.reason).toBe("clients-unknown")
	}, 30_000)

	it("with a relay client attached leaves the tuning as found, though rtlmux lists the core alone", async () => {
		const h = await harness()
		await h.sessionFlowing(1)
		await h.controller.setFrequency("rtl", F1, { origin: "rest" })
		await until(() => h.proofOf().frequency.state === "commanded")
		const client = net.connect(h.relay.getStatus().port, "127.0.0.1")
		client.on("error", () => undefined)
		cleanups.push(() => client.destroy())
		await until(() => h.relay.getStatus().clientsConnected > 0)
		await h.manager.pause("rtl")
		const from = h.fake.frames.length
		await h.manager.resume("rtl")
		await h.sessionFlowing(2)
		await until(() => h.state().resumeOutcome?.reason === "relay-attached")
		await wait(300)
		expect(
			h
				.framesFrom(from)
				.filter(([cmd]) => cmd === SET_FREQUENCY || cmd === SET_SAMPLE_RATE),
		).toEqual([])
		expect(h.state().resumeOutcome).toEqual({
			outcome: "left-as-found",
			reason: "relay-attached",
			message: "relay client attached: tuning left as found",
		})
	}, 30_000)
})

describe("a free verdict counts only from a reading after the connection and the field's last doubt (V1)", () => {
	it("a client that joins and retunes after a restore gets no assert frame before a fresh poll, and a fresh poll listing it holds", async () => {
		const h = await harness()
		const from = await h.plainResume()
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.state().resumeOutcome?.reason).toBe("port-matched")
		const restored = h.framesFrom(from).length
		// An SDR++-like client joins straight on rtlmux and retunes: the polls in flight stall (the
		// last answer, under 8 s old, still says free), the engine's alarm raises the doubt.
		h.host.hold()
		await until(() => h.host.heldCount() > 0)
		h.host.setMode("second")
		h.fake.retuneSilently(F0, 0)
		h.ledger.raiseDoubt("rtl", "frequency", "untracked-retune")
		await wait(300)
		expect(h.framesFrom(from)).toHaveLength(restored)
		expect(h.proofOf().frequency.state).toBe("unverified")
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "left-as-found",
			reason: "another-client",
		})
		// The fresh poll lists two clients: held, still no frame.
		h.host.release()
		await wait(300)
		expect(h.framesFrom(from)).toHaveLength(restored)
		expect(h.state().resumeOutcome?.reason).toBe("another-client")
		expect(h.fake.tuning().centre).toBe(F0)
		// The client leaves: a poll after the doubt says free, and the tuning is taken back.
		h.host.setMode("free")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from).slice(restored)).toEqual([[SET_FREQUENCY, F1]])
	}, 30_000)

	it("a free reading whose poll started before the session does not take the tuning back, and a doubt under the hold asks for a fresh poll", async () => {
		const h = await harness({ sdrHost: false })
		let readingAt = performance.now()
		const polls: string[] = []
		h.controller.setReceiverClientsView(
			() => ({ free: true, reason: "port-matched", readingAt }),
			id => polls.push(id),
		)
		const from = await h.plainResume()
		h.controller.noteReceiverClients("rtl")
		await wait(200)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.state().resumeOutcome?.reason).toBe("clients-unknown")
		// The session start asked for a reading; a doubt asks again.
		expect(polls).toEqual(["rtl"])
		h.ledger.raiseDoubt("rtl", "sampleRate", "pipeline-error")
		expect(polls).toEqual(["rtl", "rtl"])
		// A reading after both: the tuning is taken back.
		readingAt = performance.now()
		h.controller.noteReceiverClients("rtl")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
	}, 30_000)

	it("a sole-client list taken before the session or the last doubt holds even when its poll started after them; one newer than both takes the tuning back", async () => {
		const h = await harness({ sdrHost: false })
		const reading: ReceiverClientsReading = {
			startedAt: performance.now(),
			clients: 1,
			ports: [null],
			listAgeMs: 0,
		}
		// The production verdict over a reading the test sets (fetch bound 100 ms, as the harness).
		h.controller.setReceiverClientsView(
			id =>
				receiverClientsVerdict(
					reading,
					h.manager.connectionLocalPort(id),
					performance.now(),
					60_000,
					BOUNDS,
				),
			() => undefined,
		)
		/** A poll that starts now and is answered with a list `listAgeMs` old. */
		const answer = (listAgeMs: number) => {
			reading.startedAt = performance.now()
			reading.listAgeMs = listAgeMs
			h.controller.noteReceiverClients("rtl")
		}
		const from = await h.plainResume()
		// The poll starts after the session, but the list is 1.5 s old: from before the connection.
		answer(1_500)
		await wait(200)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.state().resumeOutcome?.reason).toBe("clients-unknown")
		// No age in the answer: the list may be 30 s old, so it holds as well.
		reading.startedAt = performance.now()
		reading.listAgeMs = null
		h.controller.noteReceiverClients("rtl")
		await wait(200)
		expect(h.framesFrom(from)).toEqual([])
		// A list newer than the session: taken back as sole-client.
		answer(0)
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "restored",
			reason: "sole-client",
		})
		const restored = h.framesFrom(from).length
		// A doubt, then a poll after it answered with a list from before it: held, no assert frame.
		await wait(BOUNDS.fetchMs + 50)
		h.ledger.raiseDoubt("rtl", "frequency", "pipeline-error")
		answer(1_500)
		await wait(200)
		expect(h.framesFrom(from)).toHaveLength(restored)
		expect(h.proofOf().frequency.state).toBe("unverified")
		expect(h.state().resumeOutcome?.reason).toBe("clients-unknown")
		// A list newer than the doubt (poll past the fetch bound after it): taken back again.
		await wait(BOUNDS.fetchMs + 50)
		answer(0)
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.framesFrom(from).slice(restored)).toEqual([[SET_FREQUENCY, F1]])
	}, 30_000)

	it("a sole-client reading follows the same freshness rules: one before the session or the last doubt holds", async () => {
		const h = await harness({ sdrHost: false })
		let readingAt = performance.now()
		h.controller.setReceiverClientsView(
			() => ({ free: true, reason: "sole-client", readingAt }),
			() => undefined,
		)
		const from = await h.plainResume()
		h.controller.noteReceiverClients("rtl")
		await wait(200)
		expect(h.framesFrom(from)).toEqual([])
		expect(h.state().resumeOutcome?.reason).toBe("clients-unknown")
		readingAt = performance.now()
		h.ledger.raiseDoubt("rtl", "frequency", "pipeline-error")
		h.controller.noteReceiverClients("rtl")
		await wait(200)
		expect(h.framesFrom(from)).toEqual([])
		// A reading after the doubt: taken back, and the outcome names the sole client.
		readingAt = performance.now()
		h.controller.noteReceiverClients("rtl")
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "restored",
			reason: "sole-client",
		})
	}, 30_000)
})

describe("the plain resume's one decision covers the configured frames (Q4)", () => {
	it("a reconnect under the hold writes the configured gain only when the predicate gives the tuning back", async () => {
		const h = await harness({ configuredGain: true })
		h.host.setMode("second")
		await h.plainResume()
		await until(() => h.state().resumeOutcome?.reason === "another-client")
		// A blip while another client is on: no configured frame.
		let from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(3)
		await wait(200)
		expect(
			h
				.framesFrom(from)
				.filter(([cmd]) => cmd === SET_GAIN || cmd === SET_GAIN_MODE),
		).toEqual([])
		// The receiver is free (the next answer lists the new connection alone): a blip writes them.
		h.host.setMode("free")
		await until(() => h.state().resumeOutcome?.reason === "port-matched")
		const decision = vi.spyOn(h.controller, "plainResumeTakesTuningBack")
		decision.mockReturnValue(true)
		from = h.fake.frames.length
		h.fake.dropConnections()
		await h.sessionFlowing(4)
		await until(() => h.framesFrom(from).some(([cmd]) => cmd === SET_GAIN))
		expect(
			h
				.framesFrom(from)
				.filter(([cmd]) => cmd === SET_GAIN || cmd === SET_GAIN_MODE),
		).toEqual([
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 300],
		])
	}, 30_000)
})

describe("POST /api/tuner/:sourceId/take-back (U2)", () => {
	it("re-proves centre and rate in one call and ends the hold, with another client on rtlmux", async () => {
		const h = await harness()
		h.host.setMode("second")
		const from = await h.plainResume()
		await until(() => h.state().resumeOutcome?.reason === "another-client")
		expect(h.framesFrom(from)).toEqual([])
		const app = Fastify({ logger: false })
		cleanups.push(() => app.close())
		await app.register(tunerRoutes, {
			tunerController: h.controller,
			sourceManager: h.manager,
		} as Parameters<typeof tunerRoutes>[1])
		const bad = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl/take-back",
			payload: { hz: 1 },
		})
		expect(bad.statusCode).toBe(400)
		expect(h.framesFrom(from)).toEqual([])
		const res = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl/take-back",
		})
		expect(res.statusCode).toBe(200)
		await until(() => h.framesFrom(from).length >= 2)
		expect(h.framesFrom(from)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
		expect(h.sessionReceipts(2).map(r => [r.field, r.value, r.writer])).toEqual(
			[
				["sampleRate", RATE, "operator"],
				["frequency", F1, "operator"],
			],
		)
		await until(() => h.proofOf().frequency.state === "commanded")
		expect(h.proofOf().sampleRate.state).toBe("commanded")
		expect(h.state().resumeOutcome).toEqual({
			outcome: "restored",
			reason: "operator",
			message: "tuning taken back by the operator",
		})
		// Another call writes both again (the ledger proves them: re-proven anyway).
		const again = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl/take-back",
			payload: {},
		})
		expect(again.statusCode).toBe(200)
		await until(() => h.framesFrom(from).length >= 4)
		expect(h.framesFrom(from)).toHaveLength(4)
		// A relay client attached: refused, nothing written.
		const client = net.connect(h.relay.getStatus().port, "127.0.0.1")
		client.on("error", () => undefined)
		cleanups.push(() => client.destroy())
		await until(() => h.relay.getStatus().clientsConnected > 0)
		const blocked = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl/take-back",
		})
		// An exclusive relay client takes control: refused as every setter is, nothing written.
		expect(blocked.statusCode).toBe(409)
		expect(blocked.json()).toMatchObject({ code: "TUNER_CONTROL_EXTERNAL" })
		expect(h.framesFrom(from)).toHaveLength(4)
		client.destroy()
		await until(() => h.relay.getStatus().clientsConnected === 0)
		await until(() => h.state().controlMode === "internal")
		// A scanner lease: assert's own block, refused before anything changes.
		h.controller.setLeaseView({ holds: () => true, resend: () => undefined })
		const leased = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl/take-back",
		})
		expect(leased.statusCode).toBe(409)
		expect(leased.json()).toMatchObject({ code: "TUNER_TAKE_BACK_BLOCKED" })
		expect(h.framesFrom(from)).toHaveLength(4)
	}, 30_000)
})

describe("a take-back whose write fails keeps the hold (V4)", () => {
	it("a failing centre write leaves the plain resume's hold and its outcome as found; a later call takes it back", async () => {
		const h = await harness()
		h.host.setMode("second")
		const from = await h.plainResume()
		await until(() => h.state().resumeOutcome?.reason === "another-client")
		const setFrequency = vi
			.spyOn(h.controller, "setFrequency")
			.mockRejectedValueOnce(new Error("write failed"))
		await expect(h.controller.takeTuningBack("rtl")).rejects.toThrow(
			"write failed",
		)
		// The hold stands: no take-back outcome, the reason still names the plain resume.
		expect(h.state().resumeOutcome).toMatchObject({
			outcome: "left-as-found",
			reason: "another-client",
		})
		expect(h.manager.tuningUnproven.view("rtl")?.cause).toBe("plain-resume")
		// The rate frame went out (it is accepted), the centre did not.
		await until(() => h.framesFrom(from).length >= 1)
		await wait(100)
		expect(h.framesFrom(from)).toEqual([[SET_SAMPLE_RATE, RATE]])
		setFrequency.mockRestore()
		await h.controller.takeTuningBack("rtl")
		await until(() => h.proofOf().frequency.state === "commanded")
		await until(() => h.framesFrom(from).length >= 3)
		expect(h.framesFrom(from).slice(1)).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, F1],
		])
		expect(h.state().resumeOutcome?.reason).toBe("operator")
	}, 30_000)
})
