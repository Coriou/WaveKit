import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { access, readFile, rm, stat } from "node:fs/promises"
import { request } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { parse } from "yaml"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ConfigSchema } from "../../../src/config.js"

const execFileAsync = promisify(execFile)
const repository = fileURLToPath(new URL("../../../", import.meta.url))
const script = join(repository, "scripts/dev-protected.mjs")
const template = join(repository, "config/dev-protected.yaml")
const codePattern =
	/[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}/
const running: Running[] = []
const leftovers: string[] = []

interface Running {
	child: ChildProcess
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	stdout(): string
	stderr(): string
}

interface ReadyServer {
	proc: Running
	apiOrigin: string
	analogOrigin: string
	digitalOrigin: string
	bootstrapUrl: string
	code: string
	directory: string
}

function spawnScript(args: string[], track = false): Running {
	const child = spawn(process.execPath, [script, ...args], {
		cwd: repository,
		env: Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) => !name.startsWith("WAVEKIT_"),
			),
		),
		stdio: ["ignore", "pipe", "pipe"],
	})
	let stdout = ""
	let stderr = ""
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString()
	})
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString()
	})
	const exited = new Promise<{
		code: number | null
		signal: NodeJS.Signals | null
	}>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code, signal) => resolve({ code, signal }))
	})
	const proc = { child, exited, stdout: () => stdout, stderr: () => stderr }
	if (track) running.push(proc)
	return proc
}

async function shutdown(proc: Running): Promise<void> {
	if (proc.child.exitCode === null && proc.child.signalCode === null) {
		proc.child.kill("SIGINT")
		const result = await Promise.race([
			proc.exited.then(() => "exited" as const),
			delay(12_000).then(() => "timeout" as const),
		])
		if (
			result === "timeout" &&
			proc.child.exitCode === null &&
			proc.child.signalCode === null
		)
			proc.child.kill("SIGKILL")
	}
	await proc.exited.catch(() => undefined)
}

afterEach(async () => {
	const procs = running.splice(0)
	const dirs = leftovers.splice(0)
	for (const proc of procs) await shutdown(proc)
	for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function http(
	port: number,
	path: string,
	init: {
		method?: "GET" | "POST"
		headers?: Record<string, string>
		body?: string
	} = {},
) {
	return new Promise<{
		status: number | undefined
		headers: IncomingHttpHeaders
		body: string
	}>((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: init.method ?? "GET",
				headers: { Connection: "close", ...init.headers },
			},
			response => {
				let text = ""
				response.on("data", (chunk: Buffer) => {
					text += chunk.toString()
				})
				response.on("error", reject)
				response.on("end", () =>
					resolve({
						status: response.statusCode,
						headers: response.headers,
						body: text,
					}),
				)
			},
		)
		req.setTimeout(3_000, () =>
			req.destroy(new Error("Loopback request timed out")),
		)
		req.on("error", reject)
		req.end(init.body)
	})
}

function sessionCookie(headers: IncomingHttpHeaders): string {
	const raw = headers["set-cookie"]
	const line = Array.isArray(raw) ? raw[0] : raw
	const pair = line?.split(";")[0]
	if (!pair?.startsWith("wavekit_session="))
		throw new Error("Missing session cookie")
	return pair
}

function portOf(url: string): number {
	const port = Number(new URL(url).port)
	if (!Number.isInteger(port) || port < 1)
		throw new Error("Missing origin port")
	return port
}

async function machineToken(directory: string): Promise<string> {
	const parsed: unknown = JSON.parse(
		await readFile(join(directory, "access-state.json"), "utf8"),
	)
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("machineToken" in parsed) ||
		typeof parsed.machineToken !== "string"
	)
		throw new Error("Private state has no machine credential")
	return parsed.machineToken
}

async function ready(proc: Running): Promise<ReadyServer> {
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		const stdout = proc.stdout()
		const apiOrigin = /^API origin: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout)
		const analogOrigin =
			/^Analog audio origin: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout)
		const digitalOrigin =
			/^Digital audio origin: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout)
		const bootstrapUrl =
			/^Bootstrap URL: (http:\/\/127\.0\.0\.1:\d+\/api\/access\/bootstrap)$/m.exec(
				stdout,
			)
		const code = new RegExp(
			`^One-time browser pairing code: (${codePattern.source})$`,
			"m",
		).exec(stdout)
		const directory = /^Private access directory: (.+)$/m.exec(stdout)
		if (
			apiOrigin?.[1] &&
			analogOrigin?.[1] &&
			digitalOrigin?.[1] &&
			bootstrapUrl?.[1] &&
			code?.[1] &&
			directory?.[1]
		)
			return {
				proc,
				apiOrigin: apiOrigin[1],
				analogOrigin: analogOrigin[1],
				digitalOrigin: digitalOrigin[1],
				bootstrapUrl: bootstrapUrl[1],
				code: code[1],
				directory: directory[1],
			}
		if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
			await proc.exited.catch(() => undefined)
			throw new Error(
				`dev-protected exited before it was ready\n${proc.stdout()}\n${proc.stderr()}`,
			)
		}
		await delay(50)
	}
	throw new Error(
		`dev-protected readiness deadline exceeded\n${proc.stdout()}\n${proc.stderr()}`,
	)
}

async function pairedSession(origin: string, code: string) {
	const port = portOf(origin)
	const paired = await http(port, "/api/access/pair", {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	})
	expect(paired.status).toBe(201)
	const body: unknown = JSON.parse(paired.body)
	if (
		typeof body !== "object" ||
		body === null ||
		!("deviceId" in body) ||
		typeof body.deviceId !== "string"
	)
		throw new Error("Pair response has no device")
	const cookie = sessionCookie(paired.headers)
	const status = await http(port, "/api/access/session", {
		headers: { Origin: origin, Cookie: cookie },
	})
	expect(status.status).toBe(200)
	const session: unknown = JSON.parse(status.body)
	expect(session).toMatchObject({ deviceId: body.deviceId })
	return body.deviceId
}

function withDefaultPorts(text: string): string {
	const defaults =
		/^# wavekit-dev-protected-defaults: api=(\d+) analog=(\d+) digital=(\d+)$/m.exec(
			text,
		)
	if (!defaults?.[1] || !defaults[2] || !defaults[3])
		throw new Error("missing dev-protected port defaults")
	return text
		.replaceAll("__WAVEKIT_DEV_API_PORT__", defaults[1])
		.replaceAll("__WAVEKIT_DEV_ANALOG_PORT__", defaults[2])
		.replaceAll("__WAVEKIT_DEV_DIGITAL_PORT__", defaults[3])
}

describe("protected development config", () => {
	it("substitutes explicit port placeholders and leaves default digits in place", () => {
		const text = readFileSync(template, "utf8")
		expect(text).toContain(
			"# wavekit-dev-protected-defaults: api=9473 analog=9474 digital=9475",
		)
		expect(text).toContain("port: __WAVEKIT_DEV_API_PORT__")
		expect(text).toContain("httpPort: __WAVEKIT_DEV_ANALOG_PORT__")
		expect(text).toContain("httpPort: __WAVEKIT_DEV_DIGITAL_PORT__")
		expect(text).toContain("9473, 9474 and 9475")
		const source = readFileSync(script, "utf8")
		expect(source).not.toContain("replaceAll(String(port)")
		expect(source).toContain('process.on("SIGHUP"')
		expect(source).toContain('process.on("SIGQUIT"')
	})

	it("is valid local-http protected configuration with three origins", () => {
		const config = ConfigSchema.parse(
			parse(withDefaultPorts(readFileSync(template, "utf8"))),
		)
		expect(config.access.mode).toBe("protected")
		if (config.access.mode !== "protected") return
		expect(config.access.exposure).toBe("local-http")
		expect(config.access.listenerScheme).toBe("http")
		expect(config.api.host).toBe("127.0.0.1")
		expect(config.sources).toEqual([])
		expect(config.decoders).toEqual([])
		expect(config.scanner.enabled).toBe(false)
		expect(config.resources.enabled).toBe(false)
		const analog = config.liveDemod?.httpPort
		const digital = config.digitalVoice?.httpPort
		expect(analog).toBeTypeOf("number")
		expect(digital).toBeTypeOf("number")
		expect(
			new Set([config.api.port, config.audio.tcpPort, analog, digital]).size,
		).toBe(4)
		expect(config.access.publicOrigins).toEqual({
			api: `http://127.0.0.1:${config.api.port}`,
			analogAudio: `http://127.0.0.1:${analog}`,
			digitalAudio: `http://127.0.0.1:${digital}`,
		})
		expect(config.access.allowedOrigins).toEqual([
			`http://127.0.0.1:${config.api.port}`,
		])
		expect(config.api.port).toBe(9473)
		expect(config.liveDemod?.httpPort).toBe(9474)
		expect(config.digitalVoice?.httpPort).toBe(9475)
		expect(config.audio.tcpPort).toBe(9472)
	})
})

describe("protected development arguments", () => {
	it("rejects unknown flags and incomplete --pair without starting a server", async () => {
		const unknown = spawnScript(["--nope"])
		const help = spawnScript(["--help"])
		const incomplete = spawnScript(["--pair"])
		const [unknownResult, helpResult, incompleteResult] = await Promise.all([
			unknown.exited,
			help.exited,
			incomplete.exited,
		])
		expect(unknownResult.code).toBe(1)
		expect(unknown.stderr()).toContain("Usage: node scripts/dev-protected.mjs")
		expect(unknown.stdout()).not.toMatch(codePattern)
		expect(helpResult.code).toBe(0)
		expect(help.stdout()).toContain("--pair --private-directory ABS")
		expect(incompleteResult.code).toBe(1)
		expect(incomplete.stdout()).not.toMatch(codePattern)
	})
})

describe("protected development server", () => {
	beforeAll(async () => {
		await execFileAsync(
			"pnpm",
			[
				"run",
				"build-file",
				"./src/index.ts",
				"./src/core/spectrum/spectrum-worker.ts",
				"./src/access-command.ts",
				"./src/core/activity/storage/activity-writer-worker.ts",
				"./src/core/activity/query/activity-query-worker.ts",
			],
			{ cwd: repository, timeout: 110_000 },
		)
	}, 120_000)

	it("does not invent a pairing code when the private directory is missing", async () => {
		const missing = join(tmpdir(), "wavekit-dev-protected-missing-directory")
		const proc = spawnScript([
			"--pair",
			"--private-directory",
			missing,
			"--api-origin",
			"http://127.0.0.1:9",
		])
		const result = await proc.exited
		expect(result.code).toBe(1)
		expect(proc.stdout()).not.toMatch(codePattern)
		expect(`${proc.stdout()}${proc.stderr()}`).not.toContain("Bearer ")
	})

	it("serves bootstrap, pairs a session, and removes the private directory", async () => {
		const proc = spawnScript(
			["--api-port", "0", "--analog-port", "0", "--digital-port", "0"],
			true,
		)
		const server = await ready(proc)
		leftovers.push(dirname(server.directory))
		expect(server.bootstrapUrl).toBe(`${server.apiOrigin}/api/access/bootstrap`)
		expect(
			new Set([server.apiOrigin, server.analogOrigin, server.digitalOrigin])
				.size,
		).toBe(3)
		const token = await machineToken(server.directory)
		const bootstrap = await http(
			portOf(server.apiOrigin),
			"/api/access/bootstrap",
		)
		expect(bootstrap.status).toBe(200)
		expect(JSON.parse(bootstrap.body)).toMatchObject({
			apiOrigin: server.apiOrigin,
			analogAudioOrigin: server.analogOrigin,
			digitalAudioOrigin: server.digitalOrigin,
			access: { mode: "protected", pairingAvailable: true },
		})
		const reissued = spawnScript([
			"--pair",
			"--private-directory",
			server.directory,
			"--api-origin",
			server.apiOrigin,
		])
		const reissuedCode = await pairingLine(reissued)
		expect((await reissued.exited).code).toBe(0)
		expect(reissuedCode).not.toBe(server.code)
		const first = await pairedSession(server.apiOrigin, server.code)
		const second = await pairedSession(server.apiOrigin, reissuedCode)
		expect(first).not.toBe(second)
		const output = `${proc.stdout()}${proc.stderr()}${reissued.stdout()}${reissued.stderr()}`
		expect(output).not.toContain(token)
		expect(output).not.toContain("Bearer ")
		await shutdown(proc)
		await expect(access(server.directory)).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(access(dirname(server.directory))).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 60_000)

	it("keeps the private directory when --keep is set", async () => {
		const proc = spawnScript(
			[
				"--keep",
				"--api-port",
				"0",
				"--analog-port",
				"0",
				"--digital-port",
				"0",
			],
			true,
		)
		const server = await ready(proc)
		leftovers.push(dirname(server.directory))
		expect(proc.stdout()).toContain(
			"Keeping private access directory after exit.",
		)
		const mode = await stat(server.directory)
		expect(mode.mode & 0o777).toBe(0o700)
		const rendered = await readFile(
			join(dirname(server.directory), "runtime.yaml"),
			"utf8",
		)
		expect(rendered).toContain(
			"# wavekit-dev-protected-defaults: api=9473 analog=9474 digital=9475",
		)
		expect(rendered).toContain("9473, 9474 and 9475")
		expect(rendered).not.toContain("__WAVEKIT_DEV_")
		expect(rendered).toContain(`port: ${portOf(server.apiOrigin)}`)
		expect(rendered).toContain(`httpPort: ${portOf(server.analogOrigin)}`)
		expect(rendered).toContain(`httpPort: ${portOf(server.digitalOrigin)}`)
		await shutdown(proc)
		expect((await stat(server.directory)).isDirectory()).toBe(true)
		const token = await machineToken(server.directory)
		expect(`${proc.stdout()}${proc.stderr()}`).not.toContain(token)
	}, 60_000)

	it("stops the detached server and deletes the private directory on SIGHUP and SIGQUIT", async () => {
		for (const signal of ["SIGHUP", "SIGQUIT"] as const) {
			const proc = spawnScript(
				["--api-port", "0", "--analog-port", "0", "--digital-port", "0"],
				true,
			)
			const server = await ready(proc)
			leftovers.push(dirname(server.directory))
			const port = portOf(server.apiOrigin)
			try {
				proc.child.kill(signal)
				const result = await proc.exited
				expect(result.signal).toBeNull()
				expect(result.code).toBe(143)
				await expect(access(server.directory)).rejects.toMatchObject({
					code: "ENOENT",
				})
				await expect(access(dirname(server.directory))).rejects.toMatchObject({
					code: "ENOENT",
				})
				await expectPortClosed(port)
			} finally {
				await releaseListener(port)
			}
		}
	}, 90_000)
})

async function expectPortClosed(port: number): Promise<void> {
	const deadline = Date.now() + 3_000
	while (Date.now() < deadline) {
		try {
			await http(port, "/health")
		} catch {
			return
		}
		await delay(50)
	}
	throw new Error(`port ${port} still accepting connections`)
}

async function releaseListener(port: number): Promise<void> {
	try {
		await http(port, "/health")
	} catch {
		return
	}
	try {
		const { stdout } = await execFileAsync("lsof", [
			"-nP",
			`-iTCP:${port}`,
			"-sTCP:LISTEN",
			"-t",
		])
		for (const pid of stdout.split(/\s+/)) {
			if (!/^\d+$/.test(pid)) continue
			try {
				process.kill(Number(pid), "SIGKILL")
			} catch {
				// The listener exited between discovery and the signal.
			}
		}
	} catch {
		// lsof exits non-zero when nothing is listening.
	}
}

async function pairingLine(proc: Running): Promise<string> {
	const deadline = Date.now() + 15_000
	const pattern = new RegExp(
		`^One-time browser pairing code: (${codePattern.source})$`,
		"m",
	)
	let closed = false
	void proc.exited.then(
		() => {
			closed = true
		},
		() => {
			closed = true
		},
	)
	while (Date.now() < deadline) {
		const match = pattern.exec(proc.stdout())
		if (match?.[1]) return match[1]
		if (closed) break
		await delay(30)
	}
	const match = pattern.exec(proc.stdout())
	if (match?.[1]) return match[1]
	throw new Error(
		`dev-protected --pair failed\n${proc.stdout()}\n${proc.stderr()}`,
	)
}
