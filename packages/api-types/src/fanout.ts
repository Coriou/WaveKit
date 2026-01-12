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
	backpressureSince?: string | null
	lastBackpressureAt?: string | null
	lastDrainAt?: string | null
}

export interface FanoutSnapshot {
	timestamp: string
	branches: BranchTelemetry[]
	backpressureActiveCount: number
	droppedBytesTotal: number
	droppedChunksTotal: number
	totalBytesWritten?: number
}

export type FanoutStatus = FanoutSnapshot
