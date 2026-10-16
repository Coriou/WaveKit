/**
 * WG6 (docs/specs/web-gaps-6, requirement 7): redacted export of the effective configuration.
 * E2 is pending a user decision; the frozen behaviour is the recommended default below, each
 * part a one-constant switch.
 */

/** GET route of the export (YAML body). */
export const CONFIG_EXPORT_ROUTE = "/api/config/export"
/** Media type of the export body. */
export const CONFIG_EXPORT_CONTENT_TYPE = "application/yaml; charset=utf-8"
/** Suggested download name (Content-Disposition). */
export const CONFIG_EXPORT_FILE_NAME = "wavekit-config.redacted.yaml"
/**
 * E2 (recommended): the export route is mounted only in protected access mode and authorizes
 * every request like the other protected operator routes. false would mount it in legacy mode.
 */
export const CONFIG_EXPORT_REQUIRES_ACCESS = true
/** Replaces every redacted value, whatever its type. */
export const CONFIG_EXPORT_REDACTED = "<redacted>"
/**
 * E2 (recommended): decoder option keys whose string values are exported. Every other string
 * in `decoders[].options` (at any depth) is redacted. Numbers and booleans are kept unless the
 * key matches CONFIG_EXPORT_SECRET_KEY_PATTERN.
 */
export const CONFIG_EXPORT_OPTION_ALLOWLIST: readonly string[] = Object.freeze([
	"region",
	"preset",
	"mode",
	"modulation",
	"protocol",
	"protocols",
	"format",
	"outputFormat",
	"demod",
	"band",
])
/**
 * E2: a config key (any path segment, case-insensitive) whose value is redacted whatever its
 * type or position, decoder options included (PSKs, privacy keys, passwords, tokens).
 */
export const CONFIG_EXPORT_SECRET_KEY_PATTERN =
	/(key|psk|secret|passw|token|cred|auth|cookie|cert|salt)/i
/**
 * E2 (recommended): free-text strings outside decoder options are exported only at these paths
 * (`*` = any array index); every other string is redacted unless the config schema restricts it
 * to a closed set (enum or literal). Host names, URLs, paths, names and callsigns are redacted.
 */
export const CONFIG_EXPORT_KEPT_STRING_PATHS: readonly string[] = Object.freeze(
	[
		"sources.*.id",
		"sources.*.type",
		"decoders.*.id",
		"decoders.*.type",
		"decoders.*.sourceId",
		"tunerRelay.sourceId",
		"liveDemod.sourceId",
		"region",
		"station.country",
	],
)
/** Values redacted whatever their type (precise station position is personal data). */
export const CONFIG_EXPORT_REDACTED_PATHS: readonly string[] = Object.freeze([
	"station.lat",
	"station.lon",
	"station.altM",
])
/** Upper bound of the export body; a larger export is 500 CONFIG_EXPORT_FAILED. */
export const CONFIG_EXPORT_MAX_BYTES = 256 * 1024

export type ConfigExportErrorCode =
	| "CONFIG_EXPORT_UNAVAILABLE"
	| "CONFIG_EXPORT_FAILED"

/** Error body of the export route. */
export interface ConfigExportErrorDto {
	readonly error: "ConfigExportError"
	readonly code: ConfigExportErrorCode
	readonly message: string
}
