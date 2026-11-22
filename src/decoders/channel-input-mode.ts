/**
 * How a channelised decoder gets its channel: `direct` (the channel socket is the decoder's stdin; the default) or
 * `relay` (Node pipes the channel socket into the decoder's stdin). Selected once per process by
 * WAVEKIT_CHANNEL_INPUT; it has no `__`, so the config loader's WAVEKIT_ overrides never read it, and there is no
 * config key. Direct is the default because in relay mode every channel byte waits for the core's main thread: a
 * main-thread stall longer than the channel's queue drops samples there (`queue-overflow`), while a direct decoder
 * reads its socket itself. Scanner taps and scanner probe decoders keep the relay in both modes (DecoderManager).
 */
import { ZodError } from "zod"
import type { ChannelInputMode } from "../core/channelizer/types.js"
import { ConfigValidationError } from "../utils/errors.js"
import type { Logger } from "../utils/logger.js"

export const CHANNEL_INPUT_ENV = "WAVEKIT_CHANNEL_INPUT"

/** The mode when WAVEKIT_CHANNEL_INPUT is unset or empty. */
export const DEFAULT_CHANNEL_INPUT_MODE: ChannelInputMode = "direct"

/** The values WAVEKIT_CHANNEL_INPUT accepts, exactly as written. */
export const CHANNEL_INPUT_MODES: readonly ChannelInputMode[] = [
	"direct",
	"relay",
]

/**
 * The error for a value that is not accepted. It names the variable and the accepted values only: the value itself
 * is never in its message or its issues.
 */
export function unknownChannelInputModeError(): ConfigValidationError {
	return new ConfigValidationError(
		new ZodError([
			{
				code: "custom",
				path: [CHANNEL_INPUT_ENV],
				message: `Invalid value. Expected one of: ${CHANNEL_INPUT_MODES.join(", ")}`,
			},
		]),
	)
}

/**
 * `relay` and `direct` are read as given; unset and empty read as the default (direct). Any other value (another
 * case, surrounding spaces, anything else) throws a ConfigValidationError naming the accepted values: there is no
 * silent fallback.
 */
export function channelInputModeFrom(
	raw: string | undefined,
): ChannelInputMode {
	if (raw === undefined || raw === "") return DEFAULT_CHANNEL_INPUT_MODE
	if (raw === "direct" || raw === "relay") return raw
	throw unknownChannelInputModeError()
}

let processMode: ChannelInputMode | undefined

/**
 * The process's mode, read from the environment on the first call (the DecoderManager constructor, at startup): one
 * info line names it. A value that is not accepted logs one error naming only the variable and the accepted values
 * (the value itself is never logged) and throws the ConfigValidationError, so startup fails; nothing is cached then.
 */
export function processChannelInputMode(
	log: Logger,
	env: NodeJS.ProcessEnv = process.env,
): ChannelInputMode {
	if (processMode !== undefined) return processMode
	let mode: ChannelInputMode
	try {
		mode = channelInputModeFrom(env[CHANNEL_INPUT_ENV])
	} catch (error: unknown) {
		log.error(
			{ variable: CHANNEL_INPUT_ENV, accepted: CHANNEL_INPUT_MODES },
			"Unknown channel input mode; startup stops",
		)
		throw error
	}
	processMode = mode
	log.info({ channelInput: mode }, "Channel input mode")
	return mode
}

/** Tests only: forget the process's mode so the next call reads the environment again. */
export function resetProcessChannelInputModeForTests(): void {
	processMode = undefined
}
