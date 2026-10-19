/**
 * Messages between SpectrumEngine (main thread) and the spectrum worker.
 * Inbound worker messages are validated with Zod; outbound events are
 * produced by SpectrumPipeline and only checked for their envelope.
 */
import { SPECTRUM_SUMMARY_BINS_MAX } from "@wavekit/api-types"
import { z } from "zod"
import {
	CHANNEL_GATE_MAX_SLOTS,
	CHANNEL_GATE_MAX_WIDTH_HZ,
	CHANNEL_GATE_MIN_WIDTH_HZ,
	type ChannelPlan,
} from "../scanner/scanner-redesign-contract.js"
import type { ArtefactMasks } from "./artefacts.js"
import { EngineStateSchema } from "./engine-state.js"
import { wireEventProblem } from "./summary-wire.js"
import type {
	EngineState,
	PipelineConfig,
	PipelineEvent,
	PipelineInput,
} from "./types.js"

const FreqRangeSchema = z.object({ startHz: z.number(), endHz: z.number() })

const channelWidthHz = z
	.number()
	.finite()
	.min(CHANNEL_GATE_MIN_WIDTH_HZ)
	.max(CHANNEL_GATE_MAX_WIDTH_HZ)

const ChannelPlanEntrySchema = z.object({
	startHz: z.number().finite(),
	endHz: z.number().finite(),
	widthHz: channelWidthHz,
	rasterHz: z.number().finite().nullable(),
	firstChannelHz: z.number().finite().nullable(),
	burst: z.boolean(),
	rangeKey: z.string(),
})

const ChannelPlanBodySchema = z.object({
	sourceId: z.string(),
	entries: z.array(ChannelPlanEntrySchema).max(CHANNEL_GATE_MAX_SLOTS),
	defaultWidthHz: channelWidthHz,
})

const RasterSchema = z.object({
	spacingHz: z.number().positive(),
	firstChannelHz: z.number(),
})
const TuningTrustSchema = z.enum(["commanded", "relay", "unverified"])

export const PipelineConfigSchema = z.object({
	sourceId: z.string().min(1),
	format: z.enum(["U8_IQ", "S16_IQ", "FLOAT32LE"]),
	sampleRateHz: z.number().positive(),
	fftSize: z.number().int().min(512).max(16384),
	integrationMs: z.number().positive(),
	usableFraction: z.number().gt(0).max(1),
	dcGuardHz: z.number().nonnegative(),
	ppmMargin: z.number().nonnegative(),
	hysteresisDb: z.number().nonnegative(),
	clipFraction: z.number().gt(0).max(1),
	minSurfaceBlocks: z.number().int().min(1),
	thresholdDb: z.number().nullable(),
	faTargetPerMhzMin: z.number().positive(),
	spectrumBins: z.number().int().min(16).max(SPECTRUM_SUMMARY_BINS_MAX),
	trackHangMs: z.number().nonnegative(),
	maxTracks: z.number().int().positive(),
	maxTrackMs: z.number().positive(),
	shortIntegrationMs: z.number().positive().nullable().optional(),
	overlap: z.union([z.literal(0), z.literal(0.5)]).optional(),
	persistedEngine: EngineStateSchema.optional(),
})

const PendingEpochSchema = z.object({
	epoch: z.number().int().nonnegative(),
	commandSample: z.number().int().nonnegative(),
	bufferedSamples: z.number().int().nonnegative(),
	settleSamples: z.number().int().nonnegative(),
	expectMarker: z.boolean(),
	markerTimeoutSamples: z.number().int().nonnegative(),
	pllSettleSamples: z.number().int().nonnegative(),
	centreHz: z.number(),
	sampleRateHz: z.number().positive(),
	gainKey: z.string(),
	tuningTrust: TuningTrustSchema,
	centreChanged: z.boolean(),
	staleMaxMs: z.number().finite().nonnegative().max(1000).optional(),
	verifiedFromSample: z.number().int().nonnegative().optional(),
})

export const PipelineInputSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("bytes"),
			startSample: z.number().int().nonnegative(),
			bytes: z.instanceof(Uint8Array),
		}),
		z.object({
			kind: z.literal("gap"),
			startSample: z.number().int().nonnegative(),
			samples: z.number().int().positive(),
		}),
		z.object({ kind: z.literal("pending-epoch"), pending: PendingEpochSchema }),
		z.object({
			kind: z.literal("new-stream"),
			stream: z.number().int().nonnegative(),
			centreHz: z.number(),
			sampleRateHz: z.number().positive(),
			gainKey: z.string(),
			tuningTrust: TuningTrustSchema,
		}),
		z.object({
			kind: z.literal("masks"),
			exclusions: z.array(FreqRangeSchema),
			cfarRanges: z.array(
				FreqRangeSchema.extend({
					faTargetPerMhzMin: z.number().positive().optional(),
				}),
			),
			burstRanges: z.array(FreqRangeSchema),
			rasters: z.array(RasterSchema),
			obwHz: z.array(z.number().positive()),
			inWindow: z.boolean(),
		}),
		z.object({ kind: z.literal("spectrum-feed"), enabled: z.boolean() }),
		z.object({
			kind: z.literal("channel-plan"),
			plan: ChannelPlanBodySchema.nullable(),
		}),
	])
	.superRefine((input, ctx) => {
		if (input.kind !== "channel-plan" || input.plan === null) return
		for (let i = 0; i < input.plan.entries.length; i++) {
			const entry = input.plan.entries[i]
			if (entry === undefined || entry.startHz < entry.endHz) continue
			ctx.addIssue({
				code: "custom",
				message: "startHz must be below endHz",
				path: ["plan", "entries", i, "startHz"],
			})
		}
	})

/** Opt-in worker stage profile (R 9.2). Absent on init: the pipeline records nothing. */
export const PipelineProfileOptionSchema = z.object({
	sampleEvery: z.number().int().positive(),
})

/** Present on an export-state reply only while profiling is on. */
const finiteMs = z.number().nonnegative().finite()

export const PipelineProfileSchema = z.object({
	blocks: z.number().int().nonnegative().finite(),
	busyMs: finiteMs,
	stages: z.object({
		window: finiteMs,
		fft: finiteMs,
		power: finiteMs,
		floor: finiteMs,
		detector: finiteMs,
		gate: finiteMs,
		tracker: finiteMs,
		wire: finiteMs,
	}),
})

export const MainToWorkerSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("init"),
		config: PipelineConfigSchema,
		profile: PipelineProfileOptionSchema.optional(),
	}),
	z.object({ type: z.literal("input"), input: PipelineInputSchema }),
	z.object({
		type: z.literal("export-state"),
		requestId: z.number().int().nonnegative(),
	}),
	z.object({
		type: z.literal("artefact-masks"),
		requestId: z.number().int().nonnegative(),
	}),
	z.object({ type: z.literal("close") }),
])

type WorkerInit = {
	type: "init"
	config: PipelineConfig
	profile?: { sampleEvery: number }
}

/** A channel plan for the spectrum worker. `null` clears the plan. */
export interface ChannelPlanInput {
	kind: "channel-plan"
	plan: ChannelPlan | null
}

/** Pipeline inputs plus the channel-plan kind (types.ts stays the Main seam). */
export type WorkerPipelineInput = PipelineInput | ChannelPlanInput

export type MainToWorker =
	| WorkerInit
	| { type: "input"; input: WorkerPipelineInput }
	| { type: "export-state"; requestId: number }
	| { type: "artefact-masks"; requestId: number }
	| { type: "close" }

export type WorkerToMain =
	/** Block summaries may be in wire form (summary-wire.ts); the host decodes them. */
	| { type: "events"; events: PipelineEvent[] }
	| { type: "buffer"; buffer: ArrayBuffer }
	| { type: "engine-state"; requestId: number; state: EngineState }
	| { type: "artefact-masks"; requestId: number; masks: ArtefactMasks }
	| { type: "error"; message: string }

/** Envelope check for worker → main messages (events come from SpectrumPipeline). */
export const WorkerToMainSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("events"),
		// Block-summary bins may travel as int16 half-dB (summary-wire.ts): flag, type and length checked here.
		events: z.array(
			z
				.custom<PipelineEvent>(
					v => typeof v === "object" && v !== null && "kind" in v,
				)
				.superRefine((ev, ctx) => {
					const problem = wireEventProblem(ev, SPECTRUM_SUMMARY_BINS_MAX)
					if (problem) ctx.addIssue({ code: "custom", message: problem })
				}),
		),
	}),
	z.object({ type: z.literal("buffer"), buffer: z.instanceof(ArrayBuffer) }),
	z.object({
		type: z.literal("engine-state"),
		requestId: z.number().int().nonnegative(),
		state: EngineStateSchema.extend({
			profile: PipelineProfileSchema.optional(),
		}),
	}),
	z.object({
		type: z.literal("artefact-masks"),
		requestId: z.number().int().nonnegative(),
		// Built by SpectrumPipeline.artefactMasks() (plain data, Task 7a): envelope check only, like `events`.
		masks: z.custom<ArtefactMasks>(
			v => typeof v === "object" && v !== null && "epoch" in v,
		),
	}),
	z.object({ type: z.literal("error"), message: z.string() }),
])
