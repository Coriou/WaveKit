import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, it, expect } from "vitest"

export function tempManifest(fixtures: unknown[]): {
	dir: string
	path: string
} {
	const dir = mkdtempSync(join(tmpdir(), "wk-fixtures-"))
	const path = join(dir, "manifest.yaml")
	writeFileSync(path, JSON.stringify({ version: 2, fixtures, candidates: [] }))
	return { dir, path }
}

describe("manifest-query.mjs", () => {
	it("lists fixtures with pipe-separated fetch fields", () => {
		const { path } = tempManifest([
			{
				id: "a_fix",
				fetch: { kind: "private" },
				file: "raw/a.cu8",
				sha256: "b".repeat(64),
			},
		])
		const r = spawnSync(
			"node",
			[resolve("fixtures/manifest-query.mjs"), "list"],
			{
				encoding: "utf8",
				env: { ...process.env, WAVEKIT_FIXTURES_MANIFEST: path },
			},
		)
		expect(r.status, r.stderr).toBe(0)
		expect(r.stdout.trim()).toBe(
			`a_fix|private|||none|raw/a.cu8|${"b".repeat(64)}||false`,
		)
	})
	it("rejects a v1 manifest", () => {
		const { dir } = tempManifest([])
		const path = join(dir, "v1.yaml")
		writeFileSync(path, "version: 1\nfixtures: []\n")
		const r = spawnSync(
			"node",
			[resolve("fixtures/manifest-query.mjs"), "list"],
			{
				encoding: "utf8",
				env: { ...process.env, WAVEKIT_FIXTURES_MANIFEST: path },
			},
		)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toMatch(/version 2/)
	})
})
