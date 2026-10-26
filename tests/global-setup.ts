import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Own all worker/subprocess temporary files, including tests without local cleanup. */
export default function setup(): (() => void) | undefined {
	// For measuring fixture cleanup independently of this guard.
	if (process.env["WAVEKIT_TEST_TMP_GUARD"] === "0") return
	const keys = ["TMPDIR", "TMP", "TEMP", "WAVEKIT_TEST_TMP_ROOT"] as const
	const previous = keys.map(key => [key, process.env[key]] as const)
	const root = mkdtempSync(join(tmpdir(), "wk-test-"))
	const keep = process.env["WAVEKIT_TEST_KEEP_TMP"] === "1"
	for (const key of keys) process.env[key] = root

	return () => {
		try {
			const entries = readdirSync(root)
			const prefixes = new Map<string, number>()
			for (const entry of entries) {
				const prefix = entry.replace(/[A-Za-z0-9]{6}$/, "*")
				prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1)
			}
			const top = [...prefixes]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, 10)
				.map(([prefix, count]) => `${prefix}: ${count}`)
				.join(", ")
			console.warn(
				`[test tmp] ${entries.length} entries left in ${root} (${top || "none"})${keep ? "; retained for inspection" : ""}`,
			)
		} finally {
			try {
				if (!keep) rmSync(root, { recursive: true, force: true })
			} finally {
				for (const [key, value] of previous) {
					if (value === undefined) delete process.env[key]
					else process.env[key] = value
				}
			}
		}
	}
}
