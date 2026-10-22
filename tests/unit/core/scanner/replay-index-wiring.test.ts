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

	it("shares the guarded service with on-demand trials and owns it at 45", () => {
		const create = source.indexOf("createIqCaptureService({")
		expect(create).toBeGreaterThan(0)
		expect(source).toContain("trialOnly: !config.scanner.iqCapture?.enabled")
		expect(source.slice(create)).toContain("protectedMode,")
		expect(source.indexOf("own(45, () => service.stop())")).toBeGreaterThan(
			create,
		)
		expect(source).toContain("createAnalogLiveRunner(")
	})
})
