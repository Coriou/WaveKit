import { afterEach, beforeEach, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wavekit imager "))
})
afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

function run(entries: object[]) {
	const manifest = join(dir, "os-list.json")
	writeFileSync(manifest, JSON.stringify({ os_list: entries }))
	return spawnSync(
		process.execPath,
		[
			resolve("packages/sdr-host/scripts/open-pi-imager.mjs"),
			"--manifest",
			manifest,
			"--dry-run",
		],
		{ encoding: "utf8" },
	)
}
function entry() {
	const image = join(dir, "image with spaces.img.xz")
	writeFileSync(image, "fixture")
	return {
		name: "WaveKit SDR host",
		init_format: "cloudinit-rpi",
		url: pathToFileURL(image).href,
		extract_sha256: "a".repeat(64),
	}
}

it("launches the dedicated catalog with paths preserved as arguments", () => {
	const result = run([entry()])
	expect(result.status, result.stderr).toBe(0)
	const launch = JSON.parse(result.stdout)
	expect(launch.args.slice(-2)).toEqual([
		"--repo",
		pathToFileURL(join(dir, "os-list.json")).href,
	])
	if (process.platform === "darwin")
		expect(launch.args.slice(0, 4)).toEqual([
			"-n",
			"-a",
			"Raspberry Pi Imager",
			"--args",
		])
})

it("rejects catalogs that would lose customization or show unrelated images", () => {
	expect(run([{ ...entry(), init_format: "none" }]).status).toBe(1)
	expect(run([entry(), entry()]).status).toBe(1)
})

it("rejects missing images and unverified catalogs before launch", () => {
	expect(
		run([{ ...entry(), url: pathToFileURL(join(dir, "missing.img.xz")).href }])
			.status,
	).toBe(1)
	expect(run([{ ...entry(), extract_sha256: "" }]).status).toBe(1)
})
