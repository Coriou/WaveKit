#!/usr/bin/env node

/**
 * Auto Capture (Interactive Wrapper)
 *
 * Always runs IQ auto-capture inside the demod-test container and writes
 * captures to the shared debug_audio volume.
 *
 * Usage:
 *   node scripts/auto-capture.mjs
 *   node scripts/auto-capture.mjs --host 192.168.1.69 --port 1235 --threshold 1.5
 *
 * Options are passed through to /scripts/auto-capture.py.
 */

import { spawn } from "node:child_process"
import { access, mkdir } from "node:fs/promises"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { stdin, stdout, stderr } from "node:process"
import { parseArgs } from "node:util"
import readline from "node:readline/promises"

const IS_TTY = Boolean(stdout.isTTY && stdin.isTTY)

function color(code, text) {
	if (!IS_TTY) return text
	return `\u001b[${code}m${text}\u001b[0m`
}

function dim(text) {
	return color("2", text)
}

function bold(text) {
	return color("1", text)
}

function red(text) {
	return color("31", text)
}

function green(text) {
	return color("32", text)
}

function yellow(text) {
	return color("33", text)
}

function cyan(text) {
	return color("36", text)
}

function clearScreen() {
	if (!IS_TTY) return
	stdout.write("\u001b[2J\u001b[H")
}

function hr(width = 72) {
	return "-".repeat(Math.max(10, width))
}

function clampNumber(value, { min = -Infinity, max = Infinity } = {}) {
	if (Number.isNaN(value)) return value
	return Math.min(max, Math.max(min, value))
}

function parseNumberOrNull(text) {
	const trimmed = String(text ?? "").trim()
	if (!trimmed) return null
	const num = Number(trimmed)
	return Number.isFinite(num) ? num : null
}

async function ensureHostDebugAudioDir() {
	const dir = resolve("debug_audio")
	try {
		await access(dir)
		return dir
	} catch {
		await mkdir(dir, { recursive: true })
		return dir
	}
}

function buildPythonArgs(config) {
	/** @type {string[]} */
	const args = ["python3", "/scripts/auto-capture.py"]

	args.push("--host", config.host)
	args.push("--port", String(config.port))
	args.push("--threshold", String(config.threshold))
	if (config.release != null) args.push("--release", String(config.release))
	args.push("--pre", String(config.pre))
	args.push("--post", String(config.post))
	args.push("--min-duration", String(config.minDuration))
	args.push("--max-duration", String(config.maxDuration))
	args.push("--cooldown", String(config.cooldown))
	args.push("--max", String(config.maxCaptures))
	args.push("--timeout", String(config.timeout))
	args.push("--output", "/data/debug_audio")
	if (config.quiet) args.push("--quiet")

	return args
}

function buildDockerComposeArgs({ composeFile, service, pythonArgs }) {
	return ["compose", "-f", composeFile, "run", "--rm", service, ...pythonArgs]
}

function printConfig(config, { composeFile, service }) {
	stdout.write(
		[
			bold("WaveKit Auto Capture"),
			dim("(runs inside demod-test container; outputs to ./debug_audio)"),
			hr(),
			`${bold("Docker")}: docker compose -f ${composeFile} run --rm ${service}`,
			`${bold("Output")}: /data/debug_audio  ${dim("(host: ./debug_audio)")}`,
			"",
			`${bold("Source")}: ${config.host}:${config.port}`,
			`${bold("Trigger")}: std > ${config.threshold}`,
			`${bold("Release")}: ${config.release ?? dim("(auto: 85% of trigger)")}`,
			`${bold("Buffers")}: pre=${config.pre}s post=${config.post}s`,
			`${bold("Duration")}: min=${config.minDuration}s max=${config.maxDuration}s`,
			`${bold("Limits")}: maxCaptures=${config.maxCaptures} timeout=${config.timeout}s cooldown=${config.cooldown}s`,
			`${bold("Mode")}: ${config.quiet ? "quiet" : "normal"}`,
			hr(),
			"",
		].join(EOL),
	)
}

async function promptText(rl, label, { defaultValue } = {}) {
	const suffix =
		defaultValue != null ? ` ${dim(`(default: ${defaultValue})`)}` : ""
	const answer = await rl.question(`${cyan(label)}${suffix}: `)
	const trimmed = answer.trim()
	if (trimmed) return trimmed
	return defaultValue ?? ""
}

async function promptNumber(rl, label, { defaultValue, min, max } = {}) {
	while (true) {
		const answer = await promptText(rl, label, {
			defaultValue: String(defaultValue),
		})
		const n = parseNumberOrNull(answer)
		if (n == null) {
			stdout.write(red("Please enter a valid number.") + EOL)
			continue
		}
		if (min != null && n < min) {
			stdout.write(red(`Value must be >= ${min}.`) + EOL)
			continue
		}
		if (max != null && n > max) {
			stdout.write(red(`Value must be <= ${max}.`) + EOL)
			continue
		}
		return n
	}
}

async function promptYesNo(rl, label, { defaultValue = false } = {}) {
	const hint = defaultValue ? "Y/n" : "y/N"
	while (true) {
		const answer = await rl.question(`${cyan(label)} ${dim(`(${hint})`)}: `)
		const trimmed = answer.trim().toLowerCase()
		if (!trimmed) return defaultValue
		if (["y", "yes"].includes(trimmed)) return true
		if (["n", "no"].includes(trimmed)) return false
		stdout.write(red("Please answer y or n.") + EOL)
	}
}

async function resolveConfigFromArgs(argv) {
	const defaults = {
		host: "192.168.1.69",
		port: 1235,
		threshold: 1.5,
		release: null,
		pre: 1.0,
		post: 0.5,
		minDuration: 0.5,
		maxDuration: 60.0,
		cooldown: 2.0,
		maxCaptures: 10,
		timeout: 300,
		quiet: false,
	}

	const { values } = parseArgs({
		args: argv,
		allowPositionals: false,
		options: {
			host: { type: "string" },
			port: { type: "string" },
			threshold: { type: "string" },
			release: { type: "string" },
			pre: { type: "string" },
			post: { type: "string" },
			"min-duration": { type: "string" },
			"max-duration": { type: "string" },
			cooldown: { type: "string" },
			max: { type: "string" },
			timeout: { type: "string" },
			quiet: { type: "boolean" },
			interactive: { type: "boolean" },
			"dry-run": { type: "boolean" },
			"compose-file": { type: "string" },
			service: { type: "string" },
			help: { type: "boolean" },
		},
	})

	if (values.help) {
		stdout.write(
			[
				bold("WaveKit Auto Capture (interactive)"),
				"",
				"Runs /scripts/auto-capture.py inside the demod-test container and writes to ./debug_audio.",
				"",
				bold("Usage"),
				"  node scripts/auto-capture.mjs [options]",
				"",
				bold("Options"),
				"  --host <ip>            rtl_tcp host",
				"  --port <n>             rtl_tcp port",
				"  --threshold <n>        trigger threshold (std)",
				"  --release <n>          release threshold (std)",
				"  --pre <sec>            pre-buffer seconds",
				"  --post <sec>           post-tail seconds",
				"  --min-duration <sec>   minimum capture duration",
				"  --max-duration <sec>   maximum capture duration",
				"  --cooldown <sec>       cooldown between captures",
				"  --max <n>              max captures",
				"  --timeout <sec>        timeout (0 = no timeout)",
				"  --quiet                minimal output",
				"  --interactive          force prompts",
				"  --dry-run              print docker command, don’t run",
				"  --compose-file <path>  compose file (default: docker-compose.demod-test.yml)",
				"  --service <name>       service name (default: demod-test)",
			].join(EOL) + EOL,
		)
		process.exit(0)
	}

	const composeFile = values["compose-file"] ?? "docker-compose.demod-test.yml"
	const service = values.service ?? "demod-test"
	const forceInteractive = Boolean(values.interactive)
	const dryRun = Boolean(values["dry-run"])

	const parsed = {
		host: values.host ?? defaults.host,
		port: parseNumberOrNull(values.port) ?? defaults.port,
		threshold: parseNumberOrNull(values.threshold) ?? defaults.threshold,
		release:
			values.release != null
				? parseNumberOrNull(values.release)
				: defaults.release,
		pre: parseNumberOrNull(values.pre) ?? defaults.pre,
		post: parseNumberOrNull(values.post) ?? defaults.post,
		minDuration:
			parseNumberOrNull(values["min-duration"]) ?? defaults.minDuration,
		maxDuration:
			parseNumberOrNull(values["max-duration"]) ?? defaults.maxDuration,
		cooldown: parseNumberOrNull(values.cooldown) ?? defaults.cooldown,
		maxCaptures: Math.round(
			parseNumberOrNull(values.max) ?? defaults.maxCaptures,
		),
		timeout: parseNumberOrNull(values.timeout) ?? defaults.timeout,
		quiet: Boolean(values.quiet ?? defaults.quiet),
	}

	// If any values are missing due to invalid parsing, fall back to defaults.
	parsed.port = Number.isFinite(parsed.port)
		? clampNumber(parsed.port, { min: 1, max: 65535 })
		: defaults.port
	parsed.threshold = Number.isFinite(parsed.threshold)
		? Math.max(0.001, parsed.threshold)
		: defaults.threshold
	parsed.pre = Number.isFinite(parsed.pre)
		? Math.max(0, parsed.pre)
		: defaults.pre
	parsed.post = Number.isFinite(parsed.post)
		? Math.max(0, parsed.post)
		: defaults.post
	parsed.minDuration = Number.isFinite(parsed.minDuration)
		? Math.max(0, parsed.minDuration)
		: defaults.minDuration
	parsed.maxDuration = Number.isFinite(parsed.maxDuration)
		? Math.max(parsed.minDuration, parsed.maxDuration)
		: defaults.maxDuration
	parsed.cooldown = Number.isFinite(parsed.cooldown)
		? Math.max(0, parsed.cooldown)
		: defaults.cooldown
	parsed.maxCaptures = Number.isFinite(parsed.maxCaptures)
		? Math.max(1, parsed.maxCaptures)
		: defaults.maxCaptures
	parsed.timeout = Number.isFinite(parsed.timeout)
		? Math.max(0, parsed.timeout)
		: defaults.timeout
	if (parsed.release != null && !Number.isFinite(parsed.release))
		parsed.release = null

	const needsPrompts = forceInteractive || (IS_TTY && argv.length === 0)
	if (!needsPrompts) return { config: parsed, composeFile, service, dryRun }

	clearScreen()
	stdout.write(bold("WaveKit Auto Capture") + EOL)
	stdout.write(dim("Interactive mode — press Enter to accept defaults") + EOL)
	stdout.write(hr() + EOL + EOL)

	const rl = readline.createInterface({ input: stdin, output: stdout })
	try {
		parsed.host = await promptText(rl, "rtlmux/rtl_tcp host", {
			defaultValue: parsed.host,
		})
		parsed.port = await promptNumber(rl, "rtlmux/rtl_tcp port", {
			defaultValue: parsed.port,
			min: 1,
			max: 65535,
		})
		parsed.threshold = await promptNumber(rl, "Trigger threshold (std)", {
			defaultValue: parsed.threshold,
			min: 0.001,
		})

		const releaseText = await promptText(
			rl,
			"Release threshold (std) — leave blank for auto",
			{
				defaultValue: "",
			},
		)
		parsed.release = releaseText ? parseNumberOrNull(releaseText) : null

		parsed.pre = await promptNumber(rl, "Pre-buffer seconds", {
			defaultValue: parsed.pre,
			min: 0,
		})
		parsed.post = await promptNumber(rl, "Post-tail seconds", {
			defaultValue: parsed.post,
			min: 0,
		})
		parsed.minDuration = await promptNumber(rl, "Min duration seconds", {
			defaultValue: parsed.minDuration,
			min: 0,
		})
		parsed.maxDuration = await promptNumber(rl, "Max duration seconds", {
			defaultValue: parsed.maxDuration,
			min: parsed.minDuration,
		})
		parsed.cooldown = await promptNumber(rl, "Cooldown seconds", {
			defaultValue: parsed.cooldown,
			min: 0,
		})
		parsed.maxCaptures = await promptNumber(rl, "Max captures", {
			defaultValue: parsed.maxCaptures,
			min: 1,
			max: 100000,
		})
		parsed.timeout = await promptNumber(
			rl,
			"Timeout seconds (0 = no timeout)",
			{
				defaultValue: parsed.timeout,
				min: 0,
			},
		)
		parsed.quiet = await promptYesNo(rl, "Quiet mode", {
			defaultValue: parsed.quiet,
		})

		stdout.write(EOL)
		const ok = await promptYesNo(rl, "Start capture now?", {
			defaultValue: true,
		})
		if (!ok) process.exit(0)
	} finally {
		rl.close()
	}

	return { config: parsed, composeFile, service, dryRun }
}

async function main() {
	await ensureHostDebugAudioDir()

	const argv = process.argv.slice(2)
	const { config, composeFile, service, dryRun } =
		await resolveConfigFromArgs(argv)
	const pythonArgs = buildPythonArgs(config)
	const dockerArgs = buildDockerComposeArgs({
		composeFile,
		service,
		pythonArgs,
	})

	printConfig(config, { composeFile, service })

	if (dryRun) {
		stdout.write(yellow("Dry-run:" + EOL))
		stdout.write(
			`docker ${dockerArgs.map(a => JSON.stringify(a)).join(" ")}${EOL}`,
		)
		process.exit(0)
	}

	stdout.write(green("Starting capture…") + EOL)
	const child = spawn("docker", dockerArgs, {
		stdio: "inherit",
		env: process.env,
	})

	child.on("exit", code => {
		if (typeof code === "number" && code !== 0) {
			stderr.write(red(`auto-capture failed (exit ${code})`) + EOL)
			process.exit(code)
		}
		stdout.write(EOL)
		stdout.write(green("Done.") + EOL)
		stdout.write(
			[
				"Next:",
				`  docker compose -f ${composeFile} run --rm ${service} bash`,
				`  # inside: bash /scripts/demod-test.sh /data/debug_audio/iq_capture_*.u8`,
			].join(EOL) + EOL,
		)
		process.exit(0)
	})
}

main().catch(err => {
	stderr.write(red(String(err?.stack ?? err)) + EOL)
	process.exit(1)
})
