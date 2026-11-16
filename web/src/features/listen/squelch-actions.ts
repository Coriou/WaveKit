// The squelch actions Listen, Settings, the palette and the `Q` key share (DESIGN.md "Squelch UX"). The
// squelch is a core setting: every change is a config PATCH, never a stream reattach.
import type { LiveAudioStore } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import type { LiveAudioConfig } from "@wavekit/api-types"

import {
	closedSquelchOf,
	squelchOf,
	squelchPatch,
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

/**
 * Remembers the closed squelch in `config` as the one `Q` goes back to (nothing while Open). For an Open
 * chosen where Listen is not started (Settings), so `Q` still returns to the squelch before it.
 */
export function rememberBeforeOpen(
	config: LiveAudioConfig | null | undefined,
): void {
	const closed = closedSquelchOf(config)
	if (closed !== null) beforeOpen = closed
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

/**
 * Open: remembers the squelch it replaces, and starts Listen here once the core took it (Open is for
 * hearing everything). Listen, the palette's Squelch › Open and typed `sq open` / `sq off` come here.
 */
export function openSquelch(
	liveAudio: LiveAudioStore,
	listen: ListenController | null,
): Promise<boolean> {
	const config = liveAudio.get().status?.config
	rememberBeforeOpen(config)
	const after = unlockHere(listen)
	return send(liveAudio, squelchPatch(config, { kind: "open" })).then(ok => {
		after(ok)
		return ok
	})
}

/**
 * Unlocks audio inside the gesture when Listen is off here, and returns what to do once the PATCH
 * answers: start Listen when the core took it, else suspend the unlocked audio again.
 */
function unlockHere(listen: ListenController | null): (ok: boolean) => void {
	if (!listen || listen.get().wanted) return () => undefined
	listen.unlock()
	return ok => {
		if (ok) void listen.start()
		else listen.suspend()
	}
}

/** `Q`: Open, or back to the squelch before it. Opening also starts Listen here once the core took it. */
export function toggleOpen(
	liveAudio: LiveAudioStore,
	listen: ListenController | null,
): Promise<boolean> {
	const status = liveAudio.get().status
	const { patch, remember } = toggleOpenPatch(status, beforeOpen)
	if (remember !== null) beforeOpen = remember
	const after = remember !== null ? unlockHere(listen) : () => undefined
	return send(liveAudio, patch).then(ok => {
		after(ok)
		return ok
	})
}

/**
 * Play anyway: Voice only off (Auto stays), with Undo in the toast. Undo turns Voice only back on only
 * while the squelch is still Auto with Voice only off; after any other change it does nothing.
 */
export function playAnyway(liveAudio: LiveAudioStore): Promise<boolean> {
	const config = liveAudio.get().status?.config
	return send(
		liveAudio,
		squelchPatch(config, { kind: "auto", voiceOnly: false }),
	).then(ok => {
		if (ok)
			showAppToast("Voice only is off: every carrier plays", {
				undo: () => {
					const now = liveAudio.get().status?.config
					const setting = squelchOf(now)
					if (
						now?.squelchMode !== "auto" ||
						setting.kind !== "auto" ||
						setting.voiceOnly
					)
						return
					void send(
						liveAudio,
						squelchPatch(now, { kind: "auto", voiceOnly: true }),
					)
				},
			})
		return ok
	})
}
