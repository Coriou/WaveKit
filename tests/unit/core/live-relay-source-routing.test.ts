import { EventEmitter, once } from "node:events"
import * as net from "node:net"
import * as http from "node:http"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import { liveAudioListen } from "../../../src/core/scanner/listen.js"
import type { Discovery } from "../../../src/core/scanner/types.js"
import { makeNormalisedSpec } from "../../mocks/scanner/job-spec.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { TunerArbiter } from "../../../src/core/scanner/tuner-arbiter.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"
import { ConfigSchema, LiveDemodConfigSchema } from "../../../src/config.js"
import type { SourceManager } from "../../../src/core/source-manager.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
import { spawn } from "node:child_process"

const logger = pino({ level: "silent" })
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	vi.restoreAllMocks()
})

class Sources extends EventEmitter {
	readonly streams = new Map([
		["A", new PassThrough()],
		["B", new PassThrough()],
	])
	readonly caps = new Map([
		[
			"A",
			{
				kind: "iq" as const,
				format: "U8_IQ" as const,
				sampleRate: 1_024_000,
				exclusive: false,
				centerFreq: 100_000_000,
			},
		],
		[
			"B",
			{
				kind: "iq" as const,
				format: "U8_IQ" as const,
				sampleRate: 2_048_000,
				exclusive: false,
				centerFreq: 200_000_000,
			},
		],
	])
	readonly writes: Array<{ id: string; bytes: Buffer }> = []
	getAllStatus() {
		return [...this.streams.keys()].map(id => this.getStatus(id)!)
	}
	getStatus(id: string) {
		return this.streams.has(id)
			? {
					id,
					connected: true,
					type: "rtl_tcp" as const,
					caps: this.getCaps(id)!,
				}
			: undefined
	}
	getStream(id: string) {
		return this.streams.get(id)
	}
	getCaps(id: string) {
		return this.caps.get(id)
	}
	getRtlTcpInfo(id: string) {
		return { tunerType: id === "A" ? 1 : 5, tunerGainCount: 29 }
	}
	isRtlTcpSource(id: string) {
		return this.streams.has(id)
	}
	updateSourceCaps(id: string, update: object) {
		Object.assign(this.caps.get(id)!, update)
	}
	writeToSource(id: string, bytes: Buffer) {
		this.writes.push({ id, bytes: Buffer.from(bytes) })
		this.emit("write", id)
	}
}

function harness(allDedicated = false) {
	const sources = new Sources()
	const primary = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		primary,
		logger,
		undefined,
		{
			dedicated: new Set(allDedicated ? ["A", "B"] : ["A"]),
		},
	)
	// Consume A as the scanner does, so inactive-source IQ is not buffered by the fake.
	router.getFanout("A")
	cleanups.push(() => {
		router.destroy()
		primary.destroy()
		for (const stream of sources.streams.values()) stream.destroy()
	})
	return { sources, primary, router }
}

async function freePort() {
	const server = net.createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const port = (server.address() as net.AddressInfo).port
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

function mockProcesses() {
	const children: Array<
		EventEmitter & {
			stdin: PassThrough
			stdout: PassThrough
			stderr: PassThrough
			pid: number
			exitCode: number | null
			signalCode: string | null
		}
	> = []
	vi.mocked(spawn).mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			pid: 4_000_000 + children.length,
			exitCode: null,
			signalCode: null,
		})
		children.push(child)
		return child as unknown as ReturnType<typeof spawn>
	})
	vi.spyOn(process, "kill").mockImplementation(pid => {
		const child = children.find(c => c.pid === Math.abs(pid))!
		queueMicrotask(() => {
			child.signalCode = "SIGTERM"
			child.emit("exit", null, "SIGTERM")
		})
		return true
	})
	return children
}

describe("live audio and relay source routing (§10.4, §10.7)", () => {
	it.each([
		{
			explicit: undefined,
			allDedicated: false,
			legacy: false,
			policy: "exclusive" as const,
		},
		{
			explicit: "A",
			allDedicated: false,
			legacy: false,
			policy: "exclusive" as const,
		},
		{
			explicit: "A",
			allDedicated: true,
			legacy: false,
			policy: "shared" as const,
		},
		{
			explicit: "B",
			allDedicated: false,
			legacy: true,
			policy: "exclusive" as const,
		},
	])(
		"relay $explicit (allDedicated=$allDedicated, legacy=$legacy, policy=$policy) couples IQ, caps, command target and lease preemption",
		async ({ explicit, allDedicated, legacy, policy }) => {
			const { sources, primary, router } = harness(allDedicated)
			const selected = explicit ?? "B"
			const relay = new TunerRelay(
				logger,
				sources as unknown as SourceManager,
				legacy ? primary : router,
				{
					enabled: true,
					host: "127.0.0.1",
					port: await freePort(),
					sourceId: explicit,
					controlPolicy: policy,
				},
			)
			cleanups.push(() => relay.stop())
			const tuner = new TunerController(
				logger,
				sources as unknown as SourceManager,
			)
			for (const id of ["A", "B"])
				tuner.initializeSource(id, sources.getCaps(id), "rtl_tcp")
			wireTunerControl({
				log: logger,
				sourceManager: sources as unknown as SourceManager,
				tunerController: tuner,
				tunerRelay: relay,
				relayEnabled: true,
			})
			const arbiter = new TunerArbiter({
				logger,
				tuner,
				sources: sources as unknown as SourceManager,
				epochs: () => undefined,
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
			})
			cleanups.push(() => arbiter.dispose())
			expect(arbiter.acquire("scan-A", "A", 1).ok).toBe(true)
			expect(arbiter.acquire("scan-B", "B", 1).ok).toBe(true)
			await relay.start()
			expect(relay.getStatus()).toMatchObject({
				sourceId: selected,
				compatibility: "ok",
				rtlTcpHeader: sources.getRtlTcpInfo(selected),
			})
			const accepted = once(relay, "client-connected")
			const client = net.connect(relay.getStatus().port, "127.0.0.1")
			cleanups.push(() => {
				client.destroy()
			})
			const header = once(client, "data")
			await accepted
			await header
			expect(tuner.getState(selected)?.controlMode).toBe("external")
			expect(arbiter.holder(selected)).toBeUndefined()
			expect(arbiter.holder(selected === "A" ? "B" : "A")?.jobId).toBe(
				`scan-${selected === "A" ? "B" : "A"}`,
			)
			expect(arbiter.acquire("another", selected, 1)).toMatchObject({
				ok: false,
				reason: "relay",
			})
			const iq = once(client, "data")
			sources.streams.get("A")!.write(Buffer.from([11, 12]))
			sources.streams.get("B")!.write(Buffer.from([21, 22]))
			expect((await iq)[0]).toEqual(
				Buffer.from(selected === "A" ? [11, 12] : [21, 22]),
			)
			const command = Buffer.alloc(5)
			command[0] = 1
			command.writeUInt32BE(210_000_000, 1)
			const written = once(sources, "write")
			client.write(command)
			await written
			expect(sources.writes).toEqual([{ id: selected, bytes: command }])
			expect(sources.getCaps(selected)?.centerFreq).toBe(210_000_000)
			// Reconnect the selected radio; the other source still cannot feed its branch.
			sources.emit("disconnected", selected)
			sources.streams.get(selected)!.destroy()
			sources.streams.set(selected, new PassThrough())
			sources.emit("connected", selected)
			const reconnectedIq = once(client, "data")
			sources.streams
				.get(selected === "A" ? "B" : "A")!
				.write(Buffer.from([31, 32]))
			sources.streams.get(selected)!.write(Buffer.from([41, 42]))
			expect((await reconnectedIq)[0]).toEqual(Buffer.from([41, 42]))
			sources.streams.get(selected)!.destroy()
			sources.streams.delete(selected)
			sources.caps.delete(selected)
			sources.emit("removed", selected)
			expect(relay.getStatus()).toMatchObject({
				sourceId: selected,
				compatibility: "missing-source",
			})
			expect(tuner.getState(selected)).toBeUndefined()
			const disconnected = once(relay, "client-disconnected")
			client.end()
			await disconnected
			await relay.stop()
			expect(router.getFanout(selected).getBranchIds()).not.toContain(
				`tuner-relay-${selected}`,
			)
		},
	)

	it("live default and runtime selection use matching bytes and RF geometry; invalid selection preserves the running source", async () => {
		const { sources, primary, router } = harness()
		const children = mockProcesses()
		const live = new LiveDemodulator(
			logger,
			sources as unknown as SourceManager,
			router,
			LiveDemodConfigSchema.parse({
				enabled: true,
				httpPort: await freePort(),
				offsetHz: 20_000,
			}),
		)
		cleanups.push(() => live.stop())
		await live.start()
		expect(live.getStatus()).toMatchObject({
			sourceId: "B",
			sourceIqSampleRate: 2_048_000,
		})
		const tuner = new TunerController(
			logger,
			sources as unknown as SourceManager,
		)
		for (const id of ["A", "B"])
			tuner.initializeSource(id, sources.getCaps(id), "rtl_tcp")
		const arbiter = new TunerArbiter({
			logger,
			tuner,
			sources: sources as unknown as SourceManager,
			epochs: () => undefined,
			settings: () => testSettings(),
			link: () => "network",
			persistLease: () => Promise.resolve(),
			impactSources: {
				liveDemod: live,
				digitalVoice: null,
				decoders: { getAllStatus: () => [] },
			},
			scannerJobsOn: () => [],
			canHandOver: () => true,
		})
		cleanups.push(() => arbiter.dispose())
		const audioConnected = once(live, "client-connected")
		const request = http.get(
			live.getStatus().httpUrl.replace("localhost", "127.0.0.1"),
		)
		request.on("error", () => undefined)
		cleanups.push(() => {
			request.destroy()
		})
		await audioConnected
		expect(arbiter.impact("B", makeNormalisedSpec()).liveAudioClients).toBe(1)
		expect(arbiter.impact("A", makeNormalisedSpec()).liveAudioClients).toBe(0)
		const first = once(children[0]!.stdin, "data")
		sources.streams.get("A")!.write(Buffer.from([11, 12]))
		sources.streams.get("B")!.write(Buffer.from([21, 22]))
		expect((await first)[0]).toEqual(Buffer.from([21, 22]))
		expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining([
				expect.stringContaining(String(20_000 / 2_048_000)),
			]),
		)
		await expect(live.reconfigure({ sourceId: "missing" })).rejects.toThrow()
		expect(live.getStatus().sourceId).toBe("B")
		expect(primary.getBranchIds()).toContain("live-demod-B")
		await live.reconfigure({ sourceId: "A" })
		expect(live.getStatus()).toMatchObject({
			sourceId: "A",
			sourceIqSampleRate: 1_024_000,
		})
		expect(primary.getBranchIds()).not.toContain("live-demod-B")
		const second = once(children[2]!.stdin, "data")
		sources.streams.get("B")!.write(Buffer.from([23, 24]))
		sources.streams.get("A")!.write(Buffer.from([13, 14]))
		expect((await second)[0]).toEqual(Buffer.from([13, 14]))
		await live.stop()
		expect(router.getFanout("A").getBranchIds()).not.toContain("live-demod-A")
		// Idle scanner listen selects A using its actual centre and branch, then restart stays on A.
		await live.reconfigure({ sourceId: "" })
		await liveAudioListen(
			{
				sourceIds: ["A"],
				frequencyHz: 100_050_000,
				measuredOffsetHz: 0,
			} as Discovery,
			{
				caps: sources.getCaps("A"),
				usableHalfSpanHz: 400_000,
				liveDemod: live,
			},
		)
		expect(live.getStatus()).toMatchObject({
			sourceId: "A",
			config: { offsetHz: 50_000 },
			sourceIqSampleRate: 1_024_000,
		})
		const listenIq = once(children[4]!.stdin, "data")
		sources.streams.get("B")!.write(Buffer.from([51, 52]))
		sources.streams.get("A")!.write(Buffer.from([61, 62]))
		expect((await listenIq)[0]).toEqual(Buffer.from([61, 62]))
		await live.stop()
		await live.start()
		expect(live.getStatus().sourceId).toBe("A")
		sources.streams.get("A")!.destroy()
		sources.streams.delete("A")
		sources.caps.delete("A")
		sources.emit("removed", "A")
		expect(live.getStatus()).toMatchObject({
			sourceId: "A",
			sourceConnected: false,
		})
		await live.stop()
		const spawnedBefore = vi.mocked(spawn).mock.calls.length
		await expect(live.start()).rejects.toMatchObject({
			code: "LIVE_DEMOD_SOURCE_NOT_IQ",
		})
		expect(vi.mocked(spawn).mock.calls.length).toBe(spawnedBefore)
		await live.reconfigure({ sourceId: "" })
		await live.start()
		expect(live.getStatus().sourceId).toBe("B")
	})

	it("all-dedicated sources have no implicit live or relay source", async () => {
		const { sources, router } = harness(true)
		const live = new LiveDemodulator(
			logger,
			sources as unknown as SourceManager,
			router,
			LiveDemodConfigSchema.parse({ httpPort: await freePort() }),
		)
		await expect(live.start()).rejects.toThrow()
		const relay = new TunerRelay(
			logger,
			sources as unknown as SourceManager,
			router,
			{
				enabled: true,
				host: "127.0.0.1",
				port: await freePort(),
				controlPolicy: "exclusive",
			},
		)
		cleanups.push(() => relay.stop())
		await expect(relay.start()).rejects.toThrow()
		expect(sources.writes).toEqual([])
	})

	it("a legacy fixed fanout rejects changing to another radio before modifying its running pipeline", async () => {
		const { sources, primary } = harness()
		const children = mockProcesses()
		const live = new LiveDemodulator(
			logger,
			sources as unknown as SourceManager,
			primary,
			LiveDemodConfigSchema.parse({
				sourceId: "B",
				httpPort: await freePort(),
			}),
		)
		cleanups.push(() => live.stop())
		await live.start()
		await expect(live.reconfigure({ sourceId: "A" })).rejects.toMatchObject({
			code: "LIVE_DEMOD_SOURCE_ROUTING_UNAVAILABLE",
		})
		expect(live.getStatus()).toMatchObject({
			sourceId: "B",
			config: { sourceId: "B" },
		})
		const iq = once(children[0]!.stdin, "data")
		sources.streams.get("A")!.write(Buffer.from([91, 92]))
		sources.streams.get("B")!.write(Buffer.from([101, 102]))
		expect((await iq)[0]).toEqual(Buffer.from([101, 102]))
	})

	it("validates enabled relay selections against configuration before sources connect", () => {
		const { sources } = harness()
		const configured = ["A", "B"].map(id => ({
			id,
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: 1234,
			caps: sources.getCaps(id),
			...(id === "A" ? { scanner: { role: "dedicated" } } : {}),
		}))
		expect(
			ConfigSchema.safeParse({
				sources: configured,
				tunerRelay: { enabled: true, sourceId: "missing" },
			}).success,
		).toBe(false)
		for (const sourceId of [undefined, "A", "B"]) {
			expect(
				ConfigSchema.safeParse({
					sources: configured,
					tunerRelay: { enabled: true, sourceId },
				}).success,
			).toBe(true)
		}
	})

	it("relay can start before source registration and attaches only the configured source on connection", async () => {
		const sources = new Sources()
		for (const stream of sources.streams.values()) stream.destroy()
		sources.streams.clear()
		const primary = new FanoutManager(logger)
		const router = new SourceFanoutRouter(
			sources as unknown as SourceManager,
			primary,
			logger,
			"B",
			{ dedicated: new Set(["A"]) },
		)
		cleanups.push(() => {
			router.destroy()
			primary.destroy()
			for (const stream of sources.streams.values()) stream.destroy()
		})
		const relay = new TunerRelay(
			logger,
			sources as unknown as SourceManager,
			router,
			{
				enabled: true,
				host: "127.0.0.1",
				port: await freePort(),
				controlPolicy: "exclusive",
			},
		)
		cleanups.push(() => relay.stop())
		await relay.start()
		expect(relay.getStatus().sourceId).toBe("B")
		const accepted = once(relay, "client-connected")
		const client = net.connect(relay.getStatus().port, "127.0.0.1")
		cleanups.push(() => {
			client.destroy()
		})
		const header = once(client, "data")
		await accepted
		await header
		sources.streams.set("A", new PassThrough())
		sources.streams.set("B", new PassThrough())
		sources.emit("connected", "A")
		sources.emit("connected", "B")
		const iq = once(client, "data")
		sources.streams.get("A")!.write(Buffer.from([71, 72]))
		sources.streams.get("B")!.write(Buffer.from([81, 82]))
		expect((await iq)[0]).toEqual(Buffer.from([81, 82]))
	})
})
