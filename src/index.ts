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
import { loadConfig } from "./config.js"
import { createLogger, createComponentLogger } from "./utils/logger.js"
import { GracefulShutdown } from "./utils/graceful-shutdown.js"
import { SourceManager } from "./core/source-manager.js"
import { FanoutManager } from "./core/fanout-manager.js"
import { AudioOutput } from "./core/audio-output.js"
import { DecoderRegistry } from "./decoders/registry.js"
import { DecoderManager } from "./decoders/manager.js"
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
import type { Logger } from "./utils/logger.js"
import type { Decoder } from "./decoders/types.js"

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
	audioOutput: AudioOutput,
	log: Logger,
): () => void {
	// Create a combined audio stream that aggregates audio from all decoders
	const combinedAudioStream = new PassThrough({
		highWaterMark: 256 * 1024, // 256KB buffer
	})

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
 * Wires source reconnection events to re-attach to fanout.
 * Ensures the fanout manager stays connected when sources reconnect.
 *
 * Requirements:
 * - 1.4: Handle source disconnection and reconnection
 * - 2.1: Maintain fanout connection to source
 *
 * @param sourceManager - The source manager
 * @param fanoutManager - The fanout manager
 * @param primarySourceId - The ID of the primary source to attach to fanout
 * @param log - Logger instance
 */
function wireSourceReconnection(
	sourceManager: SourceManager,
	fanoutManager: FanoutManager,
	primarySourceId: string,
	log: Logger,
): void {
	// When the primary source reconnects, re-attach to fanout
	sourceManager.on("connected", (sourceId: string) => {
		if (sourceId === primarySourceId) {
			const stream = sourceManager.getStream(sourceId)
			if (stream) {
				fanoutManager.attachSource(stream)
				log.info({ sourceId }, "Source reconnected and re-attached to fanout")
			}
		}
	})

	// When the primary source disconnects, detach from fanout to prevent errors
	sourceManager.on("disconnected", (sourceId: string) => {
		if (sourceId === primarySourceId) {
			fanoutManager.detachSource()
			log.info({ sourceId }, "Source disconnected, detached from fanout")
		}
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
				...config,
				sources: config.sources.length,
				decoders: config.decoders.length,
			},
		},
		"Starting WaveKit",
	)

	// Step 3: Create graceful shutdown handler (Requirement 14.1)
	const shutdown = new GracefulShutdown({
		logger,
		shutdownTimeout: 10000, // 10 seconds max shutdown time
	})

	// Install signal handlers for SIGTERM/SIGINT
	shutdown.installSignalHandlers()

	// Step 4: Initialize core components
	const sourceManager = new SourceManager(logger)
	const fanoutManager = new FanoutManager(logger)
	const audioOutput = new AudioOutput(logger, {
		port: config.audio.tcpPort,
		format: config.audio.format,
		sampleRate: config.audio.sampleRate,
	})

	// Step 5: Initialize decoder system
	const decoderRegistry = new DecoderRegistry()
	const decoderManager = new DecoderManager(
		decoderRegistry,
		fanoutManager,
		logger,
		{
			restartDelay: 2000,
			maxRestartDelay: 30000,
			maxRestarts: 0, // Unlimited restarts
		},
	)

	// Step 6: Register built-in decoders with capabilities
	decoderRegistry.register("dsd-fme", createDsdFmeDecoder, DSD_FME_CAPS)
	decoderRegistry.register("multimon-ng", createMultimonDecoder, MULTIMON_CAPS)
	decoderRegistry.register("rtl433", createRtl433Decoder, RTL433_CAPS)

	log.info(
		{ registeredDecoders: decoderRegistry.getRegisteredTypes() },
		"Built-in decoders registered",
	)

	// Step 7: Create decoders from configuration
	for (const decoderConfig of config.decoders) {
		try {
			decoderManager.createDecoder(decoderConfig)
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

	// Step 8: Initialize API server
	const apiServer = new ApiServer(
		{
			sourceManager,
			decoderManager,
			audioOutput,
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
			fanoutManager.destroy()
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

	// Step 10: Start API server
	await apiServer.start()

	// Step 11: Start audio output server
	await audioOutput.start()

	// Step 12: Wire decoder audio outputs to AudioOutput (Requirement 11.1)
	// This creates a combined stream that aggregates audio from all decoders
	const cleanupAudioWiring = wireDecoderAudioToOutput(
		decoderManager,
		audioOutput,
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

	// Step 13: Connect to configured sources and wire to fanout
	let primarySourceId: string | null = null
	for (const sourceConfig of config.sources) {
		try {
			const stream = await sourceManager.connect(sourceConfig)
			// Attach first source to fanout (for now, single source support)
			// Multi-source support will be added in Phase 2
			if (config.sources.indexOf(sourceConfig) === 0) {
				fanoutManager.attachSource(stream)
				primarySourceId = sourceConfig.id
				log.info({ sourceId: sourceConfig.id }, "Source attached to fanout")
			}
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
			// Even if initial connection fails, set up for reconnection
			if (config.sources.indexOf(sourceConfig) === 0) {
				primarySourceId = sourceConfig.id
			}
		}
	}

	// Step 14: Wire source reconnection handling
	// This ensures fanout stays connected when sources reconnect
	if (primarySourceId) {
		wireSourceReconnection(sourceManager, fanoutManager, primarySourceId, log)
	}

	// Step 15: Start enabled decoders
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
