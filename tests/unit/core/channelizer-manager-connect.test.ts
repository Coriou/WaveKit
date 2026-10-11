import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { PassThrough } from "node:stream"
import pino from "pino"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { ChannelizerManager } from "../../../src/core/channelizer/channelizer-manager.js"
import type { ChannelizerProcessLike } from "../../../src/core/channelizer/channelizer-process.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"

const net = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock("node:net", () => ({ createConnection: net.connect }))
const root = `/tmp/wkc-connect-${process.pid}`
const logger = pino({ level: "silent" })
const request = {
	centerHz: 162e6,
	bandwidthHz: 45_600,
	transitionHz: 1_200,
	outputRateHz: 48_000,
	format: "cf32" as const,
}
class Sources extends EventEmitter {
	getCaps(): SourceCaps {
		return {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 2_048_000,
			centerFreq: 162e6,
			exclusive: false,
		}
	}
}
class Process extends EventEmitter implements ChannelizerProcessLike {
	input = new PassThrough()
	constructor(readonly generation: number) {
		super()
	}
	start() {
		this.emit("event", {
			v: 1,
			type: "ready",
			generation: this.generation,
			pid: 42,
		})
		return Promise.resolve()
	}
	send(r: ChannelizerRequest) {
		if (r.type === "open")
			this.emit("event", {
				v: 1,
				type: "opened",
				generation: this.generation,
				id: r.id,
				socket: `${root}/test.sock`,
				outputRateHz: 48_000,
				format: "cf32",
				filterTaps: 730,
				groupDelaySamples: 3,
			})
		else if (r.type === "close")
			this.emit("event", {
				v: 1,
				type: "closed",
				generation: this.generation,
				id: r.id,
				reason: "requested",
			})
	}
	stop() {
		this.input.destroy()
		this.emit("exit", 0, null)
		return Promise.resolve()
	}
}
let m: ChannelizerManager
let socket: PassThrough
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	socket = new PassThrough()
	net.connect.mockReset().mockReturnValue(socket)
	const fanout = new FanoutManager(logger)
	m = new ChannelizerManager({
		sourceManager: new Sources() as never,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: root }),
		logger,
		openNow: Date.now,
		createProcess: o => new Process(o.generation),
	})
})
afterEach(async () => {
	await m.destroy()
	expect(vi.getTimerCount()).toBe(0)
	vi.useRealTimers()
	rmSync(root, { recursive: true, force: true })
})
describe("default socket acquisition cleanup", () => {
	it.each(["abort", "deadline"] as const)(
		"destroys a socket still connecting on %s",
		async mode => {
			const controller = new AbortController()
			const result = m.requestChannel(
				"rtl",
				"target",
				request,
				undefined,
				controller.signal,
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(net.connect).toHaveBeenCalledOnce()
			expect(socket.destroyed).toBe(false)
			if (mode === "abort") controller.abort("PRIVATE REASON MUST NOT LEAK")
			else await vi.advanceTimersByTimeAsync(5000)
			await vi.advanceTimersByTimeAsync(0)
			expect(await result).toEqual({
				ok: false,
				reasonCode: "channelizer-unavailable",
				detail:
					mode === "abort"
						? "channel request cancelled"
						: "channel request timed out after 5000 ms",
			})
			expect(socket.destroyed).toBe(true)
			expect(socket.listenerCount("connect")).toBe(0)
			expect(() =>
				socket.emit("error", new Error("late transport error")),
			).not.toThrow()
		},
	)
	it("removes acquisition abort ownership on successful connect/grant", async () => {
		const controller = new AbortController()
		const result = m.requestChannel(
			"rtl",
			"target",
			request,
			undefined,
			controller.signal,
		)
		await vi.advanceTimersByTimeAsync(0)
		socket.emit("connect")
		const granted = await result
		expect(granted.ok).toBe(true)
		controller.abort()
		expect(socket.destroyed).toBe(false)
		if (granted.ok) await m.releaseChannel(granted.channelId)
		expect(socket.destroyed).toBe(true)
	})
})
