// The squelch actions Listen, Settings, the palette and the `Q` key share (DESIGN.md "Squelch UX"). The
// squelch is a core setting: every change is a config PATCH, never a stream reattach.
import type { LiveAudioStore } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import {
	closedSquelch,
	squelchPatch,
	squelchSetting,
	toggleOpenPatch,
	type ClosedSquelch,
} from "./audio.ts"
import type { ListenController } from "./controller.ts"

/**
 * The closed squelch `Q` goes back to, this tab only (the squelch itself is shared by every client). Set
 * whenever this tab opens the squelch; an Open chosen elsewhere goes back to Auto with the voice check.
 */
let beforeOpen: ClosedSquelch | null = null

/** For tests: forget the remembered squelch. */
export function resetOpenMemory(): void {
	beforeOpen = null
}

export function rememberedClosed(): ClosedSquelch | null {
	return beforeOpen
}

function send(
	liveAudio: LiveAudioStore,
	patch: Parameters<LiveAudioStore["setConfig"]>[0],
): Promise<boolean> {
	return liveAudio.setConfig(patch).then(
		() => true,
		// the store holds the error; Listen shows it
		() => false,
	)
}

/** Open: remembers the squelch it replaces, and starts Listen here (Open is for hearing everything). */
export function openSquelch(
	liveAudio: LiveAudioStore,
	listen: ListenController | null,
): Promise<boolean> {
	const status = liveAudio.get().status
	const closed = closedSquelch(squelchSetting(status))
	if (closed !== null) beforeOpen = closed
	if (listen && !listen.get().wanted) void listen.start()
	return send(liveAudio, squelchPatch(status?.config, { kind: "open" }))
}

/** `Q`: Open, or back to the squelch before it. Opening also starts Listen here. */
export function toggleOpen(
	liveAudio: LiveAudioStore,
	listen: ListenController | null,
): Promise<boolean> {
	const status = liveAudio.get().status
	const { patch, remember } = toggleOpenPatch(status, beforeOpen)
	if (remember !== null) {
		beforeOpen = remember
		if (listen && !listen.get().wanted) void listen.start()
	}
	return send(liveAudio, patch)
}

/** Play anyway: Voice only off (Auto stays), with Undo in the toast. */
export function playAnyway(liveAudio: LiveAudioStore): Promise<boolean> {
	const config = liveAudio.get().status?.config
	return send(
		liveAudio,
		squelchPatch(config, { kind: "auto", voiceOnly: false }),
	).then(ok => {
		if (ok)
			showAppToast("Voice only is off: every carrier plays", {
				undo: () =>
					void send(
						liveAudio,
						squelchPatch(liveAudio.get().status?.config, {
							kind: "auto",
							voiceOnly: true,
						}),
					),
			})
		return ok
	})
}
