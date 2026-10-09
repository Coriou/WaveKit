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
	/** Receiver service uptime in seconds. */
	uptime?: number
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
		config?: {
			sampleRate: number
			frequency: number
			agc: boolean
			gain: number
		}
	}
	rtlmux?: {
		running: boolean
		pid?: number | null
		restartCount: number
		lastRestartAt: string | null
		endpoint?: string
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
	failures?: number
}): { state: Tone; title: string; detail: string }

export function flowRate(
	status: StatusPayload | null,
	fresh: boolean,
): { value: string; unit: string; sub: string; basis: string }

export interface Row {
	state: Tone
	text: string
	sub: string
}
export interface ClientRow {
	key: string
	address: string
	state: "ok" | "warn" | "unknown"
	rate: string
	bytesPerSec: number | null
	detail: string
}
export const CLIENT_SLOTS: number
export function stream(
	status: StatusPayload | null,
	piNow?: string | null,
): {
	endpoint: string | null
	dongle: Row
	tuning: { text: string; sub: string }
	clientsKnown: boolean
	clientsRow: Row
	clients: ClientRow[]
} | null
export function clientSlots(
	clients: ClientRow[],
	slots?: number,
): {
	shown: ClientRow[]
	more: { state: "ok" | "warn"; text: string; detail: string } | null
}

type Series = Array<[number, number | null]>
export function trends(host: SdrHostTelemetry | null): {
	windowMs: number
	cpu: Series
	memory: Series
	temperature: Series
	dips: Series
} | null
export function recentDips(
	host: SdrHostTelemetry | null,
): { count: number; spanMs: number } | null
export function power(host: SdrHostTelemetry | null): Row
export function wifiBars(dbm: number): {
	bars: 1 | 2 | 3 | 4
	word: string
	warn: boolean
}

export interface Readout {
	state: "ok" | "warn" | "fault" | "stale" | "unavailable"
	value: string
	sub: string
	bars?: number | null
	/** Storage only: used fraction, 0–1, drawn as a meter. */
	meter?: number
}
export function readouts(
	host: SdrHostTelemetry | null,
): Record<
	"cpu" | "memory" | "disk" | "temperature" | "network" | "uptime",
	Readout
> | null
export function lastBoot(host: SdrHostTelemetry | null): {
	unexpected: boolean
	text: string
	short: string
	lastLog: string | null
}
export function primaryInterface(
	network: Reading<SdrHostNetworkInterface[]> | undefined,
): SdrHostNetworkInterface | null
export function setupLine(reading: SdrHostTelemetry["setup"] | undefined): {
	state: Tone
	text: string
}
export function setupRow(reading: SdrHostTelemetry["setup"] | undefined): Row
export interface Fact {
	term: string
	value: string
	/** Freshness lamp, for measurement sources. */
	tone?: "ok" | "stale" | "unknown"
	word?: string
	/** Static explanation, gathered into the notes after the groups. */
	note?: string
}
export interface DiagnosticsGroup {
	key: "receiver" | "host" | "sources"
	title: string
	facts: Fact[]
}
export function diagnostics(input: {
	status: StatusPayload | null
	host: SdrHostTelemetry | null
	/** False once the page has lost contact: sources read "Last known". */
	fresh?: boolean
}): DiagnosticsGroup[]
export function tracePath(
	points: Array<[number, number | null]>,
	options: { windowMs: number; width: number; height: number; max: number },
): { d: string; area: string }
export function smoothTrace(
	points: Array<[number, number | null]>,
	spanMs?: number,
): Array<[number, number | null]>
export function plotMax(
	expected: number | null,
	points: Array<[number, number | null]>,
): number
