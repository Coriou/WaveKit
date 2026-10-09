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

import { PassThrough } from "node:stream"
import {
	loadConfig,
	DigitalVoiceConfigSchema,
	LiveDemodConfigSchema,
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
import { SourceFanoutRouter } from "./core/source-fanout-router.js"
import { AudioOutput } from "./core/audio-output.js"
import { TunerRelay } from "./core/tuner-relay.js"
import { TunerController } from "./core/tuner-controller.js"
import { wireTunerControl } from "./core/tuner-wiring.js"
import { LiveDemodulator } from "./core/live-demodulator.js"
import { DigitalVoiceService } from "./core/digital-voice.js"
import { DecoderRegistry } from "./decoders/registry.js"
import { DecoderManager } from "./decoders/manager.js"
import { createDecoderManagerOptions } from "./decoders/manager-options.js"
import { resolveProcessBandRegion } from "./decoders/band-region.js"
import { BandOverrideStore } from "./decoders/band-override-store.js"
import { ApiServer } from "./api/server.js"
import {
	createDsdFmeDecoder,
	DSD_FME_CAPS,
} from "./decoders/builtin/dsd-fme.js"
import {
	createMultimonDecoder,
	MULTIMON_CAPS,
} from "./decoders/builtin/multimon-ng.js"
import { createRtl433Decoder, RTL433_CAPS } from "./decoders/builtin/rtl433.js"
import { createReadsbDecoder, READSB_CAPS } from "./decoders/builtin/readsb.js"
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
function wireDecoderAudioToOutput(
	decoderManager: DecoderManager,
	fanoutManager: FanoutManager,
	audioOutput: AudioOutput,
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
				...config,
				sources: config.sources.length,
				decoders: config.decoders.length,
			},
		},
		"Starting WaveKit",
	)

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

	// Install signal handlers for SIGTERM/SIGINT
	shutdown.installSignalHandlers()

	// Step 4: Initialize core components
	const sourceManager = new SourceManager(logger, {
		signalFlatThresholdDbfs: config.health?.signalFlatThresholdDbfs,
		signalFlatHoldMs: config.health?.signalFlatHoldMs,
	})
	const fanoutManager = new FanoutManager(logger)
	const sourceRouting = new SourceFanoutRouter(
		sourceManager,
		fanoutManager,
		logger,
		config.sources[0]?.id,
	)
	const audioOutput = new AudioOutput(logger, {
		port: config.audio.tcpPort,
		format: config.audio.format,
		sampleRate: config.audio.sampleRate,
	})
	const tunerRelay = new TunerRelay(logger, sourceManager, fanoutManager, {
		enabled: config.tunerRelay.enabled,
		host: config.tunerRelay.host,
		port: config.tunerRelay.port,
		sourceId: config.tunerRelay.sourceId ?? config.sources[0]?.id,
		controlPolicy: config.tunerRelay.controlPolicy,
		maxClients: config.tunerRelay.maxClients,
	})
	const tunerController = new TunerController(logger, sourceManager, {
		reconnectPolicy: config.tuner.reconnectPolicy,
	})
	const liveDemodConfig = LiveDemodConfigSchema.parse(config.liveDemod ?? {})
	const liveDemod = new LiveDemodulator(
		logger,
		sourceManager,
		fanoutManager,
		liveDemodConfig,
	)
	const digitalVoiceConfig = DigitalVoiceConfigSchema.parse(
		config.digitalVoice ?? {},
	)
	const digitalVoice = new DigitalVoiceService(logger, digitalVoiceConfig)

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
		relayEnabled: config.tunerRelay.enabled,
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
	const decoderRegistry = new DecoderRegistry()
	const decoderManager = new DecoderManager(
		decoderRegistry,
		fanoutManager,
		logger,
		createDecoderManagerOptions(config.health, bandRegion),
		bandOverrides,
	)

	// Wire DecoderManager to SourceManager for dynamic sample rate handling
	decoderManager.setSourceManager(sourceManager, sourceRouting)

	// Step 6: Register built-in decoders with capabilities
	decoderRegistry.register("dsd-fme", createDsdFmeDecoder, DSD_FME_CAPS)
	decoderRegistry.register("multimon-ng", createMultimonDecoder, MULTIMON_CAPS)
	decoderRegistry.register("rtl433", createRtl433Decoder, RTL433_CAPS)
	decoderRegistry.register("readsb", createReadsbDecoder, READSB_CAPS)
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
	let decoderConfigs: DecoderConfig[] = config.decoders
	try {
		decoderConfigs = await digitalVoice.prepareDecoderConfigs(config.decoders)
	} catch (err) {
		log.error({ err }, "Digital voice setup failed; decoders keep their output")
	}
	for (const decoderConfig of decoderConfigs) {
		try {
			const decoder = decoderManager.createDecoder(decoderConfig)
			digitalVoice.attachDecoder(decoderConfig.id, decoder)
			log.info(
				{ decoderId: decoderConfig.id, type: decoderConfig.type },
				"Decoder created",
			)
		} catch (err) {
			log.error(
				{ err, decoderId: decoderConfig.id, type: decoderConfig.type },
				"Failed to create decoder",
			)
		}
	}

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
	aircraftEnrichmentService.wireToTracker(aircraftTrackingManager.getTracker())
	// Wire enrichment cache stats to tracker for accurate stats reporting
	aircraftTrackingManager
		.getTracker()
		.setEnrichmentCacheProvider(aircraftEnrichmentService)

	// Step 9: Initialize API server
	const apiServer = new ApiServer(
		{
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
			logger,
			audioConfig: {
				format: config.audio.format,
				sampleRate: config.audio.sampleRate,
			},
		},
		{
			host: config.api.host,
			port: config.api.port,
		},
	)

	// Step 9: Register shutdown handlers (in reverse order of startup)
	// Handlers are called in LIFO order, so register in reverse dependency order

	// Last to shutdown: Source connections
	shutdown.register({
		name: "source-manager",
		handler: async () => {
			log.info("Shutting down source connections")
			await sourceManager.disconnectAll()
		},
		timeout: 5000,
	})

	// Shutdown fanout manager (destroys all streams)
	shutdown.register({
		name: "fanout-manager",
		handler: async () => {
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
			log.info("Shutting down live demodulator")
			await liveDemod.stop()
		},
		timeout: 2000,
	})

	// Shutdown digital voice stream (releases its UDP sockets)
	shutdown.register({
		name: "digital-voice",
		handler: async () => {
			log.info("Shutting down digital voice stream")
			await digitalVoice.destroy()
		},
		timeout: 2000,
	})

	// Shutdown tuner relay
	shutdown.register({
		name: "tuner-relay",
		handler: async () => {
			log.info("Shutting down tuner relay")
			await tunerRelay.stop()
		},
		timeout: 2000,
	})

	// Shutdown decoders
	shutdown.register({
		name: "decoder-manager",
		handler: async () => {
			log.info("Shutting down decoders")
			await decoderManager.destroy()
		},
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

	// First to shutdown: API server (stop accepting new connections)
	shutdown.register({
		name: "api-server",
		handler: async () => {
			log.info("Shutting down API server")
			await apiServer.stop()
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

	// Step 10: Start API server
	await apiServer.start()

	const wsBroadcaster = apiServer.getWebSocketBroadcaster()

	// Wire live demodulator events to WebSocket broadcaster
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
		log.warn({ err }, "Digital voice stream error")
		broadcastDigitalVoiceStatus()
	})

	// Step 11: Start audio output server
	await audioOutput.start()

	// Step 11b: Start tuner relay server (if enabled)
	await tunerRelay.start()

	// Broadcast source caps changes to WebSocket clients
	sourceManager.on("caps-changed", (sourceId, caps) => {
		wsBroadcaster.broadcast("sources", {
			type: "source:caps-changed",
			data: { sourceId, caps },
		})
	})

	// Step 12: Wire decoder audio outputs to AudioOutput (Requirement 11.1)
	// This creates a combined stream that aggregates audio from all decoders
	const cleanupAudioWiring = wireDecoderAudioToOutput(
		decoderManager,
		fanoutManager,
		audioOutput,
		config, // Pass config for monitoring check
		log,
	)

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

	// Step 13: Connect to configured sources and wire to fanout
	for (const sourceConfig of config.sources) {
		try {
			await sourceManager.connect(sourceConfig)
			log.info(
				{
					sourceId: sourceConfig.id,
					host: sourceConfig.host,
					port: sourceConfig.port,
				},
				"Connected to source",
			)
		} catch (err) {
			log.error(
				{ err, sourceId: sourceConfig.id },
				"Failed to connect to source (will retry)",
			)
		}
	}

	// Step 14b: Start live demodulator (if enabled)
	if (liveDemodConfig.enabled) {
		try {
			await liveDemod.start()
		} catch (err) {
			log.error({ err }, "Failed to start live demodulator")
		}
	}

	// Step 14c: Start the digital voice stream (if any dsd-fme decoder feeds it)
	if (digitalVoice.getStatus().decoders.length > 0) {
		try {
			await digitalVoice.start()
		} catch (err) {
			log.error({ err }, "Failed to start digital voice stream")
		}
	} else if (digitalVoiceConfig.enabled) {
		log.info("Digital voice enabled but no dsd-fme decoder streams voice")
	}

	// Step 15: Start enabled decoders
	// Log decoded messages for user visibility (Requirement: User Feedback)
	decoderManager.on("decoder:output", (decoderId, output) => {
		log.info({ decoderId, output }, "Decoded Message")
	})

	await decoderManager.startAll()

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
}

// Run the application
main().catch(err => {
	console.error("Fatal error during startup:", err)
	process.exit(1)
})
