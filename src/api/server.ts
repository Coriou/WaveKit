/**
 * API Server - Fastify-based REST and WebSocket server
 *
 * Requirements:
 * - 9.1: GET /health returns system health status
 *
 * This module sets up the Fastify server with:
 * - CORS support for cross-origin requests
 * - WebSocket support for real-time events
 * - Swagger/OpenAPI documentation
 * - Centralized error handling
 */

import type { StationIdentity } from "@wavekit/api-types"
import { stationRoutes } from "./routes/station.js"
import type { FanoutTelemetryProvider } from "../core/source-fanout-router.js"
import Fastify, { type FastifyInstance, type FastifyError } from "fastify"
import fastifyCors from "@fastify/cors"
import fastifyWebsocket from "@fastify/websocket"
import fastifySwagger from "@fastify/swagger"
import fastifySwaggerUi from "@fastify/swagger-ui"
import {
	createComponentLogger,
	generateCorrelationId,
	createScopedLogger,
	type Logger,
} from "../utils/logger.js"
import type { SourceManager } from "../core/source-manager.js"
import type { FanoutManager } from "../core/fanout-manager.js"
import type { DecoderManager } from "../decoders/manager.js"
import type { DecoderRegistry } from "../decoders/registry.js"
import type { AudioOutput } from "../core/audio-output.js"
import type { TunerRelay } from "../core/tuner-relay.js"
import type { TunerController } from "../core/tuner-controller.js"
import type { LiveDemodulator } from "../core/live-demodulator.js"
import type { DigitalVoiceService } from "../core/digital-voice.js"
import { WaveKitError } from "../utils/errors.js"
import { ActivityQueryError } from "../core/activity/query/errors.js"
import {
	inertActivityService,
	type ActivityRuntime,
	type ActivityUnavailableState,
} from "../core/activity/runtime.js"
import { activityRoutes } from "./routes/activity.js"
import { createActivitySubscriptions } from "./activity-subscriptions.js"
import type { ActivitySubscriptionHub } from "./activity-subscriptions.js"
import { healthRoutes } from "./routes/health.js"
import { accessBootstrapRoutes } from "./routes/access-bootstrap.js"
import { sourceRoutes } from "./routes/sources.js"
import { decoderRoutes } from "./routes/decoders.js"
import { decoderBandRoutes } from "./routes/decoder-band.js"
import { telemetryRoutes } from "./routes/telemetry.js"
import { tunerRelayRoutes } from "./routes/tuner-relay.js"
import { tunerRoutes } from "./routes/tuner.js"
import { liveAudioRoutes } from "./routes/live-audio.js"
import { digitalVoiceRoutes } from "./routes/digital-voice.js"
import { resourceRoutes } from "./routes/resources.js"
import { aircraftRoutes } from "./routes/aircraft.js"
import { vesselRoutes } from "./routes/vessels.js"
import { meshRoutes } from "./routes/mesh.js"
import { aprsRoutes } from "./routes/aprs.js"
import { scannerRoutes } from "./routes/scanner.js"
import type { ScannerService } from "../core/scanner/scanner-service.js"
import { spectrumRoutes } from "./routes/spectrum.js"
import type { SpectrumService } from "../core/spectrum/spectrum-service.js"
import {
	WebSocketEventBroadcaster,
	type ServerMessage,
} from "./websocket/events.js"
import { wireScannerBroadcasts } from "./websocket/scanner-broadcast.js"
import { wireSpectrumBroadcasts } from "./websocket/spectrum-broadcast.js"
import type { WsLimiter } from "../core/scanner/ws-limiter.js"
import { SourceStatusPublisher } from "./websocket/source-status-publisher.js"
import { toApiDecoderInfo } from "./serializers/decoder-status.js"
import type { ResourceAggregator } from "../core/resource-aggregator.js"
import type { AircraftTracker } from "../core/aircraft-tracker.js"
import type { VesselTracker } from "../core/vessel-tracker.js"
import type {
	AprsStation,
	AprsTrackerStats,
	MeshNode,
	MeshTrackerStats,
	VesselState,
	VesselTrackerStats,
} from "@wavekit/api-types"
import type { MeshTracker } from "../core/mesh-tracker.js"
import type { AprsTracker } from "../core/aprs-tracker.js"
import { EntityUpdateThrottle } from "../core/entity-update-throttle.js"
import { installAccessHooks } from "../access/fastify-adapter.js"
import type { FastifyAccessController } from "../access/fastify-adapter.js"
import { registerAccessRoutes } from "../access/access-routes.js"
import type { AccessRouteController } from "../access/access-routes.js"
import { accessCapabilities } from "../access/bootstrap-policy.js"
import type { ProtectedAccessBootstrap } from "../access/bootstrap-policy.js"
import type { ProtectedRuntimeAccessConfig } from "../access/runtime-config.js"
import type { NamedAccessRuntimeContext } from "../access/runtime-context.js"
import type { OperatorDataService } from "../operator-data/service.js"
import { operatorDataRoutes } from "../operator-data/routes.js"
import { sendOperatorDataSnapshot } from "../operator-data/broadcast-adapter.js"
import type { OperatorDataBroadcastPort } from "../operator-data/broadcast-adapter.js"
import {
	createBandPlansBroadcastPort,
	sendBandPlansSnapshot,
} from "./websocket/bandplans-broadcast-adapter.js"
import { regionalRoutes } from "./routes/regional.js"
import { bandPlanRoutes } from "./routes/bandplans.js"
import type {
	BandPlanService,
	BandPlansBroadcastPort,
} from "../core/bandplans/contract.js"
import { receiverCapabilitiesRoutes } from "./routes/receiver-capabilities.js"
import type { RegionalRegistry } from "../core/regional/registry.js"
import type { ReceiverCapabilitiesProvider } from "../core/tuner-capabilities/types.js"

/**
 * HTTP header name for correlation ID.
 * Clients can provide their own correlation ID via this header.
 */
const CORRELATION_ID_HEADER = "x-correlation-id"
/** WG2 req 9: vessel, APRS and mesh `*:update` messages, at most one per entity per 2 s. */
const ENTITY_UPDATE_WINDOW_MS = 2000

/**
 * WG2 req 9.2 identities: a change is sent at once. JSON tuples, so field text containing a
 * separator cannot collide and null stays distinct from "".
 */
export const vesselIdentity = (v: VesselState): string =>
	JSON.stringify([v.name, v.callsign, v.navStatus, v.shipType, v.destination])
export const aprsIdentity = (a: AprsStation): string =>
	JSON.stringify([a.kind, a.symbol, a.comment, a.status, a.killed])
export const meshIdentity = (n: MeshNode): string =>
	JSON.stringify([n.longName, n.shortName, n.role, n.hwModel])

export interface ApiServerConfig {
	publicOrigins?: ProtectedRuntimeAccessConfig["publicOrigins"]
	accessBootstrap?: ProtectedAccessBootstrap
	host: string
	port: number
}

export interface AudioConfig {
	format: string
	sampleRate: number
}

export interface ApiServerDependencies {
	station?: StationIdentity
	access?: NamedAccessRuntimeContext
	regionalRegistry?: RegionalRegistry | null
	/** Owned: stop() closes it after HTTP drain. Writes mount only with access. */
	bandPlans?: BandPlanService
	receiverCapabilitiesProvider?: ReceiverCapabilitiesProvider | null | undefined

	sourceManager: SourceManager
	fanoutManager: FanoutManager
	fanoutTelemetry?: FanoutTelemetryProvider
	decoderManager: DecoderManager
	decoderRegistry?: DecoderRegistry | undefined
	audioOutput: AudioOutput
	tunerRelay?: TunerRelay | undefined
	tunerController?: TunerController | undefined
	liveDemod?: LiveDemodulator | undefined
	digitalVoice?: DigitalVoiceService | undefined
	resourceAggregator?: ResourceAggregator | undefined
	aircraftTracker?: AircraftTracker | undefined
	/** AIS vessel current state (WG1 req 6). */
	vesselTracker?: VesselTracker | undefined
	/** Meshtastic node current state (WG2 req 6). */
	meshTracker?: MeshTracker | undefined
	/** APRS station, object and item current state (WG2 req 4). */
	aprsTracker?: AprsTracker | undefined
	scanner?: ScannerService | undefined
	spectrum?: SpectrumService | undefined
	logger: Logger
	audioConfig?: AudioConfig | undefined
	/** Omitted means Activity is disabled: routes 404 and the socket says so. */
	activity?: ActivityRuntime
}

/**
 * ApiServer - Fastify-based REST and WebSocket server for WaveKit.
 *
 * Provides:
 * - REST API for system control (sources, decoders)
 * - WebSocket endpoint for real-time events
 * - OpenAPI documentation via Swagger
 * - CORS support for browser clients
 */
export class ApiServer {
	private readonly station: StationIdentity | undefined
	private readonly regionalRegistry: RegionalRegistry | null | undefined
	private readonly bandPlans: BandPlanService | undefined
	private readonly receiverCapabilitiesProvider:
		| ReceiverCapabilitiesProvider
		| null
		| undefined
	private readonly access: NamedAccessRuntimeContext | undefined
	private readonly accessController: FastifyAccessController | undefined
	private readonly publicBootstrapConfigured: boolean
	private accessRoutes: AccessRouteController | undefined
	private readonly app: FastifyInstance
	private readonly log: Logger
	private readonly config: ApiServerConfig
	private readonly sourceManager: SourceManager
	private readonly fanoutManager: FanoutManager
	private readonly fanoutTelemetry: FanoutTelemetryProvider
	private readonly decoderManager: DecoderManager
	private readonly decoderRegistry?: DecoderRegistry | undefined
	private readonly audioOutput: AudioOutput
	private readonly tunerRelay?: TunerRelay | undefined
	private readonly tunerController?: TunerController | undefined
	private readonly liveDemod?: LiveDemodulator | undefined
	private readonly digitalVoice?: DigitalVoiceService | undefined
	private readonly resourceAggregator?: ResourceAggregator | undefined
	private readonly aircraftTracker?: AircraftTracker | undefined
	private readonly vesselTracker?: VesselTracker | undefined
	/** Detaches the vessel tracker listeners; the tracker outlives the server. */
	private vesselWiring: (() => void) | null = null
	private readonly meshTracker?: MeshTracker | undefined
	/** Detaches the mesh tracker listeners; the tracker outlives the server. */
	private meshWiring: (() => void) | null = null
	private readonly aprsTracker?: AprsTracker | undefined
	/** Detaches the APRS tracker listeners and stops its update throttle. */
	private aprsWiring: (() => void) | null = null
	private readonly scanner?: ScannerService | undefined
	private readonly spectrum?: SpectrumService | undefined
	private readonly audioConfig?: AudioConfig | undefined
	private readonly wsBroadcaster: WebSocketEventBroadcaster
	private readonly sourceStatusPublisher: SourceStatusPublisher
	private mounted = false
	private starting = false
	private startResult: Promise<void> | undefined
	private stopping = false
	private stopResult: Promise<void> | undefined
	private operatorMountIntent = false
	private operatorRestRegistered = false
	private operatorData: OperatorDataService | undefined
	private operatorObserver: (() => void) | undefined
	private bandPlansObserver: (() => void) | undefined
	private operatorCloseResult: Promise<void> | undefined
	private telemetryInterval: ReturnType<typeof setInterval> | null = null
	private scannerLimiter: WsLimiter<ServerMessage> | null = null
	private scannerWiring: { dispose(): void } | null = null
	private spectrumWiring: { dispose(): void } | null = null
	private readonly activityRuntime: ActivityRuntime | undefined
	private readonly activityService: ActivityRuntime["service"]
	private readonly activityReady: boolean
	private readonly activityUnavailable: ActivityUnavailableState | undefined
	private readonly activityHub: ActivitySubscriptionHub

	constructor(dependencies: ApiServerDependencies, config: ApiServerConfig) {
		this.station = dependencies.station
		this.regionalRegistry = dependencies.regionalRegistry
		this.bandPlans = dependencies.bandPlans
		this.receiverCapabilitiesProvider =
			dependencies.receiverCapabilitiesProvider
		this.access = dependencies.access
		this.sourceManager = dependencies.sourceManager
		this.fanoutManager = dependencies.fanoutManager
		this.fanoutTelemetry =
			dependencies.fanoutTelemetry ?? dependencies.fanoutManager
		this.decoderManager = dependencies.decoderManager
		this.decoderRegistry = dependencies.decoderRegistry
		this.audioOutput = dependencies.audioOutput
		this.tunerRelay = dependencies.tunerRelay
		this.tunerController = dependencies.tunerController
		this.liveDemod = dependencies.liveDemod
		this.digitalVoice = dependencies.digitalVoice
		this.resourceAggregator = dependencies.resourceAggregator
		this.aircraftTracker = dependencies.aircraftTracker
		this.vesselTracker = dependencies.vesselTracker
		this.meshTracker = dependencies.meshTracker
		this.aprsTracker = dependencies.aprsTracker
		this.scanner = dependencies.scanner
		this.spectrum = dependencies.spectrum
		this.audioConfig = dependencies.audioConfig
		this.log = createComponentLogger(dependencies.logger, "ApiServer")
		this.config = config
		this.publicBootstrapConfigured = Boolean(
			this.access &&
			config.publicOrigins &&
			config.accessBootstrap?.mode === "protected",
		)

		// Create WebSocket broadcaster
		this.wsBroadcaster = new WebSocketEventBroadcaster(dependencies.logger)
		this.bandPlansObserver = this.wsBroadcaster.observeChannel("bandplans", {
			subscribed: clientId => {
				try {
					const outcome = sendBandPlansSnapshot(
						this.bandPlans,
						this.getBandPlansBroadcastPort(),
						clientId,
					)
					if (outcome === "rejected")
						this.wsBroadcaster.invalidateClient(clientId)
				} catch {
					this.log.warn("Band-plan snapshot unavailable")
					this.wsBroadcaster.invalidateClient(clientId)
				}
			},
			unsubscribed: () => {},
		})
		const activity = dependencies.activity
		const activityUnavailable =
			activity?.status === "unavailable" ? activity.unavailable : undefined
		this.activityRuntime = activity
		this.activityService = activity?.service ?? inertActivityService()
		this.activityReady = activity?.status === "ready"
		this.activityUnavailable = activityUnavailable
		this.activityHub = createActivitySubscriptions({
			service: this.activityService,
			enabled: this.activityReady,
			...(activityUnavailable ? { unavailable: true } : {}),
		})
		this.wsBroadcaster.attachActivity(this.activityHub)
		activity?.bindSubscriptions(this.activityHub)
		this.sourceStatusPublisher = new SourceStatusPublisher({
			sourceManager: this.sourceManager,
			fanoutTelemetry: this.fanoutTelemetry,
			broadcaster: this.wsBroadcaster,
			logger: dependencies.logger,
		})

		// Create Fastify instance with custom logger
		this.app = Fastify({
			logger: false, // We use our own Pino logger
			disableRequestLogging: true, // We'll handle request logging ourselves
		})

		// Root policy precedes every plugin and route, including documentation.
		this.accessController = this.access
			? installAccessHooks(this.app, {
					...this.access.api,
					publicBootstrap: this.publicBootstrapConfigured,
				})
			: undefined
		if (this.access)
			this.app.addHook("onSend", async (_request, reply, payload) => {
				if (
					reply.hasHeader("Retry-After") &&
					reply.hasHeader("Access-Control-Allow-Origin")
				)
					reply.header("Access-Control-Expose-Headers", "Retry-After")
				return payload
			})

		// Register error handler immediately so it's available for any routes
		this.registerErrorHandler()

		// Wire up event handlers for broadcasting
		this.setupEventBroadcasting()
	}

	/**
	 * Starts the API server.
	 * Registers all plugins and routes, then begins listening.
	 */
	start(): Promise<void> {
		if (this.stopping || this.starting)
			return Promise.reject(
				new WaveKitError("API startup unavailable", "ACCESS_UNAVAILABLE"),
			)
		this.starting = true
		this.startResult = this.finishStart()
		return this.startResult
	}

	private async finishStart(): Promise<void> {
		this.log.info(
			{ host: this.config.host, port: this.config.port },
			"Starting API server",
		)

		// Register plugins
		await this.registerPlugins()
		if (this.stopping)
			throw new WaveKitError("API startup stopped", "ACCESS_UNAVAILABLE")

		// Register request logging hook
		this.registerRequestLogging()

		// Register routes (placeholder - routes will be implemented in later tasks)
		await this.registerRoutes()
		if (this.stopping)
			throw new WaveKitError("API startup stopped", "ACCESS_UNAVAILABLE")

		// Start listening
		try {
			await this.app.listen({
				host: this.config.host,
				port: this.config.port,
			})

			if (this.stopping)
				throw new WaveKitError("API startup stopped", "ACCESS_UNAVAILABLE")
			this.mounted = true
			this.operatorRestRegistered = this.operatorMountIntent
			this.log.info(
				{ host: this.config.host, port: this.config.port },
				"API server started",
			)
		} catch (err) {
			this.log.error("Failed to start API server")
			throw err
		}
	}

	/**
	 * Stops the API server gracefully.
	 */
	/** Current configured projection; the public route publishes an explicit allowlist. */
	getAccessBootstrap() {
		if (
			!this.access ||
			!this.config.publicOrigins ||
			!this.config.accessBootstrap
		)
			return null
		const origins = this.config.publicOrigins
		const mounted = this.mounted && !this.accessController?.admissionStopped
		return {
			version: 1 as const,
			apiOrigin: origins.api,
			webSocketUrl: `${origins.api.replace(/^http/, "ws")}/ws`,
			analogAudioOrigin: origins.analogAudio,
			digitalAudioOrigin: origins.digitalAudio,
			access: accessCapabilities(this.config.accessBootstrap, {
				sessions:
					mounted &&
					this.accessRoutes !== undefined &&
					!this.access.api.sessions.unavailable,
				pairing: mounted && this.accessRoutes !== undefined,
			}),
			capabilities: {
				analogAudioAvailable:
					mounted && Boolean(this.liveDemod?.getStatus().running),
				digitalAudioAvailable:
					mounted && Boolean(this.digitalVoice?.getStatus().running),
				operatorDataAvailable: mounted && this.operatorDataAvailable(),
			},
		}
	}

	/** One initial port; synchronous bounded publication uses the existing transport. */
	getOperatorDataBroadcastPort(): OperatorDataBroadcastPort {
		return {
			publishUpdated: data => {
				try {
					this.wsBroadcaster.broadcast("operator-data", {
						type: "operator-data:updated",
						channel: "operator-data",
						data,
					})
				} catch {
					this.invalidateOperatorDataPublication()
				}
			},
			sendSnapshot: (clientId, data) =>
				this.wsBroadcaster.sendToClients("operator-data", [clientId], {
					type: "operator-data:snapshot",
					channel: "operator-data",
					data,
				}) === 1,
		}
	}

	/** Change notices on `bandplans` in both access modes. */
	getBandPlansBroadcastPort(): BandPlansBroadcastPort {
		return createBandPlansBroadcastPort(this.wsBroadcaster, () => {
			this.log.warn("Band-plan publication unavailable")
			this.wsBroadcaster.invalidateChannelClients("bandplans")
		})
	}

	/** Mapping can fail before the port is called; the initial sink owns this fallback. */
	invalidateOperatorDataPublication(): void {
		this.log.warn("Operator data publication unavailable")
		this.wsBroadcaster.invalidateChannelClients("operator-data")
	}

	/** Protected-only registration intent. Availability follows successful listen, not this call. */
	mountOperatorData(service: OperatorDataService | undefined): void {
		if (
			!this.access ||
			this.starting ||
			this.stopping ||
			this.operatorMountIntent
		)
			throw new WaveKitError("Operator mount unavailable", "ACCESS_UNAVAILABLE")
		this.operatorMountIntent = true
		this.operatorData = service
		this.wsBroadcaster.enableOperatorDataChannel()
		const port = this.getOperatorDataBroadcastPort()
		this.operatorObserver = this.wsBroadcaster.observeChannel("operator-data", {
			subscribed: clientId => {
				try {
					if (!sendOperatorDataSnapshot(this.operatorData, port, clientId))
						this.wsBroadcaster.invalidateClient(clientId)
				} catch {
					this.log.warn("Operator data snapshot unavailable")
					this.wsBroadcaster.invalidateClient(clientId)
				}
			},
			unsubscribed: () => {},
		})
	}

	private operatorDataAvailable(): boolean {
		if (!this.operatorRestRegistered || !this.operatorObserver || this.stopping)
			return false
		try {
			return this.operatorData?.snapshot() !== undefined
		} catch {
			return false
		}
	}

	stopAdmission(): void {
		this.stopping = true
		this.mounted = false
		this.operatorRestRegistered = false
		let failed = false
		for (const seal of [
			() => this.accessController?.stopAdmission(),
			() => this.accessRoutes?.stopAdmission(),
			() => this.wsBroadcaster.stopSubscriptionAdmission(),
		]) {
			try {
				seal()
			} catch {
				failed = true
			}
		}
		if (failed)
			throw new WaveKitError(
				"API admission seal incomplete",
				"ACCESS_UNAVAILABLE",
			)
	}

	stop(): Promise<void> {
		if (this.stopResult) return this.stopResult
		let failed = false
		try {
			this.stopAdmission()
		} catch {
			failed = true
		}
		this.stopResult = this.finishStop(failed)
		return this.stopResult
	}

	private async finishStop(sealFailed: boolean): Promise<void> {
		this.log.info("Stopping API server")
		let failed = sealFailed
		const attempt = async (operation: () => void | Promise<void>) => {
			try {
				await operation()
			} catch {
				failed = true
			}
		}
		// Startup cannot resume into registration/listen after teardown.
		await this.startResult?.catch(() => undefined)
		// Each actual drain is attempted. Output policy/sink/observer survive both.
		await attempt(() => {
			this.operatorCloseResult ??=
				this.operatorData?.close() ?? Promise.resolve()
			return this.operatorCloseResult
		})
		await attempt(async () => {
			await this.accessRoutes?.drain()
		})
		await attempt(() => {
			this.operatorObserver?.()
			this.operatorObserver = undefined
		})
		await attempt(() => {
			this.bandPlansObserver?.()
			this.bandPlansObserver = undefined
		})
		await attempt(() => {
			this.accessController?.dispose()
		})
		await attempt(() => {
			this.wsBroadcaster.closeAll()
		})
		await attempt(() => {
			if (this.telemetryInterval) {
				clearInterval(this.telemetryInterval)
				this.telemetryInterval = null
			}
		})
		await attempt(() => {
			this.sourceStatusPublisher.stop()
		})
		await attempt(() => {
			this.scannerWiring?.dispose()
			this.scannerWiring = null
			this.scannerLimiter = null
		})
		await attempt(() => {
			this.spectrumWiring?.dispose()
			this.spectrumWiring = null
		})
		await attempt(() => {
			this.vesselWiring?.()
			this.vesselWiring = null
		})
		await attempt(() => {
			this.meshWiring?.()
			this.meshWiring = null
		})
		await attempt(() => {
			this.aprsWiring?.()
			this.aprsWiring = null
		})
		await attempt(async () => {
			await this.app.close()
		})
		// After HTTP drain: reads never see a closed store while requests finish.
		await attempt(() => this.bandPlans?.close())
		if (failed) {
			this.log.error("Error stopping API server")
			throw new WaveKitError("API shutdown incomplete", "ACCESS_UNAVAILABLE")
		}
		this.log.info("API server stopped")
	}

	/**
	 * Returns the underlying Fastify instance.
	 * Useful for testing or advanced configuration.
	 */
	getApp(): FastifyInstance {
		return this.app
	}

	/**
	 * Returns the source manager instance.
	 * Used by route handlers.
	 */
	getSourceManager(): SourceManager {
		return this.sourceManager
	}

	/**
	 * Returns the fanout manager instance.
	 * Used by route handlers and telemetry.
	 */
	getFanoutManager(): FanoutManager {
		return this.fanoutManager
	}

	/**
	 * Returns the decoder manager instance.
	 * Used by route handlers.
	 */
	getDecoderManager(): DecoderManager {
		return this.decoderManager
	}

	/**
	 * Returns the audio output instance.
	 * Used by route handlers.
	 */
	getAudioOutput(): AudioOutput {
		return this.audioOutput
	}

	/**
	 * Returns the tuner relay instance (if enabled).
	 */
	getTunerRelay(): TunerRelay | undefined {
		return this.tunerRelay
	}

	/**
	 * Returns the tuner controller instance (if enabled).
	 */
	getTunerController(): TunerController | undefined {
		return this.tunerController
	}

	/**
	 * Returns the resource aggregator instance (if enabled).
	 */
	getResourceAggregator(): ResourceAggregator | undefined {
		return this.resourceAggregator
	}

	/**
	 * Returns the WebSocket broadcaster instance.
	 * Used for external event broadcasting.
	 */
	getWebSocketBroadcaster(): WebSocketEventBroadcaster {
		return this.wsBroadcaster
	}

	/**
	 * Sets up event broadcasting from source manager and decoder manager to WebSocket clients.
	 * Wires up event handlers to broadcast events to subscribed clients.
	 *
	 * Requirements:
	 * - 10.3: Broadcast decoder output to subscribed clients
	 * - 10.4: Broadcast source events to subscribed clients
	 * - 20.4: Broadcast decoder health state changes
	 * - Telemetry: Broadcast fanout backpressure/drain events
	 */
	private setupEventBroadcasting(): void {
		// Decoder events (Requirement 10.3)
		this.decoderManager.on("decoder:output", (decoderId, output) => {
			this.wsBroadcaster.broadcastDecoderOutput(decoderId, output)
		})

		this.decoderManager.on("decoder:started", decoderId => {
			this.wsBroadcaster.broadcastDecoderStarted(decoderId)
		})

		this.decoderManager.on("decoder:stopped", decoderId => {
			this.wsBroadcaster.broadcastDecoderStopped(decoderId)
		})

		this.decoderManager.on("decoder:error", (decoderId, error) => {
			this.wsBroadcaster.broadcastDecoderError(decoderId, error.message)
		})

		// Decoder health events (Requirement 20.4)
		this.decoderManager.on("decoder:health", (decoderId, health) => {
			this.wsBroadcaster.broadcastDecoderHealth(decoderId, health)
		})

		// Full decoder status (same body as GET /api/decoders/:id) on every
		// lifecycle transition, so WS clients see lastError/restartCount without REST.
		const publishDecoderStatus = (decoderId: string): void => {
			const status = this.decoderManager.getStatus(decoderId)
			if (status)
				this.wsBroadcaster.broadcastDecoderStatus(
					toApiDecoderInfo(status, this.decoderRegistry),
				)
		}
		for (const event of [
			"decoder:started",
			"decoder:stopped",
			"decoder:error",
			"decoder:health",
			"decoder:restarting",
			"decoder:max-restarts",
			// after stop/exit cleanup (unwire), so the final status is not stale
			"decoder:status-changed",
		] as const)
			this.decoderManager.on(event, publishDecoderStatus)

		// Runtime decoders (scanner probes, spec § 6.5 / § 12.2)
		this.decoderManager.on("decoder:created", (decoderId: string) => {
			const status = this.decoderManager.getStatus(decoderId)
			if (!status) return
			this.wsBroadcaster.broadcastDecoderCreated({
				decoderId,
				decoder: toApiDecoderInfo(status, this.decoderRegistry),
			})
		})
		this.decoderManager.on("decoder:removed", (decoderId: string) => {
			this.wsBroadcaster.broadcastDecoderRemoved({
				decoderId,
				removedAt: new Date().toISOString(),
			})
		})

		if (this.scanner) this.setupScannerBroadcasting(this.scanner)
		// Spectrum frames, acks and snapshots bypass the scanner WsLimiter (Spectrum-profile amendment).
		if (this.spectrum)
			this.spectrumWiring = wireSpectrumBroadcasts(
				this.spectrum,
				this.wsBroadcaster,
			)

		// Source status with activity (same body as a GET /api/sources item)
		this.sourceStatusPublisher.start()

		// Source events (Requirement 10.4)
		this.sourceManager.on("connected", sourceId => {
			this.wsBroadcaster.broadcastSourceConnected(sourceId)
		})

		this.sourceManager.on("disconnected", (sourceId, error) => {
			this.wsBroadcaster.broadcastSourceDisconnected(sourceId, error?.message)
		})

		// Every permanent removal goes through SourceManager.disconnect(), which
		// emits "source-removed" once. reconnect() and shutdown do not.
		this.sourceManager.on("source-removed", (sourceId, removedAt) => {
			this.wsBroadcaster.broadcastSourceRemoved(sourceId, removedAt)
		})

		this.sourceManager.on("error", (sourceId, error) => {
			this.wsBroadcaster.broadcastSourceError(sourceId, error.message)
		})

		// Metrics events (Requirement 10.5)
		this.sourceManager.on("metrics", (sourceId, metrics) => {
			this.wsBroadcaster.broadcastMetrics(sourceId, metrics)
		})

		// Fanout telemetry events (edge-triggered)
		this.fanoutTelemetry.on("backpressure", (branchId, bufferedBytes) => {
			this.wsBroadcaster.broadcastFanoutBackpressure(branchId, bufferedBytes)
		})

		this.fanoutTelemetry.on("drain", (branchId, durationMs) => {
			this.wsBroadcaster.broadcastFanoutDrain(branchId, durationMs)
		})

		// Periodic fanout telemetry snapshot (every 1 second)
		this.telemetryInterval = setInterval(() => {
			const snapshot = this.fanoutTelemetry.getTelemetrySnapshot()
			this.wsBroadcaster.broadcastFanoutSnapshot(snapshot)
		}, 1000)

		// Resource monitoring events
		if (this.resourceAggregator) {
			this.resourceAggregator.on("snapshot", snapshot => {
				this.wsBroadcaster.broadcastResourceSnapshot(snapshot)
			})

			this.resourceAggregator.on("alert", alert => {
				this.wsBroadcaster.broadcastResourceAlert(alert)
			})
		}

		// Tuner controller events
		if (this.tunerController) {
			this.tunerController.on("state-changed", (sourceId, state) => {
				this.wsBroadcaster.broadcastTunerStateChanged(sourceId, state)
			})

			this.tunerController.on(
				"command-sent",
				(sourceId, command, value, origin) => {
					this.wsBroadcaster.broadcastTunerCommandSent(
						sourceId,
						command,
						value,
						origin,
					)
				},
			)

			this.tunerController.on("control-mode-changed", (sourceId, mode) => {
				this.wsBroadcaster.broadcastTunerControlModeChanged(sourceId, mode)
			})

			this.tunerController.on("error", (sourceId, error) => {
				this.wsBroadcaster.broadcastTunerError(sourceId, error.message)
			})
		}

		// Aircraft tracker events (ADS-B specific)
		if (this.aircraftTracker) {
			this.aircraftTracker.on("aircraft:new", aircraft => {
				this.wsBroadcaster.broadcastAircraftNew(aircraft)
			})

			this.aircraftTracker.on("aircraft:update", aircraft => {
				this.wsBroadcaster.broadcastAircraftUpdate(aircraft)
			})

			this.aircraftTracker.on("aircraft:lost", (icao, aircraft) => {
				this.wsBroadcaster.broadcastAircraftLost(icao, aircraft)
			})

			this.aircraftTracker.on("stats:update", stats => {
				this.wsBroadcaster.broadcastAircraftStats(stats)
			})
		}

		// AIS vessel tracker events (WG1 req 6.4); updates through the 2 s throttle (WG2 req 9.4)
		if (this.vesselTracker) {
			const tracker = this.vesselTracker
			const throttle = new EntityUpdateThrottle<VesselState>({
				windowMs: ENTITY_UPDATE_WINDOW_MS,
				identity: vesselIdentity,
				emit: (_key, vessel) => {
					this.wsBroadcaster.broadcastVesselUpdate(vessel)
				},
			})
			const onNew = (vessel: VesselState) => {
				this.wsBroadcaster.broadcastVesselNew(vessel)
			}
			const onUpdate = (vessel: VesselState) => {
				throttle.offer(vessel.mmsi, vessel)
			}
			// A pending update must not follow the lost message.
			const onLost = (mmsi: string, vessel: VesselState) => {
				throttle.clear(mmsi)
				this.wsBroadcaster.broadcastVesselLost(mmsi, vessel)
			}
			const onStats = (stats: VesselTrackerStats) => {
				this.wsBroadcaster.broadcastVesselStats(stats)
			}
			tracker.on("vessel:new", onNew)
			tracker.on("vessel:update", onUpdate)
			tracker.on("vessel:lost", onLost)
			tracker.on("stats:update", onStats)
			this.vesselWiring = () => {
				throttle.stop()
				tracker.off("vessel:new", onNew)
				tracker.off("vessel:update", onUpdate)
				tracker.off("vessel:lost", onLost)
				tracker.off("stats:update", onStats)
			}
		}

		// APRS tracker events (WG2 req 4.2, 4.3); updates through the 2 s throttle (req 9.4)
		if (this.aprsTracker) {
			const tracker = this.aprsTracker
			const throttle = new EntityUpdateThrottle<AprsStation>({
				windowMs: ENTITY_UPDATE_WINDOW_MS,
				identity: aprsIdentity,
				emit: (_key, station) => {
					this.wsBroadcaster.broadcastAprsUpdate(station)
				},
			})
			const onNew = (station: AprsStation) => {
				this.wsBroadcaster.broadcastAprsNew(station)
			}
			const onUpdate = (station: AprsStation) => {
				throttle.offer(station.key, station)
			}
			const onLost = (key: string, station: AprsStation) => {
				throttle.clear(key)
				this.wsBroadcaster.broadcastAprsLost(key, station)
			}
			const onStats = (stats: AprsTrackerStats) => {
				this.wsBroadcaster.broadcastAprsStats(stats)
			}
			tracker.on("aprs:new", onNew)
			tracker.on("aprs:update", onUpdate)
			tracker.on("aprs:lost", onLost)
			tracker.on("stats:update", onStats)
			this.aprsWiring = () => {
				throttle.stop()
				tracker.off("aprs:new", onNew)
				tracker.off("aprs:update", onUpdate)
				tracker.off("aprs:lost", onLost)
				tracker.off("stats:update", onStats)
			}
		}

		// Meshtastic node tracker events (WG2 req 6.2, 6.3); updates through the 2 s throttle (req 9.4)
		if (this.meshTracker) {
			const tracker = this.meshTracker
			const throttle = new EntityUpdateThrottle<MeshNode>({
				windowMs: ENTITY_UPDATE_WINDOW_MS,
				identity: meshIdentity,
				emit: (_key, node) => {
					this.wsBroadcaster.broadcastMeshUpdate(node)
				},
			})
			const onNew = (node: MeshNode) => {
				this.wsBroadcaster.broadcastMeshNew(node)
			}
			const onUpdate = (node: MeshNode) => {
				throttle.offer(node.key, node)
			}
			const onLost = (nodeId: string, node: MeshNode) => {
				throttle.clear(node.key)
				this.wsBroadcaster.broadcastMeshLost(nodeId, node)
			}
			const onStats = (stats: MeshTrackerStats) => {
				this.wsBroadcaster.broadcastMeshStats(stats)
			}
			tracker.on("mesh:new", onNew)
			tracker.on("mesh:update", onUpdate)
			tracker.on("mesh:lost", onLost)
			tracker.on("stats:update", onStats)
			this.meshWiring = () => {
				throttle.stop()
				tracker.off("mesh:new", onNew)
				tracker.off("mesh:update", onUpdate)
				tracker.off("mesh:lost", onLost)
				tracker.off("stats:update", onStats)
			}
		}

		this.log.debug("Event broadcasting handlers registered")
	}

	/** Scanner channel (spec § 12.2): rate-limited `scanner`. */
	private setupScannerBroadcasting(scanner: ScannerService): void {
		const wiring = wireScannerBroadcasts(scanner, this.wsBroadcaster)
		this.scannerLimiter = wiring.limiter
		this.scannerWiring = wiring
	}

	/**
	 * Registers all Fastify plugins.
	 */
	private async registerPlugins(): Promise<void> {
		// CORS support for browser clients
		if (!this.access)
			await this.app.register(fastifyCors, {
				origin: true, // Allow all origins (can be restricted in production)
				methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
				allowedHeaders: ["Content-Type", "Authorization"],
				credentials: true,
			})

		this.log.debug("CORS plugin registered")

		// WebSocket support for real-time events
		await this.app.register(fastifyWebsocket, {
			options: {
				maxPayload: 1048576, // 1MB max message size
			},
		})

		this.log.debug("WebSocket plugin registered")

		// Swagger/OpenAPI documentation
		await this.app.register(fastifySwagger, {
			openapi: {
				openapi: "3.0.0",
				info: {
					title: "WaveKit API",
					description: "SDR stream processing framework REST API",
					version: "1.0.0",
				},
				servers: [
					{
						url: `http://${this.config.host}:${this.config.port}`,
						description: "Local server",
					},
				],
				tags: [
					{ name: "health", description: "Health check endpoints" },
					{ name: "sources", description: "SDR source management" },
					{ name: "decoders", description: "Decoder management" },
					{ name: "aircraft", description: "Aircraft tracking endpoints" },
					{ name: "vessels", description: "AIS vessel tracking endpoints" },
					{ name: "mesh", description: "Meshtastic node tracking endpoints" },
					{
						name: "aprs",
						description: "APRS station, object and item tracking",
					},
					{ name: "live-audio", description: "Live demodulation endpoints" },
					{ name: "tuner", description: "RTL-TCP tuner control endpoints" },
					{ name: "tuner-relay", description: "RTL-TCP tuner relay endpoints" },
					{ name: "resources", description: "Resource monitoring endpoints" },
					{
						name: "scanner",
						description: "Signal discovery scanner endpoints",
					},
				],
			},
		})

		this.log.debug("Swagger plugin registered")

		// Swagger UI for interactive documentation
		await this.app.register(fastifySwaggerUi, {
			routePrefix: "/docs",
			uiConfig: {
				docExpansion: "list",
				deepLinking: true,
			},
		})

		this.log.debug("Swagger UI plugin registered")
	}

	/**
	 * Registers the centralized error handler.
	 * Converts errors to consistent JSON responses with correlation IDs.
	 *
	 * Requirements:
	 * - 6.3: Include correlation IDs in logs for request tracing
	 */
	private registerErrorHandler(): void {
		// Handle 404 Not Found
		this.app.setNotFoundHandler((request, reply) => {
			const correlationId = (request as unknown as { correlationId?: string })
				.correlationId

			this.log.debug(
				{
					method: request.method,
					route: request.routeOptions.url ?? "unmatched",
					correlationId,
				},
				"Route not found",
			)

			return reply.status(404).send({
				error: "NotFound",
				code: "NOT_FOUND",
				message: this.access
					? "Route not found"
					: `Route ${request.method} ${request.url} not found`,
				correlationId,
			})
		})

		this.app.setErrorHandler((error: FastifyError, request, reply) => {
			const correlationId = (request as unknown as { correlationId?: string })
				.correlationId

			// Log the error with correlation ID
			this.log.error(
				{
					code: error instanceof WaveKitError ? error.code : "REQUEST_ERROR",
					method: request.method,
					route: request.routeOptions.url ?? "unmatched",
					statusCode: error.statusCode ?? 500,
					correlationId,
				},
				"Request error",
			)

			// Handle WaveKit-specific errors. Activity query errors carry their
			// own status (409/410/429/500/503); other WaveKit errors stay 400.
			if (error instanceof WaveKitError) {
				const status =
					error instanceof ActivityQueryError ? error.statusCode : 400
				const reason =
					error instanceof ActivityQueryError ? error.reason : undefined
				return reply.status(status).send({
					error: error.name,
					code: error.code,
					message: this.access ? "Request failed" : error.message,
					...(reason !== undefined ? { reason } : {}),
					correlationId,
				})
			}

			// Handle validation errors (from Fastify schema validation)
			if (error.validation) {
				return reply.status(400).send({
					error: "ValidationError",
					code: "VALIDATION_ERROR",
					message: this.access ? "Request failed" : error.message,
					...(this.access ? {} : { details: error.validation }),
					correlationId,
				})
			}

			// Handle not found errors
			if (error.statusCode === 404) {
				return reply.status(404).send({
					error: "NotFound",
					code: "NOT_FOUND",
					message: "Resource not found",
					correlationId,
				})
			}

			// Handle other HTTP errors
			if (
				error.statusCode &&
				error.statusCode >= 400 &&
				error.statusCode < 500
			) {
				return reply.status(error.statusCode).send({
					error: error.name || "ClientError",
					code: error.code || "CLIENT_ERROR",
					message: this.access ? "Request failed" : error.message,
					correlationId,
				})
			}

			// Default to 500 for unknown errors
			return reply.status(500).send({
				error: "InternalServerError",
				code: "INTERNAL_ERROR",
				message:
					this.access || process.env["NODE_ENV"] === "production"
						? "An internal error occurred"
						: error.message,
				correlationId,
			})
		})

		this.log.debug("Error handler registered")
	}

	/**
	 * Registers request logging hook.
	 * Logs incoming requests and response times with correlation IDs.
	 *
	 * Requirements:
	 * - 6.1: Output structured JSON logs
	 * - 6.3: Include correlation IDs in logs for request tracing
	 */
	private registerRequestLogging(): void {
		// Generate or extract correlation ID for each request
		this.app.addHook("onRequest", async (request, reply) => {
			// Use client-provided correlation ID or generate a new one
			const clientCorrelationId = request.headers[CORRELATION_ID_HEADER]
			const correlationId =
				typeof clientCorrelationId === "string" &&
				/^[A-Za-z0-9_-]{1,64}$/.test(clientCorrelationId)
					? clientCorrelationId
					: generateCorrelationId()

			// Store correlation ID on request for later use
			;(request as unknown as { correlationId: string }).correlationId =
				correlationId

			// Add correlation ID to response headers for client tracking
			void reply.header(CORRELATION_ID_HEADER, correlationId)

			// Create a request-scoped logger with correlation ID
			const requestLogger = createScopedLogger(
				this.log,
				"Request",
				correlationId,
			)
			;(request as unknown as { log: Logger }).log = requestLogger

			// Skip logging for health checks and docs to reduce noise
			if (request.url === "/health" || request.url.startsWith("/docs")) {
				return
			}

			requestLogger.debug(
				{
					method: request.method,
					route: request.routeOptions.url ?? "unmatched",
					remoteAddress: request.ip,
				},
				"Incoming request",
			)
		})

		this.app.addHook("onResponse", async (request, reply) => {
			// Skip logging for health checks and docs
			if (request.url === "/health" || request.url.startsWith("/docs")) {
				return
			}

			// Get the correlation ID from the request
			const correlationId = (request as unknown as { correlationId?: string })
				.correlationId

			this.log.info(
				{
					method: request.method,
					route: request.routeOptions.url ?? "unmatched",
					statusCode: reply.statusCode,
					responseTime: reply.elapsedTime,
					correlationId,
				},
				"Request completed",
			)
		})

		this.log.debug("Request logging hooks registered")
	}

	/**
	 * Registers all API routes.
	 * Routes are implemented in separate files and registered here.
	 */
	private async registerRoutes(): Promise<void> {
		if (this.station)
			await this.app.register(stationRoutes, { station: this.station })
		// These child plugins inherit normal root admission in both access modes.
		// Providers are borrowed; the composing runtime owns receiver disposal.
		if (this.regionalRegistry !== undefined)
			await this.app.register(regionalRoutes, {
				registry: this.regionalRegistry,
			})
		// Reads in both access modes; mutation routes only with the access controller.
		if (this.bandPlans)
			await this.app.register(bandPlanRoutes, {
				service: this.bandPlans,
				...(this.accessController
					? {
							authorizeMutation: request =>
								this.accessController!.authorizeMetadataMutation(request),
						}
					: {}),
			})
		await this.app.register(receiverCapabilitiesRoutes, {
			provider: this.receiverCapabilitiesProvider,
		})
		if (this.access)
			this.accessRoutes = registerAccessRoutes(this.app, this.access.services)

		if (this.publicBootstrapConfigured && this.access && this.accessController)
			await this.app.register(accessBootstrapRoutes, {
				policy: this.access.api.policy,
				controller: this.accessController,
				provideBootstrap: () =>
					this.mounted &&
					!this.stopping &&
					!this.accessController?.admissionStopped
						? this.getAccessBootstrap()
						: null,
			})

		// Register health and status routes (Requirement 9.1, 9.2)
		await this.app.register(healthRoutes, {
			sourceManager: this.sourceManager,
			decoderManager: this.decoderManager,
			audioOutput: this.audioOutput,
			audioConfig: this.audioConfig,
			tunerRelay: this.tunerRelay,
		})

		// Register source routes (Requirement 9.3, 9.4, 9.5)
		await this.app.register(sourceRoutes, {
			sourceManager: this.sourceManager,
			fanoutManager: this.fanoutTelemetry,
		})

		// Register decoder routes (Requirement 9.6, 9.7, 9.8, 9.9)
		await this.app.register(decoderRoutes, {
			decoderManager: this.decoderManager,
			decoderRegistry: this.decoderRegistry,
		})
		// Band overrides (band defaults spec §5.2)
		await this.app.register(decoderBandRoutes, {
			decoderManager: this.decoderManager,
		})

		// Register telemetry routes (Fanout backpressure monitoring)
		await this.app.register(telemetryRoutes, {
			fanoutManager: this.fanoutTelemetry,
		})

		if (this.tunerRelay) {
			await this.app.register(tunerRelayRoutes, {
				tunerRelay: this.tunerRelay,
			})
		}

		if (this.tunerController) {
			await this.app.register(tunerRoutes, {
				tunerController: this.tunerController,
			})
		}

		if (this.liveDemod) {
			await this.app.register(liveAudioRoutes, {
				liveDemod: this.liveDemod,
			})
		}

		if (this.digitalVoice) {
			await this.app.register(digitalVoiceRoutes, {
				digitalVoice: this.digitalVoice,
			})
		}

		// Register resource monitoring routes
		if (this.resourceAggregator) {
			await this.app.register(resourceRoutes, {
				resourceAggregator: this.resourceAggregator,
			})
		}

		// Register aircraft tracking routes (ADS-B specific)
		if (this.aircraftTracker) {
			await this.app.register(aircraftRoutes, {
				tracker: this.aircraftTracker,
			})
		}

		// AIS vessel current-state routes (WG1 req 6.1-6.3)
		if (this.vesselTracker) {
			await this.app.register(vesselRoutes, {
				tracker: this.vesselTracker,
			})
		}

		// APRS current-state routes (WG2 req 4.1)
		if (this.aprsTracker) {
			await this.app.register(aprsRoutes, {
				tracker: this.aprsTracker,
			})
		}

		// Meshtastic node current-state routes (WG2 req 6.1)
		if (this.meshTracker) {
			await this.app.register(meshRoutes, {
				tracker: this.meshTracker,
			})
		}

		// Signal discovery scanner (spec § 12.1)
		if (this.scanner) {
			await this.app.register(scannerRoutes, {
				scanner: this.scanner,
				...(this.accessController ? { access: this.accessController } : {}),
			})
		}
		if (this.spectrum) {
			await this.app.register(spectrumRoutes, { spectrum: this.spectrum })
		}

		if (this.operatorMountIntent && this.accessController)
			await this.app.register(operatorDataRoutes, {
				operatorData: this.operatorData,
				authorizeMetadataMutation: request =>
					this.accessController!.authorizeMetadataMutation(request),
			})

		const activityRuntime = this.activityRuntime
		await this.app.register(activityRoutes, {
			service: this.activityService,
			enabled: this.activityReady,
			...(activityRuntime
				? { discloseErrors: activityRuntime.discloseErrors }
				: {}),
			...(this.accessController
				? {
						access: {
							principalId: request =>
								this.accessController?.principalOf(request)?.id,
						},
					}
				: {}),
			...(this.activityUnavailable
				? { unavailable: this.activityUnavailable }
				: {}),
			...(this.activityReady && activityRuntime
				? { stats: () => activityRuntime.stats() }
				: {}),
		})

		// Register WebSocket route (Requirement 10.1, 10.2, 10.3, 10.4, 10.5)
		this.wsBroadcaster.registerRoute(this.app, this.accessController)

		this.log.debug("Routes registered")
	}
}
