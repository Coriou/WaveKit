/**
 * WG8 frozen contract for lanes ST and DP (docs/specs/web-gaps-8, requirements 1 to 3, design
 * "Decoder settings"). Read-only for the lanes: ST implements the store, layers, patch policy and
 * service against these names; DP implements the manager port and the routes against them; Main
 * composes them in src/index.ts and src/api/server.ts.
 */
import type {
	DecoderSettingValue,
	DecoderSettingsErrorBody,
	DecoderSettingsErrorCode,
	DecoderSettingsUpdateResult,
	DecoderSettingsView,
	DecoderOptionIssue,
	DecoderStatus,
} from "@wavekit/api-types"
import { DECODER_SETTINGS_ERROR_STATUS } from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import type { Logger } from "../../utils/logger.js"
import type { DecoderConfig } from "../types.js"

export const DECODER_SETTINGS_SCHEMA_VERSION = 1

/** One stored entry (keyed by decoder id; `type` must equal the configured type to apply). */
export interface DecoderOverride {
	readonly type: string
	readonly enabled?: boolean
	/** Only patchable keys; at most DECODER_SETTINGS_MAX_KEYS. */
	readonly options: Readonly<Record<string, DecoderSettingValue>>
	/** ISO time of the last write of this entry. */
	readonly updatedAt: string
}

/** `<stateDir>/decoder-settings.json`. */
export interface DecoderSettingsFile {
	schemaVersion: typeof DECODER_SETTINGS_SCHEMA_VERSION
	/** Increments by one per successful write; 0 is "no file". */
	revision: number
	decoders: Record<string, DecoderOverride>
}

/**
 * What the settings service needs from the DecoderManager (lane DP adds the two staging
 * methods; `getStatus` exists). The service stages the EFFECTIVE value of each patchable key it
 * touched (override, else configured value); `null` means neither sets it, so the key is
 * removed. Staged values replace the named option keys of the instance's current configuration
 * at its next start; other keys (digital-voice preparation included) are kept.
 */
export interface DecoderSettingsManagerPort {
	getStatus(id: string): DecoderStatus | undefined
	/** Stages patchable option values and returns `pendingRestart`. Unknown id: false. */
	stageDecoderOptions(
		id: string,
		options: Readonly<Record<string, DecoderSettingValue | null>>,
	): boolean
	/** True while the instance does not yet run with its staged options. */
	isRestartPending(id: string): boolean
}

/** Live decoder settings (lane ST, `src/decoders/settings/service.ts`). */
export interface DecoderSettingsService {
	/** Store revision (one counter for the file). */
	revision(): number
	/** The view of a configured decoder; undefined for unknown ids and scanner probes. */
	view(id: string): DecoderSettingsView | undefined
	/**
	 * Validates (patch policy), persists (tmp + fsync + rename), then stages on the manager.
	 * Writes are serialised. Throws DecoderSettingsError without changing state. `body` is the
	 * raw request body (unknown shape until validated).
	 */
	update(
		id: string,
		body: unknown,
		options?: { ifMatch?: number },
	): Promise<DecoderSettingsUpdateResult>
	/**
	 * The configuration a decoder is created with at boot: the configured entry with the
	 * override applied (`enabled` and options). Never mutates `config`.
	 */
	effectiveConfig(config: DecoderConfig): DecoderConfig
	/** Orphan and retyped entries seen at load (counts only). */
	ignored(): { orphans: number; retyped: number }
	close(): Promise<void>
}

/** What `openDecoderSettingsService` (lane ST) accepts. */
export interface DecoderSettingsServiceOptions {
	/** The configured decoders (YAML with env overrides): the config layer. Never mutated. */
	configs: readonly DecoderConfig[]
	stateDir: string
	logger: Logger
	/** Set by Main once the manager exists; until then `update` answers STORE_UNAVAILABLE. */
	manager?: DecoderSettingsManagerPort
	now?: () => number
}

const ERROR_BY_STATUS: Readonly<Record<number, string>> = {
	400: "Bad Request",
	412: "Precondition Failed",
	413: "Payload Too Large",
	503: "Service Unavailable",
}

/** A rejected settings update (400, 412, 413, 503); state is unchanged when thrown. */
export class DecoderSettingsError extends WaveKitError {
	readonly statusCode: number
	declare readonly code: DecoderSettingsErrorCode
	readonly issues?: DecoderOptionIssue[]
	readonly keys?: string[]
	readonly unknownKeys?: number

	constructor(
		code: DecoderSettingsErrorCode,
		message: string,
		detail: {
			issues?: DecoderOptionIssue[]
			keys?: string[]
			unknownKeys?: number
		} = {},
		cause?: Error,
	) {
		super(message, code, cause)
		this.name = "DecoderSettingsError"
		this.statusCode = DECODER_SETTINGS_ERROR_STATUS[code]
		if (detail.issues !== undefined) this.issues = detail.issues
		if (detail.keys !== undefined) this.keys = detail.keys
		if (detail.unknownKeys !== undefined) this.unknownKeys = detail.unknownKeys
	}

	toBody(): DecoderSettingsErrorBody {
		const body: DecoderSettingsErrorBody = {
			error: ERROR_BY_STATUS[this.statusCode] ?? "Error",
			code: this.code,
			message: this.message,
		}
		if (this.issues !== undefined)
			body.issues = this.issues.map(i => ({ ...i }))
		if (this.keys !== undefined) body.keys = [...this.keys]
		if (this.unknownKeys !== undefined) body.unknownKeys = this.unknownKeys
		return body
	}
}
