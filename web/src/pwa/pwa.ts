// The page's side of the PWA: registers the service worker (production builds, secure contexts), offers a new
// build through the app toast, keeps Chrome's install prompt for ⌘K « Install WaveKit », marks <html> with
// data-wk-display="standalone" in an installed window and keeps <meta name="theme-color"> on the theme's ground
// (an installed window's title bar takes that colour).

import { Store } from "../data/store.ts"
import { themeStore } from "../shell/theme.ts"
import { showAppToast } from "../shell/toast.ts"
import { isStandalone, type PwaState } from "./state.ts"

/** Chrome's install prompt event (not in the dom lib). */
interface InstallPromptEvent extends Event {
	prompt(): Promise<void>
	readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>
}

export const pwaState = new Store<PwaState>({
	standalone: false,
	canPrompt: false,
	secure: true,
})

let deferred: InstallPromptEvent | null = null

/** Shows the browser's install dialog; false when there is none or it was dismissed. */
export async function promptInstall(): Promise<boolean> {
	const event = deferred
	if (!event) return false
	deferred = null
	pwaState.update(s => ({ ...s, canPrompt: false }))
	await event.prompt()
	const choice = await event.userChoice
	return choice.outcome === "accepted"
}

function syncThemeColor(): void {
	const meta = document.querySelector<HTMLMetaElement>(
		'meta[name="theme-color"]',
	)
	if (!meta) return
	const bg = getComputedStyle(document.documentElement)
		.getPropertyValue("--wk-bg")
		.trim()
	if (bg) meta.content = bg
}

function watchDisplay(): void {
	const update = () => {
		const standalone = isStandalone(
			q => window.matchMedia(q).matches,
			(navigator as Navigator & { standalone?: boolean }).standalone,
		)
		if (standalone)
			document.documentElement.setAttribute("data-wk-display", "standalone")
		else document.documentElement.removeAttribute("data-wk-display")
		pwaState.update(s =>
			s.standalone === standalone ? s : { ...s, standalone },
		)
	}
	update()
	window
		.matchMedia("(display-mode: standalone)")
		.addEventListener("change", update)
}

const UPDATE_CHECK_MS = 60 * 60 * 1000

function registerWorker(): void {
	const sw = navigator.serviceWorker
	let reloading = false
	let asked = false
	const offer = (reg: ServiceWorkerRegistration) => {
		if (!reg.waiting || !sw.controller || asked) return
		asked = true
		showAppToast("WaveKit was updated", {
			persist: true,
			action: {
				label: "Reload",
				run: () => {
					reloading = true
					reg.waiting?.postMessage({ type: "skip-waiting" })
				},
			},
		})
	}
	sw.addEventListener("controllerchange", () => {
		if (reloading) window.location.reload()
	})
	sw.register(`${import.meta.env.BASE_URL}sw.js`)
		.then(reg => {
			offer(reg)
			reg.addEventListener("updatefound", () => {
				const next = reg.installing
				next?.addEventListener("statechange", () => {
					if (next.state === "installed") offer(reg)
				})
			})
			// The app stays open for days on a receiver screen: look for a new build when it comes back into view.
			let lastCheck = Date.now()
			document.addEventListener("visibilitychange", () => {
				if (
					document.visibilityState !== "visible" ||
					Date.now() - lastCheck < UPDATE_CHECK_MS
				)
					return
				lastCheck = Date.now()
				reg.update().catch(() => undefined)
			})
		})
		.catch(() => undefined)
}

/** Starts the PWA wiring; called once from main.tsx. */
export function startPwa(): void {
	if (typeof window === "undefined") return
	pwaState.update(s => ({ ...s, secure: window.isSecureContext }))
	watchDisplay()
	syncThemeColor()
	themeStore.subscribe(syncThemeColor)
	window.addEventListener("beforeinstallprompt", e => {
		// Kept for ⌘K; Chrome's own install button in the address bar stays.
		e.preventDefault()
		deferred = e as InstallPromptEvent
		pwaState.update(s => ({ ...s, canPrompt: true }))
	})
	window.addEventListener("appinstalled", () => {
		deferred = null
		pwaState.update(s => ({ ...s, canPrompt: false }))
	})
	if (
		import.meta.env.PROD &&
		window.isSecureContext &&
		"serviceWorker" in navigator
	)
		registerWorker()
}
