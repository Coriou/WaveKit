// Which source the plot shows: one rule, also the receiver the Receiver island, the palette's receiver
// commands and the P key act on (features/receiver/feed.ts shownSourceFor / receiverSourceId), so a pause or a
// gain change never lands on a receiver other than the one on screen.

/**
 * The source the plot shows. The one shown before stays while it is listed and connected or paused, so pausing
 * it freezes its waterfall instead of switching to another receiver (which would reset the history); otherwise
 * the first connected source, else the first paused one (a core that booted paused), else none.
 */
export function plotSourceId(
	sources: readonly { id: string; connected: boolean }[],
	isPaused: (id: string) => boolean,
	shown: string | null,
): string | null {
	const kept = shown === null ? undefined : sources.find(s => s.id === shown)
	if (kept && (kept.connected || isPaused(kept.id))) return kept.id
	return (
		sources.find(s => s.connected)?.id ??
		sources.find(s => isPaused(s.id))?.id ??
		null
	)
}
