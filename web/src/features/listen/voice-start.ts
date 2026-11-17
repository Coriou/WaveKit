// The `voice-start` condition: `/auto` routes a decoded call only while the digital voice service runs, so the
// page starts it on demand while listening needs it. A failed start is one toast until a start succeeds, the
// service runs, listening stops or it no longer needs decoded voice (Source Analog, squelch Open).
import { notices, type NoticeService } from "../../shell/notices/service.ts"

export interface VoiceStartState {
	/** The reader is listening. */
	readonly wanted: boolean
	/** The digital voice service runs. */
	readonly voiceRunning: boolean
	/** What plays now needs decoded voice. */
	readonly needsVoice: boolean
}

/**
 * One run of the effect: starts the service when needed and raises or clears `voice-start`. The returned
 * cleanup makes a start still pending ignore its result (listening stopped, or the state changed meanwhile).
 */
export function syncVoiceStart(
	state: VoiceStartState,
	ensureRunning: () => Promise<unknown>,
	service: NoticeService = notices,
): () => void {
	if (!state.wanted || state.voiceRunning || !state.needsVoice) {
		service.clear("voice-start")
		return () => undefined
	}
	let live = true
	ensureRunning().then(
		() => {
			if (live) service.clear("voice-start")
		},
		(error: unknown) => {
			if (!live) return
			const told = service.conditions.get().has("voice-start")
			service.raise(
				"voice-start",
				{
					text: `Decoded voice could not start: ${error instanceof Error ? error.message : "the core refused"}`,
					tone: "warn",
				},
				!told,
			)
		},
	)
	return () => {
		live = false
	}
}
