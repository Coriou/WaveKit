#!/usr/bin/env node
/**
 * wavekit-sdr-host entry point
 *
 * RTL-SDR dongle host with rtlmux fanout and unified status API.
 */
import { createLogger } from "@wavekit/shared"
import { restartUsbReceiver } from "./supervisor/usb-recovery.js"
import { loadConfig } from "./config.js"
import { ProcessManager } from "./supervisor/process-manager.js"
import {
	runPreflight,
	startPreflightMonitoring,
} from "./supervisor/preflight.js"
import { createApiServer, startApiServer } from "./api/server.js"
import { HostCollector } from "./telemetry/host.js"
import { loadUnitIdAtStartup } from "./telemetry/unit-id.js"

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
	const stopPreflightMonitoring = startPreflightMonitoring(
		preflightResult,
		logger,
		{ onDeviceChange: () => restartUsbReceiver(logger) },
	)

	// Create process manager
	const processManager = new ProcessManager(config, logger)
	processManager.startMonitoring()

	// Host telemetry is sampled in the background so page viewers cost no I/O.
	const hostCollector = new HostCollector({
		statusDir: config.api.hostStatusDir,
	})
	hostCollector.start()

	// The stable unit id (kept in the state directory); none when it would not be stable.
	const unit = await loadUnitIdAtStartup(config.state.dir)
	const { result } = unit
	if (result.reason === "state-not-persistent")
		logger.warn(
			{ stateDir: config.state.dir, persistence: unit.persistence },
			unit.persistence === "tmpfs"
				? "State directory is a tmpfs (lost at every restart): no stable unit id is reported. Mount a disk-backed volume there (docker-compose.yml mounts /var/lib/wavekit/sdr-host at /state)"
				: "State directory is not a mounted volume: no stable unit id is reported. Mount a volume there (docker-compose.yml mounts /var/lib/wavekit/sdr-host at /state)",
		)
	else if (result.reason !== null)
		logger.warn(
			{ stateDir: config.state.dir, reason: result.reason },
			"State directory not readable or writable: no stable unit id is reported",
		)
	else {
		if (unit.persistence === "unknown")
			logger.warn(
				{ stateDir: config.state.dir },
				"Could not tell whether the state directory is a mounted volume; the unit id may change when the container is recreated",
			)
		if (result.dirSyncError !== undefined)
			logger.warn(
				{ stateDir: config.state.dir, code: result.dirSyncError },
				"State directory cannot be fsynced; the unit id was written but its rename may not survive a power loss",
			)
		logger.info({ source: result.source }, "Unit id ready")
	}

	// Create API server
	const fastify = await createApiServer({
		config,
		logger,
		processManager,
		preflightResult,
		hostTelemetry: hostCollector,
		unitId: result.unitId,
		unitIdReason: result.reason,
	})

	// Handle shutdown
	const shutdown = async (): Promise<void> => {
		logger.info("Shutting down")
		await fastify.close()
		await stopPreflightMonitoring()
		hostCollector.stop()
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
