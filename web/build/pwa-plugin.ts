// Makes the web app an installable PWA (Chrome, Edge, Safari's Add to Dock): the web manifest, the brand's app
// icons and, in production builds, the service worker (src/pwa/sw.ts) with this build's file list baked in.
// The dev server serves the manifest and icons too, so install can be tried there; it never registers the worker.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { HtmlTagDescriptor, Plugin } from "vite"

import { isPrecached } from "../src/pwa/sw-policy.ts"

const brandExports = fileURLToPath(
	new URL("../../packages/brand/exports/", import.meta.url),
)
const swEntry = fileURLToPath(new URL("../src/pwa/sw.ts", import.meta.url))

/** The app's default ground (theme.ts DEFAULT_THEME: dark on True black); the page keeps theme-color in step after. */
export const PWA_BACKGROUND = "#000000"

/** Brand exports copied to icons/: the opaque square master for "any", its safe-area version for "maskable". */
export const PWA_ICONS = [
	{ file: "wavekit-app-180.png", sizes: "180x180", purpose: null },
	{ file: "wavekit-app-192.png", sizes: "192x192", purpose: "any" },
	{ file: "wavekit-app-512.png", sizes: "512x512", purpose: "any" },
	{ file: "wavekit-maskable-192.png", sizes: "192x192", purpose: "maskable" },
	{ file: "wavekit-maskable-512.png", sizes: "512x512", purpose: "maskable" },
] as const

/** The web manifest. Paths are relative to the manifest, so the app installs from whatever path serves it. */
export function webManifest(): Record<string, unknown> {
	return {
		id: "./",
		name: "WaveKit",
		short_name: "WaveKit",
		description: "Your receiver's spectrum, decoders and activity",
		lang: "en",
		dir: "ltr",
		start_url: "./",
		scope: "./",
		display: "standalone",
		background_color: PWA_BACKGROUND,
		theme_color: PWA_BACKGROUND,
		categories: ["utilities"],
		// A second launch (dock icon, link) brings the open window forward instead of a second spectrum stream.
		launch_handler: { client_mode: ["focus-existing", "auto"] },
		icons: PWA_ICONS.filter(i => i.purpose !== null).map(i => ({
			src: `icons/${i.file}`,
			sizes: i.sizes,
			type: "image/png",
			purpose: i.purpose,
		})),
	}
}

export function pwa(): Plugin {
	let base = "/"
	let isBuild = false
	return {
		name: "wavekit-pwa",
		configResolved(config) {
			base = config.base
			isBuild = config.command === "build"
		},
		buildStart() {
			if (!isBuild) return
			this.emitFile({ type: "chunk", id: swEntry, fileName: "sw.js" })
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? "").split("?")[0] ?? ""
				if (path === `${base}manifest.webmanifest`) {
					res.setHeader("Content-Type", "application/manifest+json")
					res.end(JSON.stringify(webManifest(), null, "\t"))
					return
				}
				const icon = PWA_ICONS.find(i => path === `${base}icons/${i.file}`)
				if (icon) {
					res.setHeader("Content-Type", "image/png")
					res.end(readFileSync(`${brandExports}${icon.file}`))
					return
				}
				next()
			})
		},
		transformIndexHtml(): HtmlTagDescriptor[] {
			const link = (
				rel: string,
				href: string,
				extra: Record<string, string> = {},
			): HtmlTagDescriptor => ({
				tag: "link",
				attrs: { rel, href: `${base}${href}`, ...extra },
				injectTo: "head",
			})
			const meta = (name: string, content: string): HtmlTagDescriptor => ({
				tag: "meta",
				attrs: { name, content },
				injectTo: "head",
			})
			return [
				link("manifest", "manifest.webmanifest"),
				link("apple-touch-icon", "icons/wavekit-app-180.png"),
				meta("theme-color", PWA_BACKGROUND),
				meta("application-name", "WaveKit"),
				meta("apple-mobile-web-app-title", "WaveKit"),
				meta("mobile-web-app-capable", "yes"),
				meta("apple-mobile-web-app-capable", "yes"),
				meta("apple-mobile-web-app-status-bar-style", "black"),
			]
		},
		generateBundle: {
			order: "post",
			handler(_options, bundle) {
				if (!isBuild) return
				this.emitFile({
					type: "asset",
					fileName: "manifest.webmanifest",
					source: JSON.stringify(webManifest(), null, "\t"),
				})
				for (const icon of PWA_ICONS)
					this.emitFile({
						type: "asset",
						fileName: `icons/${icon.file}`,
						source: readFileSync(`${brandExports}${icon.file}`),
					})
				const sw = bundle["sw.js"]
				if (!sw || sw.type !== "chunk") {
					this.error("wavekit-pwa: the service worker chunk is missing")
				}
				if (sw.imports.length > 0 || sw.dynamicImports.length > 0)
					this.error(
						"wavekit-pwa: sw.js imports another chunk; it must stay a standalone classic script",
					)
				// The manifest and icons emitted above are in the bundle already; a Set keeps addAll free of duplicates.
				const files = [
					...new Set([
						...Object.keys(bundle).filter(isPrecached),
						"index.html",
					]),
				].sort()
				const hash = createHash("sha256")
				for (const name of files) {
					hash.update(name)
					const out = bundle[name]
					if (out?.type === "asset") hash.update(out.source)
				}
				const version = hash.digest("hex").slice(0, 12)
				const list = JSON.stringify(JSON.stringify(files))
				sw.code = sw.code
					.replace(/(["'])__WK_PRECACHE__\1/, list)
					.replace(/(["'])__WK_VERSION__\1/, JSON.stringify(version))
				if (
					sw.code.includes("__WK_PRECACHE__") ||
					sw.code.includes("__WK_VERSION__")
				)
					this.error("wavekit-pwa: could not bake the file list into sw.js")
			},
		},
	}
}
