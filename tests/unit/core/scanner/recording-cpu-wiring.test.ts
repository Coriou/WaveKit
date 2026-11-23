/**
 * The production composition gives the scanner the efficiency gate's CPU reading. ScannerService
 * cannot derive it: its `cpuMeter` dep is the host CpuMeter (host percent only, no own cores, no
 * capacity, no guard), and the gate that classifies own CPU is built in src/index.ts. Without the
 * `recordingCpu` dep every source records at the floor of 2 forever, so the core's
 * `new ScannerService({ ... })` must pass it, read on the gate's own clock (the monitor's
 * monotonic clock its samples are stamped with), or a fresh reading would read as stale.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const indexSource = readFileSync(
	join(import.meta.dirname, "../../../../src/index.ts"),
	"utf8",
)

/** The object literal given to `new ScannerService(`, by brace matching. */
function scannerDeps(source: string): string {
	const start = source.indexOf("new ScannerService({")
	expect(start).toBeGreaterThanOrEqual(0)
	const open = source.indexOf("{", start)
	let depth = 0
	for (let i = open; i < source.length; i++) {
		const c = source[i]
		if (c === "{") depth++
		else if (c === "}") {
			depth--
			if (depth === 0) return source.slice(open, i + 1)
		}
	}
	throw new Error("unbalanced ScannerService deps")
}

describe("the core wires the recording CPU reading into the scanner", () => {
	it("passes recordingCpu from the efficiency gate's cpuState on the monitor's clock", () => {
		const deps = scannerDeps(indexSource)
		expect(deps).toMatch(
			/recordingCpu:\s*\(\)\s*=>\s*gate\.cpuState\?\.\(\s*monitor\.monoNow\(\)\s*\)\s*\?\?\s*null/,
		)
	})
})
