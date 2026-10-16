#!/usr/bin/env node
// Syncs the design canvas Kit board with the UI kit source, packages/brand/tokens/ui.css.
//
// The Kit board carries ui.css verbatim between `/* wk-ui begin */` and `/* wk-ui end */`
// in its helmet; every other board imports it. This script rewrites that section from
// ui.css. The canvas stays the design source: after a sync, publish the Kit board to the
// canvas and snapshot it into docs/web/canvas/.
//
// Usage: node scripts/web-canvas-kit.mjs <Kit.dc.html> [--check]
//   --check  report only; exit 1 when the board's kit section differs from ui.css
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const BEGIN = "/* wk-ui begin */\n"
const END = "/* wk-ui end */"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const check = args.includes("--check")
const board = args.find(arg => !arg.startsWith("--"))

if (!board) {
	process.stderr.write(
		"usage: node scripts/web-canvas-kit.mjs <Kit.dc.html> [--check]\n",
	)
	process.exit(2)
}

const kit = readFileSync(join(root, "packages/brand/tokens/ui.css"), "utf8")
const text = readFileSync(board, "utf8")
const start = text.indexOf(BEGIN)
const end = text.indexOf(END, start)
if (start < 0 || end < 0) {
	process.stderr.write(`${board}: no ${BEGIN.trim()} … ${END} section\n`)
	process.exit(1)
}

const synced = text.slice(0, start + BEGIN.length) + kit + text.slice(end)
if (check) {
	if (synced !== text) {
		process.stderr.write(
			`${board}: kit section differs from packages/brand/tokens/ui.css\n`,
		)
		process.exit(1)
	}
	process.stdout.write(`${board}: in sync\n`)
} else if (synced === text) {
	process.stdout.write(`${board}: already in sync\n`)
} else {
	writeFileSync(board, synced)
	process.stdout.write(`${board}: kit section updated\n`)
}
