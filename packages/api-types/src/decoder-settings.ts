import type { DecoderOptionIssue } from "./decoders.js"

/**
 * WG8 decoder settings store and decoder PATCH (docs/specs/web-gaps-8, requirements 1 to 3).
 * A persisted override layer over the configuration, protected only, applied when the
 * decoder next starts.
 */

/**
 * WG8 req 2.1: GET /api/decoders/:id/settings and the working PATCH /api/decoders/:id mount
 * only in protected access mode. false would mount them in legacy mode too.
 */
export const DECODER_SETTINGS_REQUIRES_ACCESS = true
/** WG8 req 1.1: the override file, directly under `stateDir`. */
export const DECODER_SETTINGS_FILE_NAME = "decoder-settings.json"
/** WG8 req 1.3: bytes of the override file (256 entries of ~1 KiB each fit). */
export const DECODER_SETTINGS_FILE_MAX_BYTES = 256 * 1024
/** WG8 req 1.3: decoder entries in the override file. */
export const DECODER_SETTINGS_MAX_DECODERS = 256
/** WG8 req 1.3, 2.2: option keys per entry and per PATCH body (the largest schema has 26). */
export const DECODER_SETTINGS_MAX_KEYS = 64
/** WG8 req 2.2: bytes of a PATCH body. */
export const DECODER_SETTINGS_BODY_MAX_BYTES = 16 * 1024
/**
 * WG8 req 2.3: descriptor types a patchable key may have. `string-list` only with a closed set
 * (`enumValues`); `string` (free text) and `object` are never patchable.
 */
export const DECODER_SETTINGS_PATCHABLE_TYPES = Object.freeze([
	"boolean",
	"integer",
	"number",
	"enum",
	"string-list",
	"number-list",
] as const)

/** A value a patchable option may hold (JSON scalars and lists of the patchable types). */
export type DecoderSettingValue =
	| boolean
	| number
	| string
	| readonly string[]
	| readonly number[]

/** WG8 req 1.1: where the effective value of a setting comes from. */
export type DecoderSettingSource = "override" | "config" | "default"

/** WG8 req 2.7: one documented option key in the settings view. */
export interface DecoderOptionSetting {
	key: string
	source: DecoderSettingSource
	patchable: boolean
	secret: boolean
	/** The effective value is set (override or config); false when only a default applies. */
	present: boolean
	/** Only for a patchable, non-secret key: the effective value (null = adapter default). */
	value?: DecoderSettingValue | null
}

/** WG8 req 2.7: GET /api/decoders/:id/settings body (and `settings` of a PATCH result). */
export interface DecoderSettingsView {
	decoderId: string
	type: string
	/** Store revision (one counter for the whole file); send it as If-Match. */
	revision: number
	enabled: { value: boolean; source: DecoderSettingSource }
	/** Documented keys of the type, in descriptor order. */
	options: DecoderOptionSetting[]
	/** Configured keys the type does not document; never named. */
	undocumentedKeys: number
	/** True while the decoder instance does not yet run with the effective options. */
	pendingRestart: boolean
	/** The stored entry for this id has another type; it is ignored until a PATCH replaces it. */
	overrideIgnored?: "type-changed"
}

/**
 * WG8 req 2.2: PATCH /api/decoders/:id body, a JSON merge patch. A value sets the override,
 * null removes it, an absent key is unchanged. At least one key.
 */
export interface DecoderSettingsUpdate {
	enabled?: boolean | null
	options?: Record<string, DecoderSettingValue | null>
}

/** WG8 req 2.6: PATCH /api/decoders/:id 200 body (protected mode). */
export interface DecoderSettingsUpdateResult {
	settings: DecoderSettingsView
	revision: number
	/** Keys whose effective value changed: "enabled" first, then options in descriptor order. */
	changed: string[]
	pendingRestart: boolean
}

export type DecoderSettingsErrorCode =
	| "DECODER_OPTIONS_INVALID"
	| "DECODER_OPTION_NOT_PATCHABLE"
	| "DECODER_SETTINGS_REVISION_MISMATCH"
	| "DECODER_SETTINGS_STORE_UNAVAILABLE"
	| "DECODER_SETTINGS_LIMIT"

/** HTTP status of each settings error code. */
export const DECODER_SETTINGS_ERROR_STATUS: Readonly<
	Record<DecoderSettingsErrorCode, 400 | 412 | 413 | 503>
> = Object.freeze({
	DECODER_OPTIONS_INVALID: 400,
	DECODER_OPTION_NOT_PATCHABLE: 400,
	DECODER_SETTINGS_REVISION_MISMATCH: 412,
	DECODER_SETTINGS_STORE_UNAVAILABLE: 503,
	DECODER_SETTINGS_LIMIT: 413,
})

/**
 * WG8 decoder settings error body (400, 412, 413, 503). Never carries a submitted value. The
 * 404 DECODER_NOT_FOUND and 409 DECODER_OWNED_BY_SCANNER bodies are the existing ones.
 */
export interface DecoderSettingsErrorBody {
	error: string
	code: DecoderSettingsErrorCode
	message: string
	/** DECODER_OPTIONS_INVALID: issues of documented keys, fixed rule text only. */
	issues?: DecoderOptionIssue[]
	/** DECODER_OPTION_NOT_PATCHABLE: the documented keys refused. */
	keys?: string[]
	/** DECODER_OPTION_NOT_PATCHABLE: keys the type does not document (counted, never named). */
	unknownKeys?: number
}
