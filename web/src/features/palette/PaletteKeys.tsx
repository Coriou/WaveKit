// The app's single-key shortcuts (keys.ts), always mounted; the palette itself loads on first use.
import { useEffect } from "react"

import { useServices } from "../../app/context.ts"
import { shellStore } from "../../shell/store.ts"
import { requestActivitySearchFocus } from "../activity/focus.ts"
import { effectiveStep } from "../tuner/prefs.ts"
import { GO_WINDOW_MS, isTypingTarget, shortcutFor } from "./keys.ts"
import { openPalette } from "./request.ts"

export function PaletteKeys() {
	const { data, tuning, prefs, listen } = useServices()
	useEffect(() => {
		let goUntil = 0
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return
			const shell = shellStore.getState()
			if (shell.palette) return
			const now = Date.now()
			const goPending = now < goUntil
			goUntil = 0
			const sc = shortcutFor(
				{
					key: e.key,
					meta: e.metaKey,
					ctrl: e.ctrlKey,
					alt: e.altKey,
					typing: isTypingTarget(e.target),
				},
				goPending,
			)
			if (!sc) return
			if (e.repeat && sc.kind !== "step") return
			switch (sc.kind) {
				case "goPrefix":
					goUntil = now + GO_WINDOW_MS
					break
				case "view":
					shellStore.setView(sc.id)
					break
				case "drawer":
					shellStore.openDrawer(sc.id)
					break
				case "scope":
					if (sc.scope === "save" && tuning.displayHz() === null) return
					openPalette(sc.scope)
					break
				case "step": {
					const hz = tuning.displayHz()
					if (hz === null) return
					const step = effectiveStep(
						prefs.get().stepHz,
						data.bandplan.get().view,
						hz,
					)
					void tuning.tune(hz + sc.dir * step)
					break
				}
				case "listen":
					if (!data.liveAudio.get().status) return
					void (listen.get().wanted ? listen.stop() : listen.start())
					break
				case "searchActivity":
					// the open Activity drawer focuses its own field
					if (shell.drawer === "activity") return
					requestActivitySearchFocus()
					shellStore.openDrawer("activity")
					break
			}
			e.preventDefault()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [data, tuning, prefs, listen])
	return null
}
