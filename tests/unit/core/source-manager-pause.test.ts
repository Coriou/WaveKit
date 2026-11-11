/**
 * Receiver feed pause / resume (SourceManager.pause / resume): a pause closes the rtl_tcp
 * connection cleanly with no reconnect, survives a restart through the state dir, and a
 * resume reconnects the same registration. A plain resume writes no tuning (another client may
 * have retuned the shared dongle during the pause); `restoreTuning` writes the accepted
 * pre-pause tuning back; relay commands made during the pause are written either way. A resume that
 * cannot reach the receiver reads "error" (fixed safe message) and a later resume retries.
 * In-process fakes only: a fake rtl_tcp server on an ephemeral loopback port.
 */
import * as net from "node:net"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SOURCE_RESUME_FAILED_MESSAGE } from "@wavekit/api-types"
import type { SourceFeed } from "@wavekit/api-types"
import {
	SourceManager,
	type SourceConfig,
} from "../../../src/core/source-manager.js"
import {
	SOURCE_FEED_FILE_NAME,
	SourceFeedStore,
	type SourceFeedPersistence,
} from "../../../src/core/source-feed-store.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"

interface FakeConnection {
	socket: net.Socket
	frames: Array<[number, number]>
	/** The client half-closed (sent FIN) before the socket closed. */
	ended: boolean
	closed: boolean
}

/** What the shared dongle is tuned to; frames from any connection change it. */
interface FakeDongle {
	centre: number
	rate: number
	gainMode: number
	gain: number
}

interface FakeRtlTcp {
	server: net.Server
	port: number
	connections: FakeConnection[]
	dongle: FakeDongle
	close(): Promise<void>
}

/** rtl_tcp-like: header on accept, then IQ every 20 ms; parses 5-byte commands. */
async function startFakeRtlTcp(port = 0): Promise<FakeRtlTcp> {
	const connections: FakeConnection[] = []
	const dongle: FakeDongle = {
		centre: 100_000_000,
		rate: 2_048_000,
		gainMode: 0,
		gain: 0,
	}
	const apply = (cmd: number, value: number) => {
		if (cmd === 0x01) dongle.centre = value
		else if (cmd === 0x02) dongle.rate = value
		else if (cmd === 0x03) dongle.gainMode = value
		else if (cmd === 0x04) dongle.gain = value
	}
	const server = net.createServer(socket => {
		const conn: FakeConnection = {
			socket,
			frames: [],
			ended: false,
			closed: false,
		}
		connections.push(conn)
		let pending = Buffer.alloc(0)
		socket.on("data", data => {
			pending = Buffer.concat([pending, Buffer.from(data)])
			while (pending.length >= 5) {
				const frame: [number, number] = [
					pending.readUInt8(0),
					pending.readUInt32BE(1),
				]
				conn.frames.push(frame)
				apply(...frame)
				pending = pending.subarray(5)
			}
		})
		// rtl_tcp closes its side when the client ends the stream.
		socket.on("end", () => {
			conn.ended = true
			socket.end()
		})
		socket.on("error", () => undefined)
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		const iq = setInterval(() => {
			if (!socket.destroyed && socket.writable)
				socket.write(Buffer.alloc(512, 127))
		}, 20)
		socket.on("close", () => {
			conn.closed = true
			clearInterval(iq)
		})
	})
	await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve))
	return {
		server,
		port: (server.address() as net.AddressInfo).port,
		connections,
		dongle,
		close: async () => {
			for (const c of connections) c.socket.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}

/** A pino logger whose messages the test can read. */
function recordingLogger() {
	const messages: string[] = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, done) {
			for (const line of chunk.toString("utf8").split("\n")) {
				if (!line) continue
				const parsed = JSON.parse(line) as { msg?: string }
				if (parsed.msg) messages.push(parsed.msg)
			}
			done()
		},
	})
	return { logger: pino({ level: "info" }, sink), messages }
}

const config = (port: number, id = "rtl"): SourceConfig => ({
	id,
	type: "rtl_tcp",
	host: "127.0.0.1",
	port,
	loop: false,
	playbackSpeed: 1,
	caps: {
		kind: "iq",
		format: "U8_IQ",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		exclusive: false,
	},
})

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting")
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

/** In-memory persistence, so a "restart" is a new SourceManager on the same store. */
class MemoryFeeds implements SourceFeedPersistence {
	saved: string[][] = []
	failNext = false
	private paused = new Set<string>()
	load(): Promise<ReadonlySet<string>> {
		return Promise.resolve(new Set(this.paused))
	}
	save(paused: ReadonlySet<string>): Promise<boolean> {
		if (this.failNext) {
			this.failNext = false
			return Promise.resolve(false)
		}
		this.paused = new Set(paused)
		this.saved.push([...paused])
		return Promise.resolve(true)
	}
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	vi.useRealTimers()
	vi.restoreAllMocks()
})

async function started(
	options: { feeds?: SourceFeedPersistence; port?: number } = {},
) {
	const upstream = await startFakeRtlTcp(options.port)
	cleanups.push(() => upstream.close())
	const { logger, messages } = recordingLogger()
	const manager = new SourceManager(logger, {
		feedPersistence: options.feeds ?? new MemoryFeeds(),
	})
	cleanups.push(() => manager.disconnectAll())
	const feedEvents: Array<[string, SourceFeed["state"]]> = []
	manager.on("feed-changed", (id, feed) => feedEvents.push([id, feed.state]))
	return { upstream, manager, messages, feedEvents }
}

describe("SourceManager feed pause / resume", () => {
	it("pause half-closes the connection, never reconnects, and is idempotent", async () => {
		const { upstream, manager, messages, feedEvents } = await started()
		const disconnected: string[] = []
		manager.on("disconnected", id => disconnected.push(id))
		await manager.connect(config(upstream.port))
		await waitFor(
			() => manager.getStatus("rtl")?.activity.state === "streaming",
		)

		const first = await manager.pause("rtl")
		expect(first.changed).toBe(true)
		expect(first.feed.state).toBe("paused")
		const conn = upstream.connections[0]!
		// Clean close: the core sent FIN and the peer saw end of stream.
		await waitFor(() => conn.closed)
		expect(conn.ended).toBe(true)
		await waitFor(() => disconnected.length === 1)
		expect(manager.getStatus("rtl")).toMatchObject({
			connected: false,
			reconnectAttempts: 0,
			feed: { state: "paused" },
		})
		expect(manager.isPaused("rtl")).toBe(true)
		// The close scheduled no reconnect (logged synchronously by the close handler).
		expect(messages).not.toContain("Scheduling reconnection")

		const second = await manager.pause("rtl")
		expect(second).toMatchObject({ changed: false, feed: { state: "paused" } })
		expect(upstream.connections).toHaveLength(1)
		expect(feedEvents).toEqual([["rtl", "paused"]])
	})

	it("a paused feed is intentional: not degraded, not unavailable, listed as paused", async () => {
		const { upstream, manager } = await started()
		await manager.connect(config(upstream.port))
		await manager.connect(config(upstream.port, "rtl2"))
		await waitFor(() => manager.getStatus("rtl")?.connected === true)
		await waitFor(() => manager.getStatus("rtl2")?.connected === true)

		await manager.pause("rtl")
		await waitFor(() => manager.getStatus("rtl")?.connected === false)
		expect(manager.getDegradedInfo()).toMatchObject({
			isDegraded: false,
			isAllUnavailable: false,
			disconnectedSources: [],
			pausedSources: ["rtl"],
		})
		await manager.pause("rtl2")
		await waitFor(() => manager.getStatus("rtl2")?.connected === false)
		expect(manager.getDegradedInfo()).toMatchObject({
			isDegraded: false,
			isAllUnavailable: false,
			disconnectedSources: [],
			pausedSources: ["rtl", "rtl2"],
		})
	})

	it("a failed resume is not intentional: the source reads disconnected and unavailable", async () => {
		const probe = await startFakeRtlTcp()
		const { manager } = await started()
		const port = probe.port
		await probe.close()
		await expect(manager.connect(config(port))).rejects.toMatchObject({
			name: "SourceConnectionError",
		})
		await manager.pause("rtl")
		await manager.resume("rtl")
		expect(manager.getStatus("rtl")?.feed?.state).toBe("error")
		expect(manager.getDegradedInfo()).toMatchObject({
			isAllUnavailable: true,
			disconnectedSources: ["rtl"],
			pausedSources: [],
		})
	})

	it("pause cancels a pending backoff retry; the receiver is never dialled while paused", async () => {
		const probe = await startFakeRtlTcp()
		const port = probe.port
		await probe.close()
		const { logger, messages } = recordingLogger()
		const manager = new SourceManager(logger, {
			feedPersistence: new MemoryFeeds(),
		})
		cleanups.push(() => manager.disconnectAll())
		await expect(manager.connect(config(port))).rejects.toMatchObject({
			name: "SourceConnectionError",
		})
		await waitFor(() => messages.includes("Scheduling reconnection"))
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		await manager.pause("rtl")
		const upstream = await startFakeRtlTcp(port)
		cleanups.push(() => upstream.close())
		// Far past the longest backoff (30 s): nothing fires.
		await vi.advanceTimersByTimeAsync(120_000)
		vi.useRealTimers()
		expect(upstream.connections).toHaveLength(0)
		expect(manager.getStatus("rtl")?.feed?.state).toBe("paused")
	})

	/** A TunerController wired to the manager as in src/index.ts (relay disabled). */
	function wiredTuner(
		manager: SourceManager,
		reconnectPolicy: "restore" | "reset" = "restore",
	) {
		const tuner = new TunerController(pino({ level: "silent" }), manager, {
			reconnectPolicy,
		})
		wireTunerControl({
			log: pino({ level: "silent" }),
			sourceManager: manager,
			tunerController: tuner,
			tunerRelay: new TunerRelay(
				pino({ level: "silent" }),
				manager,
				new FanoutManager(pino({ level: "silent" })),
				{
					enabled: false,
					host: "127.0.0.1",
					port: 0,
					sourceId: "rtl",
					controlPolicy: "exclusive",
				},
			),
			relayEnabled: false,
		})
		return tuner
	}

	/** Connects, tunes rate, centre, manual gain mode and gain, and pauses. */
	async function tunedThenPaused(
		reconnectPolicy: "restore" | "reset" = "restore",
	) {
		const ctx = await started()
		const { upstream, manager } = ctx
		const tuner = wiredTuner(manager, reconnectPolicy)
		const stream = await manager.connect(config(upstream.port))
		let bytes = 0
		stream.on("data", (chunk: Buffer) => {
			bytes += chunk.length
		})
		await waitFor(
			() => manager.getStatus("rtl")?.activity.state === "streaming",
		)
		await tuner.setSampleRate("rtl", 2_400_000)
		await tuner.setFrequency("rtl", 145_000_000)
		await tuner.setGainMode("rtl", "manual")
		await tuner.setGain("rtl", 297)
		await waitFor(() => upstream.connections[0]!.frames.length === 4)
		await manager.pause("rtl")
		await waitFor(() => upstream.connections[0]!.closed)
		return { ...ctx, tuner, bytes: () => bytes }
	}

	/** SDR++ through rtlmux while WaveKit is paused: the dongle moves, WaveKit cannot see it. */
	function retuneDuringPause(dongle: FakeDongle) {
		dongle.centre = 433_920_000
		dongle.rate = 2_160_000
		dongle.gainMode = 1
		dongle.gain = 400
	}

	/**
	 * Waits past the session's first payload, when a sync writes (synchronously), then for the
	 * written frames to cross the loopback: `frames` frames, or a short grace when none are due.
	 */
	async function settledSession(
		manager: SourceManager,
		upstream: FakeRtlTcp,
		index: number,
		frames = 0,
	) {
		await waitFor(() => upstream.connections.length === index + 1)
		await waitFor(
			() => manager.getStatus("rtl")?.activity.state === "streaming",
		)
		await waitFor(() => manager.resumeKind("rtl") === null)
		const conn = upstream.connections[index]!
		if (frames > 0) await waitFor(() => conn.frames.length >= frames)
		else await new Promise(resolve => setTimeout(resolve, 100))
		return conn
	}

	it("a paused feed shows the tuning a restore resume writes back", async () => {
		const { manager } = await tunedThenPaused()
		expect(manager.getFeed("rtl")).toMatchObject({
			state: "paused",
			restoreTuning: {
				centerFreq: 145_000_000,
				sampleRate: 2_400_000,
				gainMode: "manual",
				gain: 297,
			},
		})
		expect(manager.getStatus("rtl")?.feed?.restoreTuning?.centerFreq).toBe(
			145_000_000,
		)
	})

	it.each(["restore", "reset"] as const)(
		"plain resume writes no tuning after an external retune during the pause (reconnectPolicy %s)",
		async reconnectPolicy => {
			const { upstream, manager, tuner, feedEvents, bytes } =
				await tunedThenPaused(reconnectPolicy)
			retuneDuringPause(upstream.dongle)
			const before = bytes()

			const resumed = await manager.resume("rtl")
			expect(resumed).toMatchObject({ changed: true, feed: { state: "live" } })
			expect(resumed.feed.restoreTuning).toBeUndefined()
			const second = await settledSession(manager, upstream, 1)
			// Same stream object keeps flowing after the resume.
			await waitFor(() => bytes() > before)
			// Nothing written: SDR++'s centre, rate and gain stay on the dongle.
			expect(second.frames).toEqual([])
			expect(upstream.dongle).toEqual({
				centre: 433_920_000,
				rate: 2_160_000,
				gainMode: 1,
				gain: 400,
			})
			// The last known values stay, marked unknown until read or set; caps keep them.
			const state = tuner.getState("rtl")!
			expect(state).toMatchObject({
				frequency: 145_000_000,
				sampleRate: 2_400_000,
			})
			expect(state.unknownFields).toEqual(
				expect.arrayContaining(["frequency", "sampleRate", "gainMode", "gain"]),
			)
			expect(manager.getCaps("rtl")).toMatchObject({
				centerFreq: 145_000_000,
				sampleRate: 2_400_000,
			})
			expect(feedEvents).toEqual([
				["rtl", "paused"],
				["rtl", "resuming"],
				["rtl", "live"],
			])

			// A later dropout replays nothing from before the pause either.
			second.socket.destroy()
			const third = await settledSession(manager, upstream, 2)
			expect(third.frames).not.toEqual(
				expect.arrayContaining([[0x01, 145_000_000]]),
			)
			expect(upstream.dongle.centre).toBe(433_920_000)

			// Setting the centre proves it again.
			await tuner.setFrequency("rtl", 162_000_000)
			expect(tuner.getState("rtl")!.unknownFields ?? []).not.toContain(
				"frequency",
			)
		},
		15_000,
	)

	it.each(["restore", "reset"] as const)(
		"restore resume writes exactly the pre-pause centre, rate, gain mode and gain (reconnectPolicy %s)",
		async reconnectPolicy => {
			const { upstream, manager, tuner } =
				await tunedThenPaused(reconnectPolicy)
			retuneDuringPause(upstream.dongle)

			const resumed = await manager.resume("rtl", { restoreTuning: true })
			expect(resumed).toMatchObject({ changed: true, feed: { state: "live" } })
			const second = await settledSession(manager, upstream, 1, 4)
			expect(second.frames).toEqual([
				[0x02, 2_400_000],
				[0x01, 145_000_000],
				[0x03, 1],
				[0x04, 297],
			])
			expect(upstream.dongle).toEqual({
				centre: 145_000_000,
				rate: 2_400_000,
				gainMode: 1,
				gain: 297,
			})
			expect(tuner.getState("rtl")!.unknownFields ?? []).not.toEqual(
				expect.arrayContaining(["frequency"]),
			)

			// The override is scoped to the resume's own session: a dropout follows the policy.
			second.socket.destroy()
			const third = await settledSession(
				manager,
				upstream,
				2,
				reconnectPolicy === "restore" ? 4 : 0,
			)
			if (reconnectPolicy === "restore") {
				expect(third.frames).toEqual(
					expect.arrayContaining([[0x01, 145_000_000]]),
				)
			} else {
				expect(third.frames).not.toEqual(
					expect.arrayContaining([[0x01, 145_000_000]]),
				)
			}
		},
		15_000,
	)

	it("plain resume writes the tuner relay commands made during the pause, and only those", async () => {
		const { upstream, manager, tuner } = await tunedThenPaused()
		// What wireTunerControl does with a relay client's command while the source is down.
		tuner.applyExternalCommand("rtl", 0x01, 162_000_000)
		expect(manager.getFeed("rtl")?.restoreTuning?.centerFreq).toBe(162_000_000)

		await manager.resume("rtl")
		const second = await settledSession(manager, upstream, 1, 1)
		expect(second.frames).toEqual([[0x01, 162_000_000]])
		const state = tuner.getState("rtl")!
		expect(state.frequency).toBe(162_000_000)
		expect(state.unknownFields ?? []).not.toContain("frequency")
		expect(state.unknownFields).toEqual(
			expect.arrayContaining(["sampleRate", "gainMode", "gain"]),
		)
		expect(manager.getCaps("rtl")?.centerFreq).toBe(162_000_000)
	})

	it("with the tuner relay enabled, a relay client's retune during the pause is written on a plain resume", async () => {
		const { upstream, manager } = await started()
		const tuner = new TunerController(pino({ level: "silent" }), manager, {})
		const relay = new TunerRelay(
			pino({ level: "silent" }),
			manager,
			new FanoutManager(pino({ level: "silent" })),
			{
				enabled: true,
				host: "127.0.0.1",
				port: 0,
				sourceId: "rtl",
				controlPolicy: "shared",
			},
		)
		wireTunerControl({
			log: pino({ level: "silent" }),
			sourceManager: manager,
			tunerController: tuner,
			tunerRelay: relay,
			relayEnabled: true,
		})
		await relay.start()
		cleanups.push(() => relay.stop())
		const relayPort = (
			(
				relay as unknown as { server: net.Server }
			).server.address() as net.AddressInfo
		).port
		await manager.connect(config(upstream.port))
		await waitFor(
			() => manager.getStatus("rtl")?.activity.state === "streaming",
		)
		await tuner.setFrequency("rtl", 145_000_000)
		await manager.pause("rtl")
		await waitFor(() => upstream.connections[0]!.closed)

		// SDR++ connected to the relay retunes while WaveKit is paused: the core sees it.
		const client = net.connect(relayPort, "127.0.0.1")
		client.on("error", () => undefined)
		cleanups.push(() => {
			client.destroy()
		})
		await new Promise<void>(resolve => client.once("connect", resolve))
		const frame = Buffer.alloc(5)
		frame.writeUInt8(0x01, 0)
		frame.writeUInt32BE(162_000_000, 1)
		client.write(frame)
		await waitFor(() => tuner.getState("rtl")?.frequency === 162_000_000)
		expect(manager.getFeed("rtl")?.restoreTuning?.centerFreq).toBe(162_000_000)

		await manager.resume("rtl")
		const second = await settledSession(manager, upstream, 1, 1)
		expect(second.frames).toEqual(expect.arrayContaining([[0x01, 162_000_000]]))
		expect(second.frames).not.toEqual(
			expect.arrayContaining([[0x01, 145_000_000]]),
		)
		expect(upstream.dongle.centre).toBe(162_000_000)
	})

	it("plain resume: a configured manual gain is not written on later dropout reconnects either", async () => {
		const { upstream, manager } = await started()
		const tuner = wiredTuner(manager)
		await manager.connect({
			...config(upstream.port),
			tuner: { gainMode: "manual", gainDb: 30 },
		})
		const first = await settledSession(manager, upstream, 0, 2)
		expect(first.frames).toEqual([
			[0x03, 1],
			[0x04, 300],
		])
		await manager.pause("rtl")
		await waitFor(() => first.closed)
		retuneDuringPause(upstream.dongle)

		await manager.resume("rtl")
		const second = await settledSession(manager, upstream, 1)
		expect(second.frames).toEqual([])
		second.socket.destroy()
		const third = await settledSession(manager, upstream, 2)
		expect(third.frames).toEqual([])
		expect(upstream.dongle).toMatchObject({ gainMode: 1, gain: 400 })
		expect(tuner.getState("rtl")!.unknownFields).toEqual(
			expect.arrayContaining(["gainMode", "gain"]),
		)
	}, 15_000)

	it("a repeated pause keeps the pause mark: relay commands since the first are still written", async () => {
		const { upstream, manager, tuner } = await tunedThenPaused()
		tuner.applyExternalCommand("rtl", 0x01, 162_000_000)
		expect((await manager.pause("rtl")).changed).toBe(false)
		await manager.resume("rtl")
		const second = await settledSession(manager, upstream, 1, 1)
		expect(second.frames).toEqual([[0x01, 162_000_000]])
	})

	it("the resume kind lasts until the resumed session announced its first payload", async () => {
		const { upstream, manager } = await tunedThenPaused()
		await manager.resume("rtl")
		expect(manager.resumeKind("rtl")).not.toBeNull()
		await settledSession(manager, upstream, 1)
		expect(upstream.connections[1]!.frames).toEqual([])
		expect(manager.isResumedSession("rtl")).toBe(false)
	})

	it("retries a failed state-file write on a repeated pause or resume and reports it", async () => {
		const feeds = new MemoryFeeds()
		const { upstream, manager, messages } = await started({ feeds })
		await manager.connect(config(upstream.port))
		await waitFor(
			() => manager.getStatus("rtl")?.activity.state === "streaming",
		)

		feeds.failNext = true
		const first = await manager.pause("rtl")
		expect(first).toMatchObject({ changed: true, persisted: false })
		expect(feeds.saved).toEqual([])
		expect(
			messages.some(m => m.startsWith("Saving the paused source feeds failed")),
		).toBe(true)
		// The id is already paused in memory; the repeated pause still writes.
		const second = await manager.pause("rtl")
		expect(second).toMatchObject({ changed: false, persisted: true })
		expect(feeds.saved).toEqual([["rtl"]])
		// Nothing owed: a third pause writes nothing.
		expect(await manager.pause("rtl")).toMatchObject({ persisted: true })
		expect(feeds.saved).toHaveLength(1)

		feeds.failNext = true
		const resumed = await manager.resume("rtl")
		expect(resumed).toMatchObject({
			changed: true,
			persisted: false,
			feed: { state: "live" },
		})
		// The file still says paused (a restart would honour it) until a write succeeds.
		expect(await feeds.load()).toEqual(new Set(["rtl"]))
		const again = await manager.resume("rtl")
		expect(again).toMatchObject({ changed: false, persisted: true })
		expect(feeds.saved.at(-1)).toEqual([])
		expect(await feeds.load()).toEqual(new Set())
	})

	it("announces the live feed before the state-file write of a resume settles", async () => {
		const feeds = new MemoryFeeds()
		const { upstream, manager, feedEvents } = await started({ feeds })
		await manager.connect(config(upstream.port))
		await waitFor(
			() => manager.getStatus("rtl")?.activity.state === "streaming",
		)
		await manager.pause("rtl")
		// Hold the resume's write (a slow fsync) until the test releases it.
		let release: (ok: boolean) => void = () => undefined
		const save = vi
			.spyOn(feeds, "save")
			.mockImplementationOnce(
				() => new Promise<boolean>(resolve => (release = resolve)),
			)
		let settled = false
		const resumed = manager.resume("rtl").then(r => {
			settled = true
			return r
		})
		await waitFor(() => save.mock.calls.length === 1)
		expect(feedEvents.at(-1)).toEqual(["rtl", "live"])
		expect(settled).toBe(false)
		release(false)
		// The answer still reports the write's outcome.
		expect(await resumed).toMatchObject({
			changed: true,
			persisted: false,
			feed: { state: "live" },
		})
		expect(feedEvents.filter(([, state]) => state === "live")).toHaveLength(1)
	})

	it("drops saved pauses of sources no longer configured and rewrites the file", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "wk-feed-"))
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
		const file = join(stateDir, SOURCE_FEED_FILE_NAME)
		await writeFile(
			file,
			JSON.stringify({ version: 1, paused: ["gone", "rtl", "added"] }),
		)
		const upstream = await startFakeRtlTcp()
		cleanups.push(() => upstream.close())
		const manager = new SourceManager(pino({ level: "silent" }), { stateDir })
		cleanups.push(() => manager.disconnectAll())
		await manager.connect(config(upstream.port))
		// Registered at runtime, not in the config: its pause stays.
		await manager.connect(config(upstream.port, "added"))

		expect(await manager.pruneFeeds(["rtl"])).toBe(true)
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			version: 1,
			paused: ["rtl", "added"],
		})
		expect(manager.isPaused("rtl")).toBe(true)
		expect(upstream.connections).toHaveLength(0)

		// Nothing stale: no rewrite.
		const before = await stat(file)
		expect(await manager.pruneFeeds(["rtl"])).toBe(true)
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
	})

	it("restart while paused: the persisted pause is honoured and nothing connects", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "wk-feed-"))
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
		const upstream = await startFakeRtlTcp()
		cleanups.push(() => upstream.close())
		const silent = pino({ level: "silent" })

		const before = new SourceManager(silent, { stateDir })
		await before.connect(config(upstream.port))
		await before.pause("rtl")
		await before.disconnectAll()
		const file = JSON.parse(
			await readFile(join(stateDir, SOURCE_FEED_FILE_NAME), "utf8"),
		) as unknown
		expect(file).toEqual({ version: 1, paused: ["rtl"] })

		const { logger, messages } = recordingLogger()
		const after = new SourceManager(logger, { stateDir })
		cleanups.push(() => after.disconnectAll())
		await after.connect(config(upstream.port))
		expect(upstream.connections).toHaveLength(1)
		expect(after.getStatus("rtl")).toMatchObject({
			connected: false,
			feed: { state: "paused" },
		})
		expect(messages).toContain(
			"Source feed is paused; not connecting (POST /api/sources/:id/resume)",
		)

		await after.resume("rtl")
		await waitFor(() => upstream.connections.length === 2)
		expect(
			JSON.parse(
				await readFile(join(stateDir, SOURCE_FEED_FILE_NAME), "utf8"),
			) as unknown,
		).toEqual({ version: 1, paused: [] })
	})

	it("resume of an unreachable receiver reads error with a safe message, does not retry, and a later resume succeeds", async () => {
		const feeds = new MemoryFeeds()
		const { upstream, manager, messages } = await started({ feeds })
		await manager.connect(config(upstream.port))
		await manager.pause("rtl")
		const port = upstream.port
		await upstream.close()

		const failed = await manager.resume("rtl")
		expect(failed.feed).toMatchObject({
			state: "error",
			error: SOURCE_RESUME_FAILED_MESSAGE,
		})
		expect(manager.isPaused("rtl")).toBe(true)
		expect(messages).not.toContain("Scheduling reconnection")
		// Still paused on disk: a restart now would not connect either.
		expect(feeds.saved.at(-1)).toEqual(["rtl"])

		const back = await startFakeRtlTcp(port)
		cleanups.push(() => back.close())
		const retried = await manager.resume("rtl")
		expect(retried).toMatchObject({ changed: true, feed: { state: "live" } })
		await waitFor(() => back.connections.length === 1)
		expect(feeds.saved.at(-1)).toEqual([])
	})

	it("pause then resume issued together run in call order", async () => {
		const { upstream, manager } = await started()
		await manager.connect(config(upstream.port))
		const [paused, resumed] = await Promise.all([
			manager.pause("rtl"),
			manager.resume("rtl"),
		])
		expect(paused.feed.state).toBe("paused")
		expect(resumed.feed.state).toBe("live")
		await waitFor(() => upstream.connections.length === 2)
		expect(upstream.connections[0]!.closed).toBe(true)
	})

	it("rejects unknown ids", async () => {
		const manager = new SourceManager(pino({ level: "silent" }))
		await expect(manager.pause("nope")).rejects.toMatchObject({
			code: "SOURCE_NOT_FOUND",
		})
		await expect(manager.resume("nope")).rejects.toMatchObject({
			code: "SOURCE_NOT_FOUND",
		})
		expect(manager.isPaused("nope")).toBe(false)
	})

	it("a removed source forgets its pause", async () => {
		const feeds = new MemoryFeeds()
		const { upstream, manager } = await started({ feeds })
		await manager.connect(config(upstream.port))
		await manager.pause("rtl")
		await manager.disconnect("rtl")
		expect(feeds.saved.at(-1)).toEqual([])
		await manager.connect(config(upstream.port))
		await waitFor(() => upstream.connections.length === 2)
		expect(manager.getStatus("rtl")?.feed?.state).toBe("live")
	})
})

describe("SourceFeedStore", () => {
	it("ignores a missing, invalid or oversized file (every feed live)", async () => {
		const silent = pino({ level: "silent" })
		const read = vi.fn<(path: string, max: number) => Promise<Buffer>>()
		const store = new SourceFeedStore({
			stateDir: "/state",
			logger: silent,
			fs: { readFile: read, atomicWrite: () => Promise.resolve() },
		})
		read.mockRejectedValueOnce(
			Object.assign(new Error("x"), { code: "ENOENT" }),
		)
		expect(await store.load()).toEqual(new Set())
		read.mockResolvedValueOnce(Buffer.from("not json"))
		expect(await store.load()).toEqual(new Set())
		read.mockResolvedValueOnce(
			Buffer.from(JSON.stringify({ version: 2, paused: ["a"] })),
		)
		expect(await store.load()).toEqual(new Set())
		read.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "EFBIG" }))
		expect(await store.load()).toEqual(new Set())
		read.mockResolvedValueOnce(
			Buffer.from(JSON.stringify({ version: 1, paused: ["a", "b"] })),
		)
		expect(await store.load()).toEqual(new Set(["a", "b"]))
	})

	it("keeps the newest 16 ids and answers false on a failed write", async () => {
		const written: string[] = []
		let fail = false
		const store = new SourceFeedStore({
			stateDir: "/state",
			logger: pino({ level: "silent" }),
			fs: {
				readFile: () => Promise.reject(new Error("unused")),
				atomicWrite: (_path, data) => {
					if (fail) return Promise.reject(new Error("disk full"))
					written.push(data)
					return Promise.resolve()
				},
			},
		})
		// At the bound (16) everything is kept; past it (17) the oldest goes and the save reports false.
		const ids = Array.from({ length: 17 }, (_, i) => `s${i}`)
		expect(await store.save(new Set(ids.slice(0, 16)))).toBe(true)
		expect(
			(JSON.parse(written.at(-1)!) as { paused: string[] }).paused,
		).toHaveLength(16)
		expect(await store.save(new Set(ids))).toBe(false)
		expect(
			(JSON.parse(written.at(-1)!) as { paused: string[] }).paused,
		).toEqual(ids.slice(1))
		// An id past the length bound (128) is not persisted either: the save reports false.
		expect(await store.save(new Set(["x".repeat(128)]))).toBe(true)
		expect(await store.save(new Set(["x".repeat(129)]))).toBe(false)
		fail = true
		expect(await store.save(new Set(["a"]))).toBe(false)
	})
})
