/**
 * Mock operator data: the saved-frequency routes of src/operator-data/routes.ts and the `operator-data`
 * channel (a snapshot on subscribe, `operator-data:updated` after each change). Same revision token,
 * status codes and error bodies as core (src/operator-data/transport.ts); requests are validated with
 * the core's own schemas from @wavekit/api-types. Saved frequencies and preferences
 * (`patch-preferences` with `set` / `reset`); command usage is not mocked.
 */
import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import {
	OPERATOR_DATA_ERROR_DEFINITIONS,
	OPERATOR_DATA_LIMITS,
	mutationSchema,
	preferenceKeySchema,
	snapshotSchema,
} from "@wavekit/api-types"
import type {
	OperatorDataErrorCode,
	OperatorDataErrorDto,
	OperatorDataMutation,
	OperatorDataReadDto,
	OperatorDataSnapshot,
	OperatorDataWriteDto,
	Preferences,
	SavedFrequencyInput,
} from "@wavekit/api-types"

export interface MockOperatorData {
	snapshot(): OperatorDataSnapshot
	readDto(): OperatorDataReadDto
}

export interface MockOperatorDataOptions {
	seeds: readonly SavedFrequencyInput[]
	/** Called with every committed snapshot (the server broadcasts it on `operator-data`). */
	onCommit(dto: OperatorDataReadDto): void
	now?: () => number
}

class OperatorFailure extends Error {
	readonly code: OperatorDataErrorCode
	readonly current: { storeId: string; revision: number } | undefined
	constructor(
		code: OperatorDataErrorCode,
		current?: { storeId: string; revision: number },
	) {
		super(OPERATOR_DATA_ERROR_DEFINITIONS[code][1])
		this.code = code
		this.current = current
	}
}

/** Core's PREFERENCE_DEFAULTS (src/operator-data/domain.ts). */
const PREFERENCE_DEFAULTS: Readonly<Preferences> = Object.freeze({
	units: "nautical",
	timeFormat: "local-24h",
	waterfallPalette: "phosphor",
	showSavedFrequencyLabels: true,
})

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sendFailure(reply: FastifyReply, failure: OperatorFailure) {
	const body: OperatorDataErrorDto = {
		error: "OperatorDataError",
		code: failure.code,
		message: OPERATOR_DATA_ERROR_DEFINITIONS[failure.code][1],
		...(failure.code === "OPERATOR_DATA_CONFLICT" && failure.current
			? { details: { current: failure.current } }
			: {}),
	}
	return reply.code(OPERATOR_DATA_ERROR_DEFINITIONS[failure.code][0]).send(body)
}

export function registerOperatorData(
	app: FastifyInstance,
	options: MockOperatorDataOptions,
): MockOperatorData {
	const now = options.now ?? Date.now
	const seededAt = new Date(now() - 3 * 86_400_000).toISOString()
	let snapshot: OperatorDataSnapshot = {
		version: 1,
		storeId: randomUUID(),
		revision: options.seeds.length,
		savedFrequencies: options.seeds.map(seed => ({
			...seed,
			id: randomUUID(),
			createdAt: seededAt,
			updatedAt: seededAt,
		})),
		preferenceOverrides: {},
		commandUsage: [],
	}

	const provenanceOf = (key: keyof Preferences) =>
		Object.hasOwn(snapshot.preferenceOverrides, key)
			? ("operator" as const)
			: ("default" as const)

	const readDto = (): OperatorDataReadDto => ({
		snapshot: structuredClone(snapshot),
		preferences: {
			values: { ...PREFERENCE_DEFAULTS, ...snapshot.preferenceOverrides },
			provenance: {
				units: provenanceOf("units"),
				timeFormat: provenanceOf("timeFormat"),
				waterfallPalette: provenanceOf("waterfallPalette"),
				showSavedFrequencyLabels: provenanceOf("showSavedFrequencyLabels"),
			},
		},
		capabilities: {
			toneSelection: true,
			toneDetection: false,
			toneSquelch: false,
		},
		limits: { ...OPERATOR_DATA_LIMITS },
	})

	/** Core's route parsing: only the allowed body keys, `expected` required, then the mutation schema. */
	const parse = (
		type: OperatorDataMutation["type"],
		body: unknown,
		keys: readonly string[],
		id?: string,
	): OperatorDataMutation => {
		if (!isRecord(body) || Object.keys(body).some(k => !keys.includes(k)))
			throw new OperatorFailure("OPERATOR_DATA_INVALID")
		if (body["expected"] === undefined)
			throw new OperatorFailure("OPERATOR_DATA_PRECONDITION_REQUIRED")
		const input: Record<string, unknown> = { type }
		for (const key of keys) if (Object.hasOwn(body, key)) input[key] = body[key]
		if (id !== undefined) input["id"] = id
		const result = mutationSchema.safeParse(input)
		if (!result.success) throw new OperatorFailure("OPERATOR_DATA_INVALID")
		return result.data
	}

	const apply = (mutation: OperatorDataMutation): OperatorDataWriteDto => {
		if (
			mutation.expected.storeId !== snapshot.storeId ||
			mutation.expected.revision !== snapshot.revision
		)
			throw new OperatorFailure("OPERATOR_DATA_CONFLICT", {
				storeId: snapshot.storeId,
				revision: snapshot.revision,
			})
		const next = structuredClone(snapshot)
		const time = new Date(now()).toISOString()
		let savedFrequencyId: string | undefined
		let changed = true
		if (mutation.type === "create-saved-frequency") {
			if (next.savedFrequencies.length >= OPERATOR_DATA_LIMITS.savedFrequencies)
				throw new OperatorFailure("OPERATOR_DATA_QUOTA")
			savedFrequencyId = randomUUID()
			next.savedFrequencies.push({
				...mutation.frequency,
				id: savedFrequencyId,
				createdAt: time,
				updatedAt: time,
			})
		} else if (mutation.type === "replace-saved-frequency") {
			const index = next.savedFrequencies.findIndex(f => f.id === mutation.id)
			const previous = next.savedFrequencies[index]
			if (!previous) throw new OperatorFailure("OPERATOR_DATA_NOT_FOUND")
			const replaced = {
				...mutation.frequency,
				id: previous.id,
				createdAt: previous.createdAt,
				updatedAt: previous.updatedAt,
			}
			changed = JSON.stringify(replaced) !== JSON.stringify(previous)
			if (changed)
				next.savedFrequencies[index] = { ...replaced, updatedAt: time }
		} else if (mutation.type === "delete-saved-frequency") {
			if (!next.savedFrequencies.some(f => f.id === mutation.id))
				throw new OperatorFailure("OPERATOR_DATA_NOT_FOUND")
			next.savedFrequencies = next.savedFrequencies.filter(
				f => f.id !== mutation.id,
			)
		} else if (mutation.type === "patch-preferences") {
			// Core's domain: reset removes overrides, set assigns them; unchanged values keep the revision.
			changed = false
			const overrides = next.preferenceOverrides
			for (const key of mutation.reset ?? [])
				if (Object.hasOwn(overrides, key)) {
					delete overrides[key]
					changed = true
				}
			for (const key of preferenceKeySchema.options)
				if (
					mutation.set &&
					Object.hasOwn(mutation.set, key) &&
					overrides[key] !== mutation.set[key]
				) {
					Object.assign(overrides, { [key]: mutation.set[key] })
					changed = true
				}
		} else throw new OperatorFailure("OPERATOR_DATA_INVALID")
		if (changed) next.revision += 1
		const valid = snapshotSchema.safeParse(next)
		if (!valid.success) throw new OperatorFailure("OPERATOR_DATA_INVALID")
		snapshot = valid.data
		if (changed) options.onCommit(readDto())
		return {
			snapshot: structuredClone(snapshot),
			...(savedFrequencyId ? { savedFrequencyId } : {}),
		}
	}

	const handle = (
		reply: FastifyReply,
		status: 200 | 201,
		run: () => OperatorDataWriteDto,
	) => {
		try {
			return reply.code(status).send(run())
		} catch (error) {
			if (error instanceof OperatorFailure) return sendFailure(reply, error)
			throw error
		}
	}

	const idOf = (params: unknown): string =>
		isRecord(params) && typeof params["id"] === "string" ? params["id"] : ""

	app.get("/api/operator-data", async () => readDto())
	app.post("/api/operator-data/saved-frequencies", async (request, reply) =>
		handle(reply, 201, () =>
			apply(
				parse("create-saved-frequency", request.body, [
					"expected",
					"frequency",
				]),
			),
		),
	)
	app.put("/api/operator-data/saved-frequencies/:id", async (request, reply) =>
		handle(reply, 200, () =>
			apply(
				parse(
					"replace-saved-frequency",
					request.body,
					["expected", "frequency"],
					idOf(request.params),
				),
			),
		),
	)
	app.delete(
		"/api/operator-data/saved-frequencies/:id",
		async (request, reply) =>
			handle(reply, 200, () =>
				apply(
					parse(
						"delete-saved-frequency",
						request.body,
						["expected"],
						idOf(request.params),
					),
				),
			),
	)

	app.patch("/api/operator-data/preferences", async (request, reply) =>
		handle(reply, 200, () =>
			apply(
				parse("patch-preferences", request.body, ["expected", "set", "reset"]),
			),
		),
	)

	return { snapshot: () => structuredClone(snapshot), readDto }
}
