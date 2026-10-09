import type { SourceActivity } from "./sources.js"

/**
 * Pi SDR-host telemetry contracts (served by `@wavekit/sdr-host`).
 *
 * Every section carries its own freshness and provenance: `scope` says whose
 * measurement it is (the Pi host, the sdr-host container, the filesystem
 * backing Docker storage, or what the service itself has observed since it
 * started). An `unavailable` reading always has a `reason` and a null value.
 */
export type ReadingState = "ok" | "stale" | "unavailable"
export type ReadingScope = "host" | "container" | "docker-storage" | "service"

export interface Reading<T> {
	state: ReadingState
	scope: ReadingScope
	observedAt: string | null
	ageMs: number | null
	value: T | null
	reason: string | null
}

/**
 * Upstream sampling as evidenced by fresh rtlmux byte counts. Shares core's
 * SourceActivity vocabulary; `unknown` means the evidence cannot be observed.
 * Zero downstream clients never implies sampling stopped.
 */
type SharedActivityState = Extract<
	SourceActivity["state"],
	"disconnected" | "waiting" | "streaming" | "stale"
>
export type SamplingState = SharedActivityState | "unknown"

export type StatsError = "timeout" | "unreachable" | "http" | "invalid"

export interface SdrHostSampling {
	state: SamplingState
	reason: string | null
	timeoutMs: number
	lastSampleAt: string | null
	sampleAgeMs: number | null
	upstream: {
		/** rtlmux bytes read from rtl_tcp since rtlmux started. */
		bytesTotal: number | null
		bytesPerSec: number | null
		windowMs: number | null
		/** 2 bytes (U8 I + Q) per configured sample; null once a client sends commands. */
		expectedBytesPerSec: number | null
		rateBasis: "configured" | "client-controlled"
		rateStatus: "nominal" | "low" | "unknown"
	}
	epoch: {
		rtlmuxPid: number | null
		rtlTcpPid: number | null
		startedAt: string | null
		resets: number
		lastResetReason: "rtlmux-restart" | "counter-decrease" | null
	}
	stats: {
		state: ReadingState
		observedAt: string | null
		ageMs: number | null
		lastError: StatsError | null
	}
}

export interface SdrHostDeliveryClient {
	key: string
	address: string
	connectedAt: string | null
	/** IQ bytes rtlmux queued for this client since it connected. */
	queuedBytes: number
	queuedBytesPerSec: number | null
	/** Bytes rtlmux skipped because this client fell more than 4 MiB behind. */
	droppedBytes: number
	droppedChunks: number
	droppedBytesLast60s: number
	/** Command bytes the client sent upstream (retunes, sample-rate changes). */
	commandBytes: number
}

export interface SdrHostDelivery {
	state: "idle" | "delivering" | "dropping" | "unknown"
	clients: SdrHostDeliveryClient[]
	queuedBytesPerSec: number | null
	droppedBytesLast60s: number
	droppedChunksLast60s: number
	droppedBytesSinceMonitorStart: number
	monitorStartedAt: string
}

export interface SdrHostNetworkInterface {
	name: string
	kind: "ethernet" | "wireless" | "other"
	operstate: string
	addresses: string[]
	rxBytesPerSec: number | null
	txBytesPerSec: number | null
	wireless: { linkQuality: number; signalDbm: number } | null
}

export interface SdrHostTelemetry {
	generatedAt: string
	uptime: Reading<{
		hostSec: number
		hostBootedAt: string
		containerSec: number | null
		serviceSec: number
	}>
	cpu: Reading<{ busyPercent: number; cores: number; windowMs: number }>
	load: Reading<{ one: number; five: number; fifteen: number }>
	memory: Reading<{
		totalBytes: number
		availableBytes: number
		swapTotalBytes: number
		swapFreeBytes: number
	}>
	container: Reading<{
		memoryBytes: number
		memoryLimitBytes: number | null
		cpuPercent: number | null
	}>
	disk: Reading<{
		totalBytes: number
		usedBytes: number
		availableBytes: number
	}>
	temperature: Reading<{ celsius: number; zone: string }>
	power: {
		/** Under-voltage within the kernel's last ~2 s poll (hwmon rpi_volt). */
		undervoltageNow: Reading<boolean>
		/** Rising edges observed by sdr-host since it started; not since boot. */
		undervoltageObserved: Reading<{
			events: number
			lastAt: string | null
			since: string
			/** Measured on the Pi's monotonic clock; safe without NTP/RTC. */
			lastAgeMs: number | null
			coveredMs: number
		}>
		throttling: Reading<{
			freqCapped: boolean
			throttled: boolean
			softTempLimit: boolean
		}>
	}
	network: Reading<SdrHostNetworkInterface[]>
	setup: Reading<{
		state: "running" | "complete" | "failed" | "interrupted"
		phase: string | null
		updatedAt: string
		/** Pi clock now minus updatedAt; null when that would be negative. */
		updatedAgeMs: number | null
		exitCode: number | null
	}>
	/** Recent host trends for the operator page; absent on older receivers. */
	history?: SdrHostTelemetryHistory
	/** How the previous boot ended; absent on older receivers. */
	lastBoot?: Reading<SdrHostLastBoot>
}

/**
 * Recorded once per boot on WaveKit images from the persistent journal and the
 * firmware's flags. Each fact is null when it could not be read.
 */
export interface SdrHostLastBoot {
	/** Null when the journal holds no earlier boot (first boot, or volatile journal). */
	previous: {
		/** Time of the previous boot's last journal entry (Pi clock). */
		lastEntryAt: string
		lastEntryAgeMs: number | null
		/** It reached shutdown.target: a requested reboot or power-off. */
		cleanShutdown: boolean
	} | null
	/** Firmware flags read at this boot: seen since power-on. */
	undervoltageSinceBoot: boolean | null
	throttledSinceBoot: boolean | null
	/** True only when the watchdog driver reports a watchdog reset. */
	watchdogReset: true | null
}

/**
 * Per-collection host trends; ages are relative to the response. A null
 * value was not measurable at that moment. `undervoltageDips` counts rising
 * edges of the under-voltage alarm seen during that interval.
 */
export interface SdrHostTelemetryHistory {
	intervalMs: number
	windowMs: number
	points: Array<
		[
			ageMs: number,
			cpuBusyPercent: number | null,
			memoryUsedPercent: number | null,
			celsius: number | null,
			undervoltageDips: number | null,
		]
	>
}

/** Per-poll upstream rate for the plot; ages are relative to the response. */
export interface SdrHostSamplingHistory {
	pollIntervalMs: number
	windowMs: number
	points: Array<[ageMs: number, bytesPerSec: number | null]>
}
