import { afterEach, describe, expect, it, vi } from "vitest"
import { AnalogAdmission } from "../../../../src/core/scanner/analog-admission.js"
import type { AnalogTrialResult } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { WaveKitError } from "../../../../src/utils/errors.js"

const result: AnalogTrialResult = {
	outcome: "carrier-only",
	mode: "nfm",
	voice: false,
	tones: { ctcssHz: null, dcs: null, audioSeconds: 1 },
	stats: null,
}

afterEach(() => vi.useRealTimers())

describe("shared analog admission", () => {
	it.each(["done", "error", "throw", "cancel", "timeout", "stop"])(
		"releases the slot and cores on %s, even if the runner never settles",
		async terminal => {
			vi.useFakeTimers()
			let resolve!: (value: AnalogTrialResult) => void
			let reject!: (error: unknown) => void
			const release = vi.fn()
			const run = vi.fn(() => {
				if (terminal === "throw")
					throw new WaveKitError("trial failed", "TRIAL_FAILED")
				return new Promise<AnalogTrialResult>((yes, no) => {
					resolve = yes
					reject = no
				})
			})
			const gate = new AnalogAdmission({ run }, () => release)
			const abort = new AbortController()
			const pending = gate.run("capture", "nfm", abort.signal)
			const outcome = pending.then(
				value => value,
				() => null,
			)
			await Promise.resolve()
			if (terminal === "done") resolve(result)
			if (terminal === "error")
				reject(new WaveKitError("trial failed", "TRIAL_FAILED"))
			if (terminal === "cancel") abort.abort()
			if (terminal === "timeout") {
				setTimeout(() => abort.abort(), 5000)
				await vi.advanceTimersByTimeAsync(5000)
			}
			if (terminal === "stop") gate.stop()
			await outcome
			expect(release).toHaveBeenCalledOnce()
			if (terminal !== "stop") {
				const next = gate.reserve(0.05)
				expect(next).not.toBeNull()
				next?.()
			}
			if (
				terminal === "cancel" ||
				terminal === "timeout" ||
				terminal === "stop"
			) {
				resolve(result)
				await Promise.resolve()
				expect(release).toHaveBeenCalledTimes(terminal === "stop" ? 1 : 2)
			}
		},
	)

	it("waits for the shared budget without starting a runner and cancels while waiting", async () => {
		vi.useFakeTimers()
		let available = false
		const run = vi.fn(() => Promise.resolve(result))
		const release = vi.fn()
		const gate = new AnalogAdmission({ run }, () =>
			available ? release : null,
		)
		const abort = new AbortController()
		const pending = gate.run("waiting", "nfm", abort.signal)
		await vi.advanceTimersByTimeAsync(50)
		expect(run).not.toHaveBeenCalled()
		abort.abort()
		expect((await pending).error).toBe("cancelled")
		expect(release).not.toHaveBeenCalled()
		available = true
		await gate.run("next", "nfm", new AbortController().signal)
		expect(run).toHaveBeenCalledOnce()
		expect(release).toHaveBeenCalledOnce()
	})
})

it("private trials use both slots without an offset core reservation and a third can abort while waiting", async () => {
	const releases: (() => void)[] = []
	const reserve = vi.fn(() => null)
	const runLive = vi.fn(
		() =>
			new Promise<AnalogTrialResult>(resolve =>
				releases.push(() => resolve(result)),
			),
	)
	const gate = new AnalogAdmission(
		{ run: () => Promise.resolve(result), runLive },
		reserve,
	)
	const req = {
		sourceId: "src",
		observationId: null,
		epoch: 1,
		rfHz: 100000000,
		fromSample: 0,
		reason: "identify" as const,
		tuningTrust: "commanded" as const,
	}
	const first = gate.runLive!(req, "nfm", new AbortController().signal)
	const second = gate.runLive!(req, "nfm", new AbortController().signal)
	expect(runLive).toHaveBeenCalledTimes(2)
	const ac = new AbortController()
	const third = gate.runLive!(req, "nfm", ac.signal)
	expect(runLive).toHaveBeenCalledTimes(2)
	expect(gate.reserve(0.05)).toBeNull()
	ac.abort()
	expect((await third).error).toBe("cancelled")
	expect(runLive).toHaveBeenCalledTimes(2)
	expect(reserve).not.toHaveBeenCalled()
	releases.shift()?.()
	releases.shift()?.()
	await Promise.all([first, second])
	const fourth = gate.runLive!(req, "nfm", new AbortController().signal)
	expect(runLive).toHaveBeenCalledTimes(3)
	releases.shift()?.()
	await fourth
})

it("admits two private trials on each source and bounds each source independently", async () => {
	vi.useFakeTimers()
	const releases: (() => void)[] = []
	const runLive = vi.fn(
		() =>
			new Promise<AnalogTrialResult>(resolve =>
				releases.push(() => resolve(result)),
			),
	)
	const gate = new AnalogAdmission(
		{ run: async () => result, runLive },
		() => null,
	)
	const ac = new AbortController()
	const pending: Promise<AnalogTrialResult>[] = []
	for (const sourceId of ["a", "b"]) {
		const req = {
			sourceId,
			observationId: null,
			epoch: 1,
			rfHz: 100000000,
			fromSample: 0,
			reason: "identify" as const,
			tuningTrust: "commanded" as const,
		}
		pending.push(
			gate.runLive!(req, "nfm", ac.signal),
			gate.runLive!(req, "nfm", ac.signal),
		)
		pending.push(gate.runLive!(req, "nfm", ac.signal))
	}
	expect(runLive).toHaveBeenCalledTimes(4)
	await vi.advanceTimersByTimeAsync(100)
	expect(runLive).toHaveBeenCalledTimes(4)
	ac.abort()
	for (const release of releases) release()
	await Promise.all(pending)
})
