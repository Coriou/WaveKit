#!/usr/bin/env node

import readline from "node:readline"
import { stdin, stdout } from "node:process"
import { inspect } from "node:util"

const stderr = process.stderr

const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity })

const IS_TTY = stdout.isTTY
const STDIN_IS_TTY = stdin.isTTY

function color(code, text) {
	if (!IS_TTY) return text
	return `\u001b[${code}m${text}\u001b[0m`
}

function dim(text) {
	return color("2", text)
}

function cyan(text) {
	return color("36", text)
}

function yellow(text) {
	return color("33", text)
}

function red(text) {
	return color("31", text)
}

function magenta(text) {
	return color("35", text)
}

function stripNullArtifacts(value) {
	if (typeof value !== "string") return value
	return value
		.replaceAll("<NUL>", "")
		.replace(/\u0000/g, "")
		.trimEnd()
}

function sanitizeJsonValue(value) {
	if (typeof value === "string") return stripNullArtifacts(value)
	if (Array.isArray(value)) return value.map(sanitizeJsonValue)
	if (!value || typeof value !== "object") return value

	const out = {}
	for (const [key, child] of Object.entries(value)) {
		out[key] = sanitizeJsonValue(child)
	}
	return out
}

function safeJsonParse(line) {
	try {
		return JSON.parse(line)
	} catch {
		return null
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeWsUrl(url) {
	if (!url || typeof url !== "string") return null
	const trimmed = url.trim()
	if (!trimmed) return null
	if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://"))
		return trimmed
	if (trimmed.startsWith("http://"))
		return "ws://" + trimmed.slice("http://".length)
	if (trimmed.startsWith("https://"))
		return "wss://" + trimmed.slice("https://".length)
	return trimmed
}

function getCandidateWsUrls() {
	// 1) Explicit override
	const envUrls = process.env["WAVEKIT_WS_URLS"]
	if (envUrls) {
		return envUrls.split(",").map(normalizeWsUrl).filter(Boolean)
	}

	const single = process.env["WAVEKIT_WS_URL"]
	if (single) {
		const url = normalizeWsUrl(single)
		return url ? [url] : []
	}

	// 2) Derive from API URL if provided
	const apiUrl = process.env["WAVEKIT_API_URL"]
	if (apiUrl) {
		const wsBase = normalizeWsUrl(apiUrl)
		if (wsBase) {
			return [wsBase.replace(/\/$/, "") + "/ws"]
		}
	}

	// 3) Defaults: docker-compose exposes 4713, dev container often uses 9000
	return [
		"ws://localhost:4713/ws",
		"ws://localhost:9000/ws",
		"ws://127.0.0.1:4713/ws",
		"ws://127.0.0.1:9000/ws",
	]
}

function formatTime(isoTimestamp) {
	if (!isoTimestamp || typeof isoTimestamp !== "string") return "--:--:--"
	// Expected: 2026-01-07T23:55:31.123Z
	const timePart = isoTimestamp.split("T")[1]
	if (!timePart) return "--:--:--"
	return timePart.split(".")[0] ?? "--:--:--"
}

function formatSwitchSummary(data) {
	const switches = []
	for (let i = 1; i <= 6; i++) {
		const key = `switch${i}`
		if (!(key in data)) continue
		const value = data[key]
		if (typeof value !== "string") continue
		// Only surface interesting states to reduce noise
		if (value !== "CLOSED") switches.push(`${key}=${value}`)
	}
	return switches.length ? switches.join(" ") : ""
}

function rtl433Summary(data) {
	const model = typeof data.model === "string" ? data.model : null
	const subtype = typeof data.subtype === "string" ? data.subtype : null
	const id = data.id != null ? String(data.id) : null

	const head = model ? (subtype ? `${model}/${subtype}` : model) : null
	const parts = []
	if (head) parts.push(head)
	if (id) parts.push(`id=${id}`)

	if (typeof data.battery_ok === "number") {
		parts.push(`battery=${data.battery_ok === 1 ? "ok" : "low"}`)
	}

	if (typeof data.channel === "number") parts.push(`ch=${data.channel}`)
	if (typeof data.command === "string") parts.push(`cmd=${data.command}`)
	if (data.value != null)
		parts.push(`value=${stripNullArtifacts(String(data.value))}`)

	if (typeof data.temperature_C === "number")
		parts.push(`temp=${data.temperature_C}C`)
	if (typeof data.humidity === "number") parts.push(`hum=${data.humidity}%`)

	const switchSummary = formatSwitchSummary(data)
	if (switchSummary) parts.push(switchSummary)

	if (typeof data.raw_message === "string")
		parts.push(`raw=${data.raw_message}`)

	return parts.join(" ")
}

function compactJsonOneLine(value) {
	const cleaned = sanitizeJsonValue(value)
	try {
		return JSON.stringify(cleaned)
	} catch {
		return inspect(cleaned, {
			colors: IS_TTY,
			depth: 6,
			breakLength: Number.POSITIVE_INFINITY,
			compact: true,
		})
	}
}

function deriveDisplayType(output) {
	const type = output?.type
	const decoder = output?.decoder
	const data = output?.data

	if (
		type === "signal" &&
		decoder === "rtl433" &&
		data &&
		typeof data === "object"
	) {
		const subtype = typeof data.subtype === "string" ? data.subtype : null
		if (subtype) return `signal/${subtype}`
	}

	return type ?? "event"
}

function pad(value, width) {
	const text = String(value ?? "")
	if (text.length > width) return text.slice(0, width - 1) + "…"
	return text.padEnd(width, " ")
}

function formatData(output) {
	const data = output?.data
	if (data == null) return ""

	if (typeof data === "string") {
		return stripNullArtifacts(data)
	}

	// Prefer human-readable pager style if present
	if (typeof data === "object") {
		if (output?.decoder === "rtl433" && typeof data.model === "string") {
			return rtl433Summary(data)
		}

		const maybeMessage = stripNullArtifacts(data.message)
		if (maybeMessage) {
			const details = []
			if (data.protocol) details.push(`protocol=${data.protocol}`)
			if (data.address != null) details.push(`addr=${data.address}`)
			if (data.function != null) details.push(`fn=${data.function}`)
			if (data.messageType) details.push(`type=${data.messageType}`)
			const suffix = details.length ? dim(` (${details.join(", ")})`) : ""
			return `${maybeMessage}${suffix}`
		}
	}

	// Fallback: compact JSON on one line
	return compactJsonOneLine(data)
}

function formatLine(output) {
	const time = formatTime(output?.timestamp)
	const decoder = output?.decoder ?? "unknown"
	const type = deriveDisplayType(output)

	const timeText = dim(pad(time, 8))
	const decoderText = cyan(`[${pad(decoder, 14)}]`)

	let typeText = pad(type, 14)
	if (type === "error") typeText = red(typeText)
	else if (type === "sync") typeText = magenta(typeText)
	else typeText = yellow(typeText)

	const dataText = formatData(output)
	return `${timeText} ${decoderText} ${typeText}: ${dataText}`.trimEnd()
}

function formatWsDecoderOutput(payload) {
	// Server shape: { decoderId, output }
	if (!payload || typeof payload !== "object") return null
	const decoderId = payload.decoderId
	const output = payload.output
	if (!output || typeof output !== "object") return null

	// Some outputs may omit "decoder"; fill from decoderId for display
	if (!output.decoder && typeof decoderId === "string") {
		output.decoder = decoderId
	}

	return formatLine(output)
}

async function getWebSocketCtor() {
	if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket

	// Fallback to ws package if available (often present transitively via @fastify/websocket)
	try {
		const mod = await import("ws")
		return mod.WebSocket
	} catch {
		return null
	}
}

async function runWebSocketMode() {
	const WebSocketCtor = await getWebSocketCtor()
	if (!WebSocketCtor) {
		stderr.write(
			"WebSocket client not available. Use Node 20+ or add 'ws' dependency.\n",
		)
		process.exitCode = 1
		return
	}

	const candidates = getCandidateWsUrls()
	if (candidates.length === 0) {
		stderr.write("No WebSocket URL candidates found.\n")
		process.exitCode = 1
		return
	}

	let stopRequested = false
	process.on("SIGINT", () => {
		stopRequested = true
	})
	process.on("SIGTERM", () => {
		stopRequested = true
	})

	let attempt = 0
	let candidateIndex = 0

	while (!stopRequested) {
		const url = candidates[candidateIndex % candidates.length]
		candidateIndex++
		attempt++

		stderr.write(dim(`Connecting to ${url}...\n`))

		try {
			await new Promise((resolve, reject) => {
				const ws = new WebSocketCtor(url)

				const cleanup = () => {
					ws.removeEventListener?.("open", onOpen)
					ws.removeEventListener?.("message", onMessage)
					ws.removeEventListener?.("error", onError)
					ws.removeEventListener?.("close", onClose)
				}

				const onOpen = () => {
					try {
						ws.send(
							JSON.stringify({
								type: "subscribe",
								channels: ["decoders"],
							}),
						)
						stderr.write(dim("Subscribed to decoders channel.\n"))
					} catch {
						// Ignore
					}
				}

				const onMessage = event => {
					const raw = event?.data
					const text = typeof raw === "string" ? raw : raw?.toString?.("utf-8")
					if (!text) return
					const msg = safeJsonParse(text)
					if (!msg || typeof msg !== "object") return
					if (msg.type !== "decoder:output") return
					const line = formatWsDecoderOutput(msg.data)
					if (!line) return
					stdout.write(line + "\n")
				}

				const onError = err => {
					cleanup()
					reject(err)
				}

				const onClose = () => {
					cleanup()
					reject(new Error("WebSocket closed"))
				}

				if (ws.addEventListener) {
					ws.addEventListener("open", onOpen)
					ws.addEventListener("message", onMessage)
					ws.addEventListener("error", onError)
					ws.addEventListener("close", onClose)
				} else {
					// ws package compatibility
					ws.on("open", onOpen)
					ws.on("message", data => onMessage({ data }))
					ws.on("error", onError)
					ws.on("close", onClose)
				}

				resolve()
			})

			// Keep process alive while WS runs
			while (!stopRequested) {
				await sleep(1000)
			}
			return
		} catch (err) {
			if (stopRequested) return
			const backoffMs = Math.min(15000, 500 * Math.pow(2, Math.min(5, attempt)))
			stderr.write(
				dim(
					`Connection failed (${err?.message ?? "unknown"}); retrying in ${Math.round(backoffMs / 1000)}s...\n`,
				),
			)
			await sleep(backoffMs)
		}
	}
}

rl.on("line", line => {
	const obj = safeJsonParse(line)
	if (!obj) return

	if (obj.msg !== "Decoded Message") return

	const output = obj.output
	if (!output) return

	stdout.write(formatLine(output) + "\n")
})

// If stdin is a TTY (no pipe), default to WebSocket API mode.
if (STDIN_IS_TTY) {
	// Stop readline consuming terminal input.
	rl.close()
	void runWebSocketMode()
}
