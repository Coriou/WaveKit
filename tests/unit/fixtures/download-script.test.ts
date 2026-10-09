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
			`a_fix|private|||none|raw/a.cu8|${"b".repeat(64)}||false|`,
		)
	})
	it("lists a generated fixture's recipe in the last column (channelizer T7a)", () => {
		const { path } = tempManifest([
			{
				id: "g_fix",
				fetch: { kind: "generated", recipe: "recipes/g_fix.json" },
				file: "raw/g_fix.cu8",
				sha256: "c".repeat(64),
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
			`g_fix|generated|||none|raw/g_fix.cu8|${"c".repeat(64)}||false|recipes/g_fix.json`,
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
/** A tiny recipe: one file:// cu8 tone source composed at 256 kS/s for 20 ms. */
function generatedSetup(sourceSha?: string) {
	const src = mkdtempSync(join(tmpdir(), "wk-src-"))
	const tone = join(src, "tone.cu8")
	const n = 640
	const bytes = Buffer.alloc(2 * n)
	for (let i = 0; i < n; i++) {
		bytes[2 * i] = Math.round(128 + 60 * Math.cos((2 * Math.PI * i) / 16))
		bytes[2 * i + 1] = Math.round(128 + 60 * Math.sin((2 * Math.PI * i) / 16))
	}
	writeFileSync(tone, bytes)
	const recipe = {
		id: "unit_gen",
		sampleRate: 256_000,
		centerHz: 100_000_000,
		durationS: 0.02,
		seed: 3,
		noiseDbfs: -40,
		sources: [
			{
				id: "tone",
				url: `file://${tone}`,
				sha256: sourceSha ?? sha(tone),
				format: "cu8",
				sampleRate: 32_000,
				license: "test",
			},
		],
		components: [{ name: "t", source: "tone", offsetHz: 50_000, levelDb: -10 }],
	}
	const { path, dir } = tempManifest([])
	mkdirSync(join(dir, "recipes"))
	writeFileSync(join(dir, "recipes/unit_gen.json"), JSON.stringify(recipe))
	return { path, dir, src, tone }
}
function composeDirect(dir: string, src: string): string {
	const out = join(dir, "direct.cu8")
	const r = spawnSync(
		"python3",
		[
			"-I",
			resolve("fixtures/compose.py"),
			join(dir, "recipes/unit_gen.json"),
			"--out",
			out,
			"--sources-dir",
			src,
		],
		{ encoding: "utf8", timeout: 30000 },
	)
	expect(r.status, r.stderr).toBe(0)
	return sha(out)
}
function generatedManifest(path: string, digest: string) {
	writeFileSync(
		path,
		JSON.stringify({
			version: 2,
			fixtures: [
				{
					id: "unit_gen",
					fetch: { kind: "generated", recipe: "recipes/unit_gen.json" },
					file: "raw/unit_gen.cu8",
					sha256: digest,
				},
			],
			candidates: [],
		}),
	)
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
	it("regenerates a generated fixture from its fetched sources and verifies it (channelizer T7a)", () => {
		const { path, dir, src } = generatedSetup()
		generatedManifest(path, composeDirect(dir, src))
		const r = runDownload(path, dir)
		expect(r.status, r.stdout + r.stderr).toBe(0)
		expect(sha(join(dir, "raw/unit_gen.cu8"))).toBe(
			sha(join(dir, "direct.cu8")),
		)
		expect(sha(join(dir, "raw/.sources/tone.cu8"))).toBe(
			sha(join(src, "tone.cu8")),
		)
		const sidecar = JSON.parse(
			readFileSync(join(dir, "raw/unit_gen.cu8.json"), "utf8"),
		) as { sha256: string; components: { absoluteHz: number }[] }
		expect(sidecar.sha256).toBe(sha(join(dir, "raw/unit_gen.cu8")))
		expect(sidecar.components[0]?.absoluteHz).toBe(100_050_000)
		const again = runDownload(path, dir)
		expect(again.stdout).toMatch(/present and verified/)
	})
	it("refuses a generated fixture whose source or output sha256 does not match", () => {
		const bad = generatedSetup("0".repeat(64))
		generatedManifest(bad.path, "1".repeat(64))
		const r = runDownload(bad.path, bad.dir)
		expect(r.status).toBe(1)
		expect(r.stdout + r.stderr).toMatch(/source tone: sha256 mismatch/)
		expect(existsSync(join(bad.dir, "raw/unit_gen.cu8"))).toBe(false)
		const good = generatedSetup()
		generatedManifest(good.path, "2".repeat(64))
		const out = runDownload(good.path, good.dir)
		expect(out.status).toBe(1)
		expect(out.stdout + out.stderr).toMatch(/sha256 mismatch/)
		expect(existsSync(join(good.dir, "raw/unit_gen.cu8"))).toBe(false)
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
