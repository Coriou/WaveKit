import { describe, expect, it } from "vitest"
import { ResumeActivity } from "../../../../src/core/scanner/auto-resume.js"

const quiet = { audio: false, recording: false, identify: false }
describe("auto resume activity", () => {
	it("clamps an elapsed deadline to now instead of exposing an epoch date", () => {
		const now = Date.parse("2026-10-12T12:00:00Z")
		expect(new ResumeActivity().status(quiet, 0, 1000, now).resumeAt).toBe(
			new Date(now).toISOString(),
		)
	})
	it("uses the existing idle clock when no activity occurs", () => {
		const gate = new ResumeActivity()
		expect(gate.status(quiet, 100, 1000, 500).resumeAt).toBe(
			new Date(1100).toISOString(),
		)
	})
	it("never resumes during audio, then waits hang plus the full idle interval", () => {
		const gate = new ResumeActivity()
		expect(gate.status({ ...quiet, audio: true }, 0, 1000, 5000)).toEqual({
			resumeAt: null,
			resumeHeldBy: "audio",
		})
		expect(gate.status(quiet, 0, 1000, 6000)).toEqual({
			resumeAt: null,
			resumeHeldBy: "audio",
		})
		expect(gate.status(quiet, 0, 1000, 9000)).toEqual({
			resumeAt: new Date(10000).toISOString(),
			resumeHeldBy: null,
		})
	})
	it.each(["recording", "identify"] as const)(
		"restarts a full interval after %s ends",
		kind => {
			const gate = new ResumeActivity()
			expect(
				gate.status({ ...quiet, [kind]: true }, 0, 1000, 5000).resumeHeldBy,
			).toBe(kind)
			expect(gate.status(quiet, 0, 1000, 7000).resumeAt).toBe(
				new Date(8000).toISOString(),
			)
		},
	)
	it("activity that restarts during the hang resets the deadline", () => {
		const gate = new ResumeActivity()
		gate.status({ ...quiet, audio: true }, 0, 1000, 1)
		gate.status(quiet, 0, 1000, 2)
		gate.status({ ...quiet, audio: true }, 0, 1000, 3000)
		gate.status(quiet, 0, 1000, 4000)
		expect(gate.status(quiet, 0, 1000, 7000).resumeAt).toBe(
			new Date(8000).toISOString(),
		)
	})
})
