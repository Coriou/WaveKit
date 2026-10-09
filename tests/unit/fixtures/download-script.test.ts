import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
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

function sha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}
function runDownload(
	manifest: string,
	outDir: string,
	extraEnv: Record<string, string> = {},
	args: string[] = [],
) {
	return spawnSync("bash", [resolve("fixtures/download.sh"), ...args], {
		encoding: "utf8",
		timeout: 30000,
		env: {
			...process.env,
			WAVEKIT_FIXTURES_MANIFEST: manifest,
			WAVEKIT_FIXTURES_DIR: outDir,
			...extraEnv,
		},
	})
}

describe("download.sh v2", () => {
	it("fetches a public raw file and verifies both hashes", () => {
		const src = mkdtempSync(join(tmpdir(), "wk-src-"))
		const raw = join(src, "tone.cu8")
		writeFileSync(raw, Buffer.from([127, 128, 129, 130]))
		const digest = sha(raw)
		const { path, dir } = tempManifest([
			{
				id: "tone",
				fetch: { kind: "public", url: `file://${raw}`, archive_sha256: digest },
				file: "raw/tone.cu8",
				sha256: digest,
			},
		])
		const r = runDownload(path, dir)
		expect(r.status, r.stdout + r.stderr).toBe(0)
		expect(sha(join(dir, "raw/tone.cu8"))).toBe(digest)
	})
	it("refuses a file whose sha256 does not match and leaves no target", () => {
		const src = mkdtempSync(join(tmpdir(), "wk-src-"))
		const raw = join(src, "tone.cu8")
		writeFileSync(raw, Buffer.from([1, 2]))
		const { path, dir } = tempManifest([
			{
				id: "tone",
				fetch: {
					kind: "public",
					url: `file://${raw}`,
					archive_sha256: sha(raw),
				},
				file: "raw/tone.cu8",
				sha256: "0".repeat(64),
			},
		])
		const r = runDownload(path, dir)
		expect(r.status).toBe(1)
		expect(r.stdout + r.stderr).toMatch(/sha256 mismatch/)
		expect(existsSync(join(dir, "raw/tone.cu8"))).toBe(false)
	})
	it("copies private fixtures from WAVEKIT_PRIVATE_FIXTURES_DIR and skips without it", () => {
		const priv = mkdtempSync(join(tmpdir(), "wk-priv-"))
		writeFileSync(join(priv, "own.cu8"), Buffer.from([10, 20]))
		const digest = sha(join(priv, "own.cu8"))
		const { path, dir } = tempManifest([
			{
				id: "own",
				fetch: { kind: "private" },
				file: "raw/own.cu8",
				sha256: digest,
			},
		])
		const skipped = runDownload(path, dir)
		expect(skipped.status).toBe(0)
		expect(skipped.stdout + skipped.stderr).toMatch(
			/WAVEKIT_PRIVATE_FIXTURES_DIR/,
		)
		const fetched = runDownload(path, dir, {
			WAVEKIT_PRIVATE_FIXTURES_DIR: priv,
		})
		expect(fetched.status, fetched.stderr).toBe(0)
		expect(sha(join(dir, "raw/own.cu8"))).toBe(digest)
	})
	it("skips large fixtures unless --all", () => {
		const { path, dir } = tempManifest([
			{
				id: "big",
				fetch: {
					kind: "public",
					url: "file:///nonexistent",
					archive_sha256: "1".repeat(64),
				},
				file: "raw/big.cu8",
				sha256: "1".repeat(64),
				large: true,
			},
		])
		mkdirSync(join(dir, "raw"), { recursive: true })
		expect(runDownload(path, dir).status).toBe(0)
		expect(runDownload(path, dir, {}, ["--all"]).status).toBe(1)
		// --all must not imply --rtl433: no git clone in unit tests
		expect(existsSync(join(dir, "raw/rtl_433_tests"))).toBe(false)
	})
})
