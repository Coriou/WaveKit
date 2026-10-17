// What the app knows about being installed, and the words for it: pure, for the palette and the tests.

export interface PwaState {
	/** Opened as an installed app (its own window), not in a browser tab. */
	readonly standalone: boolean
	/** The browser handed over its install prompt (Chrome, Edge): ⌘K can install. */
	readonly canPrompt: boolean
	/** HTTPS or localhost: without it there is no service worker, and Chrome will not install. */
	readonly secure: boolean
}

/** How a page is displayed, from the display-mode media queries and Safari's navigator.standalone. */
export function isStandalone(
	matches: (query: string) => boolean,
	iosStandalone: boolean | undefined,
): boolean {
	return (
		iosStandalone === true ||
		["standalone", "window-controls-overlay", "minimal-ui", "fullscreen"].some(
			m => matches(`(display-mode: ${m})`),
		)
	)
}

/** What the palette's install row says when the browser has no prompt to give. */
export function installHint(state: PwaState): string {
	if (!state.secure)
		return "Installing needs HTTPS: open WaveKit over https:// or on localhost"
	return "Use your browser's Install command (Safari: File › Add to Dock)"
}
