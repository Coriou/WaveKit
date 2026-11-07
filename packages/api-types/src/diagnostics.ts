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
	/**
	 * A sample waits this long for the thread list and reads, whatever they do, and answers with what
	 * it has: no read starts past it, and a read that hangs is left behind (`threadsTimedOut`). No new
	 * walk starts while one is hung, so hung reads hold 1 file-pool thread at most.
	 */
	threadReadBudgetMs: 250,
	/** Channels listed, in the channelizer's order; past it `channels.truncated` says so. */
	channelsMax: 64,
})

/**
 * One thread of the core process (Linux `/proc/self/task/<tid>/stat`). `name` is a closed set: the
 * kernel's short name for Node's threads and the workers the core names, `spectrum-worker` for a
 * spectrum worker of any source, and `other` for everything else.
 */
export interface DiagnosticsThread {
	tid: number
	name: string
	/** CPU since this thread started, in seconds. */
	cpuSeconds: number
	/** Average cores over `process.windowMs`; null when the previous sample did not read this thread. */
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
	/** The loop meter's readings, in ms; null when this core does not expose its meter or it failed. */
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
	/** The whole container with every decoder process in it, in cores; null outside a container or if it failed. */
	containerCpuCores: number | null
	/**
	 * Null off Linux, when the thread list cannot be read, when the list did not arrive in time, or
	 * while an earlier sample's read is still hung (`threadsTimedOut` tells those last two apart).
	 */
	threads: {
		rows: DiagnosticsThread[]
		truncated: boolean
	} | null
	/** The thread reads did not finish in time: `threads` is null, or partial with `truncated`. */
	threadsTimedOut: boolean
	/** Null when no channelizer is composed in this core or its list could not be read. */
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
		threadsTimedOut: { type: "boolean" },
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
