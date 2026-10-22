import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../src/config.js"
import { ChannelizerManager } from "../../../src/core/channelizer/channelizer-manager.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose()
})
async function setup() {
	const logger = pino({ level: "silent" })
	const dir = mkdtempSync("/tmp/ch1-")
	const caps: SourceCaps = {
		kind: "iq",
		format: "U8_IQ",
		sampleRate: 2_048_000,
		centerFreq: 162e6,
		exclusive: false,
	}
	const sources = Object.assign(new EventEmitter(), { getCaps: () => caps })
	const fanout = new FanoutManager(logger)
	const sent: ChannelizerRequest[] = []
	let refused = false
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
				proc.emit(
					"event",
					refused
						? {
								v: 1,
								type: "refused",
								channelId: r.channelId,
								generation: 1,
								reason: "admission",
							}
						: {
								v: 1,
								type: "retuned",
								channelId: r.channelId,
								generation: 1,
								centerHz: r.centerHz,
							},
				)
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
	const manager = new ChannelizerManager({
		sourceManager: sources as unknown as Pick<
			SourceManager,
			"getCaps" | "on" | "off"
		>,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess: () => proc,
		connect: () => Promise.resolve(new PassThrough()),
	})
	cleanup.push(async () => {
		await manager.destroy()
		rmSync(dir, { recursive: true, force: true })
	})
	const grant = await manager.requestChannel(
		"s",
		"d",
		{
			centerHz: 162e6,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		},
		caps,
	)
	if (!grant.ok) throw new WaveKitError("test channel failed", "TEST")
	return {
		manager,
		grant,
		sent,
		proc,
		caps,
		refuse: () => {
			refused = true
		},
	}
}
it("retuneChannel sends retune and resolves retuned", async () => {
	const { manager, grant, sent } = await setup()
	await expect(
		manager.retuneChannel("s", grant.channelId, 162010000),
	).resolves.toBe("retuned")
	expect(sent.at(-1)).toEqual({
		v: 1,
		type: "retune",
		channelId: grant.channelId,
		centerHz: 162010000,
	})
})
it("refused resolves refused and leaves the channel open", async () => {
	const { manager, grant, sent, refuse } = await setup()
	refuse()
	await expect(
		manager.retuneChannel("s", grant.channelId, 163e6),
	).resolves.toBe("refused")
	expect(grant.stream.destroyed).toBe(false)
	expect(sent.some(r => r.type === "close")).toBe(false)
})
it("unknown channel id throws WaveKitError without echoing the id", async () => {
	const { manager } = await setup()
	const error: unknown = await manager
		.retuneChannel("s", "secret-untrusted-id", 162e6)
		.catch((e: unknown) => e)
	expect(error).toBeInstanceOf(WaveKitError)
	expect(String(error)).not.toContain("secret-untrusted-id")
})

it("rejects a failed send without exposing transport error text", async () => {
	const { manager, grant, proc } = await setup()
	proc.send = () => {
		throw new WaveKitError("secret transport error", "TEST")
	}
	const error: unknown = await manager
		.retuneChannel("s", grant.channelId, 162e6)
		.catch((e: unknown) => e)
	expect(error).toBeInstanceOf(WaveKitError)
	expect(String(error)).not.toContain("secret")
	expect(grant.stream.destroyed).toBe(false)
})
it("bounds a missing reply and removes its listeners", async () => {
	const { manager, grant, proc } = await setup()
	vi.useFakeTimers()
	try {
		proc.send = () => {}
		const before = proc.listenerCount("event")
		const pending = manager.retuneChannel("s", grant.channelId, 162e6)
		const assertion = expect(pending).rejects.toBeInstanceOf(WaveKitError)
		await vi.advanceTimersByTimeAsync(5000)
		await assertion
		expect(proc.listenerCount("event")).toBe(before)
	} finally {
		vi.useRealTimers()
	}
})

it("ignores unrelated replies and rejects concurrent retunes of the same channel", async () => {
	const { manager, grant, proc } = await setup()
	const send = proc.send
	proc.send = () => {}
	const before = proc.listenerCount("event")
	const pending = manager.retuneChannel("s", grant.channelId, 162010000)
	await expect(
		manager.retuneChannel("s", grant.channelId, 162020000),
	).rejects.toBeInstanceOf(WaveKitError)
	for (const reply of [
		{ generation: 2, channelId: grant.channelId },
		{ generation: 1, channelId: "other" },
	])
		proc.emit("event", { v: 1, type: "retuned", centerHz: 162010000, ...reply })
	expect(proc.listenerCount("event")).toBe(before + 1)
	proc.emit("event", {
		v: 1,
		type: "retuned",
		generation: 1,
		channelId: grant.channelId,
		centerHz: 162010000,
	})
	await expect(pending).resolves.toBe("retuned")
	expect(proc.listenerCount("event")).toBe(before)
	proc.send = send
	await expect(
		manager.retuneChannel("s", grant.channelId, 162020000),
	).resolves.toBe("retuned")
})

it.each(["exit", "protocol-error", "closed", "mismatched-centre"])(
	"rejects a pending retune on %s and removes listeners",
	async failure => {
		const { manager, grant, proc } = await setup()
		const send = proc.send
		proc.send = () => {}
		const before = proc.listenerCount("event")
		const pending = manager.retuneChannel("s", grant.channelId, 162010000)
		const assertion = expect(pending).rejects.toBeInstanceOf(WaveKitError)
		if (failure === "closed")
			proc.emit("event", {
				v: 1,
				type: "closed",
				generation: 1,
				id: grant.channelId,
				reason: "requested",
			})
		else if (failure === "mismatched-centre")
			proc.emit("event", {
				v: 1,
				type: "retuned",
				generation: 1,
				channelId: grant.channelId,
				centerHz: 162020000,
			})
		else
			proc.emit(failure, failure === "exit" ? 1 : "secret-untrusted-text", null)
		await assertion
		expect(proc.listenerCount("event")).toBeLessThanOrEqual(before)
		proc.send = send
	},
)

it("rejects non-finite centres and the wrong source before sending", async () => {
	const { manager, grant, sent } = await setup()
	const before = sent.length
	for (const center of [NaN, Infinity, -Infinity])
		await expect(
			manager.retuneChannel("s", grant.channelId, center),
		).rejects.toBeInstanceOf(WaveKitError)
	await expect(
		manager.retuneChannel("other", grant.channelId, 162e6),
	).rejects.toBeInstanceOf(WaveKitError)
	expect(sent).toHaveLength(before)
})

it("rejects a pending retune when its channel is released", async () => {
	const { manager, grant, proc } = await setup()
	const send = proc.send
	proc.send = request => {
		if (request.type !== "retune") send(request)
	}
	const before = proc.listenerCount("event")
	const pending = manager.retuneChannel("s", grant.channelId, 162010000)
	const assertion = expect(pending).rejects.toBeInstanceOf(WaveKitError)
	await manager.releaseChannel(grant.channelId)
	await assertion
	expect(proc.listenerCount("event")).toBeLessThanOrEqual(before)
})

it("a retuned reply arriving after release does not resolve retuned", async () => {
	const { manager, grant, proc, caps } = await setup()
	const other = await manager.requestChannel(
		"s",
		"d2",
		{
			centerHz: 162.02e6,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		},
		caps,
	)
	expect(other.ok).toBe(true)
	const send = proc.send
	const closes: string[] = []
	proc.send = request => {
		if (request.type === "close") closes.push(request.id)
		else if (request.type !== "retune") send(request)
	}
	const pending = manager.retuneChannel("s", grant.channelId, 162010000)
	const assertion = expect(pending).rejects.toBeInstanceOf(WaveKitError)
	const released = manager.releaseChannel(grant.channelId)
	proc.emit("event", {
		v: 1,
		type: "retuned",
		channelId: grant.channelId,
		generation: 1,
		centerHz: 162010000,
	})
	await assertion
	for (const id of closes)
		proc.emit("event", {
			v: 1,
			type: "closed",
			id,
			generation: 1,
			reason: "requested",
		})
	await released
})
