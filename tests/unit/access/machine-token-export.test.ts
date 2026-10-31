import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runAccessCommand } from "../../../src/access/command.js"
import { verifyMachineToken } from "../../../src/access/credentials.js"
import { exportMachineToken } from "../../../src/access/machine-token-export.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { setupLocalAccess } from "../../../src/access/setup.js"

const ownership = "single-host-pid-namespace" as const
let root: string
let directory: string
let outDir: string
let out: string

beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "wavekit-machine-token-"))
	await fs.chmod(root, 0o700)
	directory = join(root, "private")
	outDir = join(root, "agent")
	await fs.mkdir(outDir, { mode: 0o700 })
	await fs.chmod(outDir, 0o700)
	out = join(outDir, "machine-token")
})
afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

async function provision(): Promise<void> {
	const result = await setupLocalAccess({ directory, ownership })
	expect(result.kind).toBe("ready")
}

async function storedToken(): Promise<string> {
	return PrivateAccessStorage.readMachineCredential({ directory }, t => t)
}

function command(extra: string[] = []): string[] {
	return [
		"machine-token",
		"--private-directory",
		directory,
		"--out",
		out,
		...extra,
	]
}

/** Captures every stdout, stderr and console write made while `run` executes. */
async function captured<T>(run: () => Promise<T>): Promise<[T, string]> {
	const chunks: string[] = []
	const sink = (chunk: unknown): boolean => {
		chunks.push(String(chunk))
		return true
	}
	const spies = [
		vi.spyOn(process.stdout, "write").mockImplementation(sink),
		vi.spyOn(process.stderr, "write").mockImplementation(sink),
		...(["log", "info", "warn", "error", "debug"] as const).map(name =>
			vi
				.spyOn(console, name)
				.mockImplementation((...args: unknown[]) => void sink(args.join(" "))),
		),
	]
	try {
		return [await run(), chunks.join("\n")]
	} finally {
		for (const spy of spies) spy.mockRestore()
	}
}

describe("machine-token export", () => {
	it("writes the stored credential to a new 0600 file and prints no secret", async () => {
		await provision()
		const token = await storedToken()
		const [result, logs] = await captured(() => runAccessCommand(command()))
		expect(result.exitCode).toBe(0)
		const stat = await fs.stat(out)
		expect(stat.mode & 0o7777).toBe(0o600)
		expect(stat.nlink).toBe(1)
		expect(await fs.readFile(out, "utf8")).toBe(`${token}\n`)
		const output = `${result.lines.join("\n")}\n${logs}`
		expect(output).toContain("ACCESS_TOKEN_WRITTEN")
		expect(output).not.toContain(token)
		expect(output).not.toContain(directory)
		expect(output).not.toContain(out)
		// Only the published file remains: the temporary name is gone.
		expect(await fs.readdir(outDir)).toEqual(["machine-token"])
	})

	it("creates the file 0600 even under a permissive umask", async () => {
		await provision()
		const previous = process.umask(0)
		try {
			expect(await exportMachineToken({ directory, out })).toEqual({
				kind: "written",
			})
		} finally {
			process.umask(previous)
		}
		expect((await fs.stat(out)).mode & 0o7777).toBe(0o600)
	})

	it("reads while a live core owns the private directory", async () => {
		await provision()
		const owner = await PrivateAccessStorage.open({
			directory,
			mode: "load",
			ownership,
		})
		try {
			expect(await exportMachineToken({ directory, out })).toEqual({
				kind: "written",
			})
		} finally {
			await owner.close()
		}
	})

	it("refuses an existing file without --replace and leaves it untouched", async () => {
		await provision()
		await fs.writeFile(out, "keep\n", { mode: 0o600 })
		const result = await runAccessCommand(command())
		expect(result.exitCode).toBe(1)
		expect(result.lines.join("\n")).toContain("ACCESS_TOKEN_OUT_EXISTS")
		expect(await fs.readFile(out, "utf8")).toBe("keep\n")
		expect(await fs.readdir(outDir)).toEqual(["machine-token"])
	})

	it.each([0o644, 0o640, 0o604, 0o700])(
		"refuses to replace a file with mode %o",
		async mode => {
			await provision()
			await fs.writeFile(out, "keep\n")
			await fs.chmod(out, mode)
			const result = await exportMachineToken({ directory, out, replace: true })
			expect(result).toEqual({
				kind: "unavailable",
				code: "ACCESS_TOKEN_OUT_UNSAFE",
			})
			expect(await fs.readFile(out, "utf8")).toBe("keep\n")
		},
	)

	it("refuses a symlink or hard-linked target even with --replace", async () => {
		await provision()
		const elsewhere = join(root, "elsewhere")
		await fs.writeFile(elsewhere, "keep\n", { mode: 0o600 })
		await fs.symlink(elsewhere, out)
		expect(await exportMachineToken({ directory, out, replace: true })).toEqual(
			{ kind: "unavailable", code: "ACCESS_TOKEN_OUT_UNSAFE" },
		)
		await fs.unlink(out)
		await fs.link(elsewhere, out)
		expect(await exportMachineToken({ directory, out, replace: true })).toEqual(
			{ kind: "unavailable", code: "ACCESS_TOKEN_OUT_UNSAFE" },
		)
		expect(await fs.readFile(elsewhere, "utf8")).toBe("keep\n")
	})

	it.each([0o770, 0o707, 0o777])(
		"refuses an output directory with mode %o",
		async mode => {
			await provision()
			await fs.chmod(outDir, mode)
			expect(await exportMachineToken({ directory, out })).toEqual({
				kind: "unavailable",
				code: "ACCESS_TOKEN_OUT_UNSAFE",
			})
			await fs.chmod(outDir, 0o700)
			expect(await fs.readdir(outDir)).toEqual([])
		},
	)

	it("refuses a missing output directory and a path inside the private directory", async () => {
		await provision()
		expect(
			await exportMachineToken({ directory, out: join(root, "missing", "t") }),
		).toEqual({ kind: "unavailable", code: "ACCESS_TOKEN_OUT_UNSAFE" })
		expect(
			await exportMachineToken({ directory, out: join(directory, "t") }),
		).toEqual({ kind: "unavailable", code: "ACCESS_TOKEN_OUT_UNSAFE" })
		expect(await exportMachineToken({ directory, out: directory })).toEqual({
			kind: "unavailable",
			code: "ACCESS_TOKEN_OUT_UNSAFE",
		})
		expect(
			await exportMachineToken({ directory, out: join(directory, "..token") }),
		).toEqual({ kind: "unavailable", code: "ACCESS_TOKEN_OUT_UNSAFE" })
		// A symlinked ancestor that leads back into the private directory.
		const alias = join(outDir, "alias")
		await fs.symlink(root, alias)
		expect(
			await exportMachineToken({
				directory,
				out: join(alias, "private", "t"),
			}),
		).toEqual({ kind: "unavailable", code: "ACCESS_TOKEN_OUT_UNSAFE" })
		expect((await fs.readdir(directory)).sort()).toEqual([
			"access-state.json",
			"initialized",
		])
	})

	it.each([
		["before-publish", true],
		["before-publish", false],
		["after-publish", true],
		["after-publish", false],
	] as const)(
		"never lands in the private directory when the parent is swapped for a symlink to it (%s, replace %s)",
		async (step, replace) => {
			await provision()
			const target = join(outDir, "access-state.json")
			if (replace) await fs.writeFile(target, "keep\n", { mode: 0o600 })
			const privateState = join(directory, "access-state.json")
			const before = await fs.readFile(privateState)
			const moved = join(root, "agent-moved")
			const cwd = process.cwd()
			const result = await exportMachineToken(
				{ directory, out: target, replace },
				{
					step: async name => {
						if (name !== step) return
						await fs.rename(outDir, moved)
						await fs.symlink(directory, outDir)
					},
				},
			)
			expect(result).toEqual({
				kind: "unavailable",
				code: "ACCESS_TOKEN_OUT_UNSAFE",
			})
			expect(await fs.readFile(privateState)).toEqual(before)
			expect((await fs.readdir(directory)).sort()).toEqual([
				"access-state.json",
				"initialized",
			])
			// What was written went to the pinned directory and was removed again.
			expect(await fs.readdir(moved)).toEqual([])
			expect(process.cwd()).toBe(cwd)
		},
	)

	it("publishes when the parent is reached through a symlinked ancestor that stays put", async () => {
		await provision()
		const alias = join(root, "alias")
		await fs.symlink(root, alias)
		expect(
			await exportMachineToken({
				directory,
				out: join(alias, "agent", "machine-token"),
			}),
		).toEqual({ kind: "written" })
		expect((await fs.readFile(out, "utf8")).trim()).toBe(await storedToken())
	})

	it("refuses a missing, loose or unprovisioned state directory and writes nothing", async () => {
		const missing = await runAccessCommand(command())
		expect(missing.exitCode).toBe(1)
		expect(missing.lines.join("\n")).toContain("ACCESS_CREDENTIAL_UNAVAILABLE")
		await fs.mkdir(directory, { mode: 0o700 })
		await fs.chmod(directory, 0o700)
		expect(await exportMachineToken({ directory, out })).toEqual({
			kind: "unavailable",
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
		})
		await fs.rm(directory, { recursive: true })
		await provision()
		await fs.chmod(directory, 0o755)
		expect(await exportMachineToken({ directory, out })).toEqual({
			kind: "unavailable",
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
		})
		await fs.chmod(directory, 0o700)
		await fs.chmod(join(directory, "access-state.json"), 0o644)
		expect(await exportMachineToken({ directory, out })).toEqual({
			kind: "unavailable",
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
		})
		expect(await fs.readdir(outDir)).toEqual([])
	})

	it("rejects malformed arguments", async () => {
		for (const argv of [
			["machine-token"],
			["machine-token", "--private-directory", directory],
			["machine-token", "--out", out],
			["machine-token", "--private-directory", "relative", "--out", out],
			["machine-token", "--private-directory", directory, "--out", "rel"],
			[...command(), "--replace", "--replace"],
			[...command(), "--print"],
			[...command(), "--out", out],
		]) {
			const result = await runAccessCommand(argv)
			expect(result.exitCode).toBe(1)
			expect(result.lines).toEqual([
				"ACCESS_COMMAND_INVALID: Invalid access command. Use --help.",
			])
		}
		expect(await fs.readdir(outDir)).toEqual([])
	})

	it("rotation revokes the exported credential and --replace refreshes the file", async () => {
		await provision()
		expect((await runAccessCommand(command())).exitCode).toBe(0)
		const exported = (await fs.readFile(out, "utf8")).trim()
		const rotated = await runAccessCommand([
			"rotate-credential",
			"--private-directory",
			directory,
		])
		expect(rotated.exitCode).toBe(0)
		const storage = await PrivateAccessStorage.open({
			directory,
			mode: "load",
			ownership,
		})
		let digest: Buffer
		try {
			digest = storage.machineSecretDigest()
		} finally {
			await storage.close()
		}
		// The core admits the bearer only against the current digest.
		expect(verifyMachineToken(exported, digest)).toBe(false)
		const replaced = await runAccessCommand(command(["--replace"]))
		expect(replaced.exitCode).toBe(0)
		const fresh = (await fs.readFile(out, "utf8")).trim()
		expect(fresh).not.toBe(exported)
		expect(verifyMachineToken(fresh, digest)).toBe(true)
		expect((await fs.stat(out)).mode & 0o7777).toBe(0o600)
		expect(await fs.readdir(outDir)).toEqual(["machine-token"])
	})

	it("lists the command in help", async () => {
		const result = await runAccessCommand(["--help"])
		expect(result.lines.join("\n")).toContain(
			"machine-token --private-directory ABS --out ABS [--replace]",
		)
	})
})
