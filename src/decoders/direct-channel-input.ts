/**
 * Direct channel input: the decisions for a decoder whose stdin is its channel's socket. Pure: no I/O, no timers;
 * the decoder manager supplies the facts and the clock and carries out the action.
 *
 * With direct input Node holds no copy of the socket once the decoder runs, so a decoder exit no longer says by itself
 * why the input ended. The channelizer's terminal event for that channel does: `closed {client-gone}` means the
 * decoder went away on its own (the next write failed), anything else (a centre move, the end of a generation, a
 * release) means the channel went away and the decoder only saw EOF. Which one came is decided by events, with one
 * bound for a channelizer that is alive but has nothing to write: CHANNEL_FATE_MS.
 *
 * A start that was granted a direct channel is checked again at the real spawn (BaseDecoder), since a channel can end
 * while startup awaits (another decoder's stop, an adapter writing a config file): a closed socket there never spawns
 * a decoder without input; the start ends as the channel-loss hold. An exit that follows the channel's end, whichever
 * came first (the exit or the caps worker's stop), writes no lastError and no crash accounting, and the adapter's own
 * stop() runs on an exited decoder before its next start, as a requested stop would have run it.
 */
import type { DirectChannelSocket } from "../core/channelizer/types.js"
import { WaveKitError } from "../utils/errors.js"

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
	/**
	 * Node released the channel before signalling the child: an intentional stop. Kept for that run's exit when the
	 * channel had already ended (`channelEnded` on the exit): the stop is then the channel's restart, not a crash.
	 */
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
 * purpose or no longer the current run; `holdsChannel`: the decoder still holds its channel (no terminal event);
 * `channelEnded`: stopping only, the run's channel had ended (not `client-gone`) before the stop released it.
 */
export interface DirectExitedEvent {
	readonly type: "exited"
	readonly realExit: boolean
	readonly intentional: boolean
	readonly suspended: boolean
	readonly holdsChannel: boolean
	readonly capsKnown: boolean
	readonly nowMs: number
	readonly channelEnded?: boolean
}

/**
 * A start, checked twice: by the manager before it calls the decoder's start, and by the decoder at the real spawn.
 * `acquired`: this start was granted a direct channel, whatever happened to the channel since (a terminal event or a
 * close between the grant and the spawn does not undo the grant); `socketDestroyed`: its socket is missing or closed
 * now.
 */
export interface DirectStartEvent {
	readonly type: "start"
	readonly acquired: boolean
	readonly socketDestroyed: boolean
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
	| DirectStartEvent
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
	/**
	 * The socket closed between the grant and the spawn: no spawn; the channel is dropped and the start ends as the
	 * channel-loss hold (`channelizer-unavailable`, a race), never as a spawn error: no lastError, no failure count, no
	 * back-off.
	 */
	| "lost-before-start"
	/** Destroy the socket if still held and release the channel. */
	| "release"
	/** Nothing new: today's handling. */
	| "today"
	/** Set `inputEnded = "channel"` and `channelStale` in this turn. */
	| "end-input"
	/** Today's `channel-stale` restart. */
	| "channel-restart"
	/**
	 * No lastError, no crash accounting, no back-off: the caps worker restarts it once. Before that start the manager
	 * runs the adapter's own stop() on the exited decoder, once, so per-run adapter state ends as a requested stop
	 * would end it.
	 */
	| "expected-restart"
	/** As expected-restart (the adapter's stop() included, before the resume), held as a channel suspension until caps return. */
	| "expected-hold"
	/** The exit of a stop that followed the channel's end: no lastError, no crash accounting, no restart of its own. */
	| "expected-stop"
	/** Claim and release the channel, then signal the child. */
	| "release-then-signal"
	/** Run the immediate exit bookkeeping now; defer the classification (arm the fate timer). */
	| "defer"
	/** Today's unexpected-exit handling; Node releases the channel. */
	| "crash"
	/** The fate is not due yet: wait out the rest. */
	| "wait"
	/** Cancel the timer; no restart; release the channel; `record` says whether the exit is kept as a crash. */
	| "cancel"
	/** The guard failed: drop the deferred tail; release the channel if still held; `record` as for cancel. */
	| "drop"
	| "ignore"

export interface DirectStep {
	readonly next: DirectPhase
	readonly action: DirectAction
	/** exit-pending: when its exit happened (the fate is due CHANNEL_FATE_MS later). */
	readonly exitAtMs?: number
	/**
	 * cancel and drop: keep the dropped exit as the crash it most likely was (lastError and the failure count, as the
	 * relay path writes at the exit itself), unless the channel's end was seen, which makes the exit that end's EOF.
	 */
	readonly record?: boolean
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
			// Keyed on the grant, not the phase: a terminal event after the grant leaves the start's socket closed.
			if (!event.acquired) return step(phase, "today")
			if (event.socketDestroyed) return step("unwired", "lost-before-start")
			return step(phase === "wired" ? "running" : phase, "spawn")
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
				// A client-gone confirms the crash; any other end is the channel's, seen now: the exit was its EOF.
				if (!event.current)
					return {
						next: "unwired",
						action: "drop",
						record: event.cause === "client-gone",
					}
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
			if (phase === "exit-pending")
				return { next: "unwired", action: "cancel", record: true }
			if (phase === "wired") return step("unwired", "release")
			return step(phase, "today")
		case "exited":
			if (phase === "stopping")
				return step(
					"unwired",
					event.realExit && event.channelEnded === true
						? "expected-stop"
						: "today",
				)
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
			// No terminal event came: the channel's end was not seen.
			if (!event.current)
				return { next: "unwired", action: "drop", record: true }
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
 * The bytes a `channel-stats` line adds to a decoder's `bytesIn`: the samples queued for the decoder since the last line
 * it counted (`outputSamples - droppedSamples`, both cumulative: produced, less those the full queue refused), times
 * the size of one sample of the channel's format. Samples still in the queue at the line count. Never backwards: a
 * smaller count (another channel's, or a counter that restarted) adds nothing and keeps the larger mark.
 */
export function channelStatsDelta(
	countedSamples: number,
	outputSamples: number,
	droppedSamples: number,
	bytesPerSample: number,
): { bytes: number; countedSamples: number } {
	const queued = outputSamples - droppedSamples
	if (
		!Number.isSafeInteger(outputSamples) ||
		!Number.isSafeInteger(droppedSamples) ||
		droppedSamples < 0 ||
		queued <= countedSamples ||
		!Number.isSafeInteger(bytesPerSample) ||
		bytesPerSample <= 0
	)
		return { bytes: 0, countedSamples }
	return {
		bytes: (queued - countedSamples) * bytesPerSample,
		countedSamples: queued,
	}
}

/** The error code of a start that held a direct channel whose socket closed before the spawn (lost-before-start). */
export const DIRECT_INPUT_LOST = "DECODER_DIRECT_INPUT_LOST"

/** Thrown by a decoder's start instead of spawning without its input; the manager holds it, never counts it. */
export function directInputLost(decoderId: string): WaveKitError {
	return new WaveKitError(
		`Decoder ${decoderId}: its direct channel closed before the spawn`,
		DIRECT_INPUT_LOST,
	)
}

export function isDirectInputLost(err: unknown): boolean {
	return err instanceof WaveKitError && err.code === DIRECT_INPUT_LOST
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
