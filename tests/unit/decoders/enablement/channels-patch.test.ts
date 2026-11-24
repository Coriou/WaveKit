/**
 * A patched `channelsHz` list decodes the listed channels (PATCH /api/decoders/:id through the real
 * route, settings service and DecoderManager with the real planner), a core that cannot place
 * channels refuses it, and a refused placement key names the patchable alternative.
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
}: { channelizer?: boolean; enablement?: boolean } = {}) {
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	registry.register(
		"dsd-fme",
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
	// A YAML dsd-fme: no useChannelizer, no explicit channel.
	const config: DecoderConfig = {
		id: "voice",
		type: "dsd-fme",
		enabled: true,
		sourceId: "rtl",
		options: {},
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
	const patch = (options: Record<string, unknown>) =>
		app.inject({
			method: "PATCH",
			url: "/api/decoders/voice",
			payload: { options },
		})
	return { manager, provider, patch }
}

interface Field {
	field: string
	expected: string
}

it("a patched channelsHz list decodes the listed channels, not the capture centre", async () => {
	const f = await setup()
	await f.manager.startAll()
	const response = await f.patch({ channelsHz: CHANNELS })
	expect(response.statusCode).toBe(200)
	await f.manager.restartDecoder("voice")
	await vi.waitFor(() =>
		expect(f.manager.getStatus("voice")?.targetFrequenciesHz).toEqual(CHANNELS),
	)
	const placements = f.manager.getStatus("voice")?.placements ?? []
	expect(
		placements.map(p => ({
			reach: p.reach,
			origin: p.origin,
			channelHz: p.channelHz,
		})),
	).toEqual(
		CHANNELS.map(hz => ({
			reach: "channel",
			origin: "configured",
			channelHz: hz,
		})),
	)
	expect(f.provider.requestChannel).toHaveBeenCalled()
})

it.each([
	[{ channelizer: false }, "channelizer"],
	[{ enablement: false }, "placements"],
])(
	"a core that cannot place channels (%j) refuses channelsHz and says why",
	async (opts, reason) => {
		const f = await setup(opts)
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
		expect(field?.expected).toContain(reason)
		expect(field?.expected).toContain("channelHz or offsetHz")
		// Nothing was stored: reverting stays allowed.
		expect((await f.patch({ channelsHz: null })).statusCode).toBe(200)
	},
)

it("offsetHz stays a config-file key and its refusal names channelsHz and the patchable keys", async () => {
	const f = await setup()
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
	// The hinted fix: the same channel as an absolute channelsHz entry.
	expect((await f.patch({ channelsHz: [CENTRE + 25_000] })).statusCode).toBe(
		200,
	)
})
