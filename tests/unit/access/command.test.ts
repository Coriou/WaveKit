import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runAccessCommand } from "../../../src/access/command.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"

let root: string
let directory: string
const owners: PrivateAccessStorage[] = []
const origin = "http://127.0.0.1:9000"
const ownership = "single-host-pid-namespace" as const
beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "wavekit-access-command-"))
	directory = join(root, "private")
})
afterEach(async () => {
	vi.restoreAllMocks()
	for (const owner of owners.splice(0)) await owner.close()
	await fs.rm(root, { recursive: true, force: true })
})
function setup(extra: string[] = []): string[] {
	return [
		"setup",
		"--private-directory",
		directory,
		"--ownership",
		ownership,
		"--api-origin",
		origin,
		"--allow-origin",
		"http://127.0.0.1:8080",
		...extra,
	]
}
function pair(): string[] {
	return ["pair", "--private-directory", directory, "--api-origin", origin]
}

describe("standalone first-use access utility", () => {
	it("shows help without provisioning or reading credentials", async () => {
		const open = vi.spyOn(PrivateAccessStorage, "open")
		const read = vi.spyOn(PrivateAccessStorage, "readMachineCredential")
		const result = await runAccessCommand(["--help"])
		expect(result.exitCode).toBe(0)
		expect(result.lines.join("\n")).toContain(
			"node dist/access-command.js setup",
		)
		expect(result.lines.join("\n")).toContain(
			"does not enable runtime protection",
		)
		expect(open).not.toHaveBeenCalled()
		expect(read).not.toHaveBeenCalled()
	})
	it("provisions exactly the selected directory and prints only a public unmounted plan", async () => {
		const result = await runAccessCommand(
			setup(["--external-audio-origin", "http://127.0.0.1:9001"]),
		)
		expect(result.exitCode).toBe(0)
		expect(await fs.readdir(root)).toEqual(["private"])
		const input: unknown = JSON.parse(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		)
		expect(input).toHaveProperty("machineToken")
		const output = result.lines.join("\n")
		expect(output).toContain('"mode":"protected"')
		expect(output).toContain(
			'"allowedAuthorities":["127.0.0.1:9000","127.0.0.1:9001"]',
		)
		expect(output).toContain('"allowedOrigins":["http://127.0.0.1:8080"]')
		expect(output).toContain('"externalAudioOrigins":["http://127.0.0.1:9001"]')
		expect(output).toContain("does not enable protected listeners")
		expect(output).toContain("HTTPS termination")
		expect(output).not.toContain(directory)
		expect(output).not.toContain("machineToken")
		expect(output).not.toContain("credentialBinding")
		expect(await fs.readdir(directory)).toEqual(
			expect.arrayContaining(["initialized", "access-state.json"]),
		)
		expect(
			(await fs.readdir(directory)).some(value => value.startsWith("owner-")),
		).toBe(false)
	})
	it.each([
		["http://127.0.0.1:9000", "http://localhost:8080", "http://127.0.0.1:9001"],
		[
			"http://127.0.0.1:9000",
			"https://127.0.0.1:8080",
			"http://127.0.0.1:9001",
		],
		[
			"https://wavekit.example:9443",
			"https://web.wavekit.example",
			"https://wavekit.example:9001",
		],
		[
			"https://wavekit.example:9443",
			"https://wavekit.example",
			"http://wavekit.example:9001",
		],
		[
			"http://192.0.2.10:9000",
			"http://192.0.2.10:8080",
			"http://192.0.2.10:9001",
		],
		[
			"http://wavekit.example:9000",
			"http://wavekit.example:8080",
			"http://wavekit.example:9001",
		],
	])(
		"rejects incoherent hostname/scheme or non-loopback HTTP browser plans before writes",
		async (api, browser, audio) => {
			const open = vi.spyOn(PrivateAccessStorage, "open")
			const result = await runAccessCommand([
				"setup",
				"--private-directory",
				directory,
				"--ownership",
				ownership,
				"--api-origin",
				api,
				"--allow-origin",
				browser,
				"--external-audio-origin",
				audio,
			])
			expect(result.exitCode).toBe(1)
			expect(open).not.toHaveBeenCalled()
			expect(await fs.readdir(root)).toEqual([])
		},
	)
	it.each([
		"http://localhost",
		"http://127.0.0.2",
		"http://[::1]",
		"https://wavekit.example",
	])(
		"accepts coherent explicit loopback HTTP or LAN HTTPS setup %s",
		async api => {
			const result = await runAccessCommand([
				"setup",
				"--private-directory",
				directory,
				"--ownership",
				ownership,
				"--api-origin",
				api,
				"--allow-origin",
				`${api}:8080`,
				"--external-audio-origin",
				`${api}:9001`,
			])
			expect(result.exitCode).toBe(0)
			expect(result.lines.join("\n")).toContain("HTTPS termination")
		},
	)
	it("reruns stopped setup without rotating or replacing private state", async () => {
		await runAccessCommand(setup())
		const before = await fs.readFile(
			join(directory, "access-state.json"),
			"utf8",
		)
		const result = await runAccessCommand(setup())
		expect(result.exitCode).toBe(0)
		expect(result.lines[0]).toContain("ACCESS_SETUP_READY")
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(before)
	})
	it("refuses setup while the core owns private state", async () => {
		const owner = await PrivateAccessStorage.open({
			directory,
			ownership,
			mode: "provision",
		})
		owners.push(owner)
		const entries = await fs.readdir(directory)
		const result = await runAccessCommand(setup())
		expect(result).toEqual({
			exitCode: 1,
			lines: ["ACCESS_SETUP_UNAVAILABLE: Stop the core and retry setup."],
		})
		expect(await fs.readdir(directory)).toEqual(entries)
	})
	it("preserves corrupt initialized state and emits no data/path/error cause", async () => {
		await runAccessCommand(setup())
		const secret = "private-corrupt-content"
		await fs.writeFile(join(directory, "access-state.json"), secret)
		const result = await runAccessCommand(setup())
		expect(result.exitCode).toBe(1)
		expect(result.lines.join("\n")).toContain("offline repair")
		expect(JSON.stringify(result)).not.toContain(secret)
		expect(JSON.stringify(result)).not.toContain(directory)
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(secret)
	})
	it.each(
		[
			[],
			["setup"],
			["unknown", "private-secret"],
			[
				"setup",
				"--private-directory",
				"relative-secret",
				"--api-origin",
				origin,
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				"http://user:secret@localhost",
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				"http://127.1",
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				"http://0x7f000001",
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				"http://0.0.0.0",
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				"http://[::]",
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				origin,
				"--timeout-ms",
				"30001",
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				origin,
				"--timeout-ms",
				"1e3",
			],
			[
				"pair",
				"--private-directory",
				"/private/secret",
				"--api-origin",
				origin,
				"--unknown",
				"secret",
			],
		].map(args => ({ args })),
	)(
		"rejects malformed command before any private storage operation",
		async ({ args }) => {
			const open = vi.spyOn(PrivateAccessStorage, "open")
			const read = vi.spyOn(PrivateAccessStorage, "readMachineCredential")
			const result = await runAccessCommand(args)
			expect(result).toEqual({
				exitCode: 1,
				lines: ["ACCESS_COMMAND_INVALID: Invalid access command. Use --help."],
			})
			expect(open).not.toHaveBeenCalled()
			expect(read).not.toHaveBeenCalled()
			expect(await fs.readdir(root)).toEqual([])
		},
	)
	it.each(
		[
			["--allow-origin", "http://localhost/#private-secret"],
			["--api-origin", origin],
			["--private-directory", "/private/secret"],
			["--allow-origin", "http://*"],
			["--external-audio-origin", "http://0x7f000001"],
			["--external-audio-origin", "http://localhost:0"],
			["--unknown", "secret"],
		].map(extra => ({ extra })),
	)(
		"validates every setup flag and origin before creating the directory",
		async ({ extra }) => {
			expect((await runAccessCommand(setup(extra))).exitCode).toBe(1)
			expect(await fs.readdir(root)).toEqual([])
		},
	)
	it("requires explicit ownership and a browser origin, and bounds all arguments", async () => {
		const args = setup()
		for (const invalid of [
			args.filter(value => value !== "--ownership" && value !== ownership),
			args.slice(0, -2),
			setup(
				Array.from({ length: 65 }, () => [
					"--allow-origin",
					"http://localhost",
				]).flat(),
			),
			["pair", "a".repeat(4097)],
			Array.from({ length: 257 }, () => "secret"),
		]) {
			expect((await runAccessCommand(invalid)).exitCode).toBe(1)
		}
		expect(await fs.readdir(root)).toEqual([])
	})
	it("reports an unmounted pairing service honestly without generating a local code", async () => {
		await runAccessCommand(setup())
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response('{"code":"SECRET"}', { status: 404 }))
		const result = await runAccessCommand(pair())
		expect(result.exitCode).toBe(1)
		expect(result.lines.join("\n")).toContain("PAIRING_SERVICE_UNAVAILABLE")
		expect(result.lines.join("\n")).toContain("no code was generated locally")
		expect(JSON.stringify(result)).not.toContain("SECRET")
		expect(JSON.stringify(result)).not.toContain(directory)
		expect(fetch).toHaveBeenCalledOnce()
	})
	it("deliberately displays only the short-lived issued code, never the machine credential", async () => {
		await runAccessCommand(setup())
		const owner = await PrivateAccessStorage.open({
			directory,
			ownership,
			mode: "load",
		})
		owners.push(owner)
		const token = owner.useMachineCredential(value => value)
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ code: "ABCDE-FGHJK", expiresInSeconds: 600 }),
				{ status: 201 },
			),
		)
		const result = await runAccessCommand(pair())
		expect(result.exitCode).toBe(0)
		expect(result.lines.join("\n")).toContain(
			"One-time browser pairing code: ABCDE-FGHJK",
		)
		expect(result.lines.join("\n")).toContain("Expires in 600 seconds")
		expect(JSON.stringify(result)).not.toContain(token)
		expect(JSON.stringify(result)).not.toContain(directory)
	})
	it("preserves explicit machine-authenticated HTTP LAN pairing without a browser-plan guard", async () => {
		await runAccessCommand(setup())
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(
					JSON.stringify({ code: "ABCDE-FGHJK", expiresInSeconds: 600 }),
					{ status: 201 },
				),
			)
		const result = await runAccessCommand([
			"pair",
			"--private-directory",
			directory,
			"--api-origin",
			"http://192.0.2.10:9000",
		])
		expect(result.exitCode).toBe(0)
		expect(fetch).toHaveBeenCalledWith(
			"http://192.0.2.10:9000/api/access/pairing-codes",
			expect.objectContaining({ method: "POST" }),
		)
	})
})
