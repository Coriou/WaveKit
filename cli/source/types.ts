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
