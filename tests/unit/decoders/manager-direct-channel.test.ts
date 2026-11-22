/**
 * DecoderManager with direct channel input (direct-channel-input.ts): the channel socket is the decoder's stdin, so
 * the manager decides by the channel's terminal event whether an exit was the channel going away (one restart, no
 * crash accounting) or the decoder dying by itself (today's crash path). Fake channelizer, fake children, fake clock.
 */
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import {
	CHANNEL_INPUT_ENV,
	resetProcessChannelInputModeForTests,
} from "../../../src/decoders/channel-input-mode.js"
import { CHANNEL_FATE_MS } from "../../../src/decoders/direct-channel-input.js"
import {
	DecoderManager,
	type DecoderManagerConfig,
} from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	FakeSources,
	RateDecoder,
	deferred,
	iqCaps,
} from "../../mocks/rate-fakes.js"
import {
	CENTER,
	DirectDecoder,
	DirectProvider,
} from "./direct-channel-fakes.js"

const DEBOUNCE = 350

let sources: FakeSources
let provider: DirectProvider
let manager: DecoderManager
let decoders: Map<string, DirectDecoder>
let order: string[]
let restarting: string[]
let logLines: Array<Record<string, unknown>>

/** `fromEnvironment`: no channelInput option, so the process mode (WAVEKIT_CHANNEL_INPUT) decides. */
function setup(
	config: Partial<DecoderManagerConfig> = {},
	fromEnvironment = false,
) {
	vi.useFakeTimers()
	logLines = []
	order = []
	const logger = pino(
		{ level: "info" },
		{ write: (line: string) => void logLines.push(JSON.parse(line)) },
	)
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
	decoders = new Map()
	const registry = new DecoderRegistry()
	registry.register(
		"direct-test",
		cfg => {
			const decoder = new DirectDecoder(cfg.id, order)
			decoders.set(cfg.id, decoder)
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
		...(fromEnvironment ? {} : { channelInput: "direct" as const }),
		...config,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	provider = new DirectProvider(order)
	manager.setChannelizer(provider)
	restarting = []
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
}

function create(id = "dec"): DirectDecoder {
	const config: DecoderConfig = {
		id,
		type: "direct-test",
		enabled: true,
		options: {},
		useChannelizer: true,
	}
	manager.createDecoder(config)
	return decoders.get(id)!
}

async function settle(ms = DEBOUNCE) {
	await vi.advanceTimersByTimeAsync(ms)
}

function status(id = "dec") {
	return manager.getStatus(id)!
}

function warnings(msg: string) {
	return logLines.filter(line => line["msg"] === msg)
}

/** The crash path's failure count (not in the status DTO). */
function failures(id = "dec") {
	return (
		manager as unknown as {
			decoders: Map<string, { consecutiveFailures: number }>
		}
	).decoders.get(id)!.consecutiveFailures
}

/** The manager's state of a decoder: its rate generation is what exit-pending's guard compares. */
function internalState(id = "dec") {
	return (
		manager as unknown as {
			decoders: Map<
				string,
				{
					rateGeneration: number
					suspension: { reasonCode: string } | null
				}
			>
		}
	).decoders.get(id)!
}

beforeEach(() => setup())
afterEach(async () => {
	try {
		await manager.destroy()
		// D1, D3: no socket was ever read, and none is left open.
		for (const socket of provider.sockets.values()) {
			expect(socket.listenerCount("data")).toBe(0)
			expect(socket.destroyed).toBe(true)
		}
	} finally {
		vi.useRealTimers()
	}
})

describe("direct wiring", () => {
	it("hands the decoder the channel socket, never reads it and destroys Node's copy at the spawn", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([
			{ decoderId: "dec", args: 6, options: { input: "direct" } },
		])
		const socket = provider.sockets.get("dec-g1")!
		expect(decoder.spawnedWith).toEqual([socket])
		expect(decoder.relayed).toEqual([])
		expect(socket.destroyed).toBe(true)
		expect(socket.listenerCount("data")).toBe(0)
		expect(status()).toMatchObject({ running: true, suspended: false })
	})

	it.each([
		["unset", undefined, "direct"],
		["empty", "", "direct"],
		["relay", "relay", "relay"],
		["direct", "direct", "direct"],
	] as const)(
		"with no option, WAVEKIT_CHANNEL_INPUT %s selects %s; a scanner probe keeps the relay either way",
		async (_label, value, expected) => {
			await manager.destroy()
			if (value === undefined) vi.stubEnv(CHANNEL_INPUT_ENV, undefined)
			else vi.stubEnv(CHANNEL_INPUT_ENV, value)
			resetProcessChannelInputModeForTests()
			try {
				setup({}, true)
				const decoder = create()
				await manager.startDecoder("dec")
				await manager.createEphemeralDecoder(
					{
						id: "probe",
						type: "direct-test",
						enabled: true,
						options: {},
						useChannelizer: true,
					},
					{ owner: "scanner", jobId: "job" },
				)
				expect(provider.calls[0]).toEqual(
					expected === "direct"
						? { decoderId: "dec", args: 6, options: { input: "direct" } }
						: { decoderId: "dec", args: 4 },
				)
				expect(provider.calls[1]).toEqual({ decoderId: "probe", args: 4 })
				expect(decoder.spawnedWith).toHaveLength(expected === "direct" ? 1 : 0)
				expect(
					logLines.filter(line => line["msg"] === "Channel input mode"),
				).toEqual([expect.objectContaining({ channelInput: expected })])
			} finally {
				vi.unstubAllEnvs()
				resetProcessChannelInputModeForTests()
			}
		},
	)

	it("relay mode keeps today's request and stream", async () => {
		await manager.destroy()
		setup({ channelInput: "relay" })
		const decoder = create()
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([{ decoderId: "dec", args: 4 }])
		expect(decoder.relayed).toEqual([provider.streams.get("dec-g1")])
		expect(decoder.spawnedWith).toEqual([])
	})

	it("a decoder without a direct input port keeps the relay in direct mode", async () => {
		const registry = (manager as unknown as { registry: DecoderRegistry })
			.registry
		class RelayOnly extends RateDecoder {
			getChannelRequest() {
				return {
					centerHz: CENTER,
					bandwidthHz: 45_600,
					transitionHz: 1200,
					outputRateHz: 48_000,
					format: "cf32" as const,
				}
			}
		}
		registry.register(
			"relay-only",
			cfg =>
				new RelayOnly(cfg.id, {
					input: "iq",
					output: "text",
					integrationPattern: "pure_consumer",
				}),
			{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
		)
		manager.createDecoder({
			id: "plain",
			type: "relay-only",
			enabled: true,
			options: {},
			useChannelizer: true,
		})
		await manager.startDecoder("plain")
		expect(provider.calls).toEqual([{ decoderId: "plain", args: 4 }])
	})

	it("scanner-owned probe decoders keep the relay in direct mode", async () => {
		await manager.createEphemeralDecoder(
			{
				id: "probe",
				type: "direct-test",
				enabled: true,
				options: {},
				useChannelizer: true,
			},
			{ owner: "scanner", jobId: "j1" },
		)
		const probe = decoders.get("probe")!
		expect(provider.calls).toEqual([{ decoderId: "probe", args: 4 }])
		expect(probe.relayed).toEqual([provider.streams.get("probe-g1")])
		expect(probe.spawnedWith).toEqual([])
		await manager.removeDecoder("probe")
	})
})

describe("a channel that goes away (D2)", () => {
	it("the child exits on EOF before the caps worker: one restart, no crash accounting", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.endGeneration("rtl", ["dec-g1"])
		decoder.exit(0)
		expect(status()).toMatchObject({ running: false })
		expect(restarting).toEqual([])
		await settle()
		expect(decoder.starts).toBe(2)
		expect(provider.calls.map(call => call.decoderId)).toEqual(["dec", "dec"])
		expect(status()).toMatchObject({ running: true, restartCount: 0 })
		expect(status().lastError ?? null).toBeNull()
		expect(restarting).toEqual([])
		expect(
			warnings("Decoder input ended with its channel; restarting it"),
		).toHaveLength(1)
		await settle(5000)
		expect(decoder.starts).toBe(2)
	})

	it("the adapter's stop() runs once on the exited decoder before its restart; a throw is logged and the start goes on", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.endGeneration("rtl", ["dec-g1"])
		decoder.exit(0)
		decoder.failStop = true
		await settle()
		decoder.failStop = false
		expect(decoder.stops).toBe(1)
		expect(decoder.starts).toBe(2)
		expect(status()).toMatchObject({ running: true, restartCount: 0 })
		expect(status().lastError ?? null).toBeNull()
		expect(
			warnings("Decoder cleanup after its channel ended failed; continuing"),
		).toHaveLength(1)
		expect(restarting).toEqual([])
	})

	it("the caps worker reaches it while it still runs: the same single restart", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.endGeneration("rtl", ["dec-g1"])
		await settle()
		expect(decoder.starts).toBe(2)
		expect(decoder.stops).toBe(1)
		expect(status()).toMatchObject({ running: true, restartCount: 0 })
		expect(status().lastError ?? null).toBeNull()
		expect(restarting).toEqual([])
		await settle(5000)
		expect(decoder.starts).toBe(2)
	})

	it("a centre move that also adapts the pipeline restarts it once", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		sources.setCenter("rtl", CENTER + 100_000)
		provider.endGeneration("rtl", ["dec-g1"])
		decoder.exit(0)
		await settle()
		await settle(5000)
		expect(decoder.starts).toBe(2)
		expect(restarting).toEqual([])
		expect(status()).toMatchObject({ running: true, restartCount: 0 })
	})

	it("keeps the failure accounting of earlier crashes across the expected restart", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.clientGone("rtl", "dec-g1")
		decoder.exit(1)
		await settle(20)
		expect(status().restartCount).toBe(1)
		// A client-gone keeps the generation: the restarted run holds dec-g1 again.
		provider.endGeneration("rtl", ["dec-g1"])
		decoder.exit(0)
		await settle()
		expect(status()).toMatchObject({ running: true, restartCount: 1 })
		expect(status().lastError).toMatchObject({ kind: "exit" })
	})

	it("with the source gone (no caps), the exit holds as a channel suspension and resumes when caps return", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		sources.caps.delete("rtl")
		provider.endGeneration("rtl", ["dec-g1"], "source-lost")
		decoder.exit(0)
		expect(status()).toMatchObject({
			running: false,
			suspended: true,
		})
		expect(status().lastError ?? null).toBeNull()
		expect(restarting).toEqual([])
		await settle(CHANNEL_FATE_MS + DEBOUNCE)
		expect(decoder.starts).toBe(1)
		sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
		sources.emit("caps-changed", "rtl", sources.caps.get("rtl"))
		await settle()
		expect(decoder.starts).toBe(2)
		expect(status()).toMatchObject({ running: true, suspended: false })
		expect(restarting).toEqual([])
	})

	it("a provider swap ends the channel like an invalidation", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		const next = new DirectProvider(order)
		manager.setChannelizer(next)
		expect(provider.released).toEqual(["dec-g1"])
		decoder.exit(0)
		await settle()
		expect(decoder.starts).toBe(2)
		expect(next.calls).toHaveLength(1)
		expect(restarting).toEqual([])
		expect(status().lastError ?? null).toBeNull()
		await manager.destroy()
		for (const socket of next.sockets.values())
			expect(socket.destroyed).toBe(true)
	})
})

describe("an exit with no terminal event (exit-pending)", () => {
	it("waits for the channel's fate: nothing at 1 999 ms, the crash path at 2 000 ms", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		await settle(CHANNEL_FATE_MS - 1)
		expect(restarting).toEqual([])
		expect(provider.released).toEqual([])
		expect(status().lastError ?? null).toBeNull()
		await settle(1)
		expect(restarting).toEqual(["dec"])
		expect(provider.released).toEqual(["dec-g1"])
		expect(status().lastError).toMatchObject({ kind: "exit" })
		await settle(20)
		expect(decoder.starts).toBe(2)
	})

	it("closed client-gone is the decoder's own end: the crash path at once", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		provider.clientGone("rtl", "dec-g1")
		expect(restarting).toEqual(["dec"])
		expect(status().lastError).toMatchObject({ kind: "exit" })
		await settle(20)
		expect(decoder.starts).toBe(2)
		expect(status().restartCount).toBe(1)
		// The fallback never fires a second time.
		await settle(CHANNEL_FATE_MS)
		expect(restarting).toEqual(["dec"])
	})

	it("any other terminal event is the channel's end: one restart, no crash", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(0)
		provider.endGeneration("rtl", ["dec-g1"])
		await settle()
		expect(decoder.starts).toBe(2)
		expect(restarting).toEqual([])
		expect(status()).toMatchObject({ running: true, restartCount: 0 })
		await settle(CHANNEL_FATE_MS)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(2)
	})

	it("a terminal event after the fallback fired is ignored", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		await settle(CHANNEL_FATE_MS)
		expect(restarting).toEqual(["dec"])
		provider.clientGone("rtl", "dec-g1")
		provider.endGeneration("rtl", ["dec-g1"])
		await settle(20)
		expect(restarting).toEqual(["dec"])
		expect(decoder.starts).toBe(2)
	})

	it("a stop cancels the timer: no restart, the channel is released", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		await manager.stopDecoder("dec")
		expect(provider.released).toEqual(["dec-g1"])
		await settle(CHANNEL_FATE_MS * 2)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({ running: false })
	})

	it("removal and destroy cancel it too", async () => {
		const a = create("a")
		const b = create("b")
		await manager.startDecoder("a")
		await manager.startDecoder("b")
		a.exit(1)
		b.exit(1)
		await manager.removeDecoder("a")
		await manager.destroy()
		await settle(CHANNEL_FATE_MS * 2)
		expect(restarting).toEqual([])
		expect(provider.released.sort()).toEqual(["a-g1", "b-g1"])
	})

	it("a rate suspension meanwhile (a real re-evaluation) ends the wait: recorded, released, never restarted", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		sources.setRate("rtl", 24_000)
		await settle()
		expect(status()).toMatchObject({ running: false, suspended: true })
		expect(provider.released).toEqual(["dec-g1"])
		expect(status().lastError).toMatchObject({ kind: "exit" })
		expect(failures()).toBe(1)
		// The fate timer went with it: nothing fires at the bound or after it.
		await settle(CHANNEL_FATE_MS * 2)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
		expect(provider.released).toEqual(["dec-g1"])
	})

	it("a stop during the wait records the crash the relay path would have, with no restart", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		await manager.stopDecoder("dec")
		expect(status().lastError).toMatchObject({ kind: "exit" })
		expect(failures()).toBe(1)
		expect(status().restartCount).toBe(0)
		expect(status().nextRestartAt).toBeUndefined()
		await settle(CHANNEL_FATE_MS * 2)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
	})

	it("removal and destroy during the wait record it too", async () => {
		create("a")
		create("b")
		await manager.startDecoder("a")
		await manager.startDecoder("b")
		const internal = manager as unknown as {
			decoders: Map<string, { consecutiveFailures: number; lastError: unknown }>
		}
		const a = internal.decoders.get("a")!
		const b = internal.decoders.get("b")!
		decoders.get("a")!.exit(1)
		decoders.get("b")!.exit(1)
		await manager.removeDecoder("a")
		await manager.destroy()
		expect(a).toMatchObject({
			consecutiveFailures: 1,
			lastError: { kind: "exit" },
		})
		expect(b).toMatchObject({
			consecutiveFailures: 1,
			lastError: { kind: "exit" },
		})
		expect(restarting).toEqual([])
	})

	it("the guard fails, then client-gone: dropped, no restart, the probable crash recorded", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		internalState().rateGeneration++
		provider.clientGone("rtl", "dec-g1")
		expect(status().lastError).toMatchObject({ kind: "exit" })
		expect(failures()).toBe(1)
		await settle(CHANNEL_FATE_MS * 2)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
	})

	it("the guard fails, then the fate timer: dropped the same way, the probable crash recorded", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(1)
		internalState().rateGeneration++
		await settle(CHANNEL_FATE_MS)
		expect(status().lastError).toMatchObject({ kind: "exit" })
		expect(failures()).toBe(1)
		expect(provider.released).toEqual(["dec-g1"])
		await settle(CHANNEL_FATE_MS * 2)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
	})

	it("the guard fails, then the channel's own end: dropped, nothing recorded (the exit was its EOF)", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(0)
		internalState().rateGeneration++
		provider.endGeneration("rtl", ["dec-g1"])
		expect(status().lastError ?? null).toBeNull()
		expect(failures()).toBe(0)
		await settle(CHANNEL_FATE_MS * 2)
		expect(restarting).toEqual([])
	})

	it("a stop after the channel ended (the exit was its EOF) records nothing", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		decoder.exit(0)
		provider.endGeneration("rtl", ["dec-g1"])
		await manager.stopDecoder("dec")
		expect(status().lastError ?? null).toBeNull()
		expect(failures()).toBe(0)
		await settle(CHANNEL_FATE_MS + DEBOUNCE)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
	})

	it("a stop after the channel ended under a running decoder records nothing either", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.endGeneration("rtl", ["dec-g1"])
		decoder.exit(0)
		await manager.stopDecoder("dec")
		expect(status().lastError ?? null).toBeNull()
		expect(failures()).toBe(0)
		await settle(CHANNEL_FATE_MS + DEBOUNCE)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
	})
})

describe("requested stops (D5)", () => {
	function spyEvaluations() {
		return vi.spyOn(
			manager as unknown as { enqueueSourceEvaluation: () => void },
			"enqueueSourceEvaluation",
		)
	}

	it("a stop releases the channel before the child is signalled; a late client-gone finds nothing", async () => {
		create()
		await manager.startDecoder("dec")
		const evaluations = spyEvaluations()
		const invalidations = vi.fn()
		provider.on("channel-invalidated", invalidations)
		await manager.stopDecoder("dec")
		expect(order).toEqual(["release:dec-g1", "signal:dec"])
		provider.clientGone("rtl", "dec-g1")
		await settle(CHANNEL_FATE_MS + DEBOUNCE)
		expect(evaluations).not.toHaveBeenCalled()
		expect(restarting).toEqual([])
		expect(status()).toMatchObject({ running: false })
		expect(warnings("Channel died; invalidating it")).toEqual([])
		// Only the late client-gone this test emitted itself.
		expect(invalidations).toHaveBeenCalledTimes(1)
	})

	it("an operator restart releases first, then signals, then starts once", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		await manager.restartDecoder("dec")
		expect(order).toEqual(["release:dec-g1", "signal:dec"])
		expect(decoder.starts).toBe(2)
		expect(restarting).toEqual([])
		await settle(CHANNEL_FATE_MS + DEBOUNCE)
		expect(decoder.starts).toBe(2)
	})

	it("a removal releases first", async () => {
		create()
		await manager.startDecoder("dec")
		await manager.removeDecoder("dec")
		expect(order).toEqual(["release:dec-g1", "signal:dec"])
	})

	it("a rate suspension releases first and is no crash", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		sources.setRate("rtl", 24_000)
		await settle()
		expect(order).toEqual(["release:dec-g1", "signal:dec"])
		expect(status()).toMatchObject({ running: false, suspended: true })
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
	})
})

describe("start failures", () => {
	it("a spawn that fails after the hand-over releases the channel; a later client-gone is not a second cause", async () => {
		const decoder = create()
		decoder.failStart = true
		await expect(manager.startDecoder("dec")).rejects.toThrow("spawn failed")
		expect(provider.released).toEqual(["dec-g1"])
		expect(provider.sockets.get("dec-g1")?.destroyed).toBe(true)
		expect(status().lastError).toMatchObject({ kind: "error" })
		provider.clientGone("rtl", "dec-g1")
		await settle(CHANNEL_FATE_MS + DEBOUNCE)
		expect(restarting).toEqual([])
		expect(decoder.starts).toBe(1)
	})

	it("the channel ends while the adapter awaits before its spawn: no spawn, the channel-loss hold, nothing counted", async () => {
		const decoder = create()
		const gate = deferred()
		decoder.beforeSpawn = gate
		const starting = manager.startDecoder("dec")
		await vi.waitFor(() => expect(provider.sockets.size).toBe(1))
		await settle(0)
		provider.endGeneration("rtl", ["dec-g1"])
		gate.resolve()
		await starting
		expect(decoder.refused).toBe(1)
		expect(decoder.starts).toBe(0)
		expect(decoder.spawnedWith).toEqual([])
		expect(status()).toMatchObject({ running: false, suspended: true })
		expect(internalState().suspension?.reasonCode).toBe(
			"channelizer-unavailable",
		)
		expect(status().lastError ?? null).toBeNull()
		expect(failures()).toBe(0)
		expect(status().restartCount).toBe(0)
		expect(restarting).toEqual([])
		expect(provider.sockets.get("dec-g1")?.destroyed).toBe(true)
		// The evaluation the channel's end queued starts it again on a fresh channel, fed from its first byte.
		await settle()
		expect(decoder.starts).toBe(1)
		expect(decoder.spawnedWith).toEqual([provider.sockets.get("dec-g2")])
		expect(status()).toMatchObject({ running: true, suspended: false })
		expect(failures()).toBe(0)
	})

	it("the socket closes while the adapter awaits before its spawn: no spawn, the hold, the channel released once", async () => {
		const decoder = create()
		const gate = deferred()
		decoder.beforeSpawn = gate
		const starting = manager.startDecoder("dec")
		await vi.waitFor(() => expect(provider.sockets.size).toBe(1))
		await settle(0)
		provider.sockets.get("dec-g1")!.destroy()
		gate.resolve()
		await starting
		expect(decoder.refused).toBe(1)
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({ running: false, suspended: true })
		expect(internalState().suspension?.reasonCode).toBe(
			"channelizer-unavailable",
		)
		expect(status().lastError ?? null).toBeNull()
		expect(failures()).toBe(0)
		expect(restarting).toEqual([])
		expect(provider.released).toEqual(["dec-g1"])
	})

	it("relay mode spawns after the same await as before: the grant check is direct input only", async () => {
		await manager.destroy()
		setup({ channelInput: "relay" })
		const decoder = create()
		const gate = deferred()
		decoder.beforeSpawn = gate
		const starting = manager.startDecoder("dec")
		await vi.waitFor(() => expect(provider.streams.size).toBe(1))
		await settle(0)
		gate.resolve()
		await starting
		expect(decoder.refused).toBe(0)
		expect(decoder.starts).toBe(1)
		expect(status()).toMatchObject({ running: true })
	})

	it("a socket closed between wiring and the spawn is a channel lost before start: no spawn", async () => {
		const decoder = create()
		provider.closeBeforeGrant = true
		await manager.startDecoder("dec")
		expect(decoder.starts).toBe(0)
		expect(status()).toMatchObject({
			running: false,
			suspended: true,
		})
		expect(status().lastError ?? null).toBeNull()
		expect(provider.released).toEqual(["dec-g1"])
	})
})

describe("bytesIn from channel-stats", () => {
	it("is mapped by generation and channel id, in bytes of the format, and never goes backwards", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.stats({
			channelId: "dec-g1",
			outputSamples: 480,
			bytesPerSample: 8,
		})
		expect(status().stats.bytesIn).toBe(3840)
		provider.stats({ channelId: "dec-g1", outputSamples: 100 })
		expect(status().stats.bytesIn).toBe(3840)
		provider.stats({ channelId: "dec-g1", outputSamples: 500, generation: 7 })
		provider.stats({ channelId: "other-g1", outputSamples: 500 })
		provider.stats({
			channelId: "dec-g1",
			outputSamples: 500,
			sourceId: "elsewhere",
		})
		expect(decoder.bytes).toBe(3840)
		provider.stats({
			channelId: "dec-g1",
			outputSamples: 1480,
			bytesPerSample: 2,
		})
		expect(status().stats.bytesIn).toBe(3840 + 2000)
	})

	it("still counts a worker whose id changed: the channel keeps its own", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		const internal = manager as unknown as {
			decoders: Map<string, { config: DecoderConfig }>
		}
		const state = internal.decoders.get("dec")!
		internal.decoders.delete("dec")
		state.config = { ...state.config, id: "moved" }
		internal.decoders.set("moved", state)
		provider.stats({ channelId: "dec-g1", outputSamples: 10 })
		expect(decoder.bytes).toBe(80)
	})

	it("credits what was queued for the decoder: an overflow of 480 produced and 470 dropped credits 10 samples", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.stats({
			channelId: "dec-g1",
			outputSamples: 480,
			droppedSamples: 470,
			bytesPerSample: 8,
		})
		expect(decoder.bytes).toBe(80)
		expect(status().stats.bytesIn).toBe(80)
		// Only drops grew: nothing more. Then 40 more queued.
		provider.stats({
			channelId: "dec-g1",
			outputSamples: 960,
			droppedSamples: 950,
		})
		expect(decoder.bytes).toBe(80)
		provider.stats({
			channelId: "dec-g1",
			outputSamples: 1000,
			droppedSamples: 950,
		})
		expect(decoder.bytes).toBe(400)
	})

	it("every grant counts from zero, also one that reuses the id in the same generation", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		provider.stats({ channelId: "dec-g1", outputSamples: 1000 })
		expect(decoder.bytes).toBe(8000)
		// The decoder dies by itself: client-gone keeps the generation, and the restart is granted dec-g1 again.
		decoder.exit(1)
		provider.clientGone("rtl", "dec-g1")
		await settle(20)
		expect(decoder.starts).toBe(2)
		expect(provider.calls).toHaveLength(2)
		// The new channel's counter starts at zero in the process; a smaller count than the old mark still counts.
		provider.stats({ channelId: "dec-g1", outputSamples: 10 })
		expect(decoder.bytes).toBe(8000 + 80)
	})

	it("a run shorter than one stats period reports 0", async () => {
		const decoder = create()
		await manager.startDecoder("dec")
		await manager.stopDecoder("dec")
		provider.stats({ channelId: "dec-g1", outputSamples: 10 })
		expect(decoder.bytes).toBe(0)
		expect(status().stats.bytesIn).toBe(0)
	})

	it("relay mode subscribes to no stats", async () => {
		await manager.destroy()
		setup({ channelInput: "relay" })
		create()
		await manager.startDecoder("dec")
		expect(provider.listenerCount("channel-stats")).toBe(0)
	})
})
