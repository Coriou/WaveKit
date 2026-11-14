#!/usr/bin/env node
// Looks at the web app the way a person would, for an agent: starts the dev server against an
// isolated fake core (or attaches to a preview, Main only), pairs a headless browser, loads a
// route and reports console errors, failed requests, the spectrum's health and whether the plot
// and waterfall are drawn and moving. See docs/AGENT-SETUP.md "Looking at the web app".
//
// The work is in web/tests/live-core/ui-check.ts (it shares the test suites' core harness and
// browser helpers); this file only runs it with Node's type stripping.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const web = fileURLToPath(new URL("../web/", import.meta.url))
const entry = fileURLToPath(
	new URL("../web/tests/live-core/ui-check.ts", import.meta.url),
)
const child = spawn(
	process.execPath,
	[
		"--experimental-strip-types",
		"--no-warnings",
		entry,
		...process.argv.slice(2),
	],
	{ cwd: web, stdio: "inherit" },
)
child.on("error", () => process.exit(2))
child.on("exit", code => process.exit(code ?? 2))
