/**
 * GET /api/diagnostics: why the core is slow, in one read. Every figure is one the core can read
 * cheaply or already keeps; what it cannot read here is null, never a guess.
 */
export const DIAGNOSTICS_LIMITS = Object.freeze({
	/**
	 * One sample serves every read for this long, so polling cannot multiply the cost: however many
	 * clients poll, a sample starts at most once per 2 s. It is also the shortest CPU window: at
	 * Linux's 100 ticks per second, 2 s resolves 1 tick / 200 ticks = 0.005 of a core per thread.
	 */
	cacheMs: 2_000,
	/**
	 * Threads read per sample, lowest ids first (the main thread is the lowest): 1 directory read
	 * plus at most 64 file reads, so at most 65 / 2 s = 32.5 reads a second. Node's own threads
	 * plus the core's workers stay under this; past it `threads.truncated` says so.
	 */
	threadsMax: 64,
	/** Stop starting thread reads past this into a sample, so a busy file pool ends the walk. */
	threadReadBudgetMs: 250,
	/** Channels listed, in the channelizer's order; past it `channels.truncated` says so. */
	channelsMax: 64,
})

/**
 * One thread of the core process (Linux `/proc/self/task/<tid>/stat`). `name` is the kernel's
 * short name, at most 15 characters, with anything outside printable ASCII replaced by `?`.
 */
export interface DiagnosticsThread {
	tid: number
	name: string
	/** CPU since this thread started, in seconds. */
	cpuSeconds: number
	/** Average cores over `process.windowMs`; null on the sample that first sees this thread. */
	cpuCores: number | null
}

/** One open channelizer output: what it was asked for and what the process reported last. */
export interface DiagnosticsChannel {
	id: string
	sourceId: string
	decoderId: string
	generation: number
	centerHz: number
	bandwidthHz: number
	outputRateHz: number
	format: "cu8" | "cf32"
	/** Filter length the process built; its per-sample cost grows with this and the input rate. */
	filterTaps: number
	/** The capture rate this channel is cut from. */
	inputSampleRateHz: number
	/** Counters of the process's last `stats` line (every 5 s); null before the first. */
	stats: {
		outputSamples: number
		droppedSamples: number
		saturatedSamples: number
		queueHighWaterBytes: number
	} | null
}

export interface Diagnostics {
	at: string
	/** Over `process.windowMs`, 0 to 1; null on the first sample. */
	eventLoopUtilization: number | null
	/** The loop meter's readings, in ms; null when this core does not expose its meter. */
	eventLoopDelay: {
		/** The last 2 s interval. */
		last: { maxMs: number; p99Ms: number } | null
		maxMs10m: number | null
		p99MaxMs10m: number | null
		intervals10m: number
	} | null
	process: {
		/** Since the previous sample; null on the first. */
		windowMs: number | null
		/** All threads of the core together, averaged over the window; 1 is one full core. */
		cpuCores: number | null
		userSeconds: number
		systemSeconds: number
	}
	/** The whole container with every decoder process in it, in cores; null outside a container. */
	containerCpuCores: number | null
	/** Null off Linux or when the thread list cannot be read. */
	threads: {
		rows: DiagnosticsThread[]
		truncated: boolean
	} | null
	/** Null when no channelizer is composed in this core. */
	channels: {
		rows: DiagnosticsChannel[]
		truncated: boolean
	} | null
}

const nullableNumber = { type: ["number", "null"] } as const

/** Fastify response schema of `Diagnostics`. */
export const diagnosticsResponseSchema = {
	type: "object",
	properties: {
		at: { type: "string" },
		eventLoopUtilization: nullableNumber,
		eventLoopDelay: {
			type: ["object", "null"],
			properties: {
				last: {
					type: ["object", "null"],
					properties: { maxMs: { type: "number" }, p99Ms: { type: "number" } },
				},
				maxMs10m: nullableNumber,
				p99MaxMs10m: nullableNumber,
				intervals10m: { type: "number" },
			},
		},
		process: {
			type: "object",
			properties: {
				windowMs: nullableNumber,
				cpuCores: nullableNumber,
				userSeconds: { type: "number" },
				systemSeconds: { type: "number" },
			},
		},
		containerCpuCores: nullableNumber,
		threads: {
			type: ["object", "null"],
			properties: {
				rows: {
					type: "array",
					items: {
						type: "object",
						properties: {
							tid: { type: "integer" },
							name: { type: "string" },
							cpuSeconds: { type: "number" },
							cpuCores: nullableNumber,
						},
					},
				},
				truncated: { type: "boolean" },
			},
		},
		channels: {
			type: ["object", "null"],
			properties: {
				rows: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							sourceId: { type: "string" },
							decoderId: { type: "string" },
							generation: { type: "integer" },
							centerHz: { type: "number" },
							bandwidthHz: { type: "number" },
							outputRateHz: { type: "number" },
							format: { type: "string", enum: ["cu8", "cf32"] },
							filterTaps: { type: "integer" },
							inputSampleRateHz: { type: "number" },
							stats: {
								type: ["object", "null"],
								properties: {
									outputSamples: { type: "number" },
									droppedSamples: { type: "number" },
									saturatedSamples: { type: "number" },
									queueHighWaterBytes: { type: "number" },
								},
							},
						},
					},
				},
				truncated: { type: "boolean" },
			},
		},
	},
} as const
