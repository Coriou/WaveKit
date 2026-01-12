#!/usr/bin/env node
/**
 * wavekit-sdr-host entry point
 *
 * RTL-SDR dongle host with rtlmux fanout and unified status API.
 */
import { createLogger } from "@wavekit/shared"
import { loadConfig } from "./config.js"
import { ProcessManager } from "./supervisor/process-manager.js"
import { runPreflight } from "./supervisor/preflight.js"
import { createApiServer, startApiServer } from "./api/server.js"

async function main(): Promise<void> {
	// Load configuration
	const config = loadConfig()

	// Create logger
	const logger = createLogger({
		level: config.logging.level,
		pretty: config.logging.pretty,
	})

	logger.info("Starting wavekit-sdr-host")

	// Run preflight checks
	const preflightResult = await runPreflight(logger)

	// Create process manager
	const processManager = new ProcessManager(config, logger)
	processManager.startMonitoring()

	// Create API server
	const fastify = await createApiServer({
		config,
		logger,
		processManager,
		preflightResult,
	})

	// Handle shutdown
	const shutdown = async (): Promise<void> => {
		logger.info("Shutting down")
		await fastify.close()
		await processManager.shutdown()
		process.exit(0)
	}

	process.on("SIGTERM", () => void shutdown())
	process.on("SIGINT", () => void shutdown())

	// Log preflight results (s6 manages service lifecycles)
	if (!preflightResult.ready) {
		logger.warn(
			{ errors: preflightResult.errors },
			"Preflight failed, starting in degraded mode",
		)
	}

	// Start API server (always, even in degraded mode)
	await startApiServer(fastify, config, logger)
}

main().catch(error => {
	console.error("Fatal error:", error)
	process.exit(1)
})
