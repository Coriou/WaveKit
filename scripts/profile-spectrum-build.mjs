#!/usr/bin/env node
// Bundles the spectrum profile harnesses into standalone files under
// output/bench/ (everything inlined; runs with plain node 24).
import { build } from "esbuild"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { kernelDigestPlugin } from "./kernel-digest.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))

for (const name of [
	"profile-spectrum",
	"profile-spectrum-main",
	"profile-frame-path-wasm",
]) {
	if (!existsSync(`${root}scripts/${name}.ts`)) continue
	await build({
		absWorkingDir: root,
		entryPoints: [`scripts/${name}.ts`],
		outfile: fileURLToPath(
			new URL(`../output/bench/${name}.mjs`, import.meta.url),
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
