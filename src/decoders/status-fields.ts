/**
 * Decoder status fields derived from config and manager state
 * (CLI-COORDINATION requests 2-4). Pure helpers so DecoderManager only wires them.
 */

import { z } from "zod"
import { DECODER_LAST_ERROR_MAX_LENGTH } from "@wavekit/api-types"
import type {
	DecoderBandRequirements,
	DecoderCaps,
	DecoderConfig,
	DecoderLastError,
	DecoderStatus,
} from "./types.js"

export { DECODER_LAST_ERROR_MAX_LENGTH } from "@wavekit/api-types"

const FrequencyHz = z.number().finite().positive()
const FrequencyList = z.array(FrequencyHz).min(1)
const DeviceSerial = z.string().min(1)

/** Bounds a message to DECODER_LAST_ERROR_MAX_LENGTH, marking truncation with "…". */
export function boundDecoderErrorMessage(message: string): string {
	if (message.length <= DECODER_LAST_ERROR_MAX_LENGTH) return message
	let head = message.slice(0, DECODER_LAST_ERROR_MAX_LENGTH - 1)
	// Never leave half of a surrogate pair (e.g. an emoji) at the cut.
	if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
	return `${head}…`
}

/** Normalizes any thrown/emitted value into a bounded, timestamped DecoderLastError. */
export function createDecoderLastError(
	error: unknown,
	kind: DecoderLastError["kind"],
	at: Date = new Date(),
): DecoderLastError {
	const message =
		error instanceof Error ? error.message || error.name : String(error)
	return { kind, message: boundDecoderErrorMessage(message), at }
}

/** Describes an exit the manager did not request. */
export function createDecoderExitError(
	code: number | null,
	signal: string | null,
	at: Date = new Date(),
): DecoderLastError {
	const detail = [
		...(code !== null ? [`code ${code}`] : []),
		...(signal !== null ? [`signal ${signal}`] : []),
	].join(", ")
	return createDecoderLastError(
		`Process exited unexpectedly${detail ? ` (${detail})` : ""}`,
		"exit",
		at,
	)
}

/**
 * Target frequencies declared in config: top-level `frequencies`, else
 * `options.frequencies`, else `options.frequency`. Invalid values yield undefined;
 * built-in decoder defaults are deliberately not reported.
 */
export function resolveDecoderTargetFrequencies(
	config: DecoderConfig,
): number[] | undefined {
	const candidates: unknown[] = [
		config.frequencies,
		config.options["frequencies"],
		config.options["frequency"] === undefined
			? undefined
			: [config.options["frequency"]],
	]
	for (const candidate of candidates) {
		if (candidate === undefined) continue
		const parsed = FrequencyList.safeParse(candidate)
		return parsed.success ? parsed.data : undefined
	}
	return undefined
}

/**
 * Band declaration for a pipeline centred on the capture centre: the
 * configured target frequencies, else unknown (built-in defaults never count).
 */
export function configuredBandRequirements(
	config: DecoderConfig,
): DecoderBandRequirements | undefined {
	const targetsHz = resolveDecoderTargetFrequencies(config)
	return targetsHz ? { targetsHz, basis: "configured" } : undefined
}

/**
 * Status fields owned by the manager rather than the decoder process.
 * External-input decoders own their device, so they never report a sourceId;
 * their only ownership hint is a configured device serial.
 */
export function describeDecoderStatusFields(input: {
	config: DecoderConfig
	caps: DecoderCaps
	assignedSourceId: string | null
	lastError: DecoderLastError | null
	idleTimeoutMs: number
}): Pick<
	DecoderStatus,
	| "sourceId"
	| "deviceSerial"
	| "targetFrequenciesHz"
	| "lastError"
	| "idleTimeoutMs"
> {
	const { config, caps, assignedSourceId, lastError, idleTimeoutMs } = input
	const external = caps.input === "external"
	const sourceId = external ? undefined : (assignedSourceId ?? config.sourceId)
	const serial = DeviceSerial.safeParse(
		config.deviceSerial ?? config.options["deviceSerial"],
	)
	const targetFrequenciesHz = resolveDecoderTargetFrequencies(config)
	return {
		...(sourceId !== undefined ? { sourceId } : {}),
		...(external && serial.success ? { deviceSerial: serial.data } : {}),
		...(targetFrequenciesHz ? { targetFrequenciesHz } : {}),
		...(lastError ? { lastError } : {}),
		idleTimeoutMs,
	}
}
