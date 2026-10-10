import {
	OPERATOR_DATA_LIMITS,
	OperatorDataError,
	commandUsageKey,
	commandUsageSchema,
	compareCommandUsage,
	parseMutation,
	preferenceKeySchema,
	timestampSchema,
	uuidSchema,
	validateSnapshot,
} from "./schema.js"
import type {
	ExpectedToken,
	OperatorDataMutation,
	OperatorDataSnapshot,
	PreferenceKey,
	Preferences,
	SavedFrequencyInput,
} from "./schema.js"

export {
	OperatorDataError,
	validateSnapshot,
	encodeSnapshot,
	parseMutation,
} from "./schema.js"
export const PREFERENCE_DEFAULTS: Readonly<Preferences> = Object.freeze({
	units: "nautical",
	timeFormat: "local-24h",
	waterfallPalette: "phosphor",
	showSavedFrequencyLabels: true,
})
export function effectivePreferences(snapshot: OperatorDataSnapshot): {
	values: Preferences
	provenance: Record<PreferenceKey, "default" | "operator">
} {
	const overrides = validateSnapshot(snapshot).preferenceOverrides
	const provenance = {} as Record<PreferenceKey, "default" | "operator">
	for (const key of preferenceKeySchema.options)
		provenance[key] = Object.hasOwn(overrides, key) ? "operator" : "default"
	return { values: { ...PREFERENCE_DEFAULTS, ...overrides }, provenance }
}
export function createEmptySnapshot(storeId: string): OperatorDataSnapshot {
	return validateSnapshot({
		version: 1,
		storeId,
		revision: 0,
		savedFrequencies: [],
		preferenceOverrides: {},
		commandUsage: [],
	})
}
export function snapshotToken(snapshot: OperatorDataSnapshot): ExpectedToken {
	return { storeId: snapshot.storeId, revision: snapshot.revision }
}
export interface DomainContext {
	/** Return an ISO UTC wall-clock timestamp. Called only when a timestamp is needed. */
	now(): string
	/** Core supplies crypto.randomUUID; request bodies cannot select an ID. */
	uuid(): string
}
export interface TransitionResult {
	snapshot: OperatorDataSnapshot
	changed: boolean
	savedFrequencyId?: string
}
function serverTime(context: DomainContext, floors: string[] = []): string {
	const result = timestampSchema.safeParse(context.now())
	if (!result.success) throw new OperatorDataError("OPERATOR_DATA_INVALID")
	return new Date(
		Math.max(
			Date.parse(result.data),
			...floors.map(value => Date.parse(value)),
		),
	).toISOString()
}
function sameFrequency(
	a: SavedFrequencyInput,
	b: SavedFrequencyInput,
): boolean {
	return (
		a.name === b.name &&
		a.frequencyHz === b.frequencyHz &&
		a.mode === b.mode &&
		a.bandwidthHz === b.bandwidthHz &&
		a.group === b.group &&
		JSON.stringify(a.tone) === JSON.stringify(b.tone)
	)
}
/** Pure proposal only: the service must serialize CAS and persist before committing. */
export function transition(
	snapshot: OperatorDataSnapshot,
	input: OperatorDataMutation,
	context: DomainContext,
): TransitionResult {
	const next = validateSnapshot(snapshot)
	const mutation = parseMutation(input)
	if (
		mutation.expected.storeId !== next.storeId ||
		mutation.expected.revision !== next.revision
	)
		throw new OperatorDataError("OPERATOR_DATA_CONFLICT", snapshotToken(next))
	let changed = false
	let savedFrequencyId: string | undefined
	switch (mutation.type) {
		case "create-saved-frequency": {
			if (next.savedFrequencies.length >= OPERATOR_DATA_LIMITS.savedFrequencies)
				throw new OperatorDataError("OPERATOR_DATA_QUOTA")
			const id = uuidSchema.safeParse(context.uuid())
			if (
				!id.success ||
				id.data === next.storeId ||
				next.savedFrequencies.some(frequency => frequency.id === id.data)
			)
				throw new OperatorDataError("OPERATOR_DATA_INVALID")
			const time = serverTime(context)
			next.savedFrequencies.push({
				...mutation.frequency,
				id: id.data,
				createdAt: time,
				updatedAt: time,
			})
			savedFrequencyId = id.data
			changed = true
			break
		}
		case "replace-saved-frequency": {
			const index = next.savedFrequencies.findIndex(
				frequency => frequency.id === mutation.id,
			)
			const previous = next.savedFrequencies[index]
			if (!previous) throw new OperatorDataError("OPERATOR_DATA_NOT_FOUND")
			if (!sameFrequency(previous, mutation.frequency)) {
				next.savedFrequencies[index] = {
					...mutation.frequency,
					id: previous.id,
					createdAt: previous.createdAt,
					updatedAt: serverTime(context, [previous.updatedAt]),
				}
				changed = true
			}
			break
		}
		case "delete-saved-frequency": {
			if (
				!next.savedFrequencies.some(frequency => frequency.id === mutation.id)
			)
				throw new OperatorDataError("OPERATOR_DATA_NOT_FOUND")
			next.savedFrequencies = next.savedFrequencies.filter(
				frequency => frequency.id !== mutation.id,
			)
			next.commandUsage = next.commandUsage.filter(
				usage => usage.savedFrequencyId !== mutation.id,
			)
			changed = true
			break
		}
		case "patch-preferences": {
			for (const key of mutation.reset ?? []) {
				if (Object.hasOwn(next.preferenceOverrides, key)) {
					delete next.preferenceOverrides[key]
					changed = true
				}
			}
			for (const key of preferenceKeySchema.options) {
				if (
					Object.hasOwn(mutation.set ?? {}, key) &&
					next.preferenceOverrides[key] !== mutation.set?.[key]
				) {
					// Assign through the validated closed object to preserve each key's value type.
					Object.assign(next.preferenceOverrides, {
						[key]: mutation.set?.[key],
					})
					changed = true
				}
			}
			break
		}
		case "report-command-usage": {
			const preset = next.savedFrequencies.find(
				frequency => frequency.id === mutation.savedFrequencyId,
			)
			if (mutation.savedFrequencyId && !preset)
				throw new OperatorDataError("OPERATOR_DATA_NOT_FOUND")
			const key = commandUsageKey(mutation)
			const previous = next.commandUsage.find(
				usage => commandUsageKey(usage) === key,
			)
			const floors = [
				...(previous ? [previous.lastUsedAt] : []),
				...(preset ? [preset.createdAt] : []),
			]
			next.commandUsage = next.commandUsage.filter(
				usage => commandUsageKey(usage) !== key,
			)
			if (next.revision === OPERATOR_DATA_LIMITS.revision)
				throw new OperatorDataError("OPERATOR_DATA_QUOTA")
			const usage = commandUsageSchema.safeParse({
				command: mutation.command,
				...(mutation.savedFrequencyId
					? { savedFrequencyId: mutation.savedFrequencyId }
					: {}),
				count: Math.min(
					(previous?.count ?? 0) + 1,
					OPERATOR_DATA_LIMITS.usageCount,
				),
				lastUsedAt: serverTime(context, floors),
				lastUsedRevision: next.revision + 1,
			})
			if (!usage.success) throw new OperatorDataError("OPERATOR_DATA_INVALID")
			next.commandUsage.push(usage.data)
			next.commandUsage.sort(compareCommandUsage)
			next.commandUsage = next.commandUsage.slice(
				0,
				OPERATOR_DATA_LIMITS.commandUsage,
			)
			changed = true
			break
		}
		case "reset-command-usage": {
			changed = next.commandUsage.length !== 0
			next.commandUsage = []
			break
		}
	}
	if (changed) {
		if (next.revision === OPERATOR_DATA_LIMITS.revision)
			throw new OperatorDataError("OPERATOR_DATA_QUOTA")
		next.revision += 1
	}
	return {
		snapshot: validateSnapshot(next),
		changed,
		...(savedFrequencyId ? { savedFrequencyId } : {}),
	}
}
