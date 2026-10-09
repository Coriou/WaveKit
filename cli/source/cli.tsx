#!/usr/bin/env node
/** WaveKit CLI entry point. `wavekit --help` lists views, options and env vars. */
import { render } from "ink"
import { App } from "./app.js"
import { helpText, parseArgs } from "./args.js"
import { resolveExplicit, type ApiTarget } from "./data/config.js"
import { createRuntime, nodeRuntimeDeps } from "./data/runtime.js"
import {
	createScreen,
	createShutdown,
	installExitHandlers,
} from "./terminal.js"
import { formatMessage } from "./ui/messages/index.js"
import { detectColor, detectGlyphMode, setGlyphMode } from "./ui/theme.js"
import { VIEWS } from "./views/registry.js"

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

let explicit: ApiTarget | null
try {
	explicit = resolveExplicit(parsed.api, process.env)
} catch (err: unknown) {
	process.stderr.write(
		`wavekit: ${err instanceof Error ? err.message : String(err)}\n`,
	)
	process.exit(2)
}

// The UI owns the terminal. React reports errors caught by the boundary (which
// already shows them as one line) through the console error method, and any write
// would land on the alternate screen and corrupt the frame, so all are dropped.
const drop = (): void => undefined
for (const m of [
	"log",
	"info",
	"warn",
	"error",
	"debug",
	"trace",
	"dir",
	"dirxml",
	"table",
	"group",
	"groupCollapsed",
	"groupEnd",
	"count",
	"assert",
	"timeLog",
	"timeEnd",
] as const)
	console[m] = drop

const runtime = createRuntime(nodeRuntimeDeps(explicit, formatMessage))
const screen = createScreen(process.stdout)
let instance: ReturnType<typeof render> | null = null
const shutdown = createShutdown({
	unmount: () => {
		runtime.stop()
		instance?.unmount()
	},
	screen,
	stderr: process.stderr,
	exit: code => process.exit(code),
})
// Handlers first, so a crash during enter() or the first render still restores the screen.
installExitHandlers(process, screen, shutdown)
screen.enter()
runtime.start()
instance = render(
	<App
		runtime={runtime}
		views={VIEWS}
		initialView={parsed.view}
		color={detectColor(process.env, process.stdout.isTTY === true)}
	/>,
	{ exitOnCtrlC: false, patchConsole: false },
)
void instance.waitUntilExit().then(() => shutdown(0))
