// Listen to a frequency the receiver is not on yet: unlock audio inside the click, tune, and start live
// audio only once the tune landed, so a slow or failed tune never plays the previous frequency.

/** The part of ListenController that listenAfterTune drives (a fake in tests). */
export interface ListenAfterTuneTarget {
	unlock(): void
	get(): { wanted: boolean }
	start(): Promise<void>
}

/**
 * Call it synchronously from the click: the unlock runs before the first await, inside the user gesture,
 * so the browser lets the later start() sound. Audio already on follows the tune by itself. True when it listens.
 */
export async function listenAfterTune(
	hz: number,
	tune: (hz: number) => Promise<boolean>,
	listen: ListenAfterTuneTarget,
): Promise<boolean> {
	if (!listen.get().wanted) listen.unlock()
	if (!(await tune(hz))) return false
	if (!listen.get().wanted) await listen.start()
	return true
}
