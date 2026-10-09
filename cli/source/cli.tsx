#!/usr/bin/env node
/**
 * WaveKit CLI entry point. React and Ink pick their build when first loaded, and
 * static imports load before any statement runs, so NODE_ENV is set here and the
 * app is imported afterwards: the production build renders several times cheaper
 * than the development one (D3).
 */
process.env["NODE_ENV"] ??= "production"
import("./main.js").catch((err: unknown) => {
	process.stderr.write(
		`wavekit: ${err instanceof Error ? err.message : String(err)}\n`,
	)
	process.exit(1)
})
