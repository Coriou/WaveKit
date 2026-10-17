import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { DecoderSettingValue, DecoderStatus } from "@wavekit/api-types"
import { DECODER_SETTINGS_FILE_NAME } from "@wavekit/api-types"
import type { DecoderSettingsManagerPort } from "../../../../src/decoders/settings/contract.js"
import { DecoderSettingsError } from "../../../../src/decoders/settings/contract.js"
import { openDecoderSettingsService } from "../../../../src/decoders/settings/service.js"
import { resolveDecoderTargetFrequencies } from "../../../../src/decoders/status-fields.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { makeTmp, removeTmp, stubLogger } from "../../core/station/helpers.js"

class FakePort implements DecoderSettingsManagerPort {
	readonly staged: Array<{
		id: string
		options: Record<string, DecoderSettingValue | null>
	}> = []
	readonly owners = new Map<string, "config" | "scanner">()
	pending = false

	getStatus(id: string): DecoderStatus | undefined {
		const owner = this.owners.get(id)
		return owner === undefined
			? undefined
			: ({ id, owner } as unknown as DecoderStatus)
	}
	stageDecoderOptions(
		id: string,
		options: Readonly<Record<string, DecoderSettingValue | null>>,
	): boolean {
		this.staged.push({ id, options: { ...options } })
		this.pending = true
		return true
	}
	isRestartPending(): boolean {
		return this.pending
	}
}

const ISM: DecoderConfig = {
	id: "ism",
	type: "rtl433",
	enabled: true,
	options: {
		frequency: 433_920_000,
		extraArgs: ["-M", "level"],
		mystery: 3,
	},
}
const PROBE: DecoderConfig = {
	id: "probe-1",
	type: "rtl433",
	enabled: false,
	options: {},
}

let stateDir: string
let port: FakePort

beforeEach(async () => {
	stateDir = await makeTmp()
	port = new FakePort()
	port.owners.set("ism", "config")
	port.owners.set("probe-1", "scanner")
})

afterEach(async () => {
	await chmod(stateDir, 0o700).catch(() => undefined)
	await removeTmp(stateDir)
})

async function open(withPort = true, configs = [ISM, PROBE]) {
	const service = await openDecoderSettingsService({
		configs,
		stateDir,
		logger: stubLogger().logger,
		...(withPort ? { manager: port } : {}),
		now: () => Date.parse("2026-10-16T12:00:00.000Z"),
	})
	return service
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p
	} catch (err) {
		if (err instanceof DecoderSettingsError) return err.code
		throw err
	}
	throw new Error("expected a rejection")
}

async function writeStored(decoders: Record<string, unknown>, revision = 5) {
	await writeFile(
		join(stateDir, DECODER_SETTINGS_FILE_NAME),
		JSON.stringify({ schemaVersion: 1, revision, decoders }),
	)
}

describe("decoder settings service", () => {
	it("stages override values, persists and reports changes", async () => {
		const service = await open()
		const result = await service.update("ism", {
			enabled: false,
			options: { frequency: 868_000_000, analyze: true },
		})
		expect(result.revision).toBe(1)
		expect(result.changed).toEqual(["enabled", "analyze", "frequency"])
		expect(result.pendingRestart).toBe(true)
		expect(port.staged).toEqual([
			{ id: "ism", options: { frequency: 868_000_000, analyze: true } },
		])
		expect(result.settings.enabled).toEqual({
			value: false,
			source: "override",
		})
		const file = JSON.parse(
			await readFile(join(stateDir, DECODER_SETTINGS_FILE_NAME), "utf8"),
		) as { revision: number; decoders: Record<string, unknown> }
		expect(file.revision).toBe(1)
		expect(file.decoders["ism"]).toEqual({
			type: "rtl433",
			enabled: false,
			options: { frequency: 868_000_000, analyze: true },
			updatedAt: "2026-10-16T12:00:00.000Z",
		})
		const effective = service.effectiveConfig(ISM)
		expect(effective.enabled).toBe(false)
		expect(effective.options["frequency"]).toBe(868_000_000)
		expect(ISM.options["frequency"]).toBe(433_920_000)
		await service.close()
	})

	it("a revert stages the configured value, null when neither sets it, and removes the entry", async () => {
		const service = await open()
		await service.update("ism", {
			options: { frequency: 868_000_000, analyze: true },
		})
		const result = await service.update("ism", {
			options: { frequency: null, analyze: null },
		})
		expect(port.staged[1]).toEqual({
			id: "ism",
			options: { frequency: 433_920_000, analyze: null },
		})
		expect(result.changed).toEqual(["analyze", "frequency"])
		const file = JSON.parse(
			await readFile(join(stateDir, DECODER_SETTINGS_FILE_NAME), "utf8"),
		) as { decoders: Record<string, unknown> }
		expect(file.decoders).toEqual({})
		expect(service.effectiveConfig(ISM)).toEqual(ISM)
		await service.close()
	})

	it("changed omits keys whose effective value is the same", async () => {
		const service = await open()
		const result = await service.update("ism", {
			options: { frequency: 433_920_000 },
		})
		expect(result.changed).toEqual([])
		expect(
			result.settings.options.find(o => o.key === "frequency")?.source,
		).toBe("override")
		await service.close()
	})

	it("If-Match mismatch answers 412 before validation", async () => {
		const service = await open()
		expect(
			await codeOf(
				service.update(
					"ism",
					{ options: { port: 1 }, bogus: true },
					{ ifMatch: 9 },
				),
			),
		).toBe("DECODER_SETTINGS_REVISION_MISMATCH")
		const ok = await service.update(
			"ism",
			{ options: { analyze: true } },
			{ ifMatch: 0 },
		)
		expect(ok.revision).toBe(1)
		await service.close()
	})

	it("refuses invalid and non-patchable bodies without change", async () => {
		const service = await open()
		expect(
			await codeOf(service.update("ism", { options: { extraArgs: ["-x"] } })),
		).toBe("DECODER_OPTION_NOT_PATCHABLE")
		expect(await codeOf(service.update("ism", { nope: 1 }))).toBe(
			"DECODER_OPTIONS_INVALID",
		)
		expect(service.revision()).toBe(0)
		expect(port.staged).toEqual([])
		await service.close()
	})

	it("STORE_UNAVAILABLE before setManager, for probes and unknown ids", async () => {
		const service = await open(false)
		const body = { options: { analyze: true } }
		expect(await codeOf(service.update("ism", body))).toBe(
			"DECODER_SETTINGS_STORE_UNAVAILABLE",
		)
		expect(service.view("ism")?.pendingRestart).toBe(false)
		service.setManager(port)
		expect(await codeOf(service.update("probe-1", body))).toBe(
			"DECODER_SETTINGS_STORE_UNAVAILABLE",
		)
		expect(await codeOf(service.update("nope", body))).toBe(
			"DECODER_SETTINGS_STORE_UNAVAILABLE",
		)
		expect(service.view("probe-1")).toBeUndefined()
		expect(service.view("nope")).toBeUndefined()
		expect((await service.update("ism", body)).revision).toBe(1)
		await service.close()
	})

	it("a write failure leaves view, revision and staging unchanged", async () => {
		const service = await open()
		const viewBefore = service.view("ism")
		await chmod(stateDir, 0o500)
		expect(
			await codeOf(service.update("ism", { options: { analyze: true } })),
		).toBe("DECODER_SETTINGS_STORE_UNAVAILABLE")
		expect(service.revision()).toBe(0)
		expect(service.view("ism")).toEqual(viewBefore)
		expect(port.staged).toEqual([])
		expect(service.effectiveConfig(ISM)).toEqual(ISM)
		await chmod(stateDir, 0o700)
		expect(
			(await service.update("ism", { options: { analyze: true } })).revision,
		).toBe(1)
		await service.close()
	})

	it("serialises concurrent updates; If-Match sees the previous write", async () => {
		const service = await open()
		const [a, b, c] = await Promise.allSettled([
			service.update("ism", { options: { analyze: true } }, { ifMatch: 0 }),
			service.update("ism", { options: { frequency: 1e8 } }, { ifMatch: 1 }),
			service.update("ism", { options: { analyze: false } }, { ifMatch: 1 }),
		])
		expect(a.status === "fulfilled" && a.value.revision).toBe(1)
		expect(b.status === "fulfilled" && b.value.revision).toBe(2)
		expect(c.status).toBe("rejected")
		expect(service.revision()).toBe(2)
		const opts = service.effectiveConfig(ISM).options
		expect(opts["analyze"]).toBe(true)
		expect(opts["frequency"]).toBe(1e8)
		await service.close()
	})

	it("flags a retyped entry and replaces it on PATCH; counts orphans", async () => {
		await writeStored({
			ism: {
				type: "acarsdec",
				enabled: false,
				options: { frequency: 1 },
				updatedAt: "2026-10-01T00:00:00.000Z",
			},
			gone: {
				type: "rtl433",
				options: { analyze: true },
				updatedAt: "2026-10-01T00:00:00.000Z",
			},
		})
		const service = await open()
		expect(service.ignored()).toEqual({ orphans: 1, retyped: 1 })
		expect(service.view("ism")?.overrideIgnored).toBe("type-changed")
		expect(service.effectiveConfig(ISM)).toEqual(ISM)
		const result = await service.update("ism", { options: { analyze: true } })
		expect(result.revision).toBe(6)
		expect(result.settings.overrideIgnored).toBeUndefined()
		expect(result.settings.enabled).toEqual({ value: true, source: "config" })
		const file = JSON.parse(
			await readFile(join(stateDir, DECODER_SETTINGS_FILE_NAME), "utf8"),
		) as { decoders: Record<string, { type: string; options: unknown }> }
		expect(file.decoders["ism"]?.type).toBe("rtl433")
		expect(file.decoders["ism"]?.options).toEqual({ analyze: true })
		expect(file.decoders["gone"]).toBeDefined()
		await service.close()
	})

	it("drops a stored non-patchable key on load without rewriting the file", async () => {
		await writeStored({
			ism: {
				type: "rtl433",
				options: { extraArgs: ["-x"], outputFormat: "csv", analyze: true },
				updatedAt: "2026-10-01T00:00:00.000Z",
			},
		})
		const raw = await readFile(
			join(stateDir, DECODER_SETTINGS_FILE_NAME),
			"utf8",
		)
		const { logger, warn } = stubLogger()
		const service = await openDecoderSettingsService({
			configs: [ISM],
			stateDir,
			logger,
		})
		const effective = service.effectiveConfig(ISM)
		expect(effective.options["extraArgs"]).toEqual(["-M", "level"])
		expect(effective.options).not.toHaveProperty("outputFormat")
		expect(effective.options["analyze"]).toBe(true)
		expect(warn).toHaveBeenCalledWith(
			{ dropped: 2, shadowed: 0 },
			expect.any(String),
		)
		expect(
			await readFile(join(stateDir, DECODER_SETTINGS_FILE_NAME), "utf8"),
		).toBe(raw)
		await service.close()
	})

	it("view never names undocumented keys nor non-patchable values", async () => {
		const service = await open()
		const view = service.view("ism")
		expect(view?.undocumentedKeys).toBe(1)
		const json = JSON.stringify(view)
		expect(json).not.toContain("mystery")
		expect(json).not.toContain("level")
		await service.close()
	})
})

describe("decoder settings service review regressions", () => {
	const readDisk = async () =>
		JSON.parse(
			await readFile(join(stateDir, DECODER_SETTINGS_FILE_NAME), "utf8"),
		) as { revision: number; decoders: Record<string, unknown> }

	it.each(["__proto__", "constructor", "prototype"])(
		"refuses the prototype id %s and never writes it",
		async id => {
			const config: DecoderConfig = {
				id,
				type: "rtl433",
				enabled: true,
				options: { frequency: 433_920_000 },
			}
			port.owners.set(id, "config")
			const service = await open(true, [ISM, config])
			expect(
				await codeOf(service.update(id, { options: { analyze: true } })),
			).toBe("DECODER_SETTINGS_STORE_UNAVAILABLE")
			expect(service.revision()).toBe(0)
			expect(Object.getPrototypeOf({})).toBe(Object.prototype)
			const effective = service.effectiveConfig(config)
			expect(effective).not.toBe(config)
			expect(effective).toEqual(config)
			// Another decoder still persists normally and the bad id never reaches the disk.
			await service.update("ism", { options: { analyze: true } })
			const disk = await readDisk()
			expect(Object.keys(disk.decoders)).toEqual(["ism"])
			await service.close()
		},
	)

	it("accepts 65 and 256 rtl433 protocols end to end; 257 stored items are corrupt", async () => {
		const list = (n: number) => Array.from({ length: n }, (_, i) => i)
		const service = await open()
		for (const n of [65, 256]) {
			await service.update("ism", { options: { protocols: list(n) } })
			expect(service.effectiveConfig(ISM).options["protocols"]).toEqual(list(n))
			const disk = (await readDisk()).decoders["ism"] as {
				options: { protocols: number[] }
			}
			expect(disk.options.protocols).toHaveLength(n)
		}
		await service.close()
		const reopened = await open()
		expect(reopened.effectiveConfig(ISM).options["protocols"]).toEqual(
			list(256),
		)
		await reopened.close()

		await writeStored({
			ism: {
				type: "rtl433",
				options: { protocols: list(257) },
				updatedAt: "2026-10-01T00:00:00.000Z",
			},
		})
		const corrupt = await open()
		expect(corrupt.effectiveConfig(ISM).options).not.toHaveProperty("protocols")
		expect(corrupt.revision()).toBeGreaterThan(5)
		await corrupt.close()
	})

	it("persists other applied entries sanitized; orphan entries stay as stored", async () => {
		const ISM2: DecoderConfig = { ...ISM, id: "ism2" }
		port.owners.set("ism2", "config")
		const orphan = {
			type: "rtl433",
			options: { outputFormat: "csv" },
			updatedAt: "2026-10-01T00:00:00.000Z",
		}
		await writeStored({
			ism: {
				type: "rtl433",
				options: { outputFormat: "csv", analyze: true },
				updatedAt: "2026-10-01T00:00:00.000Z",
			},
			gone: orphan,
		})
		const service = await open(true, [ISM, ISM2])
		await service.update("ism2", { options: { analyze: true } })
		const disk = await readDisk()
		expect(disk.decoders["ism"]).toEqual({
			type: "rtl433",
			options: { analyze: true },
			updatedAt: "2026-10-01T00:00:00.000Z",
		})
		expect(disk.decoders["gone"]).toEqual(orphan)
		await service.close()
	})

	it("normalises -0 in memory and staging to the committed 0", async () => {
		const DSD: DecoderConfig = {
			id: "dsd",
			type: "dsd-fme",
			enabled: true,
			options: { frequency: 851_000_000 },
		}
		port.owners.set("dsd", "config")
		const service = await open(true, [DSD])
		await service.update("dsd", { options: { fmGain: -0 } })
		const staged = port.staged.at(-1)?.options["fmGain"]
		expect(Object.is(staged, 0)).toBe(true)
		const effective = service.effectiveConfig(DSD).options["fmGain"]
		expect(Object.is(effective, 0)).toBe(true)
		const view = service.view("dsd")
		const setting = view?.options.find(o => o.key === "fmGain")
		expect(Object.is(setting?.value, 0)).toBe(true)
		await service.close()
	})
})

describe("frequency keys shadowed by a higher-priority source (WG8 R1)", () => {
	const acars = (top?: number[]): DecoderConfig => ({
		id: "acars",
		type: "acarsdec",
		enabled: true,
		...(top ? { frequencies: top } : {}),
		options: { frequencies: [131_550_000] },
	})

	async function refusal(p: Promise<unknown>): Promise<DecoderSettingsError> {
		try {
			await p
		} catch (err) {
			if (err instanceof DecoderSettingsError) return err
			throw err
		}
		throw new Error("expected a rejection")
	}

	beforeEach(() => port.owners.set("acars", "config"))

	it("top-level frequencies: PATCH options.frequencies is refused and the view says not patchable", async () => {
		const config = acars([131_550_000])
		const service = await open(true, [config])
		const err = await refusal(
			service.update("acars", { options: { frequencies: [131_725_000] } }),
		)
		expect(err.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
		expect(err.message).toBe("Option not patchable")
		expect(JSON.stringify(err)).not.toContain("131725000")
		expect(port.staged).toEqual([])
		expect(service.revision()).toBe(0)
		const view = service.view("acars")
		const setting = view?.options.find(o => o.key === "frequencies")
		expect(setting?.patchable).toBe(false)
		expect(setting).not.toHaveProperty("value")
		expect(view?.options.find(o => o.key === "frequency")?.patchable).toBe(
			false,
		)
		await service.close()
	})

	it("options.frequencies shadows options.frequency; a same-patch frequencies does too", async () => {
		const service = await open(true, [acars()])
		expect(
			(await refusal(service.update("acars", { options: { frequency: 1e8 } })))
				.code,
		).toBe("DECODER_OPTION_NOT_PATCHABLE")
		expect(
			service.view("acars")?.options.find(o => o.key === "frequency")
				?.patchable,
		).toBe(false)
		// A revert of a shadowed key stays allowed.
		await service.update("acars", { options: { frequency: null } })
		await service.close()
	})

	it("without top-level frequencies the PATCH is accepted and changes the resolved targets", async () => {
		const config = acars()
		const service = await open(true, [config])
		const view = service.view("acars")
		expect(view?.options.find(o => o.key === "frequencies")?.patchable).toBe(
			true,
		)
		const result = await service.update("acars", {
			options: { frequencies: [131_725_000] },
		})
		expect(result.changed).toEqual(["frequencies"])
		expect(port.staged).toEqual([
			{ id: "acars", options: { frequencies: [131_725_000] } },
		])
		expect(resolveDecoderTargetFrequencies(config)).toEqual([131_550_000])
		expect(
			resolveDecoderTargetFrequencies(service.effectiveConfig(config)),
		).toEqual([131_725_000])
		// The manager's rebuild applies the staged options over the configured ones.
		const rebuilt: DecoderConfig = {
			...config,
			options: { ...config.options, ...port.staged[0]!.options },
		}
		expect(resolveDecoderTargetFrequencies(rebuilt)).toEqual([131_725_000])
		await service.close()
	})
})
