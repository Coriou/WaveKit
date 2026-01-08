#!/usr/bin/env node

/**
 * Backpressure Viewer - Real-time TTY dashboard for fanout telemetry
 *
 * Connects to WaveKit WebSocket API and displays a live table of branch
 * backpressure status with drop counters and buffer usage.
 *
 * Usage:
 *   node scripts/backpressure-viewer.mjs
 *   WAVEKIT_WS_URL=ws://host:port/ws node scripts/backpressure-viewer.mjs
 *
 * Environment:
 *   WAVEKIT_WS_URL   - WebSocket URL (default: tries multiple candidates)
 *   WAVEKIT_API_URL  - HTTP API URL (WebSocket path derived from this)
 */

import { stdout, stderr, stdin } from "node:process"

const IS_TTY = stdout.isTTY

// ============================================================================
// ANSI Colors
// ============================================================================

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

function bgRed(text) {
	return color("41;37", text)
}

function bgGreen(text) {
	return color("42;30", text)
}

// ============================================================================
// Terminal Utilities
// ============================================================================

function clearScreen() {
	if (!IS_TTY) return
	stdout.write("\u001b[2J\u001b[H")
}

function moveCursor(row, col) {
	if (!IS_TTY) return
	stdout.write(`\u001b[${row};${col}H`)
}

function hideCursor() {
	if (!IS_TTY) return
	stdout.write("\u001b[?25l")
}

function showCursor() {
	if (!IS_TTY) return
	stdout.write("\u001b[?25h")
}

// ============================================================================
// State Management
// ============================================================================

/** @type {Map<string, import('../src/core/fanout-manager.js').BranchTelemetry>} */
const branches = new Map()

let globalDroppedBytes = 0
let globalDroppedChunks = 0
let globalTotalBytes = 0
let backpressureActiveCount = 0
let lastSnapshotAt = null
let connectionStatus = "connecting"
let lastError = null

// Drop rate calculation (sliding window)
const dropHistory = []
const DROP_WINDOW_MS = 5000

function recordDrop(bytes) {
	const now = Date.now()
	dropHistory.push({ timestamp: now, bytes })
	// Prune old entries
	while (
		dropHistory.length > 0 &&
		dropHistory[0].timestamp < now - DROP_WINDOW_MS
	) {
		dropHistory.shift()
	}
}

function getDropRate() {
	if (dropHistory.length === 0) return 0
	const now = Date.now()
	const windowStart = now - DROP_WINDOW_MS
	const recentDrops = dropHistory.filter(d => d.timestamp >= windowStart)
	const totalBytes = recentDrops.reduce((sum, d) => sum + d.bytes, 0)
	return Math.round(totalBytes / (DROP_WINDOW_MS / 1000)) // bytes/sec
}

// ============================================================================
// WebSocket Connection
// ============================================================================

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
	const envUrls = process.env["WAVEKIT_WS_URLS"]
	if (envUrls) {
		return envUrls.split(",").map(normalizeWsUrl).filter(Boolean)
	}

	const single = process.env["WAVEKIT_WS_URL"]
	if (single) {
		const url = normalizeWsUrl(single)
		return url ? [url] : []
	}

	const apiUrl = process.env["WAVEKIT_API_URL"]
	if (apiUrl) {
		const wsBase = normalizeWsUrl(apiUrl)
		if (wsBase) {
			return [wsBase.replace(/\/$/, "") + "/ws"]
		}
	}

	// Defaults
	return [
		"ws://localhost:4713/ws",
		"ws://localhost:9000/ws",
		"ws://127.0.0.1:4713/ws",
		"ws://127.0.0.1:9000/ws",
	]
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function getWebSocketCtor() {
	if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket
	try {
		const mod = await import("ws")
		return mod.WebSocket
	} catch {
		return null
	}
}

// ============================================================================
// Message Handlers
// ============================================================================

function handleSnapshot(data) {
	if (!data || typeof data !== "object") return

	lastSnapshotAt = Date.now()
	globalDroppedBytes = data.droppedBytesTotal ?? 0
	globalDroppedChunks = data.droppedChunksTotal ?? 0
	globalTotalBytes = data.totalBytesWritten ?? 0
	backpressureActiveCount = data.backpressureActiveCount ?? 0

	if (Array.isArray(data.branches)) {
		// Track previous drops for rate calculation
		const prevDrops = new Map()
		for (const [id, branch] of branches) {
			prevDrops.set(id, branch.droppedBytesTotal ?? 0)
		}

		branches.clear()
		for (const branch of data.branches) {
			if (branch && branch.id) {
				branches.set(branch.id, branch)

				// Record drop delta for rate calculation
				const prev = prevDrops.get(branch.id) ?? 0
				const delta = (branch.droppedBytesTotal ?? 0) - prev
				if (delta > 0) {
					recordDrop(delta)
				}
			}
		}
	}
}

function handleBackpressure(data) {
	if (!data || typeof data !== "object") return
	const { branchId } = data
	if (!branchId) return

	const existing = branches.get(branchId)
	if (existing) {
		existing.backpressureActive = true
		existing.lastBackpressureAt = data.timestamp
	}
}

function handleDrain(data) {
	if (!data || typeof data !== "object") return
	const { branchId, durationMs } = data
	if (!branchId) return

	const existing = branches.get(branchId)
	if (existing) {
		existing.backpressureActive = false
		existing.lastDrainAt = data.timestamp
	}
}

function handleMessage(msg) {
	if (!msg || typeof msg !== "object") return

	switch (msg.type) {
		case "fanout:snapshot":
			handleSnapshot(msg.data)
			break
		case "fanout:backpressure":
			handleBackpressure(msg.data)
			break
		case "fanout:drain":
			handleDrain(msg.data)
			break
		case "subscribed":
			connectionStatus = "connected"
			break
		case "error":
			lastError = msg.data?.message ?? "Unknown error"
			break
	}
}

// ============================================================================
// Rendering
// ============================================================================

function formatBytes(bytes) {
	if (bytes === 0) return "0 B"
	const units = ["B", "KB", "MB", "GB"]
	const exp = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	)
	const value = bytes / Math.pow(1024, exp)
	return `${value.toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`
}

function formatRate(bytesPerSec) {
	if (bytesPerSec === 0) return dim("0 B/s")
	return yellow(formatBytes(bytesPerSec) + "/s")
}

function padRight(text, width) {
	const str = String(text)
	if (str.length >= width) return str.slice(0, width)
	return str + " ".repeat(width - str.length)
}

function padLeft(text, width) {
	const str = String(text)
	if (str.length >= width) return str.slice(0, width)
	return " ".repeat(width - str.length) + str
}

function renderStatusIndicator(active) {
	if (active) {
		return bgRed(" DROP ")
	}
	return bgGreen("  OK  ")
}

function renderBufferBar(bufferBytes, highWaterMark) {
	const pct = highWaterMark > 0 ? Math.min(1, bufferBytes / highWaterMark) : 0
	const barWidth = 12
	const filled = Math.round(pct * barWidth)
	const empty = barWidth - filled

	let filledColor = green
	if (pct > 0.9) filledColor = red
	else if (pct > 0.7) filledColor = yellow

	const bar = filledColor("█".repeat(filled)) + dim("░".repeat(empty))
	const pctText = padLeft(`${Math.round(pct * 100)}%`, 4)
	return `${bar} ${pctText}`
}

function render() {
	if (!IS_TTY) return

	clearScreen()
	moveCursor(1, 1)

	// Header
	const title = bold(cyan(" 📊 WaveKit Backpressure Monitor "))
	const connIcon = connectionStatus === "connected" ? green("●") : yellow("○")
	const connText =
		connectionStatus === "connected" ? "Connected" : "Connecting..."

	stdout.write(`${title}  ${connIcon} ${dim(connText)}\n\n`)

	// Global stats
	const dropRate = getDropRate()
	const activeText =
		backpressureActiveCount > 0
			? red(`${backpressureActiveCount} branch(es) dropping`)
			: green("All branches flowing")

	stdout.write(`  ${bold("Status:")} ${activeText}\n`)
	stdout.write(`  ${bold("Drop Rate:")} ${formatRate(dropRate)}\n`)
	stdout.write(`  ${bold("Total Flowed:")} ${formatBytes(globalTotalBytes)}\n`)
	stdout.write(
		`  ${bold("Total Dropped:")} ${formatBytes(globalDroppedBytes)} (${globalDroppedChunks} chunks)\n`,
	)

	if (lastSnapshotAt) {
		const age = Math.round((Date.now() - lastSnapshotAt) / 1000)
		stdout.write(`  ${bold("Last Update:")} ${dim(`${age}s ago`)}\n`)
	}

	stdout.write("\n")

	// Table header
	const header =
		dim("  ") +
		bold(padRight("Branch ID", 24)) +
		bold(padRight("State", 10)) +
		bold(padRight("Buffer Usage", 22)) +
		bold(padRight("Flowed", 12)) +
		bold(padRight("Dropped", 12)) +
		bold(padRight("% Drop", 8)) +
		bold(padRight("Enter Count", 12)) +
		"\n"

	stdout.write(header)
	stdout.write(dim("  " + "─".repeat(90)) + "\n")

	// Table rows
	if (branches.size === 0) {
		stdout.write(dim("  No branches registered\n"))
	} else {
		const sortedBranches = Array.from(branches.values()).sort((a, b) => {
			// Active backpressure first, then by drops, then by ID
			if (a.backpressureActive !== b.backpressureActive) {
				return a.backpressureActive ? -1 : 1
			}
			if (a.droppedBytesTotal !== b.droppedBytesTotal) {
				return (b.droppedBytesTotal ?? 0) - (a.droppedBytesTotal ?? 0)
			}
			return a.id.localeCompare(b.id)
		})

		for (const branch of sortedBranches) {
			const id = padRight(branch.id, 24)
			const status = renderStatusIndicator(branch.backpressureActive)
			const bufferBar = renderBufferBar(
				branch.bufferBytes ?? 0,
				branch.highWaterMark ?? 262144,
			)
			const flowed = padRight(formatBytes(branch.totalBytesWritten ?? 0), 12)
			const dropped = padRight(formatBytes(branch.droppedBytesTotal ?? 0), 12)

			let dropPct = 0
			if ((branch.totalBytesWritten ?? 0) > 0) {
				dropPct =
					((branch.droppedBytesTotal ?? 0) / (branch.totalBytesWritten ?? 1)) *
					100
			}
			const dropPctText = padRight(`${dropPct.toFixed(1)}%`, 8)

			const enterCount = padLeft(String(branch.backpressureEnterCount ?? 0), 12)

			// Highlight row if in backpressure
			const prefix = branch.backpressureActive ? red("▶ ") : "  "
			stdout.write(
				`${prefix}${id}${status}  ${bufferBar}  ${flowed}${dropped}${dropPctText}${enterCount}\n`,
			)
		}
	}

	// Footer
	stdout.write("\n")
	stdout.write(dim("  Press Ctrl+C to exit\n"))

	if (lastError) {
		stdout.write(red(`\n  Error: ${lastError}\n`))
	}
}

// ============================================================================
// Main Loop
// ============================================================================

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

	// Handle graceful shutdown
	process.on("SIGINT", () => {
		stopRequested = true
		showCursor()
		stdout.write("\n")
		process.exit(0)
	})
	process.on("SIGTERM", () => {
		stopRequested = true
		showCursor()
	})

	hideCursor()

	let attempt = 0
	let candidateIndex = 0

	while (!stopRequested) {
		const url = candidates[candidateIndex % candidates.length]
		candidateIndex++
		attempt++

		connectionStatus = "connecting"
		lastError = null
		render()

		try {
			const connected = await new Promise((resolve, reject) => {
				let ws
				try {
					ws = new WebSocketCtor(url)
				} catch (err) {
					reject(err)
					return
				}

				const cleanup = () => {
					if (ws.removeEventListener) {
						ws.removeEventListener("open", onOpen)
						ws.removeEventListener("message", onMessage)
						ws.removeEventListener("error", onError)
						ws.removeEventListener("close", onClose)
					} else {
						ws.removeListener?.("open", onOpen)
						ws.removeListener?.("message", onMessage)
						ws.removeListener?.("error", onError)
						ws.removeListener?.("close", onClose)
					}
				}

				const onOpen = () => {
					try {
						ws.send(
							JSON.stringify({
								type: "subscribe",
								channels: ["fanout", "metrics"],
							}),
						)
						connectionStatus = "connected"
						render()
						resolve(ws)
					} catch (err) {
						reject(err)
					}
				}

				const onMessage = event => {
					try {
						const raw = event?.data
						const text =
							typeof raw === "string" ? raw : raw?.toString?.("utf-8")
						if (!text) return
						const msg = JSON.parse(text)
						handleMessage(msg)
					} catch {
						// Ignore parse errors
					}
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
					ws.on("open", onOpen)
					ws.on("message", data => onMessage({ data }))
					ws.on("error", onError)
					ws.on("close", onClose)
				}

				// Timeout for initial connection
				setTimeout(() => {
					if (connectionStatus !== "connected") {
						cleanup()
						try {
							ws.close()
						} catch {
							/* ignore */
						}
						reject(new Error("Connection timeout"))
					}
				}, 5000)
			})

			// Connected - run render loop
			attempt = 0
			while (!stopRequested && connected.readyState === 1) {
				render()
				await sleep(250)
			}

			connectionStatus = "connecting"
		} catch (err) {
			if (stopRequested) break

			lastError = err?.message ?? "Connection failed"
			const backoffMs = Math.min(15000, 500 * Math.pow(2, Math.min(5, attempt)))
			render()
			await sleep(backoffMs)
		}
	}

	showCursor()
}

// ============================================================================
// Entry Point
// ============================================================================

if (stdin.isTTY) {
	// Running interactively
	void runWebSocketMode()
} else {
	stderr.write(
		"Backpressure viewer requires a TTY. Run directly from terminal.\n",
	)
	process.exitCode = 1
}
