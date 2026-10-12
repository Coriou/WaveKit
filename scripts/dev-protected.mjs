#!/usr/bin/env node
import { spawn } from "node:child_process"
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const templatePath = fileURLToPath(
	new URL("../config/dev-protected.yaml", import.meta.url),
)
const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url))
const accessCommand = fileURLToPath(
	new URL("../dist/access-command.js", import.meta.url),
)
const usage = `Usage: node scripts/dev-protected.mjs [--keep] [--api-port N] [--analog-port N] [--digital-port N]
       node scripts/dev-protected.mjs --pair --private-directory ABS [--api-origin ORIGIN]

Starts the real server in protected local-http mode with no receiver, dongle,
Docker, or decoders. Provisions a throwaway private access directory, prints the
three loopback origins, the bootstrap URL, and a one-time pairing code, then
removes the directory on exit. --keep retains it and prints its path. --pair
re-issues a code for a running instance. The machine credential is never printed.
N is 1-65535, or 0 for an ephemeral port. Build first with pnpm run build.
`
const codePattern =
	/[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}/

function fail(message) {
	process.stderr.write(`${message}\n${usage}`)
	process.exit(1)
}

function parsePort(value) {
	if (!/^(0|[1-9]\d{0,4})$/.test(value)) return undefined
	const port = Number(value)
	return port <= 65535 ? port : undefined
}

function parseArgs(argv) {
	const options = {
		help: false,
		pair: false,
		keep: false,
		directory: undefined,
		apiOrigin: undefined,
		apiPort: undefined,
		analogPort: undefined,
		digitalPort: undefined,
	}
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]
		const take = () => {
			const value = argv[index + 1]
			if (value === undefined || value.startsWith("-") || value.includes("\0"))
				return undefined
			index += 1
			return value
		}
		if (flag === "--help" || flag === "-h") options.help = true
		else if (flag === "--pair") {
			if (options.pair) return undefined
			options.pair = true
		} else if (flag === "--keep") {
			if (options.keep) return undefined
			options.keep = true
		} else if (flag === "--private-directory") {
			const value = take()
			if (!value || options.directory !== undefined || !isAbsolute(value))
				return undefined
			options.directory = value
		} else if (flag === "--api-origin") {
			const value = take()
			if (!value || options.apiOrigin !== undefined) return undefined
			options.apiOrigin = value
		} else if (
			flag === "--api-port" ||
			flag === "--analog-port" ||
			flag === "--digital-port"
		) {
			const value = take()
			const port = value === undefined ? undefined : parsePort(value)
			const key =
				flag === "--api-port"
					? "apiPort"
					: flag === "--analog-port"
						? "analogPort"
						: "digitalPort"
			if (port === undefined || options[key] !== undefined) return undefined
			options[key] = port
		} else return undefined
	}
	if (options.help && argv.length === 1) return options
	if (options.help) return undefined
	if (options.pair) {
		if (
			options.keep ||
			options.directory === undefined ||
			options.apiPort !== undefined ||
			options.analogPort !== undefined ||
			options.digitalPort !== undefined
		)
			return undefined
		return options
	}
	if (options.directory !== undefined || options.apiOrigin !== undefined)
		return undefined
	return options
}

function runtimeEnv(extra) {
	const env = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("WAVEKIT_")) continue
		env[key] = value
	}
	return { ...env, ...extra }
}

let activeCommand

function runCommand(args) {
	return new Promise((resolve, reject) => {
		const command = spawn(process.execPath, [accessCommand, ...args], {
			cwd: root,
			env: runtimeEnv({}),
			stdio: ["ignore", "pipe", "pipe"],
		})
		activeCommand = command
		let stdout = ""
		let stderr = ""
		const timer = setTimeout(() => command.kill("SIGKILL"), 15_000)
		const finish = () => {
			clearTimeout(timer)
			if (activeCommand === command) activeCommand = undefined
		}
		command.stdout.on("data", chunk => {
			stdout += chunk.toString()
		})
		command.stderr.on("data", chunk => {
			stderr += chunk.toString()
		})
		command.once("error", error => {
			finish()
			reject(error)
		})
		command.once("close", code => {
			finish()
			resolve({ code: code ?? 1, stdout, stderr })
		})
	})
}

async function assertBuilt() {
	try {
		await access(serverEntry)
		await access(accessCommand)
	} catch {
		fail(
			"Build WaveKit before the protected development server: pnpm run build",
		)
	}
}

function readTemplatePorts(template) {
	const api = /^api:\n  host: 127\.0\.0\.1\n  port: ([1-9]\d{0,4})$/m.exec(
		template,
	)
	const audio = /^audio:\n  tcpPort: ([1-9]\d{0,4})$/m.exec(template)
	const analog =
		/^liveDemod:\n  enabled: false\n  httpPort: ([1-9]\d{0,4})$/m.exec(template)
	const digital =
		/^digitalVoice:\n  enabled: false\n  httpPort: ([1-9]\d{0,4})$/m.exec(
			template,
		)
	if (!api?.[1] || !audio?.[1] || !analog?.[1] || !digital?.[1])
		throw new Error(
			"config/dev-protected.yaml must bind local-http on 127.0.0.1 with api.port, audio.tcpPort, liveDemod.httpPort and digitalVoice.httpPort",
		)
	const ports = {
		api: Number(api[1]),
		audio: Number(audio[1]),
		analog: Number(analog[1]),
		digital: Number(digital[1]),
	}
	if (
		new Set([ports.api, ports.audio, ports.analog, ports.digital]).size !== 4 ||
		Object.values(ports).some(port => port > 65535)
	)
		throw new Error(
			"config/dev-protected.yaml ports must be four distinct TCP ports",
		)
	return ports
}

function reservePort() {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (!address || typeof address === "string") {
				server.close()
				reject(new Error("Could not reserve a loopback port"))
				return
			}
			const { port } = address
			server.close(error => (error ? reject(error) : resolve(port)))
		})
	})
}

async function choosePort(requested, used) {
	if (requested !== 0) {
		if (used.has(requested))
			throw new Error(`Port ${requested} is already selected`)
		used.add(requested)
		return requested
	}
	for (let attempt = 0; attempt < 20; attempt++) {
		const port = await reservePort()
		if (!used.has(port)) {
			used.add(port)
			return port
		}
	}
	throw new Error("Could not reserve a distinct loopback port")
}

function origin(port) {
	return `http://127.0.0.1:${port}`
}

function renderConfig(template, defaults, ports, stateDir) {
	let rendered = template
	const tokens = [
		[defaults.api, "__WAVEKIT_DEV_API_PORT__"],
		[defaults.analog, "__WAVEKIT_DEV_ANALOG_PORT__"],
		[defaults.digital, "__WAVEKIT_DEV_DIGITAL_PORT__"],
	]
	for (const [port, token] of tokens)
		rendered = rendered.replaceAll(String(port), token)
	rendered = rendered
		.replaceAll("__WAVEKIT_DEV_API_PORT__", String(ports.api))
		.replaceAll("__WAVEKIT_DEV_ANALOG_PORT__", String(ports.analog))
		.replaceAll("__WAVEKIT_DEV_DIGITAL_PORT__", String(ports.digital))
	if (rendered.includes("__WAVEKIT_DEV_"))
		throw new Error("Port substitution failed")
	for (const value of [
		origin(ports.api),
		origin(ports.analog),
		origin(ports.digital),
	]) {
		if (!rendered.includes(value))
			throw new Error("Rendered config is missing a canonical origin")
	}
	if (!rendered.endsWith("\n")) rendered += "\n"
	rendered += `stateDir: ${JSON.stringify(stateDir)}\n`
	return rendered
}

async function issuePairingCode(directory, apiOrigin) {
	const result = await runCommand([
		"pair",
		"--private-directory",
		directory,
		"--api-origin",
		apiOrigin,
		"--timeout-ms",
		"5000",
	])
	const match = result.stdout.match(
		new RegExp(`One-time browser pairing code: (${codePattern.source})`),
	)
	if (result.code !== 0 || !match?.[1]) {
		if (result.stderr) process.stderr.write(result.stderr)
		throw new Error(
			"Pairing code was not issued. A running protected server and its private directory are required.",
		)
	}
	return match[1]
}

function printLines(lines) {
	process.stdout.write(`${lines.join("\n")}\n`)
}

function probe(port) {
	return new Promise(resolve => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path: "/health",
				method: "GET",
				timeout: 1000,
			},
			response => {
				response.resume()
				resolve(response.statusCode === 200)
			},
		)
		req.on("error", () => resolve(false))
		req.on("timeout", () => {
			req.destroy()
			resolve(false)
		})
		req.end()
	})
}

let passLogs = true
const heldLogs = []

function forwardStream(stream, destination) {
	stream.on("data", chunk => {
		if (passLogs) destination.write(chunk)
		else heldLogs.push({ destination, chunk })
	})
}

function flushLogs() {
	passLogs = true
	for (const item of heldLogs.splice(0)) item.destination.write(item.chunk)
}

function signalGroup(child, signal) {
	if (!child.pid) return
	try {
		if (process.platform !== "win32") process.kill(-child.pid, signal)
		else child.kill(signal)
	} catch (error) {
		if (error.code !== "ESRCH") throw error
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	if (!options) fail("Invalid dev-protected arguments.")
	if (options.help) {
		process.stdout.write(usage)
		return
	}
	await assertBuilt()
	const template = await readFile(templatePath, "utf8")
	const defaults = readTemplatePorts(template)
	let child
	let stopSignal
	let escalate
	let signaledChild = false
	const stopped = () => {
		if (!stopSignal) return false
		process.exitCode = stopSignal === "SIGINT" ? 130 : 143
		return true
	}
	const requestStop = signal => {
		if (!stopSignal) stopSignal = signal
		if (activeCommand && activeCommand.exitCode === null)
			activeCommand.kill("SIGKILL")
		if (
			!child ||
			signaledChild ||
			child.exitCode !== null ||
			child.signalCode !== null
		)
			return
		signaledChild = true
		signalGroup(child, stopSignal)
		escalate = setTimeout(() => {
			if (child && child.exitCode === null && child.signalCode === null)
				signalGroup(child, "SIGKILL")
		}, 12_000)
		escalate.unref()
	}
	process.on("SIGINT", () => requestStop("SIGINT"))
	process.on("SIGTERM", () => requestStop("SIGTERM"))
	if (options.pair) {
		if (!options.directory) fail("Invalid dev-protected arguments.")
		const apiOrigin = options.apiOrigin ?? origin(defaults.api)
		const code = await issuePairingCode(options.directory, apiOrigin)
		if (stopped()) return
		printLines([`One-time browser pairing code: ${code}`])
		return
	}

	const used = new Set([defaults.audio])
	const ports = {
		api: await choosePort(options.apiPort ?? defaults.api, used),
		analog: await choosePort(options.analogPort ?? defaults.analog, used),
		digital: await choosePort(options.digitalPort ?? defaults.digital, used),
	}
	const apiOrigin = origin(ports.api)
	const analogOrigin = origin(ports.analog)
	const digitalOrigin = origin(ports.digital)
	let workspace
	let directory
	let announced = false
	let childDone = Promise.resolve({ code: 0, signal: null })
	try {
		if (stopped()) return
		workspace = await mkdtemp(join(tmpdir(), "wavekit-dev-protected-"))
		await chmod(workspace, 0o700)
		directory = await mkdtemp(join(workspace, "private-"))
		await chmod(directory, 0o700)
		const stateDir = join(workspace, "state")
		await mkdir(stateDir, { mode: 0o700 })
		await chmod(stateDir, 0o700)
		const configPath = join(workspace, "runtime.yaml")
		await writeFile(
			configPath,
			renderConfig(template, defaults, ports, stateDir),
			{ mode: 0o600 },
		)
		if (stopped()) return
		const setup = await runCommand([
			"setup",
			"--private-directory",
			directory,
			"--ownership",
			"single-host-pid-namespace",
			"--api-origin",
			apiOrigin,
			"--allow-origin",
			apiOrigin,
			"--external-audio-origin",
			analogOrigin,
			"--external-audio-origin",
			digitalOrigin,
		])
		if (stopped()) return
		if (setup.code !== 0) {
			if (setup.stderr) process.stderr.write(setup.stderr)
			throw new Error("Access setup failed")
		}

		child = spawn(process.execPath, [serverEntry], {
			cwd: root,
			env: runtimeEnv({
				WAVEKIT_CONFIG: configPath,
				WAVEKIT_ACCESS_PRIVATE_DIRECTORY: directory,
			}),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		})
		forwardStream(child.stdout, process.stdout)
		forwardStream(child.stderr, process.stderr)
		childDone = new Promise(resolve => {
			child.once("error", () => resolve({ code: 1, signal: null }))
			child.once("close", (code, signal) => resolve({ code, signal }))
		})
		if (stopSignal) requestStop(stopSignal)
		const deadline = Date.now() + 20_000
		let healthy = false
		while (Date.now() < deadline) {
			if (stopSignal) break
			if (child.exitCode !== null || child.signalCode !== null) break
			if (await probe(ports.api)) {
				healthy = true
				break
			}
			await delay(100)
		}
		if (!healthy) {
			if (stopped()) return
			throw new Error(
				"Protected development server exited or did not become healthy",
			)
		}
		const code = await issuePairingCode(directory, apiOrigin)
		if (stopped()) return
		const lines = [
			`API origin: ${apiOrigin}`,
			`Analog audio origin: ${analogOrigin}`,
			`Digital audio origin: ${digitalOrigin}`,
			`Bootstrap URL: ${apiOrigin}/api/access/bootstrap`,
			`One-time browser pairing code: ${code}`,
			`Private access directory: ${directory}`,
		]
		if (options.keep) lines.push("Keeping private access directory after exit.")
		passLogs = false
		printLines(lines)
		announced = true
		flushLogs()
		const result = await childDone
		if (stopped()) return
		process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 1)
	} finally {
		if (child && child.exitCode === null && child.signalCode === null)
			requestStop(stopSignal ?? "SIGTERM")
		if (child) await childDone
		if (escalate) clearTimeout(escalate)
		if (options.keep && directory && !announced) {
			process.stderr.write(
				`Keeping private access directory after exit.\nPrivate access directory: ${directory}\n`,
			)
		}
		if (!options.keep && workspace)
			await rm(workspace, { recursive: true, force: true })
	}
}

process.stdout.on("error", () => {
	process.exitCode = 1
})
process.stderr.on("error", () => {
	process.exitCode = 1
})
main().catch(error => {
	const message =
		error instanceof Error ? error.message : "dev-protected failed"
	process.stderr.write(`${message}\n`)
	if (!process.exitCode) process.exitCode = 1
})
