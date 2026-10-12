import { isAbsolute } from "node:path"
import { isIP } from "node:net"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { resolveAccessBootstrap } from "./bootstrap-policy.js"
import type { ProtectedAccessBootstrap } from "./bootstrap-policy.js"
import {
	requestMachineDevices,
	revokeAllMachineDevices,
	revokeMachineDevice,
} from "./machine-client.js"
import type { MachineAccessDevicesDto } from "./machine-devices.js"
import { rotateLocalMachineCredential } from "./machine-rotation.js"
import { canonicalPairingOrigin, requestPairingCode } from "./pairing-client.js"
import { setupLocalAccess } from "./setup.js"

export interface AccessCommandResult {
	exitCode: 0 | 1
	/** Only public settings/status or the intentionally displayed one-time code. */
	lines: readonly string[]
}
interface SetupOptions {
	command: "setup"
	directory: string
	apiOrigin: string
	ownership: "single-host-pid-namespace"
	allowedOrigins: string[]
	externalAudioOrigins: string[]
}
interface PairOptions {
	command: "pair"
	directory: string
	apiOrigin: string
	allowedOrigins: string[]
	externalAudioOrigins: string[]
	timeoutMs?: number
}
interface RemoteOptions {
	directory: string
	apiOrigin: string
	timeoutMs?: number
}
type CommandOptions =
	| SetupOptions
	| PairOptions
	| { command: "rotate-credential"; directory: string; keepSessions: boolean }
	| ({ command: "devices-list"; json: boolean } & RemoteOptions)
	| ({ command: "devices-revoke"; deviceId: string } & RemoteOptions)
	| ({ command: "devices-revoke-all" } & RemoteOptions)
	| { command: "devices-revoke-all-unconfirmed" }
const help = [
	"Usage: node dist/access-command.js setup --private-directory ABS --ownership single-host-pid-namespace --api-origin ORIGIN --allow-origin ORIGIN [--allow-origin ORIGIN] [--external-audio-origin ORIGIN]",
	"       node dist/access-command.js pair --private-directory ABS --api-origin ORIGIN [--timeout-ms 1..30000]",
	"       node dist/access-command.js devices list --private-directory ABS --api-origin ORIGIN [--json] [--timeout-ms 1..30000]",
	"       node dist/access-command.js devices revoke DEVICE_ID --private-directory ABS --api-origin ORIGIN [--timeout-ms 1..30000]",
	"       node dist/access-command.js devices revoke-all --yes --private-directory ABS --api-origin ORIGIN [--timeout-ms 1..30000]",
	"       node dist/access-command.js rotate-credential --private-directory ABS [--keep-sessions]",
	"Setup runs with the core stopped. It provisions private state and prints a public access plan; it does not enable runtime protection.",
	"Setup uses one canonical hostname and scheme for browser/API/audio origins, with explicit ports. LAN browser use requires HTTPS; HTTP is available only for explicit loopback targets.",
	"Pair requests a one-time code from a running core with the access service mounted. Browser pairing and rolling 30-day renewal need the connected web UI.",
	"Device commands use the machine credential against a running core. They never send a browser cookie. rotate-credential runs with the core stopped and replaces that credential. By default it removes remembered browser sessions; --keep-sessions keeps them.",
]
const deviceIdPattern = /^device_[A-Za-z0-9_-]{43}$/
function invalid(): AccessCommandResult {
	return {
		exitCode: 1,
		lines: ["ACCESS_COMMAND_INVALID: Invalid access command. Use --help."],
	}
}

function timeoutOption(value: string | undefined): number | undefined | null {
	if (value === undefined) return undefined
	if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 30_000) return null
	return Number(value)
}

function directoryOption(value: string | undefined): string | undefined {
	if (!value || !isAbsolute(value) || value.includes("\0")) return undefined
	return value
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
	if (command === "rotate-credential") return parseRotate(args)
	if (command === "devices") return parseDevices(args)
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
	const timeoutMs = timeoutOption(single.get("--timeout-ms"))
	if (timeoutMs === null) return undefined
	return {
		command,
		directory,
		apiOrigin,
		allowedOrigins,
		externalAudioOrigins,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	}
}

function parseRotate(args: readonly string[]): CommandOptions | undefined {
	const single = new Map<string, string>()
	let keepSessions = false
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]
		if (!flag) return undefined
		if (flag === "--keep-sessions") {
			if (keepSessions) return undefined
			keepSessions = true
			continue
		}
		if (flag === "--private-directory") {
			const value = args[++index]
			if (!value || value.startsWith("--") || single.has(flag)) return undefined
			single.set(flag, value)
			continue
		}
		return undefined
	}
	const directory = directoryOption(single.get("--private-directory"))
	if (!directory) return undefined
	return { command: "rotate-credential", directory, keepSessions }
}

function parseDevices(args: readonly string[]): CommandOptions | undefined {
	const [action, ...rest] = args
	if (action !== "list" && action !== "revoke" && action !== "revoke-all")
		return undefined
	const single = new Map<string, string>()
	const positional: string[] = []
	let json = false
	let yes = false
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index]
		if (!flag) return undefined
		if (flag === "--json") {
			if (json) return undefined
			json = true
			continue
		}
		if (flag === "--yes") {
			if (yes) return undefined
			yes = true
			continue
		}
		if (
			flag === "--private-directory" ||
			flag === "--api-origin" ||
			flag === "--timeout-ms"
		) {
			const value = rest[++index]
			if (!value || value.startsWith("--") || single.has(flag)) return undefined
			single.set(flag, value)
			continue
		}
		if (flag.startsWith("--")) return undefined
		positional.push(flag)
	}
	if (action === "revoke-all" && positional.length > 0) return undefined
	if ((action !== "list" && json) || (action !== "revoke-all" && yes))
		return undefined
	if (action === "revoke-all" && !yes)
		return { command: "devices-revoke-all-unconfirmed" }
	const directory = directoryOption(single.get("--private-directory"))
	const rawOrigin = single.get("--api-origin")
	if (!directory || !rawOrigin) return undefined
	const timeoutMs = timeoutOption(single.get("--timeout-ms"))
	if (timeoutMs === null) return undefined
	const remote = {
		directory,
		apiOrigin: canonicalPairingOrigin(rawOrigin),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	}
	if (action === "list") {
		if (positional.length > 0) return undefined
		return { command: "devices-list", json, ...remote }
	}
	if (action === "revoke-all")
		return { command: "devices-revoke-all", ...remote }
	const deviceId = positional[0]
	if (positional.length !== 1 || !deviceId || !deviceIdPattern.test(deviceId))
		return undefined
	return { command: "devices-revoke", deviceId, ...remote }
}

function publicPlan(options: SetupOptions): ProtectedAccessBootstrap {
	const url = new URL(options.apiOrigin)
	const audio = options.externalAudioOrigins.map(origin => new URL(origin))
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
	if (options.command === "rotate-credential") {
		const rotated = await rotateLocalMachineCredential({
			directory: options.directory,
			keepSessions: options.keepSessions,
		})
		if (rotated.kind !== "rotated")
			return {
				exitCode: 1,
				lines: [
					rotated.code === "ACCESS_STORAGE_BUSY"
						? "ACCESS_STORAGE_BUSY: Stop the core and retry credential rotation."
						: `${rotated.code}: Credential rotation did not change private state.`,
				],
			}
		return {
			exitCode: 0,
			lines: [
				options.keepSessions
					? "ACCESS_CREDENTIAL_ROTATED: Machine credential replaced. Remembered browser sessions were kept. Restart the core before using the new credential, then run `devices list` to review them."
					: "ACCESS_CREDENTIAL_ROTATED: Machine credential replaced. Remembered browser sessions were removed. Restart the core before using the new credential.",
			],
		}
	}
	if (options.command === "devices-revoke-all-unconfirmed")
		return {
			exitCode: 1,
			lines: [
				"ACCESS_CONFIRMATION_REQUIRED: Pass --yes to revoke every remembered device.",
			],
		}
	if (options.command === "devices-list") {
		const listed = await requestMachineDevices({
			apiOrigin: options.apiOrigin,
			directory: options.directory,
			...remoteTimeout(options),
		})
		if (listed.kind !== "ok") return machineUnavailable(listed.code)
		return {
			exitCode: 0,
			lines: options.json
				? [JSON.stringify(listed.body)]
				: deviceTable(listed.body.devices),
		}
	}
	if (options.command === "devices-revoke") {
		const revoked = await revokeMachineDevice({
			apiOrigin: options.apiOrigin,
			directory: options.directory,
			deviceId: options.deviceId,
			...remoteTimeout(options),
		})
		if (revoked.kind !== "ok") return machineUnavailable(revoked.code)
		if (!revoked.body.revoked)
			return {
				exitCode: 1,
				lines: [
					"ACCESS_DEVICE_NOT_FOUND: No remembered device matched that id.",
				],
			}
		return { exitCode: 0, lines: [`Revoked ${options.deviceId}.`] }
	}
	if (options.command === "devices-revoke-all") {
		const revoked = await revokeAllMachineDevices({
			apiOrigin: options.apiOrigin,
			directory: options.directory,
			...remoteTimeout(options),
		})
		if (revoked.kind !== "ok") return machineUnavailable(revoked.code)
		return {
			exitCode: 0,
			lines: ["Revoked every remembered device."],
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

function remoteTimeout(options: RemoteOptions): { timeoutMs?: number } {
	return options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
}

function machineUnavailable(code: string): AccessCommandResult {
	return {
		exitCode: 1,
		lines: [
			`${code}: Machine device administration is unavailable. Do not retry automatically after a timeout.`,
		],
	}
}

function deviceTable(devices: MachineAccessDevicesDto["devices"]): string[] {
	if (devices.length === 0)
		return [
			"deviceId  createdAt  renewedAt  expiresAt  current",
			"No remembered devices.",
		]
	const rows = devices.map(device => [
		device.deviceId,
		String(device.createdAt),
		String(device.renewedAt),
		String(device.expiresAt),
		device.current ? "true" : "false",
	])
	const header = ["deviceId", "createdAt", "renewedAt", "expiresAt", "current"]
	const widths = header.map((name, index) =>
		Math.max(name.length, ...rows.map(row => row[index]?.length ?? 0)),
	)
	const format = (columns: string[]): string =>
		columns
			.map((column, index) => column.padEnd(widths[index] ?? 0))
			.join("  ")
			.trimEnd()
	return [format(header), ...rows.map(format)]
}
