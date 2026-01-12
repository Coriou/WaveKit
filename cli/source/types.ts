/**
 * Shared type definitions for CLI components
 */

// ============================================================================
// Decoder Types
// ============================================================================

export interface DecoderStats {
	bytesIn: number
	eventsOut: number
	errors: number
}

export interface DecoderStatus {
	id: string
	type?: string
	running: boolean
	/** Server returns "running" | "idle" | "faulted" */
	health:
		| "running"
		| "idle"
		| "faulted"
		| "healthy"
		| "degraded"
		| "unhealthy"
		| "unknown"
	stats: DecoderStats
	uptime: number
	pid?: number
	restartCount?: number
	version?: string
	error?: string
}

export interface DecoderOutput {
	type: string
	decoder: string
	timestamp: string
	data: unknown
}

// ============================================================================
// Source Types
// ============================================================================

export interface SourceStatus {
	id: string
	type?: string
	url?: string
	connected: boolean
	consumers?: number
	bytesReceived?: number
	dataRate?: number
	lastError?: string
	reconnectAttempts?: number
}

// ============================================================================
// Tuner Relay Types
// ============================================================================

export interface TunerRelayStatus {
	enabled: boolean
	listening: boolean
	host: string
	port: number
	sourceId?: string
	sourceConnected?: boolean
	sourceKind?: string
	sourceFormat?: string
	compatibility?: string
	compatibilityMessage?: string
	clientsConnected: number
	controlClientId?: string
	controlClientRemote?: string
	controlPolicy: "exclusive" | "shared"
	maxClients?: number
	bytesSent: number
	bytesReceived: number
	lastCommand?: string
	lastCommandAt?: string
	lastCommandValue?: number
	lastFrequency?: number
	lastSampleRate?: number
	lastGain?: number
	lastPpm?: number
	commandHistoryLimit?: number
	commandStats?: TunerRelayCommandStat[]
	commandHistory?: TunerRelayCommandHistoryEntry[]
	lastError?: string
}

export interface TunerRelayCommandStat {
	id: number
	name: string
	count: number
	lastValue: number
	lastSeenAt: string
}

export interface TunerRelayCommandHistoryEntry {
	id: number
	name: string
	value: number
	at: string
	clientId?: string
	clientRemote?: string
}

// ============================================================================
// Backpressure Types
// ============================================================================

export interface BranchTelemetry {
	id: string
	decoderId?: string
	sourceId?: string
	backpressureActive: boolean
	backpressureEnterCount: number
	droppedBytesTotal: number
	droppedChunksTotal: number
	bufferBytes: number
	highWaterMark: number
	totalBytesWritten?: number
	lastBackpressureAt?: string
	lastDrainAt?: string
}

export interface FanoutSnapshot {
	timestamp: string
	branches: BranchTelemetry[]
	backpressureActiveCount: number
	droppedBytesTotal: number
	droppedChunksTotal: number
	totalBytesWritten?: number
}

// ============================================================================
// WebSocket Message Types
// ============================================================================

export interface DecoderOutputMessage {
	decoderId: string
	output: DecoderOutput
}
