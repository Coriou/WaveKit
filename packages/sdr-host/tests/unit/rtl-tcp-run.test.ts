import { it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const service = fileURLToPath(
	new URL(
		"../../docker/overlay/s6-overlay/s6-rc.d/rtl-tcp/run",
		import.meta.url,
	),
)

it.each([
	{ configured: undefined, expected: "15" },
	{ configured: "invalid", expected: "15" },
	{ configured: "31", expected: "31" },
])(
	"passes a safe default or explicit USB buffer count: $configured",
	({ configured, expected }) => {
		const directory = mkdtempSync(join(tmpdir(), "wavekit-rtl-tcp-"))
		try {
			// Print the arguments rather than accessing hardware.
			writeFileSync(
				join(directory, "rtl_tcp"),
				'#!/bin/sh\nprintf "%s\\n" "$@"\n',
				{ mode: 0o755 },
			)
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PATH: `${directory}:${process.env["PATH"] ?? ""}`,
			}
			for (const key of Object.keys(env))
				if (key.startsWith("SDR_HOST_")) delete env[key]
			if (configured !== undefined) env["SDR_HOST_RTL_TCP__BUFFER"] = configured
			const args = execFileSync("sh", [service], {
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			})
				.trim()
				.split("\n")
			expect(args[args.indexOf("-b") + 1]).toBe(expected)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	},
)
