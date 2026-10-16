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
import type { NamedAccessRuntimeContext } from "./access/runtime-context.js"
import type { ProtectedAccessBootstrap } from "./access/bootstrap-policy.js"
import { validateProtectedRuntimeMapping } from "./access/runtime-config.js"
import { WaveKitError } from "./utils/errors.js"
import { PassThrough } from "node:stream"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
	loadConfig,
	DigitalVoiceConfigSchema,
	LiveDemodConfigSchema,
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
import { createRegionalRegistry } from "./core/regional/registry.js"
import { createRegionalRegistration } from "./core/regional/data.js"
import { createReceiverCapabilitiesProvider } from "./core/tuner-capabilities/provider.js"
import { wireTunerControl } from "./core/tuner-wiring.js"
import { LiveDemodulator } from "./core/live-demodulator.js"
import { liveDemodOperatorActivity } from "./core/live-demod-activity.js"
import { DigitalVoiceService } from "./core/digital-voice.js"
import { ChannelizerManager } from "./core/channelizer/channelizer-manager.js"
import { SettlementRegistry } from "./core/channelizer/settlement-observer.js"
import type {
	ChannelSettlementObserver,
	CleanupOutcome,
	ProviderLifetime,
} from "./core/channelizer/settlement-observer.js"
import { ScannerLifecycleOwner } from "./core/scanner/channel/consumer-lifecycle.js"
import { ScannerService } from "./core/scanner/scanner-service.js"
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
import { SourceBackpressureTracker } from "./core/source-backpressure-tracker.js"
import { ResourceAggregator } from "./core/resource-aggregator.js"
import { AircraftTrackingManager } from "./core/aircraft-tracking-manager.js"
import { VesselTrackingManager } from "./core/vessel-tracking-manager.js"
import { MeshTrackingManager } from "./core/mesh-tracking-manager.js"
import { AprsTrackingManager } from "./core/aprs-tracking-manager.js"
import { createStationEstimator } from "./core/station-estimate/provider.js"
import { openStationService } from "./core/station/station-service.js"
import { resolveSpectrumBinsCap } from "./core/spectrum/bin-cap.js"
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
	liveStorageReportSources,
	storageActivityLimits,
} from "./core/storage-report/areas-from-config.js"
import {
	tunerFrequencyAt,
	wireAnalogTransmissions,
} from "./core/analog-transmission.js"
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
		const fanoutManager = new FanoutManager(logger)
		const sourceRouting = new SourceFanoutRouter(
			sourceManager,
			fanoutManager,
			logger,
			defaultSourceIdFor(config.sources),
			{
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
		const liveDemodConfig = LiveDemodConfigSchema.parse(config.liveDemod ?? {})
		const liveDemod = new LiveDemodulator(
			logger,
			sourceManager,
			sourceRouting,
			liveDemodConfig,
			access && config.access.mode === "protected"
				? {
						httpAccess: access.analogAudio,
						publicOrigin: config.access.publicOrigins.analogAudio,
						httpHost: config.access.audio.analog.bindHost,
					}
				: {},
		)
		admissionGates.push(() => liveDemod.shutdownAdmission())
		own(50, () => liveDemod.stop())
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
		const decoderSettings = await openDecoderSettingsService({
			configs: config.decoders,
			stateDir: config.stateDir,
			logger,
		})
		own(12, () => decoderSettings.close())
		checkpoint()
		const decoderRegistry = new DecoderRegistry()
		const decoderManager = new DecoderManager(
			decoderRegistry,
			fanoutManager,
			logger,
			createDecoderManagerOptions(config.health, bandRegion),
			bandOverrides,
		)

		runtimeDecoders = decoderManager
		// WG8 req 2.4: PATCH stages effective option values on the manager (next start)
		decoderSettings.setManager(decoderSettingsPort(decoderManager))

		// Wire DecoderManager to SourceManager for dynamic sample rate handling
		decoderManager.setSourceManager(sourceManager, sourceRouting)

		// Opt-in core channelizer (addendum §4): one wavekit-chan per source, spawned
		// on the first channel request. Off by default, so no manager exists.
		if (config.channelizer.enabled) {
			const registry = new SettlementRegistry()
			providerLifetime = registry.registerProviderLifetime()
			if (!providerLifetime)
				throw new WaveKitError(
					"Scanner lifetime unavailable",
					"ACCESS_UNAVAILABLE",
				)
			const constructionCleanup = providerLifetime.ownCleanup(
				"construction",
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
			)
			if (!constructionCleanup)
				throw new WaveKitError(
					"Scanner owner unavailable",
					"ACCESS_UNAVAILABLE",
				)
			settlementObserver = registry.createObserver(providerLifetime)
		}
		const channelizer = config.channelizer.enabled
			? new ChannelizerManager({
					sourceManager,
					routing: sourceRouting,
					config: config.channelizer,
					logger,
					...(settlementObserver ? { settlementObserver } : {}),
				})
			: null
		runtimeChannelizer = channelizer
		const channels =
			channelizer && settlementObserver
				? settlementObserver.bindProvider(channelizer)
				: channelizer
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

		// Step 7: Create decoders from configuration. dsd-fme decoders are first
		// pointed at the digital voice stream (-o udp to a local socket).
		// Overrides apply BEFORE the digital-voice preparation, which rewrites dsd-fme output.
		const effectiveDecoders = effectiveDecoderConfigs(
			decoderSettings,
			config.decoders,
		)
		let decoderConfigs: DecoderConfig[] = effectiveDecoders
		try {
			decoderConfigs =
				await digitalVoice.prepareDecoderConfigs(effectiveDecoders)
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
		let bandPlanService: BandPlanService | undefined
		let bandPlanViewWarned = false
		let bandPlanSkipsWarned = false
		// WG7 req 1.3: the decoder provenance index is built after the scanner starts; until then
		// ambient AIS/ACARS/VDL2/LoRa decodes have no trust and are no evidence (fail closed).
		let ambientProvenance: ActivityProvenanceLookup | null = null
		const scannerBandplans = createScannerBandplanProvider(
			() => bandPlanService?.view(),
			bandRegion.code,
			err => {
				if (bandPlanViewWarned) return
				bandPlanViewWarned = true
				bandPlanLog.warn(
					{ err },
					"Band-plan view unavailable; scanner uses built-in plans",
				)
			},
		)
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
		try {
			scannerConstructionStarted = true
			scanner = new ScannerService({
				settings: scannerSettings,
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
				cpuMeter: new CpuMeter({ sampleMs: 5000 }),
			})
			scannerConstructionSettled = true
			scannerConstruction.completeConstruction({ ok: true })
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

		// Step 8: Initialize resource monitoring (if enabled)
		let resourceAggregator: ResourceAggregator | undefined
		let containerMonitor: ContainerMonitor | undefined
		let sdrHostPoller: SdrHostPoller | undefined
		let backpressureTracker: SourceBackpressureTracker | undefined

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

		own(20, () => {
			resourceAggregator?.stop()
			sdrHostPoller?.stop()
			containerMonitor?.stop()
		})
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
			onCommit: event => publishBandPlans?.(event),
			onStoreUnavailable: reason => {
				bandPlanLog.warn({ reason }, "Band-plan store unavailable")
			},
		})
		bandPlanService = bandPlans
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
			frequencyAt: tunerFrequencyAt(id => tunerController.getState(id)),
			broadcast: event => {
				wsBroadcaster.broadcastLiveAudioTransmission(event)
			},
			sink: () => activity.transmissionSink(),
		})
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
