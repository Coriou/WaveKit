#!/usr/bin/env node
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const [mode, ...flags] = process.argv.slice(2)
if (
	!["local", "rtl", "pi"].includes(mode) ||
	flags.some(flag => flag !== "--watch")
) {
	console.error("Usage: node scripts/run-local.mjs <local|rtl|pi> [--watch]")
	process.exit(1)
}

const root = fileURLToPath(new URL("../", import.meta.url))
const config = fileURLToPath(
	new URL(
		`../config/${mode === "rtl" ? "local-rtl" : mode}.yaml`,
		import.meta.url,
	),
)
const child = spawn("pnpm", [flags.includes("--watch") ? "dev" : "start"], {
	cwd: root,
	env: { ...process.env, WAVEKIT_CONFIG: process.env.WAVEKIT_CONFIG || config },
	stdio: "inherit",
	detached: process.platform !== "win32",
})
child.on("error", error => {
	console.error(`Could not start pnpm: ${error.message}`)
	process.exitCode = 1
})
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		try {
			if (process.platform !== "win32" && child.pid) {
				// Stop the build/watch/app process group as well as the pnpm wrapper.
				process.kill(-child.pid, signal)
			} else {
				child.kill(signal)
			}
		} catch (error) {
			if (error.code !== "ESRCH") throw error
		}
	})
}
child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1)
})
