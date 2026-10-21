import { expect, it, vi } from "vitest"
import fc from "fast-check"
import type * as StoreModule from "../../../../src/decoders/settings/store.js"
import type { DecoderSettingsFile } from "../../../../src/decoders/settings/store.js"
import { openDecoderSettingsService } from "../../../../src/decoders/settings/service.js"
import { stubLogger } from "../../core/station/helpers.js"

vi.mock("../../../../src/decoders/settings/store.js", async importOriginal => {
	const original = await importOriginal<typeof StoreModule>()
	return {
		...original,
		openDecoderSettingsStore: () => {
			let file: DecoderSettingsFile = {
				schemaVersion: 1,
				revision: 0,
				decoders: {},
			}
			return Promise.resolve({
				snapshot: () => file,
				revision: () => file.revision,
				write: (next: DecoderSettingsFile) => {
					file = structuredClone(next)
					return Promise.resolve()
				},
				close: () => Promise.resolve(),
			})
		},
	}
})

// Feature: decoder-enablement, Property 12: Live mode
// Validates: Requirements 2.4, 2.5
it("successful mode sequences increment revision and apply only changed modes", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.constantFrom(
					"auto" as const,
					"always" as const,
					"off" as const,
					null,
				),
				{ maxLength: 5 },
			),
			async modes => {
				const stateDir = "unused-in-memory-store"
				const applyDecoderMode = vi.fn(async () => {})
				const service = await openDecoderSettingsService({
					stateDir,
					logger: stubLogger().logger,
					configs: [
						{ id: "test", type: "direwolf", enabled: true, options: {} },
					],
					manager: {
						getStatus: () => undefined,
						stageDecoderOptions: () => false,
						isRestartPending: () => false,
					},
					applyDecoderMode,
				})
				try {
					let previous: string | null = null
					for (const mode of modes) {
						const revision = service.revision()
						const calls = applyDecoderMode.mock.calls.length
						const result = await service.update("test", { mode })
						expect(result.revision).toBe(revision + 1)
						expect(result.settings.mode?.value).toBe(mode ?? "auto")
						expect(applyDecoderMode).toHaveBeenCalledTimes(
							calls + (mode !== previous ? 1 : 0),
						)
						if (mode !== previous)
							expect(applyDecoderMode).toHaveBeenLastCalledWith(
								"test",
								mode ?? "auto",
							)
						const successfulCalls = applyDecoderMode.mock.calls.length
						previous = mode
						await expect(
							service.update("test", { mode: "invalid" }),
						).rejects.toMatchObject({ code: "DECODER_OPTIONS_INVALID" })
						expect(service.revision()).toBe(revision + 1)
						expect(applyDecoderMode).toHaveBeenCalledTimes(successfulCalls)
					}
				} finally {
					await service.close()
				}
			},
		),
		{ numRuns: 100 },
	)
})
