/**
 * WG8 lane ST: the live decoder settings service (docs/specs/web-gaps-8, requirements 1 and 2,
 * design "Decoder settings (lane ST)", Service).
 */
import type {
	DecoderSettingValue,
	DecoderSettingsUpdateResult,
	DecoderSettingsView,
} from "@wavekit/api-types"
import {
	DECODER_SETTINGS_MAX_DECODERS,
	DECODER_SETTINGS_MAX_KEYS,
} from "@wavekit/api-types"
import { createComponentLogger } from "../../utils/logger.js"
import { decoderOptionDescriptors } from "../options/index.js"
import type { DecoderConfig } from "../types.js"
import {
	DECODER_SETTINGS_SCHEMA_VERSION,
	DecoderSettingsError,
} from "./contract.js"
import type {
	DecoderOverride,
	DecoderSettingsFile,
	DecoderSettingsManagerPort,
	DecoderSettingsService,
	DecoderSettingsServiceOptions,
} from "./contract.js"
import { buildDecoderSettingsView, effectiveDecoderConfig } from "./layers.js"
import { sanitizeStoredOptions, validateDecoderPatch } from "./patch-policy.js"
import { openDecoderSettingsStore } from "./store.js"

const UNAVAILABLE_TEXT = "Decoder settings store is unavailable"
const LIMIT_TEXT = "Decoder settings exceed the store bounds"

export type OpenedDecoderSettingsService = DecoderSettingsService & {
	/** Main sets the manager port once the DecoderManager exists. */
	setManager(port: DecoderSettingsManagerPort): void
}

function unavailable(): DecoderSettingsError {
	return new DecoderSettingsError(
		"DECODER_SETTINGS_STORE_UNAVAILABLE",
		UNAVAILABLE_TEXT,
	)
}

/** Deep equality of two option values (absent = undefined). */
function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
	return Object.is(a, b)
}

function optionValue(
	options: Readonly<Record<string, unknown>>,
	key: string,
): unknown {
	return Object.hasOwn(options, key) ? options[key] : undefined
}

export async function openDecoderSettingsService(
	options: DecoderSettingsServiceOptions,
): Promise<OpenedDecoderSettingsService> {
	const log = createComponentLogger(options.logger, "DecoderSettings")
	const now = options.now ?? Date.now
	const store = await openDecoderSettingsStore({
		stateDir: options.stateDir,
		logger: options.logger,
		now,
	})
	let manager = options.manager

	// Configured entries by id; the first entry of a repeated id wins (the manager does the same).
	const configured = new Map<string, DecoderConfig>()
	for (const config of options.configs)
		if (!configured.has(config.id)) configured.set(config.id, config)

	// Applied entries (configured id, same type), patch policy re-checked; in memory only.
	const applied = new Map<string, DecoderOverride>()
	let orphans = 0
	let retyped = 0
	let dropped = 0
	const loaded = store.snapshot()
	for (const id of Object.keys(loaded.decoders)) {
		const entry = loaded.decoders[id]
		if (entry === undefined) continue
		const config = configured.get(id)
		if (config === undefined) {
			orphans += 1
			continue
		}
		if (config.type !== entry.type) {
			retyped += 1
			continue
		}
		const sanitized = sanitizeStoredOptions(entry.type, entry.options)
		dropped += sanitized.dropped
		applied.set(id, { ...entry, options: sanitized.options })
	}
	const entries = Object.keys(loaded.decoders).length
	if (entries > 0)
		log.info(
			{ entries, applied: applied.size, orphans, retyped },
			"Decoder settings overrides loaded",
		)
	if (orphans > 0 || retyped > 0)
		log.warn(
			{ orphans, retyped },
			"Decoder settings entries ignored (decoder not configured or type changed)",
		)
	if (dropped > 0)
		log.warn(
			{ dropped },
			"Decoder settings stored options dropped (no longer patchable or valid)",
		)

	let chain: Promise<unknown> = Promise.resolve()

	const probeOwned = (id: string): boolean =>
		manager?.getStatus(id)?.owner === "scanner"

	const storedRetyped = (id: string, config: DecoderConfig): boolean => {
		const entry = store.snapshot().decoders[id]
		return entry !== undefined && entry.type !== config.type
	}

	const viewOf = (
		id: string,
		config: DecoderConfig,
		pendingRestart: boolean,
	): DecoderSettingsView =>
		buildDecoderSettingsView({
			config,
			override: applied.get(id),
			overrideIgnored: storedRetyped(id, config),
			revision: store.revision(),
			pendingRestart,
		})

	const runUpdate = async (
		id: string,
		body: unknown,
		ifMatch: number | undefined,
	): Promise<DecoderSettingsUpdateResult> => {
		const port = manager
		const config = configured.get(id)
		if (port === undefined || config === undefined || probeOwned(id))
			throw unavailable()
		if (ifMatch !== undefined && ifMatch !== store.revision())
			throw new DecoderSettingsError(
				"DECODER_SETTINGS_REVISION_MISMATCH",
				"Decoder settings revision does not match",
			)
		const patch = validateDecoderPatch(config.type, config.options, body)

		// A retyped stored entry is replaced: the patch starts from empty.
		const previous = applied.get(id)
		const nextOptions: Record<string, DecoderSettingValue> = {
			...(previous?.options ?? {}),
		}
		let nextEnabled = previous?.enabled
		if (patch.enabled !== undefined)
			nextEnabled = patch.enabled === null ? undefined : patch.enabled
		const patchKeys = Object.keys(patch.options)
		for (const key of patchKeys) {
			const value = patch.options[key]
			if (value === null || value === undefined) delete nextOptions[key]
			else nextOptions[key] = value
		}

		const current = store.snapshot()
		const decoders: Record<string, DecoderOverride> = {
			...current.decoders,
		}
		let nextEntry: DecoderOverride | undefined
		if (Object.keys(nextOptions).length === 0 && nextEnabled === undefined) {
			delete decoders[id]
		} else {
			nextEntry = {
				type: config.type,
				...(nextEnabled !== undefined ? { enabled: nextEnabled } : {}),
				options: nextOptions,
				updatedAt: new Date(now()).toISOString(),
			}
			decoders[id] = nextEntry
		}
		if (
			Object.keys(decoders).length > DECODER_SETTINGS_MAX_DECODERS ||
			Object.keys(nextOptions).length > DECODER_SETTINGS_MAX_KEYS
		)
			throw new DecoderSettingsError("DECODER_SETTINGS_LIMIT", LIMIT_TEXT)

		const next: DecoderSettingsFile = {
			schemaVersion: DECODER_SETTINGS_SCHEMA_VERSION,
			revision: current.revision + 1,
			decoders,
		}
		// Throws without changing the store; nothing below has run yet.
		await store.write(next)

		const before = effectiveDecoderConfig(config, previous)
		if (nextEntry === undefined) applied.delete(id)
		else applied.set(id, nextEntry)
		const after = effectiveDecoderConfig(config, nextEntry)

		let staged = false
		if (patchKeys.length > 0) {
			const values: Record<string, DecoderSettingValue | null> = {}
			for (const key of patchKeys) {
				const value = Object.hasOwn(nextOptions, key)
					? nextOptions[key]
					: optionValue(config.options, key)
				values[key] =
					value === undefined ? null : (value as DecoderSettingValue)
			}
			staged = port.stageDecoderOptions(id, values)
		}

		const changed: string[] = []
		if (before.enabled !== after.enabled) changed.push("enabled")
		const order = (decoderOptionDescriptors(config.type) ?? []).map(d => d.key)
		const touched = new Set(patchKeys)
		for (const key of order) {
			if (!touched.has(key)) continue
			if (
				!sameValue(
					optionValue(before.options, key),
					optionValue(after.options, key),
				)
			)
				changed.push(key)
		}

		const pendingRestart = staged || port.isRestartPending(id)
		return {
			settings: viewOf(id, config, pendingRestart),
			revision: store.revision(),
			changed,
			pendingRestart,
		}
	}

	return {
		setManager(port: DecoderSettingsManagerPort): void {
			manager = port
		},
		revision: () => store.revision(),
		view(id: string): DecoderSettingsView | undefined {
			const config = configured.get(id)
			if (config === undefined || probeOwned(id)) return undefined
			return viewOf(id, config, manager?.isRestartPending(id) ?? false)
		},
		update(id, body, opts) {
			const result = chain.then(() => runUpdate(id, body, opts?.ifMatch))
			chain = result.then(
				() => undefined,
				() => undefined,
			)
			return result
		},
		effectiveConfig(config: DecoderConfig): DecoderConfig {
			const entry = applied.get(config.id)
			return effectiveDecoderConfig(
				config,
				entry !== undefined && entry.type === config.type ? entry : undefined,
			)
		},
		ignored: () => ({ orphans, retyped }),
		close: () => store.close(),
	}
}
