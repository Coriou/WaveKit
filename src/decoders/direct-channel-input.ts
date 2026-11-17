/**
 * Direct channel input: the decisions for a decoder whose stdin is its channel's socket. Pure: no I/O, no timers;
 * the decoder manager supplies the facts and the clock and carries out the action.
 *
 * With direct input Node holds no copy of the socket once the decoder runs, so a decoder exit no longer says by itself
 * why the input ended. The channelizer's terminal event for that channel does: `closed {client-gone}` means the
 * decoder went away on its own (the next write failed), anything else (a centre move, the end of a generation, a
 * release) means the channel went away and the decoder only saw EOF. Which one came is decided by events, with one
 * bound for a channelizer that is alive but has nothing to write: CHANNEL_FATE_MS.
 */
import type { DirectChannelSocket } from "../core/channelizer/types.js"

/**
 * How long an exit with no terminal event waits for one. While the channelizer runs, `client-gone` or the end of the
 * generation follows a decoder's exit within milliseconds (the next write fails); only a source that is paused or lost
 * leaves nothing to write, and then the exit is the decoder's own, so the crash path is the right answer at the bound.
 */
export const CHANNEL_FATE_MS = 2000

export type DirectPhase =
	/** No direct channel (none, or the relay path). */
	| "unwired"
	/** The paused socket is held; the decoder has not spawned. */
	| "wired"
	/** The child holds the socket as stdin; Node destroyed its copy. */
	| "running"
	/** The channel's terminal event (not `client-gone`) came while it ran: the child will see EOF. */
	| "ending"
	/** It exited with no terminal event seen: the classification waits for one, at most CHANNEL_FATE_MS. */
	| "exit-pending"
	/** Node released the channel before signalling the child: an intentional stop. */
	| "stopping"
	/** It exited after its channel ended: the caps worker restarts it, once. */
	| "restart-due"
	/** It exited after its channel ended with no caps for its source: held as a channel suspension. */
	| "suspended"

export interface DirectFacts {
	readonly phase: DirectPhase
	/** exit-pending: the clock value of the exit. */
	readonly exitAtMs?: number
}

/**
 * `channel-invalidated` for its channel, its `closed`, or the end of its generation. `current`: exit-pending's guard
 * (same decoder state, `rateGeneration` and `stopRevision` as at the exit).
 */
export interface DirectTerminalEvent {
	readonly type: "terminal"
	readonly cause: "client-gone" | "other"
	readonly capsKnown: boolean
	readonly current: boolean
}

/**
 * The process exited. `realExit`: a code or signal (a failed restart reports neither); `intentional`: stopped on
 * purpose or no longer the current run; `holdsChannel`: the decoder still holds its channel (no terminal event).
 */
export interface DirectExitedEvent {
	readonly type: "exited"
	readonly realExit: boolean
	readonly intentional: boolean
	readonly suspended: boolean
	readonly holdsChannel: boolean
	readonly capsKnown: boolean
	readonly nowMs: number
}

/** The exit-pending timer fired. */
export interface DirectFateDueEvent {
	readonly type: "fate-due"
	readonly nowMs: number
	readonly current: boolean
}

export type DirectEvent =
	/** A channel was granted; `direct`: direct mode, an eligible decoder and a grant that carries the socket. */
	| { readonly type: "granted"; readonly direct: boolean }
	/** An in-place retune; `live`: the channel is in its generation's table and not invalidated. */
	| { readonly type: "retune"; readonly live: boolean }
	| { readonly type: "start"; readonly socketDestroyed: boolean }
	/** `spawn` threw, `proc.pid` was undefined, or `error` came before `spawn`. */
	| { readonly type: "spawn-failed" }
	/** A start abandoned after wiring (stop, removal, placement change). */
	| { readonly type: "abandoned" }
	| DirectTerminalEvent
	/** The caps worker reaches the decoder. */
	| { readonly type: "caps-worker" }
	/** A stop, suspend, restart, removal or destroy was requested. */
	| { readonly type: "stop-requested" }
	| DirectExitedEvent
	| DirectFateDueEvent

export type DirectAction =
	/** Keep the paused socket; `error` and `close` listeners only. */
	| "keep-socket"
	/** Today's relay path, unchanged. */
	| "relay"
	/** Send `retune` as today. */
	| "retune"
	/** Spawn with the socket as fd 0, then destroy Node's copy. */
	| "spawn"
	/** The socket closed before the start: drop the channel, no spawn. */
	| "lost-before-start"
	/** Destroy the socket if still held and release the channel. */
	| "release"
	/** Nothing new: today's handling. */
	| "today"
	/** Set `inputEnded = "channel"` and `channelStale` in this turn. */
	| "end-input"
	/** Today's `channel-stale` restart. */
	| "channel-restart"
	/** No lastError, no crash accounting, no back-off: the caps worker restarts it once. */
	| "expected-restart"
	/** As expected-restart, but held as a channel suspension until caps return. */
	| "expected-hold"
	/** Claim and release the channel, then signal the child. */
	| "release-then-signal"
	/** Run the immediate exit bookkeeping now; defer the classification (arm the fate timer). */
	| "defer"
	/** Today's unexpected-exit handling; Node releases the channel. */
	| "crash"
	/** The fate is not due yet: wait out the rest. */
	| "wait"
	/** Cancel the timer; no restart; release the channel. */
	| "cancel"
	/** The guard failed: drop the deferred tail; release the channel if still held. */
	| "drop"
	| "ignore"

export interface DirectStep {
	readonly next: DirectPhase
	readonly action: DirectAction
	/** exit-pending: when its exit happened (the fate is due CHANNEL_FATE_MS later). */
	readonly exitAtMs?: number
}

const step = (next: DirectPhase, action: DirectAction): DirectStep => ({
	next,
	action,
})

/** The lifecycle table of a decoder with direct channel input. */
export function directStep(facts: DirectFacts, event: DirectEvent): DirectStep {
	const { phase } = facts
	switch (event.type) {
		case "granted":
			return event.direct
				? step("wired", "keep-socket")
				: step("unwired", "relay")
		case "retune":
			if (phase === "wired") return step("wired", "retune")
			if (phase === "running")
				return step("running", event.live ? "retune" : "today")
			return step(phase, "today")
		case "start":
			if (phase !== "wired") return step(phase, "today")
			return event.socketDestroyed
				? step("unwired", "lost-before-start")
				: step("running", "spawn")
		case "spawn-failed":
			return phase === "wired" || phase === "running"
				? step("unwired", "release")
				: step(phase, "today")
		case "abandoned":
			return phase === "wired"
				? step("unwired", "release")
				: step(phase, "today")
		case "terminal":
			if (phase === "wired") return step("unwired", "today")
			if (phase === "running")
				return event.cause === "client-gone"
					? step("running", "today")
					: step("ending", "end-input")
			if (phase === "exit-pending") {
				if (!event.current) return step("unwired", "drop")
				if (event.cause === "client-gone") return step("unwired", "crash")
				return event.capsKnown
					? step("restart-due", "expected-restart")
					: step("suspended", "expected-hold")
			}
			return step(phase, "ignore")
		case "caps-worker":
			return phase === "ending" || phase === "restart-due"
				? step("unwired", "channel-restart")
				: step(phase, "today")
		case "stop-requested":
			if (phase === "running" || phase === "ending")
				return step("stopping", "release-then-signal")
			if (phase === "exit-pending") return step("unwired", "cancel")
			if (phase === "wired") return step("unwired", "release")
			return step(phase, "today")
		case "exited":
			if (!event.realExit || event.intentional || event.suspended)
				return step(phase === "wired" ? "wired" : "unwired", "today")
			if (phase === "ending")
				return event.capsKnown
					? step("restart-due", "expected-restart")
					: step("suspended", "expected-hold")
			if (phase === "running" && event.holdsChannel)
				return { next: "exit-pending", action: "defer", exitAtMs: event.nowMs }
			return step("unwired", "today")
		case "fate-due":
			if (phase !== "exit-pending") return step(phase, "ignore")
			if (!event.current) return step("unwired", "drop")
			if (event.nowMs - (facts.exitAtMs ?? event.nowMs) >= CHANNEL_FATE_MS)
				return step("unwired", "crash")
			return {
				next: "exit-pending",
				action: "wait",
				...(facts.exitAtMs !== undefined ? { exitAtMs: facts.exitAtMs } : {}),
			}
	}
}

/**
 * The bytes a `channel-stats` line adds to a decoder's `bytesIn`: the output samples since the last line it counted,
 * times the size of one sample of the channel's format. Never backwards: a smaller count (another channel's, or a
 * counter that restarted) adds nothing and keeps the larger mark.
 */
export function channelStatsDelta(
	countedSamples: number,
	outputSamples: number,
	bytesPerSample: number,
): { bytes: number; countedSamples: number } {
	if (
		!Number.isSafeInteger(outputSamples) ||
		outputSamples <= countedSamples ||
		!Number.isSafeInteger(bytesPerSample) ||
		bytesPerSample <= 0
	)
		return { bytes: 0, countedSamples }
	return {
		bytes: (outputSamples - countedSamples) * bytesPerSample,
		countedSamples: outputSamples,
	}
}

/** What a decoder adapter offers for direct channel input (BaseDecoder and the bases built on it). */
export interface DirectInputDecoder {
	/** Holds the paused socket until the spawn, which takes it as stdin. */
	attachDirectInput(socket: DirectChannelSocket): void
	/** Adds bytes the channelizer reports as written to this decoder's channel. */
	addInputBytes(bytes: number): void
}

/** The decoder's direct input port, found structurally; null for adapters without one. */
export function directInputOf(decoder: object): DirectInputDecoder | null {
	const candidate = decoder as Partial<DirectInputDecoder>
	return typeof candidate.attachDirectInput === "function" &&
		typeof candidate.addInputBytes === "function"
		? (decoder as DirectInputDecoder)
		: null
}
