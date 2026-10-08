#!/usr/bin/env node
/**
 * WaveKit CLI entry point. `wavekit --help` lists views, options and env vars.
 * Phase 1: renders the legacy App until the new shell replaces it (Task 37).
 */
import { render } from "ink"
import { App as LegacyApp } from "./app.js"
import { helpText, parseArgs } from "./args.js"
import { resolveExplicit } from "./data/config.js"
import { createScreen, installExitHandlers } from "./terminal.js"
import type { ViewId } from "./ui/actions.js"
import { detectGlyphMode, setGlyphMode } from "./ui/theme.js"

const LEGACY_VIEW: Record<
	ViewId,
	"dashboard" | "decoders" | "output" | "sources" | "resources"
> = {
	overview: "dashboard",
	decoders: "decoders",
	messages: "output",
	receiver: "sources",
	system: "resources",
}

// Glyph mode first, so help and usage errors honour WAVEKIT_ASCII and the locale.
setGlyphMode(detectGlyphMode(process.env))
const parsed = parseArgs(process.argv.slice(2))
if (parsed.kind === "help") {
	process.stdout.write(helpText())
	process.exit(0)
}
if (parsed.kind === "error") {
	process.stderr.write(`${parsed.message}\n`)
	process.exit(2)
}
try {
	const target = resolveExplicit(parsed.api, process.env)
	if (target) {
		// The legacy App reads only env vars; hand it the resolved target (removed with the legacy App).
		process.env["WAVEKIT_API_URL"] = target.base
		process.env["WAVEKIT_WS_URLS"] = target.ws
		process.env["WAVEKIT_WS_URL"] = target.ws
	}
} catch (err: unknown) {
	process.stderr.write(
		`wavekit: ${err instanceof Error ? err.message : String(err)}\n`,
	)
	process.exit(2)
}

const screen = createScreen(process.stdout)
screen.enter()
const instance = render(<LegacyApp initialView={LEGACY_VIEW[parsed.view]} />)
let done = false
const shutdown = (code: number): void => {
	if (done) return
	done = true
	instance.unmount()
	screen.restore()
	process.exit(code)
}
installExitHandlers(process, screen, shutdown)
void instance.waitUntilExit().then(() => shutdown(0))
