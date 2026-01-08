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
	const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
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
 * Format ISO timestamp to time only (HH:MM:SS)
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
export function padRight(text: string, width: number): string {
	if (!text) return " ".repeat(width)
	if (text.length >= width) return text.slice(0, width)
	return text + " ".repeat(width - text.length)
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
