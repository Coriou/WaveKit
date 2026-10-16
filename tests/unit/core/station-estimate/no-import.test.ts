import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function tsFiles(dir: string): string[] {
	if (!existsSync(dir)) return []
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return tsFiles(path)
		return entry.name.endsWith(".ts") ? [path] : []
	})
}

describe("station estimate isolation (req 2.8)", () => {
	it("is imported by nothing under coverage, station or decoders", () => {
		const files = [
			"src/core/coverage",
			"src/core/station",
			"src/decoders",
		].flatMap(dir => tsFiles(join(process.cwd(), dir)))
		expect(files.length).toBeGreaterThan(0)
		const offenders = files.filter(file =>
			readFileSync(file, "utf8").includes("station-estimate"),
		)
		expect(offenders).toEqual([])
	})
})
