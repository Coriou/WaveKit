import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../src/config.js"
import {
	ChannelizerManager,
	RECENTER_LINGER_MAX_MS,
	RECENTER_LINGER_MS,
} from "../../../src/core/channelizer/channelizer-manager.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { WaveKitError } from "../../../src/utils/errors.js"

import { CHANNELIZER_IDLE_STOP_MS } from "../../../src/decoders/enablement/contract.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose()
	vi.restoreAllMocks()
	vi.useRealTimers()
})
async function setup(idleStopMs?: number) {
	vi.useFakeTimers()
	const logger = pino({ level: "silent" })
	const dir = mkdtempSync("/tmp/ch2-")
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
	let closeDelayMs = 0
	const proc = Object.assign(new EventEmitter(), {
		generation: 1,
		input: new PassThrough(),
		start: () => {
			proc.emit("event", { v: 1, type: "ready", generation: 1, pid: 1 })
			return Promise.resolve()
		},
		stop: vi.fn(() => Promise.resolve()),
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
			if (r.type === "close") {
				const acknowledge = () =>
					proc.emit("event", {
						v: 1,
						type: "closed",
						id: r.id,
						generation: 1,
						reason: "requested",
					})
				if (closeDelayMs > 0) setTimeout(acknowledge, closeDelayMs)
				else acknowledge()
			}
		},
	})
	const createProcess = vi.fn(() => proc)
	const connect = vi.fn(() => Promise.resolve(new PassThrough()))
	const manager = new ChannelizerManager({
		...(idleStopMs === undefined ? {} : { idleStopMs }),
		sourceManager: sources as unknown as Pick<
			SourceManager,
			"getCaps" | "on" | "off"
		>,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess,
		connect,
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
		sources,
		createProcess,
		connect,
		grant,
		sent,
		proc,
		caps,
		delayClose: (ms: number) => {
			closeDelayMs = ms
		},
		refuse: () => {
			refused = true
		},
	}
}

it("idle stop after 60 s, not at 59.9 s", async () => {
	const { manager, grant, proc } = await setup(CHANNELIZER_IDLE_STOP_MS)
	await manager.releaseChannel(grant.channelId)
	await vi.advanceTimersByTimeAsync(59_900)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(100)
	expect(proc.stop).toHaveBeenCalledTimes(1)
	expect(vi.getTimerCount()).toBe(0)
})

it("a release then a request within the linger reuses the engine: one spawn", async () => {
	const { manager, grant, proc, caps, createProcess } = await setup(
		CHANNELIZER_IDLE_STOP_MS,
	)
	await manager.releaseChannel(grant.channelId)
	await vi.advanceTimersByTimeAsync(59_900)
	const next = await manager.requestChannel(
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
	expect(next.ok).toBe(true)
	expect(createProcess).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(1000)
	expect(proc.stop).not.toHaveBeenCalled()
	if (!next.ok) throw new WaveKitError("test channel failed", "TEST")
	await expect(
		manager.retuneChannel("s", next.channelId, 162010000),
	).resolves.toBe("retuned")
})

it.each([undefined, 0])(
	"without idleStopMs (%s) the last release retires at once",
	async idleStopMs => {
		const { manager, grant, proc } = await setup(idleStopMs)
		await manager.releaseChannel(grant.channelId)
		expect(proc.stop).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	},
)

it.each(["caps-changed", "disconnected", "removed"])(
	"%s during the linger retires at once and clears the timer",
	async event => {
		const { manager, grant, proc, sources, caps } = await setup(
			CHANNELIZER_IDLE_STOP_MS,
		)
		await manager.releaseChannel(grant.channelId)
		sources.emit(event, "s", { ...caps, sampleRate: 2_400_000 })
		expect(proc.stop).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(CHANNELIZER_IDLE_STOP_MS)
		expect(proc.stop).toHaveBeenCalledTimes(1)
	},
)

it("a centre move during the linger keeps the process and its linger", async () => {
	const { manager, grant, proc, sources, caps, sent } = await setup(
		CHANNELIZER_IDLE_STOP_MS,
	)
	await manager.releaseChannel(grant.channelId)
	sources.emit("caps-changed", "s", { ...caps, centerFreq: 163e6 })
	await Promise.resolve()
	expect(proc.stop).not.toHaveBeenCalled()
	expect(sent.at(-1)).toEqual({
		v: 1,
		type: "recenter",
		centerHz: 163e6,
		atInputBytes: 0,
	})
	await vi.advanceTimersByTimeAsync(CHANNELIZER_IDLE_STOP_MS - 1)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(proc.stop).toHaveBeenCalledTimes(1)
})

it.each([undefined, 0])(
	"with idle stop %s, a centre move that takes the last channel lingers for exactly RECENTER_LINGER_MS",
	async idleStopMs => {
		const { proc, sources, caps } = await setup(idleStopMs)
		sources.emit("caps-changed", "s", { ...caps, centerFreq: 163e6 })
		expect(proc.stop).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 1)
		expect(proc.stop).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(proc.stop).toHaveBeenCalledTimes(1)
	},
)

it("cleaning up an acquisition the move caught keeps the recentre deadline", async () => {
	const { manager, proc, sources, caps, connect } = await setup()
	connect.mockImplementation(() => new Promise<PassThrough>(() => {}))
	const controller = new AbortController()
	const pending = manager.requestChannel(
		"s",
		"b",
		{
			centerHz: 162e6,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		},
		caps,
		controller.signal,
	)
	await vi.advanceTimersByTimeAsync(10)
	expect(connect).toHaveBeenCalledTimes(2)
	const moved = { ...caps, centerFreq: 163e6 }
	sources.getCaps = () => moved
	sources.emit("caps-changed", "s", moved)
	await vi.advanceTimersByTimeAsync(100)
	controller.abort()
	expect((await pending).ok).toBe(false)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 101)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(proc.stop).toHaveBeenCalledTimes(1)
})

it("a request the new centre refuses inside the linger keeps its deadline too", async () => {
	const { manager, proc, sources, caps } = await setup()
	sources.emit("caps-changed", "s", { ...caps, centerFreq: 170e6 })
	const moved = { ...caps, centerFreq: 170e6 }
	sources.getCaps = () => moved
	await vi.advanceTimersByTimeAsync(1000)
	const refused = await manager.requestChannel(
		"s",
		"b",
		{
			centerHz: 162e6,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		},
		moved,
	)
	expect(refused.ok).toBe(false)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 1001)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(proc.stop).toHaveBeenCalledTimes(1)
})

it("a grant after a move ends the deadline: its release retires at once", async () => {
	const { manager, proc, sources, caps } = await setup()
	const moved = { ...caps, centerFreq: 163e6 }
	sources.getCaps = () => moved
	sources.emit("caps-changed", "s", moved)
	await vi.advanceTimersByTimeAsync(10)
	const next = await manager.requestChannel(
		"s",
		"d",
		{
			centerHz: 163e6,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		},
		moved,
	)
	if (!next.ok) throw new WaveKitError(next.detail, "TEST")
	await manager.releaseChannel(next.channelId)
	expect(proc.stop).toHaveBeenCalledTimes(1)
})

it("a later move moves a running timer's deadline: stopped at it, not 1 ms before", async () => {
	const { proc, sources, caps, sent } = await setup()
	sources.emit("caps-changed", "s", { ...caps, centerFreq: 163e6 })
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 10)
	sources.emit("caps-changed", "s", { ...caps, centerFreq: 164e6 })
	await Promise.resolve()
	expect(sent.at(-1)).toMatchObject({ type: "recenter", centerHz: 164e6 })
	// The first timer is due now and must not stop the process.
	await vi.advanceTimersByTimeAsync(10)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 10 - 1)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(proc.stop).toHaveBeenCalledTimes(1)
	expect(vi.getTimerCount()).toBe(0)
})

it("moves that never stop hold a channel-less process only up to the cap", async () => {
	const { proc, sources, caps } = await setup()
	const hopMs = 500
	let hop = 0
	const hops = RECENTER_LINGER_MAX_MS / hopMs
	sources.emit("caps-changed", "s", { ...caps, centerFreq: 163e6 })
	// A hop every 500 ms: each one is inside the linger, so only the cap can end it.
	for (; hop < hops - 1; hop++) {
		await vi.advanceTimersByTimeAsync(hopMs)
		sources.emit("caps-changed", "s", {
			...caps,
			centerFreq: 164e6 + hop * 1e5,
		})
		expect(proc.stop).not.toHaveBeenCalled()
	}
	await vi.advanceTimersByTimeAsync(hopMs - 1)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(proc.stop).toHaveBeenCalledTimes(1)
	expect(vi.getTimerCount()).toBe(0)
})

it("a grant gives the next move a whole new cap", async () => {
	const { manager, proc, sources, caps } = await setup()
	sources.emit("caps-changed", "s", { ...caps, centerFreq: 163e6 })
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 1)
	const moved = { ...caps, centerFreq: 164e6 }
	sources.getCaps = () => moved
	sources.emit("caps-changed", "s", moved)
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 1)
	const grant = await manager.requestChannel(
		"s",
		"d",
		{
			centerHz: 164e6,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		},
		moved,
	)
	if (!grant.ok) throw new WaveKitError(grant.detail, "TEST")
	const later = { ...caps, centerFreq: 165e6 }
	sources.getCaps = () => later
	sources.emit("caps-changed", "s", later)
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS - 1)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(proc.stop).toHaveBeenCalledTimes(1)
})

it("a longer configured idle stop wins over the recentre linger", async () => {
	const { proc, sources, caps } = await setup(CHANNELIZER_IDLE_STOP_MS)
	sources.emit("caps-changed", "s", { ...caps, centerFreq: 163e6 })
	await vi.advanceTimersByTimeAsync(RECENTER_LINGER_MS + 1)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(
		CHANNELIZER_IDLE_STOP_MS - RECENTER_LINGER_MS - 1,
	)
	expect(proc.stop).toHaveBeenCalledTimes(1)
})

it("destroy during the linger stops the process and leaves no timer", async () => {
	const { manager, grant, proc } = await setup(CHANNELIZER_IDLE_STOP_MS)
	await manager.releaseChannel(grant.channelId)
	await manager.destroy()
	expect(proc.stop).toHaveBeenCalledTimes(1)
	expect(vi.getTimerCount()).toBe(0)
})

it("the linger timer does not keep the event loop alive", async () => {
	const { manager, grant } = await setup(CHANNELIZER_IDLE_STOP_MS)
	const timer = vi.spyOn(globalThis, "setTimeout")
	await manager.releaseChannel(grant.channelId)
	const index = timer.mock.calls.findIndex(
		call => call[1] === CHANNELIZER_IDLE_STOP_MS,
	)
	expect(index).toBeGreaterThanOrEqual(0)
	const handle = timer.mock.results[index]?.value as ReturnType<
		typeof setTimeout
	>
	expect(handle.hasRef()).toBe(false)
})

it("a pending open cancels the linger until acquisition settles", async () => {
	const { manager, grant, proc, caps, connect } = await setup(
		CHANNELIZER_IDLE_STOP_MS,
	)
	await manager.releaseChannel(grant.channelId)
	await vi.advanceTimersByTimeAsync(59_900)
	let connected: ((socket: PassThrough) => void) | undefined
	connect.mockImplementation(
		() =>
			new Promise(resolve => {
				connected = resolve
			}),
	)
	const pending = manager.requestChannel(
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
	await vi.advanceTimersByTimeAsync(200)
	expect(proc.stop).not.toHaveBeenCalled()
	expect(connected).toBeDefined()
	connected?.(new PassThrough())
	expect((await pending).ok).toBe(true)
	expect(vi.getTimerCount()).toBe(1) // the running generation's watchdog; no linger timer
})

it("a last channel dying starts the linger", async () => {
	const { grant, proc } = await setup(CHANNELIZER_IDLE_STOP_MS)
	proc.emit("event", {
		v: 1,
		type: "closed",
		generation: 1,
		id: grant.channelId,
		reason: "client-gone",
	})
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(CHANNELIZER_IDLE_STOP_MS)
	expect(proc.stop).toHaveBeenCalledTimes(1)
})

it("a reopen waiting for close acknowledgement preserves the engine past idle expiry", async () => {
	const { manager, grant, proc, caps, createProcess, delayClose } =
		await setup(100)
	delayClose(200)
	const released = manager.releaseChannel(grant.channelId)
	await vi.advanceTimersByTimeAsync(50)
	const pending = manager.requestChannel(
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
	await vi.advanceTimersByTimeAsync(100)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(50)
	expect((await pending).ok).toBe(true)
	await released
	expect(createProcess).toHaveBeenCalledTimes(1)
	expect(vi.getTimerCount()).toBe(1) // the running generation's watchdog; no linger timer
})

it("a cancelled close waiter restores the idle linger", async () => {
	const { manager, grant, proc, caps, delayClose } = await setup(100)
	delayClose(200)
	const released = manager.releaseChannel(grant.channelId)
	await vi.advanceTimersByTimeAsync(50)
	const controller = new AbortController()
	const pending = manager.requestChannel(
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
		controller.signal,
	)
	await vi.advanceTimersByTimeAsync(10)
	controller.abort()
	expect((await pending).ok).toBe(false)
	await vi.advanceTimersByTimeAsync(99)
	expect(proc.stop).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(proc.stop).toHaveBeenCalledTimes(1)
	await released
	await vi.advanceTimersByTimeAsync(40)
	expect(vi.getTimerCount()).toBe(0)
})
