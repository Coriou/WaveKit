import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	actionsForMode,
	isTerminal,
	transition,
} from "../../../../src/core/scanner/job-state.js"
import type { JobEvent } from "../../../../src/core/scanner/job-state.js"
import type {
	FailReason,
	JobState,
	PauseReason,
} from "../../../../src/core/scanner/types.js"

type S = { state: JobState; reason?: PauseReason | FailReason }
const label = (s: S): string =>
	s.reason !== undefined ? `${s.state}(${s.reason})` : s.state
const PAUSED: PauseReason[] = [
	"operator",
	"preempted-operator",
	"preempted-relay",
	"preempted-job",
	"source-down",
	"core-restart",
	"resume-blocked",
]
const ACTIVE = ["running", "holding"]
const PAUSED_LABELS = PAUSED.map(r => `paused(${r})`)
const PREEMPTED = [
	"paused(preempted-operator)",
	"paused(preempted-relay)",
	"paused(preempted-job)",
]
/** States that hold the lease and the decoder hold (§ 10.3). */
const LEASED = [
	"starting",
	...ACTIVE,
	"paused(operator)",
	"paused(source-down)",
]
/** Paused without lease or decoder hold: ending them must not release a hold another job (the preemptor) owns. */
const UNLEASED = [
	...PREEMPTED,
	"paused(resume-blocked)",
	"paused(core-restart)",
]
const ALL_STATES = [
	"pending",
	...LEASED,
	...UNLEASED,
	"completed",
	"cancelled",
	"failed(source-removed)",
	"failed(tuner-unavailable)",
	"failed(invalid)",
]
const END = ["stop-probes", "restore", "release-lease", "release-decoders"]

/** Event variants by key: every event type, with both values of each event parameter. */
const EVENTS: Record<string, JobEvent> = {
	start: { type: "start" },
	"create-rejected": { type: "create-rejected" },
	"engine-ready": { type: "engine-ready" },
	"tuner-error": { type: "tuner-error" },
	hold: { type: "hold" },
	"hold-done": { type: "hold-done" },
	pause: { type: "pause" },
	"rest-write": { type: "rest-write" },
	"relay-external": { type: "relay-external" },
	"preempted-job": { type: "preempted-job" },
	"preemptor-lost": { type: "preemptor-lost" },
	"source-down": { type: "source-down" },
	"source-up": { type: "source-up" },
	"preemptor-idle:same": { type: "preemptor-idle", impactGrew: false },
	"preemptor-idle:grew": { type: "preemptor-idle", impactGrew: true },
	"resume:plain": { type: "resume", takeover: false },
	"resume:takeover": { type: "resume", takeover: true },
	cancel: { type: "cancel" },
	"stop-condition": { type: "stop-condition" },
	"source-removed": { type: "source-removed" },
	boot: { type: "boot" },
}

/** Spec § 10.1 as data: [from labels, event key, to label, sweep actions]. Every pair not listed is INVALID. */
const ROWS: [string[], string, string, string[]][] = [
	[
		["pending"],
		"start",
		"starting",
		["acquire-lease", "hold-decoders", "open-engine"],
	],
	[["pending"], "create-rejected", "failed(invalid)", []],
	[["starting"], "engine-ready", "running", []],
	[
		["starting"],
		"tuner-error",
		"failed(tuner-unavailable)",
		// S1-B final review, finding 1: what the first retune wrote is restored (re-queued when it fails)
		["restore", "release-lease", "release-decoders"],
	],
	[["running"], "hold", "holding", []],
	[["holding"], "hold-done", "running", []],
	[ACTIVE, "pause", "paused(operator)", ["stop-probes"]],
	[
		ACTIVE,
		"rest-write",
		"paused(preempted-operator)",
		["stop-probes", "release-lease", "release-decoders"],
	],
	[
		ACTIVE,
		"relay-external",
		"paused(preempted-relay)",
		["stop-probes", "release-lease", "release-decoders"],
	],
	[
		ACTIVE,
		"preempted-job",
		"paused(preempted-job)",
		["stop-probes", "release-lease"],
	],
	// the arbiter hands the lease over from a paused holder too (probes already stopped; the job keeps its own keyed decoder hold)
	[
		["paused(operator)", "paused(source-down)"],
		"preempted-job",
		"paused(preempted-job)",
		["release-lease"],
	],
	// a lease lost while paused (Task 35 fix round): the operator's pause stays, a source-down pause is preempted
	[
		["paused(operator)"],
		"rest-write",
		"paused(operator)",
		["release-lease", "release-decoders"],
	],
	[
		["paused(operator)"],
		"relay-external",
		"paused(operator)",
		["release-lease", "release-decoders"],
	],
	[
		["paused(source-down)"],
		"rest-write",
		"paused(preempted-operator)",
		["release-lease", "release-decoders"],
	],
	[
		["paused(source-down)"],
		"relay-external",
		"paused(preempted-relay)",
		["release-lease", "release-decoders"],
	],
	// S1-B final review, finding 3: the preemptor lost the lease to the operator or a relay; the waiter frees the decoders
	[
		["paused(preempted-job)"],
		"preemptor-lost",
		"paused(preempted-job)",
		["release-decoders"],
	],
	[ACTIVE, "source-down", "paused(source-down)", ["stop-probes"]],
	[["paused(source-down)"], "source-up", "running", ["resend-hop"]],
	[
		PREEMPTED,
		"preemptor-idle:same",
		"running",
		["acquire-lease", "hold-decoders", "resend-hop"],
	],
	[
		PREEMPTED,
		"preemptor-idle:grew",
		"paused(resume-blocked)",
		["report-impact", "release-decoders"],
	],
	// explicit resume of a preempted job (fix round 2; the service admits only the best waiter on a free lease)
	[
		PREEMPTED,
		"resume:plain",
		"running",
		["acquire-lease", "hold-decoders", "resend-hop"],
	],
	[
		PREEMPTED,
		"resume:takeover",
		"running",
		["acquire-lease", "hold-decoders", "resend-hop"],
	],
	[["paused(operator)"], "resume:plain", "running", ["resend-hop"]],
	[["paused(operator)"], "resume:takeover", "running", ["resend-hop"]],
	[
		["paused(resume-blocked)"],
		"resume:takeover",
		"running",
		["acquire-lease", "hold-decoders", "resend-hop"],
	],
	[
		["paused(core-restart)"],
		"resume:plain",
		"running",
		["acquire-lease", "hold-decoders", "open-engine", "resend-hop"],
	],
	[
		["paused(core-restart)"],
		"resume:takeover",
		"running",
		["acquire-lease", "hold-decoders", "open-engine", "resend-hop"],
	],
	[["pending"], "cancel", "cancelled", []],
	[LEASED, "cancel", "cancelled", END],
	[UNLEASED, "cancel", "cancelled", ["stop-probes"]],
	[ACTIVE, "stop-condition", "completed", END],
	[["pending"], "source-removed", "failed(source-removed)", []],
	[
		LEASED,
		"source-removed",
		"failed(source-removed)",
		["stop-probes", "release-lease", "release-decoders"],
	],
	[UNLEASED, "source-removed", "failed(source-removed)", ["stop-probes"]],
	// a job persisted in starting already held a lease: it boots like any other active job
	[
		["starting", ...ACTIVE, ...PAUSED_LABELS],
		"boot",
		"paused(core-restart)",
		["restore"],
	],
]
const EXPECTED = new Map<string, { to: string; actions: string[] }>()
for (const [from, ev, to, actions] of ROWS)
	for (const f of from) {
		const key = `${f}|${ev}`
		if (EXPECTED.has(key)) throw new Error(`duplicate table row ${key}`)
		EXPECTED.set(key, { to, actions })
	}
const fromLabel = (l: string): S => {
	const m = /^(\w+)\((.+)\)$/.exec(l)
	return m ? ({ state: m[1], reason: m[2] } as S) : { state: l as JobState }
}
const eventKey = (e: JobEvent): string =>
	e.type === "preemptor-idle"
		? `preemptor-idle:${e.impactGrew ? "grew" : "same"}`
		: e.type === "resume"
			? `resume:${e.takeover ? "takeover" : "plain"}`
			: e.type

const eventArb: fc.Arbitrary<JobEvent> = fc.oneof(
	...(
		[
			"start",
			"create-rejected",
			"engine-ready",
			"tuner-error",
			"hold",
			"hold-done",
			"pause",
			"rest-write",
			"relay-external",
			"preempted-job",
			"preemptor-lost",
			"source-down",
			"source-up",
			"cancel",
			"stop-condition",
			"source-removed",
			"boot",
		] as const
	).map(type => fc.constant({ type } as JobEvent)),
	fc
		.boolean()
		.map((impactGrew): JobEvent => ({ type: "preemptor-idle", impactGrew })),
	fc.boolean().map((takeover): JobEvent => ({ type: "resume", takeover })),
)
const stateArb: fc.Arbitrary<S> = fc.oneof(
	fc.constantFrom<S>(
		{ state: "pending" },
		{ state: "starting" },
		{ state: "running" },
		{ state: "holding" },
		{ state: "completed" },
		{ state: "cancelled" },
	),
	fc.constantFrom(...PAUSED).map((reason): S => ({ state: "paused", reason })),
	fc
		.constantFrom<FailReason>("source-removed", "tuner-unavailable", "invalid")
		.map((reason): S => ({ state: "failed", reason })),
)

describe("job transition table (§ 10.1)", () => {
	it("starts a sweep with lease, decoder hold and engine; an in-window job only opens the engine", () => {
		const r = transition({ state: "pending" }, { type: "start" })
		expect(r).toEqual({
			state: "starting",
			actions: ["acquire-lease", "hold-decoders", "open-engine"],
		})
		if ("invalid" in r) return
		expect(actionsForMode("in-window", r.actions)).toEqual(["open-engine"])
		expect(actionsForMode("sweep", r.actions)).toEqual(r.actions)
	})

	it("restores only while the lease is held", () => {
		expect(transition({ state: "running" }, { type: "cancel" })).toEqual({
			state: "cancelled",
			actions: ["stop-probes", "restore", "release-lease", "release-decoders"],
		})
		expect(
			transition(
				{ state: "paused", reason: "preempted-operator" },
				{ type: "cancel" },
			),
		).toEqual({ state: "cancelled", actions: ["stop-probes"] })
		expect(
			transition({ state: "holding" }, { type: "stop-condition" }),
		).toEqual({
			state: "completed",
			actions: ["stop-probes", "restore", "release-lease", "release-decoders"],
		})
		expect(transition({ state: "pending" }, { type: "cancel" })).toEqual({
			state: "cancelled",
			actions: [],
		})
	})

	it("loses the lease without restoring on an operator write, and hands it over to a higher-priority job", () => {
		expect(transition({ state: "holding" }, { type: "rest-write" })).toEqual({
			state: "paused",
			reason: "preempted-operator",
			actions: ["stop-probes", "release-lease", "release-decoders"],
		})
		expect(transition({ state: "running" }, { type: "preempted-job" })).toEqual(
			{
				state: "paused",
				reason: "preempted-job",
				actions: ["stop-probes", "release-lease"],
			},
		)
		// a paused lease holder is handed over too, so it never keeps a stale lease
		expect(
			transition(
				{ state: "paused", reason: "operator" },
				{ type: "preempted-job" },
			),
		).toEqual({
			state: "paused",
			reason: "preempted-job",
			actions: ["release-lease"],
		})
		expect(
			transition(
				{ state: "paused", reason: "source-down" },
				{ type: "preempted-job" },
			),
		).toEqual({
			state: "paused",
			reason: "preempted-job",
			actions: ["release-lease"],
		})
	})

	it("never releases the decoder hold the preemptor owns when a preempted job ends", () => {
		const preempted: S = { state: "paused", reason: "preempted-job" }
		expect(transition(preempted, { type: "cancel" })).toEqual({
			state: "cancelled",
			actions: ["stop-probes"],
		})
		expect(transition(preempted, { type: "source-removed" })).toEqual({
			state: "failed",
			reason: "source-removed",
			actions: ["stop-probes"],
		})
	})

	it("auto-resumes only when the impact did not grow; resume-blocked needs takeover", () => {
		const paused: S = { state: "paused", reason: "preempted-relay" }
		expect(
			transition(paused, { type: "preemptor-idle", impactGrew: false }),
		).toEqual({
			state: "running",
			actions: ["acquire-lease", "hold-decoders", "resend-hop"],
		})
		expect(
			transition(paused, { type: "preemptor-idle", impactGrew: true }),
		).toEqual({
			state: "paused",
			reason: "resume-blocked",
			actions: ["report-impact", "release-decoders"],
		})
		expect(
			transition(
				{ state: "paused", reason: "resume-blocked" },
				{ type: "resume", takeover: false },
			),
		).toEqual({ invalid: true })
		expect(
			transition(
				{ state: "paused", reason: "resume-blocked" },
				{ type: "resume", takeover: true },
			),
		).toEqual({
			state: "running",
			actions: ["acquire-lease", "hold-decoders", "resend-hop"],
		})
	})

	it("keeps an operator pause when the lease is lost and re-acquires it on resume", () => {
		const paused: S = { state: "paused", reason: "operator" }
		expect(transition(paused, { type: "rest-write" })).toEqual({
			state: "paused",
			reason: "operator",
			actions: ["release-lease", "release-decoders"],
		})
		// the runner knows it no longer holds the lease
		expect(
			transition(
				paused,
				{ type: "resume", takeover: false },
				{ leaseHeld: false },
			),
		).toEqual({
			state: "running",
			actions: ["acquire-lease", "hold-decoders", "resend-hop"],
		})
		expect(
			transition(
				paused,
				{ type: "resume", takeover: false },
				{ leaseHeld: true },
			),
		).toEqual({ state: "running", actions: ["resend-hop"] })
		expect(
			transition(
				{ state: "paused", reason: "source-down" },
				{ type: "relay-external" },
			),
		).toEqual({
			state: "paused",
			reason: "preempted-relay",
			actions: ["release-lease", "release-decoders"],
		})
	})

	it("resends the hop after a reconnect and restores the persisted lease at boot", () => {
		expect(
			transition(
				{ state: "paused", reason: "source-down" },
				{ type: "source-up" },
			),
		).toEqual({ state: "running", actions: ["resend-hop"] })
		expect(transition({ state: "holding" }, { type: "boot" })).toEqual({
			state: "paused",
			reason: "core-restart",
			actions: ["restore"],
		})
		expect(transition({ state: "starting" }, { type: "boot" })).toEqual({
			state: "paused",
			reason: "core-restart",
			actions: ["restore"],
		})
		expect(transition({ state: "pending" }, { type: "boot" })).toEqual({
			invalid: true,
		})
	})

	// Feature: signal-discovery-scanner, Property 9: Job transitions
	// Validates: spec § 10.1
	it("matches the table exactly for every state × event: listed rows with their actions, INVALID elsewhere", () => {
		expect(ALL_STATES).toHaveLength(16)
		for (const l of ALL_STATES)
			for (const [key, e] of Object.entries(EVENTS)) {
				const want = EXPECTED.get(`${l}|${key}`)
				const r = transition(fromLabel(l), e)
				if (want === undefined) {
					expect({ at: `${l}|${key}`, r }).toEqual({
						at: `${l}|${key}`,
						r: { invalid: true },
					})
					continue
				}
				const got =
					"invalid" in r
						? r
						: {
								to: label(
									r.reason !== undefined
										? { state: r.state, reason: r.reason }
										: { state: r.state },
								),
								actions: r.actions,
							}
				expect({ at: `${l}|${key}`, got }).toEqual({
					at: `${l}|${key}`,
					got: want,
				})
			}
		for (const key of EXPECTED.keys())
			expect(ALL_STATES).toContain(key.split("|")[0])
	})

	// Feature: signal-discovery-scanner, Property 9: Job transitions
	// Validates: spec § 10.1
	it("follows the table along any event sequence; terminal states are absorbing; in-window strips lease actions", () => {
		fc.assert(
			fc.property(
				stateArb,
				fc.array(eventArb, { maxLength: 40 }),
				(initial, events) => {
					let s: S = initial
					for (const e of events) {
						const r = transition(s, e)
						const want = EXPECTED.get(`${label(s)}|${eventKey(e)}`)
						if (isTerminal(s.state)) expect(want).toBeUndefined()
						if (want === undefined) {
							expect(r).toEqual({ invalid: true })
							continue
						}
						if ("invalid" in r)
							throw new Error(`${label(s)}|${eventKey(e)} must be valid`)
						const next: S =
							r.reason !== undefined
								? { state: r.state, reason: r.reason }
								: { state: r.state }
						expect({ to: label(next), actions: r.actions }).toEqual(want)
						expect(next.state === "paused" || next.state === "failed").toBe(
							next.reason !== undefined,
						)
						for (const a of actionsForMode("in-window", r.actions))
							expect([
								"acquire-lease",
								"release-lease",
								"restore",
								"hold-decoders",
								"release-decoders",
								"resend-hop",
							]).not.toContain(a)
						s = next
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
