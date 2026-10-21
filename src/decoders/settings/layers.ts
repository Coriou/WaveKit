/**
 * WG8 lane ST: pure decoder settings layering (override > config > adapter default) and the
 * settings view (docs/specs/web-gaps-8, requirements 1.1, 1.4, 2.7; design "Layers").
 * Imported at startup: keep it free of runtime modules.
 */
import type {
	DecoderMode,
	DecoderOptionSetting,
	DecoderSettingSource,
	DecoderSettingValue,
	DecoderSettingsView,
} from "@wavekit/api-types"
import { decoderOptionDescriptors } from "../options/index.js"
import type { DecoderConfig } from "../types.js"
import type { DecoderOverride } from "./store.js"
import { resolveDecoderMode } from "../enablement/mode.js"
import type { ResolvedMode } from "../enablement/contract.js"
import { isFrequencyKeyShadowed, isPatchableOption } from "./patch-policy.js"

// The frozen decoder config type lacks the optional mode field.
export type ModeDecoderConfig = DecoderConfig & { mode?: DecoderMode }

/**
 * Mode of a configured decoder under its stored override. The view, the live apply and the
 * flattened boot config must agree. A stored enable re-enables a configured disable at boot
 * (today's behaviour), so resolution uses the enable the decoder will actually start with.
 */
export function resolveLayeredDecoderMode(
	config: ModeDecoderConfig,
	override: DecoderOverride | undefined,
): ResolvedMode {
	return resolveDecoderMode({
		settingsMode: override?.mode,
		settingsEnabled: override?.enabled,
		configMode: config.mode,
		configEnabled: override?.enabled === true ? true : config.enabled,
		configBandSuspension: config.band?.bandSuspension,
	})
}

function copyValue<T>(value: T): T {
	return (Array.isArray(value) ? [...(value as unknown[])] : value) as T
}

/**
 * The configuration a decoder runs with: a new object (options copied), `enabled` from the
 * override when it sets one, override option keys replacing the configured ones. Never
 * mutates `config`, `config.options` or the override.
 */
export function effectiveDecoderConfig(
	config: ModeDecoderConfig,
	override: DecoderOverride | undefined,
): ModeDecoderConfig {
	// Spread and defineProperty create own data properties: a configured or override
	// "__proto__" key stays data and never becomes the prototype.
	const options: Record<string, unknown> = { ...config.options }
	const out: ModeDecoderConfig = { ...config, options }
	if (override === undefined) return out
	for (const key of Object.keys(override.options))
		Object.defineProperty(options, key, {
			value: copyValue(override.options[key]),
			writable: true,
			enumerable: true,
			configurable: true,
		})
	if (override.enabled !== undefined) out.enabled = override.enabled
	if (override.mode !== undefined) out.mode = override.mode
	// A stored disable outranks a configured mode (precedence 2.2), so it must survive
	// flattening; without a configured mode the output stays as before.
	else if (override.enabled === false && out.mode !== undefined)
		out.mode = "off"
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
	config: ModeDecoderConfig
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
		// A frequency key a higher-priority source shadows is not patchable for this decoder.
		const patchable =
			isPatchableOption(config.type, d.key) &&
			!isFrequencyKeyShadowed(d.key, config.frequencies, effective.options)
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

	const resolved = resolveLayeredDecoderMode(config, override)
	const view: DecoderSettingsView = {
		mode: {
			value: resolved.mode,
			// The frozen view type uses setting-layer provenance.
			source:
				resolved.source === "settings"
					? "override"
					: resolved.source === "default"
						? "default"
						: "config",
		},
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
