/**
 * Activity lifecycle for the process entry. Disabled mode constructs nothing
 * and does not load the store. node:sqlite stays behind the storage probe's
 * dynamic import.
 */
import type { ActivityPublisher } from "../../decoders/manager.js"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import type { ActivityQueryService } from "./storage/contract.js"
import type {
	ActivityRetentionPolicy,
	ActivityStoreStats,
	AnalogTransmissionPayload,
} from "./storage/contract.js"
import type { ActivityLimits } from "./storage/limits.js"
import type { ActivityProvenanceLookup, DecodeEnvelope } from "./types.js"

export type ActivityFailureCode =
	| "ACTIVITY_UNAVAILABLE"
	| "ACTIVITY_STORE_LOCKED"
	| "ACTIVITY_SCHEMA_MISMATCH"
	| "ACTIVITY_OPEN_TIMEOUT"

export interface ActivityUnavailableState {
	reason: ActivityFailureCode
	message: string
	/** When false, routes replace `message` and still return `reason`. */
	discloseErrors?: boolean
	/**
	 * False when another attempt cannot help: no node:sqlite or FTS5 (the probe), or a
	 * foreign schema. Timeouts, a held lock and other open failures are retryable.
	 */
	retryable?: boolean
}

export interface ActivityRetentionOverrides {
	maxRows?: number | undefined
	maxDbBytes?: number | undefined
	maxAgeMs?: number | undefined
	/** WG3 (web-gaps-3 req 1.1); omitted keeps ACTIVITY_RETENTION_POLICY_DEFAULT. */
	policy?: ActivityRetentionPolicy | undefined
}

export interface ActivityAdmissionOverrides {
	globalPerSecond?: number | undefined
	globalBurst?: number | undefined
	perDecoderPerSecond?: number | undefined
	perDecoderBurst?: number | undefined
}

export interface ActivityRuntime {
	readonly status: "disabled" | "unavailable" | "ready"
	readonly service: ActivityQueryService
	readonly unavailable?: ActivityUnavailableState
	/** False in protected mode: HTTP 503 messages stay generic. */
	readonly discloseErrors: boolean
	stats(): ActivityStoreStats
	bindSubscriptions(hub: { close(): void }): void
	/**
	 * Admits a closed transmission when Activity is ready. Null when disabled,
	 * unavailable, or closed. The returned function never throws; it allocates
	 * receivedAt with Date.now() and sets producedAt to payload.endedAt.
	 */
	transmissionSink(): ((payload: AnalogTransmissionPayload) => void) | null
	close(): Promise<void>
}

/**
 * The config-derived part of the runtime options (the `activity` block). An
 * omitted retention or admission block stays unset, so the store applies the
 * bounded ACTIVITY_LIMIT_DEFAULTS (WG1 req 7.1, 7.2).
 */
export function activityConfigOptions(activity: {
	enabled: boolean
	retention?: ActivityRetentionOverrides | undefined
	admission?: ActivityAdmissionOverrides | undefined
}): Pick<StartActivityRuntimeOptions, "enabled" | "retention" | "admission"> {
	return {
		enabled: activity.enabled,
		...(activity.retention ? { retention: activity.retention } : {}),
		...(activity.admission ? { admission: activity.admission } : {}),
	}
}

export interface StartActivityRuntimeOptions {
	enabled: boolean
	stateDir: string
	logger: Logger
	retention?: ActivityRetentionOverrides
	admission?: ActivityAdmissionOverrides
	setPublisher: (publish: ActivityPublisher | null) => void
	/**
	 * Store limit overrides merged after retention and admission. Production
	 * leaves this unset; tests use it to flush on admit.
	 */
	limits?: Partial<ActivityLimits>
	/** Store execution. Production uses the default worker thread. */
	execution?: "thread" | "inline"
	workerUrl?: URL
	/** Query execution. Production uses the default reader worker. */
	queryExecution?: "worker" | "inline"
	queryWorkerUrl?: URL
	/** Replaces the capability probe. A failure writes no state file. */
	probe?: () => Promise<{ ok: true } | { ok: false; reason: string }>
	/** When false, failure logs carry the code only. */
	discloseErrors?: boolean
	/** False: a failed open logs nothing (the retrying lifecycle logs its own warn). */
	logFailure?: boolean
	/** Writer open budget; the store's ACTIVITY_OPEN_TIMEOUT_MS when omitted. */
	openTimeoutMs?: number
	/** Test seam: the writer waits this long after taking the lock. */
	openDelayMs?: number
	/**
	 * WG3 (web-gaps-3 req 5.2): decoder binding lookup for reception provenance, passed to
	 * the ingress unchanged. Null or omitted keeps null provenance (pre-WG3 behaviour).
	 */
	resolveProvenance?: ActivityProvenanceLookup | null
	/**
	 * Detection quality R4: called with the presented envelope of each reception the
	 * store admitted (after coalescing, rate and queue admission), never for a dropped
	 * one. A throwing callback is ignored; it never reaches the decoder path.
	 */
	onEnvelope?: (envelope: DecodeEnvelope) => void
}

/** Service that routes never call while Activity is disabled or unavailable. */
export function inertActivityService(): ActivityQueryService {
	const fail = (): never => {
		throw new WaveKitError(
			"Activity service is not available",
			"ACTIVITY_UNAVAILABLE",
		)
	}
	return {
		search: async () => fail(),
		detail: async () => fail(),
		facets: async () => fail(),
		trails: async () => fail(),
		bandMap: async () => fail(),
		timeline: async () => fail(),
		replay: () => fail(),
		close: async () => {},
	}
}

function closedStats(): never {
	throw new WaveKitError("Activity store is not open", "ACTIVITY_UNAVAILABLE")
}

function failureState(
	options: StartActivityRuntimeOptions,
	reason: ActivityFailureCode,
	message: string,
	retryable: boolean,
): ActivityUnavailableState {
	return {
		reason,
		message,
		discloseErrors: options.discloseErrors !== false,
		retryable,
	}
}

function mapLimits(
	retention: ActivityRetentionOverrides | undefined,
	admission: ActivityAdmissionOverrides | undefined,
): Partial<ActivityLimits> | undefined {
	const limits: Partial<ActivityLimits> = {}
	if (retention?.maxRows !== undefined) limits.maxRows = retention.maxRows
	if (retention?.maxDbBytes !== undefined)
		limits.maxDbBytes = retention.maxDbBytes
	if (retention?.maxAgeMs !== undefined) limits.maxAgeMs = retention.maxAgeMs
	if (retention?.policy !== undefined) limits.retentionPolicy = retention.policy
	if (admission?.globalPerSecond !== undefined)
		limits.globalRatePerSec = admission.globalPerSecond
	if (admission?.globalBurst !== undefined)
		limits.globalBurst = admission.globalBurst
	if (admission?.perDecoderPerSecond !== undefined)
		limits.decoderRatePerSec = admission.perDecoderPerSecond
	if (admission?.perDecoderBurst !== undefined)
		limits.decoderBurst = admission.perDecoderBurst
	return Object.keys(limits).length > 0 ? limits : undefined
}

interface RuntimeParts {
	status: ActivityRuntime["status"]
	service: ActivityQueryService
	unavailable?: ActivityUnavailableState
	stats: () => ActivityStoreStats
	closeSteps: Array<() => Promise<void> | void>
	admitTransmission?: (payload: AnalogTransmissionPayload) => void
}

function assemble(
	options: StartActivityRuntimeOptions,
	parts: RuntimeParts,
): ActivityRuntime {
	const log = createComponentLogger(options.logger, "Activity")
	const disclose = options.discloseErrors !== false
	let subscriptions: { close(): void } | undefined
	let closed = false

	function note(step: string, err: unknown): void {
		try {
			log.error(
				disclose ? { err, step } : { step, code: "ACTIVITY_CLOSE_FAILED" },
				"Activity shutdown step failed",
			)
		} catch {
			// Shutdown must not throw.
		}
	}

	const runtime: ActivityRuntime = {
		status: parts.status,
		service: parts.service,
		discloseErrors: options.discloseErrors !== false,
		stats: parts.stats,
		...(parts.unavailable ? { unavailable: parts.unavailable } : {}),
		bindSubscriptions(hub) {
			subscriptions = hub
			if (!closed) return
			try {
				hub.close()
			} catch (err) {
				note("subscriptions", err)
			}
		},
		transmissionSink() {
			const admit = parts.admitTransmission
			if (closed || !admit) return null
			return payload => {
				if (closed) return
				try {
					admit(payload)
				} catch {
					// The live-demod listener must not see a store failure.
				}
			}
		},
		async close() {
			if (closed) return
			closed = true
			const steps: Array<() => Promise<void> | void> = [
				() => {
					options.setPublisher(null)
				},
				() => {
					subscriptions?.close()
				},
				...parts.closeSteps,
			]
			for (const step of steps) {
				try {
					await step()
				} catch (err) {
					note("close", err)
				}
			}
		},
	}
	return runtime
}

function unavailableRuntime(
	options: StartActivityRuntimeOptions,
	unavailable: ActivityUnavailableState,
): ActivityRuntime {
	const log = createComponentLogger(options.logger, "Activity")
	const disclose = options.discloseErrors !== false
	if (options.logFailure !== false)
		try {
			log.error(
				disclose
					? { code: unavailable.reason, err: unavailable.message }
					: { code: unavailable.reason },
				"Activity is unavailable; WaveKit continues without it",
			)
		} catch {
			// A failing logger must not take the process down.
		}
	return assemble(options, {
		status: "unavailable",
		service: inertActivityService(),
		unavailable,
		stats: closedStats,
		closeSteps: [],
	})
}

/**
 * Opens the store, query service and ingress when Activity is enabled.
 * Probe and open failures leave the process running with Activity unavailable.
 */
export async function startActivityRuntime(
	options: StartActivityRuntimeOptions,
): Promise<ActivityRuntime> {
	if (!options.enabled) {
		return assemble(options, {
			status: "disabled",
			service: inertActivityService(),
			stats: closedStats,
			closeSteps: [],
		})
	}

	const log = createComponentLogger(options.logger, "Activity")
	try {
		const storage = await import("./storage/index.js")
		const query = await import("./query/index.js")
		const ingressMod = await import("./ingress.js")
		const probed = await (options.probe ?? storage.probeActivityRuntime)()
		if (!probed.ok) {
			return unavailableRuntime(
				options,
				failureState(options, "ACTIVITY_UNAVAILABLE", probed.reason, false),
			)
		}
		const mapped = mapLimits(options.retention, options.admission)
		const limits =
			mapped || options.limits ? { ...mapped, ...options.limits } : undefined
		const store = await storage.openActivityStore({
			stateDir: options.stateDir,
			logger: options.logger,
			...(limits ? { limits } : {}),
			...(options.execution ? { execution: options.execution } : {}),
			...(options.workerUrl ? { workerUrl: options.workerUrl } : {}),
			...(options.probe ? { probe: options.probe } : {}),
			...(options.openTimeoutMs !== undefined
				? { openTimeoutMs: options.openTimeoutMs }
				: {}),
			...(options.openDelayMs !== undefined
				? { openDelayMs: options.openDelayMs }
				: {}),
		})
		let service: ActivityQueryService
		try {
			service = query.createActivityQueryService({
				store,
				logger: options.logger,
				...(options.queryExecution
					? { execution: options.queryExecution }
					: {}),
				...(options.queryWorkerUrl
					? { workerUrl: options.queryWorkerUrl }
					: {}),
			})
		} catch (error) {
			await store.close().catch(() => undefined)
			throw error
		}
		const ingress = ingressMod.createActivityIngress({
			sink: (envelope, present) => {
				const onEnvelope = options.onEnvelope
				if (onEnvelope === undefined) {
					store.admit(envelope, present)
					return
				}
				// The store presents only a kept reception; the callback reuses that result.
				let presented: DecodeEnvelope | undefined
				const lazy = (): DecodeEnvelope => (presented ??= present())
				const result = store.admit(envelope, lazy)
				if (!result.admitted) return
				try {
					onEnvelope(presented ?? lazy())
				} catch {
					// Never into the decoder path.
				}
			},
			logger: options.logger,
			resolveProvenance: options.resolveProvenance ?? null,
		})
		try {
			options.setPublisher((decoderId, decoderType, output) => {
				ingress.publish(decoderId, decoderType, output)
			})
		} catch (error) {
			try {
				options.setPublisher(null)
			} catch {
				// The open error is reported below.
			}
			await service.close().catch(() => undefined)
			await store.close().catch(() => undefined)
			throw error
		}
		try {
			log.info({ stateDir: options.stateDir }, "Activity store open")
		} catch {
			// Startup logging is not required for the store to run.
		}
		return assemble(options, {
			status: "ready",
			service,
			stats: () => store.stats(),
			closeSteps: [() => service.close(), () => store.close()],
			admitTransmission: payload => {
				store.admitTransmission({
					payload,
					producedAt: payload.endedAt,
					receivedAt: new Date(Date.now()).toISOString(),
				})
			},
		})
	} catch (error) {
		let reason: ActivityFailureCode = "ACTIVITY_UNAVAILABLE"
		let message = error instanceof Error ? error.message : String(error)
		let retryable = true
		try {
			const storage = await import("./storage/index.js")
			if (error instanceof storage.ActivityOpenTimeoutError) {
				reason = "ACTIVITY_OPEN_TIMEOUT"
				message = error.message
			} else if (error instanceof storage.ActivityStoreLockedError) {
				reason = "ACTIVITY_STORE_LOCKED"
				message = error.message
			} else if (error instanceof storage.ActivitySchemaMismatchError) {
				reason = "ACTIVITY_SCHEMA_MISMATCH"
				message = error.message
				retryable = false
			} else if (error instanceof storage.ActivityUnavailableError) {
				reason = "ACTIVITY_UNAVAILABLE"
				message = error.message
			}
		} catch {
			// Classification is best-effort; the process still stays up.
		}
		return unavailableRuntime(
			options,
			failureState(options, reason, message, retryable),
		)
	}
}
