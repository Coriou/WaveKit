import { afterEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import { resolveDecoderMode } from "../../../../src/decoders/enablement/mode.js"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDecoderSettingsService } from "../../../../src/decoders/settings/service.js"
import { validateDecoderPatch } from "../../../../src/decoders/settings/patch-policy.js"
import { parseDecoderSettingsFile } from "../../../../src/decoders/settings/store.js"
import {
	buildDecoderSettingsView,
	effectiveDecoderConfig,
} from "../../../../src/decoders/settings/layers.js"
import { stubLogger } from "../../core/station/helpers.js"

const dirs: string[] = []
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})
async function setup() {
	const stateDir = await mkdtemp(join(tmpdir(), "wavekit-mode-"))
	dirs.push(stateDir)
	const log = stubLogger()
	const persistedAtApply: string[] = []
	const applyDecoderMode = vi.fn(async () => {
		persistedAtApply.push(
			await readFile(join(stateDir, "decoder-settings.json"), "utf8"),
		)
	})
	const service = await openDecoderSettingsService({
		stateDir,
		logger: log.logger,
		configs: [{ id: "test", type: "direwolf", enabled: true, options: {} }],
		manager: {
			getStatus: () => undefined,
			stageDecoderOptions: () => false,
			isRestartPending: () => false,
		},
		applyDecoderMode,
	})
	return { service, applyDecoderMode, stateDir, log, persistedAtApply }
}
it("mode always persists and the view reports the settings override", async () => {
	const { service, applyDecoderMode, stateDir, persistedAtApply } =
		await setup()
	try {
		const result = await service.update("test", { mode: "always" })
		expect(persistedAtApply).toHaveLength(1)
		const atApply = parseDecoderSettingsFile(persistedAtApply[0] ?? "")
		expect(atApply.corrupt).toBe(false)
		if (!atApply.corrupt) {
			expect(atApply.file.decoders["test"]?.mode).toBe("always")
			expect(atApply.file.revision).toBe(result.revision)
		}
		expect(result.settings.mode).toEqual({
			value: "always",
			source: "override",
		})
		const parsed = parseDecoderSettingsFile(
			await readFile(join(stateDir, "decoder-settings.json"), "utf8"),
		)
		expect(parsed.corrupt).toBe(false)
		if (!parsed.corrupt)
			expect(parsed.file.decoders["test"]?.mode).toBe("always")
		expect(applyDecoderMode).toHaveBeenCalledExactlyOnceWith("test", "always")
		expect(result.pendingRestart).toBe(false)
		await service.update("test", { mode: "always" })
		expect(applyDecoderMode).toHaveBeenCalledTimes(1)
		const reverted = await service.update("test", { mode: null })
		expect(reverted.settings.mode).toEqual({ value: "auto", source: "default" })
	} finally {
		await service.close()
	}
})
it("stale revision rejects a mode patch with today's error code", async () => {
	const { service, applyDecoderMode } = await setup()
	try {
		await expect(
			service.update("test", { mode: "off" }, { ifMatch: 1 }),
		).rejects.toMatchObject({ code: "DECODER_SETTINGS_REVISION_MISMATCH" })
		expect(applyDecoderMode).not.toHaveBeenCalled()
	} finally {
		await service.close()
	}
})
it("applyDecoderMode is not called on a failed persist", async () => {
	const { service, applyDecoderMode, stateDir } = await setup()
	try {
		await rm(stateDir, { recursive: true })
		await writeFile(stateDir, "block directory recreation")
		await expect(service.update("test", { mode: "off" })).rejects.toMatchObject(
			{ code: "DECODER_SETTINGS_STORE_UNAVAILABLE" },
		)
		expect(applyDecoderMode).not.toHaveBeenCalled()
		expect(service.revision()).toBe(0)
	} finally {
		await service.close()
	}
})
it("applyDecoderMode rejecting is logged with fixed fields and the update still succeeds", async () => {
	const { service, applyDecoderMode, log } = await setup()
	applyDecoderMode.mockRejectedValueOnce(new TypeError("untrusted secret"))
	try {
		expect((await service.update("test", { mode: "off" })).revision).toBe(1)
		expect(log.warn).toHaveBeenCalledWith(
			{ err: { type: "TypeError" } },
			"Decoder mode apply failed after persist",
		)
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain(
			"untrusted secret",
		)
	} finally {
		await service.close()
	}
})
it("invalid mode value is DECODER_OPTIONS_INVALID at path mode with no echo of the value", () => {
	for (const mode of ["secret-value", undefined, 42, {}, [], true]) {
		try {
			validateDecoderPatch("direwolf", {}, { mode })
			expect.unreachable()
		} catch (err) {
			expect(err).toMatchObject({
				code: "DECODER_OPTIONS_INVALID",
				issues: [
					{
						path: "mode",
						code: "invalid-value",
						message: "mode must be auto, always, off or null",
					},
				],
			})
		}
	}
})
it("body with only mode is accepted; empty body and unknown keys carry the new fixed messages", () => {
	expect(validateDecoderPatch("direwolf", {}, { mode: "auto" }).mode).toBe(
		"auto",
	)
	for (const [body, message] of [
		[{}, "body must set enabled, options or mode"],
		[{ unknown: true }, "body may only contain enabled, options and mode"],
	] as const) {
		try {
			validateDecoderPatch("direwolf", {}, body)
			expect.unreachable()
		} catch (err) {
			expect(err).toMatchObject({ issues: [{ message }] })
		}
	}
})
it("older store file without mode parses", () => {
	expect(
		parseDecoderSettingsFile(
			JSON.stringify({
				schemaVersion: 1,
				revision: 1,
				decoders: {
					test: {
						type: "direwolf",
						options: {},
						updatedAt: "2026-10-20T00:00:00.000Z",
					},
				},
			}),
		).corrupt,
	).toBe(false)
})

it("mode null removes the override and the view falls back to config", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "wavekit-mode-"))
	dirs.push(stateDir)
	const config = {
		id: "test",
		type: "direwolf",
		enabled: true,
		mode: "always" as const,
		options: {},
	}
	const applyDecoderMode = vi.fn(async () => {})
	const service = await openDecoderSettingsService({
		stateDir,
		logger: stubLogger().logger,
		configs: [config],
		manager: {
			getStatus: () => undefined,
			stageDecoderOptions: () => false,
			isRestartPending: () => true,
		},
		applyDecoderMode,
	})
	try {
		await service.update("test", { mode: "off" })
		const result = await service.update("test", { mode: null })
		expect(result.settings.mode).toEqual({ value: "always", source: "config" })
		expect(result.pendingRestart).toBe(true)
		expect(applyDecoderMode).toHaveBeenLastCalledWith("test", "always")
		const reloaded = await openDecoderSettingsService({
			stateDir,
			logger: stubLogger().logger,
			configs: [config],
		})
		try {
			expect(reloaded.view("test")?.mode?.value).toBe("always")
		} finally {
			await reloaded.close()
		}
	} finally {
		await service.close()
	}
})
it("enabled remains boot-only and stored mode survives reload", async () => {
	const { service, applyDecoderMode, stateDir } = await setup()
	try {
		await service.update("test", { enabled: false })
		expect(applyDecoderMode).not.toHaveBeenCalled()
		await service.update("test", { mode: "always" })
		expect(
			service.effectiveConfig({
				id: "test",
				type: "direwolf",
				enabled: true,
				options: {},
			}).enabled,
		).toBe(false)
		const reloaded = await openDecoderSettingsService({
			stateDir,
			logger: stubLogger().logger,
			configs: [{ id: "test", type: "direwolf", enabled: true, options: {} }],
		})
		try {
			expect(reloaded.view("test")?.mode?.value).toBe("always")
		} finally {
			await reloaded.close()
		}
	} finally {
		await service.close()
	}
})
it("mode layering copies config and ignores retyped overrides", () => {
	const config = {
		id: "test",
		type: "direwolf",
		enabled: true,
		mode: "always" as const,
		options: {},
	}
	const override = {
		type: "direwolf",
		mode: "off" as const,
		options: {},
		updatedAt: "2026-10-20T00:00:00.000Z",
	}
	expect(effectiveDecoderConfig(config, override).mode).toBe("off")
	expect(config.mode).toBe("always")
	expect(
		buildDecoderSettingsView({
			config,
			override: { ...override, type: "rtl433" },
			revision: 1,
			pendingRestart: false,
		}).mode?.value,
	).toBe("always")
})

describe("effectiveDecoderConfig keeps mode precedence", () => {
	const base = { id: "d", type: "direwolf", enabled: true, options: {} }
	it("a stored disable outranks a configured mode", () => {
		const out = effectiveDecoderConfig(
			{ ...base, mode: "always" },
			{
				type: "direwolf",
				enabled: false,
				options: {},
				updatedAt: "2026-10-21T00:00:00.000Z",
			},
		)
		expect(out.mode).toBe("off")
		expect(out.enabled).toBe(false)
	})
	it("a stored mode outranks a stored disable", () => {
		const out = effectiveDecoderConfig(
			{ ...base, mode: "always" },
			{
				type: "direwolf",
				enabled: false,
				mode: "auto",
				options: {},
				updatedAt: "2026-10-21T00:00:00.000Z",
			},
		)
		expect(out.mode).toBe("auto")
	})
	it("without any mode the flattened config has no mode key", () => {
		const out = effectiveDecoderConfig(base, {
			type: "direwolf",
			enabled: false,
			options: {},
			updatedAt: "2026-10-21T00:00:00.000Z",
		})
		expect(Object.hasOwn(out, "mode")).toBe(false)
		expect(out).toEqual({ ...base, enabled: false })
	})
})

describe("view and flattened config agree on the mode", () => {
	// Feature: decoder-enablement, Property 2: Mode precedence
	// Validates: Requirements 2.2
	it("resolving the flattened config matches the settings view", () => {
		const mode = fc.option(fc.constantFrom("auto", "always", "off" as const), {
			nil: undefined,
		})
		const flag = fc.option(fc.boolean(), { nil: undefined })
		fc.assert(
			fc.property(
				mode,
				fc.boolean(),
				flag,
				mode,
				flag,
				(
					configMode,
					configEnabled,
					bandSuspension,
					storedMode,
					storedEnabled,
				) => {
					const config = {
						id: "d",
						type: "direwolf",
						enabled: configEnabled,
						options: {},
						...(configMode === undefined ? {} : { mode: configMode }),
						...(bandSuspension === undefined
							? {}
							: { band: { bandSuspension } }),
					}
					const override = {
						type: "direwolf",
						options: {},
						updatedAt: "2026-10-21T00:00:00.000Z",
						...(storedMode === undefined ? {} : { mode: storedMode }),
						...(storedEnabled === undefined ? {} : { enabled: storedEnabled }),
					}
					const flat = effectiveDecoderConfig(config, override)
					const fromFlat = resolveDecoderMode({
						configEnabled: flat.enabled,
						...(flat.mode === undefined ? {} : { configMode: flat.mode }),
						...(bandSuspension === undefined
							? {}
							: { configBandSuspension: bandSuspension }),
					})
					const view = buildDecoderSettingsView({
						config,
						override,
						revision: 1,
					} as Parameters<typeof buildDecoderSettingsView>[0])
					expect(view.mode?.value).toBe(fromFlat.mode)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("live apply uses the same resolution as the view", () => {
	it.each([
		[{}, "auto"],
		[{ band: { bandSuspension: false } }, "always"],
	] as const)(
		"clearing a stored mode over a configured disable re-enabled in settings (%o)",
		async (extra, expected) => {
			const stateDir = await mkdtemp(join(tmpdir(), "wavekit-mode-"))
			dirs.push(stateDir)
			const applyDecoderMode = vi.fn(async () => {})
			const service = await openDecoderSettingsService({
				stateDir,
				logger: stubLogger().logger,
				configs: [
					{
						id: "test",
						type: "direwolf",
						enabled: false,
						options: {},
						...extra,
					},
				],
				manager: {
					getStatus: () => undefined,
					stageDecoderOptions: () => false,
					isRestartPending: () => false,
				},
				applyDecoderMode,
			})
			await service.update("test", { enabled: true, mode: "always" })
			const cleared = await service.update("test", { mode: null })
			expect(cleared.settings.mode?.value).toBe(expected)
			expect(applyDecoderMode).toHaveBeenLastCalledWith("test", expected)
		},
	)
})
