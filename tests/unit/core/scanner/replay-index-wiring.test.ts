// WG11 req 6.1: the composition root only creates the
// capture service (protected mode, scanner.iqCapture.enabled) and passes it to the scanner, which
// owns the replay queue. No shutdown handler is added, wrapped or replaced, and no new call path
// from the entry point reaches the scanner service (the built-entry fixtures stub it).
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(
	new URL("../../../../src/index.ts", import.meta.url),
	"utf8",
)

describe("index IQ capture wiring", () => {
	it("adds no shutdown handler (the shutdown sequence and its logs stay unchanged)", () => {
		expect(source).not.toContain('name: "iq-capture"')
	})

	it("never calls the scanner's replay surface or builds the queue itself", () => {
		for (const call of [
			"replayProbes(",
			"planReplay(",
			"applyReplayResult(",
			"replayPlanInput(",
			"setReplayRecheck(",
			"replaySkip(",
			"createIqReplayQueue",
		])
			expect(source).not.toContain(call)
	})

	it("creates the service only with scanner.iqCapture.enabled in protected mode, owned at 45", () => {
		const create = source.indexOf("createIqCaptureService({")
		const cond = source.lastIndexOf(
			"if (config.scanner.iqCapture?.enabled)",
			create,
		)
		const mode = source.lastIndexOf("if (protectedMode)", create)
		expect(cond).toBeGreaterThan(0)
		expect(mode).toBeGreaterThan(cond)
		expect(source.indexOf("own(45, () => service.stop())")).toBeGreaterThan(
			create,
		)
	})
})
