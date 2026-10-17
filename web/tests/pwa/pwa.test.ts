import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { PWA_ICONS, webManifest } from "../../build/pwa-plugin.ts"
import {
	flatten,
	PaletteModel,
	type PaletteContext,
} from "../../src/features/palette/model.ts"
import {
	cacheName,
	isPrecached,
	routeRequest,
	staleCaches,
	type SwRequest,
} from "../../src/pwa/sw-policy.ts"
import {
	installHint,
	isStandalone,
	type PwaState,
} from "../../src/pwa/state.ts"
import { INITIAL_SHELL } from "../../src/shell/store.ts"
import { DEFAULT_THEME } from "../../src/shell/theme.ts"

const SCOPE = "https://wavekit.local/"
const PRECACHE = new Set([
	`${SCOPE}index.html`,
	`${SCOPE}assets/index-abc.js`,
	`${SCOPE}icons/wavekit-app-192.png`,
])
const get = (url: string, over: Partial<SwRequest> = {}): SwRequest => ({
	url,
	method: "GET",
	mode: "cors",
	range: null,
	...over,
})

describe("service worker: what it answers", () => {
	it("serves this build's files from the cache, query or not", () => {
		expect(
			routeRequest(get(`${SCOPE}assets/index-abc.js`), SCOPE, PRECACHE),
		).toEqual({
			kind: "shell",
			key: `${SCOPE}assets/index-abc.js`,
		})
		expect(
			routeRequest(get(`${SCOPE}assets/index-abc.js?v=1`), SCOPE, PRECACHE)
				.kind,
		).toBe("shell")
	})

	it("loads pages from the network, with the shell as the offline fallback", () => {
		expect(
			routeRequest(get(SCOPE, { mode: "navigate" }), SCOPE, PRECACHE).kind,
		).toBe("navigate")
		expect(
			routeRequest(get(`${SCOPE}?x=1`, { mode: "navigate" }), SCOPE, PRECACHE)
				.kind,
		).toBe("navigate")
	})

	it("never touches the core: API, WebSocket, health, even as a page load", () => {
		for (const path of [
			"api/status",
			"api/recordings/1.wav",
			"ws",
			"ws?x=1",
			"health",
			"api",
		])
			for (const mode of ["cors", "navigate", "same-origin"])
				expect(
					routeRequest(get(`${SCOPE}${path}`, { mode }), SCOPE, PRECACHE).kind,
				).toBe("pass")
		// an app below the root: the core's paths under the scope and at the origin root both pass
		const sub = "https://box.local/wavekit/"
		expect(routeRequest(get(`${sub}api/status`), sub, PRECACHE).kind).toBe(
			"pass",
		)
		expect(
			routeRequest(
				get("https://box.local/api/status", { mode: "navigate" }),
				sub,
				PRECACHE,
			).kind,
		).toBe("pass")
	})

	it("leaves other origins, writes, media ranges and unknown files alone", () => {
		expect(
			routeRequest(get("https://tiles.openfreemap.org/a.pbf"), SCOPE, PRECACHE)
				.kind,
		).toBe("pass")
		expect(
			routeRequest(get("http://wavekit.local:8081/audio"), SCOPE, PRECACHE)
				.kind,
		).toBe("pass")
		expect(
			routeRequest(
				get(`${SCOPE}index.html`, { method: "POST" }),
				SCOPE,
				PRECACHE,
			).kind,
		).toBe("pass")
		expect(
			routeRequest(
				get(`${SCOPE}assets/index-abc.js`, { range: "bytes=0-" }),
				SCOPE,
				PRECACHE,
			).kind,
		).toBe("pass")
		expect(
			routeRequest(get(`${SCOPE}assets/other.js`), SCOPE, PRECACHE).kind,
		).toBe("pass")
	})

	it("passes every request under a core path, whatever follows (property)", () => {
		// Feature: web PWA, Property 1: the core's traffic is never cached
		fc.assert(
			fc.property(
				fc.constantFrom("api", "ws", "health"),
				fc.webPath(),
				fc.constantFrom("cors", "navigate", "no-cors", "same-origin"),
				(prefix, rest, mode) => {
					const url = `${SCOPE}${prefix}/${rest.replace(/^\//, "")}`
					return (
						routeRequest(get(url, { mode }), SCOPE, PRECACHE).kind === "pass"
					)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("drops only other builds' shells, and never precaches maps or itself", () => {
		expect(
			staleCaches(["wavekit-shell-a", "wavekit-shell-b", "maplibre"], "b"),
		).toEqual(["wavekit-shell-a"])
		expect(cacheName("b")).toBe("wavekit-shell-b")
		expect(isPrecached("assets/index-abc.js")).toBe(true)
		expect(isPrecached("assets/index-abc.js.map")).toBe(false)
		expect(isPrecached("sw.js")).toBe(false)
	})
})

describe("manifest", () => {
	it("is installable: standalone, relative start and scope, any and maskable icons that exist", () => {
		const m = webManifest()
		expect(m["display"]).toBe("standalone")
		expect(m["start_url"]).toBe("./")
		expect(m["scope"]).toBe("./")
		const icons = m["icons"] as { sizes: string; purpose: string }[]
		for (const size of ["192x192", "512x512"])
			for (const purpose of ["any", "maskable"])
				expect(icons.some(i => i.sizes === size && i.purpose === purpose)).toBe(
					true,
				)
		for (const icon of PWA_ICONS) {
			const path = fileURLToPath(
				new URL(
					`../../../packages/brand/exports/${icon.file}`,
					import.meta.url,
				),
			)
			expect(existsSync(path)).toBe(true)
			// PNG IHDR width matches the declared size
			const png = readFileSync(path)
			expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes)
		}
	})
})

describe("install state", () => {
	it("reads an installed window from any app display mode or Safari's flag", () => {
		expect(isStandalone(() => false, undefined)).toBe(false)
		expect(
			isStandalone(q => q === "(display-mode: standalone)", undefined),
		).toBe(true)
		expect(
			isStandalone(
				q => q === "(display-mode: window-controls-overlay)",
				undefined,
			),
		).toBe(true)
		expect(isStandalone(() => false, true)).toBe(true)
	})

	const state = (over: Partial<PwaState> = {}): PwaState => ({
		standalone: false,
		canPrompt: false,
		secure: true,
		...over,
	})
	const ctx = (pwa: PwaState): PaletteContext => ({
		tunedHz: null,
		config: null,
		listening: false,
		volume: 1,
		stepHz: 12_500,
		chosenStepHz: null,
		receiver: null,
		readOnly: false,
		accessMode: null,
		theme: DEFAULT_THEME,
		saved: null,
		bandplan: null,
		discoveries: [],
		presets: [],
		sweep: null,
		shell: INITIAL_SHELL,
		recent: [],
		boost: () => 0,
		pwa,
	})
	const installRow = (pwa: PwaState) =>
		flatten(new PaletteModel(ctx(pwa)).build(null, "install")).find(
			i => i.id === "app:install",
		)

	it("⌘K installs when the browser gives its prompt, explains otherwise, hides in the app", () => {
		expect(installRow(state({ canPrompt: true }))?.action).toEqual({
			kind: "install",
		})
		expect(installRow(state())?.info).toBe(true)
		expect(installRow(state())?.sub).toBe(installHint(state()))
		expect(installRow(state({ secure: false }))?.sub).toMatch(/HTTPS/)
		expect(
			installRow(state({ standalone: true, canPrompt: true })),
		).toBeUndefined()
		expect(
			flatten(new PaletteModel(ctx(state())).build(null, "add to dock"))[0]?.id,
		).toBe("app:install")
	})
})
