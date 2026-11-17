/**
 * How a channelised decoder gets its channel: `relay` (Node pipes the channel socket into the decoder's stdin) or
 * `direct` (the channel socket is the decoder's stdin). Selected once per process by WAVEKIT_CHANNEL_INPUT; it has no
 * `__`, so the config loader's WAVEKIT_ overrides never read it, and there is no config key.
 */
import type { ChannelInputMode } from "../core/channelizer/types.js"
import type { Logger } from "../utils/logger.js"

export const CHANNEL_INPUT_ENV = "WAVEKIT_CHANNEL_INPUT"

/** Unset, empty and any value other than `relay` or `direct` read as `relay`; `known` is false for the last. */
export function channelInputModeFrom(raw: string | undefined): {
	mode: ChannelInputMode
	known: boolean
} {
	if (raw === "direct") return { mode: "direct", known: true }
	if (raw === undefined || raw === "" || raw === "relay")
		return { mode: "relay", known: true }
	return { mode: "relay", known: false }
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
			{ variable: CHANNEL_INPUT_ENV, accepted: ["relay", "direct"] },
			"Unknown channel input mode; using relay",
		)
	log.info({ channelInput: mode }, "Channel input mode")
	return mode
}

/** Tests only: forget the process's mode so the next call reads the environment again. */
export function resetProcessChannelInputModeForTests(): void {
	processMode = undefined
}
