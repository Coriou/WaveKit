import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"
import {
	CONFIG_EXPORT_CONTENT_TYPE,
	CONFIG_EXPORT_FILE_NAME,
	CONFIG_EXPORT_ROUTE,
} from "@wavekit/api-types"
import type { DeniedAdmission } from "../../../src/access/types.js"
import type { Config } from "../../../src/config.js"

const SECRET = "s3cr3t-value-xyz"

vi.mock("../../../src/core/config-export/export.js", () => {
	class ConfigExportTooLargeError extends Error {}
	return {
		ConfigExportTooLargeError,
		exportConfig: (
			config: { marker?: string },
			options: { maxBytes?: number; generatedAt: string },
		) => {
			const body = `# WaveKit config export\n# generated ${options.generatedAt}\nmarker: ${config.marker ?? ""}\n`
			if (options.maxBytes !== undefined && body.length > options.maxBytes)
				throw new ConfigExportTooLargeError(`too large ${SECRET}`)
			return body
		},
	}
})

const { configExportRoutes } =
	await import("../../../src/api/routes/config-export.js")
type Options = Parameters<typeof configExportRoutes>[1]

const config = { marker: SECRET } as unknown as Config
const denial: DeniedAdmission = {
	kind: "deny",
	status: 401,
	code: "unauthorized" as DeniedAdmission["code"],
	headers: { "WWW-Authenticate": "Bearer" } as DeniedAdmission["headers"],
}

async function build(options: Partial<Options>, loggerStream?: object) {
	const app = Fastify(
		loggerStream
			? { logger: { level: "trace", stream: loggerStream as never } }
			: {},
	)
	await app.register(configExportRoutes, {
		version: "1.2.3",
		authorize: () => undefined,
		...options,
	} as Options)
	return app
}

describe("configExportRoutes", () => {
	it("fails closed at registration without authorize", async () => {
		const app = Fastify()
		await expect(
			app.register(configExportRoutes, { version: "1" }).ready(),
		).rejects.toThrow(/authorizer/)
	})

	it("authorizes before getConfig and sends the denial", async () => {
		const getConfig = vi.fn(() => config)
		const app = await build({ authorize: () => denial, getConfig })
		const res = await app.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		expect(res.statusCode).toBe(401)
		expect(res.headers["www-authenticate"]).toBe("Bearer")
		expect(res.headers["content-type"]).toContain("application/json")
		expect(JSON.parse(res.body)).toEqual({ code: denial.code })
		expect(getConfig).not.toHaveBeenCalled()
	})

	it("returns 503 when getConfig is missing", async () => {
		const app = await build({})
		const res = await app.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		expect(res.statusCode).toBe(503)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(JSON.parse(res.body)).toMatchObject({
			error: "ConfigExportError",
			code: "CONFIG_EXPORT_UNAVAILABLE",
		})
	})

	it("returns 503 without echoing a throwing getConfig message", async () => {
		const app = await build({
			getConfig: () => {
				throw new Error(`boom ${SECRET}`)
			},
		})
		const res = await app.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		expect(res.statusCode).toBe(503)
		expect(res.body).not.toContain(SECRET)
		expect(JSON.parse(res.body).code).toBe("CONFIG_EXPORT_UNAVAILABLE")
	})

	it("returns 500 when the export is too large, without content", async () => {
		const app = await build({ getConfig: () => config, maxBytes: 5 })
		const res = await app.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		expect(res.statusCode).toBe(500)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(res.body).not.toContain(SECRET)
		expect(JSON.parse(res.body).code).toBe("CONFIG_EXPORT_FAILED")
	})

	it("serves the export with download headers", async () => {
		const app = await build({
			getConfig: () => config,
			now: () => new Date("2026-01-02T03:04:05.000Z"),
		})
		const res = await app.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		expect(res.statusCode).toBe(200)
		expect(res.headers["content-type"]).toBe(CONFIG_EXPORT_CONTENT_TYPE)
		expect(res.headers["content-disposition"]).toBe(
			`attachment; filename="${CONFIG_EXPORT_FILE_NAME}"`,
		)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(res.body.startsWith("# WaveKit")).toBe(true)
		expect(res.body).toContain("2026-01-02T03:04:05.000Z")
	})

	it("never logs the secret on failure paths", async () => {
		const lines: string[] = []
		const stream = { write: (s: string) => void lines.push(s) }
		const app = await build(
			{
				getConfig: () => {
					throw new Error(`boom ${SECRET}`)
				},
			},
			stream,
		)
		await app.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		const app2 = await build({ getConfig: () => config, maxBytes: 5 }, stream)
		await app2.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		expect(lines.join("")).toContain("CONFIG_EXPORT_")
		expect(lines.join("")).not.toContain(SECRET)
	})

	it("returns a fixed 500 when authorize throws, without echoing or logging it", async () => {
		const lines: string[] = []
		const stream = { write: (s: string) => void lines.push(s) }
		const getConfig = vi.fn(() => config)
		const app = await build(
			{
				authorize: () => {
					throw new Error(`authorizer exploded ${SECRET}`)
				},
				getConfig,
			},
			stream,
		)
		const res = await app.inject({ method: "GET", url: CONFIG_EXPORT_ROUTE })
		expect(res.statusCode).toBe(500)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(JSON.parse(res.body)).toEqual({
			error: "ConfigExportError",
			code: "CONFIG_EXPORT_FAILED",
			message: "Configuration export failed",
		})
		expect(res.body).not.toContain(SECRET)
		expect(getConfig).not.toHaveBeenCalled()
		expect(lines.join("")).toContain("CONFIG_EXPORT_FAILED")
		expect(lines.join("")).not.toContain(SECRET)
		expect(lines.join("")).not.toContain("exploded")
	})
})
