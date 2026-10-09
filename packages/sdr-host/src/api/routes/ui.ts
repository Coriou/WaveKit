import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

/** Same-origin only: the page needs nothing from any other host. */
const CONTENT_SECURITY_POLICY = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"font-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ")

const UI_FILES: Record<
	string,
	{ file: string; type: string; immutable?: boolean }
> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/model.js": { file: "model.js", type: "text/javascript; charset=utf-8" },
	"/brand/D-DINCondensed.woff2": {
		file: "brand/D-DINCondensed.woff2",
		type: "font/woff2",
		immutable: true,
	},
	"/brand/D-DINCondensed-Bold.woff2": {
		file: "brand/D-DINCondensed-Bold.woff2",
		type: "font/woff2",
		immutable: true,
	},
	"/brand/NotoSans-Regular.woff2": {
		file: "brand/NotoSans-Regular.woff2",
		type: "font/woff2",
		immutable: true,
	},
	"/brand/wavekit-wordmark-on-dark.svg": {
		file: "brand/wavekit-wordmark-on-dark.svg",
		type: "image/svg+xml",
	},
	"/brand/favicon.svg": { file: "brand/favicon.svg", type: "image/svg+xml" },
}

interface Asset {
	type: string
	body: Buffer
	gzip: Buffer | null
	etag: string
	cacheControl: string
}

/** dist/api/routes/ui.js and src/api/routes/ui.ts both sit three levels below the package. */
export const DEFAULT_UI_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../ui",
)

/** Reads the fixed asset list once; the Pi then serves it from memory. */
export function loadUiAssets(root: string): Map<string, Asset> | null {
	const assets = new Map<string, Asset>()
	for (const [route, spec] of Object.entries(UI_FILES)) {
		let body: Buffer
		try {
			body = fs.readFileSync(path.join(root, spec.file))
		} catch {
			return null
		}
		const compressible = !spec.type.startsWith("font/")
		assets.set(route, {
			type: spec.type,
			body,
			gzip: compressible ? gzipSync(body, { level: 9 }) : null,
			etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`,
			// Text assets revalidate (cheap 304s) so an updated container is
			// picked up immediately; fonts never change under a given name.
			cacheControl: spec.immutable ? "public, max-age=604800" : "no-cache",
		})
	}
	return assets
}

export function registerUiRoutes(
	fastify: FastifyInstance,
	options: { root?: string } = {},
): void {
	const assets = loadUiAssets(options.root ?? DEFAULT_UI_ROOT)
	if (!assets) {
		fastify.appLogger.warn("Operator page assets missing; serving API only")
		return
	}

	const serve =
		(route: string) => async (request: FastifyRequest, reply: FastifyReply) => {
			const asset = assets.get(route)
			if (!asset) return reply.status(404).send()
			reply
				.header("Content-Type", asset.type)
				.header("Cache-Control", asset.cacheControl)
				.header("ETag", asset.etag)
				.header("Vary", "Accept-Encoding")
				.header("X-Content-Type-Options", "nosniff")
				.header("Referrer-Policy", "no-referrer")
			if (route === "/") {
				reply
					.header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
					.header("X-Frame-Options", "DENY")
			}
			if (request.headers["if-none-match"] === asset.etag) {
				return reply.status(304).send()
			}
			const acceptsGzip = /\bgzip\b/.test(
				request.headers["accept-encoding"] ?? "",
			)
			if (asset.gzip && acceptsGzip) {
				return reply.header("Content-Encoding", "gzip").send(asset.gzip)
			}
			return reply.send(asset.body)
		}

	for (const route of assets.keys()) {
		fastify.get(route, serve(route))
	}
}
