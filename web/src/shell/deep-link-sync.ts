// Keeps the address bar's hash and the app in step (deep-link.ts says what the hash holds). On load and on
// hashchange the hash opens its view, drawer, Activity search or discovery; afterwards every change rewrites it with
// replaceState, coalesced to one write per task.
import type { AppServices } from "../app/services.ts"
import {
	activityLayout,
	setActivityLayout,
} from "../features/activity/layout.ts"
import { setTab } from "../features/scanner/drawer/state.ts"
import { openDiscovery, scannerUi } from "../features/scanner/ui-store.ts"
import {
	SETTINGS_REGISTRY,
	focusSetting,
} from "../features/settings/registry.ts"
import type { LinkState } from "./deep-link.ts"
import { formatLink, parseLink } from "./deep-link.ts"
import { shellStore } from "./store.ts"

interface LaunchQueue {
	setConsumer(consumer: (params: { targetURL?: string }) => void): void
}

/** What is on screen, as a link. */
export function currentLink(services: AppServices): LinkState {
	const shell = shellStore.getState()
	const out: LinkState = { view: shell.view, drawer: shell.drawer }
	if (shell.drawer === "activity") {
		const a = services.activity.get()
		out.activity = {
			tokens: a.tokens,
			chip: a.chip,
			range: a.range,
			audio: a.audio,
			openId: a.openId,
			...(activityLayout.get().layout === "cards"
				? { layout: "cards" as const }
				: {}),
		}
	} else if (shell.drawer === "scanner")
		out.discoveryId = scannerUi.get().openDiscoveryId
	return out
}

/** Opens what a link names. */
export function applyLink(services: AppServices, link: LinkState): void {
	if (link.activity) services.activity.restore(link.activity)
	// a link names Cards only; one without it keeps this browser's layout
	if (link.activity?.layout === "cards") setActivityLayout("cards")
	if (link.discoveryId) {
		setTab("all")
		openDiscovery(link.discoveryId)
	}
	shellStore.setView(link.view)
	if (link.settingId) {
		const entry = SETTINGS_REGISTRY.find(e => e.id === link.settingId)
		if (entry) {
			focusSetting(entry.id)
			if (entry.place.kind === "panel") {
				shellStore.closeDrawer()
				shellStore.openPanel(entry.place.id)
				return
			}
		}
	}
	if (link.drawer !== null) shellStore.openDrawer(link.drawer)
	else shellStore.closeDrawer()
}

export function followDeepLinks(services: AppServices): () => void {
	if (typeof window === "undefined") return () => undefined
	let queued = false
	// The hash as this module last read or wrote it. A different one in the address bar was set from outside (a
	// link, the address bar, a script) and its hashchange is still on its way (a task later): the app's state does
	// not overwrite it meanwhile, or the change would be lost (open() would then read the old hash back).
	let known = window.location.hash

	const write = () => {
		queued = false
		const loc = window.location
		if (loc.hash !== known) return
		const hash = formatLink(currentLink(services))
		if (hash === loc.hash || (hash === "" && loc.hash === "")) return
		const url = hash === "" ? `${loc.pathname}${loc.search}` : hash
		try {
			window.history.replaceState(window.history.state, "", url)
		} catch {
			// Sandboxed frames refuse it: the app works the same without the link.
		}
		known = loc.hash
	}
	const schedule = () => {
		if (queued) return
		queued = true
		queueMicrotask(write)
	}

	const open = () => {
		known = window.location.hash
		const link = parseLink(known)
		if (link) applyLink(services, link)
		schedule()
	}

	open()
	window.addEventListener("hashchange", open)
	// installed app: a manifest shortcut or a link launched into the open window (launch_handler focus-existing)
	const queue = (window as { launchQueue?: LaunchQueue }).launchQueue
	queue?.setConsumer(params => {
		if (!params.targetURL) return
		const hash = new URL(params.targetURL).hash
		if (hash !== window.location.hash) window.location.hash = hash
	})
	const offs = [
		shellStore.subscribe(schedule),
		services.activity.subscribe(schedule),
		scannerUi.subscribe(schedule),
		activityLayout.subscribe(schedule),
	]
	return () => {
		window.removeEventListener("hashchange", open)
		for (const off of offs) off()
	}
}
