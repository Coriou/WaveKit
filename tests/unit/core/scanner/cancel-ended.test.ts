import fc from "fast-check"
import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../../src/api/routes/scanner.js"
import { ScannerApiError } from "../../../../src/core/scanner/errors.js"
import {
	isTerminal,
	type JobEvent,
} from "../../../../src/core/scanner/job-state.js"
import type { JobState } from "../../../../src/core/scanner/types.js"
import { flush, jobHarness } from "./cancel-ended-harness.js"

const ENDED = ["completed", "cancelled", "failed"] as const

async function outcome(p: Promise<void>): Promise<string> {
	try {
		await p
		return "resolved"
	} catch (err) {
		const e = err as { statusCode?: number; code?: string }
		return `${e.statusCode}:${e.code}`
	}
}

async function runningJob() {
	const h = jobHarness()
	await h.runner.start()
	await flush()
	await h.runner.idle()
	expect(h.record.state).toBe("running")
	return h
}

const END_ACTIONS = ["releaseJob", "release", "releaseSource", "closeEngine"]
const endActionCount = (calls: string[]): number =>
	calls.filter(c => END_ACTIONS.includes(c)).length

describe("cancel of an ended job (WG11 1.6)", () => {
	for (const state of ENDED) {
		it(`is a no-op on a ${state} job: no transition, action, event or write`, async () => {
			const h = jobHarness({ state })
			if (state === "failed") h.record.reason = "tuner-unavailable"
			const before = structuredClone({ ...h.record })
			// Frozen code (14f2feaa) answered 409 SCANNER_INVALID_TRANSITION with no calls.
			expect(await outcome(h.runner.dispatch({ type: "cancel" }))).toBe(
				"resolved",
			)
			await h.runner.idle()
			expect(h.calls).toEqual([])
			expect({ ...h.record }).toEqual(before)
		})

		for (const type of ["pause", "resume"] as const) {
			it(`keeps 409 for ${type} of a ${state} job (golden)`, async () => {
				const h = jobHarness({ state })
				const e: JobEvent =
					type === "pause" ? { type } : { type, takeover: false }
				expect(await outcome(h.runner.dispatch(e))).toBe(
					"409:SCANNER_INVALID_TRANSITION",
				)
				expect(h.calls).toEqual([])
				expect(h.record.state).toBe(state)
			})
		}
	}

	it("a cancel of a running job still ends it with its end actions (golden path)", async () => {
		const h = await runningJob()
		h.calls.length = 0
		await h.runner.dispatch({ type: "cancel" })
		expect(h.record.state).toBe("cancelled")
		// an in-window job takes no lease (actionsForMode): stop-probes, then the teardown
		expect(h.calls).toEqual([
			"releaseJob",
			"closeEngine",
			"persist:cancelled",
			"changed:state",
		])
		// a second cancel changes nothing
		h.calls.length = 0
		await h.runner.dispatch({ type: "cancel" })
		expect(h.calls).toEqual([])
		expect(h.record.state).toBe("cancelled")
	})

	for (const order of [
		["cancel", "stop-condition"],
		["stop-condition", "cancel"],
	] as const) {
		it(`a cancel racing completion (${order.join(" then ")}) ends in one terminal state, end actions once`, async () => {
			const h = await runningJob()
			h.calls.length = 0
			const results = await Promise.all(
				order.map(type => outcome(h.runner.dispatch({ type }))),
			)
			await h.runner.idle()
			const terminalWrites = h.calls.filter(c =>
				/^persist:(completed|cancelled|failed)$/.test(c),
			)
			expect(terminalWrites).toEqual([
				`persist:${order[0] === "cancel" ? "cancelled" : "completed"}`,
			])
			expect(endActionCount(h.calls)).toBe(2)
			expect(h.record.state).toBe(
				order[0] === "cancel" ? "cancelled" : "completed",
			)
			// the late cancel is a no-op; a late stop-condition stays the frozen 409
			expect(results).toEqual(
				order[0] === "cancel"
					? ["resolved", "409:SCANNER_INVALID_TRANSITION"]
					: ["resolved", "resolved"],
			)
		})
	}

	// Feature: web-gaps-11, Property 4: A stop is clean
	// Validates: Requirements 1.6
	it("property: cancels of ended jobs change nothing and every job ends once", async () => {
		const eventArb = fc.constantFrom<JobEvent>(
			{ type: "cancel" },
			{ type: "stop-condition" },
			{ type: "engine-failed" },
			{ type: "source-removed" },
			{ type: "pause" },
			{ type: "resume", takeover: false },
			{ type: "source-down" },
			{ type: "source-up" },
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(eventArb, fc.boolean()), {
					minLength: 1,
					maxLength: 8,
				}),
				async steps => {
					const h = await runningJob()
					h.calls.length = 0
					let pending: Promise<string>[] = []
					for (const [e, wait] of steps) {
						const terminalBefore = isTerminal(h.record.state)
						const callsBefore = h.calls.length
						pending.push(outcome(h.runner.dispatch(e)))
						if (wait) {
							await Promise.all(pending)
							pending = []
							if (terminalBefore && e.type === "cancel")
								expect(h.calls.length).toBe(callsBefore)
						}
					}
					await Promise.all(pending)
					await h.runner.idle()
					const states = h.calls
						.filter(c => c.startsWith("persist:"))
						.map(c => c.slice("persist:".length) as JobState)
					const terminal = states.filter(s => isTerminal(s))
					expect(terminal.length).toBeLessThanOrEqual(1)
					if (terminal.length === 1) {
						expect(states.at(-1)).toBe(terminal[0])
						expect(h.record.state).toBe(terminal[0])
						expect(h.calls.filter(c => c === "closeEngine")).toHaveLength(1)
						// a cancel after the end adds nothing
						const n = h.calls.length
						expect(await outcome(h.runner.dispatch({ type: "cancel" }))).toBe(
							"resolved",
						)
						expect(h.calls.length).toBe(n)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("cancel route (WG11 1.6)", () => {
	async function app(cancelJob: ScannerRouteService["cancelJob"]) {
		const a = Fastify({ logger: false })
		await a.register(scannerRoutes, {
			scanner: { cancelJob } as unknown as ScannerRouteService,
		})
		return a
	}

	it("answers 200 with the unchanged ended job", async () => {
		const job = { id: "j_1", state: "completed" }
		const a = await app(vi.fn(() => Promise.resolve(job)) as never)
		const res = await a.inject({
			method: "POST",
			url: "/api/scanner/jobs/j_1/cancel",
		})
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(job)
		await a.close()
	})

	it("keeps 404 for an unknown id", async () => {
		const a = await app(
			vi.fn(() =>
				Promise.reject(
					new ScannerApiError(
						"Job j_x not found",
						"SCANNER_JOB_NOT_FOUND",
						404,
					),
				),
			) as never,
		)
		const res = await a.inject({
			method: "POST",
			url: "/api/scanner/jobs/j_x/cancel",
		})
		expect(res.statusCode).toBe(404)
		expect(res.json()).toMatchObject({ code: "SCANNER_JOB_NOT_FOUND" })
		await a.close()
	})
})
