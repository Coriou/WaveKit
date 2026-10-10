import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

interface Step {
	name?: string
	uses?: string
	run?: string
	with?: Record<string, unknown>
}
const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
	jobs: Record<string, { steps: Step[] }>
}

describe("CI workflow", () => {
	it("provides pinned Python and numpy before the tests (fixture composer tests; final review infra I3)", () => {
		const steps = ci.jobs["lint-typecheck-test"]!.steps
		const python = steps.findIndex(s =>
			s.uses?.startsWith("actions/setup-python@"),
		)
		const numpy = steps.findIndex(s =>
			/pip install numpy==2\.\d+\.\d+/.test(s.run ?? ""),
		)
		const test = steps.findIndex(s => s.run === "pnpm test")
		expect(python).toBeGreaterThanOrEqual(0)
		expect(String(steps[python]!.with?.["python-version"])).toMatch(/^3\.\d+$/)
		expect(numpy).toBeGreaterThan(python)
		expect(test).toBeGreaterThan(numpy)
	})
})
