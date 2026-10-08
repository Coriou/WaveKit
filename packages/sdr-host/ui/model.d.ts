// Types for model.js, so tests check the page against the shared contracts.
import type {
	Reading,
	SdrHostDelivery,
	SdrHostNetworkInterface,
	SdrHostSampling,
	SdrHostSamplingHistory,
	SdrHostTelemetry,
} from "@wavekit/api-types"

export interface StatusPayload {
	dongle?: {
		present: boolean
		product: string | null
		driverConflict?: boolean
		conflictingDriver?: string | null
	}
	rtlTcp?: {
		running: boolean
		pid?: number | null
		restartCount: number
		lastRestartAt: string | null
	}
	rtlmux?: {
		running: boolean
		pid?: number | null
		restartCount: number
		lastRestartAt: string | null
	}
	sampling?: SdrHostSampling
	delivery?: SdrHostDelivery
	samplingHistory?: SdrHostSamplingHistory
}

export type Tone = "ok" | "warn" | "fault" | "unknown"
export type LinkStateName =
	| "connecting"
	| "live"
	| "reconnecting"
	| "stale"
	| "offline"

export const SNAPSHOT_STALE_MS: number
export const POLL_INTERVAL_MS: number
export const REQUEST_TIMEOUT_MS: number
export const MAX_BACKOFF_MS: number

export function formatRate(bytesPerSecond: number | null | undefined): {
	value: string
	unit: string
}
export function formatRateText(
	bytesPerSecond: number | null | undefined,
): string
export function formatBytes(bytes: number | null | undefined): string
export function formatDuration(seconds: number | null | undefined): string
export function formatAge(ms: number | null | undefined): string
export function formatAgePrecise(ms: number | null | undefined): string
export function nextDelay(consecutiveFailures: number): number
export function linkState(input: {
	lastSuccessAt: number | null
	consecutiveFailures: number
	now: number
	hidden: boolean
}): { state: LinkStateName; text: string }
export function verdict(input: {
	status: StatusPayload | null
	host: SdrHostTelemetry | null
	fresh: boolean
}): { state: Tone; title: string; detail: string }

export interface Stage {
	state: "ok" | "warn" | "fault" | "idle" | "unknown"
	word: string
	fact: string
}
export function stages(
	status: StatusPayload | null,
): { dongle: Stage; rtltcp: Stage; rtlmux: Stage; clients: Stage } | null
export function power(host: SdrHostTelemetry | null): {
	windows: Array<{
		key: string
		label: string
		state: "active" | "latched" | "clear" | "unknown"
		text: string
	}>
	note: string
}
export interface Readout {
	state: "ok" | "warn" | "fault" | "stale" | "unavailable"
	value: string
	sub: string
	fill: number | null
}
export function readouts(
	host: SdrHostTelemetry | null,
): Record<
	"cpu" | "memory" | "disk" | "temperature" | "network" | "uptime",
	Readout
> | null
export function primaryInterface(
	network: Reading<SdrHostNetworkInterface[]> | undefined,
): SdrHostNetworkInterface | null
export function setupLine(reading: SdrHostTelemetry["setup"] | undefined): {
	state: Tone
	text: string
}
export function tracePath(
	points: Array<[number, number | null]>,
	options: { windowMs: number; width: number; height: number; max: number },
): { d: string; gaps: Array<[number, number]> }
export function plotMax(
	expected: number | null,
	points: Array<[number, number | null]>,
): number
