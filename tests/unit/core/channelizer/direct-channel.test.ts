/**
 * ChannelizerManager with `input: "direct"`: the grant carries the paused socket and no stream, the connector gets the
 * mode, a handed-off channel still retunes, and `stats` lines become `channel-stats`. The process is scripted and
 * the connector is a fake socket; nothing connects anywhere. The settlement adapter forwards both the mode and the
 * counters, and asks the channelizer for counters only while something listens to it (relay mode: nothing does).
 */
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../../src/config.js"
import {
	ChannelizerManager,
	type ChannelizerManagerDeps,
} from "../../../../src/core/channelizer/channelizer-manager.js"
import type { ChannelizerRequest } from "../../../../src/core/channelizer/protocol.js"
import { SettlementRegistry } from "../../../../src/core/channelizer/settlement-observer.js"
import type {
	ChannelInputMode,
	ChannelProvider,
	ChannelRequestOptions,
	ChannelRequestResult,
	ChannelStats,
	DecoderChannelRequest,
	DirectChannelPort,
} from "../../../../src/core/channelizer/types.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"

const logger = pino({ level: "silent" })
const caps: SourceCaps = {
	kind: "iq",
	format: "U8_IQ",
	sampleRate: 2_048_000,
	centerFreq: 162e6,
	exclusive: false,
}
const request = (format: "cu8" | "cf32" = "cf32"): DecoderChannelRequest => ({
	centerHz: 162e6,
	bandwidthHz: 45_600,
	transitionHz: 1200,
	outputRateHz: 48_000,
	format,
})

/** What a paused, unread net.Socket looks like to the manager. */
function fakeSocket(paused = true): PassThrough & { bytesRead: number } {
	const socket = Object.assign(new PassThrough(), { bytesRead: 0 })
	if (paused) socket.pause()
	return socket
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function setup(opts: { pause?: boolean } = {}) {
	const dir = mkdtempSync("/tmp/wkdc-")
	const sources = Object.assign(new EventEmitter(), { getCaps: () => caps })
	const fanout = new FanoutManager(logger)
	const sent: ChannelizerRequest[] = []
	const sockets: Array<PassThrough & { bytesRead: number }> = []
	const modes: Array<ChannelInputMode | undefined> = []
	const argCounts: number[] = []
	const proc = Object.assign(new EventEmitter(), {
		generation: 1,
		input: new PassThrough(),
		start: () => {
			proc.emit("event", { v: 1, type: "ready", generation: 1, pid: 1 })
			return Promise.resolve()
		},
		stop: () => Promise.resolve(),
		send: (r: ChannelizerRequest) => {
			sent.push(r)
			if (r.type === "open")
				proc.emit("event", {
					v: 1,
					type: "opened",
					id: r.id,
					generation: 1,
					socket: "fake",
					outputRateHz: r.outputRateHz,
					format: r.format,
					filterTaps: 10,
					groupDelaySamples: 5,
				})
			if (r.type === "retune")
				proc.emit("event", {
					v: 1,
					type: "retuned",
					channelId: r.channelId,
					generation: 1,
					centerHz: r.centerHz,
				})
			if (r.type === "close")
				proc.emit("event", {
					v: 1,
					type: "closed",
					id: r.id,
					generation: 1,
					reason: "requested",
				})
		},
	})
	const connect: NonNullable<ChannelizerManagerDeps["connect"]> = (...args) => {
		argCounts.push(args.length)
		modes.push(args[2])
		const socket = fakeSocket(opts.pause ?? args[2] === "direct")
		sockets.push(socket)
		return Promise.resolve(socket)
	}
	const manager = new ChannelizerManager({
		sourceManager:
			sources as unknown as ChannelizerManagerDeps["sourceManager"],
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess: () => proc,
		connect,
	})
	cleanup.push(async () => {
		await manager.destroy()
		fanout.destroy()
		rmSync(dir, { recursive: true, force: true })
	})
	const invalidated: unknown[][] = []
	manager.on("channel-invalidated", (...args: unknown[]) =>
		invalidated.push(args),
	)
	return { manager, proc, sent, sockets, modes, argCounts, invalidated }
}

const direct: ChannelRequestOptions = { input: "direct" }

describe("ChannelizerManager direct grants", () => {
	it("hands the connector the mode and grants the paused socket with no stream", async () => {
		const { manager, sockets, modes } = setup()
		const grant = await manager.requestChannel(
			"s",
			"d",
			request(),
			caps,
			undefined,
			direct,
		)
		expect(modes).toEqual(["direct"])
		expect(grant).toMatchObject({
			ok: true,
			input: "direct",
			channelId: "d-g1",
			generation: 1,
			realised: { outputRateHz: 48_000, format: "cf32", groupDelaySamples: 5 },
		})
		if (!grant.ok || !("socket" in grant)) throw new Error("direct grant")
		expect("stream" in grant).toBe(false)
		expect(grant.socket).toBe(sockets[0])
		// Not piped, not read: error and close listeners only.
		expect(grant.socket.listenerCount("data")).toBe(0)
		expect(grant.socket.isPaused()).toBe(true)
		expect(grant.socket.readableFlowing).toBe(false)
		expect(manager.openChannelRows()).toHaveLength(1)
	})

	it("keeps the relay call and grant unchanged without the option", async () => {
		const { manager, sockets, argCounts } = setup()
		const grant = await manager.requestChannel("s", "d", request(), caps)
		expect(argCounts).toEqual([2])
		if (!grant.ok) throw new Error("relay grant")
		expect(grant.stream).not.toBe(sockets[0])
		expect(sockets[0]?.listenerCount("data")).toBeGreaterThan(0)
	})

	it("refuses a connector that did not pause, and closes the channel", async () => {
		const { manager, sent, sockets } = setup({ pause: false })
		const grant = await manager.requestChannel(
			"s",
			"d",
			request(),
			caps,
			undefined,
			direct,
		)
		expect(grant).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "channel socket not paused for direct input",
		})
		expect(sockets[0]?.destroyed).toBe(true)
		expect(sent.map(r => r.type)).toEqual(["open", "close"])
		expect(manager.openChannelRows()).toHaveLength(0)
	})

	it("retunes a handed-off channel (Node's copy destroyed) without any stream", async () => {
		const { manager, sent } = setup()
		const grant = await manager.requestChannel(
			"s",
			"d",
			request(),
			caps,
			undefined,
			direct,
		)
		if (!grant.ok || !("socket" in grant)) throw new Error("direct grant")
		grant.socket.destroy()
		await new Promise(resolve => setImmediate(resolve))
		await expect(manager.retuneChannel("s", "d-g1", 162.01e6)).resolves.toBe(
			"retuned",
		)
		expect(sent.filter(r => r.type === "retune")).toHaveLength(1)
		expect(manager.openChannelRows()[0]?.centerHz).toBe(162.01e6)
	})

	it("fails a pending retune on the channel's terminal event, not on a stream close", async () => {
		const { manager, proc } = setup()
		const grant = await manager.requestChannel(
			"s",
			"d",
			request(),
			caps,
			undefined,
			direct,
		)
		if (!grant.ok) throw new Error("direct grant")
		const send = proc.send
		proc.send = (r: ChannelizerRequest) => {
			if (r.type !== "retune") send(r)
		}
		const retune = manager.retuneChannel("s", "d-g1", 162.02e6)
		proc.emit("event", {
			v: 1,
			type: "closed",
			id: "d-g1",
			generation: 1,
			reason: "client-gone",
		})
		await expect(retune).rejects.toThrow("transport unavailable")
	})

	it("releases a direct channel without an invalidation and destroys Node's copy", async () => {
		const { manager, sent, sockets, invalidated } = setup()
		await manager.requestChannel("s", "d", request(), caps, undefined, direct)
		await manager.releaseChannel("d-g1")
		expect(sockets[0]?.destroyed).toBe(true)
		expect(sent.at(-1)).toMatchObject({ type: "close", id: "d-g1" })
		expect(invalidated).toEqual([])
	})

	it("reports client-gone as the invalidation's cause", async () => {
		const { manager, proc, invalidated } = setup()
		await manager.requestChannel("s", "d", request(), caps, undefined, direct)
		proc.emit("event", {
			v: 1,
			type: "closed",
			id: "d-g1",
			generation: 1,
			reason: "client-gone",
		})
		expect(invalidated).toEqual([["s", 1, ["d-g1"], "client-gone"]])
	})

	it("keeps reporting discontinuities of a direct channel", async () => {
		const { manager, proc } = setup()
		await manager.requestChannel("s", "d", request(), caps, undefined, direct)
		const seen: unknown[][] = []
		manager.on("channel-discontinuity", (...args: unknown[]) => seen.push(args))
		proc.emit("event", {
			v: 1,
			type: "discontinuity",
			id: "d-g1",
			generation: 1,
			sampleIndex: 100,
			droppedSamples: 50,
			cause: "queue-overflow",
		})
		expect(seen).toEqual([["d-g1", 1, 100, 50, "queue-overflow"]])
	})
})

describe("channel-stats", () => {
	it("emits one event per open channel of a stats line, in bytes of each channel's format", async () => {
		const { manager, proc } = setup()
		await manager.requestChannel(
			"s",
			"a",
			request("cf32"),
			caps,
			undefined,
			direct,
		)
		await manager.requestChannel("s", "b", request("cu8"), caps)
		const stats: ChannelStats[] = []
		manager.on("channel-stats", (entry: ChannelStats) => stats.push(entry))
		const entry = (id: string, outputSamples: number) => ({
			id,
			outputSamples,
			queueHighWaterBytes: 0,
			droppedSamples: 0,
			saturatedSamples: 0,
		})
		proc.emit("event", {
			v: 1,
			type: "stats",
			generation: 1,
			inputSamples: 1000,
			channels: [entry("a-g1", 480), entry("b-g1", 96), entry("gone-g1", 7)],
		})
		expect(stats).toEqual([
			{
				sourceId: "s",
				generation: 1,
				channelId: "a-g1",
				outputSamples: 480,
				bytesPerSample: 8,
			},
			{
				sourceId: "s",
				generation: 1,
				channelId: "b-g1",
				outputSamples: 96,
				bytesPerSample: 2,
			},
		])
	})

	it("emits nothing with no listener and survives a throwing one", async () => {
		const { manager, proc } = setup()
		await manager.requestChannel("s", "a", request(), caps, undefined, direct)
		const line = {
			v: 1,
			type: "stats",
			generation: 1,
			inputSamples: 1,
			channels: [
				{
					id: "a-g1",
					outputSamples: 1,
					queueHighWaterBytes: 0,
					droppedSamples: 0,
					saturatedSamples: 0,
				},
			],
		}
		const emit = vi.spyOn(manager, "emit")
		proc.emit("event", line)
		expect(emit.mock.calls.some(call => call[0] === "channel-stats")).toBe(
			false,
		)
		manager.on("channel-stats", () => {
			throw new Error("listener")
		})
		expect(() => proc.emit("event", line)).not.toThrow()
	})
})

describe("settlement adapter", () => {
	class Underlying extends EventEmitter implements ChannelProvider {
		readonly calls: Array<{ args: number; options?: ChannelRequestOptions }> =
			[]
		override off(
			event: string | symbol,
			listener: (...args: never[]) => void,
		): this {
			return super.off(event, listener as (...args: unknown[]) => void)
		}
		requestChannel(
			_sourceId: string,
			_decoderId: string,
			_req: DecoderChannelRequest,
			_caps: SourceCaps | undefined,
			...rest: [AbortSignal?, ChannelRequestOptions?]
		): Promise<ChannelRequestResult> {
			this.calls.push({
				args: 4 + rest.length,
				...(rest[1] ? { options: rest[1] } : {}),
			})
			return Promise.resolve({
				ok: false,
				reasonCode: "channelizer-unavailable",
				detail: "held",
			})
		}
		releaseChannel(): Promise<void> {
			return Promise.resolve()
		}
		currentGeneration(): number {
			return 1
		}
	}

	function bound() {
		const registry = new SettlementRegistry()
		const lifetime = registry.registerProviderLifetime()!
		const observer = registry.createObserver(lifetime)
		const underlying = new Underlying()
		const adapter = observer.bindProvider(underlying) as ChannelProvider &
			DirectChannelPort
		return { underlying, adapter, observer, lifetime }
	}

	it("passes the direct option through and keeps the relay call as it was", async () => {
		const { underlying, adapter } = bound()
		await adapter.requestChannel("s", "d", request(), caps)
		await adapter.requestChannel("s", "d", request(), caps, undefined, direct)
		expect(underlying.calls).toEqual([
			{ args: 4 },
			{ args: 6, options: { input: "direct" } },
		])
	})

	it("forwards channel-stats to its own listeners", () => {
		const { underlying, adapter } = bound()
		const seen: ChannelStats[] = []
		const listener = (entry: ChannelStats) => seen.push(entry)
		adapter.on("channel-stats", listener)
		const entry: ChannelStats = {
			sourceId: "s",
			generation: 1,
			channelId: "d-g1",
			outputSamples: 5,
			bytesPerSample: 8,
		}
		underlying.emit("channel-stats", entry)
		adapter.off("channel-stats", listener)
		underlying.emit("channel-stats", entry)
		expect(seen).toEqual([entry])
	})

	it("attaches its forwarder below only while it has a channel-stats listener", () => {
		const { underlying, adapter } = bound()
		expect(underlying.listenerCount("channel-stats")).toBe(0)
		const a = () => {}
		const b = () => {}
		adapter.on("channel-stats", a)
		adapter.on("channel-stats", b)
		expect(underlying.listenerCount("channel-stats")).toBe(1)
		adapter.off("channel-stats", a)
		expect(underlying.listenerCount("channel-stats")).toBe(1)
		adapter.off("channel-stats", b)
		expect(underlying.listenerCount("channel-stats")).toBe(0)
	})

	it("the invalidation claim's remover removes an attached forwarder, and none attaches after it", () => {
		const { underlying, adapter, observer, lifetime } = bound()
		adapter.on("channel-stats", () => {})
		expect(underlying.listenerCount("channel-stats")).toBe(1)
		observer.sealAdmission()
		expect(lifetime.disposeListenersIfSettled()).toMatchObject({ ok: true })
		expect(underlying.listenerCount("channel-invalidated")).toBe(0)
		expect(underlying.listenerCount("channel-stats")).toBe(0)
		adapter.on("channel-stats", () => {})
		expect(underlying.listenerCount("channel-stats")).toBe(0)
	})

	it("relay mode (no adapter listener): the manager's stats line emits no channel-stats; a listener turns it on", async () => {
		const { manager, proc } = setup()
		const registry = new SettlementRegistry()
		const observer = registry.createObserver(
			registry.registerProviderLifetime()!,
		)
		const adapter = observer.bindProvider(manager) as ChannelProvider &
			DirectChannelPort
		await adapter.requestChannel("s", "a", request(), caps)
		const line = {
			v: 1,
			type: "stats",
			generation: 1,
			inputSamples: 1,
			channels: [
				{
					id: "a-g1",
					outputSamples: 1,
					queueHighWaterBytes: 0,
					droppedSamples: 0,
					saturatedSamples: 0,
				},
			],
		}
		const emit = vi.spyOn(manager, "emit")
		const emitted = () =>
			emit.mock.calls.filter(call => call[0] === "channel-stats").length
		proc.emit("event", line)
		expect(manager.listenerCount("channel-stats")).toBe(0)
		expect(emitted()).toBe(0)
		const seen: ChannelStats[] = []
		const listener = (entry: ChannelStats) => seen.push(entry)
		adapter.on("channel-stats", listener)
		proc.emit("event", line)
		expect(emitted()).toBe(1)
		expect(seen).toEqual([
			{
				sourceId: "s",
				generation: 1,
				channelId: "a-g1",
				outputSamples: 1,
				bytesPerSample: 8,
			},
		])
		adapter.off("channel-stats", listener)
		proc.emit("event", line)
		expect(emitted()).toBe(1)
	})
})
