/**
 * Scan job lifecycle (spec § 10.1) as a pure transition function. Actions are those of a sweep;
 * in-window jobs run the same table without the lease rows (`actionsForMode`).
 */
import type { FailReason, JobState, PauseReason, ScanMode } from "./types.js"

export type JobEvent =
	| { type: "start" }
	| { type: "create-rejected" }
	| { type: "engine-ready" }
	| { type: "tuner-error" }
	| { type: "engine-failed" }
	| { type: "hold" }
	| { type: "hold-done" }
	| { type: "pause" }
	| { type: "rest-write" }
	| { type: "relay-external" }
	| { type: "preempted-job" }
	| { type: "preemptor-lost" }
	| { type: "source-down" }
	| { type: "source-up" }
	| { type: "preemptor-idle"; impactGrew: boolean }
	| { type: "resume"; takeover: boolean }
	| { type: "cancel" }
	| { type: "stop-condition" }
	| { type: "source-removed" }
	| { type: "boot" }

export type JobAction =
	| "acquire-lease"
	| "release-lease"
	| "restore"
	| "hold-decoders"
	| "release-decoders"
	| "stop-probes"
	| "open-engine"
	| "resend-hop"
	| "report-impact"

type From = { state: JobState; reason?: PauseReason | FailReason }
type Result =
	| { state: JobState; reason?: PauseReason | FailReason; actions: JobAction[] }
	| { invalid: true }

const INVALID: Result = { invalid: true }
const TERMINAL: ReadonlySet<JobState> = new Set([
	"completed",
	"cancelled",
	"failed",
])
const LEASE_ACTIONS: ReadonlySet<JobAction> = new Set([
	"acquire-lease",
	"release-lease",
	"restore",
	"hold-decoders",
	"release-decoders",
	"resend-hop",
])

export function isTerminal(state: JobState): boolean {
	return TERMINAL.has(state)
}

/** In-window jobs never touch the tuner or the decoder hold (§ 10.1, § 10.3). */
export function actionsForMode(
	mode: ScanMode,
	actions: JobAction[],
): JobAction[] {
	return mode === "sweep"
		? [...actions]
		: actions.filter(a => !LEASE_ACTIONS.has(a))
}

function to(
	state: JobState,
	actions: JobAction[],
	reason?: PauseReason | FailReason,
): Result {
	return reason === undefined ? { state, actions } : { state, reason, actions }
}

function holdsLease(s: From): boolean {
	if (s.state === "starting" || s.state === "running" || s.state === "holding")
		return true
	return (
		s.state === "paused" &&
		(s.reason === "operator" || s.reason === "source-down")
	)
}

/**
 * Ending a job. Only a lease holder restores and releases the lease and its decoder hold. A paused
 * job without the lease (preempted-*, resume-blocked, core-restart) gets stop-probes only: a
 * preempted-job job may still hold its own decoder hold (DecoderManager keys holds by holder,
 * Task 29), which Task 35's terminal teardown drops; the running preemptor's hold is its own key
 * and stays (§ 10.4).
 */
function endActions(s: From): JobAction[] {
	if (s.state === "pending") return []
	return holdsLease(s)
		? ["stop-probes", "restore", "release-lease", "release-decoders"]
		: ["stop-probes"]
}

/**
 * A lease lost while paused (Task 35 fix round): the operator's pause never auto-resumes (it stays
 * `paused(operator)` without the lease); a source-down pause becomes the preemption. Probes are
 * already stopped in both.
 */
function pausedLeaseLost(
	s: From,
	lost: "preempted-operator" | "preempted-relay",
): Result {
	if (s.state !== "paused") return INVALID
	if (s.reason === "operator")
		return to("paused", ["release-lease", "release-decoders"], "operator")
	if (s.reason === "source-down")
		return to("paused", ["release-lease", "release-decoders"], lost)
	return INVALID
}

/**
 * Runner context the table cannot see (Task 35 fix round). `leaseHeld: false` marks a sweep whose
 * lease was revoked while it stayed `paused(operator)`: its resume re-acquires the lease.
 */
export interface TransitionContext {
	leaseHeld?: boolean
}

export function transition(
	s: From,
	e: JobEvent,
	ctx: TransitionContext = {},
): Result {
	if (TERMINAL.has(s.state)) return INVALID
	const active = s.state === "running" || s.state === "holding"
	const pausedFor = (reason: PauseReason): boolean =>
		s.state === "paused" && s.reason === reason
	const preempted =
		pausedFor("preempted-operator") ||
		pausedFor("preempted-relay") ||
		pausedFor("preempted-job")
	switch (e.type) {
		case "start":
			return s.state === "pending"
				? to("starting", ["acquire-lease", "hold-decoders", "open-engine"])
				: INVALID
		case "create-rejected":
			return s.state === "pending" ? to("failed", [], "invalid") : INVALID
		case "engine-ready":
			return s.state === "starting" ? to("running", []) : INVALID
		case "tuner-error":
			// A first retune can fail mid-sequence (rate written, frequency refused): restore what was
			// written; a failed restore is re-queued for the next connection (H4). No-op without a lease.
			return s.state === "starting"
				? to(
						"failed",
						["restore", "release-lease", "release-decoders"],
						"tuner-unavailable",
					)
				: INVALID
		case "engine-failed":
			return to("failed", endActions(s), "tuner-unavailable")
		case "hold":
			return s.state === "running" ? to("holding", []) : INVALID
		case "hold-done":
			return s.state === "holding" ? to("running", []) : INVALID
		case "pause":
			return active ? to("paused", ["stop-probes"], "operator") : INVALID
		case "rest-write":
			return active
				? to(
						"paused",
						["stop-probes", "release-lease", "release-decoders"],
						"preempted-operator",
					)
				: pausedLeaseLost(s, "preempted-operator")
		case "relay-external":
			return active
				? to(
						"paused",
						["stop-probes", "release-lease", "release-decoders"],
						"preempted-relay",
					)
				: pausedLeaseLost(s, "preempted-relay")
		case "preempted-job":
			if (active)
				return to("paused", ["stop-probes", "release-lease"], "preempted-job")
			// the arbiter hands the lease over from a paused holder too; probes are already stopped
			return pausedFor("operator") || pausedFor("source-down")
				? to("paused", ["release-lease"], "preempted-job")
				: INVALID
		case "preemptor-lost":
			// The job that took the lease lost it to an operator or relay write (S1-B final review,
			// finding 3): a waiter keeps waiting but frees the configured decoders; preemptor-idle re-holds.
			return pausedFor("preempted-job")
				? to("paused", ["release-decoders"], "preempted-job")
				: INVALID
		case "source-down":
			return s.state === "starting"
				? to("failed", endActions(s), "tuner-unavailable")
				: active
					? to("paused", ["stop-probes"], "source-down")
					: INVALID
		case "source-up":
			return pausedFor("source-down") ? to("running", ["resend-hop"]) : INVALID
		case "preemptor-idle":
			if (!preempted) return INVALID
			return e.impactGrew
				? to("paused", ["report-impact", "release-decoders"], "resume-blocked")
				: to("running", ["acquire-lease", "hold-decoders", "resend-hop"])
		case "resume":
			if (pausedFor("operator"))
				return ctx.leaseHeld === false
					? to("running", ["acquire-lease", "hold-decoders", "resend-hop"])
					: to("running", ["resend-hop"])
			if (pausedFor("resume-blocked"))
				return e.takeover
					? to("running", ["acquire-lease", "hold-decoders", "resend-hop"])
					: INVALID
			if (pausedFor("core-restart"))
				return to("running", [
					"acquire-lease",
					"hold-decoders",
					"open-engine",
					"resend-hop",
				])
			// Explicit resume of a preempted job (Task 35 fix round 2): ScannerService lets it through
			// only when the lease is free and the job is the best waiter; a refused acquire changes nothing.
			if (preempted)
				return to("running", ["acquire-lease", "hold-decoders", "resend-hop"])
			return INVALID
		case "cancel":
			return to("cancelled", endActions(s))
		case "stop-condition":
			return active ? to("completed", endActions(s)) : INVALID
		case "source-removed": {
			if (s.state === "pending") return to("failed", [], "source-removed")
			return to(
				"failed",
				holdsLease(s)
					? ["stop-probes", "release-lease", "release-decoders"]
					: ["stop-probes"],
				"source-removed",
			)
		}
		case "boot":
			// a job persisted in starting already held a lease (§ 10.3)
			return s.state === "starting" || active || s.state === "paused"
				? to("paused", ["restore"], "core-restart")
				: INVALID
	}
}
