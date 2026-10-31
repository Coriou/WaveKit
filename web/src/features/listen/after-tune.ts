// Listen to a frequency the receiver is not on yet: unlock audio inside the click, tune, and start live
// audio only once the tune landed, so a slow or failed tune never plays the previous frequency.

/** The part of ListenController that listenAfterTune drives (a fake in tests). */
export interface ListenAfterTuneTarget {
	unlock(): void
	/** Puts the audio the unlock woke back to sleep when nothing plays here (ListenController.suspend). */
	suspend(): void
	get(): { wanted: boolean }
	start(): Promise<void>
}

/**
 * Call it synchronously from the click: the unlock runs before the first await, inside the user gesture,
 * so the browser lets the later start() sound. Audio already on follows the tune by itself. True when it
 * listens; on a failed or superseded tune the unlocked audio is suspended again and nothing plays.
 */
export async function listenAfterTune(
	hz: number,
	tune: (hz: number) => Promise<boolean>,
	listen: ListenAfterTuneTarget,
): Promise<boolean> {
	const unlocked = !listen.get().wanted
	if (unlocked) listen.unlock()
	let landed = false
	try {
		landed = await tune(hz)
	} finally {
		if (!landed && unlocked) listen.suspend()
	}
	if (!landed) return false
	if (!listen.get().wanted) await listen.start()
	return true
}

/** The warning a Listen whose tune did not land shows (drawer and spectrum tag alike). */
export function tuneFailedText(error: string | null): string {
	return error
		? `Could not tune: ${error}`
		: "Not listening: the receiver was tuned elsewhere first"
}
