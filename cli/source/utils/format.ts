/**
 * Format utilities for CLI display
 *
 * Shared formatting functions for bytes, time, and other values.
 */

/**
 * Format bytes to human-readable string (e.g., "1.2 MB")
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B"
	const units = ["B", "KB", "MB", "GB", "TB"]
	const exp = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	)
	const value = bytes / Math.pow(1024, exp)
	return `${value.toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`
}

/**
 * Format bytes per second to human-readable rate
 */
export function formatRate(bytesPerSec: number): string {
	if (bytesPerSec === 0) return "0 B/s"
	return formatBytes(bytesPerSec) + "/s"
}

/**
 * Format duration in seconds to human-readable string
 */
export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) {
		const mins = Math.floor(seconds / 60)
		const secs = seconds % 60
		return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
	}
	const hours = Math.floor(seconds / 3600)
	const mins = Math.floor((seconds % 3600) / 60)
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/**
 * Format ISO timestamp to local time (HH:MM:SS)
 *
 * Converts UTC timestamps to the user's local timezone for better UX.
 * Falls back gracefully if parsing fails.
 */
export function formatLocalTime(isoTimestamp: string | undefined): string {
	if (!isoTimestamp || typeof isoTimestamp !== "string") return "--:--:--"

	try {
		const date = new Date(isoTimestamp)
		if (isNaN(date.getTime())) return "--:--:--"

		// Use local time components
		const hours = date.getHours().toString().padStart(2, "0")
		const mins = date.getMinutes().toString().padStart(2, "0")
		const secs = date.getSeconds().toString().padStart(2, "0")
		return `${hours}:${mins}:${secs}`
	} catch {
		return "--:--:--"
	}
}

/**
 * Format ISO timestamp to time only (HH:MM:SS) - UTC
 *
 * @deprecated Use formatLocalTime for user-facing timestamps
 */
export function formatTime(isoTimestamp: string | undefined): string {
	if (!isoTimestamp || typeof isoTimestamp !== "string") return "--:--:--"
	const timePart = isoTimestamp.split("T")[1]
	if (!timePart) return "--:--:--"
	return timePart.split(".")[0] ?? "--:--:--"
}

/**
 * Format number with thousands separators
 */
export function formatNumber(num: number): string {
	return num.toLocaleString()
}

/**
 * Pad string to fixed width (right-aligned)
 */
export function padLeft(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width)
	return " ".repeat(width - text.length) + text
}

/**
 * Pad string to fixed width (left-aligned)
 */

export function padRight(
	text: string | number | null | undefined,
	width: number,
): string {
	const value = text == null ? "" : String(text)
	if (value.length === 0) return " ".repeat(width)
	if (value.length >= width) return value.slice(0, width)
	return value + " ".repeat(width - value.length)
}

/**
 * Truncate string with ellipsis if too long
 */
export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text
	return text.slice(0, maxLength - 1) + "…"
}

/**
 * Strip null artifacts from string (decoder output cleanup)
 */
export function stripNulls(value: string): string {
	return value
		.replaceAll("<NUL>", "")
		.replace(/\u0000/g, "")
		.trimEnd()
}

/**
 * Format milliseconds duration to human-readable string (e.g., "1.2s", "1m 23s")
 * Optimized for call durations which are typically seconds to minutes.
 */
export function formatDurationMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	const seconds = ms / 1000
	if (seconds < 60) {
		return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
	}
	const mins = Math.floor(seconds / 60)
	const secs = Math.round(seconds % 60)
	return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

/**
 * Format a protocol name for display (uppercase, clean)
 */
export function formatProtocol(protocol: string | undefined | null): string {
	if (!protocol) return "UNKNOWN"
	return protocol.toUpperCase().replace(/P(\d)/, "P$1 ") // "p25p1" -> "P25 P1"
}

/**
 * Format text as a clickable terminal hyperlink using OSC 8 escape sequence.
 * Works in most modern terminal emulators (iTerm2, Terminal.app, VS Code, etc.)
 *
 * Falls back to plain text if url is undefined.
 *
 * NOTE: For Ink components, prefer using `ink-link` package instead, as Ink's
 * Text component may escape these sequences. This utility is for raw terminal output.
 *
 * @see https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
 */
export function formatHyperlink(text: string, url: string | undefined): string {
	if (!url) return text
	// OSC 8 hyperlink: \x1b]8;;URL\x07TEXT\x1b]8;;\x07
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}
