/**
 * Receiver controls: the capabilities snapshot and relay status per source, and the tuner setting
 * writes with their pending and error state per control.
 *
 * Writes are not optimistic-only: while one is in flight the control shows its target and a pending
 * mark; once the core answers, the validated TunerState goes to the tuner store and the control shows
 * the core's value again (as do `tuner:state-changed` events from any other writer). Writes to one
 * control run one at a time and the latest value wins: a slider drag sends what it ends on, not
 * every step. A failure keeps the core's error on that control until the next attempt or dismiss().
 */
import type { TunerState } from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import type {
	ReceiverApi,
	ReceiverCaps,
	ReceiverSetting,
	ReceiverSettingKey,
	TunerRelayView,
} from "./receiver-api.ts"
import { createReceiverApi } from "./receiver-api.ts"
import { Store } from "./store.ts"

/** A failed request: the core's stable code when it sent one, its HTTP status (0: no answer). */
export interface ControlError {
	code: string | null
	status: number
	message: string
}

export interface ControlStatus {
	pending: boolean
	/** The value being written while pending. */
	target: ReceiverSetting["value"] | null
	error: ControlError | null
}

export interface CapsEntry {
	status: "loading" | "ready" | "error"
	caps: ReceiverCaps | null
	error: ControlError | null
}

export interface ReceiverStoreState {
	caps: Readonly<Record<string, CapsEntry>>
	/** GET /api/tuner-relay; null when the core has no relay or before it loaded. */
	relay: TunerRelayView | null
	relayLoaded: boolean
	controls: Readonly<
		Record<string, Readonly<Partial<Record<ReceiverSettingKey, ControlStatus>>>>
	>
}

export interface ReceiverStoreOptions {
	/** The tuner store's current state for a source (gain mode decides the manual-gain sequence). */
	tunerState: (sourceId: string) => TunerState | undefined
	/** Where validated write answers go (the tuner store). */
	onState: (state: TunerState) => void
	/** Overrides the REST calls (tests). */
	receiverApi?: ReceiverApi
}

export function toControlError(error: unknown): ControlError {
	if (error instanceof ApiError)
		return { code: error.code, status: error.status, message: error.message }
	return { code: null, status: 0, message: errorMessage(error) }
}

const IDLE: ControlStatus = { pending: false, target: null, error: null }

export class ReceiverStore extends Store<ReceiverStoreState> {
	private readonly api: ReceiverApi
	private readonly options: ReceiverStoreOptions
	private readonly cleanup: (() => void)[]
	private readonly queued = new Map<string, ReceiverSetting>()
	private readonly running = new Map<string, Promise<boolean>>()
	private readonly capsRequests = new Map<string, AbortController>()
	private readonly lastRate = new Map<string, number>()

	constructor(
		api: ApiClient,
		events: EventsClient,
		options: ReceiverStoreOptions,
	) {
		super({ caps: {}, relay: null, relayLoaded: false, controls: {} })
		this.api = options.receiverApi ?? createReceiverApi(api)
		this.options = options
		this.cleanup = [
			events.subscribe(["tuner"]),
			events.on("tuner:state-changed", ({ sourceId, state }) =>
				this.onTunerState(sourceId, state),
			),
			events.on("tuner:control-mode-changed", () => void this.loadRelay()),
			events.onReconnected(() => {
				void this.loadRelay()
				for (const id of Object.keys(this.get().caps)) void this.loadCaps(id)
			}),
		]
	}

	control(sourceId: string, key: ReceiverSettingKey): ControlStatus {
		return this.get().controls[sourceId]?.[key] ?? IDLE
	}

	/** Never rejects: a failure lands in the entry's error. */
	async loadCaps(sourceId: string): Promise<void> {
		this.capsRequests.get(sourceId)?.abort()
		const abort = new AbortController()
		this.capsRequests.set(sourceId, abort)
		this.putCaps(sourceId, entry => ({
			status: entry?.caps ? entry.status : "loading",
			caps: entry?.caps ?? null,
			error: null,
		}))
		try {
			const caps = await this.api.capabilities(sourceId, abort.signal)
			if (abort.signal.aborted) return
			this.putCaps(sourceId, () => ({ status: "ready", caps, error: null }))
		} catch (error) {
			if (abort.signal.aborted) return
			this.putCaps(sourceId, () => ({
				status: "error",
				caps: null,
				error: toControlError(error),
			}))
		} finally {
			if (this.capsRequests.get(sourceId) === abort)
				this.capsRequests.delete(sourceId)
		}
	}

	/** Never rejects: a failure leaves the relay unknown (null). */
	async loadRelay(): Promise<void> {
		try {
			const relay = await this.api.relay()
			this.update(s => ({ ...s, relay, relayLoaded: true }))
		} catch {
			this.update(s => ({ ...s, relay: null, relayLoaded: true }))
		}
	}

	/**
	 * Writes one setting. Resolves true when the core accepted it (or a newer value for the same
	 * control that superseded it), false when the last attempt failed. Never rejects.
	 */
	write(sourceId: string, setting: ReceiverSetting): Promise<boolean> {
		const k = `${sourceId}\u0000${setting.key}`
		this.patchControl(sourceId, setting.key, {
			pending: true,
			target: setting.value,
			error: null,
		})
		this.queued.set(k, setting)
		const current = this.running.get(k)
		if (current) return current
		const run = this.drain(sourceId, setting.key, k)
		this.running.set(k, run)
		return run
	}

	/**
	 * Manual gain at `tenthsDb`: switches the tuner to manual first unless the core already reports
	 * manual mode as known (rtl_tcp ignores a gain while the tuner AGC runs).
	 */
	async setManualGain(sourceId: string, tenthsDb: number): Promise<boolean> {
		const state = this.options.tunerState(sourceId)
		const knownManual =
			state !== undefined &&
			state.gainMode === "manual" &&
			!(state.unknownFields?.includes("gainMode") ?? false)
		const modePending = this.control(sourceId, "gainMode")
		if (
			!knownManual ||
			(modePending.pending && modePending.target !== "manual")
		) {
			this.patchControl(sourceId, "gain", {
				pending: true,
				target: tenthsDb,
				error: null,
			})
			const ok = await this.write(sourceId, {
				key: "gainMode",
				value: "manual",
			})
			if (!ok) {
				const failure = this.control(sourceId, "gainMode").error
				this.patchControl(sourceId, "gain", {
					pending: false,
					target: null,
					error: failure,
				})
				return false
			}
		}
		return this.write(sourceId, { key: "gain", value: tenthsDb })
	}

	dismiss(sourceId: string, key: ReceiverSettingKey): void {
		const status = this.control(sourceId, key)
		if (status.error) this.patchControl(sourceId, key, { error: null })
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
		for (const abort of this.capsRequests.values()) abort.abort()
		this.capsRequests.clear()
	}

	private async drain(
		sourceId: string,
		key: ReceiverSettingKey,
		k: string,
	): Promise<boolean> {
		let ok = true
		let failure: ControlError | null = null
		try {
			for (let next = this.queued.get(k); next; next = this.queued.get(k)) {
				this.queued.delete(k)
				try {
					const state = await this.api.write(sourceId, next)
					this.options.onState(state)
					ok = true
					failure = null
				} catch (error) {
					ok = false
					failure = toControlError(error)
				}
			}
		} finally {
			this.running.delete(k)
			this.patchControl(sourceId, key, {
				pending: false,
				target: null,
				error: failure,
			})
		}
		return ok
	}

	private onTunerState(sourceId: string, state: TunerState): void {
		const previous = this.lastRate.get(sourceId)
		this.lastRate.set(sourceId, state.sampleRate)
		// A new rate restarts the stream in the core: the declared stream and the session change.
		if (
			previous !== undefined &&
			previous !== state.sampleRate &&
			this.get().caps[sourceId]
		)
			void this.loadCaps(sourceId)
	}

	private putCaps(
		sourceId: string,
		fn: (entry: CapsEntry | undefined) => CapsEntry,
	): void {
		this.update(s => ({
			...s,
			caps: { ...s.caps, [sourceId]: fn(s.caps[sourceId]) },
		}))
	}

	private patchControl(
		sourceId: string,
		key: ReceiverSettingKey,
		patch: Partial<ControlStatus>,
	): void {
		this.update(s => {
			const bySource = s.controls[sourceId] ?? {}
			const next = { ...(bySource[key] ?? IDLE), ...patch }
			return {
				...s,
				controls: { ...s.controls, [sourceId]: { ...bySource, [key]: next } },
			}
		})
	}
}
