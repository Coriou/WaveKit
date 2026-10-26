import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises"
import { request } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { connect, createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

import type { Plugin } from "esbuild"
import { WebSocket } from "ws"
import { z } from "zod"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { OperatorDataStorage } from "../../../src/operator-data/storage.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
let buildDirectory: string | undefined
let entry: string
let failedScannerEntry: string
let failedOperatorEntry: string
let pausedOperatorEntry: string
let failedOperatorCloseEntry: string
let scannerPhasesEntry: string
let metadataLifecycleEntry: string
const roots: string[] = []
const processes: RunningCore[] = []
const reservations: Server[] = []
const sockets: WebSocket[] = []

// These explicit contract fixtures exercise entry-point composition, not the core
// settlement implementation. The ordinary entry above always compiles real source.
const scannerOwnerFixture = `
export class ScannerLifecycleOwner {
	callbacks = new Map()
	sealAdmission() { process.stdout.write("scanner-admission-sealed\\n") }
	ownCleanup(slot, attempt) {
		if (this.callbacks.has(slot) || this.handle) return false
		this.callbacks.set(slot, attempt)
		return true
	}
	completeConstruction(outcome) { this.construction ??= outcome }
	beginStop() {
		if (this.handle) return this.handle
		let resolve, reject
		const producerSettled = new Promise((yes, no) => { resolve = yes; reject = no })
		this.handle = Object.freeze({ producerSettled, completed: producerSettled })
		void producerSettled.catch(() => {})
		this.sealAdmission()
		void Promise.allSettled([...this.callbacks.values()].map(attempt => Promise.resolve().then(attempt)))
			.then(outcomes => {
				if (this.construction?.ok === false || outcomes.some(outcome => outcome.status === "rejected" || !outcome.value.ok)) {
					this.componentFailed = true
					reject(new Error("Fixture scanner component failed"))
				} else resolve()
			})
		return this.handle
	}
	finalizeStopNative(observer, lifetime) {
		process.stdout.write("scanner-final-inspected\\n")
		let outcome = this.construction ?? { ok: true }
		if (this.componentFailed) outcome = { ok: false, state: "failed", detail: "Component failed" }
		const final = observer ? observer.inspectFinal(outcome) : lifetime ? lifetime.inspectFinal(outcome) : outcome
		return final.ok ? Promise.resolve() : Promise.reject(new Error("Fixture scanner final failed"))
	}
}`

const settlementFixture = `
export function registerSettlementTransport() {
	throw new Error("Native settlement transport is outside this composition fixture")
}
class Lifetime {
	callbacks = new Map()
	ownCleanup(kind, attempt) {
		if (this.callbacks.has(kind)) return undefined
		this.callbacks.set(kind, attempt)
		return { settle() {} }
	}
	ownListener() { return { settle() {} } }
	sealAdmission() { process.stdout.write("provider-admission-sealed\\n") }
	attemptLocalCleanup() {
		return this.localCleanup ??= Promise.resolve().then(() => this.runLocalCleanup())
	}
	async runLocalCleanup() {
		process.stdout.write("provider-local-attempt\\n")
		const outcomes = await Promise.allSettled([...this.callbacks.values()].map(attempt => Promise.resolve().then(attempt)))
		const actual = outcomes.map(outcome => outcome.status === "fulfilled" ? outcome.value : { ok: false, state: "failed", detail: "Fixture local failed" })
		if (process.env.R14_PROCESS_CASE === "local-failure") actual.push({ ok: false, state: "failed", detail: "Fixture local failed" })
		this.localFailed = actual.some(outcome => !outcome.ok)
		return actual
	}
	disposeListenersIfSettled() { return { ok: true } }
	inspectFinal(outcome) {
		process.stdout.write("provider-final-inspected\\n")
		return this.final ??= this.localFailed ? { ok: false, state: "failed", detail: "Fixture local failed" } : outcome
	}
}
export class SettlementRegistry {
	registerProviderLifetime() { return new Lifetime() }
	createObserver(lifetime) {
		return {
			provider: lifetime,
			bindProvider(provider) { return provider },
			sealAdmission() { lifetime.sealAdmission() },
			attemptLocalCleanup() { return lifetime.attemptLocalCleanup() },
			inspectFinal(outcome) { return lifetime.inspectFinal(outcome) }
		}
	}
}`

function lifecycleContracts(): Plugin {
	return {
		name: "explicit-r14-composition-contract-fixtures",
		setup(builder) {
			builder.onResolve(
				{ filter: /(?:settlement-observer|consumer-lifecycle)\.js$/ },
				args => ({ path: args.path, namespace: "r14-contract" }),
			)
			builder.onLoad({ filter: /.*/, namespace: "r14-contract" }, args => ({
				loader: "js",
				contents: args.path.endsWith("consumer-lifecycle.js")
					? scannerOwnerFixture
					: settlementFixture,
			}))
		},
	}
}

const scannerServiceFixture = `
import { EventEmitter } from "node:events"
import { ScannerLifecycleOwner } from "./channel/consumer-lifecycle.js"
export class ScannerService extends EventEmitter {
	constructor(options) {
		super()
		this.options = options
		this.owner = options.construction ?? options.channelOwnership?.construction ?? new ScannerLifecycleOwner()
		this.owner.ownCleanup("service", async () => {
			process.stdout.write("scanner-stop-real\\n")
			if (process.env.R14_PROCESS_CASE === "legacy-held") {
				// Listen before announcing: the parent signals on the marker, and an
				// unhandled SIGUSR2 would kill this process.
				const hold = setInterval(() => {}, 1000)
				try {
					await new Promise(resolve => {
						process.once("SIGUSR2", resolve)
						process.stdout.write("scanner-component-paused\\n")
					})
				} finally { clearInterval(hold) }
			}
			if (["partial-failure", "legacy-held"].includes(process.env.R14_PROCESS_CASE))
				return { ok: false, state: "failed", detail: "Fixture component failed" }
			return { ok: true }
		})
		this.owner.ownCleanup("probes", async () => {
			process.stdout.write("scanner-probes-cleaned\\n")
			return { ok: true }
		})
		if (process.env.R14_PROCESS_CASE === "constructor-failure")
			throw new Error("Fixture scanner constructor failed")
	}
	settings() { return this.options.settings }
	async start() {
		if (process.env.R14_PROCESS_CASE === "partial-failure")
			throw new Error("Scanner fixture startup failed")
	}
	sealAdmission() { this.owner.sealAdmission() }
	beginStop() { return this.owner.beginStop() }
	finalizeStopNative() { return this.owner.finalizeStopNative(this.options.channelOwnership?.observer, this.options.channelOwnership?.lifetime) }
	stop() {
		if (this.compatibilityStopped) {
			process.stdout.write("scanner-stop-noop\\n")
			return Promise.resolve()
		}
		this.compatibilityStopped = true
		return this.beginStop().producerSettled
	}
}`

// Build these exact current sources in a repository-local ignored directory so
// Node resolves the same external dependencies without accepting stale dist/.
beforeAll(async () => {
	const agentsDirectory = join(repository, ".agents")
	await mkdir(agentsDirectory, { recursive: true })
	buildDirectory = await mkdtemp(
		join(agentsDirectory, "protected-process-build-"),
	)
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
	// Instrument the real compiled entry/providers without production test hooks.
	const metadataDirectory = join(buildDirectory, "metadata-lifecycle")
	metadataLifecycleEntry = join(metadataDirectory, "index.js")
	await build({
		absWorkingDir: repository,
		entryPoints: [{ in: "src/index.ts", out: "index" }],
		bundle: true,
		outdir: metadataDirectory,
		platform: "node",
		format: "esm",
		packages: "external",
		plugins: [
			{
				name: "metadata-provider-lifecycle-observations",
				setup(builder) {
					builder.onLoad(
						{ filter: /[/\\]tuner-capabilities[/\\]provider\.ts$/ },
						async args => {
							const source = await readFile(args.path, "utf8")
							if (!source.includes("dispose() {"))
								throw new Error("Provider fixture seam missing")
							return {
								loader: "ts",
								contents: source.replace(
									"dispose() {",
									'dispose() {\nprocess.stdout.write("metadata-disposed\\n")',
								),
							}
						},
					)
					builder.onLoad({ filter: /[/\\]api[/\\]server\.ts$/ }, async args => {
						let source = await readFile(args.path, "utf8")
						const constructor =
							"constructor(dependencies: ApiServerDependencies, config: ApiServerConfig) {"
						const start = "private async finishStart(): Promise<void> {"
						const finish = 'this.log.info("API server stopped")'
						if (
							![constructor, start, finish].every(marker =>
								source.includes(marker),
							)
						)
							throw new Error("API lifecycle fixture seam missing")
						source = source.replace(
							constructor,
							constructor +
								`
						if (process.env.R14_PROCESS_CASE === "metadata-constructor-failure")
							throw new Error("Fixture API constructor failed")
					`,
						)
						source = source.replace(
							start,
							start +
								`
						if (process.env.R14_PROCESS_CASE === "metadata-start-paused") {
							process.once("SIGTERM", () => process.stdout.write("metadata-signal-seen\\n"))
							await new Promise(resolve => {
								process.once("SIGUSR2", resolve)
								process.stdout.write("metadata-start-paused\\n")
							})
						}
					`,
						)
						const stop =
							"private async finishStop(sealFailed: boolean): Promise<void> {"
						if (!source.includes(stop))
							throw new Error("API drain fixture seam missing")
						source = source.replace(
							stop,
							stop +
								`
						if (process.env.R14_PROCESS_CASE === "metadata-drain-held") {
							await new Promise(resolve => {
								process.once("SIGUSR2", resolve)
								process.stdout.write("metadata-drain-held\\n")
							})
						}
					`,
						)
						source = source.replace(
							finish,
							finish + '\nprocess.stdout.write("metadata-api-drained\\n")',
						)
						return { loader: "ts", contents: source }
					})
					builder.onLoad({ filter: /[/\\]source-manager\.ts$/ }, async args => {
						const source = await readFile(args.path, "utf8")
						const seam = "async disconnectAll(): Promise<void> {"
						if (!source.includes(seam))
							throw new Error("Source cleanup fixture seam missing")
						return {
							loader: "ts",
							contents: source.replace(
								seam,
								seam +
									'\nprocess.stdout.write("metadata-sources-disconnected\\n")',
							),
						}
					})
					builder.onLoad(
						{ filter: /[/\\]graceful-shutdown\.ts$/ },
						async args => {
							const source = await readFile(args.path, "utf8")
							const seam = "}, handler.timeout)"
							if (!source.includes(seam))
								throw new Error("Shutdown timer fixture seam missing")
							return {
								loader: "ts",
								contents: source.replace(
									seam,
									'}, process.env["R14_PROCESS_CASE"] === "metadata-drain-held" ? 20 : handler.timeout)',
								),
							}
						},
					)
				},
			},
		],
	})
	const failureDirectory = join(buildDirectory, "failed-scanner")
	failedScannerEntry = join(failureDirectory, "index.js")
	await build({
		absWorkingDir: repository,
		entryPoints: [{ in: "src/index.ts", out: "index" }],
		bundle: true,
		outdir: failureDirectory,
		platform: "node",
		format: "esm",
		packages: "external",
		plugins: [
			lifecycleContracts(),
			{
				name: "failed-partial-scanner-cleanup",
				setup(builder) {
					builder.onLoad({ filter: /[/\\]scanner-service\.ts$/ }, () => ({
						loader: "js",
						contents: scannerServiceFixture.replaceAll(
							"process.env.R14_PROCESS_CASE",
							'"partial-failure"',
						),
					}))
				},
			},
		],
	})
	const phasesDirectory = join(buildDirectory, "scanner-phases-contract")
	scannerPhasesEntry = join(phasesDirectory, "index.js")
	await build({
		absWorkingDir: repository,
		entryPoints: [{ in: "src/index.ts", out: "index" }],
		bundle: true,
		outdir: phasesDirectory,
		platform: "node",
		format: "esm",
		packages: "external",
		plugins: [
			lifecycleContracts(),
			{
				name: "actual-index-scanner-phase-contract",
				setup(builder) {
					builder.onLoad({ filter: /[/\\]scanner-service\.ts$/ }, () => ({
						loader: "js",
						contents: scannerServiceFixture,
					}))
					builder.onLoad(
						{ filter: /[/\\]channelizer-manager\.ts$/ },
						async args => {
							const source = await readFile(args.path, "utf8")
							const original = "async destroy(): Promise<void> {"
							if (!source.includes(original))
								throw new Error("Channelizer fixture seam missing")
							return {
								loader: "ts",
								contents: source.replace(
									original,
									original +
										`
							process.stdout.write("core-native-attempt\\n")
							if (process.env.R14_PROCESS_CASE === "native-failure") throw new Error("Fixture native failed")
							`,
								),
							}
						},
					)
					builder.onLoad(
						{ filter: /[/\\]operator-data[/\\]service\.ts$/ },
						async args => {
							const source = await readFile(args.path, "utf8")
							const original =
								"...(options.storageStage ? { stage: options.storageStage } : {}),"
							if (!source.includes(original))
								throw new Error("Operator fixture seam missing")
							return {
								loader: "ts",
								contents: source.replace(
									original,
									`stage: async (stage, phase) => {
							if (process.env.R14_PROCESS_CASE === "operator-held" && stage === "lock-release" && phase === "before") {
								// Listen before announcing: the parent signals on the marker.
								const hold = setInterval(() => {}, 1000)
								try {
									await new Promise(resolve => {
										process.once("SIGUSR2", resolve)
										process.stdout.write("operator-drain-paused\\n")
									})
								} finally { clearInterval(hold) }
							}
							},`,
								),
							}
						},
					)
					builder.onLoad(
						{ filter: /[/\\]graceful-shutdown\.ts$/ },
						async args => {
							const source = await readFile(args.path, "utf8")
							if (
								!source.includes("}, handler.timeout)") ||
								!source.includes("clearTimeout(forceExitTimer)")
							)
								throw new Error("Generic shutdown fixture seam missing")
							return {
								loader: "ts",
								contents: source
									.replace(
										"}, handler.timeout)",
										'}, process.env["R14_PROCESS_CASE"] === "legacy-held" ? 20 : handler.timeout)',
									)
									.replace(
										"clearTimeout(forceExitTimer)",
										'clearTimeout(forceExitTimer)\nprocess.stdout.write("generic-utility-fulfilled\\n")',
									),
							}
						},
					)
				},
			},
		],
	})
	for (const kind of ["failed", "paused", "close-failed"] as const) {
		const directory = join(buildDirectory, kind + "-operator")
		if (kind === "failed") failedOperatorEntry = join(directory, "index.js")
		else if (kind === "paused")
			pausedOperatorEntry = join(directory, "index.js")
		else failedOperatorCloseEntry = join(directory, "index.js")
		await build({
			absWorkingDir: repository,
			entryPoints: [{ in: "src/index.ts", out: "index" }],
			bundle: true,
			outdir: directory,
			platform: "node",
			format: "esm",
			packages: "external",
			plugins: [
				{
					name: kind + "-operator-acquisition",
					setup(builder) {
						builder.onLoad(
							{ filter: /[/\\]operator-data[/\\]service\.ts$/ },
							async args => {
								const source = await readFile(args.path, "utf8")
								const original =
									"...(options.storageStage ? { stage: options.storageStage } : {}),"
								if (!source.includes(original))
									throw new Error("Operator fixture seam missing")
								const stage =
									kind === "failed"
										? `stage: (stage, phase) => {
								if (phase === "before" && (stage === "temp-write" || stage === "lock-release"))
									throw new Error("Fixture operator acquisition or cleanup failed")
							},`
										: kind === "close-failed"
											? `stage: (stage, phase) => {
								if (stage === "lock-release" && phase === "before")
									throw new Error("Fixture operator close failed")
							},`
											: `stage: async (stage, phase) => {
								if (stage === "parent-open" && phase === "before") {
									process.once("SIGTERM", () => process.stdout.write("operator-signal-seen\\n"))
									// Listen before announcing: the parent signals on the marker.
									await new Promise(resolve => {
										process.once("SIGUSR2", resolve)
										process.stdout.write("operator-open-paused\\n")
									})
								}
							},`
								return {
									loader: "ts",
									contents: source.replace(original, stage),
								}
							},
						)
					},
				},
			],
		})
	}
}, 30_000)

afterAll(async () => {
	if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
})

interface RunningCore {
	child: ChildProcess
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	stdout(): string
	stderr(): string
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.terminate()
	for (const core of processes.splice(0)) {
		if (core.child.exitCode === null && core.child.signalCode === null)
			core.child.kill("SIGKILL")
		await core.exited
	}
	for (const reservation of reservations.splice(0)) {
		if (reservation.listening)
			await new Promise<void>(resolve => reservation.close(() => resolve()))
	}
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true })
})

async function fixture() {
	// Compilation and missing fresh output fail this suite, never skip it.
	await access(entry)
	const root = await mkdtemp(join(tmpdir(), "wavekit-protected-process-"))
	roots.push(root)
	const ports: number[] = []
	const held: Server[] = []
	// The core binds these ports only after releasePorts() and a full process boot. A port
	// from listen(0) is in the OS ephemeral range, where any concurrent test's listen(0) or
	// outbound connection can take it in that window (seen as EADDRINUSE on the audio port).
	// Reserve outside the ephemeral ranges (Linux 32768+, macOS 49152+) and away from the
	// decoder defaults (30003, 30005, ...), so only another explicit pick can collide.
	while (ports.length < 5) {
		const port = 24000 + Math.floor(Math.random() * 6000)
		if (ports.includes(port)) continue
		const server = createServer()
		const bound = async (host: string, probe: Server) =>
			new Promise<string | null>(resolve => {
				probe.once("error", (error: NodeJS.ErrnoException) =>
					resolve(error.code ?? "unknown"),
				)
				probe.listen(port, host, () => resolve(null))
			})
		// AudioOutput listens on the wildcard address: the port must be free there too
		// (a host without IPv6 answers EAFNOSUPPORT/EADDRNOTAVAIL: nothing to check).
		const wildcard = createServer()
		const wildcardError = await bound("::", wildcard)
		if (wildcardError === "EADDRINUSE" || wildcardError === "EACCES") continue
		if (wildcard.listening)
			await new Promise<void>(resolve => wildcard.close(() => resolve()))
		if ((await bound("127.0.0.1", server)) !== null) continue
		reservations.push(server)
		held.push(server)
		ports.push(port)
	}
	const [api, analog, digital, raw, relay] = ports as [
		number,
		number,
		number,
		number,
		number,
	]
	const origin = `http://127.0.0.1:${api}`
	const directory = join(root, "SECRET-private-authority")
	const configFile = join(root, "config.yaml")
	const config = {
		sources: [],
		decoders: [],
		stateDir: join(root, "state"),
		scanner: { enabled: false },
		resources: { enabled: false },
		channelizer: { enabled: false },
		api: { host: "127.0.0.1", port: api },
		audio: { tcpPort: raw },
		tunerRelay: { enabled: false, host: "127.0.0.1", port: relay },
		liveDemod: { enabled: false, httpPort: analog },
		digitalVoice: { enabled: false, httpPort: digital },
		logging: { level: "info" },
		access: {
			mode: "protected",
			listenerScheme: "http",
			exposure: "local-http",
			allowedAuthorities: [`127.0.0.1:${api}`],
			allowedOrigins: [origin],
			audio: {
				analog: {
					allowedAuthorities: [`127.0.0.1:${analog}`],
					bindHost: "127.0.0.1",
				},
				digital: {
					allowedAuthorities: [`127.0.0.1:${digital}`],
					bindHost: "127.0.0.1",
				},
			},
			publicOrigins: {
				api: origin,
				analogAudio: `http://127.0.0.1:${analog}`,
				digitalAudio: `http://127.0.0.1:${digital}`,
			},
			healthProbe: { target: origin, host: `127.0.0.1:${api}` },
		},
	}
	await mkdir(config.stateDir, { mode: 0o700 })
	await writeFile(configFile, JSON.stringify(config))
	const releasePorts = async (keepApi = false) => {
		for (const server of keepApi ? held.slice(1) : held)
			if (server.listening)
				await new Promise<void>(resolve => server.close(() => resolve()))
	}
	return {
		root,
		directory,
		configFile,
		config,
		api,
		analog,
		digital,
		raw,
		relay,
		origin,
		releasePorts,
	}
}

function run(
	configFile: string,
	directory?: string,
	executable = entry,
	fixtureCase?: string,
): RunningCore {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !name.startsWith("WAVEKIT_"),
		),
	)
	delete env["R14_PROCESS_CASE"]
	if (fixtureCase !== undefined) env["R14_PROCESS_CASE"] = fixtureCase
	env["WAVEKIT_CONFIG"] = configFile
	if (directory !== undefined)
		env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] = directory
	const child = spawn(process.execPath, [executable], {
		cwd: repository,
		env,
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
	const core = { child, exited, stdout: () => stdout, stderr: () => stderr }
	processes.push(core)
	return core
}

async function started(core: RunningCore): Promise<void> {
	const deadline = Date.now() + 8000
	while (Date.now() < deadline) {
		if (core.stdout().includes("WaveKit started successfully")) return
		if (core.child.exitCode !== null || core.child.signalCode !== null)
			throw new Error("Built core exited before startup completed")
		await delay(20)
	}
	throw new Error("Built core startup deadline exceeded")
}

async function marker(core: RunningCore, value: string): Promise<void> {
	if (core.stdout().includes(value)) return
	await new Promise<void>((resolve, reject) => {
		const check = () => {
			if (core.stdout().includes(value)) {
				cleanup()
				resolve()
			}
		}
		const ended = () => {
			cleanup()
			reject(new Error("Core exited before fixture marker"))
		}
		const cleanup = () => {
			core.child.stdout?.off("data", check)
			core.child.off("close", ended)
		}
		core.child.stdout?.on("data", check)
		core.child.once("close", ended)
		check()
	})
}

async function http(
	port: number,
	path: string,
	headers: Record<string, string> = {},
	body?: unknown,
) {
	return new Promise<{
		status: number | undefined
		headers: IncomingHttpHeaders
		body: string
	}>((resolve, reject) => {
		const encoded = body === undefined ? undefined : JSON.stringify(body)
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: encoded === undefined ? "GET" : "POST",
				headers: {
					Connection: "close",
					...(encoded === undefined
						? {}
						: { "Content-Type": "application/json" }),
					...headers,
				},
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
		req.setTimeout(2000, () =>
			req.destroy(new Error("Loopback request timed out")),
		)
		req.on("error", reject)
		req.end(encoded)
	})
}

async function listening(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = connect({ host: "127.0.0.1", port })
		const finish = (value: boolean) => {
			socket.destroy()
			resolve(value)
		}
		socket.once("connect", () => finish(true))
		socket.once("error", () => finish(false))
		socket.setTimeout(500, () => finish(false))
	})
}

async function websocket(port: number, headers: Record<string, string>) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
	sockets.push(socket)
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve)
		socket.once("error", reject)
	})
	const closed = new Promise<void>(resolve =>
		socket.once("close", () => resolve()),
	)
	return { socket, closed }
}

async function stop(core: RunningCore) {
	core.child.kill("SIGTERM")
	return core.exited
}

describe("built protected runtime process", () => {
	it("retains the operator lock code and reason through startup cleanup", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		const holder = await OperatorDataStorage.open({
			stateDir: env.config.stateDir,
		})
		try {
			await env.releasePorts()
			const core = run(env.configFile, env.directory)
			expect(await core.exited).toEqual({ code: 1, signal: null })
			expect(core.stderr()).toBe(
				"WaveKit startup failed: WaveKitError [OPERATOR_DATA_UNAVAILABLE/lock-held]: startup could not complete\n",
			)
			expect(core.stdout() + core.stderr()).not.toContain(env.directory)
			for (const port of [env.api, env.analog, env.digital, env.raw, env.relay])
				expect(await listening(port)).toBe(false)
		} finally {
			await holder.close()
		}
	}, 15_000)

	it("names the concrete access lock code on the startup line", async () => {
		const env = await fixture()
		const holder = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		try {
			await env.releasePorts()
			const core = run(env.configFile, env.directory)
			expect(await core.exited).toEqual({ code: 1, signal: null })
			expect(core.stderr()).toBe(
				"WaveKit startup failed: WaveKitError [ACCESS_STORAGE_BUSY]: startup could not complete\n",
			)
			expect(core.stdout() + core.stderr()).not.toContain(env.directory)
			for (const port of [env.api, env.analog, env.digital, env.raw, env.relay])
				expect(await listening(port)).toBe(false)
		} finally {
			await holder.close()
		}
	}, 15_000)

	it("mounts admission, disables raw listeners and drains SIGTERM before a durable browser restart", async () => {
		const env = await fixture()
		const storage = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		const token = storage.useMachineCredential(value => value)
		await storage.close()
		await env.releasePorts()
		const first = run(env.configFile, env.directory)
		await started(first)
		expect((await http(env.api, "/health")).status).toBe(200)
		expect((await http(env.api, "/api/status")).status).toBe(401)
		const machine = { Authorization: `Bearer ${token}` }
		expect((await http(env.api, "/api/status", machine)).status).toBe(200)
		const inventory = await http(env.api, "/api/decoders", machine)
		expect(inventory.status).toBe(200)
		const decoders = z
			.array(
				z.object({
					id: z.string(),
					running: z.boolean(),
					origin: z.literal("catalogue"),
				}),
			)
			.parse(JSON.parse(inventory.body))
		expect(decoders.map(decoder => decoder.id)).toEqual([
			"readsb",
			"ais-catcher",
			"acarsdec",
			"dumpvdl2",
			"rtl433",
			"direwolf",
			"multimon-ng",
			"dsd-fme",
			"lora-meshtastic",
		])
		expect(decoders.every(decoder => !decoder.running)).toBe(true)
		expect(
			(await http(env.api, "/api/decoders/efficiency", machine)).status,
		).toBe(200)
		expect(
			(await http(env.api, "/api/decoders/readsb/settings", machine)).status,
		).toBe(200)
		const operator = await http(env.api, "/api/operator-data", machine)
		expect(operator.status).toBe(200)
		expect(JSON.parse(operator.body)).toMatchObject({
			snapshot: { revision: 0 },
		})
		for (const port of [env.raw, env.relay, env.analog, env.digital])
			expect(await listening(port)).toBe(false)
		const issued = await http(env.api, "/api/access/pairing-codes", machine, {})
		expect(issued.status).toBe(201)
		const { code } = z
			.object({ code: z.string() })
			.parse(JSON.parse(issued.body))
		const paired = await http(
			env.api,
			"/api/access/pair",
			{ Origin: env.origin },
			{ code },
		)
		expect(paired.status).toBe(201)
		const cookieHeader = paired.headers["set-cookie"]?.[0]
		expect(cookieHeader).toContain("HttpOnly")
		if (!cookieHeader) throw new Error("Missing remembered-browser cookie")
		const browser = { Cookie: cookieHeader.split(";")[0]!, Origin: env.origin }
		const before = await http(env.api, "/api/access/session", browser)
		expect(before.status).toBe(200)
		const identity = z
			.object({ deviceId: z.string(), csrfToken: z.string() })
			.parse(JSON.parse(before.body))
		const browserWs = await websocket(env.api, browser)
		const machineWs = await websocket(env.api, machine)
		expect(await stop(first)).toEqual({ code: 0, signal: null })
		await Promise.all([browserWs.closed, machineWs.closed])
		expect(await listening(env.api)).toBe(false)
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toEqual([])
		const second = run(env.configFile, env.directory)
		await started(second)
		const remembered = await http(env.api, "/api/access/session", browser)
		expect(remembered.status).toBe(200)
		expect(
			z
				.object({ deviceId: z.string(), csrfToken: z.string() })
				.parse(JSON.parse(remembered.body)),
		).toEqual(identity)
		expect((await http(env.api, "/api/status", machine)).status).toBe(200)
		expect(await stop(second)).toEqual({ code: 0, signal: null })
		for (const core of [first, second]) {
			expect(core.stdout() + core.stderr()).not.toContain(token)
			expect(core.stdout() + core.stderr()).not.toContain(env.directory)
			expect(core.stdout() + core.stderr()).not.toContain(
				cookieHeader.split(";")[0],
			)
		}
		const snapshot = await readFile(
			join(env.directory, "access-state.json"),
			"utf8",
		)
		expect(snapshot).not.toContain(cookieHeader.split("=")[1]?.split(";")[0])
	}, 30_000)

	it("drains the real optional channelizer composition with no profile or acquisition", async () => {
		const env = await fixture()
		await writeFile(
			env.configFile,
			JSON.stringify({
				...env.config,
				channelizer: { enabled: true },
			}),
		)
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		// Ordinary entry: real registry, manager, scanner owner and finalizer, no contract plugins.
		const core = run(env.configFile, env.directory)
		await started(core)
		expect(await stop(core)).toEqual({ code: 0, signal: null })
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toEqual([])
		for (const port of [env.api, env.raw, env.relay, env.analog, env.digital])
			expect(await listening(port)).toBe(false)
	}, 15_000)

	it("aborts rejected operator acquisition with hidden lock cleanup failure and retains private owner", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		const core = run(env.configFile, env.directory, failedOperatorEntry)
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stdout()).not.toContain("WaveKit started successfully")
		expect(core.stdout()).toContain("Destroying DecoderManager")
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toHaveLength(1)
		await access(join(env.config.stateDir, "operator-data", ".writer-lock"))
		for (const port of [env.api, env.analog, env.digital, env.raw, env.relay])
			expect(await listening(port)).toBe(false)
	}, 15_000)

	it("retains private ownership when an acquired operator store fails actual lock release during shutdown", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		const core = run(env.configFile, env.directory, failedOperatorCloseEntry)
		await started(core)
		core.child.kill("SIGTERM")
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stdout()).toContain("Destroying DecoderManager")
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toHaveLength(1)
		await access(join(env.config.stateDir, "operator-data", ".writer-lock"))
		for (const port of [env.api, env.analog, env.digital, env.raw, env.relay])
			expect(await listening(port)).toBe(false)
	}, 15_000)

	it("settles a real operator open stalled before I/O after SIGTERM without mounting, then releases settled ownership", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		const core = run(env.configFile, env.directory, pausedOperatorEntry)
		await marker(core, "operator-open-paused")
		core.child.kill("SIGTERM")
		await marker(core, "operator-signal-seen")
		expect(await listening(env.api)).toBe(false)
		core.child.kill("SIGUSR2")
		expect(await core.exited).toEqual({ code: 0, signal: null })
		expect(core.stdout()).not.toContain("WaveKit started successfully")
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toHaveLength(0)
		await expect(
			access(join(env.config.stateDir, "operator-data", ".writer-lock")),
		).rejects.toMatchObject({ code: "ENOENT" })
	}, 15_000)

	it("legacy startup opens no operator store or lock and exposes no metadata routes", async () => {
		const env = await fixture()
		await writeFile(
			env.configFile,
			JSON.stringify({ ...env.config, access: { mode: "legacy" } }),
		)
		await env.releasePorts()
		const core = run(env.configFile)
		await started(core)
		expect((await http(env.api, "/api/operator-data")).status).toBe(404)
		await expect(
			access(join(env.config.stateDir, "operator-data")),
		).rejects.toMatchObject({ code: "ENOENT" })
		core.child.kill("SIGTERM")
		expect(await core.exited).toEqual({ code: 0, signal: null })
	}, 15_000)

	it("releases private ownership after a later API bind failure and settles earlier resources", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		// Keep the test's actual API-port listener to force EADDRINUSE after
		// protected state and core services have been constructed.
		await env.releasePorts(true)
		const core = run(env.configFile, env.directory)
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stderr()).toBe(
			"WaveKit startup failed: Error [EADDRINUSE]: startup could not complete\n",
		)
		expect(core.stdout()).not.toContain("WaveKit started successfully")
		expect(core.stdout() + core.stderr()).not.toContain(env.directory)
		expect(core.stdout() + core.stderr()).toContain(
			"Failed to start API server",
		)
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toEqual([])
		const reopened = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "load",
			ownership: "single-host-pid-namespace",
		})
		await reopened.close()
		for (const port of [env.raw, env.relay, env.analog, env.digital])
			expect(await listening(port)).toBe(false)
		// API remains held by this test, and is deliberately excluded above.
	}, 15_000)

	it("retains failed partial scanner cleanup even when a repeated stop would resolve", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		const core = run(env.configFile, env.directory, failedScannerEntry)
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stderr()).toBe(
			"WaveKit startup failed: WaveKitError [ACCESS_UNAVAILABLE]: startup could not complete\n",
		)
		expect(core.stdout()).not.toContain("WaveKit started successfully")
		expect(core.stdout().match(/scanner-stop-real/g)).toHaveLength(1)
		expect(core.stdout()).not.toContain("scanner-stop-noop")
		// Shutdown still attempts other constructed resources after that rejection.
		expect(core.stdout()).toContain("Destroying DecoderManager")
		// Retaining this file proves close() never released access ownership.
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toHaveLength(1)
		for (const port of [env.api, env.raw, env.relay, env.analog, env.digital])
			expect(await listening(port)).toBe(false)
	}, 15_000)

	it("preserves legacy startup fallback after the same partial scanner cleanup failure", async () => {
		const env = await fixture()
		await writeFile(
			env.configFile,
			JSON.stringify({ ...env.config, access: { mode: "legacy" } }),
		)
		await env.releasePorts()
		const core = run(env.configFile, undefined, failedScannerEntry)
		await started(core)
		expect(core.stdout()).toContain(
			"Stopping the partially started scanner failed",
		)
		expect(core.stdout().match(/scanner-stop-real/g)).toHaveLength(1)
		expect(await listening(env.api)).toBe(true)
		expect(await listening(env.raw)).toBe(true)
		core.child.kill("SIGTERM")
		expect(await core.exited).toEqual({ code: 1, signal: null })
	}, 15_000)

	it("seals scanner and provider admission before a held operator drain", async () => {
		const env = await fixture()
		env.config.channelizer.enabled = true
		await writeFile(env.configFile, JSON.stringify(env.config))
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		const core = run(
			env.configFile,
			env.directory,
			scannerPhasesEntry,
			"operator-held",
		)
		await started(core)
		core.child.kill("SIGTERM")
		await marker(core, "operator-drain-paused")
		const held = core.stdout()
		expect(held.indexOf("provider-admission-sealed")).toBeGreaterThanOrEqual(0)
		expect(held.indexOf("scanner-admission-sealed")).toBeGreaterThanOrEqual(0)
		expect(held.indexOf("provider-admission-sealed")).toBeLessThan(
			held.indexOf("operator-drain-paused"),
		)
		expect(held.indexOf("scanner-admission-sealed")).toBeLessThan(
			held.indexOf("operator-drain-paused"),
		)
		expect(held).not.toContain("scanner-stop-real")
		expect(held).not.toContain("core-native-attempt")
		expect(core.child.exitCode).toBeNull()
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toHaveLength(1)
		core.child.kill("SIGUSR2")
		expect(await core.exited).toEqual({ code: 0, signal: null })
		expect(core.stdout().match(/scanner-stop-real/g)).toHaveLength(1)
		expect(core.stdout()).toContain("scanner-probes-cleaned")
		expect(core.stdout()).toContain("provider-final-inspected")
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toEqual([])
	}, 15_000)

	it("cleans externally owned scanner components when construction returns no service", async () => {
		const env = await fixture()
		env.config.channelizer.enabled = true
		await writeFile(env.configFile, JSON.stringify(env.config))
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		const core = run(
			env.configFile,
			env.directory,
			scannerPhasesEntry,
			"constructor-failure",
		)
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stderr()).toBe(
			"WaveKit startup failed: WaveKitError [ACCESS_UNAVAILABLE]: startup could not complete\n",
		)
		expect(core.stdout()).not.toContain("WaveKit started successfully")
		expect(core.stdout().match(/scanner-stop-real/g)).toHaveLength(1)
		expect(core.stdout()).toContain("scanner-probes-cleaned")
		expect(core.stdout()).toContain("Destroying DecoderManager")
		expect(core.stdout()).toContain("core-native-attempt")
		expect(core.stdout()).toContain("provider-local-attempt")
		expect(core.stdout()).toContain("provider-final-inspected")
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toHaveLength(1)
		expect(await listening(env.api)).toBe(false)
	}, 15_000)

	it.each(["native-failure", "local-failure"] as const)(
		"attempts both independent core cleanups and retains private ownership after %s",
		async kind => {
			const env = await fixture()
			env.config.channelizer.enabled = true
			await writeFile(env.configFile, JSON.stringify(env.config))
			const provision = await PrivateAccessStorage.open({
				directory: env.directory,
				mode: "provision",
				ownership: "single-host-pid-namespace",
			})
			await provision.close()
			await env.releasePorts()
			const core = run(env.configFile, env.directory, scannerPhasesEntry, kind)
			await started(core)
			core.child.kill("SIGTERM")
			expect(await core.exited).toEqual({ code: 1, signal: null })
			expect(core.stdout().match(/core-native-attempt/g)).toHaveLength(1)
			expect(core.stdout().match(/provider-local-attempt/g)).toHaveLength(1)
			expect(core.stdout()).toContain("scanner-probes-cleaned")
			expect(core.stdout()).toContain("Destroying DecoderManager")
			expect(core.stdout()).toContain("provider-final-inspected")
			expect(
				(await readdir(env.directory)).filter(name =>
					name.startsWith("owner-"),
				),
			).toHaveLength(1)
			for (const port of [env.api, env.raw, env.relay, env.analog, env.digital])
				expect(await listening(port)).toBe(false)
		},
		15_000,
	)

	it("keeps the actual legacy signal pending after generic handler timeouts and exits on the retained failure", async () => {
		const env = await fixture()
		await writeFile(
			env.configFile,
			JSON.stringify({
				...env.config,
				channelizer: { enabled: true },
				access: { mode: "legacy" },
			}),
		)
		await env.releasePorts()
		const core = run(
			env.configFile,
			undefined,
			scannerPhasesEntry,
			"legacy-held",
		)
		await started(core)
		core.child.kill("SIGTERM")
		await marker(core, "scanner-component-paused")
		await marker(core, "generic-utility-fulfilled")
		expect(core.stdout()).toContain("Shutdown handler failed or timed out")
		expect(core.child.exitCode).toBeNull()
		expect(core.child.signalCode).toBeNull()
		expect(core.stdout()).not.toContain("provider-final-inspected")
		core.child.kill("SIGUSR2")
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stdout().match(/scanner-stop-real/g)).toHaveLength(1)
		expect(core.stdout()).toContain("scanner-probes-cleaned")
		expect(core.stdout()).toContain("core-native-attempt")
		expect(core.stdout()).toContain("provider-local-attempt")
		expect(core.stdout()).toContain("provider-final-inspected")
		expect(await listening(env.api)).toBe(false)
		expect(await listening(env.raw)).toBe(false)
	}, 15_000)

	it.each([
		"implicit relay",
		"missing private authority",
		"private config secret",
	] as const)(
		"fails %s before API availability with a fixed fatal message",
		async kind => {
			const env = await fixture()
			if (kind === "implicit relay") env.config.tunerRelay.enabled = true
			const input =
				kind === "private config secret"
					? {
							...env.config,
							access: {
								...env.config.access,
								machineToken: "SECRET-config-credential",
							},
						}
					: env.config
			await writeFile(env.configFile, JSON.stringify(input))
			await env.releasePorts()
			const core = run(env.configFile)
			const result = await core.exited
			expect(result).toEqual({ code: 1, signal: null })
			expect(core.stderr()).toBe(
				kind === "implicit relay"
					? "WaveKit startup failed: ConfigValidationError [CONFIG_VALIDATION_ERROR]: startup could not complete\n"
					: kind === "missing private authority"
						? "WaveKit startup failed: WaveKitError [ACCESS_RUNTIME_UNAVAILABLE]: startup could not complete\n"
						: "WaveKit startup failed: WaveKitError [ACCESS_CONFIG_INVALID]: startup could not complete\n",
			)
			expect(core.stdout()).not.toContain("WaveKit started successfully")
			expect(core.stdout() + core.stderr()).not.toContain("SECRET")
			for (const port of [env.api, env.raw, env.relay])
				expect(await listening(port)).toBe(false)
		},
		15_000,
	)
})

// These are process-owned synthetic files/listeners, never a configured receiver.
describe.each(["protected", "legacy"] as const)(
	"metadata entry composition %s",
	mode => {
		async function prepare() {
			const env = await fixture()
			let token = ""
			if (mode === "protected") {
				const provision = await PrivateAccessStorage.open({
					directory: env.directory,
					mode: "provision",
					ownership: "single-host-pid-namespace",
				})
				token = provision.useMachineCredential(value => value)
				await provision.close()
			} else
				await writeFile(
					env.configFile,
					JSON.stringify({ ...env.config, access: { mode } }),
				)
			return {
				...env,
				token,
				directory: mode === "protected" ? env.directory : undefined,
			}
		}

		it("serves evidence-pending regional data and actual recording evidence, then disposes after API drain", async () => {
			const env = await prepare()
			const filePath = join(env.root, "TEST-only-iq.u8")
			await writeFile(filePath, Buffer.alloc(4096, 128))
			await writeFile(
				env.configFile,
				JSON.stringify({
					...env.config,
					...(mode === "legacy" ? { access: { mode } } : {}),
					sources: [
						{
							id: "TEST-recording",
							type: "recording",
							filePath,
							loop: false,
							caps: {
								kind: "iq",
								format: "U8_IQ",
								sampleRate: 2400000,
								exclusive: false,
							},
						},
					],
				}),
			)
			await env.releasePorts()
			const core = run(env.configFile, env.directory, metadataLifecycleEntry)
			await started(core)
			const headers =
				mode === "protected" ? { Authorization: `Bearer ${env.token}` } : {}
			const regional = await http(
				env.api,
				"/api/regional/channels?region=US&family=frs",
				headers,
			)
			expect(regional.status).toBe(200)
			expect(JSON.parse(regional.body)).toMatchObject({
				state: "unavailable",
				reason: "evidence-pending",
			})
			expect(JSON.parse(regional.body)).not.toHaveProperty("rows")
			const receiver = await http(
				env.api,
				"/api/receiver-capabilities/TEST-recording",
				headers,
			)
			expect(receiver.status).toBe(200)
			const evidence = z
				.object({
					sourceId: z.literal("TEST-recording"),
					sessionId: z.null(),
					peerHeader: z.object({ state: z.literal("not-applicable") }),
					controls: z
						.array(
							z.object({
								physical: z.object({ state: z.literal("unknown") }),
								currentValue: z.object({ state: z.literal("unknown") }),
							}),
						)
						.length(15),
				})
				.parse(JSON.parse(receiver.body))
			expect(evidence.sourceId).toBe("TEST-recording")
			expect(receiver.headers["cache-control"]).toBe("no-store")
			expect(await stop(core)).toEqual({ code: 0, signal: null })
			const output = core.stdout()
			expect(output.match(/metadata-disposed/g)).toHaveLength(1)
			expect(output.indexOf("metadata-api-drained")).toBeLessThan(
				output.indexOf("metadata-disposed"),
			)
			expect(output.indexOf("metadata-disposed")).toBeLessThan(
				output.indexOf("metadata-sources-disconnected"),
			)
		}, 15_000)

		it.each(["metadata-constructor-failure", "metadata-bind-failure"])(
			"cleans immediately owned provider on %s",
			async failure => {
				const env = await prepare()
				await env.releasePorts(failure === "metadata-bind-failure")
				const core = run(
					env.configFile,
					env.directory,
					metadataLifecycleEntry,
					failure,
				)
				expect(await core.exited).toEqual({ code: 1, signal: null })
				expect(core.stdout().match(/metadata-disposed/g)).toHaveLength(1)
				expect(core.stdout()).not.toContain("WaveKit started successfully")
				if (failure === "metadata-bind-failure")
					expect(core.stdout().indexOf("metadata-api-drained")).toBeLessThan(
						core.stdout().indexOf("metadata-disposed"),
					)
			},
			15_000,
		)

		it("defers disposal until signal-stalled API startup actually settles", async () => {
			const env = await prepare()
			await env.releasePorts()
			const core = run(
				env.configFile,
				env.directory,
				metadataLifecycleEntry,
				"metadata-start-paused",
			)
			await marker(core, "metadata-start-paused")
			core.child.kill("SIGTERM")
			await marker(core, "metadata-signal-seen")
			expect(core.stdout()).not.toContain("metadata-disposed")
			expect(await listening(env.api)).toBe(false)
			core.child.kill("SIGUSR2")
			expect(await core.exited).toEqual({ code: 0, signal: null })
			expect(core.stdout().match(/metadata-disposed/g)).toHaveLength(1)
			expect(core.stdout()).not.toContain("WaveKit started successfully")
		}, 15_000)

		it("does not mistake a generic shutdown-handler timeout for actual API drain", async () => {
			const env = await prepare()
			await env.releasePorts()
			const core = run(
				env.configFile,
				env.directory,
				metadataLifecycleEntry,
				"metadata-drain-held",
			)
			await started(core)
			core.child.kill("SIGTERM")
			await marker(core, "metadata-drain-held")
			if (mode === "legacy")
				await marker(core, "Shutdown handler failed or timed out")
			expect(core.stdout()).not.toContain("metadata-disposed")
			expect(core.stdout()).not.toContain("metadata-sources-disconnected")
			core.child.kill("SIGUSR2")
			expect(await core.exited).toEqual({ code: 0, signal: null })
			expect(core.stdout().match(/metadata-disposed/g)).toHaveLength(1)
			expect(core.stdout().indexOf("metadata-api-drained")).toBeLessThan(
				core.stdout().indexOf("metadata-disposed"),
			)
		}, 15_000)
	},
)
