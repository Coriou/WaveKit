/**
 * Settings › Devices: the browsers and apps this core remembers (GET /api/access/devices, a
 * browser session only), their name and kind (POST …/label), and sign-out of one device after a
 * few seconds of Undo (POST …/revoke). Signing this browser out and "everywhere" go through the
 * data layer, which also drops the session. docs/API.md › remembered devices.
 */
import { accessDevicesDtoSchema } from "@wavekit/api-types"
import type { AccessDeviceDto, AccessDeviceKind } from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import {
	ACCESS_DEVICES_LABEL_ROUTE,
	ACCESS_DEVICES_REVOKE_ROUTE,
	ACCESS_DEVICES_ROUTE,
	ApiError,
	errorMessage,
	validated,
} from "./api-client.ts"
import { Store } from "./store.ts"

/** How long a signed-out device waits for Undo before the core is told. */
export const DEVICE_REVOKE_GRACE_MS = 6000

export interface AccessDevicesState {
	/** Null until loaded, and when this browser has no session (the route answers 401). */
	devices: readonly AccessDeviceDto[] | null
	loading: boolean
	error: string | null
	/** Devices signed out and waiting for Undo: hidden from the list. */
	removing: ReadonlySet<string>
}

export class AccessDevicesStore extends Store<AccessDevicesState> {
	private readonly api: ApiClient
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
	private inflight: Promise<void> | null = null

	constructor(api: ApiClient) {
		super({ devices: null, loading: false, error: null, removing: new Set() })
		this.api = api
	}

	/** GET /api/access/devices. Never rejects: a 401 empties the list, anything else lands in `error`. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	/** Forgets the list (the session ended). */
	clear(): void {
		for (const t of this.timers.values()) clearTimeout(t)
		this.timers.clear()
		this.set({
			devices: null,
			loading: false,
			error: null,
			removing: new Set(),
		})
	}

	/** POST …/label: name and kind (null clears, absent keeps). Rejects with the ApiError. */
	async label(
		deviceId: string,
		patch: { name?: string | null; kind?: AccessDeviceKind | null },
	): Promise<void> {
		const name =
			patch.name === undefined || patch.name === null
				? patch.name
				: patch.name.trim() || null
		await this.api.post<unknown>(ACCESS_DEVICES_LABEL_ROUTE, {
			deviceId,
			...(name !== undefined ? { name } : {}),
			...(patch.kind !== undefined ? { kind: patch.kind } : {}),
		})
		this.update(s => ({
			...s,
			devices:
				s.devices?.map(d =>
					d.deviceId === deviceId
						? {
								...d,
								...(name !== undefined ? { name } : {}),
								...(patch.kind !== undefined ? { kind: patch.kind } : {}),
							}
						: d,
				) ?? null,
		}))
	}

	/**
	 * Hides another device now and signs it out after the grace period; the returned function
	 * is Undo. A failure shows the device again and calls `onError`.
	 */
	scheduleRevoke(
		deviceId: string,
		onError: (error: unknown) => void,
		graceMs = DEVICE_REVOKE_GRACE_MS,
	): () => void {
		this.cancelTimer(deviceId)
		this.setRemoving(deviceId, true)
		this.timers.set(
			deviceId,
			setTimeout(() => {
				this.timers.delete(deviceId)
				void this.revoke(deviceId).catch(onError)
			}, graceMs),
		)
		return () => {
			if (!this.timers.has(deviceId)) return
			this.cancelTimer(deviceId)
			this.setRemoving(deviceId, false)
		}
	}

	/** Sends every sign-out still waiting for Undo (Settings is closing). */
	flushRevokes(): void {
		for (const id of [...this.timers.keys()]) {
			this.cancelTimer(id)
			void this.revoke(id).catch(() => {})
		}
	}

	/** POST …/revoke now. Rejects with the ApiError (the device shows again). */
	async revoke(deviceId: string): Promise<void> {
		try {
			await this.api.post<unknown>(ACCESS_DEVICES_REVOKE_ROUTE, { deviceId })
			this.update(s => ({
				...s,
				devices: s.devices?.filter(d => d.deviceId !== deviceId) ?? null,
			}))
		} finally {
			this.setRemoving(deviceId, false)
		}
	}

	private async fetch(): Promise<void> {
		this.update(s => ({ ...s, loading: true }))
		try {
			const body = await this.api.get<unknown>(ACCESS_DEVICES_ROUTE)
			const { devices } = validated(
				accessDevicesDtoSchema,
				body,
				"GET",
				ACCESS_DEVICES_ROUTE,
			)
			this.update(s => ({ ...s, devices, loading: false, error: null }))
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) {
				this.update(s => ({ ...s, devices: null, loading: false, error: null }))
				return
			}
			this.update(s => ({ ...s, loading: false, error: errorMessage(error) }))
		}
	}

	private cancelTimer(id: string): void {
		const t = this.timers.get(id)
		if (t) clearTimeout(t)
		this.timers.delete(id)
	}

	private setRemoving(id: string, on: boolean): void {
		this.update(s => {
			if (s.removing.has(id) === on) return s
			const removing = new Set(s.removing)
			if (on) removing.add(id)
			else removing.delete(id)
			return { ...s, removing }
		})
	}
}
