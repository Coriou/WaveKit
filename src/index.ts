/**
 * WaveKit - SDR Stream Processing Framework
 *
 * Main entry point that bootstraps the application.
 *
 * Requirements:
 * - 12.1: Load configuration from default YAML file
 * - 14.1: Begin graceful shutdown on SIGTERM
 * - 1.1: Connect Source Manager to SDR sources
 * - 2.1: Connect Fanout Manager to distribute audio streams
 * - 4.1: Connect Decoder Manager to process audio
 * - 11.1: Connect Audio Output to stream decoded audio
 */

import "./bootstrap.js"

import { openAccessRuntime } from "./access/runtime-context.js"
import { createAnalogLiveRunner } from "./core/iq-capture/analog-live.js"
import type { NamedAccessRuntimeContext } from "./access/runtime-context.js"
import type { ProtectedAccessBootstrap } from "./access/bootstrap-policy.js"
import { validateProtectedRuntimeMapping } from "./access/runtime-config.js"
import { WaveKitError } from "./utils/errors.js"
import { arch, cpus } from "node:os"
import { performance } from "node:perf_hooks"
import {
	buildDecoderCatalogue,
	isCatalogueConfig,
} from "./decoders/enablement/catalogue.js"
import { resolveDecoderBinary } from "./decoders/enablement/binary.js"
import { resolveDecoderMode } from "./decoders/enablement/mode.js"
import { planPlacements } from "./decoders/enablement/placement.js"
import {
	createBandplanChannelLookup,
	createBandplanRangeLookup,
	createVfoTracker,
	vfoFromLiveDemod,
} from "./decoders/enablement/channel-sources.js"
import { createEfficiencyGate } from "./decoders/enablement/efficiency-gate.js"
import { createEfficiencyMonitor } from "./decoders/enablement/efficiency-monitor.js"
import {
	channelizerAutoAccepted,
	CHANNELIZER_IDLE_STOP_MS,
	DECODER_MAX_BANDPLAN_CHANNELS,
	EFFICIENCY_SAMPLE_MS,
	EFFICIENCY_CPU_GUARD_PERCENT,
	channelizerComposition,
	defaultCpuBudgetCores,
} from "./decoders/enablement/contract.js"
import { createRatePolicy } from "./core/rate-policy.js"
import { composeLinkBurst } from "./core/link-burst/compose.js"
import { createLinkQuality } from "./core/link-burst/link-quality.js"
import { frameBytesFor } from "./core/link-burst/contract.js"
import { createLinkAdvisor } from "./core/link-advisory.js"
import type { DropReader } from "./decoders/enablement/efficiency-gate.js"
import type {
	EfficiencyGate,
	EfficiencyInputs,
	ResolvedMode,
} from "./decoders/enablement/contract.js"
import type { LinkAdvisor, RatePolicy } from "./core/rate-policy-contract.js"
import { PassThrough } from "node:stream"
import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
	loadConfig,
	DigitalVoiceConfigSchema,
	LiveDemodConfigSchema,
	liveDemodAdvertisedOrigin,
	splitLiveDemodConfig,
	sourceScannerConfig,
	type Config,
} from "./config.js"
import {
	CSDR_BUFFER_ENV,
	configureCsdrBuffers,
} from "./decoders/csdr-buffers.js"
import { createLogger, createComponentLogger } from "./utils/logger.js"
import { GracefulShutdown } from "./utils/graceful-shutdown.js"
import { SourceManager } from "./core/source-manager.js"
import { FanoutManager } from "./core/fanout-manager.js"
import {
	SourceFanoutRouter,
	defaultSourceIdFor,
} from "./core/source-fanout-router.js"
import { AudioOutput } from "./core/audio-output.js"
import { TunerRelay } from "./core/tuner-relay.js"
import {
	TunerController,
	TUNER_REST_COMMAND_POLICY,
} from "./core/tuner-controller.js"
import { applyConfiguredTuning } from "./core/tuner-config-gain.js"
import { createRegionalRegistry } from "./core/regional/registry.js"
import { createRegionalRegistration } from "./core/regional/data.js"
import { createReceiverCapabilitiesProvider } from "./core/tuner-capabilities/provider.js"
import { wireTunerControl } from "./core/tuner-wiring.js"
import { LiveDemodulator } from "./core/live-demodulator.js"
import { liveDemodOperatorActivity } from "./core/live-demod-activity.js"
import { DigitalVoiceService } from "./core/digital-voice.js"
import type { ChannelizerManagerDeps } from "./core/channelizer/channelizer-manager.js"
import { ChannelizerManager } from "./core/channelizer/channelizer-manager.js"
import { SettlementRegistry } from "./core/channelizer/settlement-observer.js"
import type {
	ChannelSettlementObserver,
	CleanupOutcome,
	ProviderLifetime,
} from "./core/channelizer/settlement-observer.js"
import { ScannerLifecycleOwner } from "./core/scanner/channel/consumer-lifecycle.js"
import { ScannerService } from "./core/scanner/scanner-service.js"
import {
	createIqCaptureService,
	type IqCaptureService,
} from "./core/iq-capture/service.js"
import { createAnalogTrialRunner } from "./core/iq-capture/analog-trial.js"
import { ToneDetector } from "./core/audio-tones/tone-detector.js"
import type { AnalogTrialRunner } from "./core/scanner/scanner-redesign-contract.js"
import { CpuMeter } from "./core/scanner/cpu-meter.js"
import { toDecoderCoverageView } from "./core/scanner/plan/decoded-elsewhere.js"
import { bandPlanSkipSources } from "./core/scanner/plan/bandplan-skips.js"
import { ambientTrustFromBinding } from "./core/scanner/probes/ambient-trust.js"
import { createBandPlanUrlFetcher } from "./core/bandplan-url/fetch.js"
import { BANDPLAN_URL_IMPORT_HOSTS } from "@wavekit/api-types"
import { APP_VERSION } from "./api/routes/health.js"
import { DecoderRegistry } from "./decoders/registry.js"
import { DecoderManager } from "./decoders/manager.js"
import { createDecoderManagerOptions } from "./decoders/manager-options.js"
import { resolveProcessBandRegion } from "./decoders/band-region.js"
import { BandOverrideStore } from "./decoders/band-override-store.js"
import { ApiServer } from "./api/server.js"
import {
	activityConfigOptions,
	startActivityRuntime,
} from "./core/activity/runtime.js"
import { OperatorDataService } from "./operator-data/service.js"
import {
	openBandPlanService,
	createScannerBandplanProvider,
} from "./core/bandplans/index.js"
import type {
	BandPlanService,
	BandPlansCommitSink,
} from "./core/bandplans/contract.js"
import { createOperatorDataCommitSink } from "./operator-data/broadcast-adapter.js"
import { createBandPlansCommitSink } from "./api/websocket/bandplans-broadcast-adapter.js"
import {
	createDsdFmeDecoder,
	DSD_FME_CAPS,
} from "./decoders/builtin/dsd-fme.js"
import {
	createMultimonDecoder,
	MULTIMON_CAPS,
} from "./decoders/builtin/multimon-ng.js"
import { createRtl433Decoder, RTL433_CAPS } from "./decoders/builtin/rtl433.js"
import { readsbDecoderFactory, READSB_CAPS } from "./decoders/builtin/readsb.js"
import { createDecoderProvenanceIndex } from "./decoders/provenance-bindings.js"
import type { ActivityProvenanceLookup } from "./core/activity/types.js"
import { CoverageManager } from "./core/coverage/coverage-manager.js"
import {
	createAcarsdecDecoder,
	ACARSDEC_CAPS,
} from "./decoders/builtin/acarsdec.js"
import {
	createAisCatcherDecoder,
	AIS_CATCHER_CAPS,
} from "./decoders/builtin/ais-catcher.js"
import {
	createDumpvdl2Decoder,
	DUMPVDL2_CAPS,
} from "./decoders/builtin/dumpvdl2.js"
import {
	createDirewolfDecoder,
	DIREWOLF_CAPS,
} from "./decoders/builtin/direwolf.js"
import {
	createLoraMeshtasticDecoder,
	LORA_MESHTASTIC_CAPS,
} from "./decoders/builtin/lora-meshtastic.js"
import { ContainerMonitor } from "./core/container-monitor.js"
import { SdrHostPoller, type SdrHostConfig } from "./core/sdr-host-poller.js"
import {
	EndpointSelector,
	type EndpointSelectionTarget,
} from "./core/endpoint-selector.js"
import {
	configuredApiPort,
	createEndpointProbe,
	plainHttpApiUrl,
} from "./core/endpoint-probe.js"
import { SourceBackpressureTracker } from "./core/source-backpressure-tracker.js"
import { ResourceAggregator } from "./core/resource-aggregator.js"
import { AircraftTrackingManager } from "./core/aircraft-tracking-manager.js"
import { VesselTrackingManager } from "./core/vessel-tracking-manager.js"
import { MeshTrackingManager } from "./core/mesh-tracking-manager.js"
import { AprsTrackingManager } from "./core/aprs-tracking-manager.js"
import { createStationEstimator } from "./core/station-estimate/provider.js"
import { openStationService } from "./core/station/station-service.js"
import { resolveSpectrumBinsCap } from "./core/spectrum/bin-cap.js"
import { createRecordingInventory } from "./core/recordings/inventory.js"
import { openRecordingKeepService } from "./core/recordings/keep-service.js"
import { lateBoundRecordingProtection } from "./core/recordings/late-bound-protection.js"
import type {
	RecordingKeepService,
	ScannerRecordingDeleter,
} from "./core/recordings/contract.js"
import { RecordingKeepError } from "./core/recordings/contract.js"
import { RECORDING_DELETE_UNSUPPORTED_TEXT } from "./core/recordings/verified-unlink.js"
import { sweepRecordingDeleteLeftovers } from "./core/recordings/delete-sweep.js"
import { keptSummaryOf } from "./core/recordings/kept-summary.js"
import { setCallRecordingProtection } from "./decoders/builtin/call-recordings.js"
import type {
	DecoderSettingsManagerPort,
	DecoderSettingsService,
} from "./decoders/settings/contract.js"
import { openDecoderSettingsService } from "./decoders/settings/service.js"
import { toApiDecoderStatus } from "./api/serializers/decoder-status.js"
import { STATION_WRITE_REQUIRES_ACCESS } from "./core/station/contract.js"
import { createStorageReporter } from "./core/storage-report/reporter.js"
import {
	activityRetentionFromStats,
	dsdFmeRecordingDir,
	liveStorageReportSources,
	storageActivityLimits,
} from "./core/storage-report/areas-from-config.js"
import {
	tunerFrequencyAt,
	wireAnalogTransmissions,
} from "./core/analog-transmission.js"
import type { AnalogTransmissionTracker } from "./core/analog-transmission.js"
import {
	createAnalogEvidenceLog,
	liveAudioMonitoring,
} from "./core/scanner/analog-evidence.js"
import type { AnalogEvidenceLog } from "./core/scanner/analog-evidence.js"
import { AircraftEnrichmentService } from "./services/aircraft-enrichment-service.js"
import type { Logger } from "./utils/logger.js"
import type { Decoder, DecoderConfig } from "./decoders/types.js"

/**
 * Application startup time for uptime calculation.
 */
const startTime = Date.now()

/**
 * Wires decoder audio outputs to the AudioOutput component.
 * Creates a combined stream that aggregates audio from all decoders that produce audio.
 *
 * Requirements:
 * - 11.1: Connect Audio Output to decoder audio streams
 *
 * @param decoderManager - The decoder manager containing all decoders
 * @param audioOutput - The audio output TCP server
 * @param log - Logger instance
 * @returns Cleanup function to detach audio sources
 */
export function wireDecoderAudioToOutput(
	decoderManager: Pick<DecoderManager, "on" | "getDecoder" | "getAllDecoders">,
	fanoutManager: Pick<FanoutManager, "addBranch">,
	audioOutput: Pick<AudioOutput, "attachSource" | "detachSource">,
	config: Config, // Added config parameter
	log: Logger,
): () => void {
	// Create a combined audio stream that aggregates audio from all decoders
	const combinedAudioStream = new PassThrough({
		highWaterMark: 256 * 1024, // 256KB buffer
	})

	// DEBUG: Monitor Raw Audio (Pipe Source -> Output directly)
	// Only enabled if config.audio.monitoring is true
	if (config.audio.monitoring) {
		const rawAudioStream = fanoutManager.addBranch({ id: "audio-monitor" })
		rawAudioStream.pipe(combinedAudioStream, { end: false })
		log.info("Wired raw audio source to AudioOutput for monitoring")
	}

	// Track which decoders are piped to the combined stream
	const pipedDecoders = new Map<string, Decoder>()

	/**
	 * Wires a decoder's audio output to the combined stream if available.
	 */
	const wireDecoderAudio = (decoderId: string): void => {
		const decoder = decoderManager.getDecoder(decoderId)
		if (!decoder) return

		// WG8: a rebuilt instance (staged settings, next start) replaces the one piped before
		const piped = pipedDecoders.get(decoderId)
		if (piped !== undefined && piped !== decoder) unwireDecoderAudio(decoderId)

		const audioStream = decoder.getAudioOutput()
		if (audioStream && !pipedDecoders.has(decoderId)) {
			audioStream.pipe(combinedAudioStream, { end: false })
			pipedDecoders.set(decoderId, decoder)
			log.debug({ decoderId }, "Decoder audio output wired to AudioOutput")
		}
	}

	/**
	 * Unwires a decoder's audio output from the combined stream.
	 */
	const unwireDecoderAudio = (decoderId: string): void => {
		const decoder = pipedDecoders.get(decoderId)
		if (decoder) {
			const audioStream = decoder.getAudioOutput()
			if (audioStream) {
				audioStream.unpipe(combinedAudioStream)
			}
			pipedDecoders.delete(decoderId)
			log.debug({ decoderId }, "Decoder audio output unwired from AudioOutput")
		}
	}

	// WG8: drop a replaced instance's audio pipe as soon as the rebuild is announced
	// (decoder:created with a known id); decoder:started then wires the new instance.
	decoderManager.on("decoder:created", (decoderId: string) => {
		const piped = pipedDecoders.get(decoderId)
		if (piped !== undefined && piped !== decoderManager.getDecoder(decoderId))
			unwireDecoderAudio(decoderId)
	})

	// Wire audio when decoders start
	decoderManager.on("decoder:started", (decoderId: string) => {
		wireDecoderAudio(decoderId)
	})

	// Unwire audio when decoders stop
	decoderManager.on("decoder:stopped", (decoderId: string) => {
		unwireDecoderAudio(decoderId)
	})

	// Wire existing running decoders
	for (const decoder of decoderManager.getAllDecoders()) {
		if (decoder.getStatus().running) {
			wireDecoderAudio(decoder.id)
		}
	}

	// Attach the combined stream to audio output
	audioOutput.attachSource(combinedAudioStream)
	log.info("Decoder audio outputs wired to AudioOutput")

	// Return cleanup function
	return () => {
		// Unwire all decoders
		for (const decoderId of pipedDecoders.keys()) {
			unwireDecoderAudio(decoderId)
		}
		// Detach from audio output
		audioOutput.detachSource()
		// End the combined stream
		combinedAudioStream.end()
		log.info("Decoder audio outputs unwired from AudioOutput")
	}
}

interface ScannerRuntimePhaseDependencies {
	sealAdmission(): void
	drainBeforeProducer(): Promise<void>
	beginStop(): Readonly<{
		producerSettled: Promise<void>
		completed: Promise<void>
	}>
	stopDecoders(): Promise<void>
	stopChannelizer(): Promise<void>
	attemptLocalCleanup(): Promise<readonly CleanupOutcome[]>
	finalizeStopNative(producerOutcome: CleanupOutcome): Promise<void>
}

/**
 * WG8 req 1.5: the decoder configurations created at boot, override applied (`enabled` and
 * patchable options). Without a settings file each entry deep-equals the configured one.
 */
export function effectiveDecoderConfigs(
	settings: Pick<DecoderSettingsService, "effectiveConfig">,
	configs: readonly DecoderConfig[],
): DecoderConfig[] {
	return configs.map(c => settings.effectiveConfig(c))
}

/**
 * WG8 req 3.1: a rebuild at next start announces the new instance with decoder:created (same
 * id) before decoder:started. Digital voice follows the new instance once; attachDecoder
 * detaches the replaced instance's listener first. Only ids in `attached` (configured decoders
 * attached at boot) are followed: scanner probes attach in the probe pool.
 */
export function followRebuiltVoiceDecoders(
	decoderManager: Pick<DecoderManager, "on" | "getDecoder">,
	digitalVoice: Pick<DigitalVoiceService, "attachDecoder">,
	attached: Map<string, Decoder>,
): void {
	decoderManager.on("decoder:created", (decoderId: string) => {
		const previous = attached.get(decoderId)
		if (previous === undefined) return
		const decoder = decoderManager.getDecoder(decoderId)
		if (decoder === undefined || decoder === previous) return
		digitalVoice.attachDecoder(decoderId, decoder)
		attached.set(decoderId, decoder)
	})
}

/** Derived instances are runtime-only; the parsed configuration remains exportable verbatim. */
export async function prepareDecoderCatalogue(
	config: Pick<Config, "decoders" | "decoderPolicy">,
	region: Parameters<typeof buildDecoderCatalogue>[1]["region"],
	resolveBinary: typeof resolveDecoderBinary = resolveDecoderBinary,
) {
	const catalogue = buildDecoderCatalogue(config.decoders, {
		enabled: config.decoderPolicy?.catalogue !== false,
		region,
	})
	const catalogueIds = new Set(
		catalogue.filter(isCatalogueConfig).map(c => c.id),
	)
	const unavailable = new Set<string>()
	const recheckAvailable = async (id: string) => {
		const decoder = catalogue.find(c => c.id === id)
		if (!decoder || !catalogueIds.has(id)) return true
		const { available } = await resolveBinary(decoder.type, process.env)
		if (available) unavailable.delete(id)
		else unavailable.add(id)
		return available
	}
	await Promise.all(
		catalogue
			.filter(c => catalogueIds.has(c.id))
			.map(c => recheckAvailable(c.id)),
	)
	return { catalogue, catalogueIds, unavailable, recheckAvailable }
}

/** Metrics are KiB/s; link advice uses bytes/s and reconnect-local evidence. */
export function wireDecoderLinkFeed(
	sources: Pick<SourceManager, "on" | "off">,
	tuner: Pick<TunerController, "getState">,
	link: LinkAdvisor,
	policy: Pick<RatePolicy, "reset">,
	now: () => number = Date.now,
): () => void {
	const metrics = (id: string, value: { dataRate: number }) =>
		link.observe(
			id,
			value.dataRate * 1024,
			tuner.getState(id)?.sampleRate ?? null,
			now(),
		)
	const connected = (id: string) => {
		link.reset(id)
		policy.reset(id)
	}
	sources.on("metrics", metrics)
	sources.on("connected", connected)
	return () => {
		sources.off("metrics", metrics)
		sources.off("connected", connected)
	}
}

export function wireDecoderRatePolicy(
	tuner: Pick<
		TunerController,
		| "setBeforeOperatorRetune"
		| "setOnOperatorSampleRate"
		| "setOnRelayRetune"
		| "setRatePolicyRecordFor"
	>,
	policy: RatePolicy,
): () => void {
	tuner.setBeforeOperatorRetune((...args) =>
		policy.beforeOperatorRetune(...args),
	)
	tuner.setOnOperatorSampleRate(id => policy.onOperatorSampleRate(id))
	tuner.setOnRelayRetune((id, hz) => policy.onRelayRetune(id, hz))
	tuner.setRatePolicyRecordFor(id => policy.recordFor(id))
	return () => {
		policy.dispose()
		tuner.setBeforeOperatorRetune(null)
		tuner.setOnOperatorSampleRate(null)
		tuner.setOnRelayRetune(null)
		tuner.setRatePolicyRecordFor(null)
	}
}

/** One cleanup owns the link feed and every installed policy hook. */
export function composeDecoderRatePolicyLifetime(
	sources: Parameters<typeof wireDecoderLinkFeed>[0],
	tuner: Parameters<typeof wireDecoderRatePolicy>[0] &
		Parameters<typeof wireDecoderLinkFeed>[1],
	link: LinkAdvisor,
	policy: RatePolicy,
): () => void {
	const unhook = wireDecoderRatePolicy(tuner, policy)
	const closeFeed = wireDecoderLinkFeed(sources, tuner, link, policy)
	return () => {
		closeFeed()
		unhook()
	}
}

/** Admission deadlines stay monotonic through the manager; only views use epoch time. */
export function composeDecoderEfficiencyGate(
	inputs: EfficiencyInputs,
	drops: DropReader,
	log?: Logger,
): EfficiencyGate {
	const gate = createEfficiencyGate(inputs, { drops, ...(log ? { log } : {}) })
	return {
		...gate,
		record: sample => gate.record({ ...sample, atMs: drops.monoNow() }),
	}
}

export function composeDecoderModes(
	read: () => (id: string) => ResolvedMode,
	manager: () => Pick<DecoderManager, "applyDecoderMode">,
) {
	const resolvedModes = new Map<string, ResolvedMode>()
	return {
		resolvedModes,
		applyDecoderMode: (id: string, mode: ResolvedMode["mode"]) => {
			resolvedModes.set(id, read()(id))
			return manager().applyDecoderMode(id, mode)
		},
	}
}

export function decoderLinkReporter(
	aggregator: () => Pick<ResourceAggregator, "reportLinkAdvisory"> | undefined,
): NonNullable<Parameters<typeof createRatePolicy>[0]["reportLink"]> {
	return (id, advisory) => aggregator()?.reportLinkAdvisory(id, advisory)
}

export async function prepareDecoderVoice(
	voice: Pick<DigitalVoiceService, "prepareDecoderConfigs">,
	configs: DecoderConfig[],
	catalogueIds: ReadonlySet<string>,
	unavailable: ReadonlySet<string>,
): Promise<DecoderConfig[]> {
	const eligible = configs.filter(
		c => !catalogueIds.has(c.id) || !unavailable.has(c.id),
	)
	const prepared = new Map(
		(await voice.prepareDecoderConfigs(eligible)).map(c => [c.id, c]),
	)
	return configs.map(c => prepared.get(c.id) ?? c)
}

/** Construct observation and provider together, leaving native acquisition lazy. */
export function composeDecoderChannelizer(
	deps: Omit<ChannelizerManagerDeps, "settlementObserver" | "idleStopMs"> & {
		ownObservation?: (
			observer: ChannelSettlementObserver,
			lifetime: ProviderLifetime,
		) => void
	},
	constructionCleanup: () => Promise<CleanupOutcome>,
	accepted: boolean = channelizerAutoAccepted(arch()),
	createManager: (deps: ChannelizerManagerDeps) => ChannelizerManager = deps =>
		new ChannelizerManager(deps),
) {
	const chanMode = channelizerComposition(deps.config, accepted)
	if (chanMode === null)
		return {
			channelizer: null,
			channels: null,
			observer: undefined,
			lifetime: undefined,
		}
	const registry = new SettlementRegistry()
	const lifetime = registry.registerProviderLifetime()
	if (!lifetime)
		throw new WaveKitError("Scanner lifetime unavailable", "ACCESS_UNAVAILABLE")
	if (!lifetime.ownCleanup("construction", constructionCleanup))
		throw new WaveKitError("Scanner owner unavailable", "ACCESS_UNAVAILABLE")
	const observer = registry.createObserver(lifetime)
	const { ownObservation, ...managerDeps } = deps
	ownObservation?.(observer, lifetime)
	const channelizer = createManager({
		...managerDeps,
		settlementObserver: observer,
		...(chanMode === "auto" ? { idleStopMs: CHANNELIZER_IDLE_STOP_MS } : {}),
	})
	const channels = observer.bindProvider(channelizer)
	// Preserve the optional in-place retune port across the settlement adapter.
	Object.assign(channels, {
		retuneChannel: channelizer.retuneChannel.bind(channelizer),
	})
	return { channelizer, channels, observer, lifetime }
}

export function decoderPolicyTimer(
	fn: () => void,
	ms: number,
): { cancel(): void } {
	const timer = setTimeout(fn, ms)
	timer.unref()
	return { cancel: () => clearTimeout(timer) }
}

/**
 * WG8 req 2.4: the settings service's view of the DecoderManager. The port speaks the API
 * status DTO (the service reads only `owner`); staging goes straight to the manager.
 */
export function decoderSettingsPort(
	decoderManager: Pick<
		DecoderManager,
		"getStatus" | "stageDecoderOptions" | "isRestartPending"
	>,
): DecoderSettingsManagerPort {
	return {
		getStatus: id => {
			const status = decoderManager.getStatus(id)
			return status === undefined ? undefined : toApiDecoderStatus(status)
		},
		stageDecoderOptions: (id, options) =>
			decoderManager.stageDecoderOptions(id, options),
		isRestartPending: id => decoderManager.isRestartPending(id),
	}
}

/**
 * WG9 req 3.2: the analog transmission frequency label. The strict state rule, demoted to
 * `unverified` unless the controller wrote both frequency and sample rate on the current
 * connection (a failed reconnect replay proves nothing).
 */
export function analogFrequencyAt(
	tuner: Pick<TunerController, "getState" | "tuningWrittenOnConnection">,
): ReturnType<typeof tunerFrequencyAt> {
	return tunerFrequencyAt(
		id => tuner.getState(id),
		id => tuner.tuningWrittenOnConnection(id),
	)
}

/**
 * WG10 req 3.1-3.2: the analog evidence log identify reads. `monitoring` reads the live
 * demodulator status and the tuner state lazily at call time, checks the target's own source and
 * treats a tuner frequency the controller does not know as not monitoring (fail closed).
 */
export function identifyAnalogEvidence(deps: {
	liveDemod: Pick<LiveDemodulator, "getStatus">
	tuner: Pick<TunerController, "getState">
	logger?: Logger
}): AnalogEvidenceLog {
	return createAnalogEvidenceLog({
		...(deps.logger
			? { logger: createComponentLogger(deps.logger, "AnalogEvidence") }
			: {}),
		monitoring: (sourceId, hz, toleranceHz) => {
			const state = deps.tuner.getState(sourceId)
			const tunerHz =
				state === undefined ||
				(Array.isArray(state.unknownFields) &&
					state.unknownFields.includes("frequency"))
					? null
					: state.frequency
			return liveAudioMonitoring(
				deps.liveDemod.getStatus(),
				tunerHz,
				hz,
				toleranceHz,
				sourceId,
			)
		},
	})
}

/**
 * WG10 req 3.1: feeds the tracker's open and closed events into the evidence log. The tracker is
 * built after the scanner service, so the log handed to the scanner stays empty until then
 * (identify answers `no-sync`/`no-live-audio`, never a false positive).
 */
export function feedAnalogEvidence(
	tracker: Pick<AnalogTransmissionTracker, "on"> &
		Partial<Pick<AnalogTransmissionTracker, "pending">>,
	log: Pick<AnalogEvidenceLog, "record"> &
		Partial<Pick<AnalogEvidenceLog, "setPending">>,
): void {
	tracker.on("transmission", event => {
		log.record(event)
	})
	// WG10 R2: identify counts a not yet published opening at its deadline as `timeout`.
	if (typeof tracker.pending === "function")
		log.setPending?.(() => tracker.pending?.() ?? null)
}

/**
 * WG12 req 6.4: the detected CTCSS/DCS tone of a current or closed
 * transmission, on the live-audio status. Open events omit the tone until it
 * is known; a closed event always carries the detected result. `startedAt`
 * is the transmission's open time, so a config-close that arrives after a
 * retune or stop does not put the old channel's tone back.
 */
export function feedLiveChannelTone(
	tracker: Pick<AnalogTransmissionTracker, "on">,
	liveDemod: Pick<LiveDemodulator, "noteTransmissionTone">,
): void {
	tracker.on("transmission", event => {
		const detected = event.tone
		if (detected === undefined) return
		liveDemod.noteTransmissionTone({
			ctcssHz: detected.ctcssHz,
			dcs: detected.dcs ?? null,
			at: event.endedAt ?? event.startedAt,
			startedAt: event.startedAt,
		})
	})
}

/**
 * WG10 req 1.1: the keep service's scanner deleter, bound late: until the scanner service exists
 * (and when it failed to start) a `scan:` delete answers 409 RECORDING_DELETE_UNSUPPORTED.
 */
export function lateBoundScannerDeleter(
	scanner: () => Pick<ScannerService, "scannerRecordingDeleter"> | null,
): ScannerRecordingDeleter {
	return {
		deleteRecording(recordingId, stillDeletable) {
			const deleter = scanner()?.scannerRecordingDeleter()
			if (!deleter)
				return Promise.reject(
					new RecordingKeepError(
						"RECORDING_DELETE_UNSUPPORTED",
						RECORDING_DELETE_UNSUPPORTED_TEXT,
					),
				)
			return deleter.deleteRecording(recordingId, stillDeletable)
		},
	}
}

/**
 * WG10 req 1.9 (Main, rk2 review minor 3): the directory directly holding the scanner's `d_*`
 * recording folders, under the realpath of the configured storage root (the sweep refuses a
 * symlinked root, the evidence store follows it once). Null when the root does not resolve.
 */
export async function scannerDeleteSweepDir(
	stateDir: string,
	storageDir: string | null | undefined,
	resolveReal: (path: string) => Promise<string> = realpath,
): Promise<string | null> {
	try {
		const root = await resolveReal(
			resolve(storageDir || join(stateDir, "scanner")),
		)
		return join(root, "recordings", "dv")
	} catch {
		return null
	}
}

/**
 * WG8 req 4.1: the dsd-fme per-call recording directories of the configured decoders (scanner
 * probes are not configured decoders), sorted by decoder id so inventory ids stay stable.
 */
export function recordingDsdFmeDirs(
	decoderManager: Pick<DecoderManager, "getConfiguredDecoderConfigs">,
): { decoderId: string; dir: string }[] {
	return decoderManager
		.getConfiguredDecoderConfigs()
		.filter(c => c.type === "dsd-fme")
		.flatMap(c => {
			const dir = dsdFmeRecordingDir(c.options)
			return dir === null ? [] : [{ decoderId: c.id, dir }]
		})
		.sort((a, b) =>
			a.decoderId < b.decoderId ? -1 : a.decoderId > b.decoderId ? 1 : 0,
		)
}

/** Actual phase promises remain authoritative even when a caller races a timeout. */
export function createScannerRuntimePhases(
	deps: ScannerRuntimePhaseDependencies,
) {
	let sealed = false
	let firstFailure: WaveKitError | undefined
	let producerOutcome: CleanupOutcome = { ok: true }
	let producer: Promise<void> | undefined
	let manager: Promise<void> | undefined
	let core: Promise<void> | undefined
	let final: Promise<void> | undefined
	const fail = () => {
		firstFailure ??= new WaveKitError(
			"Scanner runtime shutdown incomplete",
			"ACCESS_UNAVAILABLE",
		)
		return firstFailure
	}
	const attempt = <T>(run: () => T | Promise<T>): Promise<T> => {
		try {
			return Promise.resolve(run())
		} catch (error) {
			return Promise.reject(error)
		}
	}
	const previous = async (phase: Promise<void>) => {
		try {
			await phase
		} catch {
			fail()
		}
	}
	const sealAdmission = () => {
		if (sealed) return
		sealed = true
		try {
			deps.sealAdmission()
		} catch {
			fail()
		}
	}
	const producerSettled = (): Promise<void> => {
		sealAdmission()
		producer ??= Promise.resolve()
			.then(async () => {
				await previous(attempt(deps.drainBeforeProducer))
				const handle = deps.beginStop()
				// Completion belongs to phase 66, not the producer boundary.
				void handle.completed.catch(() => undefined)
				return handle.producerSettled
			})
			.catch(() => {
				producerOutcome = {
					ok: false,
					state: "unknown",
					detail: "Scanner component cleanup incomplete",
				}
				throw fail()
			})
		return producer
	}
	const managerSettled = (): Promise<void> => {
		manager ??= Promise.resolve().then(async () => {
			await previous(producerSettled())
			try {
				await deps.stopDecoders()
			} catch {
				throw fail()
			}
		})
		return manager
	}
	const coreSettled = (): Promise<void> => {
		core ??= Promise.resolve().then(async () => {
			await previous(managerSettled())
			// Initiate every independent local attempt even when native close hangs.
			const native = attempt(deps.stopChannelizer)
			const local = attempt(deps.attemptLocalCleanup)
			const outcomes = await Promise.allSettled([native, local] as const)
			const localOutcome = outcomes[1]
			if (
				outcomes[0]?.status === "rejected" ||
				localOutcome?.status === "rejected" ||
				(localOutcome?.status === "fulfilled" &&
					localOutcome.value.some(outcome => !outcome.ok))
			)
				throw fail()
		})
		return core
	}
	const completed = (): Promise<void> => {
		sealAdmission()
		final ??= Promise.resolve().then(async () => {
			await previous(coreSettled())
			try {
				await deps.finalizeStopNative(producerOutcome)
			} catch {
				fail()
			}
			if (firstFailure) throw firstFailure
		})
		return final
	}
	return Object.freeze({
		sealAdmission,
		producerSettled,
		managerSettled,
		coreSettled,
		completed,
	})
}

/**
 * Main application bootstrap function.
 *
 * Initializes all components in the correct order:
 * 1. Load configuration
 * 2. Create logger
 * 3. Create graceful shutdown handler
 * 4. Initialize core components (SourceManager, FanoutManager, AudioOutput)
 * 5. Initialize decoder system (Registry, Manager)
 * 6. Register built-in decoders
 * 7. Create decoders from configuration
 * 8. Initialize API server
 * 9. Register shutdown handlers
 * 10. Start API server
 * 11. Connect to configured sources
 * 12. Start enabled decoders
 */
async function main(): Promise<void> {
	// Step 1: Load configuration (Requirement 12.1)
	const config = loadConfig()

	// Step 2: Create logger
	const loggerConfig: { level: typeof config.logging.level; dir?: string } = {
		level: config.logging.level,
	}
	if (config.logging.dir !== undefined) {
		loggerConfig.dir = config.logging.dir
	}
	const logger = createLogger(loggerConfig)
	const log = createComponentLogger(logger, "Main")

	log.info(
		{
			config: {
				accessMode: config.access.mode,
				sources: config.sources.length,
				decoders: config.decoders.length,
			},
		},
		"Starting WaveKit",
	)

	const protectedMode = config.access.mode === "protected"
	let access: NamedAccessRuntimeContext | undefined
	let accessBootstrap: ProtectedAccessBootstrap | undefined
	let stopping = false
	let settled!: () => void
	const startupSettled = new Promise<void>(resolve => {
		settled = resolve
	})
	const cleanup: { priority: number; run: () => void | Promise<void> }[] = []
	const admissionGates: (() => void)[] = []
	const own = (priority: number, run: () => void | Promise<void>) => {
		if (protectedMode) cleanup.push({ priority, run })
	}
	let runtimeApi: ApiServer | undefined
	// Idempotent; also closed by ApiServer.stop(). Covers a legacy stop during startup.
	let closeBandPlans: (() => Promise<void>) | undefined
	let disposeReceiver: (() => void) | undefined
	let receiverDisposeResult: Promise<void> | undefined
	const disposeReceiverAfterApi = (): Promise<void> => {
		receiverDisposeResult ??= (async () => {
			// A utility-handler timeout cannot authorize disposal before actual drain.
			await runtimeApi?.stop()
			disposeReceiver?.()
		})()
		return receiverDisposeResult
	}
	let runtimeDecoders: DecoderManager | undefined
	let runtimeChannelizer: ChannelizerManager | null = null
	let scanner: ScannerService | null = null
	const scannerConstruction = new ScannerLifecycleOwner()
	let scannerConstructionStarted = false
	let scannerConstructionSettled = false
	let settlementObserver: ChannelSettlementObserver | undefined
	let providerLifetime: ProviderLifetime | undefined
	const scannerPhases = createScannerRuntimePhases({
		sealAdmission: () => {
			// Attempt every independent gate even if one owner rejects sealing.
			let failed = false
			for (const seal of [
				() => scannerConstruction.sealAdmission(),
				() => scanner?.sealAdmission(),
				() => providerLifetime?.sealAdmission(),
				() => settlementObserver?.sealAdmission(),
			]) {
				try {
					seal()
				} catch {
					failed = true
				}
			}
			if (failed)
				throw new WaveKitError(
					"Scanner admission incomplete",
					"ACCESS_UNAVAILABLE",
				)
		},
		drainBeforeProducer: async () => {
			await startupSettled
			await runtimeApi?.stop()
		},
		beginStop: () => {
			if (!scannerConstructionStarted && !scannerConstructionSettled) {
				// Startup is now sealed/settled: no constructor capability escaped.
				scannerConstructionSettled = true
				scannerConstruction.completeConstruction({ ok: true })
			}
			return scannerConstruction.beginStop()
		},
		stopDecoders: async () => {
			await runtimeDecoders?.destroy()
		},
		stopChannelizer: async () => {
			await runtimeChannelizer?.destroy()
		},
		attemptLocalCleanup: () =>
			providerLifetime?.attemptLocalCleanup() ?? Promise.resolve([]),
		finalizeStopNative: async () => {
			if (scanner) await scanner.finalizeStopNative()
			else
				await scannerConstruction.finalizeStopNative(
					settlementObserver,
					providerLifetime,
				)
		},
	})
	admissionGates.push(scannerPhases.sealAdmission)
	own(40, scannerPhases.producerSettled)
	own(60, scannerPhases.managerSettled)
	own(65, scannerPhases.coreSettled)
	own(66, scannerPhases.completed)
	const checkpoint = () => {
		if (stopping)
			throw new WaveKitError("Startup stopped", "ACCESS_UNAVAILABLE")
	}
	let admissionFailed = false
	let closing: Promise<void> | undefined
	let closeLegacy: (() => Promise<void>) | undefined
	const closeProtected = (): Promise<void> => {
		stopping = true
		for (const gate of admissionGates) {
			try {
				gate()
			} catch {
				admissionFailed = true
			}
		}
		closing ??= (async () => {
			await startupSettled
			// Real completion, never a timeout-race result, authorizes storage release.
			let failed = admissionFailed
			for (const entry of cleanup.sort((a, b) => a.priority - b.priority)) {
				try {
					await entry.run()
				} catch {
					failed = true
				}
			}
			if (failed)
				throw new WaveKitError(
					"Protected shutdown incomplete",
					"ACCESS_UNAVAILABLE",
				)
			await access?.close()
		})()
		return closing
	}
	if (protectedMode) {
		let signaled = false
		const signal = () => {
			if (signaled) return
			signaled = true
			const watchdog = setTimeout(() => process.exit(1), 10_000)
			void closeProtected().then(
				() => {
					clearTimeout(watchdog)
					process.exit(0)
				},
				() => process.exit(1),
			)
		}
		process.on("SIGTERM", signal)
		process.on("SIGINT", signal)
	}
	try {
		if (config.access.mode === "protected") {
			accessBootstrap = validateProtectedRuntimeMapping(
				config.access,
				config.api,
				{
					analog: LiveDemodConfigSchema.parse(config.liveDemod ?? {}).httpPort,
					digital: DigitalVoiceConfigSchema.parse(config.digitalVoice ?? {})
						.httpPort,
				},
			)
			access = await openAccessRuntime({
				bootstrap: accessBootstrap,
				audio: {
					analog: {
						listenerScheme: config.access.listenerScheme,
						allowedAuthorities: config.access.audio.analog.allowedAuthorities,
					},
					digital: {
						listenerScheme: config.access.listenerScheme,
						allowedAuthorities: config.access.audio.digital.allowedAuthorities,
					},
				},
				directory: process.env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] ?? "",
				ownership: "single-host-pid-namespace",
				logger,
			})
			checkpoint()
		}

		// CSDR ring sizing applies only to validated streaming stages; an inherited
		// native setting is stripped from child shells so it cannot widen that set.
		configureCsdrBuffers({
			enabled: config.csdr.boundedBuffers,
			elements: config.csdr.bufferElements,
		})
		if (process.env[CSDR_BUFFER_ENV] !== undefined) {
			log.warn(
				{ env: CSDR_BUFFER_ENV },
				"Ignoring inherited CSDR buffer setting; use csdr.boundedBuffers / WAVEKIT_CSDR__BOUNDED_BUFFERS",
			)
		}
		log.info(
			{
				boundedBuffers: config.csdr.boundedBuffers,
				bufferElements: config.csdr.bufferElements,
			},
			"CSDR ring policy",
		)

		// Step 3: Create graceful shutdown handler (Requirement 14.1)
		const shutdown = new GracefulShutdown({
			logger,
			shutdownTimeout: 10000, // 10 seconds max shutdown time
		})

		if (!protectedMode) {
			let legacyClosing: Promise<void> | undefined
			closeLegacy = () => {
				stopping = true
				for (const gate of admissionGates) {
					try {
						gate()
					} catch {
						admissionFailed = true
					}
				}
				legacyClosing ??= (async () => {
					await startupSettled
					// Utility timeouts may advance its hooks; actual phase dependencies cannot.
					const outcomes = await Promise.allSettled([
						shutdown.shutdown(),
						scannerPhases.completed(),
						disposeReceiverAfterApi().finally(() => closeBandPlans?.()),
					])
					if (admissionFailed || outcomes.some(x => x.status === "rejected"))
						throw new WaveKitError(
							"Runtime shutdown incomplete",
							"ACCESS_UNAVAILABLE",
						)
				})()
				return legacyClosing
			}
			let signaled = false
			const signal = () => {
				if (signaled) return
				signaled = true
				const watchdog = setTimeout(() => process.exit(1), 10_000)
				void closeLegacy!().then(
					() => {
						clearTimeout(watchdog)
						process.exit(0)
					},
					() => process.exit(1),
				)
			}
			process.on("SIGTERM", signal)
			process.on("SIGINT", signal)
		}

		// Step 4: Initialize core components
		const sourceManager = new SourceManager(logger, {
			signalFlatThresholdDbfs: config.health?.signalFlatThresholdDbfs,
			signalFlatHoldMs: config.health?.signalFlatHoldMs,
		})
		own(100, async () => {
			await disposeReceiverAfterApi()
			await sourceManager.disconnectAll()
		})
		const composed = composeLinkBurst({ log: logger })
		own(20, composed.dispose)
		const fanoutManager = new FanoutManager(logger)
		const sourceRouting = new SourceFanoutRouter(
			sourceManager,
			fanoutManager,
			logger,
			defaultSourceIdFor(config.sources),
			{
				linkBurst: composed.factories,
				dedicated: new Set(
					config.sources
						.filter(s => sourceScannerConfig(s).role === "dedicated")
						.map(s => s.id),
				),
			},
		)
		own(90, () => {
			sourceRouting.destroy()
			fanoutManager.destroy()
		})
		const audioOutput = new AudioOutput(logger, {
			port: config.audio.tcpPort,
			format: config.audio.format,
			sampleRate: config.audio.sampleRate,
		})
		own(70, () => audioOutput.stop())
		const tunerRelay = new TunerRelay(logger, sourceManager, sourceRouting, {
			enabled: !protectedMode && config.tunerRelay.enabled,
			host: config.tunerRelay.host,
			port: config.tunerRelay.port,
			sourceId: config.tunerRelay.sourceId,
			controlPolicy: config.tunerRelay.controlPolicy,
			maxClients: config.tunerRelay.maxClients,
		})
		own(80, () => tunerRelay.stop())
		const tunerController = new TunerController(logger, sourceManager, {
			reconnectPolicy: config.tuner.reconnectPolicy,
		})
		const { config: liveDemodConfig, publicOrigin: legacyAudioOrigin } =
			splitLiveDemodConfig(LiveDemodConfigSchema.parse(config.liveDemod ?? {}))
		const liveDemodOrigin = liveDemodAdvertisedOrigin(
			config.access,
			legacyAudioOrigin,
		)
		const liveDemod = new LiveDemodulator(
			logger,
			sourceManager,
			sourceRouting,
			liveDemodConfig,
			{
				...(access && config.access.mode === "protected"
					? {
							httpAccess: access.analogAudio,
							httpHost: config.access.audio.analog.bindHost,
						}
					: {}),
				...(liveDemodOrigin !== undefined
					? { publicOrigin: liveDemodOrigin }
					: {}),
			},
		)
		admissionGates.push(() => liveDemod.shutdownAdmission())
		own(50, () => liveDemod.stop())
		// WG10 req 3: identify's analog evidence; fed by the transmission tracker once it exists.
		const analogEvidence = identifyAnalogEvidence({
			liveDemod,
			tuner: tunerController,
			logger,
		})
		const digitalVoiceConfig = DigitalVoiceConfigSchema.parse(
			config.digitalVoice ?? {},
		)
		const digitalVoice = new DigitalVoiceService(
			logger,
			digitalVoiceConfig,
			access && config.access.mode === "protected"
				? {
						httpAccess: access.digitalAudio,
						publicOrigin: config.access.publicOrigins.digitalAudio,
						httpHost: config.access.audio.digital.bindHost,
					}
				: {},
		)
		admissionGates.push(() => digitalVoice.shutdownAdmission())
		own(50, () => digitalVoice.destroy())

		// Initialize tuner controller for configured RTL-TCP sources
		for (const sourceConfig of config.sources) {
			if (sourceConfig.type === "rtl_tcp") {
				tunerController.initializeSource(
					sourceConfig.id,
					sourceConfig.caps,
					sourceConfig.type,
				)
			}
		}

		// WG11 req 4.1: configured gain and AGC, written on connect (rtl_tcp only)
		applyConfiguredTuning(config.sources, tunerController, sourceId =>
			log.warn(
				{ sourceId },
				"Source tuner config ignored: only rtl_tcp sources support it",
			),
		)

		wireTunerControl({
			log,
			sourceManager,
			tunerController,
			tunerRelay,
			relayEnabled: !protectedMode && config.tunerRelay.enabled,
		})

		// Step 5: Initialize decoder system
		// Band region (built-in band defaults) and persisted API band overrides;
		// the store is loaded before startAll so the first check sees them.
		const bandRegion = resolveProcessBandRegion(config.region)
		log.info(
			{ region: bandRegion.code, source: bandRegion.source },
			"Band region",
		)
		const bandOverrides = new BandOverrideStore({
			stateDir: config.stateDir,
			logger,
		})
		await bandOverrides.load()
		checkpoint()

		// WG4 req 6: live station identity (env > yaml > ui > default). Opened before
		// the decoders so readsb reads its location; coverage follows a location change
		// once it exists (the API, the only writer, starts later).
		let applyStationLocation = (
			_location: { lat: number; lon: number } | null,
		): { cleared: boolean } => ({ cleared: false })
		const stationService = await openStationService({
			config,
			region: bandRegion.code,
			stateDir: config.stateDir,
			logger,
			writable: protectedMode || !STATION_WRITE_REQUIRES_ACCESS,
			onLocationChange: location => applyStationLocation(location),
		})
		own(12, () => stationService.close())
		checkpoint()
		// WG8 req 1-3: decoder settings overrides (<stateDir>/decoder-settings.json), loaded in
		// both modes; read-only until the manager port is set. Export stays YAML-only.
		const { catalogue, catalogueIds, unavailable, recheckAvailable } =
			await prepareDecoderCatalogue(config, bandRegion.code)
		checkpoint()
		let bandPlanService: BandPlanService | undefined
		const scannerBandplans = createScannerBandplanProvider(
			() => bandPlanService?.view(),
			bandRegion.code,
		)
		const bandplanChannels = createBandplanChannelLookup({
			getResolved: () => bandPlanService?.resolved(),
			scannerPlans: scannerBandplans,
		})
		const bandplanRangeContains = createBandplanRangeLookup({
			scannerPlans: scannerBandplans,
		})
		const efficiencyCpu = new CpuMeter({ sampleMs: EFFICIENCY_SAMPLE_MS })
		efficiencyCpu.start()
		own(20, () => efficiencyCpu.stop())
		let backpressureTracker: SourceBackpressureTracker | undefined
		const advisorRef: { current: ReturnType<typeof createLinkAdvisor> | null } =
			{ current: null }
		const monitor = createEfficiencyMonitor({
			sourceEvents: sourceManager,
			monoNow: composed.factories.monoNow,
			attributionApplies: id =>
				sourceRouting.linkBurst(id)?.transport === "network",
			recovery: (id, now) =>
				sourceRouting.linkBurst(id)?.recorder?.recovery(now) ?? null,
			ingest: (id, from, to) =>
				sourceRouting.linkBurst(id)?.recorder?.interval(from, to) ?? null,
			loopDelay: () => composed.loopMeter.takeInterval(),
			shortfall: id =>
				advisorRef.current?.shortfall(
					id,
					tunerController.getState(id)?.sampleRate ?? 0,
					frameBytesFor(sourceManager.getCaps(id)?.format ?? "") ?? 0,
				) ?? null,
			upstreamDroppedTotal: id =>
				config.resources.sdrHostPoller.enabled &&
				config.sources.find(source => source.id === id)?.sdrHost?.apiUrl
					? (backpressureTracker?.upstreamDroppedTotal(id) ?? null)
					: undefined,
			cpuGuardPercent:
				config.decoderPolicy?.efficiency?.cpuGuardPercent ??
				EFFICIENCY_CPU_GUARD_PERCENT,
			log: createComponentLogger(logger, "EfficiencyMonitor"),
			sources: () => sourceManager.getAllStatus().map(source => source.id),
			branchCounters: id => sourceRouting.branchDropCounters(id),
			topology: id => sourceRouting.branchTopology(id),
			cpu: efficiencyCpu,
			now: Date.now,
			onSample: sample => gate.record(sample),
			setInterval: (fn, ms) => {
				const timer = setInterval(fn, ms)
				timer.unref()
				return { cancel: () => clearInterval(timer) }
			},
		})
		monitor.start()
		own(20, () => monitor.stop())
		const gate = composeDecoderEfficiencyGate(
			{
				budgetCores:
					config.decoderPolicy?.efficiency?.cpuBudgetCores ??
					defaultCpuBudgetCores(arch(), cpus().length),
				cpuGuardPercent:
					config.decoderPolicy?.efficiency?.cpuGuardPercent ??
					EFFICIENCY_CPU_GUARD_PERCENT,
			},
			monitor,
			createComponentLogger(logger, "EfficiencyGate"),
		)
		// auto-listen-route 3.4: bumped at every event that can change voice coverage.
		let coverageGeneration = 0
		const vfo = createVfoTracker({
			now: () => performance.now(),
			setTimer: decoderPolicyTimer,
			onSettled: value => {
				decoderManager.notifyVfoSettled(value)
				coverageGeneration++
			},
		})
		const updateVfo = () =>
			vfo.update(
				vfoFromLiveDemod({
					sourceId: () =>
						liveDemod.getStatus().sourceId ||
						defaultSourceIdFor(config.sources) ||
						null,
					offsetHz: () => liveDemod.getStatus().config.offsetHz,
					centreHz: id => sourceManager.getCaps(id)?.centerFreq ?? null,
				}),
			)
		liveDemod.on("config-changed", updateVfo)
		sourceManager.on("caps-changed", updateVfo)
		sourceManager.on("connected", updateVfo)
		const bumpCoverage = () => {
			coverageGeneration++
		}
		liveDemod.on("config-changed", bumpCoverage)
		sourceManager.on("caps-changed", bumpCoverage)
		const closeVfo = () => {
			vfo.dispose()
			liveDemod.off("config-changed", updateVfo)
			sourceManager.off("caps-changed", updateVfo)
			sourceManager.off("connected", updateVfo)
			liveDemod.off("config-changed", bumpCoverage)
			sourceManager.off("caps-changed", bumpCoverage)
		}
		own(20, closeVfo)
		const modeBinding = composeDecoderModes(
			() => readResolvedMode,
			() => decoderManager,
		)
		const resolvedModes = modeBinding.resolvedModes
		const decoderSettings = await openDecoderSettingsService({
			configs: catalogue,
			stateDir: config.stateDir,
			logger,
			applyDecoderMode: modeBinding.applyDecoderMode,
		})
		own(12, () => decoderSettings.close())
		checkpoint()
		const readResolvedMode = (id: string): ResolvedMode => {
			const original = catalogue.find(c => c.id === id)
			if (!original) return { mode: "off", source: "default" }
			const mode = decoderSettings.view(id)?.mode
			return resolveDecoderMode({
				settingsMode: mode?.source === "override" ? mode.value : undefined,
				configMode: original.mode,
				configEnabled: decoderSettings.effectiveConfig(original).enabled,
				configBandSuspension: original.band?.bandSuspension,
			})
		}
		// Read views before installing the status port: views consult manager status.
		for (const config of catalogue)
			resolvedModes.set(config.id, readResolvedMode(config.id))
		const decoderRegistry = new DecoderRegistry()
		const decoderManager = new DecoderManager(
			decoderRegistry,
			fanoutManager,
			logger,
			{
				...createDecoderManagerOptions(config.health, bandRegion),
				enablement: {
					planner: input => planPlacements({ ...input, bandplanRangeContains }),
					resolveMode: id =>
						resolvedModes.get(id) ?? { mode: "off", source: "default" },
					isCatalogue: value => catalogueIds.has(value.id),
					unavailable: id => unavailable.has(id),
					recheckAvailable,
					vfo: () => vfo.current(),
					bandplanChannels,
					maxBandplanChannels:
						config.decoderPolicy?.efficiency?.maxBandplanChannels ??
						DECODER_MAX_BANDPLAN_CHANNELS,
					gate,
				},
			},
			bandOverrides,
		)

		runtimeDecoders = decoderManager
		// WG8 req 2.4: PATCH stages effective option values on the manager (next start)
		decoderSettings.setManager(decoderSettingsPort(decoderManager))

		// Wire DecoderManager to SourceManager for dynamic sample rate handling
		decoderManager.setSourceManager(sourceManager, sourceRouting)

		// auto-listen-route 3.4: coverage only on a verified, settled frequency that matches.
		const coverageEvents = [
			"decoder:started",
			"decoder:stopped",
			"decoder:removed",
			"decoder:status-changed",
		] as const
		for (const event of coverageEvents) decoderManager.on(event, bumpCoverage)
		own(20, () => {
			for (const event of coverageEvents)
				decoderManager.off(event, bumpCoverage)
		})
		const liveVfo = () =>
			vfoFromLiveDemod({
				sourceId: () =>
					liveDemod.getStatus().sourceId ||
					defaultSourceIdFor(config.sources) ||
					null,
				offsetHz: () => liveDemod.getStatus().config.offsetHz,
				centreHz: id => sourceManager.getCaps(id)?.centerFreq ?? null,
			})
		liveDemod.attachAutoRouteVoice(digitalVoice, {
			get generation() {
				return coverageGeneration
			},
			covers: decoderId => {
				try {
					const live = liveVfo()
					const settled = vfo.current()
					const status = decoderManager.getStatus(decoderId)
					if (!live || !settled || !status) return "unknown"
					if (
						settled.sourceId !== live.sourceId ||
						settled.frequencyHz !== live.frequencyHz
					)
						return "unknown"
					if (!status.running) return "no"
					const half = liveDemod.getStatus().config.bandwidth / 2
					const near = (hz: number | undefined) =>
						hz !== undefined && Math.abs(hz - live.frequencyHz) <= half
					const placements = status.placements ?? []
					if (placements.length > 0)
						return placements.some(
							p =>
								p.running && p.sourceId === live.sourceId && near(p.channelHz),
						)
							? "yes"
							: "no"
					if (status.sourceId === undefined) return "unknown"
					if (status.sourceId !== live.sourceId) return "no"
					return (status.targetFrequenciesHz ?? []).some(hz => near(hz))
						? "yes"
						: "no"
				} catch {
					return "unknown"
				}
			},
		})

		// Core channelizer (addendum §4): one wavekit-chan per source, spawned on the
		// first channel request. Without `channelizer.enabled` it is composed only
		// where automatic composition is accepted for this host's architecture.
		const composedChannels = composeDecoderChannelizer(
			{
				sourceManager,
				routing: sourceRouting,
				config: config.channelizer,
				logger,
				ownObservation: (observer, lifetime) => {
					settlementObserver = observer
					providerLifetime = lifetime
				},
			},
			async () => {
				try {
					await scannerPhases.producerSettled()
					return { ok: true }
				} catch {
					return {
						ok: false,
						state: "unknown",
						detail: "Scanner construction cleanup incomplete",
					}
				}
			},
			// Requirement 5.4: auto composition is accepted on x86-64 hosts only.
			channelizerAutoAccepted(arch()),
		)
		const { channelizer, channels } = composedChannels
		providerLifetime = composedChannels.lifetime
		settlementObserver = composedChannels.observer
		runtimeChannelizer = channelizer
		decoderManager.setChannelizer(channels)

		// Step 6: Register built-in decoders with capabilities
		decoderRegistry.register("dsd-fme", createDsdFmeDecoder, DSD_FME_CAPS)
		decoderRegistry.register(
			"multimon-ng",
			createMultimonDecoder,
			MULTIMON_CAPS,
		)
		decoderRegistry.register("rtl433", createRtl433Decoder, RTL433_CAPS)
		// readsb is the only decoder that receives the station location (WG3 req 9.1),
		// read from the station service at each readsb start
		decoderRegistry.register(
			"readsb",
			readsbDecoderFactory(() => stationService.location()),
			READSB_CAPS,
		)
		decoderRegistry.register("acarsdec", createAcarsdecDecoder, ACARSDEC_CAPS)
		decoderRegistry.register(
			"ais-catcher",
			createAisCatcherDecoder,
			AIS_CATCHER_CAPS,
		)
		decoderRegistry.register("dumpvdl2", createDumpvdl2Decoder, DUMPVDL2_CAPS)
		decoderRegistry.register("direwolf", createDirewolfDecoder, DIREWOLF_CAPS)
		decoderRegistry.register(
			"lora-meshtastic",
			createLoraMeshtasticDecoder,
			LORA_MESHTASTIC_CAPS,
		)

		log.info(
			{ registeredDecoders: decoderRegistry.getRegisteredTypes() },
			"Built-in decoders registered",
		)

		// WG8 req 4: read-only recordings inventory (protected routes only). dsd-fme per-call
		// directories of the configured decoders (probes excluded), sorted by decoder id; the
		// scanner's recordings root as its service resolves it, none without a scanner.
		// WG9 req 2.5, 2.7: built before any decoder with the deletion decision bound late (the
		// keep service needs the inventory); until it is bound every answer is "protected".
		let recordingKeeps: RecordingKeepService | undefined
		const recordingInventory = createRecordingInventory({
			dsdFmeDirs: () => recordingDsdFmeDirs(decoderManager),
			scannerRecordingsDir: () => {
				if (scanner === null) return null
				const storage = scanner.settings().storage
				return join(
					resolve(storage.dir ?? join(config.stateDir, "scanner")),
					"recordings",
				)
			},
			discoveryCentreHz: id => scanner?.getDiscovery(id)?.frequencyHz ?? null,
			logger,
			protection: lateBoundRecordingProtection(() => recordingKeeps),
		})
		// WG9 req 2.3-2.5: the keep store (<stateDir>/recording-keeps.json), loaded in both modes
		// before any decoder exists, so no pruner runs while it loads; a bad file leaves it failed
		// (everything protected). Keep, unkeep and delete routes are mounted in protected mode only.
		const keeps = await openRecordingKeepService({
			stateDir: config.stateDir,
			inventory: recordingInventory,
			logger,
			// WG10 req 1.1: delete routes exist in protected mode only.
			...(protectedMode
				? { scannerDeleter: lateBoundScannerDeleter(() => scanner) }
				: {}),
		})
		recordingKeeps = keeps
		own(67, () => keeps.close())
		checkpoint()
		setCallRecordingProtection(keeps, logger)

		// Step 7: Create decoders from configuration. dsd-fme decoders are first
		// pointed at the digital voice stream (-o udp to a local socket).
		// Overrides apply BEFORE the digital-voice preparation, which rewrites dsd-fme output.
		const effectiveDecoders = effectiveDecoderConfigs(
			decoderSettings,
			catalogue,
		)
		let decoderConfigs: DecoderConfig[] = effectiveDecoders
		try {
			decoderConfigs = await prepareDecoderVoice(
				digitalVoice,
				effectiveDecoders,
				catalogueIds,
				unavailable,
			)
			checkpoint()
		} catch (err) {
			if (stopping) throw err
			log.error(
				protectedMode ? { code: "RUNTIME_ERROR" } : { err },
				"Digital voice setup failed; decoders keep their output",
			)
		}
		// Configured instances digital voice follows; scanner probes attach in the probe pool.
		const voiceAttached = new Map<string, Decoder>()
		for (const decoderConfig of decoderConfigs) {
			try {
				const decoder = decoderManager.createDecoder(decoderConfig)
				digitalVoice.attachDecoder(decoderConfig.id, decoder)
				voiceAttached.set(decoderConfig.id, decoder)
				log.info(
					{ decoderId: decoderConfig.id, type: decoderConfig.type },
					"Decoder created",
				)
			} catch (err) {
				if (stopping) throw err
				log.error(
					{
						...(protectedMode ? { code: "RUNTIME_ERROR" } : { err }),
						decoderId: decoderConfig.id,
						type: decoderConfig.type,
					},
					"Failed to create decoder",
				)
			}
		}

		// WG8 req 3.1: re-attach digital voice to a rebuilt instance. Registered before startAll.
		followRebuiltVoiceDecoders(decoderManager, digitalVoice, voiceAttached)

		// WG10 req 1.9: interrupted recording deletes, swept after the keep service resolved and
		// the decoders exist, before any decoder or the scanner starts. Protected mode only (the
		// delete routes exist only there); the keep service's state() is the readiness proof.
		if (protectedMode) {
			await sweepRecordingDeleteLeftovers({
				dsdFmeDirs: recordingDsdFmeDirs(decoderManager).map(d => d.dir),
				scannerRecordingsDir: await scannerDeleteSweepDir(
					config.stateDir,
					config.scanner.storage.dir,
				),
				protection: keeps,
				logger,
			})
			checkpoint()
		}

		// Step 7b: Signal discovery scanner + core spectrum service (docs/SCANNER.md).
		// Built after the decoders and digital voice so probes and ambient evidence
		// can attach, and started before any source connects, so a persisted tuner
		// lease is restored on the source's first payload-started (spec § 10.3).
		// Always constructed: with scanner.enabled false it runs no jobs, but its
		// SpectrumService still serves `spectrum` subscribers and /api/spectrum.
		// An unreadable state directory never reaches this catch: start() logs it and
		// runs without the unread files (Task 35). Only an unexpected construction or
		// start failure drops the scanner, and with it /api/spectrum.
		// The band-plan service opens later in startup; until then, and if its view
		// throws, the scanner falls back to the built-in plans for the region.
		// Read per call: a committed stack applies to the next job create, patch or
		// preview; a resumed or running job keeps the plans it was admitted with.
		const bandPlanLog = createComponentLogger(logger, "BandPlans")
		let bandPlanSkipsWarned = false
		let ambientProvenance: ActivityProvenanceLookup | null = null
		const { channelTier, ...scannerSettings } = config.scanner
		// WG8 req 5.2: the host bins cap, resolved once (bounded bench, or the configured value)
		const spectrumBinsCap = resolveSpectrumBinsCap(
			config.scanner.ws.spectrumBinsCap ?? "auto",
		)
		log.info(
			{
				setting: spectrumBinsCap.setting,
				cap: spectrumBinsCap.cap,
				source: spectrumBinsCap.source,
				wallMs: spectrumBinsCap.wallMs,
			},
			"Spectrum bins cap resolved",
		)
		const spectrumBinsCapView = Object.freeze({
			setting: spectrumBinsCap.setting,
			cap: spectrumBinsCap.cap,
			source: spectrumBinsCap.source,
		})
		// Persistent replay and private analog trials share one guarded capture service.
		// With capture disabled its native ring runs only for an active trial lease.
		let iqCapture: IqCaptureService | null = null
		// Shared by replay admission and identify; created with the capture service.
		let analogTrial: AnalogTrialRunner | undefined
		{
			const service = createIqCaptureService({
				config: config.scanner.iqCapture,
				trialOnly: !config.scanner.iqCapture?.enabled,
				storageRoot: resolve(
					config.scanner.storage.dir || join(config.stateDir, "scanner"),
				),
				protectedMode,
				logger,
			})
			iqCapture = service
			analogTrial = createAnalogLiveRunner(
				service,
				createAnalogTrialRunner({
					port: service,
					tones: () => new ToneDetector(),
					logger,
				}),
			)
			own(45, () => service.stop())
			await service.sweep()
		}
		try {
			scannerConstructionStarted = true
			scanner = new ScannerService({
				settings: scannerSettings,
				...(iqCapture ? { iqCapture } : {}),
				...(analogTrial ? { analogTrial } : {}),
				analogEvidence,
				recordingProtection: keeps,
				construction: scannerConstruction,
				channels,
				channelUsableFraction: config.channelizer.usableFraction,
				channelTier: Object.freeze({ ...channelTier }),
				channelProfile: null,
				...(settlementObserver && providerLifetime
					? {
							channelOwnership: {
								observer: settlementObserver,
								lifetime: providerLifetime,
								construction: scannerConstruction,
							},
						}
					: {}),
				sourceConfigs: config.sources,
				decoderConfigs,
				spectrumBinsCap: () => spectrumBinsCapView,
				region: bandRegion.code,
				bandplans: scannerBandplans,
				stateDir: config.stateDir,
				sources: sourceManager,
				routing: sourceRouting,
				tuner: tunerController,
				decoders: decoderManager,
				// WG6 req 1.1: read once per plan; the mapper and the plan fail closed (a
				// decoder counts only when its own running state and band assessment prove it).
				decoderCoverage: () => {
					try {
						const defaultSourceId = sourceRouting.getDefaultSourceId() ?? null
						return decoderManager
							.getAllStatus()
							.map(s => toDecoderCoverageView(s, defaultSourceId))
					} catch (err) {
						log.warn(
							protectedMode ? { code: "RUNTIME_ERROR" } : { err },
							"Decoder statuses unavailable; plans claim no decoded-elsewhere ranges",
						)
						return []
					}
				},
				// WG7 req 6.2, 6.6: skip-marked band-plan segments, read once per plan (legacy and
				// protected mode alike). Fails closed: no band-plan service yet, or a throwing
				// view, means no skips (logged once).
				bandPlanSkips: () => {
					try {
						return bandPlanService
							? bandPlanSkipSources(bandPlanService.resolved())
							: []
					} catch (err) {
						if (!bandPlanSkipsWarned) {
							bandPlanSkipsWarned = true
							bandPlanLog.warn(
								protectedMode ? { code: "RUNTIME_ERROR" } : { err },
								"Band-plan view unavailable; plans apply no band-plan skips",
							)
						}
						return []
					}
				},
				// WG7 req 1.3: the decoder's own provenance binding; only commanded/relay, on the very
				// source the ambient target names, at a frequency within 1 kHz of a binding target
				// (the frequencies trust was proven for). Anything else: undefined (fail closed).
				ambientTrust: (decoderId, hz, sourceId) =>
					ambientTrustFromBinding(ambientProvenance?.(decoderId), hz, sourceId),
				digitalVoice,
				liveDemod,
				operatorActivity: liveDemodOperatorActivity(liveDemod),
				logger,
				cpuMeter: efficiencyCpu,
			})
			scannerConstructionSettled = true
			scannerConstruction.completeConstruction({ ok: true })
			await iqCapture?.start()
			await scanner.start()
			checkpoint()
		} catch (err) {
			if (!scannerConstructionSettled) {
				scannerConstructionSettled = true
				scannerConstruction.completeConstruction({
					ok: false,
					state: "unknown",
					detail: "Scanner construction incomplete",
				})
			}
			if (stopping) throw err
			log.error(
				protectedMode ? { code: "RUNTIME_ERROR" } : { err },
				protectedMode
					? "Scanner startup failed; attempting cleanup"
					: "Scanner failed to start; continuing without it",
			)
			// A partial start leaves listeners, spectrum fanout branches and timers behind and
			// there is no shutdown hook for a null scanner: stop it before dropping it.
			if (protectedMode) {
				// Rejection aborts startup; shutdown observes this same rejection
				// while still attempting the remaining owned cleanup.
				await scannerConstruction.beginStop().producerSettled
			} else {
				await scannerConstruction
					.beginStop()
					.producerSettled.catch((stopErr: unknown) =>
						log.warn(
							{ err: stopErr },
							"Stopping the partially started scanner failed",
						),
					)
			}
			scanner = null
		}

		checkpoint()

		// Scanner construction failure may have stopped the shared meter.
		efficiencyCpu.start()
		// Step 8: Initialize resource monitoring (if enabled)
		let resourceAggregator: ResourceAggregator | undefined
		let containerMonitor: ContainerMonitor | undefined
		let sdrHostPoller: SdrHostPoller | undefined
		let endpointSelector: EndpointSelector | undefined
		const linkInputOf = (id: string) => {
			const source = sourceManager.getConfig(id)
			const rate = tunerController.getState(id)?.sampleRate
			return source?.host && rate
				? { sourceId: id, host: source.host, sampleRateHz: rate }
				: null
		}
		const linkQuality = createLinkQuality({
			sources: () => sourceManager.getAllStatus().map(source => source.id),
			handles: id => sourceRouting.linkBurst(id),
			attribution: id => monitor.attributionCounts(id),
			upstreamDropRate: id => backpressureTracker?.peekDropRate(id) ?? null,
			receiver: id => sdrHostPoller?.getLinkFacts(id) ?? null,
			loopDelay: () => composed.loopMeter.report(monitor.monoNow()),
			monoNow: monitor.monoNow,
			now: Date.now,
			advisory: id => {
				const input = linkInputOf(id)
				return input && advisorRef.current
					? advisorRef.current.classify(
							input,
							backpressureTracker?.peekDropRate(id) ?? null,
						)
					: null
			},
			reportAdvisory: (id, advisory) =>
				resourceAggregator?.reportLinkAdvisory(id, advisory),
		})

		if (config.resources.enabled) {
			// Create container monitor
			if (config.resources.containerMonitor.enabled) {
				containerMonitor = new ContainerMonitor(logger, {
					pollIntervalMs: config.resources.containerMonitor.pollIntervalMs,
					emitSnapshots: false, // ResourceAggregator handles broadcasting
				})
			}

			// Create SDR host poller with auto-detection
			// For rtl_tcp sources, try to detect SDR host API at standard ports
			// Explicit sdrHost config overrides auto-detection
			const sdrHostConfigs: SdrHostConfig[] = config.sources
				.filter(s => s.type === "rtl_tcp" && s.host) // Only rtl_tcp with host
				.map(s => {
					// Explicit config takes priority
					if (s.sdrHost?.apiUrl) {
						const cfg: SdrHostConfig = {
							sourceId: s.id,
							apiUrl: s.sdrHost.apiUrl,
						}
						if (s.sdrHost.rtlmuxStatsUrl) {
							cfg.rtlmuxStatsUrl = s.sdrHost.rtlmuxStatsUrl
						}
						return cfg
					}

					// Auto-detect: use source host with standard SDR host ports
					const cfg: SdrHostConfig = {
						sourceId: s.id,
						apiUrl: `http://${s.host}:8080`, // Standard wavekit-sdr-host port
					}
					cfg.rtlmuxStatsUrl = `http://${s.host}:5556/stats.json` // Standard rtlmux stats
					return cfg
				})

			if (config.resources.sdrHostPoller.enabled && sdrHostConfigs.length > 0) {
				sdrHostPoller = new SdrHostPoller(logger, sdrHostConfigs, {
					pollIntervalMs: config.resources.sdrHostPoller.pollIntervalMs,
					timeoutMs: config.resources.sdrHostPoller.timeoutMs,
				})
				log.info(
					{
						count: sdrHostConfigs.length,
						sources: sdrHostConfigs.map(c => c.sourceId),
					},
					"SDR host polling configured (auto-detected from source hosts)",
				)
			}

			// Receiver endpoint selection (receiver-endpoints 3.1): opt-in per source.
			const endpointTargets: EndpointSelectionTarget[] = config.sources.flatMap(
				s =>
					s.type === "rtl_tcp" &&
					s.host &&
					s.port &&
					s.sdrHost?.endpointSelection === "auto" &&
					plainHttpApiUrl(s.sdrHost.apiUrl)
						? [
								{
									sourceId: s.id,
									configuredHost: s.host,
									port: s.port,
									apiPort: configuredApiPort(s.sdrHost.apiUrl),
								},
							]
						: [],
			)
			if (endpointTargets.length > 0 && sdrHostPoller) {
				const selector = new EndpointSelector(
					logger,
					sourceManager,
					createEndpointProbe(),
					endpointTargets,
				)
				endpointSelector = selector
				sdrHostPoller.on("receiver-endpoints", (sourceId, report) => {
					selector.onReport(sourceId, report).catch((err: unknown) => {
						log.warn({ err, sourceId }, "Endpoint selection failed")
					})
				})
				sourceManager.on("endpoint-fallback", (sourceId, host) => {
					selector.onFallback(sourceId, host)
				})
				log.info(
					{ sources: endpointTargets.map(t => t.sourceId) },
					"Receiver endpoint selection enabled",
				)
			}

			// Create backpressure tracker
			backpressureTracker = new SourceBackpressureTracker(
				logger,
				sourceManager,
				sdrHostPoller ?? null,
			)

			// Create resource aggregator
			resourceAggregator = new ResourceAggregator(
				logger,
				{
					broadcastIntervalMs: config.resources.broadcastIntervalMs,
					autoBroadcast: true,
				},
				{
					containerMonitor: containerMonitor ?? null,
					sdrHostPoller: sdrHostPoller ?? null,
					backpressureTracker,
					linkQuality,
				},
			)

			log.info(
				{
					containerMonitor: !!containerMonitor,
					sdrHostPoller: !!sdrHostPoller,
					sdrHostCount: sdrHostConfigs.length,
				},
				"Resource monitoring initialized",
			)
		}

		for (const s of config.sources) {
			if (s.sdrHost?.endpointSelection !== "auto") continue
			const reason =
				s.type !== "rtl_tcp" || !s.host || !s.port
					? "it applies only to rtl_tcp sources with a host and port"
					: !plainHttpApiUrl(s.sdrHost.apiUrl)
						? "sdrHost.apiUrl must be a plain http://host[:port] URL"
						: !endpointSelector
							? "it needs resources.enabled and the SDR host poller"
							: null
			if (reason)
				log.warn(
					{ sourceId: s.id },
					`Receiver endpoint selection stays off for this source: ${reason}`,
				)
		}
		own(20, () => {
			endpointSelector?.stop()
			resourceAggregator?.stop()
			sdrHostPoller?.stop()
			containerMonitor?.stop()
		})
		const linkAdvisor = createLinkAdvisor({
			now: Date.now,
			monoNow: monitor.monoNow,
			linkDropsSince: monitor.linkDropsSince,
			burst: id => linkQuality.burst(id),
		})
		advisorRef.current = linkAdvisor
		const ratePolicy = createRatePolicy({
			port: { readsbOn: id => decoderManager.readsbRateFacts(id) },
			tuner: {
				sampleRateOf: id => tunerController.getState(id)?.sampleRate ?? null,
				controlModeOf: id => tunerController.getState(id)?.controlMode ?? null,
				setSampleRate: (id, hz, opts) =>
					tunerController.setSampleRate(id, hz, opts),
			},
			link: linkAdvisor,
			linkInput: linkInputOf,
			upstreamDropsOf: id => backpressureTracker?.peekDropRate(id) ?? null,
			reportLink: decoderLinkReporter(() => resourceAggregator),
			setTimer: decoderPolicyTimer,
			emit: event => tunerController.emitRatePolicy(event),
			now: () => new Date(),
			log: logger,
			enabled: config.decoderPolicy?.rateRaise !== false,
		})
		const closeRatePolicy = composeDecoderRatePolicyLifetime(
			sourceManager,
			tunerController,
			linkAdvisor,
			ratePolicy,
		)

		own(20, closeRatePolicy)
		// Step 8b: Initialize aircraft tracking (ADS-B specific)
		const aircraftTrackingManager = new AircraftTrackingManager(
			decoderManager,
			{
				maxAge: 60,
				cleanupInterval: 5000,
				maxTrackPoints: 100,
				minTrackDistance: 50,
			},
			logger,
		)

		// Step 8c: Initialize aircraft enrichment service (ADS-B specific)
		const aircraftEnrichmentService = new AircraftEnrichmentService(
			{
				cacheTtlMs: 24 * 60 * 60 * 1000, // 24 hours
				maxCacheSize: 10000,
				rateLimitMs: 1000, // 1 request per second
				enabled: true,
			},
			logger,
		)
		aircraftEnrichmentService.wireToTracker(
			aircraftTrackingManager.getTracker(),
		)
		// Wire enrichment cache stats to tracker for accurate stats reporting
		aircraftTrackingManager
			.getTracker()
			.setEnrichmentCacheProvider(aircraftEnrichmentService)

		own(20, () => {
			aircraftEnrichmentService.stop()
			aircraftTrackingManager.stop()
		})

		// Step 8d: AIS vessel current state (WG1 req 5, 6)
		const vesselTrackingManager = new VesselTrackingManager(
			decoderManager,
			{},
			logger,
		)
		own(20, () => {
			vesselTrackingManager.stop()
		})

		// Step 8d': ADS-B and AIS coverage per bearing from the station (WG3 req 7);
		// without a station location the route answers available: false.
		const coverageManager = new CoverageManager({
			station: stationService.location(),
			aircraft: aircraftTrackingManager.getTracker(),
			vessels: vesselTrackingManager.getTracker(),
		})
		// A PATCH moving the station > STATION_COVERAGE_RESET_M (or clearing it) resets coverage
		applyStationLocation = location => coverageManager.setStation(location)
		own(20, () => {
			coverageManager.stop()
		})

		// Step 8e: APRS station, object and item current state (WG2 req 3, 4)
		const aprsTrackingManager = new AprsTrackingManager(
			decoderManager,
			{},
			logger,
		)
		own(20, () => {
			aprsTrackingManager.stop()
		})

		// Step 8f: Meshtastic node current state (WG2 req 5, 6)
		const meshTrackingManager = new MeshTrackingManager(
			decoderManager,
			{},
			logger,
		)
		own(20, () => {
			meshTrackingManager.stop()
		})

		// Step 8g: approximate station location from heard positions (WG4 req 2),
		// computed on request over live tracker snapshots
		const stationEstimate = createStationEstimator({
			aircraft: () => aircraftTrackingManager.getTracker().getAll(),
			vessels: () => vesselTrackingManager.getTracker().getAll(),
			aprs: () => aprsTrackingManager.getTracker().getAll(),
			mesh: () => meshTrackingManager.getTracker().getAll(),
			stationConfigured: () => stationService.location() !== null,
		})

		// Read-only metadata providers add no source consumers or receiver actions.
		const regionalRegistry = createRegionalRegistry(
			createRegionalRegistration(),
		)
		const receiverCapabilitiesProvider = createReceiverCapabilitiesProvider(
			{
				read: id => sourceManager.getReceiverEvidence(id),
				readPage: (after, limit) =>
					sourceManager.getReceiverEvidencePage(after, limit),
			},
			TUNER_REST_COMMAND_POLICY,
			id => {
				const source = sourceManager.getConfig(id)
				return source
					? {
							configured: source.delivery ?? "auto",
							advertised:
								sdrHostPoller?.getStatus(id)?.iqDelivery?.modes ?? null,
						}
					: null
			},
		)
		let receiverDisposed = false
		disposeReceiver = () => {
			if (receiverDisposed) return
			receiverCapabilitiesProvider.dispose()
			receiverDisposed = true
		}
		// Own immediately, including a constructor failure before runtimeApi exists.
		own(15, disposeReceiverAfterApi)

		// WG3 req 5: RF provenance on receptions from each decoder's binding (config and
		// scanner probes alike), kept current on decoder create/remove. WG5 req 6:
		// tuningTrust is "commanded" (internal control) or "relay" (external) when the
		// observed tuner state proves the decoder hears its targets, else "unverified".
		const decoderProvenance = createDecoderProvenanceIndex(
			decoderManager,
			() => sourceRouting.getDefaultSourceId(),
			tunerController,
		)
		own(8, () => decoderProvenance.dispose())
		ambientProvenance = decoderProvenance.lookup

		// Activity runs when config.activity.enabled (the default). A failed probe or open
		// logs and leaves the rest of WaveKit running.
		const activity = await startActivityRuntime({
			...activityConfigOptions(config.activity),
			stateDir: config.stateDir,
			logger,
			setPublisher: publish => {
				decoderManager.setActivityPublisher(publish)
			},
			discloseErrors: !protectedMode,
			resolveProvenance: decoderProvenance.lookup,
		})
		// Own before checkpoint: a stop during open must still close the workers.
		own(8, () => activity.close())
		checkpoint()

		// WG4 req 3: storage report over the areas WaveKit writes. Areas and the low-space
		// threshold are read at each scan (cache misses), so runtime scanner settings and
		// the scanner's presence show; Activity retention is read per report (null when
		// disabled, a throwing stats() reports retention: null). Scanner probes record
		// inside scanner storage, already its area.
		const activityLimits = storageActivityLimits(config.activity.retention)
		const accessDirectory = access
			? (process.env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] ?? null)
			: null
		const storageSources = liveStorageReportSources({
			stateDir: config.stateDir,
			activityMaxDbBytes: activityLimits?.maxDbBytes ?? null,
			scannerStorage: config.scanner.storage,
			scanner: () => scanner,
			decoders: () => decoderManager.getConfiguredDecoderConfigs(),
			accessDirectory,
			logsDir: config.logging.dir,
		})
		const storageReport = createStorageReporter({
			stateDir: config.stateDir,
			areas: storageSources.areas,
			activityRetention: () =>
				activity.status === "disabled" || activityLimits === null
					? null
					: activityRetentionFromStats(activity.stats(), activityLimits),
			minFreeBytes: storageSources.minFreeBytes,
			// WG10 req 1.8: keep totals in protected mode; legacy reports `kept: null`.
			...(protectedMode ? { kept: () => keptSummaryOf(keeps) } : {}),
		})
		// Band plans never stop core: a storage failure leaves built-ins readable.
		// The API server closes it after HTTP drain; own() covers a failed construction.
		let publishBandPlans: BandPlansCommitSink | undefined
		const bandPlans = await openBandPlanService({
			stateDir: config.stateDir,
			context: {
				region: bandRegion.code,
				effectiveCountry: stationService.identity().effectiveCountry,
			},
			writable: protectedMode,
			// WG6 req 5: URL import and update checks; the service turns them off unless writable
			// (protected mode), so the legacy service advertises `urlImportHosts: []`.
			urlFetcher: createBandPlanUrlFetcher({
				userAgent: `WaveKit/${APP_VERSION}`,
				logger,
			}),
			urlImportHosts: BANDPLAN_URL_IMPORT_HOSTS,
			onCommit: event => {
				decoderManager.notifyBandplansChanged()
				publishBandPlans?.(event)
			},
			onStoreUnavailable: reason => {
				bandPlanLog.warn({ reason }, "Band-plan store unavailable")
			},
		})
		bandPlanService = bandPlans
		decoderManager.notifyBandplansChanged()
		updateVfo()
		closeBandPlans = () => bandPlans.close()
		own(11, closeBandPlans)
		checkpoint()

		// Step 9: Initialize API server
		const apiServer = new ApiServer(
			{
				bandPlans,
				...(access ? { access } : {}),
				activity,
				station: stationService.identity(),
				stationService,
				// WG8 req 2: mounted by the server only in protected mode (the access controller)
				decoderSettings,
				// WG6 req 7: the validated config with env overrides, as the runtime uses it.
				getConfig: () => config,
				regionalRegistry,
				receiverCapabilitiesProvider,
				sourceManager,
				fanoutManager,
				fanoutTelemetry: sourceRouting,
				decoderManager,
				decoderRegistry,
				audioOutput,
				tunerRelay,
				tunerController,
				liveDemod,
				digitalVoice,
				resourceAggregator,
				aircraftTracker: aircraftTrackingManager.getTracker(),
				vesselTracker: vesselTrackingManager.getTracker(),
				coverage: coverageManager,
				meshTracker: meshTrackingManager.getTracker(),
				aprsTracker: aprsTrackingManager.getTracker(),
				stationEstimate,
				storageReport,
				recordingInventory,
				recordingKeeps: keeps,
				scanner: scanner ?? undefined,
				spectrum: scanner?.spectrum,
				logger,
				audioConfig: {
					format: config.audio.format,
					sampleRate: config.audio.sampleRate,
				},
			},
			{
				host: config.api.host,
				port: config.api.port,
				...(accessBootstrap ? { accessBootstrap } : {}),
				...(config.access.mode === "protected"
					? { publicOrigins: config.access.publicOrigins }
					: {}),
			},
		)

		publishBandPlans = createBandPlansCommitSink(
			apiServer.getBandPlansBroadcastPort(),
		)
		runtimeApi = apiServer
		admissionGates.push(() => apiServer.stopAdmission())
		own(10, () => apiServer.stop())

		if (protectedMode) {
			let acquisition: "pending" | "acquired" | "rejected" = "pending"
			let operatorData: OperatorDataService | undefined
			let mounted = false
			let earlyClose: Promise<void> | undefined
			// Register BEFORE invoking open: a rejection hides the lock-cleanup outcome.
			own(5, () => {
				if (acquisition !== "acquired" || !operatorData)
					throw new WaveKitError(
						"Operator acquisition cleanup unknown",
						"ACCESS_UNAVAILABLE",
					)
				// After transfer, the server's retained stop outcome owns drain-before-close.
				if (mounted) return apiServer.stop()
				return (earlyClose ??= operatorData.close())
			})
			const sink = createOperatorDataCommitSink(
				apiServer.getOperatorDataBroadcastPort(),
			)
			try {
				operatorData = await OperatorDataService.open({
					stateDir: config.stateDir,
					onCommit: snapshot => {
						try {
							sink(snapshot)
						} catch {
							apiServer.invalidateOperatorDataPublication()
						}
						return undefined
					},
				})
				acquisition = "acquired"
			} catch {
				acquisition = "rejected"
				throw new WaveKitError(
					"Operator startup unavailable",
					"ACCESS_UNAVAILABLE",
				)
			}
			checkpoint()
			apiServer.mountOperatorData(operatorData)
			mounted = true
		}

		// Step 9: Register shutdown handlers (in reverse order of startup)
		shutdown.register({
			name: "decoder-enablement",
			handler: async () => {
				closeRatePolicy()
				closeVfo()
				monitor.stop()
				efficiencyCpu.stop()
			},
		})
		// Handlers are called in LIFO order, so register in reverse dependency order

		// Last to shutdown: Source connections
		shutdown.register({
			name: "source-manager",
			handler: async () => {
				await scannerPhases.completed().catch(() => undefined)
				await disposeReceiverAfterApi()
				log.info("Shutting down source connections")
				await sourceManager.disconnectAll()
			},
			timeout: 5000,
		})

		// Shutdown fanout manager (destroys all streams)
		shutdown.register({
			name: "fanout-manager",
			handler: async () => {
				await scannerPhases.completed().catch(() => undefined)
				log.info("Shutting down fanout manager")
				sourceRouting.destroy()
				fanoutManager.destroy()
			},
			timeout: 2000,
		})

		// Shutdown live demodulator
		shutdown.register({
			name: "live-demodulator",
			handler: async () => {
				await scannerPhases.completed().catch(() => undefined)
				log.info("Shutting down live demodulator")
				await liveDemod.stop()
			},
			timeout: 2000,
		})

		// Shutdown digital voice stream (releases its UDP sockets)
		shutdown.register({
			name: "digital-voice",
			handler: async () => {
				await scannerPhases.completed().catch(() => undefined)
				log.info("Shutting down digital voice stream")
				await digitalVoice.destroy()
			},
			timeout: 2000,
		})

		// Shutdown tuner relay
		shutdown.register({
			name: "tuner-relay",
			handler: async () => {
				await scannerPhases.completed().catch(() => undefined)
				log.info("Shutting down tuner relay")
				await tunerRelay.stop()
			},
			timeout: 2000,
		})

		// Actual dependencies remain ordered even if generic LIFO hooks time out.
		shutdown.register({
			name: "scanner-native-finalization",
			handler: scannerPhases.completed,
			timeout: 5000,
		})
		shutdown.register({
			name: "channelizer",
			handler: scannerPhases.coreSettled,
			timeout: 5000,
		})

		// Shutdown decoders
		shutdown.register({
			name: "decoder-manager",
			handler: scannerPhases.managerSettled,
			timeout: 5000,
		})

		// Shutdown audio output
		shutdown.register({
			name: "audio-output",
			handler: async () => {
				log.info("Shutting down audio output")
				await audioOutput.stop()
			},
			timeout: 2000,
		})

		shutdown.register({
			name: "receiver-capabilities",
			handler: disposeReceiverAfterApi,
			timeout: 5000,
		})

		// Shutdown the scanner after the API server and before the decoders,
		// channelizer, fanout and sources (LIFO): its tuner lease restore writes to
		// a still-open rtl_tcp socket (spec § 10.3).
		shutdown.register({
			name: "scanner",
			handler: scannerPhases.producerSettled,
			timeout: 5000,
		})

		// Runs right after the API server stops (LIFO), so no PATCH is in flight
		shutdown.register({
			name: "station",
			handler: async () => {
				await stationService.close()
			},
			timeout: 2000,
		})

		// Same position: no settings PATCH is in flight once the API server has stopped
		shutdown.register({
			name: "decoder-settings",
			handler: async () => {
				await decoderSettings.close()
			},
			timeout: 2000,
		})

		// First to shutdown: API server (stop accepting new connections)
		shutdown.register({
			name: "api-server",
			handler: async () => {
				log.info("Shutting down API server")
				await apiServer.stop()
			},
			timeout: 5000,
		})

		// Runs before the API server stops (LIFO): publisher, subscriptions,
		// query service, then the store. Step errors are logged, not thrown.
		shutdown.register({
			name: "activity",
			handler: async () => {
				log.info("Shutting down activity")
				await activity.close()
			},
			timeout: 5000,
		})

		// Shutdown resource monitoring
		if (resourceAggregator) {
			shutdown.register({
				name: "resource-aggregator",
				handler: async () => {
					log.info("Shutting down resource monitoring")
					resourceAggregator?.stop()
					sdrHostPoller?.stop()
					containerMonitor?.stop()
				},
				timeout: 1000,
			})
		}

		// Shutdown aircraft tracking and enrichment
		shutdown.register({
			name: "aircraft-tracking",
			handler: async () => {
				log.info("Shutting down aircraft tracking and enrichment")
				aircraftEnrichmentService.stop()
				aircraftTrackingManager.stop()
			},
			timeout: 1000,
		})

		shutdown.register({
			name: "vessel-tracking",
			handler: async () => {
				log.info("Shutting down vessel tracking")
				vesselTrackingManager.stop()
			},
			timeout: 1000,
		})

		shutdown.register({
			name: "coverage",
			handler: async () => {
				coverageManager.stop()
			},
			timeout: 1000,
		})

		shutdown.register({
			name: "aprs-tracking",
			handler: async () => {
				log.info("Shutting down APRS tracking")
				aprsTrackingManager.stop()
			},
			timeout: 1000,
		})

		shutdown.register({
			name: "mesh-tracking",
			handler: async () => {
				log.info("Shutting down mesh tracking")
				meshTrackingManager.stop()
			},
			timeout: 1000,
		})

		// Step 10: Start API server
		await apiServer.start()
		checkpoint()

		const wsBroadcaster = apiServer.getWebSocketBroadcaster()

		// Analog transmissions from the live demodulator's squelch (WG1 req 3, 4).
		// Started before liveDemod.start(), so a later POST start is covered too.
		// Shutdown is LIFO: registered after "activity", this runs first, so the
		// final closed event is broadcast and stored before Activity and the API
		// close. own(7) does the same on a failed startup (Activity is own(8)).
		const transmissions = wireAnalogTransmissions({
			source: liveDemod,
			frequencyAt: analogFrequencyAt(tunerController),
			broadcast: event => {
				wsBroadcaster.broadcastLiveAudioTransmission(event)
			},
			sink: () => activity.transmissionSink(),
			// WG10 activity hygiene: short or carrier-less squelch openings are not published.
			onSuppressed: (reason, event) => {
				log.debug(
					{
						reason,
						transmissionId: event.transmissionId,
						durationMs: event.durationMs,
						suppressed: transmissions.suppressed(),
					},
					"Analog transmission suppressed (activity hygiene)",
				)
			},
		})
		feedAnalogEvidence(transmissions, analogEvidence)
		feedLiveChannelTone(transmissions, liveDemod)
		own(7, () => transmissions.stop())
		shutdown.register({
			name: "analog-transmissions",
			handler: async () => {
				log.info("Shutting down analog transmissions")
				transmissions.stop()
			},
			timeout: 1000,
		})

		// Wire live demodulator events to WebSocket broadcaster
		liveDemod.on("level", level => {
			wsBroadcaster.broadcastLiveAudioLevel(level)
		})
		liveDemod.on("started", () => {
			wsBroadcaster.broadcast("live-audio", {
				type: "live-audio:started",
				data: {},
			})
			wsBroadcaster.broadcastLiveAudioStatus(liveDemod.getStatus())
		})
		liveDemod.on("stopped", () => {
			wsBroadcaster.broadcast("live-audio", {
				type: "live-audio:stopped",
				data: {},
			})
			wsBroadcaster.broadcastLiveAudioStatus(liveDemod.getStatus())
		})
		liveDemod.on("config-changed", liveConfig => {
			wsBroadcaster.broadcastLiveAudioConfig(liveConfig)
			wsBroadcaster.broadcastLiveAudioStatus(liveDemod.getStatus())
		})
		liveDemod.on("client-connected", () => {
			wsBroadcaster.broadcastLiveAudioStatus(liveDemod.getStatus())
		})
		liveDemod.on("client-disconnected", () => {
			wsBroadcaster.broadcastLiveAudioStatus(liveDemod.getStatus())
		})
		liveDemod.on("error", err => {
			wsBroadcaster.broadcast("live-audio", {
				type: "live-audio:error",
				data: { message: err.message },
			})
			wsBroadcaster.broadcastLiveAudioStatus(liveDemod.getStatus())
		})

		// Wire digital voice call state and status to WebSocket broadcaster
		const broadcastDigitalVoiceStatus = () =>
			wsBroadcaster.broadcastDigitalVoiceStatus(digitalVoice.getStatus())
		digitalVoice.on("call", call => {
			wsBroadcaster.broadcastDigitalVoiceCall(call)
			broadcastDigitalVoiceStatus()
		})
		digitalVoice.on("started", broadcastDigitalVoiceStatus)
		digitalVoice.on("stopped", broadcastDigitalVoiceStatus)
		digitalVoice.on("clients-changed", broadcastDigitalVoiceStatus)
		digitalVoice.on("error", err => {
			log.warn(
				protectedMode ? { code: "RUNTIME_ERROR" } : { err },
				"Digital voice stream error",
			)
			broadcastDigitalVoiceStatus()
		})

		// Step 11: Start audio output server
		if (!protectedMode) await audioOutput.start()

		// Step 11b: Start tuner relay server (if enabled)
		await tunerRelay.start()
		checkpoint()

		// Broadcast source caps changes to WebSocket clients
		sourceManager.on("caps-changed", (sourceId, caps) => {
			wsBroadcaster.broadcast("sources", {
				type: "source:caps-changed",
				data: { sourceId, caps },
			})
		})

		// Step 12: Wire decoder audio outputs to AudioOutput (Requirement 11.1)
		// This creates a combined stream that aggregates audio from all decoders
		const cleanupAudioWiring = protectedMode
			? () => {}
			: wireDecoderAudioToOutput(
					decoderManager,
					fanoutManager,
					audioOutput,
					config, // Pass config for monitoring check
					log,
				)

		own(30, cleanupAudioWiring)

		// Register cleanup for audio wiring
		shutdown.register({
			name: "audio-wiring",
			handler: async () => {
				log.info("Cleaning up audio wiring")
				cleanupAudioWiring()
			},
			timeout: 1000,
		})

		// Start resource monitoring components
		if (resourceAggregator) {
			containerMonitor?.start()
			sdrHostPoller?.start()
			resourceAggregator.start()
			log.info("Resource monitoring started")
		}

		// Start aircraft tracking manager and enrichment service
		aircraftTrackingManager.start()
		aircraftEnrichmentService.start()
		vesselTrackingManager.start()
		coverageManager.start()
		meshTrackingManager.start()
		aprsTrackingManager.start()

		// Step 13: Connect to configured sources and wire to fanout
		for (const sourceConfig of config.sources) {
			checkpoint()
			try {
				await sourceManager.connect(sourceConfig)
				checkpoint()
				log.info(
					{
						sourceId: sourceConfig.id,
						host: sourceConfig.host,
						port: sourceConfig.port,
					},
					"Connected to source",
				)
			} catch (err) {
				if (stopping) throw err
				log.error(
					{
						...(protectedMode ? { code: "RUNTIME_ERROR" } : { err }),
						sourceId: sourceConfig.id,
					},
					"Failed to connect to source (will retry)",
				)
			}
		}

		// Step 14b: Start live demodulator (if enabled)
		checkpoint()
		if (liveDemodConfig.enabled) {
			try {
				await liveDemod.start()
				checkpoint()
			} catch (err) {
				if (stopping) throw err
				log.error(
					protectedMode ? { code: "RUNTIME_ERROR" } : { err },
					"Failed to start live demodulator",
				)
			}
		}

		// Step 14c: Start the digital voice stream (if any dsd-fme decoder feeds it)
		checkpoint()
		if (digitalVoice.getStatus().decoders.length > 0) {
			try {
				await digitalVoice.start()
				checkpoint()
			} catch (err) {
				if (stopping) throw err
				log.error(
					protectedMode ? { code: "RUNTIME_ERROR" } : { err },
					"Failed to start digital voice stream",
				)
			}
		} else if (digitalVoiceConfig.enabled) {
			log.info("Digital voice enabled but no dsd-fme decoder streams voice")
		}

		// Step 15: Start enabled decoders
		// Log decoded messages for user visibility (Requirement: User Feedback)
		decoderManager.on("decoder:output", (decoderId, output) => {
			log.info({ decoderId, output }, "Decoded Message")
		})

		checkpoint()
		await decoderManager.startAll()
		checkpoint()

		// Log startup complete
		const uptimeMs = Date.now() - startTime
		log.info(
			{
				uptimeMs,
				apiHost: config.api.host,
				apiPort: config.api.port,
				audioPort: config.audio.tcpPort,
				sources: config.sources.length,
				decoders: config.decoders.length,
			},
			"WaveKit started successfully",
		)
	} catch (error) {
		settled()
		if (protectedMode) {
			const watchdog = setTimeout(() => process.exit(1), 10_000)
			try {
				await closeProtected()
			} finally {
				clearTimeout(watchdog)
			}
		} else if (closeLegacy) {
			const watchdog = setTimeout(() => process.exit(1), 10_000)
			try {
				await closeLegacy()
			} finally {
				clearTimeout(watchdog)
			}
		}
		throw error
	} finally {
		settled()
	}
}

// Run the application
if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	void main().catch(() => {
		process.stderr.write("WaveKit startup failed\n")
		process.exit(1)
	})
