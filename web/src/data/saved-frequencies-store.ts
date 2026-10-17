/**
 * Saved frequencies (DESIGN.md "Saved frequencies are first-class"): stored in core operator data,
 * shared by every client. GET /api/operator-data, the `operator-data` channel (a snapshot on
 * subscribe, `operator-data:updated` after each commit), and create / replace / delete with the
 * store's revision token. Changes show at once (optimistic) and roll back when core refuses them.
 *
 * Operator data is protected mode only: a legacy core answers 404 and the store says `unavailable`.
 */
import {
	OPERATOR_DATA_LIMITS,
	operatorDataReadDtoSchema,
	savedFrequencyInputSchema,
} from "@wavekit/api-types"
import type {
	ExpectedToken,
	OperatorDataReadDto,
	OperatorDataSnapshot,
	OperatorDataWriteDto,
	SavedFrequency,
	SavedFrequencyInput,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export type SavedFrequenciesStatus =
	| "idle"
	| "loading"
	| "ready"
	/** No operator data on this core (legacy mode, or core reports it unavailable). */
	| "unavailable"
	| "error"

/** A row as the app shows it: core's record, or one still being written. */
export interface SavedFrequencyRow extends SavedFrequency {
	/** Set while a change to this row waits for core. */
	pending?: "create" | "replace"
}

export interface SavedFrequenciesState {
	status: SavedFrequenciesStatus
	/** Sorted by frequency, then name. Includes optimistic changes. */
	items: readonly SavedFrequencyRow[]
	/** The token of the last snapshot core confirmed. */
	token: ExpectedToken | null
	/** Operator preference: draw saved-frequency names on the spectrum tags. */
	showLabels: boolean
	limit: number
	error: string | null
}

interface CreateOp {
	seq: number
	kind: "create"
	tempId: string
	frequency: SavedFrequencyInput
}
interface ReplaceOp {
	seq: number
	kind: "replace"
	id: string
	frequency: SavedFrequencyInput
}
interface DeleteOp {
	seq: number
	kind: "delete"
	id: string
}
/** A change shown before core confirms it. */
export type Op = CreateOp | ReplaceOp | DeleteOp

const TEMP_PREFIX = "pending-"

export function isPendingId(id: string): boolean {
	return id.startsWith(TEMP_PREFIX)
}

export function compareSaved(a: SavedFrequency, b: SavedFrequency): number {
	return (
		a.frequencyHz - b.frequencyHz ||
		(a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	)
}

/** Core's rows with the waiting changes applied in order, sorted for display. Pure. */
export function applyOps(
	base: readonly SavedFrequency[],
	ops: readonly Op[],
	now: string,
): SavedFrequencyRow[] {
	let rows: SavedFrequencyRow[] = [...base]
	for (const op of ops) {
		if (op.kind === "create")
			rows.push({
				...withoutUndefinedGroup(op.frequency),
				id: op.tempId,
				createdAt: now,
				updatedAt: now,
				pending: "create",
			})
		else if (op.kind === "replace")
			rows = rows.map(r =>
				r.id === op.id
					? {
							...withoutUndefinedGroup(op.frequency),
							id: r.id,
							createdAt: r.createdAt,
							updatedAt: now,
							pending: r.pending ?? "replace",
						}
					: r,
			)
		else rows = rows.filter(r => r.id !== op.id)
	}
	return rows.sort(compareSaved)
}

function withoutUndefinedGroup(f: SavedFrequencyInput): SavedFrequencyInput {
	if (f.group !== undefined || !Object.hasOwn(f, "group")) return f
	const copy = { ...f }
	delete copy.group
	return copy
}

/** Form values of a row, for a replace that keeps everything else (rename). */
export function inputOf(f: SavedFrequency): SavedFrequencyInput {
	const input: SavedFrequencyInput = {
		name: f.name,
		frequencyHz: f.frequencyHz,
		mode: f.mode,
		bandwidthHz: f.bandwidthHz,
		tone: f.tone,
	}
	if (f.group !== undefined) input.group = f.group
	return input
}

/** Validates and normalises a form (trims the name); throws ApiError `OPERATOR_DATA_INVALID`. */
export function checkInput(input: SavedFrequencyInput): SavedFrequencyInput {
	const result = savedFrequencyInputSchema.safeParse(input)
	if (result.success) return result.data
	throw new ApiError({
		status: 0,
		code: "OPERATOR_DATA_INVALID",
		message: result.error.issues[0]?.message ?? "Invalid saved frequency",
		body: null,
		method: "",
		path: "",
	})
}

function isNewer(
	next: OperatorDataSnapshot,
	current: ExpectedToken | null,
): boolean {
	return (
		!current ||
		next.storeId !== current.storeId ||
		next.revision > current.revision
	)
}

function codeOf(error: unknown): string | null {
	return error instanceof ApiError ? error.code : null
}

export class SavedFrequenciesStore extends Store<SavedFrequenciesState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	private base: readonly SavedFrequency[] = []
	private ops: Op[] = []
	private seq = 0
	private queue: Promise<unknown> = Promise.resolve()
	private inflight: Promise<void> | null = null
	private readonly clock: () => string

	constructor(
		api: ApiClient,
		events: EventsClient,
		clock: () => string = () => new Date().toISOString(),
	) {
		super({
			status: "idle",
			items: [],
			token: null,
			showLabels: true,
			limit: OPERATOR_DATA_LIMITS.savedFrequencies,
			error: null,
		})
		this.api = api
		this.clock = clock
		const live = (data: unknown) => {
			const parsed = operatorDataReadDtoSchema.safeParse(data)
			if (parsed.success) void this.accept(parsed.data)
			else void this.load()
		}
		this.cleanup = [
			events.subscribe(["operator-data"]),
			events.on("operator-data:snapshot", live),
			events.on("operator-data:updated", live),
			events.onReconnected(() => void this.load()),
		]
	}

	/** Never rejects: a failure lands in `error` (404 / unavailable: status `unavailable`). */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	/** The saved frequency at `hz` (exact), if any. */
	at(hz: number): SavedFrequencyRow | undefined {
		const r = Math.round(hz)
		return this.get().items.find(f => f.frequencyHz === r)
	}

	/** Saves a new frequency. Resolves with core's record; rejects (and rolls back) on refusal. */
	create(input: SavedFrequencyInput): Promise<SavedFrequency> {
		const frequency = checkInput(input)
		const tempId = `${TEMP_PREFIX}${++this.seq}`
		const op: Op = { seq: this.seq, kind: "create", tempId, frequency }
		this.push(op)
		return this.run(op, async token => {
			const dto = await this.api.createSavedFrequency(token, frequency)
			const id = dto.savedFrequencyId
			const created = dto.snapshot.savedFrequencies.find(f => f.id === id)
			return { dto, result: created }
		}).then(created => {
			if (!created)
				throw new ApiError({
					status: 200,
					code: "RESPONSE_INVALID",
					message: "Core did not return the saved frequency",
					body: null,
					method: "POST",
					path: "/api/operator-data/saved-frequencies",
				})
			return created
		})
	}

	/** Replaces every field of a saved frequency (rename, retune, mode). */
	replace(id: string, input: SavedFrequencyInput): Promise<void> {
		const frequency = checkInput(input)
		const op: Op = { seq: ++this.seq, kind: "replace", id, frequency }
		this.push(op)
		return this.run(op, async token => ({
			dto: await this.api.replaceSavedFrequency(id, token, frequency),
			result: undefined,
		}))
	}

	/** Renames, keeping frequency, mode, bandwidth, tone and group. */
	rename(id: string, name: string): Promise<void> {
		const row = this.get().items.find(f => f.id === id)
		if (!row) return Promise.reject(new Error("No such saved frequency"))
		return this.replace(id, { ...inputOf(row), name })
	}

	/** Deletes; a row core no longer has counts as deleted. */
	remove(id: string): Promise<void> {
		const op: Op = { seq: ++this.seq, kind: "delete", id }
		this.push(op)
		return this.run(op, async token => {
			try {
				return {
					dto: await this.api.deleteSavedFrequency(id, token),
					result: undefined,
				}
			} catch (error) {
				if (codeOf(error) !== "OPERATOR_DATA_NOT_FOUND") throw error
				await this.load()
				return { dto: null, result: undefined }
			}
		})
	}

	clearError(): void {
		this.update(s => (s.error === null ? s : { ...s, error: null }))
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}

	// ---- internals

	private async fetch(): Promise<void> {
		if (this.get().status === "idle")
			this.update(s => ({ ...s, status: "loading" }))
		try {
			this.accept(await this.api.getOperatorData())
		} catch (error) {
			const unavailable =
				error instanceof ApiError &&
				(error.status === 404 || codeOf(error) === "OPERATOR_DATA_UNAVAILABLE")
			if (unavailable) this.base = []
			this.update(s => ({
				...s,
				status: unavailable ? "unavailable" : "error",
				items: unavailable ? applyOps([], this.ops, this.clock()) : s.items,
				token: unavailable ? null : s.token,
				error: unavailable ? null : errorMessage(error),
			}))
		}
	}

	/** Takes a snapshot from core (REST answer or live event) when it is newer than ours. */
	private accept(dto: OperatorDataReadDto | OperatorDataWriteDto): boolean {
		const snapshot = dto.snapshot
		const current = this.get()
		if (!isNewer(snapshot, current.token) && current.status === "ready")
			return false
		this.base = snapshot.savedFrequencies
		const showLabels =
			"preferences" in dto
				? dto.preferences.values.showSavedFrequencyLabels
				: (snapshot.preferenceOverrides.showSavedFrequencyLabels ??
					current.showLabels)
		this.set({
			...current,
			status: "ready",
			token: { storeId: snapshot.storeId, revision: snapshot.revision },
			items: applyOps(this.base, this.ops, this.clock()),
			showLabels,
			error: null,
		})
		return true
	}

	private push(op: Op): void {
		this.ops.push(op)
		this.recompute()
	}

	private drop(op: Op): void {
		this.ops = this.ops.filter(o => o.seq !== op.seq)
		this.recompute()
	}

	private recompute(): void {
		this.update(s => ({
			...s,
			items: applyOps(this.base, this.ops, this.clock()),
		}))
	}

	/**
	 * One write at a time (each needs the latest revision). A conflict (someone else changed the
	 * data) refetches and retries once; any other refusal rolls the change back.
	 */
	private run<R>(
		op: Op,
		write: (
			token: ExpectedToken,
		) => Promise<{ dto: OperatorDataWriteDto | null; result: R }>,
	): Promise<R> {
		const task = this.queue.then(async () => {
			try {
				if (!this.get().token) await this.load()
				let attempt = 0
				for (;;) {
					const token = this.get().token
					if (!token)
						throw new ApiError({
							status: 503,
							code: "OPERATOR_DATA_UNAVAILABLE",
							message: "Saved frequencies are not available on this WaveKit.",
							body: null,
							method: "",
							path: "/api/operator-data",
						})
					try {
						const { dto, result } = await write(token)
						// leave the op in place until the snapshot that contains it is shown
						this.ops = this.ops.filter(o => o.seq !== op.seq)
						if (!dto || !this.accept(dto)) this.recompute()
						this.clearError()
						return result
					} catch (error) {
						if (codeOf(error) === "OPERATOR_DATA_CONFLICT" && attempt === 0) {
							attempt += 1
							await this.fetch()
							continue
						}
						throw error
					}
				}
			} catch (error) {
				this.drop(op)
				this.update(s => ({ ...s, error: errorMessage(error) }))
				throw error
			}
		})
		this.queue = task.catch(() => undefined)
		return task
	}
}
