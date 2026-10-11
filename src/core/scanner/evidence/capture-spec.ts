/** Job `capture` option (burst IQ capture, Task 34a). */
import type { CaptureSpec, ScanJobSpec } from "../types.js"

export const DEFAULT_CAPTURE: CaptureSpec = {
	enabled: false,
	mode: "wideband",
	preMs: 1000,
	postMs: 500,
	onlyDecoded: true,
	maxPerHour: 6,
}

export const CAPTURE_BOUNDS = {
	preMs: { min: 0, max: 5000 },
	postMs: { min: 0, max: 10_000 },
	maxPerHour: { min: 1, max: 60 },
} as const

export function normaliseCapture(c: ScanJobSpec["capture"]): CaptureSpec {
	if (!c) return { ...DEFAULT_CAPTURE }
	return {
		enabled: c.enabled,
		mode: c.mode ?? DEFAULT_CAPTURE.mode,
		preMs: c.preMs ?? DEFAULT_CAPTURE.preMs,
		postMs: c.postMs ?? DEFAULT_CAPTURE.postMs,
		onlyDecoded: c.onlyDecoded ?? DEFAULT_CAPTURE.onlyDecoded,
		maxPerHour: c.maxPerHour ?? DEFAULT_CAPTURE.maxPerHour,
	}
}
