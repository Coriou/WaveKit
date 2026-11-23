/**
 * Waits for every WAV lookup a dsd-fme adapter has queued (findWavFileAsync runs them off the
 * event loop, one at a time, on the adapter's `wavSearch` chain). A call_end held for its first
 * attempt is published by then. A retry scheduled after the last attempt is not waited for: a
 * first attempt finds a file that already exists.
 */
export async function settleWavLookups(decoder: unknown): Promise<void> {
	const internals = decoder as { wavSearch: Promise<void> }
	for (;;) {
		const tail = internals.wavSearch
		await tail
		if (internals.wavSearch === tail) return
	}
}
