// Keeps the address bar's hash and the app in step (deep-link.ts says what the hash holds). On load and on
// hashchange the hash opens its view, drawer, Activity search or discovery; afterwards every change rewrites it with
// replaceState, coalesced to one write per task.
import type { AppServices } from "../app/services.ts"
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
		}
	} else if (shell.drawer === "scanner")
		out.discoveryId = scannerUi.get().openDiscoveryId
	return out
}

/** Opens what a link names. */
export function applyLink(services: AppServices, link: LinkState): void {
	if (link.activity) services.activity.restore(link.activity)
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

	const write = () => {
		queued = false
		const hash = formatLink(currentLink(services))
		const loc = window.location
		if (hash === loc.hash || (hash === "" && loc.hash === "")) return
		const url = hash === "" ? `${loc.pathname}${loc.search}` : hash
		try {
			window.history.replaceState(window.history.state, "", url)
		} catch {
			// Sandboxed frames refuse it: the app works the same without the link.
		}
	}
	const schedule = () => {
		if (queued) return
		queued = true
		queueMicrotask(write)
	}

	const open = () => {
		const link = parseLink(window.location.hash)
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
	]
	return () => {
		window.removeEventListener("hashchange", open)
		for (const off of offs) off()
	}
}
