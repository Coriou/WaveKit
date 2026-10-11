import { isAbsolute } from "node:path"
import { isIP } from "node:net"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { resolveAccessBootstrap } from "./bootstrap-policy.js"
import type { ProtectedAccessBootstrap } from "./bootstrap-policy.js"
import { canonicalPairingOrigin, requestPairingCode } from "./pairing-client.js"
import { setupLocalAccess } from "./setup.js"

export interface AccessCommandResult {
	exitCode: 0 | 1
	/** Only public settings/status or the intentionally displayed one-time code. */
	lines: readonly string[]
}
interface CommandOptions {
	command: "setup" | "pair"
	directory: string
	apiOrigin: string
	ownership?: "single-host-pid-namespace"
	allowedOrigins: string[]
	externalAudioOrigins: string[]
	timeoutMs?: number
}
const help = [
	"Usage: node dist/access-command.js setup --private-directory ABS --ownership single-host-pid-namespace --api-origin ORIGIN --allow-origin ORIGIN [--allow-origin ORIGIN] [--external-audio-origin ORIGIN]",
	"       node dist/access-command.js pair --private-directory ABS --api-origin ORIGIN [--timeout-ms 1..30000]",
	"Setup runs with the core stopped. It provisions private state and prints a public access plan; it does not enable runtime protection.",
	"Setup uses one canonical hostname and scheme for browser/API/audio origins, with explicit ports. LAN browser use requires HTTPS; HTTP is available only for explicit loopback targets.",
	"Pair requests a one-time code from a running core with the access service mounted. Browser pairing and rolling 30-day renewal need the connected web UI.",
]
function invalid(): AccessCommandResult {
	return {
		exitCode: 1,
		lines: ["ACCESS_COMMAND_INVALID: Invalid access command. Use --help."],
	}
}

function parseArguments(input: readonly string[]): CommandOptions | undefined {
	const parsed = z
		.array(
			z
				.string()
				.min(1)
				.max(4096)
				.refine(value => !value.includes("\0")),
		)
		.max(256)
		.safeParse(input)
	if (!parsed.success) return undefined
	const [command, ...args] = parsed.data
	if (command !== "setup" && command !== "pair") return undefined
	const single = new Map<string, string>()
	const allowedOrigins: string[] = []
	const externalAudioOrigins: string[] = []
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index]
		const value = args[index + 1]
		if (!flag || !value) return undefined
		if (command === "setup" && flag === "--allow-origin")
			allowedOrigins.push(canonicalPairingOrigin(value))
		else if (command === "setup" && flag === "--external-audio-origin")
			externalAudioOrigins.push(canonicalPairingOrigin(value))
		else if (
			[
				"--private-directory",
				"--api-origin",
				...(command === "setup" ? ["--ownership"] : ["--timeout-ms"]),
			].includes(flag)
		) {
			if (single.has(flag)) return undefined
			single.set(flag, value)
		} else return undefined
	}
	const directory = single.get("--private-directory")
	const rawOrigin = single.get("--api-origin")
	if (!directory || !isAbsolute(directory) || !rawOrigin) return undefined
	const apiOrigin = canonicalPairingOrigin(rawOrigin)
	if (command === "setup") {
		if (
			single.get("--ownership") !== "single-host-pid-namespace" ||
			allowedOrigins.length < 1
		)
			return undefined
		return {
			command,
			directory,
			apiOrigin,
			ownership: "single-host-pid-namespace",
			allowedOrigins,
			externalAudioOrigins,
		}
	}
	const timeoutText = single.get("--timeout-ms")
	if (
		timeoutText !== undefined &&
		(!/^[1-9][0-9]{0,4}$/.test(timeoutText) || Number(timeoutText) > 30_000)
	)
		return undefined
	return {
		command,
		directory,
		apiOrigin,
		allowedOrigins,
		externalAudioOrigins,
		...(timeoutText === undefined ? {} : { timeoutMs: Number(timeoutText) }),
	}
}

function publicPlan(options: CommandOptions): ProtectedAccessBootstrap {
	const url = new URL(options.apiOrigin)
	const audio = options.externalAudioOrigins.map(origin => new URL(origin))
	if (options.command === "setup") {
		const browser = options.allowedOrigins.map(origin => new URL(origin))
		const coherent = [...browser, ...audio].every(
			origin =>
				origin.hostname === url.hostname && origin.protocol === url.protocol,
		)
		const loopback =
			url.hostname === "localhost" ||
			url.hostname === "[::1]" ||
			(isIP(url.hostname) === 4 && url.hostname.startsWith("127."))
		if (!coherent || (url.protocol === "http:" && !loopback))
			throw new WaveKitError("Invalid access command", "ACCESS_COMMAND_INVALID")
	}
	const plan = resolveAccessBootstrap({
		mode: "protected",
		listenerScheme: url.protocol === "https:" ? "https" : "http",
		allowedAuthorities: [url.host, ...audio.map(origin => origin.host)],
		allowedOrigins: options.allowedOrigins,
		externalAudioOrigins: options.externalAudioOrigins,
	})
	if (plan.mode !== "protected")
		throw new WaveKitError("Invalid access command", "ACCESS_COMMAND_INVALID")
	return plan
}

/** New standalone utility only: no YAML/config mutation or runtime listeners. */
export async function runAccessCommand(
	argv: readonly string[],
): Promise<AccessCommandResult> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help"))
		return { exitCode: 0, lines: help }
	let options: CommandOptions | undefined
	try {
		options = parseArguments(argv)
		if (!options) return invalid()
	} catch {
		return invalid()
	}
	if (options.command === "setup") {
		let plan: ProtectedAccessBootstrap
		try {
			plan = publicPlan(options)
		} catch {
			return invalid()
		}
		const result = await setupLocalAccess({
			directory: options.directory,
			ownership: "single-host-pid-namespace",
		})
		if (result.kind !== "ready")
			return {
				exitCode: 1,
				lines: [
					result.nextStep === "stop-core-and-retry"
						? "ACCESS_SETUP_UNAVAILABLE: Stop the core and retry setup."
						: "ACCESS_SETUP_UNAVAILABLE: Private access state needs offline repair; no replacement credential was provisioned.",
				],
			}
		return {
			exitCode: 0,
			lines: [
				`${result.code}: Private access state is ready.`,
				`Public access plan (not active runtime configuration): ${JSON.stringify(plan)}`,
				"Runtime admission integration is still required; this command does not enable protected listeners. Then start the core using the same private directory and request a browser pairing code.",
				"The listener scheme describes the external deployment. Configure and verify actual listener bindings and HTTPS termination before browser use; this utility creates no TLS listener or certificates.",
			],
		}
	}
	const result = await requestPairingCode({
		apiOrigin: options.apiOrigin,
		directory: options.directory,
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
	})
	if (result.kind !== "issued")
		return {
			exitCode: 1,
			lines: [
				`${result.code}: Pairing is unavailable. A running core must mount the access service; no code was generated locally. Do not retry automatically after a timeout.`,
			],
		}
	return {
		exitCode: 0,
		lines: [
			`One-time browser pairing code: ${result.code}`,
			`Expires in ${result.expiresInSeconds} seconds. Enter it in the connected web UI; the code is not a reusable API credential.`,
		],
	}
}
