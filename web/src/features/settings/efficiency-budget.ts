import { z } from "zod/v4"
import type {
	EfficiencyBudgetSettings,
	EfficiencyBudgetValue,
} from "@wavekit/api-types"

import type { ApiClient } from "../../data/api-client.ts"
import { ApiError, errorMessage, validated } from "../../data/api-client.ts"
import { failedWrite, WRITE_OK } from "../../data/setting-write.ts"
import type { SettingWriteResult } from "../../data/setting-write.ts"
import { Store } from "../../data/store.ts"
import type { ReadableStore } from "../../data/store.ts"
import type { AccessStoreState } from "../../data/index.ts"

const cores = z.number().positive().max(64)
const resolution = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("auto"),
		cpus: z.number().positive(),
		cores,
		label: z.string(),
	}),
	z.object({
		mode: z.literal("configured"),
		cores,
		label: z.literal("configured"),
	}),
])
const settings = z.object({
	cpuBudgetCores: z.union([z.literal("auto"), cores]),
	resolved: resolution,
})
const efficiency = z.object({
	budgetCores: cores,
	budget: resolution,
	sources: z.array(z.object({ coresInUse: z.number().nonnegative() })),
})
const ROUTE = "/api/decoders/efficiency/budget"
const VIEW = "/api/decoders/efficiency"

export interface EfficiencyBudgetState {
	settings: EfficiencyBudgetSettings | null
	used: number | null
	error: string | null
	usageError: string | null
	denied: string | null
	busy: boolean
}

export const EMPTY_BUDGET: EfficiencyBudgetState = {
	settings: null,
	used: null,
	error: null,
	usageError: null,
	denied: null,
	busy: false,
}

/** Settings-only data, using the same authenticated client and write result as other rows. */
export class EfficiencyBudgetStore extends Store<EfficiencyBudgetState> {
	private inflight: Promise<void> | null = null
	private revision = 0
	private accessRevision = 0

	constructor(private readonly api: ApiClient) {
		super(EMPTY_BUDGET)
	}

	/** A denial belongs to the access/session context in which the write started. */
	followAccess(access: ReadableStore<AccessStoreState>): () => void {
		return access.subscribe((next, previous) => {
			if (next.access === previous.access && next.session === previous.session)
				return
			this.accessRevision++
			this.update(s => ({
				...s,
				error: s.denied === null ? s.error : null,
				denied: null,
			}))
		})
	}

	load(): Promise<void> {
		if (this.get().busy) return Promise.resolve()
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	private async fetch(): Promise<void> {
		const revision = this.revision
		await Promise.all([
			(async () => {
				try {
					const value = validated(
						settings,
						await this.api.get<unknown>(ROUTE),
						"GET",
						ROUTE,
					)
					if (revision === this.revision)
						this.update(s => ({ ...s, settings: value, error: null }))
				} catch (error) {
					if (revision === this.revision)
						this.update(s => ({ ...s, error: errorMessage(error) }))
				}
			})(),
			(async () => {
				try {
					const view = validated(
						efficiency,
						await this.api.get<unknown>(VIEW),
						"GET",
						VIEW,
					)
					if (revision === this.revision)
						this.update(s => ({
							...s,
							used: view.sources.reduce(
								(sum, source) => sum + source.coresInUse,
								0,
							),
							usageError: null,
						}))
				} catch (error) {
					if (revision === this.revision)
						this.update(s => ({
							...s,
							used: null,
							usageError: errorMessage(error),
						}))
				}
			})(),
		])
	}

	async save(value: EfficiencyBudgetValue): Promise<SettingWriteResult> {
		if (this.get().busy)
			return { ok: false, message: "A budget change is being saved" }
		this.revision++
		const accessRevision = this.accessRevision
		this.update(s => ({ ...s, busy: true }))
		try {
			const result = validated(
				settings,
				await this.api.put<unknown>(ROUTE, { cpuBudgetCores: value }),
				"PUT",
				ROUTE,
			)
			this.update(s => ({ ...s, settings: result, error: null, denied: null }))
			return WRITE_OK
		} catch (error) {
			const message = errorMessage(error)
			const denied =
				error instanceof ApiError &&
				(error.status === 401 || error.status === 403)
			this.update(s => ({
				...s,
				error:
					denied && accessRevision !== this.accessRevision ? s.error : message,
				denied:
					denied && accessRevision === this.accessRevision ? message : s.denied,
			}))
			return failedWrite(error)
		} finally {
			this.update(s => ({ ...s, busy: false }))
		}
	}
}
