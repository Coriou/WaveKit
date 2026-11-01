import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { vi } from "vitest"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type {
	ChannelProvider,
	ChannelRequestResult,
} from "../../../../src/core/channelizer/types.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	EfficiencyGate,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { placementKey } from "../../../../src/decoders/enablement/contract.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

/** A channel placement of `decoderId` at `hz` on `sourceId` ("rtl"). */
export const channelPlacement = (
	decoderId: string,
	hz: number,
	sourceId = "rtl",
): WantedPlacement => ({
	key: placementKey(decoderId, sourceId, "channel", hz),
	decoderId,
	sourceId,
	channelHz: hz,
	reach: "channel",
	origin: "configured",
	primary: true,
	costCores: 0.14,
	sampleRateHz: 2_400_000,
})

/**
 * A real DecoderManager on fake timers with `gate`, catalogue decoders
 * `ids` (in-process RateDecoders behind a fake channelizer, no processes or
 * sockets) and the planner's `wanted` placements, changeable via `plan`.
 */
export function gateManager(
	gate: EfficiencyGate,
	ids: readonly string[],
	wanted: WantedPlacement[],
) {
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"))
	const sources = new FakeSources()
	for (const sourceId of new Set(["rtl", ...wanted.map(p => p.sourceId)]))
		sources.caps.set(sourceId, {
			...iqCaps(2_400_000),
			centerFreq: 162_000_000,
		})
	const registry = new DecoderRegistry()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	registry.register(
		"rate-test",
		config => {
			const decoder: RateDecoder & Pick<Decoder, "getChannelRequest"> =
				new RateDecoder(config.id, caps)
			decoder.getChannelRequest = () => ({
				centerHz: 162_000_000,
				bandwidthHz: 12_500,
				transitionHz: 2_500,
				outputRateHz: 48_000,
				format: "cu8" as const,
			})
			return decoder
		},
		caps,
	)
	let plan = wanted
	const logger = pino({ level: "silent" })
	const manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		logger,
		{
			validateVersions: false,
			enablement: {
				planner: () => ({ wanted: plan, unplaced: new Map() }),
				gate,
				resolveMode: () => ({ mode: "auto", source: "default" }),
				isCatalogue: () => true,
				unavailable: () => false,
				recheckAvailable: async () => true,
				vfo: () => null,
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
			},
		},
	)
	manager.setSourceManager(sources as unknown as SourceManager)
	let channel = 0
	manager.setChannelizer(
		Object.assign(new EventEmitter(), {
			requestChannel: vi.fn(
				async (): Promise<ChannelRequestResult> => ({
					ok: true as const,
					stream: new PassThrough(),
					channelId: String(++channel),
					generation: 1,
					realised: {
						outputRateHz: 48_000,
						format: "cu8" as const,
						groupDelaySamples: 0,
					},
				}),
			),
			releaseChannel: vi.fn(async () => {}),
			currentGeneration: () => 1,
			retuneChannel: vi.fn(async () => "retuned" as const),
		}) as unknown as ChannelProvider,
	)
	for (const id of ids)
		manager.createDecoder({
			id,
			type: "rate-test",
			enabled: true,
			options: {},
			useChannelizer: true,
		})
	return {
		manager,
		plan: (placements: WantedPlacement[]) => {
			plan = placements
		},
		settle: async () => {
			manager.notifyBandplansChanged()
			await vi.advanceTimersByTimeAsync(350)
		},
	}
}
