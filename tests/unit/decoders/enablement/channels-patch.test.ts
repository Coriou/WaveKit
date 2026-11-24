/**
 * `channelsHz` at runtime (PATCH /api/decoders/:id through the real route, settings service and
 * DecoderManager with the real planner): a YAML decoder without `useChannelizer: true` refuses a
 * channel list and names the supported ways; a decoder with `useChannelizer: true` and channelsHz
 * in its config places the listed channels; and a YAML list without `useChannelizer` keeps the base
 * placement (one raw placement at the capture centre) across a retune.
 */
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { afterEach, expect, it, vi } from "vitest"
import { decoderRoutes } from "../../../../src/api/routes/decoders.js"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { EfficiencyGate } from "../../../../src/decoders/enablement/contract.js"
import { planPlacements } from "../../../../src/decoders/enablement/placement.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { openDecoderSettingsService } from "../../../../src/decoders/settings/service.js"
import type { Decoder, DecoderConfig } from "../../../../src/decoders/types.js"
import { decoderSettingsPort } from "../../../../src/index.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

const CENTRE = 446_100_000
const CHANNELS = [446_025_000, 446_075_000]
const logger = pino({ level: "silent" })
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step()
	vi.useRealTimers()
})

async function setup({
	channelizer = true,
	enablement = true,
	type = "dsd-fme",
	voice = {},
}: {
	channelizer?: boolean
	enablement?: boolean
	type?: string
	voice?: Partial<DecoderConfig>
} = {}) {
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	registry.register(
		type,
		config => {
			const decoder: RateDecoder & Pick<Decoder, "getChannelRequest"> =
				new RateDecoder(config.id, {
					input: "iq",
					output: "text",
					integrationPattern: "pure_consumer",
				})
			let applied = { ...config.options }
			decoder.updateOptions = updates => {
				applied = { ...applied, ...updates }
				config.options = applied
			}
			decoder.getChannelRequest = input => ({
				centerHz: (applied["channelHz"] as number) ?? input.centerHz ?? 0,
				bandwidthHz: 12_500,
				transitionHz: 2_500,
				outputRateHz: 48_000,
				format: "cf32",
			})
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>(() => ({ admit: true })),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 0, cpuGuardPercent: 90, sources: [] }),
	}
	const manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		logger,
		{
			validateVersions: false,
			...(enablement
				? {
						enablement: {
							planner: planPlacements,
							gate,
							resolveMode: () => ({ mode: "auto", source: "default" }),
							isCatalogue: () => false,
							unavailable: () => false,
							recheckAvailable: async () => true,
							vfo: () => null,
							bandplanChannels: () => [],
							maxBandplanChannels: 4,
						},
					}
				: {}),
		},
	)
	cleanup.push(() => manager.destroy())
	manager.setSourceManager(sources as unknown as SourceManager)
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(async () => ({
			ok: true,
			stream: new PassThrough(),
			channelId: "one",
			generation: 1,
			realised: { outputRateHz: 48_000, format: "cf32", groupDelaySamples: 0 },
		})),
		releaseChannel: vi.fn(async () => {}),
		currentGeneration: () => 1,
		retuneChannel: vi.fn(async () => "retuned"),
	})
	if (channelizer)
		manager.setChannelizer(provider as unknown as ChannelProvider)
	// A YAML decoder (dsd-fme by default): no useChannelizer, no explicit channel, unless `voice` says so.
	const config: DecoderConfig = {
		id: "voice",
		type,
		enabled: true,
		sourceId: "rtl",
		options: {},
		...voice,
	}
	manager.createDecoder(config)
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-channels-patch-"))
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
	const settings = await openDecoderSettingsService({
		configs: [config],
		stateDir: root,
		logger,
	})
	settings.setManager(decoderSettingsPort(manager))
	cleanup.push(() => settings.close())
	const app: FastifyInstance = Fastify()
	cleanup.push(() => app.close())
	await app.register(decoderRoutes, {
		decoderManager: manager,
		settings,
		authorizeSettings: () => undefined,
	})
	await app.ready()
	const patch = (
		options: Record<string, unknown>,
		headers: Record<string, string> = {},
	) =>
		app.inject({
			method: "PATCH",
			url: "/api/decoders/voice",
			payload: { options },
			headers,
		})
	return { manager, provider, patch, settings, sources }
}

interface Field {
	field: string
	expected: string
}

type Fixture = Awaited<ReturnType<typeof setup>>

const placementSet = (f: Fixture) =>
	(f.manager.getStatus("voice")?.placements ?? []).map(p => ({
		sourceId: p.sourceId,
		reach: p.reach,
		origin: p.origin,
		primary: p.primary,
		channelHz: p.channelHz,
	}))

it("a YAML decoder without useChannelizer refuses a channelsHz list and names the supported ways", async () => {
	const f = await setup()
	await f.manager.startAll()
	const before = placementSet(f)
	const response = await f.patch({ channelsHz: CHANNELS })
	expect(response.statusCode).toBe(400)
	const body = response.json<{
		code: string
		keys: string[]
		fields: Field[]
	}>()
	expect(body.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
	expect(body.keys).toEqual(["channelsHz"])
	const field = body.fields.find(x => x.field === "options.channelsHz")
	expect(field?.expected).toContain("useChannelizer: true")
	expect(field?.expected).toContain("YAML config")
	expect(field?.expected).toContain("activity slots")
	// Nothing was stored or replanned, and reverting stays allowed.
	expect(
		(
			f.settings.view("voice")?.options as Record<string, unknown> | undefined
		)?.["channelsHz"],
	).toBeUndefined()
	expect(placementSet(f)).toEqual(before)
	expect((await f.patch({ channelsHz: null })).statusCode).toBe(200)
})

it("the hinted way: useChannelizer: true with channelsHz in the config places the listed channels", async () => {
	const f = await setup({
		voice: { useChannelizer: true, options: { channelsHz: CHANNELS } },
	})
	await f.manager.startAll()
	await vi.waitFor(() =>
		expect(f.manager.getStatus("voice")?.targetFrequenciesHz).toEqual(CHANNELS),
	)
	expect(placementSet(f)).toEqual(
		CHANNELS.map((hz, i) => ({
			sourceId: "rtl",
			reach: "channel",
			origin: "configured",
			primary: i === 0,
			channelHz: hz,
		})),
	)
	expect(f.provider.requestChannel).toHaveBeenCalled()
	// Such a decoder keeps the runtime patch: a new list is accepted.
	const moved = [446_150_000]
	expect((await f.patch({ channelsHz: moved })).statusCode).toBe(200)
})

it("a YAML channelsHz list without useChannelizer keeps the base placement across a retune: one raw input, no channels", async () => {
	const f = await setup({ voice: { options: { channelsHz: CHANNELS } } })
	await f.manager.startAll()
	// Base (no runtime opt-in): the list does not make placements; the decoder reads the raw capture.
	const raw = [
		{
			sourceId: "rtl",
			reach: "raw",
			origin: "configured",
			primary: true,
			channelHz: undefined,
		},
	]
	await vi.waitFor(() => expect(placementSet(f)).toEqual(raw))
	f.sources.setCenter("rtl", 446_500_000)
	await f.manager.restartDecoder("voice")
	await vi.waitFor(() =>
		expect(f.manager.getStatus("voice")?.running).toBe(true),
	)
	expect(placementSet(f)).toEqual(raw)
	expect(f.provider.requestChannel).not.toHaveBeenCalled()
})

it("a stale If-Match is a 412 before the channel-list refusal; the current revision gets the refusal", async () => {
	const f = await setup()
	const current = f.settings.revision()
	const stale = await f.patch(
		{ channelsHz: CHANNELS },
		{ "if-match": `"${current + 1}"` },
	)
	expect(stale.statusCode).toBe(412)
	expect(stale.json<{ code: string }>().code).toBe(
		"DECODER_SETTINGS_REVISION_MISMATCH",
	)
	const fresh = await f.patch(
		{ channelsHz: CHANNELS },
		{ "if-match": `"${current}"` },
	)
	expect(fresh.statusCode).toBe(400)
	expect(fresh.json<{ code: string }>().code).toBe(
		"DECODER_OPTION_NOT_PATCHABLE",
	)
})

it("offsetHz stays a config-file key and its refusal names channelsHz and the patchable keys", async () => {
	const f = await setup({ voice: { useChannelizer: true } })
	for (const key of ["offsetHz", "channelHz"]) {
		const response = await f.patch({ [key]: 25_000 })
		expect(response.statusCode).toBe(400)
		const body = response.json<{ code: string; fields: Field[] }>()
		expect(body.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
		const field = body.fields.find(x => x.field === `options.${key}`)
		expect(field?.expected).toContain("set channelsHz")
		expect(field?.expected).toMatch(
			/runtime-changeable options of this decoder: .*channelsHz/,
		)
		// Never echoes the value sent.
		expect(response.body).not.toContain("25000")
	}
	// The hinted fix on a useChannelizer decoder: the same channel as an absolute channelsHz entry.
	expect((await f.patch({ channelsHz: [CENTRE + 25_000] })).statusCode).toBe(
		200,
	)
})

it("an empty or malformed channelsHz is no channel list: the settings service answers, not the refusal", async () => {
	const f = await setup()
	const empty = await f.patch({ channelsHz: [] })
	expect(empty.json<{ code?: string }>().code).not.toBe(
		"DECODER_OPTION_NOT_PATCHABLE",
	)
	for (const value of ["abc", ["abc"], [CENTRE, "abc"]]) {
		const response = await f.patch({ channelsHz: value })
		expect(response.statusCode).toBe(400)
		expect(response.json<{ code: string }>().code).toBe(
			"DECODER_OPTIONS_INVALID",
		)
	}
})

it.each(["acarsdec", "readsb"])(
	"a %s decoder (no channelsHz option) gets the normal patch-policy answer, never a named channelsHz refusal",
	async type => {
		const f = await setup({ type, channelizer: false })
		const response = await f.patch({ channelsHz: CHANNELS })
		expect(response.statusCode).toBe(400)
		const body = response.json<{
			code: string
			keys?: string[]
			unknownKeys?: number
			fields: Field[]
		}>()
		expect(body.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
		expect(body.keys ?? []).not.toContain("channelsHz")
		expect(body.unknownKeys).toBe(1)
		expect(body.fields.map(x => x.field)).not.toContain("options.channelsHz")
		expect(response.body).not.toContain("cannot be set at runtime")
	},
)
