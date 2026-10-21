import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DECODER_SETTINGS_FILE_NAME } from "@wavekit/api-types"
import type { DeniedAdmission } from "../../../src/access/types.js"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import type { ModeDecoderConfig } from "../../../src/decoders/settings/layers.js"
import {
	openDecoderSettingsService,
	type OpenedDecoderSettingsService,
} from "../../../src/decoders/settings/service.js"
import type { DecoderOverride } from "../../../src/decoders/settings/store.js"

const config: ModeDecoderConfig = {
	id: "ism",
	type: "rtl433",
	enabled: true,
	mode: "auto",
	options: { frequency: 433_920_000 },
}
let directory: string
let app: FastifyInstance
let settings: OpenedDecoderSettingsService
let denial: DeniedAdmission | undefined
let scanner: boolean
const applyDecoderMode = vi.fn(async () => undefined)
const stageDecoderOptions = vi.fn(() => false)
const getDecoder = vi.fn((id: string) => (id === "ism" ? {} : undefined))

beforeEach(async () => {
	vi.clearAllMocks()
	denial = undefined
	scanner = false
	directory = await mkdtemp(join(tmpdir(), "decoder-route-mode-"))
	settings = await openDecoderSettingsService({
		configs: [config],
		stateDir: directory,
		logger: pino({ level: "silent" }),
		manager: {
			getStatus: () => undefined,
			stageDecoderOptions,
			isRestartPending: () => false,
		},
		applyDecoderMode,
	})
	app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: {
			getDecoder,
			getStatus: () => ({ owner: scanner ? "scanner" : "config" }),
		} as unknown as DecoderRoutesOptions["decoderManager"],
		settings,
		authorizeSettings: () => denial,
	})
})
afterEach(async () => {
	await app.close()
	await settings.close()
	await rm(directory, { recursive: true, force: true })
})
const patch = (
	payload: object,
	headers: Record<string, string> = {},
	id = "ism",
) =>
	app.inject({ method: "PATCH", url: `/api/decoders/${id}`, payload, headers })
async function stored(): Promise<Record<string, DecoderOverride>> {
	const file = JSON.parse(
		await readFile(join(directory, DECODER_SETTINGS_FILE_NAME), "utf8"),
	) as { decoders: Record<string, DecoderOverride> }
	return file.decoders
}

it("PATCH mode always persists through the route and calls applyDecoderMode once", async () => {
	const response = await patch({ mode: "always" })
	expect(response.statusCode).toBe(200)
	expect(response.headers["cache-control"]).toBe("no-store")
	expect(response.json()).toMatchObject({
		revision: 1,
		changed: ["mode"],
		settings: { mode: { value: "always", source: "override" } },
	})
	expect((await stored())["ism"]?.mode).toBe("always")
	expect(applyDecoderMode).toHaveBeenCalledExactlyOnceWith("ism", "always")
	expect(stageDecoderOptions).not.toHaveBeenCalled()
	await settings.close()
	settings = await openDecoderSettingsService({
		configs: [config],
		stateDir: directory,
		logger: pino({ level: "silent" }),
	})
	expect(settings.view("ism")?.mode).toEqual({
		value: "always",
		source: "override",
	})
})
it("PATCH mode null removes the override", async () => {
	await settings.update("ism", { mode: "always" })
	applyDecoderMode.mockClear()
	const response = await patch({ mode: null })
	expect(response.statusCode).toBe(200)
	expect((await stored())["ism"]?.mode).toBeUndefined()
	expect(settings.view("ism")?.mode).toEqual({
		value: "auto",
		source: "config",
	})
	expect(applyDecoderMode).toHaveBeenCalledExactlyOnceWith("ism", "auto")
})
it("If-Match mismatch rejects a mode patch with today's status", async () => {
	const response = await patch({ mode: "always" }, { "if-match": 'W/"7"' })
	expect(response.statusCode).toBe(412)
	expect(response.json()).toEqual({
		error: "Precondition Failed",
		code: "DECODER_SETTINGS_REVISION_MISMATCH",
		message: "Decoder settings revision does not match",
	})
	expect(settings.revision()).toBe(0)
	expect(applyDecoderMode).not.toHaveBeenCalled()
})
it("protected-mode rule unchanged for mode", async () => {
	denial = {
		kind: "deny",
		status: 403,
		code: "ACCESS_DENIED" as DeniedAdmission["code"],
		headers: { "x-test": "1" },
	}
	for (const body of [{ enabled: true }, { mode: "always" }]) {
		const response = await patch(body, {}, "unknown")
		expect(response.statusCode).toBe(403)
		expect(response.body).toBe('{"code":"ACCESS_DENIED"}')
		expect(response.headers["x-test"]).toBe("1")
	}
	expect(getDecoder).not.toHaveBeenCalled()
	denial = undefined
	for (const body of [{ enabled: true }, { mode: "always" }]) {
		expect((await patch(body, {}, "unknown")).statusCode).toBe(404)
		scanner = true
		expect((await patch(body)).statusCode).toBe(409)
	}
	expect(settings.revision()).toBe(0)
	expect(applyDecoderMode).not.toHaveBeenCalled()
})
it("invalid mode value is a 400 with no echo of the value", async () => {
	const response = await patch({ mode: "private-mode-sentinel" })
	expect(response.statusCode).toBe(400)
	expect(response.json()).toEqual({
		error: "Bad Request",
		code: "DECODER_OPTIONS_INVALID",
		message: "Decoder options are invalid",
		issues: [
			{
				path: "mode",
				code: "invalid-value",
				message: "mode must be auto, always, off or null",
			},
		],
	})
	expect(response.body).not.toContain("private-mode-sentinel")
	expect(settings.revision()).toBe(0)
	expect(applyDecoderMode).not.toHaveBeenCalled()
})
it("mode of a non-string type is rejected by the shape gate", async () => {
	const update = vi.spyOn(settings, "update")
	for (const mode of [true, 1, [], {}]) {
		const response = await patch({ mode })
		expect(response.statusCode).toBe(400)
		expect(response.json()).toEqual({
			error: "Bad Request",
			code: "DECODER_OPTIONS_INVALID",
			message:
				"Body must be a JSON object with only enabled (boolean or null), options (object) and mode (string or null)",
		})
	}
	expect(update).not.toHaveBeenCalled()
	expect(settings.revision()).toBe(0)
})
it("enabled and options patches are byte-identical to before", async () => {
	const baselineDir = await mkdtemp(join(tmpdir(), "decoder-route-baseline-"))
	const baseline = await openDecoderSettingsService({
		configs: [config],
		stateDir: baselineDir,
		logger: pino({ level: "silent" }),
		manager: {
			getStatus: () => undefined,
			stageDecoderOptions: () => false,
			isRestartPending: () => false,
		},
	})
	try {
		for (const body of [
			{ enabled: false },
			{ options: { frequency: 868_000_000 } },
		]) {
			const expected = await baseline.update("ism", body)
			const response = await patch(body)
			expect(response.statusCode).toBe(200)
			expect(response.body).toBe(JSON.stringify(expected))
			expect(response.headers["cache-control"]).toBe("no-store")
		}
		expect(applyDecoderMode).not.toHaveBeenCalled()
	} finally {
		await baseline.close()
		await rm(baselineDir, { recursive: true, force: true })
	}
})
