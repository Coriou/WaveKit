#!/usr/bin/env node
import { build, context } from "esbuild"
import process from "node:process"

const args = process.argv.slice(2)
let watch = false
const entryPoints = []

for (const arg of args) {
	if (arg.startsWith("--watch")) {
		watch = true
		continue
	}
	if (arg.startsWith("-")) continue
	entryPoints.push(arg)
}

if (entryPoints.length === 0) {
	console.error(
		"Missing entry file. Example: pnpm run build-file ./src/index.ts",
	)
	process.exit(1)
}

const options = {
	entryPoints,
	bundle: true,
	outdir: "dist",
	platform: "node",
	format: "esm",
	packages: "external",
}

if (watch) {
	const ctx = await context(options)
	await ctx.watch()
	await new Promise(() => {})
} else {
	await build(options)
}
