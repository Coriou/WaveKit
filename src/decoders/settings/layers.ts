/**
 * WG8 lane ST: pure decoder settings layering (override > config > adapter default) and the
 * settings view (docs/specs/web-gaps-8, requirements 1.1, 1.4, 2.7; design "Layers").
 * Imported at startup: keep it free of runtime modules.
 */
import type {
	DecoderOptionSetting,
	DecoderSettingSource,
	DecoderSettingValue,
	DecoderSettingsView,
} from "@wavekit/api-types"
import { decoderOptionDescriptors } from "../options/index.js"
import type { DecoderConfig } from "../types.js"
import type { DecoderOverride } from "./contract.js"
import { isPatchableOption } from "./patch-policy.js"

function copyValue<T>(value: T): T {
	return (Array.isArray(value) ? [...(value as unknown[])] : value) as T
}

/**
 * The configuration a decoder runs with: a new object (options copied), `enabled` from the
 * override when it sets one, override option keys replacing the configured ones. Never
 * mutates `config`, `config.options` or the override.
 */
export function effectiveDecoderConfig(
	config: DecoderConfig,
	override: DecoderOverride | undefined,
): DecoderConfig {
	const options: Record<string, unknown> = {}
	for (const key of Object.keys(config.options))
		options[key] = config.options[key]
	const out: DecoderConfig = { ...config, options }
	if (override === undefined) return out
	for (const key of Object.keys(override.options))
		options[key] = copyValue(override.options[key])
	if (override.enabled !== undefined) out.enabled = override.enabled
	return out
}

function isSettingValue(value: unknown): value is DecoderSettingValue {
	if (typeof value === "boolean" || typeof value === "string") return true
	if (typeof value === "number") return Number.isFinite(value)
	if (!Array.isArray(value)) return false
	return (
		value.every(v => typeof v === "string") ||
		value.every(v => typeof v === "number" && Number.isFinite(v))
	)
}

export interface DecoderSettingsViewInput {
	config: DecoderConfig
	override: DecoderOverride | undefined
	/** The stored entry has another type (it is ignored); `override` is then not applied. */
	overrideIgnored?: boolean
	revision: number
	pendingRestart: boolean
}

/** The settings view of one configured decoder (requirement 2.7). */
export function buildDecoderSettingsView(
	input: DecoderSettingsViewInput,
): DecoderSettingsView {
	const { config } = input
	const retyped =
		input.overrideIgnored === true ||
		(input.override !== undefined && input.override.type !== config.type)
	const override = retyped ? undefined : input.override
	const effective = effectiveDecoderConfig(config, override)
	const descriptors = decoderOptionDescriptors(config.type) ?? []
	const documented = new Set(descriptors.map(d => d.key))

	const options: DecoderOptionSetting[] = descriptors.map(d => {
		const inOverride =
			override !== undefined && Object.hasOwn(override.options, d.key)
		const source: DecoderSettingSource = inOverride
			? "override"
			: Object.hasOwn(config.options, d.key)
				? "config"
				: "default"
		const present = Object.hasOwn(effective.options, d.key)
		const patchable = isPatchableOption(config.type, d.key)
		const setting: DecoderOptionSetting = {
			key: d.key,
			source,
			patchable,
			secret: d.secret,
			present,
		}
		if (patchable && !d.secret) {
			const raw = present ? effective.options[d.key] : undefined
			setting.value = isSettingValue(raw) ? copyValue(raw) : null
		}
		return setting
	})

	let undocumentedKeys = 0
	for (const key of Object.keys(config.options))
		if (!documented.has(key)) undocumentedKeys += 1

	const view: DecoderSettingsView = {
		decoderId: config.id,
		type: config.type,
		revision: input.revision,
		enabled: {
			value: effective.enabled,
			source:
				override !== undefined && override.enabled !== undefined
					? "override"
					: "config",
		},
		options,
		undocumentedKeys,
		pendingRestart: input.pendingRestart,
	}
	if (retyped) view.overrideIgnored = "type-changed"
	return view
}
