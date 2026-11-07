/**
 * main() in src/index.ts has no seam for its ApiServer dependencies, so this reads the composition:
 * without it GET /api/diagnostics answers null for the loop delay and the channels.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(
	new URL("../../../src/index.ts", import.meta.url),
	"utf8",
)

describe("diagnostics wiring in src/index.ts", () => {
	const block = /\bdiagnostics: \{[\s\S]*?\n\t{4}\},/.exec(source)?.[0] ?? ""

	it("hands the ApiServer the loop meter's report", () => {
		expect(block).toContain(
			"loopDelay: () => composed.loopMeter.report(monitor.monoNow())",
		)
	})

	it("hands it the channelizer's rows when one is composed", () => {
		expect(block).toMatch(
			/channelizer\s*\?\s*\{ channels: \(\) => channelizer\.openChannelRows\(\) \}/,
		)
	})

	it("is in the ApiServer's dependencies, not its listen options", () => {
		const server = source.indexOf("new ApiServer(")
		const at = source.indexOf(block)
		const options = source.indexOf("host: config.api.host", server)
		expect(at).toBeGreaterThan(server)
		expect(at).toBeLessThan(options)
	})
})
