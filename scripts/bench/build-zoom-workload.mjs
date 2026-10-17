#!/usr/bin/env node
// Bundles the zoom workload benchmark into one standalone file:
// output/bench/zoom-workload.mjs (everything inlined; runs with plain node 24).
import { build } from "esbuild"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const outfile = fileURLToPath(
	new URL("../../output/bench/zoom-workload.mjs", import.meta.url),
)

await build({
	absWorkingDir: root,
	entryPoints: ["scripts/bench/zoom-workload.ts"],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	define: { __WAVEKIT_VERSION__: JSON.stringify("bench") },
	// CJS dependencies (pino via @wavekit/shared) need require() inside ESM.
	banner: {
		js: 'import { createRequire as __zmCreateRequire } from "node:module"\nconst require = __zmCreateRequire(import.meta.url)',
	},
	logLevel: "warning",
})
process.stdout.write(`built ${outfile}\n`)
