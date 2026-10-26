import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
let buildDirectory = ""
let entry = ""
const roots: string[] = []
const holders: Server[] = []

beforeAll(async () => {
	const agents = join(repository, ".agents")
	await mkdir(agents, { recursive: true })
	buildDirectory = await mkdtemp(join(agents, "legacy-port-conflict-build-"))
	entry = join(buildDirectory, "index.js")
	await build({
		absWorkingDir: repository,
		entryPoints: [
			{ in: "src/index.ts", out: "index" },
			{ in: "src/core/spectrum/spectrum-worker.ts", out: "spectrum-worker" },
			{
				in: "src/core/activity/storage/activity-writer-worker.ts",
				out: "activity-writer-worker",
			},
			{
				in: "src/core/activity/query/activity-query-worker.ts",
				out: "activity-query-worker",
			},
		],
		bundle: true,
		outdir: buildDirectory,
		platform: "node",
		format: "esm",
		packages: "external",
	})
}, 60_000)

afterAll(async () => {
	for (const holder of holders.splice(0))
		if (holder.listening)
			await new Promise<void>(resolve => holder.close(() => resolve()))
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true })
	if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
})

// Outside the OS ephemeral range, as in protected-runtime-process.test.ts.
async function freePort(host?: string): Promise<number> {
	for (;;) {
		const port = 24000 + Math.floor(Math.random() * 6000)
		const probe = createServer()
		const error = await new Promise<string | null>(resolve => {
			probe.once("error", (e: NodeJS.ErrnoException) =>
				resolve(e.code ?? "unknown"),
			)
			const done = () => resolve(null)
			if (host) probe.listen(port, host, done)
			else probe.listen(port, done)
		})
		if (error === null) {
			await new Promise<void>(resolve => probe.close(() => resolve()))
			return port
		}
	}
}

async function hold(port: number, host?: string): Promise<Server> {
	const server = createServer()
	holders.push(server)
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		if (host) server.listen(port, host, resolve)
		else server.listen(port, resolve)
	})
	return server
}

async function listening(port: number): Promise<boolean> {
	const probe = createServer()
	return new Promise<boolean>(resolve => {
		probe.once("error", () => resolve(true))
		probe.listen(port, () => probe.close(() => resolve(false)))
	})
}

async function runCore(config: Record<string, unknown>) {
	const root = await mkdtemp(join(tmpdir(), "wavekit-legacy-port-"))
	roots.push(root)
	const state = join(root, "state")
	await mkdir(state, { mode: 0o700 })
	const configFile = join(root, "config.yaml")
	await writeFile(
		configFile,
		JSON.stringify({
			sources: [],
			decoders: [],
			stateDir: state,
			scanner: { enabled: false },
			resources: { enabled: false },
			channelizer: { enabled: false },
			logging: { level: "info" },
			access: { mode: "legacy" },
			...config,
		}),
	)
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([n]) => !n.startsWith("WAVEKIT_")),
	)
	env["WAVEKIT_CONFIG"] = configFile
	const child = spawn(process.execPath, [entry], {
		cwd: repository,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	})
	let stdout = ""
	let stderr = ""
	child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()))
	child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()))
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
	const exit = await new Promise<{ code: number | null }>(resolve =>
		child.once("close", code => resolve({ code })),
	)
	clearTimeout(timer)
	return { ...exit, stdout, stderr }
}

describe("legacy startup with a held port (WG9 5.1)", () => {
	it("exits 1 with the fixed line when the audio port is held", async () => {
		const api = await freePort("127.0.0.1")
		const analog = await freePort("127.0.0.1")
		const digital = await freePort("127.0.0.1")
		const audio = await freePort()
		const held = await hold(audio)
		const result = await runCore({
			api: { host: "127.0.0.1", port: api },
			audio: { tcpPort: audio },
			tunerRelay: { enabled: false },
			liveDemod: { enabled: false, httpPort: analog },
			digitalVoice: { enabled: false, httpPort: digital },
		})
		expect(result.code).toBe(1)
		expect(result.stderr).toBe(
			"WaveKit startup failed: Error [EADDRINUSE]: startup could not complete\n",
		)
		expect(result.stderr).not.toMatch(/Unhandled|uncaught|\n\s+at /i)
		expect(result.stdout).not.toContain("WaveKit started successfully")
		expect(result.stdout + result.stderr).not.toContain(String(audio))
		expect(held.listening).toBe(true)
		await new Promise<void>(resolve => held.close(() => resolve()))
		expect(await listening(audio)).toBe(false)
		expect(await listening(api)).toBe(false)
	}, 40_000)

	it("exits 1 with the fixed line when the tuner relay port is held", async () => {
		const api = await freePort("127.0.0.1")
		const analog = await freePort("127.0.0.1")
		const digital = await freePort("127.0.0.1")
		const audio = await freePort()
		const relay = await freePort("127.0.0.1")
		const held = await hold(relay, "127.0.0.1")
		const result = await runCore({
			api: { host: "127.0.0.1", port: api },
			audio: { tcpPort: audio },
			tunerRelay: { enabled: true, host: "127.0.0.1", port: relay },
			liveDemod: { enabled: false, httpPort: analog },
			digitalVoice: { enabled: false, httpPort: digital },
		})
		expect(result.code).toBe(1)
		expect(result.stderr).toBe(
			"WaveKit startup failed: ConfigValidationError [CONFIG_VALIDATION_ERROR]: startup could not complete\n",
		)
		expect(result.stderr).not.toMatch(/Unhandled|uncaught|\n\s+at /i)
		expect(result.stdout).not.toContain("WaveKit started successfully")
		await new Promise<void>(resolve => held.close(() => resolve()))
		expect(await listening(relay)).toBe(false)
		expect(await listening(audio)).toBe(false)
	}, 40_000)
})
