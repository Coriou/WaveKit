#!/usr/bin/env node
// Bundles the main-thread budget harness into standalone files under output/bench/
// (everything inlined; runs with plain node 24). Same options as
// scripts/profile-spectrum-build.mjs.
//
//   pnpm run build && node scripts/bench/budget-build.mjs
//   nice -n 10 node output/bench/main-thread-budget.mjs --label base
//   node output/bench/budget-compare.mjs A/manifest.json B/manifest.json
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { kernelDigestPlugin } from "../kernel-digest.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

for (const name of ["main-thread-budget", "budget-compare"]) {
	await build({
		absWorkingDir: root,
		entryPoints: [`scripts/bench/${name}.ts`],
		outfile: fileURLToPath(
			new URL(`../../output/bench/${name}.mjs`, import.meta.url),
		),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		define: { __WAVEKIT_VERSION__: JSON.stringify("bench") },
		// CJS dependencies (pino via @wavekit/shared) need require() inside ESM.
		banner: {
			js: 'import { createRequire as __pfCreateRequire } from "node:module"\nconst require = __pfCreateRequire(import.meta.url)',
		},
		plugins: [kernelDigestPlugin()],
		logLevel: "warning",
	})
	process.stdout.write(`built output/bench/${name}.mjs\n`)
}
