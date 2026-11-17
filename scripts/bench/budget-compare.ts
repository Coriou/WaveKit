/**
 * Compare two main-thread budget manifests (measurement only, never a CI gate).
 *
 *   node output/bench/budget-compare.mjs A/manifest.json B/manifest.json [--allow-coverage-diff]
 *
 * Prints a Markdown before/after table of the CPU-time and count figures, and of the timing
 * figures (ELU, loop delay, long tasks) only when both manifests are timing-valid. Refuses, exit
 * 2, when the scene, rate, tier or composition differ, when the window lengths differ by more
 * than 2 %, or when the coverage classes missing or unknown differ (unless
 * --allow-coverage-diff, which prints a note naming them). Exit 1 on an unreadable manifest.
 */
import { readFileSync } from "node:fs"
import process from "node:process"
import {
	compareManifests,
	formatComparison,
	type Manifest,
	ManifestSchema,
} from "./budget-manifest.js"

function load(path: string): Manifest | string {
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, "utf8"))
	} catch (err) {
		return `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`
	}
	const parsed = ManifestSchema.safeParse(raw)
	if (!parsed.success)
		return `${path} is not a budget manifest: ${parsed.error.issues
			.slice(0, 3)
			.map(i => `${i.path.join(".")}: ${i.message}`)
			.join("; ")}`
	return parsed.data
}

function main(): void {
	const args = process.argv.slice(2)
	const allowCoverageDiff = args.includes("--allow-coverage-diff")
	const [pathA, pathB] = args.filter(x => !x.startsWith("--"))
	if (pathA === undefined || pathB === undefined) {
		process.stderr.write(
			"usage: budget-compare A/manifest.json B/manifest.json [--allow-coverage-diff]\n",
		)
		process.exitCode = 1
		return
	}
	const a = load(pathA)
	const b = load(pathB)
	for (const m of [a, b])
		if (typeof m === "string") {
			process.stderr.write(`${m}\n`)
			process.exitCode = 1
			return
		}
	if (typeof a === "string" || typeof b === "string") return
	const result = compareManifests(a, b, { allowCoverageDiff })
	if (!result.ok) {
		process.stdout.write(`Not comparable: ${result.refusal}\n`)
		process.exitCode = 2
		return
	}
	process.stdout.write(formatComparison(a, b, result))
}

main()
