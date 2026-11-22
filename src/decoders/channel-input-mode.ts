/**
 * How a channelised decoder gets its channel: `direct` (the channel socket is the decoder's stdin; the default) or
 * `relay` (Node pipes the channel socket into the decoder's stdin). Selected once per process by
 * WAVEKIT_CHANNEL_INPUT; it has no `__`, so the config loader's WAVEKIT_ overrides never read it, and there is no
 * config key. Direct is the default because in relay mode every channel byte waits for the core's main thread: a
 * main-thread stall longer than the channel's queue drops samples there (`queue-overflow`), while a direct decoder
 * reads its socket itself. Scanner taps and scanner probe decoders keep the relay in both modes (DecoderManager).
 */
import type { ChannelInputMode } from "../core/channelizer/types.js"
import type { Logger } from "../utils/logger.js"

export const CHANNEL_INPUT_ENV = "WAVEKIT_CHANNEL_INPUT"

/** The mode when WAVEKIT_CHANNEL_INPUT is unset, empty or not accepted. */
export const DEFAULT_CHANNEL_INPUT_MODE: ChannelInputMode = "direct"

/**
 * `relay` and `direct` are read as given; unset and empty read as the default (direct), and any other value too,
 * with `known` false.
 */
export function channelInputModeFrom(raw: string | undefined): {
	mode: ChannelInputMode
	known: boolean
} {
	if (raw === "direct" || raw === "relay") return { mode: raw, known: true }
	return {
		mode: DEFAULT_CHANNEL_INPUT_MODE,
		known: raw === undefined || raw === "",
	}
}

let processMode: ChannelInputMode | undefined

/**
 * The process's mode, read from the environment on the first call: one info line names it, and a value that is not
 * accepted adds a warning naming only the accepted values (the value itself is never logged).
 */
export function processChannelInputMode(
	log: Logger,
	env: NodeJS.ProcessEnv = process.env,
): ChannelInputMode {
	if (processMode !== undefined) return processMode
	const { mode, known } = channelInputModeFrom(env[CHANNEL_INPUT_ENV])
	processMode = mode
	if (!known)
		log.warn(
			{
				variable: CHANNEL_INPUT_ENV,
				accepted: ["relay", "direct"],
				default: DEFAULT_CHANNEL_INPUT_MODE,
			},
			"Unknown channel input mode; using the default",
		)
	log.info({ channelInput: mode }, "Channel input mode")
	return mode
}

/** Tests only: forget the process's mode so the next call reads the environment again. */
export function resetProcessChannelInputModeForTests(): void {
	processMode = undefined
}
