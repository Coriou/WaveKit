/**
 * Direct channel input: the lifecycle table (src/decoders/direct-channel-input.ts), one named test per row, and the
 * byte count taken from the channelizer's `stats` lines. Pure: the clock is a number passed in.
 */
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
	CHANNEL_FATE_MS,
	channelStatsDelta,
	directInputOf,
	directStep,
	type DirectEvent,
	type DirectExitedEvent,
	type DirectPhase,
	type DirectTerminalEvent,
} from "../../../src/decoders/direct-channel-input.js"
import {
	channelInputModeFrom,
	DEFAULT_CHANNEL_INPUT_MODE,
	processChannelInputMode,
	resetProcessChannelInputModeForTests,
} from "../../../src/decoders/channel-input-mode.js"
import type { Logger } from "../../../src/utils/logger.js"

const terminal = (
	cause: DirectTerminalEvent["cause"],
	over: Partial<DirectTerminalEvent> = {},
): DirectEvent => ({
	type: "terminal",
	cause,
	capsKnown: true,
	current: true,
	...over,
})
const exited = (over: Partial<DirectExitedEvent> = {}): DirectEvent => ({
	type: "exited",
	realExit: true,
	intentional: false,
	suspended: false,
	holdsChannel: true,
	capsKnown: true,
	nowMs: 1000,
	...over,
})
const at = (phase: DirectPhase, exitAtMs?: number) =>
	exitAtMs === undefined ? { phase } : { phase, exitAtMs }

describe("direct channel input lifecycle table", () => {
	it("unwired, channel granted in direct mode to an eligible decoder: wired, keep the socket", () => {
		expect(
			directStep(at("unwired"), { type: "granted", direct: true }),
		).toEqual({ next: "wired", action: "keep-socket" })
	})

	it("unwired, channel granted otherwise: today's relay path", () => {
		expect(
			directStep(at("unwired"), { type: "granted", direct: false }),
		).toEqual({ next: "unwired", action: "relay" })
	})

	it("wired, in-place retune: unchanged", () => {
		expect(directStep(at("wired"), { type: "retune", live: true })).toEqual({
			next: "wired",
			action: "retune",
		})
	})

	it("wired, decoder start with the socket open: running, spawn with the socket as fd 0", () => {
		expect(
			directStep(at("wired"), {
				type: "start",
				acquired: true,
				socketDestroyed: false,
			}),
		).toEqual({ next: "running", action: "spawn" })
		// At the real spawn the manager has already moved it to running.
		expect(
			directStep(at("running"), {
				type: "start",
				acquired: true,
				socketDestroyed: false,
			}),
		).toEqual({ next: "running", action: "spawn" })
	})

	it("a start granted a direct channel whose socket is missing or closed, before the start or at the spawn: unwired, channel lost before start, no spawn", () => {
		// The grant outlives whatever ended the channel since: a terminal event (unwired or ending) or a close.
		for (const phase of ["wired", "running", "ending", "unwired"] as const)
			expect(
				directStep(at(phase), {
					type: "start",
					acquired: true,
					socketDestroyed: true,
				}),
			).toEqual({ next: "unwired", action: "lost-before-start" })
	})

	it("a start with no direct grant is today's", () => {
		for (const socketDestroyed of [false, true])
			expect(
				directStep(at("unwired"), {
					type: "start",
					acquired: false,
					socketDestroyed,
				}),
			).toEqual({ next: "unwired", action: "today" })
	})

	it("wired, terminal event: unwired, today's handling of a channel lost before start", () => {
		for (const cause of ["client-gone", "other"] as const)
			expect(directStep(at("wired"), terminal(cause))).toEqual({
				next: "unwired",
				action: "today",
			})
	})

	it("wired, start abandoned (stop, removal, placement change): unwired, destroy the socket and release", () => {
		expect(directStep(at("wired"), { type: "abandoned" })).toEqual({
			next: "unwired",
			action: "release",
		})
		expect(directStep(at("wired"), { type: "stop-requested" })).toEqual({
			next: "unwired",
			action: "release",
		})
	})

	it("wired or running, spawn failed: unwired, release the channel (today's spawn-error path follows)", () => {
		for (const phase of ["wired", "running"] as const)
			expect(directStep(at(phase), { type: "spawn-failed" })).toEqual({
				next: "unwired",
				action: "release",
			})
		expect(directStep(at("unwired"), { type: "spawn-failed" }).action).toBe(
			"today",
		)
	})

	it("running, in-place retune of a live channel: running, send retune as today", () => {
		expect(directStep(at("running"), { type: "retune", live: true })).toEqual({
			next: "running",
			action: "retune",
		})
		expect(
			directStep(at("running"), { type: "retune", live: false }).action,
		).toBe("today")
	})

	it("running, terminal event other than client-gone: ending, inputEnded and channelStale in that turn", () => {
		expect(directStep(at("running"), terminal("other"))).toEqual({
			next: "ending",
			action: "end-input",
		})
	})

	it("running, client-gone: no expected exit (the decoder's own end), today's claim", () => {
		expect(directStep(at("running"), terminal("client-gone"))).toEqual({
			next: "running",
			action: "today",
		})
	})

	it("ending, caps worker reaches it while it runs: today's channel-stale restart", () => {
		expect(directStep(at("ending"), { type: "caps-worker" })).toEqual({
			next: "unwired",
			action: "channel-restart",
		})
	})

	it("ending, the process exits first with caps known: expected exit, restarted once by the caps worker", () => {
		expect(directStep(at("ending"), exited({ holdsChannel: false }))).toEqual({
			next: "restart-due",
			action: "expected-restart",
		})
		expect(directStep(at("restart-due"), { type: "caps-worker" })).toEqual({
			next: "unwired",
			action: "channel-restart",
		})
	})

	it("ending, the process exits first with no caps (source lost): held as a channel suspension, never the crash path", () => {
		expect(
			directStep(
				at("ending"),
				exited({ holdsChannel: false, capsKnown: false }),
			),
		).toEqual({ next: "suspended", action: "expected-hold" })
	})

	it("running or ending, stop, suspend, restart or removal requested: release the channel, then signal", () => {
		for (const phase of ["running", "ending"] as const)
			expect(directStep(at(phase), { type: "stop-requested" })).toEqual({
				next: "stopping",
				action: "release-then-signal",
			})
	})

	it("running, exit with no terminal event, not stopped, not suspended: exit-pending, defer the classification", () => {
		expect(directStep(at("running"), exited({ nowMs: 4321 }))).toEqual({
			next: "exit-pending",
			action: "defer",
			exitAtMs: 4321,
		})
	})

	it("running, an intentional, suspended or not real exit is today's", () => {
		for (const over of [
			{ intentional: true },
			{ suspended: true },
			{ realExit: false },
		])
			expect(directStep(at("running"), exited(over)).action).toBe("today")
		expect(directStep(at("stopping"), exited()).action).toBe("today")
		expect(
			directStep(at("stopping"), exited({ channelEnded: false })).action,
		).toBe("today")
		// A terminal event already took the channel (client-gone): the decoder ended by itself.
		expect(directStep(at("running"), exited({ holdsChannel: false }))).toEqual({
			next: "unwired",
			action: "today",
		})
	})

	it("stopping, the exit of a stop that followed the channel's end: no lastError, no accounting, no restart of its own", () => {
		// Both orders leave the same record: the caps worker's stop came first, the channel had ended under the run.
		for (const over of [
			{},
			{ intentional: true },
			{ holdsChannel: false },
			{ capsKnown: false },
		])
			expect(
				directStep(at("stopping"), exited({ channelEnded: true, ...over })),
			).toEqual({ next: "unwired", action: "expected-stop" })
		// A failed restart reports no code or signal: today's.
		expect(
			directStep(
				at("stopping"),
				exited({ channelEnded: true, realExit: false }),
			).action,
		).toBe("today")
	})

	it("exit-pending, closed client-gone with the guard holding: the crash path", () => {
		expect(directStep(at("exit-pending", 0), terminal("client-gone"))).toEqual({
			next: "unwired",
			action: "crash",
		})
	})

	it("exit-pending, any other terminal event with the guard holding: as ending, exits first", () => {
		expect(directStep(at("exit-pending", 0), terminal("other"))).toEqual({
			next: "restart-due",
			action: "expected-restart",
		})
		expect(
			directStep(
				at("exit-pending", 0),
				terminal("other", { capsKnown: false }),
			),
		).toEqual({ next: "suspended", action: "expected-hold" })
	})

	it("exit-pending, the fate is not due at 1 999 ms and is the crash path at 2 000 ms", () => {
		expect(CHANNEL_FATE_MS).toBe(2000)
		const facts = at("exit-pending", 10_000)
		expect(
			directStep(facts, { type: "fate-due", nowMs: 11_999, current: true }),
		).toEqual({ next: "exit-pending", action: "wait", exitAtMs: 10_000 })
		expect(
			directStep(facts, { type: "fate-due", nowMs: 12_000, current: true }),
		).toEqual({ next: "unwired", action: "crash" })
		expect(
			directStep(facts, { type: "fate-due", nowMs: 12_001, current: true }),
		).toEqual({ next: "unwired", action: "crash" })
	})

	it("exit-pending, stop, remove, suspend or destroy: cancel the timer, no restart, release, record the probable crash", () => {
		expect(
			directStep(at("exit-pending", 0), { type: "stop-requested" }),
		).toEqual({ next: "unwired", action: "cancel", record: true })
	})

	it("exit-pending, the guard fails (replaced or re-evaluated meanwhile): drop the deferred tail, recorded unless the channel's end was seen", () => {
		// Both triggers decide the same way: the crash is recorded unless a terminal event other than client-gone
		// shows the exit was the channel's EOF.
		expect(
			directStep(
				at("exit-pending", 0),
				terminal("client-gone", { current: false }),
			),
		).toEqual({ next: "unwired", action: "drop", record: true })
		expect(
			directStep(at("exit-pending", 0), terminal("other", { current: false })),
		).toEqual({ next: "unwired", action: "drop", record: false })
		expect(
			directStep(at("exit-pending", 0), {
				type: "fate-due",
				nowMs: 5000,
				current: false,
			}),
		).toEqual({ next: "unwired", action: "drop", record: true })
	})

	it("after the fallback fired, a terminal event is ignored", () => {
		for (const cause of ["client-gone", "other"] as const)
			expect(directStep(at("unwired"), terminal(cause))).toEqual({
				next: "unwired",
				action: "ignore",
			})
		expect(
			directStep(at("unwired"), {
				type: "fate-due",
				nowMs: 9999,
				current: true,
			}).action,
		).toBe("ignore")
	})

	it("the caps worker leaves every other phase to today's rules", () => {
		for (const phase of [
			"unwired",
			"wired",
			"running",
			"exit-pending",
			"stopping",
			"suspended",
		] as const)
			expect(directStep(at(phase), { type: "caps-worker" }).action).toBe(
				"today",
			)
	})
})

describe("bytesIn from channel-stats", () => {
	it("adds the positive delta in bytes of the channel's format", () => {
		expect(channelStatsDelta(0, 48_000, 0, 8)).toEqual({
			bytes: 384_000,
			countedSamples: 48_000,
		})
		expect(channelStatsDelta(48_000, 96_000, 0, 2)).toEqual({
			bytes: 96_000,
			countedSamples: 96_000,
		})
	})

	it("counts what was queued for the decoder: produced less dropped (an overflow of 480 produced, 470 dropped credits 10)", () => {
		expect(channelStatsDelta(0, 480, 470, 8)).toEqual({
			bytes: 80,
			countedSamples: 10,
		})
		// Later lines: both counters cumulative; a line where only drops grew adds nothing.
		expect(channelStatsDelta(10, 960, 950, 8).bytes).toBe(0)
		expect(channelStatsDelta(10, 1000, 950, 8)).toEqual({
			bytes: 320,
			countedSamples: 50,
		})
	})

	it("never goes backwards and refuses counters that are not whole samples", () => {
		expect(channelStatsDelta(100, 40, 0, 8)).toEqual({
			bytes: 0,
			countedSamples: 100,
		})
		expect(channelStatsDelta(100, 100, 0, 8).bytes).toBe(0)
		for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
			expect(channelStatsDelta(0, bad, 0, 8).bytes).toBe(0)
			expect(channelStatsDelta(0, 10, bad, 8).bytes).toBe(0)
		}
		expect(channelStatsDelta(0, 10, 0, 0).bytes).toBe(0)
		// More dropped than produced is no count at all.
		expect(channelStatsDelta(0, 10, 11, 8).bytes).toBe(0)
	})

	it("a run shorter than one stats period reports 0", () => {
		// No `stats` line listed the channel before it closed: nothing was counted.
		expect(channelStatsDelta(0, 0, 0, 8)).toEqual({
			bytes: 0,
			countedSamples: 0,
		})
	})

	// Feature: direct channel input, Property 1: bytesIn is monotone and equals the largest queued count seen
	it("the counted total is the largest queued count seen times the sample size, whatever the order", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc
						.tuple(
							fc.nat({ max: 1_000_000_000 }),
							fc.nat({ max: 1_000_000_000 }),
						)
						.map(([queued, dropped]) => ({
							output: queued + dropped,
							dropped,
						})),
					{ maxLength: 50 },
				),
				fc.constantFrom(2, 8),
				(lines, size) => {
					let counted = 0
					let total = 0
					for (const line of lines) {
						const step = channelStatsDelta(
							counted,
							line.output,
							line.dropped,
							size,
						)
						expect(step.bytes).toBeGreaterThanOrEqual(0)
						expect(step.countedSamples).toBeGreaterThanOrEqual(counted)
						counted = step.countedSamples
						total += step.bytes
					}
					expect(total).toBe(
						Math.max(0, ...lines.map(line => line.output - line.dropped)) *
							size,
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("direct input port and mode selection", () => {
	it("finds the port structurally", () => {
		expect(directInputOf({})).toBeNull()
		const port = { attachDirectInput: () => {}, addInputBytes: () => {} }
		expect(directInputOf(port)).toBe(port)
	})

	it("reads direct unless the value is exactly relay: unset, empty and unknown values are the default", () => {
		expect(DEFAULT_CHANNEL_INPUT_MODE).toBe("direct")
		expect(channelInputModeFrom(undefined)).toEqual({
			mode: "direct",
			known: true,
		})
		expect(channelInputModeFrom("")).toEqual({ mode: "direct", known: true })
		expect(channelInputModeFrom("relay")).toEqual({
			mode: "relay",
			known: true,
		})
		expect(channelInputModeFrom("direct")).toEqual({
			mode: "direct",
			known: true,
		})
		for (const other of ["DIRECT", "RELAY", "relay ", "yes", "1"])
			expect(channelInputModeFrom(other)).toEqual({
				mode: "direct",
				known: false,
			})
	})

	it("an unset environment selects direct for the process; relay stays selectable", () => {
		const log = { info: vi.fn(), warn: vi.fn() } as unknown as Logger
		resetProcessChannelInputModeForTests()
		try {
			expect(processChannelInputMode(log, {})).toBe("direct")
			resetProcessChannelInputModeForTests()
			expect(
				processChannelInputMode(log, { WAVEKIT_CHANNEL_INPUT: "relay" }),
			).toBe("relay")
		} finally {
			resetProcessChannelInputModeForTests()
		}
	})

	it("reads the environment once per process, logs the mode once and never echoes an unknown value", () => {
		const info = vi.fn()
		const warn = vi.fn()
		const log = { info, warn } as unknown as Logger
		resetProcessChannelInputModeForTests()
		try {
			const env = { WAVEKIT_CHANNEL_INPUT: "sideways-value" }
			expect(processChannelInputMode(log, env)).toBe("direct")
			expect(
				processChannelInputMode(log, { WAVEKIT_CHANNEL_INPUT: "relay" }),
			).toBe("direct")
			expect(info).toHaveBeenCalledTimes(1)
			expect(info.mock.calls[0]?.[0]).toEqual({ channelInput: "direct" })
			expect(warn).toHaveBeenCalledTimes(1)
			expect(JSON.stringify(warn.mock.calls)).not.toContain("sideways-value")
			expect(warn.mock.calls[0]?.[0]).toMatchObject({
				accepted: ["relay", "direct"],
				default: "direct",
			})
			resetProcessChannelInputModeForTests()
			expect(
				processChannelInputMode(log, { WAVEKIT_CHANNEL_INPUT: "relay" }),
			).toBe("relay")
			expect(warn).toHaveBeenCalledTimes(1)
		} finally {
			resetProcessChannelInputModeForTests()
		}
	})
})
