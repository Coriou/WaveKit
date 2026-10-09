import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	mkdirSync,
	copyFileSync,
	realpathSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { writeExecutable } from "../../mocks/executables.js"

// Every test spawns real subprocesses (node/bash); their wall time scales with
// host load and suite parallelism, so allow headroom beyond the 5 s default.
vi.setConfig({ testTimeout: 15000 })

let dir: string
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "wavekit imager ")))
})
afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

function run(entries: object[], launchWith?: string) {
	const manifest = join(dir, "os-list.json")
	writeFileSync(manifest, JSON.stringify({ os_list: entries }))
	return spawnSync(
		process.execPath,
		[
			resolve("packages/sdr-host/scripts/open-pi-imager.mjs"),
			"--manifest",
			manifest,
			...(launchWith
				? ["--executable", launchWith]
				: ["--executable", process.execPath, "--dry-run"]),
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
	expect(launch.args.slice(-2)).toEqual(["--repo", join(dir, "os-list.json")])
	expect(launch.command).not.toBe("open")
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

function fakeImager(body: string) {
	const executable = join(dir, "fake imager")
	writeExecutable(executable, `#!/bin/sh\n${body}\n`)
	return executable
}

it("reports actual Imager startup failures and preserves diagnostics", () => {
	const result = run([entry()], fakeImager('echo "startup failed" >&2; exit 7'))
	expect(result.status).toBe(7)
	expect(result.stderr).toContain("startup failed")
	expect(result.stderr).toContain("Imager failed (exit 7)")
})

it("reports a crashed Imager as a failure", () => {
	const result = run([entry()], fakeImager("kill -TERM $$"))
	expect(result.status).toBe(1)
	expect(result.stderr).toContain("signal SIGTERM")
})

it("does not claim GUI or card acceptance from a successful exit", () => {
	const result = run([entry()], fakeImager("exit 0"))
	expect(result.status).toBe(0)
	expect(result.stdout).toContain("does not verify a window appeared")
})

it("reports a missing executable as a launch failure", () => {
	const result = run([entry()], join(dir, "missing imager"))
	expect(result.status).toBe(1)
	expect(result.stderr).toContain("Cannot launch Raspberry Pi Imager")
})

function defaultLauncher(pointer?: string) {
	const script = join(dir, "packages/sdr-host/scripts/open-pi-imager.mjs")
	mkdirSync(join(dir, "packages/sdr-host/scripts"), { recursive: true })
	copyFileSync(resolve("packages/sdr-host/scripts/open-pi-imager.mjs"), script)
	for (const name of ["pi-image", "operator-next"]) {
		const target = join(dir, "output", name)
		mkdirSync(target, { recursive: true })
		writeFileSync(
			join(target, "os-list.json"),
			JSON.stringify({ os_list: [entry()] }),
		)
	}
	if (pointer !== undefined)
		writeFileSync(join(dir, "output/pi-image-current.json"), pointer)
	return (args: string[] = []) =>
		spawnSync(
			process.execPath,
			[script, "--executable", process.execPath, "--dry-run", ...args],
			{ encoding: "utf8" },
		)
}

it("defaults to the promoted image while retaining the older catalog", () => {
	const launch = defaultLauncher(
		JSON.stringify({ manifest: "operator-next/os-list.json" }),
	)
	const result = launch()
	expect(result.status, result.stderr).toBe(0)
	expect(JSON.parse(result.stdout).args).toEqual([
		"--repo",
		join(dir, "output/operator-next/os-list.json"),
	])
})

it("uses the legacy default before any promotion", () => {
	const result = defaultLauncher()()
	expect(result.status, result.stderr).toBe(0)
	expect(JSON.parse(result.stdout).args).toEqual([
		"--repo",
		join(dir, "output/pi-image/os-list.json"),
	])
})

it("fails closed for a broken current selection while allowing an explicit older image", () => {
	const launch = defaultLauncher(
		JSON.stringify({ manifest: "missing/os-list.json" }),
	)
	expect(launch().status).toBe(1)
	const result = launch([
		"--manifest",
		join(dir, "output/pi-image/os-list.json"),
	])
	expect(result.status, result.stderr).toBe(0)
	expect(JSON.parse(result.stdout).args).toEqual([
		"--repo",
		join(dir, "output/pi-image/os-list.json"),
	])
})
