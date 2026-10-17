import type {
	StationField,
	StationIdentity,
	StationProvenance,
	BandRegion,
} from "@wavekit/api-types"
import {
	DCS_STANDARD_CODES,
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_TONE_SQUELCH_MODULATIONS,
	SPECTRUM_SUMMARY_BINS_MAX,
	toneSchema,
} from "@wavekit/api-types"
import { CTCSS_HZ } from "./core/audio-tones/ctcss.js"
import { readFileSync, existsSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { ConfigValidationError, WaveKitError } from "./utils/errors.js"
import {
	AccessRuntimeConfigSchema,
	validateProtectedRuntimeMapping,
} from "./access/runtime-config.js"
import {
	CSDR_BUFFER_MAX_ELEMENTS,
	CSDR_BUFFER_MIN_ELEMENTS,
} from "./decoders/csdr-buffers.js"
import { BAND_REGIONS } from "./decoders/band-region.js"

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for source capabilities (Requirements 15.4, 16.1).
 * Declares what kind of data a source provides.
 */
export const SourceCapsSchema = z.object({
	kind: z.enum(["audio_pcm", "iq", "recording"]),
	sampleRate: z.number().int().positive(),
	format: z.enum(["S16LE", "FLOAT32LE", "U8_IQ", "S16_IQ", "auto"]),
	channels: z.number().int().positive().optional(),
	centerFreq: z.number().positive().optional(),
	exclusive: z.boolean().default(false),
})

/**
 * Per-source scanner role (signal discovery spec § 10.7). "dedicated"
 * sources are never the default source for unsourced decoders.
 */
export const SourceScannerConfigSchema = z.object({
	role: z.enum(["shared", "dedicated"]).default("shared"),
	passive: z.boolean().default(true),
})

/**
 * WG11 req 4.1: the receiver gain this rtl_tcp source should come up with, written on every new
 * connection unless the REST API or the relay set a value in this process. `manual` needs
 * `gainDb` (0 to 50 dB, 0.1 dB steps); `agc` refuses it. `agcMode` is the RTL2832 digital AGC.
 */
export const SourceTunerConfigSchema = z
	.object({
		gainMode: z.enum(["manual", "agc"]),
		gainDb: z
			.number()
			.finite()
			.min(0)
			.max(50)
			.refine(
				v => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6,
				"gainDb must be a multiple of 0.1 dB",
			)
			.optional(),
		agcMode: z.boolean().optional(),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.gainMode === "manual" && v.gainDb === undefined)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["gainDb"],
				message: "gainDb is required when gainMode is manual",
			})
		if (v.gainMode === "agc" && v.gainDb !== undefined)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["gainDb"],
				message: "gainDb is not allowed when gainMode is agc",
			})
	})

/**
 * Schema for SDR source configuration.
 * Supports rtl_tcp, SDR++ network sink, and recording sources.
 */
export const SourceConfigSchema = z.object({
	id: z.string().min(1),
	type: z.enum(["sdrpp-network", "rtl_tcp", "recording"]),
	host: z.string().min(1).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	filePath: z.string().optional(), // For recording sources
	loop: z.boolean().default(false), // For recording sources
	playbackSpeed: z.number().positive().default(1.0), // For recording sources
	caps: SourceCapsSchema,
	/**
	 * Stall watchdog (rtl_tcp U8_IQ sources only): once a session has streamed,
	 * a payload gap this long drops the connection and reconnects. Default
	 * 15000; 0 disables. Ignored for recordings, SDR++ network sources and other
	 * rtl_tcp formats.
	 */
	stallTimeoutMs: z
		.union([z.literal(0), z.number().int().min(1000).max(600_000)])
		.optional(),
	/** Optional SDR host endpoint for resource monitoring (per-source) */
	sdrHost: z
		.object({
			/** URL to wavekit-sdr-host API (e.g., "http://192.168.1.50:8080") */
			apiUrl: z.string().url().optional(),
			/** URL to rtlmux stats endpoint (e.g., "http://192.168.1.50:5556/stats.json") */
			rtlmuxStatsUrl: z.string().url().optional(),
			/**
			 * Receiver endpoint selection (rtl_tcp only). `auto` moves the IQ
			 * connection to a better address that this sdr-host itself lists
			 * (for example its Ethernet address), after verifying it; omitted or
			 * `off` keeps the configured host. See docs/specs/receiver-endpoints.
			 */
			endpointSelection: z.enum(["auto", "off"]).optional(),
		})
		.optional(),
	/** Scanner role and passive discovery for this source (default shared, passive). */
	scanner: SourceScannerConfigSchema.optional(),
	/** WG11: configured gain written on connect (rtl_tcp only; absent: nothing is written). */
	tuner: SourceTunerConfigSchema.optional(),
})

/**
 * Schema for decoder capabilities (Requirements 17.1, 17.2, 17.3, 17.4).
 * Declares what input/output a decoder supports and its integration pattern.
 */
export const DecoderCapsSchema = z.object({
	/** Input type the decoder accepts */
	input: z.enum(["audio_pcm", "iq", "external"]),
	/** Whether the decoder requires exclusive access to its source */
	wantsExclusiveSource: z.boolean().optional(),
	/** Preferred sample rates for this decoder */
	preferredSampleRates: z.array(z.number().int().positive()).optional(),
	/** Output format produced by the decoder */
	output: z.enum(["jsonl", "nmea", "beast", "text"]),
	/** Integration pattern for this decoder */
	integrationPattern: z.enum([
		"pure_consumer",
		"network_producer",
		"external_sdr",
	]),
})

export { BAND_REGIONS }

/** Band plan region code; case-insensitive in YAML and env. */
export const RegionSchema = z.preprocess(
	v => (typeof v === "string" ? v.toUpperCase() : v),
	z.enum(BAND_REGIONS),
)
const HzSchema = z.number().finite().positive()
const BandRangeSchema = z
	.object({ minHz: HzSchema, maxHz: HzSchema })
	.strict()
	.refine(r => r.minHz <= r.maxHz, "minHz must not exceed maxHz")

/**
 * Operator band override (config `decoders[].band` and
 * `PUT /api/decoders/:id/band`); at least one key.
 */
export const DecoderBandOverrideSchema = z
	.object({
		rangesHz: z.array(BandRangeSchema).min(1).max(32).optional(),
		targetsHz: z.array(HzSchema).min(1).max(64).optional(),
		region: RegionSchema.optional(),
		bandSuspension: z.boolean().optional(),
	})
	.strict()
	.refine(
		o => Object.keys(o).length > 0,
		"empty band override; omit it or DELETE",
	)

/**
 * Schema for decoder configuration.
 * Each decoder has a type that maps to a registered factory.
 * Supports all three integration patterns: pure_consumer, network_producer, external_sdr.
 * Requirements: 17.1, 17.2, 17.3, 17.4
 */
export const DecoderConfigSchema = z.object({
	id: z.string().min(1),
	type: z.string().min(1),
	enabled: z.boolean(),
	/** Which source to attach to (for pure_consumer decoders) */
	sourceId: z.string().min(1).optional(),
	options: z.record(z.unknown()),
	// For external SDR decoders (external_sdr pattern)
	/** Device serial number for external SDR decoders */
	deviceSerial: z.string().optional(),
	/** Frequencies to monitor (Hz) for external SDR decoders */
	frequencies: z.array(z.number().positive()).optional(),
	/** Gain setting for external SDR decoders */
	gain: z.number().optional(),
	/** PPM correction for external SDR decoders */
	ppm: z.number().optional(),
	// For network producer decoders (network_producer pattern)
	/** Host to connect to for network producer output */
	outputHost: z.string().optional(),
	/** Port to connect to for network producer output */
	outputPort: z.number().int().min(1).max(65535).optional(),
	/** Protocol for network producer output */
	outputProtocol: z.enum(["tcp", "udp"]).optional(),
	// Version pinning (Requirement 27.1, 27.2, 27.3)
	/** Minimum required version for this decoder */
	minVersion: z.string().optional(),
	/** Maximum allowed version for this decoder */
	maxVersion: z.string().optional(),
	/** Route this instance through the core channelizer (addendum §7) */
	useChannelizer: z.boolean().default(false),
	/**
	 * Band admission override (band defaults spec §3): where this decoder is
	 * useful. Never changes the process arguments.
	 */
	band: DecoderBandOverrideSchema.optional(),
})

/**
 * Schema for audio output configuration.
 */
export const AudioConfigSchema = z.object({
	tcpPort: z.number().int().min(1).max(65535).default(8080),
	format: z.enum(["S16LE", "FLOAT32LE"]).default("S16LE"),
	sampleRate: z.number().int().positive().default(48000),
	monitoring: z.boolean().default(false),
})

/**
 * Schema for tuner relay configuration (RTL-TCP compatible server).
 */
export const TunerRelayConfigSchema = z.object({
	enabled: z.boolean().default(false),
	host: z.string().default("0.0.0.0"),
	port: z.number().int().min(1).max(65535).default(1234),
	/** Source ID to expose (defaults to primary source if omitted) */
	sourceId: z.string().min(1).optional(),
	/** Control policy for client commands */
	controlPolicy: z.enum(["exclusive", "shared"]).default("exclusive"),
	/** Max number of connected clients (optional cap) */
	maxClients: z.number().int().positive().optional(),
	/** Command history entries to retain (0 disables history) */
	commandHistoryLimit: z.number().int().min(0).max(10000).default(200),
})

/**
 * Schema for tuner control behaviour (shared by the tuner API and relay).
 */
export const TunerConfigSchema = z.object({
	/**
	 * On rtl_tcp reconnect: "restore" re-sends the last accepted tuner state;
	 * "reset" sends nothing and resets tuner state/source caps to the configured
	 * baseline (use when another operator may own the receiver after an outage).
	 */
	reconnectPolicy: z.enum(["restore", "reset"]).default("restore"),
})

const LIVE_AUDIO_AGC_MODES_TUPLE = ["off", "slow", "fast"] as const

/**
 * Schema for live demodulation configuration.
 */
export const LiveDemodConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		sourceId: z.string().optional(),
		httpPort: z.number().int().min(1).max(65535).default(8081),
		modulation: z
			.enum(["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"])
			.default("nfm"),
		bandwidth: z.number().int().min(0).default(12500),
		/**
		 * Squelch threshold in dBFS (negative) of channel power measured before
		 * demodulation (|IQ| = 1 is 0 dBFS). 0 disables squelch (open).
		 */
		squelch: z.number().min(-160).max(0).default(0),
		/**
		 * manual: `squelch` is the threshold; auto: noise-floor estimate + `autoMarginDb`;
		 * WG7 noise (NFM/WFM): FM discriminator quieting of at least `noiseQuietingDb`.
		 */
		squelchMode: z.enum(["manual", "auto", "noise"]).optional(),
		autoMarginDb: z.number().finite().min(0).max(40).optional(),
		/** WG7: noise squelch quieting threshold in dB (runtime default 6). */
		noiseQuietingDb: z
			.number()
			.finite()
			.min(LIVE_AUDIO_NOISE_QUIETING_DB.min)
			.max(LIVE_AUDIO_NOISE_QUIETING_DB.max)
			.optional(),
		/** WG7: tone squelch gate (NFM only); absent or `none` = no tone gate. */
		toneSquelch: toneSchema.optional(),
		noiseReduction: z
			.enum(["off", "voice", "noaa-apt", "narrow-band"])
			.default("off"),
		lowPass: z.number().int().min(0).max(20000).default(0),
		highPass: z.number().int().min(0).max(5000).default(0),
		/**
		 * Audio gain after demodulation. For FM, CSDR's discriminator gives full
		 * scale at a deviation of half the demod rate (12.5 kHz at 25 kHz), so 2
		 * puts ±5 kHz deviation at 0.8 full scale. The former default of 10
		 * hard-clipped NFM noise and voice.
		 */
		gain: z.number().min(0.1).max(100).default(2.0),
		deEmphasis: z.boolean().default(false),
		deEmphasisTau: z.union([z.literal(50), z.literal(75)]).default(50),
		audioFormat: z.enum(["s16le", "f32le"]).default("s16le"),
		/**
		 * Deprecated, accepted for compatibility and ignored. `csdr dcblock` is
		 * real-only: on interleaved I/Q it mixed I and Q. Use offsetHz to move
		 * the channel away from the receiver's DC spike instead.
		 */
		iqDcBlock: z.boolean().default(false),
		/**
		 * Channel offset from the tuned centre in Hz: a carrier at
		 * centre + offsetHz is shifted to DC before decimation. 0 demodulates
		 * at the tuned centre.
		 */
		offsetHz: z.number().finite().min(-10_000_000).max(10_000_000).default(0),
		/**
		 * WG4: post-demodulation AGC. Absent (no default) keeps the modulation
		 * default: AM, CW, DSB, USB and LSB `fast`; NFM, WFM and raw none.
		 */
		agc: z.enum(LIVE_AUDIO_AGC_MODES_TUPLE).optional(),
	})
	.superRefine((value, ctx) => {
		if (value.modulation !== "raw" && value.bandwidth <= 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "bandwidth must be greater than 0 for non-raw modulation",
				path: ["bandwidth"],
			})
		}
		// WG7 req 2.3, 3.1: noise squelch is FM-only, tone squelch NFM-only, standard tones only.
		if (
			value.squelchMode === "noise" &&
			!LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(value.modulation)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "noise squelch requires nfm or wfm modulation",
				path: ["squelchMode"],
			})
		}
		const tone = value.toneSquelch
		if (tone !== undefined && tone.kind !== "none") {
			if (!LIVE_AUDIO_TONE_SQUELCH_MODULATIONS.includes(value.modulation))
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "tone squelch requires nfm modulation",
					path: ["toneSquelch"],
				})
			const standard =
				tone.kind === "ctcss"
					? (CTCSS_HZ as readonly number[]).some(
							hz => Math.round(hz * 10) === tone.frequencyTenthsHz,
						)
					: DCS_STANDARD_CODES.includes(tone.code)
			if (!standard)
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "tone squelch requires a standard CTCSS tone or DCS code",
					path: ["toneSquelch"],
				})
		}
	})

/**
 * Digital voice audio is on by default: dsd-fme `-o udp` measured +0.2 %
 * of one core over `-o null` (docs/DIGITAL-VOICE.md). Flip this one value
 * to change the default.
 */
export const DIGITAL_VOICE_ENABLED_DEFAULT = true

/**
 * Schema for the digital voice stream (decoded dsd-fme voice as PCM).
 * Applies to every configured dsd-fme decoder whose options leave `output`
 * unset (or "udp" without a port).
 */
export const DigitalVoiceConfigSchema = z
	.object({
		enabled: z.boolean().default(DIGITAL_VOICE_ENABLED_DEFAULT),
		httpPort: z.number().int().min(1).max(65535).default(8082),
		/** TDMA slots to synthesise (dsd-fme -V); a decoder's own voiceSlot option wins. */
		voiceSlot: z
			.preprocess(
				value => (value === "1" ? 1 : value === "2" ? 2 : value),
				z.union([z.literal(1), z.literal(2), z.literal("both")]),
			)
			.default("both"),
		/** Voice buffered (or waited for) before a burst plays: absorbs UDP burstiness. */
		jitterBufferMs: z.number().int().min(0).max(2000).default(400),
		/** Bound on queued voice per stream; the oldest is dropped beyond it. */
		maxBufferMs: z.number().int().min(100).max(10_000).default(1000),
	})
	.refine(value => value.maxBufferMs >= value.jitterBufferMs, {
		message: "maxBufferMs must be at least jitterBufferMs",
		path: ["maxBufferMs"],
	})

/**
 * Schema for API server configuration.
 */
export const ApiConfigSchema = z.object({
	host: z.string().default("0.0.0.0"),
	port: z.number().int().min(1).max(65535).default(3000),
})

/**
 * Schema for logging configuration.
 */
export const LoggingConfigSchema = z.object({
	level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
	dir: z.string().optional(),
})

/**
 * Schema for health monitoring configuration (Requirements 20.1, 20.2, 20.3, 20.4).
 * Configures how decoder health is monitored and when state transitions occur.
 */
export const HealthConfigSchema = z.object({
	/** Interval in milliseconds between health checks (default: 5000ms) */
	checkInterval: z.number().int().positive().default(5000),
	/** Milliseconds without output before a decoder is considered idle (default: 30000ms) */
	idleTimeout: z.number().int().positive().default(30000),
	/**
	 * Consecutive unstable runs (no output and under 30 s) before a decoder is
	 * reported "faulted" while retries continue (manager default: 5).
	 */
	faultAfterFailures: z.number().int().positive().optional(),
	/**
	 * Suspend wanted decoders whose target frequencies are all outside the
	 * tuned window, resuming on a retune back (manager default: true).
	 */
	bandSuspension: z.boolean().optional(),
	/**
	 * Signal-flat warning on IQ network sources: the subsampled IQ level
	 * (RMS about zero, dBFS) must stay below this for signalFlatHoldMs
	 * (source manager default: -40, about 1.3 LSB RMS in u8).
	 */
	signalFlatThresholdDbfs: z.number().min(-120).max(0).optional(),
	/** How long the level must stay low (and, to clear, recovered) (default: 30000). */
	signalFlatHoldMs: z.number().int().min(1000).max(3_600_000).optional(),
})

/**
 * Schema for resource monitoring configuration.
 * Controls container metrics, SDR host polling, and backpressure tracking.
 */
export const ResourcesConfigSchema = z.object({
	/** Enable resource monitoring (default: true) */
	enabled: z.boolean().default(true),
	/** Container resource monitoring (cgroups) */
	containerMonitor: z
		.object({
			/** Enable container resource monitoring (default: true) */
			enabled: z.boolean().default(true),
			/** Poll interval in milliseconds (default: 2000) */
			pollIntervalMs: z.number().int().positive().default(2000),
		})
		.default({}),
	/** SDR host status polling */
	sdrHostPoller: z
		.object({
			/** Enable SDR host polling (default: true) */
			enabled: z.boolean().default(true),
			/** Poll interval in milliseconds (default: 3000) */
			pollIntervalMs: z.number().int().positive().default(3000),
			/** HTTP request timeout in milliseconds (default: 2000) */
			timeoutMs: z.number().int().positive().default(2000),
		})
		.default({}),
	/** Broadcast interval for WebSocket updates (default: 2000ms) */
	broadcastIntervalMs: z.number().int().positive().default(2000),
})

/**
 * Schema for CSDR DSP stage tuning.
 * `boundedBuffers` caps the per-process ring of harness-validated streaming
 * stages (see src/decoders/csdr-buffers.ts); false keeps upstream rings.
 * Default on since 2026-10-09: an overnight interleaved real-RF A/B showed
 * 0% fanout loss and ~18 MiB shmem bounded versus ~1% loss and ~5 GiB upstream.
 * Limits mirror the native WAVEKIT_CSDR_BUFFER_ELEMENTS validation.
 */
export const CsdrConfigSchema = z.object({
	/** Enable bounded rings for validated stages (default: true; false = upstream) */
	boundedBuffers: z.boolean().default(true),
	/** Ring size in input elements for bounded stages */
	bufferElements: z
		.number()
		.int()
		.min(CSDR_BUFFER_MIN_ELEMENTS)
		.max(CSDR_BUFFER_MAX_ELEMENTS)
		.default(65536),
})

/**
 * Opt-in core channelizer (addendum §6). Off by default: every pipeline stays
 * byte-identical. One supervised wavekit-chan process per source.
 * usableFraction and blockSamples mirror the wavekit-chan argument validation.
 */
export const ChannelizerConfigSchema = z.object({
	enabled: z.boolean().default(false),
	binaryPath: z.string().min(1).default("wavekit-chan"),
	socketDir: z.string().min(1).default("/var/run/wavekit/chan"),
	usableFraction: z.number().min(0.5).max(0.95).default(0.8),
	channelQueueMs: z.number().int().min(50).max(2000).default(250),
	inputHighWaterMark: z
		.number()
		.int()
		.min(65_536)
		.max(16 * 1024 * 1024)
		.default(262_144),
	blockSamples: z
		.number()
		.int()
		.min(256)
		.max(1 << 20)
		.default(16_384),
})

const POWER_OF_TWO_FFT = z
	.number()
	.int()
	.min(512)
	.max(16384)
	.refine(n => (n & (n - 1)) === 0, "fftSize must be a power of two")

/**
 * Signal discovery scanner (spec § 12.3). Every key has a default, so an
 * absent section enables the scanner with passive in-window discovery.
 */
export const ScannerConfigSchema = z
	.object({
		enabled: z.boolean().default(true),
		/** Config-only channel-tier admission; excluded from mutable scanner settings. */
		channelTier: z
			.object({
				enabled: z.boolean().default(false),
				minMs: z.number().int().min(300).max(2000).default(500),
			})
			.default({}),
		passive: z
			.object({
				enabled: z.boolean().default(true),
				/** Pre-channelizer offset probes for passive jobs (each costs a full-rate chain). */
				offsetProbes: z.boolean().default(false),
				/**
				 * WG11 req 2.1: passive is disabled above this spectrum engine utilization (fraction of
				 * one core). Config only; absent means 0.25, so the parsed config is unchanged.
				 */
				maxEngineUtilization: z.number().finite().min(0.05).max(1).optional(),
			})
			.default({}),
		cpuBudgetCores: z.number().finite().min(0.1).max(64).default(1),
		cpuGuardPercent: z.number().finite().min(1).max(100).default(90),
		maxProbes: z
			.object({
				offset: z.number().int().min(0).max(16).default(1),
				channel: z.number().int().min(0).max(64).default(4),
			})
			.default({}),
		ringSeconds: z.number().finite().min(0.5).max(30).default(3),
		detection: z
			.object({
				fftSize: z.union([z.literal("auto"), POWER_OF_TWO_FFT]).default("auto"),
				integrationMs: z.number().finite().min(5).max(1000).default(50),
				sensitivity: z.enum(["low", "normal", "high"]).default("normal"),
				faTargetPerMhzMin: z.number().finite().min(0.01).max(1000).default(1),
				dcGuardHz: z.number().finite().min(0).max(100_000).default(1500),
				ppmMargin: z.number().finite().min(0).max(100).default(2),
				clipFraction: z.number().finite().min(1e-6).max(1).default(0.001),
				hysteresisDb: z.number().finite().min(0).max(20).default(3),
				minSurfaceBlocks: z.number().int().min(1).max(20).default(2),
				/** Short-burst path (§ 4.10); null disables it. */
				shortIntegrationMs: z.number().positive().nullable().default(5),
				/** FFT frame overlap (§ 4.2): 0 or 0.5. */
				overlap: z.union([z.literal(0), z.literal(0.5)]).default(0),
			})
			.default({}),
		sweep: z
			.object({
				markers: z.boolean().default(true),
				markerTimeoutMs: z.number().int().min(100).max(10_000).default(2000),
				pllSettleMs: z.number().finite().min(0).max(100).default(5),
				settleMs: z
					.object({
						local: z.number().int().min(0).max(10_000).default(300),
						network: z.number().int().min(0).max(10_000).default(1000),
					})
					.default({}),
				revisitShare: z.number().finite().min(0).max(0.9).default(0.3),
			})
			.default({}),
		hold: z
			.object({
				maxHoldMs: z.number().int().min(1000).max(600_000).default(60_000),
				hangMs: z.number().int().min(0).max(60_000).default(2000),
				preRollMs: z.number().int().min(0).max(10_000).default(300),
			})
			.default({}),
		storage: z
			.object({
				/** null: `<stateDir>/scanner` (resolved by the scanner service). */
				dir: z.string().min(1).nullable().default(null),
				maxRecordingsMb: z.number().int().min(1).max(1_000_000).default(512),
				maxEvidenceMb: z.number().int().min(1).max(100_000).default(64),
				maxJournalMb: z.number().int().min(1).max(10_000).default(64),
				maxAgeDays: z.number().int().min(1).max(3650).default(30),
				discoveryMaxAgeDays: z.number().int().min(1).max(3650).default(180),
				minFreeDiskMb: z.number().int().min(0).max(1_000_000).default(2048),
				maxDiscoveries: z.number().int().min(1).max(1_000_000).default(10_000),
				/** Burst IQ captures (Task 34a). */
				maxCapturesMb: z.number().int().min(1).max(100_000).default(256),
			})
			.default({}),
		ws: z
			.object({
				maxMessagesPerSecond: z.number().int().min(1).max(100).default(10),
				/** `spectrum` WS feed (§ 12.2): frame rate and bins of the default profile. */
				spectrumHz: z.number().finite().min(0.5).max(25).default(10),
				spectrumBins: z.number().int().min(128).max(2048).default(512),
				/** Engine summary-detail budget: block-summary bins per source (config only; never per client, never PATCHed). */
				spectrumSummaryBins: z
					.number()
					.int()
					.min(512)
					.max(SPECTRUM_SUMMARY_BINS_MAX)
					.default(2048),
				/** Distinct active non-default spectrum profiles over all sources (config only). */
				spectrumMaxProfiles: z.number().int().min(1).max(16).default(4),
				/**
				 * WG8 req 5.2: host cap on summary and client bins (config only). Absent or "auto"
				 * measures the host once at startup (floor 2048, ceiling 8192); no default is
				 * filled in, so the parsed config and its export stay as before. Clients get at most
				 * min(cap, spectrumSummaryBins) bins; the default profile stays within spectrumBins.
				 */
				spectrumBinsCap: z
					.union([
						z.literal("auto"),
						z.literal(2048),
						z.literal(4096),
						z.literal(8192),
					])
					.optional(),
			})
			.default({}),
		/**
		 * WG11 req 6.1: narrowband IQ capture on detection, replayed into identify. Config only,
		 * protected access mode only; absent means off, so the parsed config is unchanged.
		 */
		iqCapture: z
			.object({
				enabled: z.boolean().default(false),
				/** Total capture storage (IQ_CAPTURE_TOTAL_MAX_BYTES = 256 MiB at most). */
				maxTotalMb: z.number().int().min(16).max(256).default(256),
				/** One capture, pre-roll included (IQ_CAPTURE_MAX_MS). */
				maxCaptureMs: z.number().int().min(500).max(4000).default(4000),
				/** Pre-roll before the track start (IQ_CAPTURE_PREROLL_MAX_MS, the native ring). */
				preRollMs: z.number().int().min(0).max(2000).default(500),
				binaryPath: z.string().min(1).default("wavekit-iqcap"),
			})
			.strict()
			.optional(),
	})
	.superRefine((value, ctx) => {
		if (value.hold.preRollMs > value.ringSeconds * 1000) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["hold", "preRollMs"],
				message: `preRollMs ${value.hold.preRollMs} exceeds the IQ ring (ringSeconds ${value.ringSeconds})`,
			})
		}
	})

/** The source's scanner role with defaults applied. */
export function sourceScannerConfig(
	source: Pick<SourceConfig, "scanner">,
): SourceScannerConfig {
	return source.scanner ?? { role: "shared", passive: true }
}

/** ISO 3166-1 assigned alpha-2 codes; reserved/user-assigned codes are rejected. */
const stationCountries = new Set(
	"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
		" ",
	),
)
export const StationConfigSchema = z
	.object({
		name: z.string().trim().min(1).max(256).optional(),
		lat: z.number().finite().min(-90).max(90).optional(),
		lon: z.number().finite().min(-180).max(180).optional(),
		altM: z.number().finite().optional(),
		callsign: z.string().trim().min(1).max(128).optional(),
		country: z
			.string()
			.regex(/^[A-Z]{2}$/)
			.refine(value => stationCountries.has(value))
			.optional(),
	})
	.strict()

/** Operator ceilings. The bounded defaults (250 000 rows, 256 MiB, 3 days, 50/s) sit inside. */
const ACTIVITY_MAX_ROWS = 1_000_000_000
const ACTIVITY_MIN_DB_BYTES = 16 * 1024 * 1024
const ACTIVITY_MAX_DB_BYTES = 16 * 1024 * 1024 * 1024 * 1024
const ACTIVITY_MAX_AGE_MS = 10 * 366 * 24 * 60 * 60 * 1000
const ACTIVITY_MAX_GLOBAL_PER_SECOND = 1_000_000
const ACTIVITY_MAX_GLOBAL_BURST = 10_000_000
const ACTIVITY_MAX_DECODER_PER_SECOND = 100_000
const ACTIVITY_MAX_DECODER_BURST = 1_000_000

export const ActivityRetentionConfigSchema = z
	.object({
		maxRows: z.number().int().min(1000).max(ACTIVITY_MAX_ROWS).optional(),
		maxDbBytes: z
			.number()
			.int()
			.min(ACTIVITY_MIN_DB_BYTES)
			.max(ACTIVITY_MAX_DB_BYTES)
			.optional(),
		maxAgeMs: z.number().int().positive().max(ACTIVITY_MAX_AGE_MS).optional(),
		/**
		 * Which rows the row and byte caps remove (web-gaps-3 req 1.1). Omitted keeps the
		 * store default (`fair-share`). Age pruning is the same under both.
		 */
		policy: z.enum(["fair-share", "oldest-first"]).optional(),
	})
	.strict()

export const ActivityAdmissionConfigSchema = z
	.object({
		globalPerSecond: z
			.number()
			.int()
			.positive()
			.max(ACTIVITY_MAX_GLOBAL_PER_SECOND)
			.optional(),
		globalBurst: z
			.number()
			.int()
			.positive()
			.max(ACTIVITY_MAX_GLOBAL_BURST)
			.optional(),
		perDecoderPerSecond: z
			.number()
			.int()
			.positive()
			.max(ACTIVITY_MAX_DECODER_PER_SECOND)
			.optional(),
		perDecoderBurst: z
			.number()
			.int()
			.positive()
			.max(ACTIVITY_MAX_DECODER_BURST)
			.optional(),
	})
	.strict()

/**
 * Persistent activity store. On by default with bounded limits; an explicit
 * `enabled: false` means no database file and no worker. Retention and
 * admission stay unset here: every omitted field resolves to
 * ACTIVITY_LIMIT_DEFAULTS in the store.
 */
export const ActivityConfigSchema = z
	.object({
		enabled: z.boolean().default(true),
		retention: ActivityRetentionConfigSchema.optional(),
		admission: ActivityAdmissionConfigSchema.optional(),
	})
	.strict()

/** Main configuration schema (Requirements: 12.5, 15.4, 17.1–17.4). */
export const ConfigSchema = z
	.object({
		sources: z.array(SourceConfigSchema).default([]),
		decoders: z.array(DecoderConfigSchema).default([]),
		audio: AudioConfigSchema.default({}),
		tunerRelay: TunerRelayConfigSchema.default({}),
		tuner: TunerConfigSchema.default({}),
		liveDemod: LiveDemodConfigSchema.optional(),
		digitalVoice: DigitalVoiceConfigSchema.optional(),
		api: ApiConfigSchema.default({}),
		access: AccessRuntimeConfigSchema,
		logging: LoggingConfigSchema.default({}),
		health: HealthConfigSchema.optional(),
		resources: ResourcesConfigSchema.default({}),
		csdr: CsdrConfigSchema.default({}),
		channelizer: ChannelizerConfigSchema.default({}),
		/** Signal discovery scanner (spec § 12.3); on by default. */
		scanner: ScannerConfigSchema.default({}),
		/**
		 * Band plan region for built-in band defaults (EU, US, CA, AU, NZ, JP, CN;
		 * case-insensitive). Absent: guessed from TZ / locale, else EU.
		 */
		region: RegionSchema.optional(),
		station: StationConfigSchema.default({}),
		/**
		 * Persistent activity store under stateDir. On by default with bounded
		 * retention and admission; `activity: { enabled: false }` turns it off.
		 */
		activity: ActivityConfigSchema.default({}),
		/**
		 * Directory for runtime state (API band overrides). Relative paths
		 * resolve against the process working directory.
		 */
		stateDir: z.string().min(1).default("data"),
	})
	.superRefine((config, ctx) => {
		if (config.access.mode === "protected") {
			try {
				validateProtectedRuntimeMapping(config.access, config.api, {
					analog: LiveDemodConfigSchema.parse(config.liveDemod ?? {}).httpPort,
					digital: DigitalVoiceConfigSchema.parse(config.digitalVoice ?? {})
						.httpPort,
				})
			} catch {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["access"],
					message: "Invalid access configuration",
				})
			}
		}
		if (
			config.tunerRelay.enabled &&
			config.tunerRelay.sourceId === undefined &&
			!config.sources.some(
				source => sourceScannerConfig(source).role === "shared",
			)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["tunerRelay", "sourceId"],
				message:
					"Select an explicit configured relay source or configure a shared source",
			})
		}
		// The relay starts before sources connect, so validate its explicit
		// selection against configured identities rather than runtime status.
		if (
			config.tunerRelay.enabled &&
			config.tunerRelay.sourceId &&
			!config.sources.some(s => s.id === config.tunerRelay.sourceId)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["tunerRelay", "sourceId"],
				message: `Tuner relay source '${config.tunerRelay.sourceId}' is not configured`,
			})
		}
		// Spec § 10.7: decoders without sourceId use the default source, which
		// is never a dedicated scanner source.
		if (config.sources.length === 0) return
		if (!config.sources.every(s => sourceScannerConfig(s).role === "dedicated"))
			return
		// A decoder that names its own dongle (top-level deviceSerial for
		// external-SDR decoders, options.deviceSerial for readsb/ais-catcher)
		// never uses the default source.
		const unsourced = config.decoders.filter(
			d =>
				d.enabled &&
				d.sourceId === undefined &&
				d.deviceSerial === undefined &&
				d.options["deviceSerial"] === undefined,
		)
		if (unsourced.length === 0) return
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["sources"],
			message: `Every source is scanner.role "dedicated", but decoders ${unsourced.map(d => d.id).join(", ")} have no sourceId; give them a sourceId or make one source shared`,
		})
	})

// ============================================================================
// Type Exports
// ============================================================================

export type SourceCaps = z.infer<typeof SourceCapsSchema>
export type SourceConfig = z.infer<typeof SourceConfigSchema>
export type SourceTunerConfig = z.infer<typeof SourceTunerConfigSchema>
export type DecoderCaps = z.infer<typeof DecoderCapsSchema>
export type DecoderConfig = z.infer<typeof DecoderConfigSchema>
export type AudioConfig = z.infer<typeof AudioConfigSchema>
export type TunerRelayConfig = z.infer<typeof TunerRelayConfigSchema>
export type LiveDemodConfig = z.infer<typeof LiveDemodConfigSchema>
export type DigitalVoiceConfig = z.infer<typeof DigitalVoiceConfigSchema>
export type ApiConfig = z.infer<typeof ApiConfigSchema>
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>
export type HealthConfig = z.infer<typeof HealthConfigSchema>
export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>
export type CsdrConfig = z.infer<typeof CsdrConfigSchema>
export type ChannelizerConfig = z.infer<typeof ChannelizerConfigSchema>
export type SourceScannerConfig = z.infer<typeof SourceScannerConfigSchema>
export type ScannerConfig = z.infer<typeof ScannerConfigSchema>
export type ActivityRetentionConfig = z.infer<
	typeof ActivityRetentionConfigSchema
>
export type ActivityAdmissionConfig = z.infer<
	typeof ActivityAdmissionConfigSchema
>
export type ActivityConfig = z.infer<typeof ActivityConfigSchema>
export type Config = z.infer<typeof ConfigSchema>

// ============================================================================
// Environment Variable Mapping
// ============================================================================

/**
 * Prefix for all WaveKit environment variables.
 * Requirements: 5.1
 */
const ENV_PREFIX = "WAVEKIT_"

/**
 * Separator for nested keys in environment variables.
 * Example: WAVEKIT_API__PORT maps to config.api.port
 * Requirements: 5.1
 */
const NESTED_KEY_SEPARATOR = "__"

/**
 * Legacy environment variable mappings for backward compatibility.
 * These use single underscore format (e.g., WAVEKIT_API_PORT).
 * Format: ENV_VAR_NAME -> config.path.to.value
 */
const LEGACY_ENV_MAPPINGS: Record<
	string,
	{ path: string[]; type: "string" | "number" | "boolean" }
> = {
	WAVEKIT_API_HOST: { path: ["api", "host"], type: "string" },
	WAVEKIT_API_PORT: { path: ["api", "port"], type: "number" },
	WAVEKIT_AUDIO_TCP_PORT: { path: ["audio", "tcpPort"], type: "number" },
	WAVEKIT_AUDIO_FORMAT: { path: ["audio", "format"], type: "string" },
	WAVEKIT_AUDIO_SAMPLE_RATE: { path: ["audio", "sampleRate"], type: "number" },
	WAVEKIT_LOG_LEVEL: { path: ["logging", "level"], type: "string" },
	WAVEKIT_LOG_DIR: { path: ["logging", "dir"], type: "string" },
	WAVEKIT_REGION: { path: ["region"], type: "string" },
	WAVEKIT_COUNTRY: { path: ["station", "country"], type: "string" },
	WAVEKIT_STATE_DIR: { path: ["stateDir"], type: "string" },
	WAVEKIT_ACTIVITY__ENABLED: { path: ["activity", "enabled"], type: "boolean" },
}

/**
 * Parses an environment variable value to the appropriate type.
 * Attempts to infer the type from the value if not explicitly specified.
 */
function parseEnvValue(
	value: string,
	type?: "string" | "number" | "boolean",
): unknown {
	// If type is explicitly specified, use it
	if (type) {
		switch (type) {
			case "number": {
				const num = Number(value)
				if (Number.isNaN(num)) {
					throw new Error(`Invalid number value: ${value}`)
				}
				return num
			}
			case "boolean":
				return value.toLowerCase() === "true" || value === "1"
			case "string":
			default:
				return value
		}
	}

	// Auto-detect type from value
	// Check for boolean
	if (value.toLowerCase() === "true" || value.toLowerCase() === "false") {
		return value.toLowerCase() === "true"
	}

	// Check for number (integer or float)
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		const num = Number(value)
		if (!Number.isNaN(num)) {
			return num
		}
	}

	// Default to string
	return value
}

/**
 * Sets a nested value in an object using a path array.
 */
function setNestedValue(
	obj: Record<string, unknown>,
	path: string[],
	value: unknown,
): void {
	let current = obj
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i]
		if (key === undefined) continue
		if (["__proto__", "constructor", "prototype"].includes(key)) return
		if (
			!Object.hasOwn(current, key) ||
			typeof current[key] !== "object" ||
			current[key] === null
		) {
			current[key] = {}
		}
		current = current[key] as Record<string, unknown>
	}
	const lastKey = path[path.length - 1]
	if (
		lastKey !== undefined &&
		!["__proto__", "constructor", "prototype"].includes(lastKey)
	) {
		current[lastKey] = value
	}
}

/**
 * Converts an environment variable name to a config path.
 * Uses double underscore (__) as separator for nested keys.
 *
 * Examples:
 *   WAVEKIT_API__PORT -> ["api", "port"]
 *   WAVEKIT_SOURCES__0__HOST -> ["sources", "0", "host"]
 *   WAVEKIT_DECODERS__0__ENABLED -> ["decoders", "0", "enabled"]
 *
 * Requirements: 5.1
 */
function envVarToConfigPath(envVar: string): string[] {
	// Remove the WAVEKIT_ prefix
	const withoutPrefix = envVar.slice(ENV_PREFIX.length)

	// Split by double underscore for nested keys
	const parts = withoutPrefix.split(NESTED_KEY_SEPARATOR)

	// Convert each part from SCREAMING_SNAKE_CASE to camelCase
	return parts.map(part => {
		// Split by single underscore and convert to camelCase
		const words = part.toLowerCase().split("_")
		return words
			.map((word, index) =>
				index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
			)
			.join("")
	})
}

/**
 * Parses all WAVEKIT_* environment variables and returns them as a config object.
 * Supports nested keys using double underscore separator.
 *
 * Requirements: 5.1
 */
export function parseEnvironmentVariables(): Record<string, unknown> {
	const result: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith(ENV_PREFIX) && value !== undefined && value !== "") {
			// Check if this is a legacy mapping first
			const legacyMapping = LEGACY_ENV_MAPPINGS[key]
			if (legacyMapping) {
				try {
					const parsedValue = parseEnvValue(value, legacyMapping.type)
					setNestedValue(result, legacyMapping.path, parsedValue)
				} catch {
					// Skip invalid env values - validation will catch them later
				}
			} else if (/^WAVEKIT_(SOURCES|DECODERS)_\d+_.+/.test(key)) {
				// Compatibility with the indexed form shown in older Docker examples.
				const indexed = /^WAVEKIT_(SOURCES|DECODERS)_(\d+)_(.+)$/.exec(key)!
				const path = envVarToConfigPath(
					`WAVEKIT_${indexed[1]}__${indexed[2]}__${indexed[3]}`,
				)
				setNestedValue(result, path, parseEnvValue(value))
			} else if (key.includes(NESTED_KEY_SEPARATOR)) {
				// Use new double-underscore format for nested keys
				try {
					const path = envVarToConfigPath(key)
					const parsedValue = parseEnvValue(
						value,
						key.startsWith("WAVEKIT_STATION__") &&
							["name", "callsign", "country"].includes(path[1] ?? "")
							? "string"
							: undefined,
					)
					setNestedValue(result, path, parsedValue)
				} catch {
					// Skip invalid env values - validation will catch them later
				}
			}
		}
	}

	const country = process.env["WAVEKIT_COUNTRY"]
	if (country !== undefined)
		setNestedValue(result, ["station", "country"], country)
	return result
}

/**
 * Applies environment variable overrides to the configuration object.
 * Environment variables take precedence over config file values.
 *
 * Requirements: 5.1, 5.3
 */
function applyEnvironmentOverrides(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const result = structuredClone(config)
	const envConfig = parseEnvironmentVariables()

	// Deep merge environment config into result
	deepMerge(result, envConfig, true)

	return result
}

/**
 * Deep merges source object into target object.
 * Source values override target values.
 */
function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
	indexedArrays = false,
): void {
	for (const [key, sourceValue] of Object.entries(source)) {
		if (["__proto__", "constructor", "prototype"].includes(key)) continue
		const targetValue = target[key]
		if (
			indexedArrays &&
			sourceValue !== null &&
			typeof sourceValue === "object" &&
			!Array.isArray(sourceValue) &&
			Array.isArray(targetValue)
		) {
			for (const [index, value] of Object.entries(sourceValue)) {
				if (
					!/^(0|[1-9]\d*)$/.test(index) ||
					Number(index) >= targetValue.length ||
					!Object.hasOwn(targetValue, index)
				) {
					throw new ConfigValidationError(
						z.ZodError.create([
							{
								code: z.ZodIssueCode.custom,
								path: [key, index],
								message:
									"Environment array overrides must select an existing numeric index in the YAML configuration",
							},
						]),
					)
				}
				const item = targetValue[Number(index)] as unknown
				if (
					item !== null &&
					typeof item === "object" &&
					!Array.isArray(item) &&
					value !== null &&
					typeof value === "object" &&
					!Array.isArray(value)
				) {
					deepMerge(
						item as Record<string, unknown>,
						value as Record<string, unknown>,
						true,
					)
				} else targetValue[Number(index)] = value
			}
			continue
		}

		if (
			sourceValue !== null &&
			typeof sourceValue === "object" &&
			!Array.isArray(sourceValue) &&
			targetValue !== null &&
			typeof targetValue === "object" &&
			!Array.isArray(targetValue)
		) {
			// Both are objects, merge recursively
			deepMerge(
				targetValue as Record<string, unknown>,
				sourceValue as Record<string, unknown>,
				indexedArrays,
			)
		} else {
			// Override with source value
			target[key] = sourceValue
		}
	}
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Default configuration paths.
 * In Docker, configs are mounted at /app/config.
 * For local development, use config/ directory.
 */
const CONFIG_PATHS = {
	/** Docker container config directory */
	dockerDir: "/app/config",
	/** Local development config directory */
	localDir: "config",
	/** Default config filename */
	defaultFile: "default.yaml",
	/** Custom config filename (merged on top of default) */
	customFile: "custom.yaml",
}

/**
 * Loads a YAML configuration file if it exists.
 * Returns an empty object if the file doesn't exist.
 *
 * @param filePath - Path to the YAML file
 * @returns Parsed configuration object or empty object
 * @throws ConfigValidationError if YAML parsing fails
 */
function loadYamlFile(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) {
		return {}
	}

	try {
		const fileContent = readFileSync(filePath, "utf-8")
		const parsed = parseYaml(fileContent) as unknown
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>
		}
		if (parsed === null || parsed === undefined) return {}
		throw new Error(
			"Configuration must be a YAML mapping, not a scalar or array",
		)
	} catch (error) {
		throw new ConfigValidationError(
			z.ZodError.create([
				{
					code: z.ZodIssueCode.custom,
					path: [],
					message: `Failed to parse YAML file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				},
			]),
		)
	}
}

/**
 * Determines the config directory to use.
 * Prefers Docker path (/app/config) if it exists, otherwise uses local path.
 *
 * Requirements: 5.2
 */
function getConfigDirectory(): string {
	if (existsSync(CONFIG_PATHS.dockerDir)) {
		return CONFIG_PATHS.dockerDir
	}
	return CONFIG_PATHS.localDir
}

/**
 * Loads configuration from multiple YAML files with merging.
 * Files are loaded in order: default.yaml, then custom.yaml (if exists).
 * Later files override earlier ones.
 *
 * Requirements: 5.2
 *
 * @param configDir - Directory containing config files
 * @returns Merged configuration object
 */
function loadConfigFiles(configDir: string): Record<string, unknown> {
	const defaultPath = `${configDir}/${CONFIG_PATHS.defaultFile}`
	const customPath = `${configDir}/${CONFIG_PATHS.customFile}`

	// Load default config as base
	const defaultConfig = loadYamlFile(defaultPath)

	// Load custom config if it exists
	const customConfig = loadYamlFile(customPath)

	// Merge custom on top of default
	const merged = structuredClone(defaultConfig)
	deepMerge(merged, customConfig)

	return merged
}

/**
 * Loads and validates configuration from YAML files with environment variable overrides.
 *
 * Configuration loading order (later sources override earlier):
 * 1. default.yaml from config directory
 * 2. custom.yaml from config directory (if exists)
 * 3. Environment variables (WAVEKIT_* prefix)
 *
 * Requirements:
 * - 5.1: Support configuration via environment variables with WAVEKIT_ prefix
 * - 5.2: Support configuration via mounted YAML files at /app/config
 * - 5.3: Environment variables take precedence over config files
 * - 5.4: Validate configuration on startup and fail fast with clear error messages
 * - 12.1: Load configuration from default YAML file
 * - 12.2: Override config values with environment variables
 * - 12.3: Validate configuration against Zod schema
 * - 12.4: Return descriptive validation errors
 * - 12.5: Support configuration for sources, decoders, audio output, API server, and logging
 *
 * @param configPath - Optional path to a specific configuration file (for testing/backward compatibility)
 * @returns Validated configuration object
 * @throws ConfigValidationError if configuration is invalid
 */
export function loadConfig(configPath?: string): Config {
	let rawConfig: Record<string, unknown>
	const selectedPath = configPath ?? process.env["WAVEKIT_CONFIG"]

	if (selectedPath) {
		if (!configPath && !existsSync(selectedPath)) {
			throw new ConfigValidationError(
				z.ZodError.create([
					{
						code: z.ZodIssueCode.custom,
						path: [],
						message: `WAVEKIT_CONFIG file does not exist: ${selectedPath}`,
					},
				]),
			)
		}
		// Legacy mode: load from specific file path
		rawConfig = loadYamlFile(selectedPath)
	} else {
		// New mode: load from config directory with merging
		const configDir = getConfigDirectory()
		rawConfig = loadConfigFiles(configDir)
	}

	// Apply environment variable overrides (Requirements: 5.1, 5.3)
	const configWithOverrides = applyEnvironmentOverrides(rawConfig)

	// Validate against schema (Requirements: 5.4, 12.3)
	const result = ConfigSchema.safeParse(configWithOverrides)

	if (!result.success) {
		if (result.error.issues.some(issue => issue.path[0] === "access"))
			throw new WaveKitError(
				"Invalid access configuration",
				"ACCESS_CONFIG_INVALID",
			)
		throw new ConfigValidationError(result.error)
	}

	const env = parseEnvironmentVariables()["station"]
	const provenance: Partial<
		Record<keyof Config["station"], StationConfigOrigin>
	> = {}
	for (const key of stationKeys) {
		if (result.data.station[key] !== undefined)
			provenance[key] =
				env !== null && typeof env === "object" && Object.hasOwn(env, key)
					? "env"
					: "yaml"
	}
	stationOriginMap.set(result.data, provenance)
	return result.data
}

/**
 * Validates a partial configuration object.
 * Useful for validating individual config sections.
 */
export function validateConfig(config: unknown): Config {
	const result = ConfigSchema.safeParse(config)
	if (!result.success) {
		if (result.error.issues.some(issue => issue.path[0] === "access"))
			throw new WaveKitError(
				"Invalid access configuration",
				"ACCESS_CONFIG_INVALID",
			)
		throw new ConfigValidationError(result.error)
	}
	return result.data
}

/**
 * Validates configuration and returns detailed validation results.
 * Useful for providing user feedback without throwing.
 *
 * Requirements: 5.4
 *
 * @param config - Configuration object to validate
 * @returns Object with success status and either data or formatted errors
 */
export function validateConfigSafe(config: unknown): {
	success: boolean
	data?: Config
	errors?: string[]
} {
	const result = ConfigSchema.safeParse(config)

	if (result.success) {
		return { success: true, data: result.data }
	}

	const errors = result.error.issues.map(issue => {
		if (issue.path[0] === "access")
			return "access: Invalid access configuration"
		const path = issue.path.length > 0 ? issue.path.join(".") : "root"
		return `${path}: ${issue.message}`
	})

	return { success: false, errors }
}

/**
 * Gets the list of supported environment variables for configuration.
 * Useful for documentation and help messages.
 *
 * Requirements: 5.1
 */
export function getSupportedEnvVars(): string[] {
	const legacyVars = Object.keys(LEGACY_ENV_MAPPINGS)
	const nestedExamples = [
		"WAVEKIT_STATION__NAME",
		"WAVEKIT_STATION__LAT",
		"WAVEKIT_STATION__LON",
		"WAVEKIT_STATION__ALT_M",
		"WAVEKIT_STATION__CALLSIGN",
		"WAVEKIT_STATION__COUNTRY",
		"WAVEKIT_API__HOST",
		"WAVEKIT_API__PORT",
		"WAVEKIT_AUDIO__TCP_PORT",
		"WAVEKIT_AUDIO__FORMAT",
		"WAVEKIT_AUDIO__SAMPLE_RATE",
		"WAVEKIT_TUNER_RELAY__ENABLED",
		"WAVEKIT_TUNER_RELAY__HOST",
		"WAVEKIT_TUNER_RELAY__PORT",
		"WAVEKIT_TUNER_RELAY__SOURCE_ID",
		"WAVEKIT_TUNER_RELAY__CONTROL_POLICY",
		"WAVEKIT_TUNER_RELAY__MAX_CLIENTS",
		"WAVEKIT_TUNER_RELAY__COMMAND_HISTORY_LIMIT",
		"WAVEKIT_LOGGING__LEVEL",
		"WAVEKIT_LOGGING__DIR",
		"WAVEKIT_SOURCES__<INDEX>__HOST",
		"WAVEKIT_SOURCES__<INDEX>__PORT",
		"WAVEKIT_DECODERS__<INDEX>__ENABLED",
		"WAVEKIT_SCANNER__ENABLED",
		"WAVEKIT_SCANNER__PASSIVE__ENABLED",
		"WAVEKIT_SCANNER__CPU_BUDGET_CORES",
		"WAVEKIT_SCANNER__MAX_PROBES__OFFSET",
		"WAVEKIT_SCANNER__STORAGE__DIR",
		"WAVEKIT_SOURCES__<INDEX>__SCANNER__ROLE",
		"WAVEKIT_ACTIVITY__RETENTION__MAX_ROWS",
		"WAVEKIT_ACTIVITY__RETENTION__MAX_DB_BYTES",
		"WAVEKIT_ACTIVITY__RETENTION__MAX_AGE_MS",
		"WAVEKIT_ACTIVITY__ADMISSION__GLOBAL_PER_SECOND",
		"WAVEKIT_ACTIVITY__ADMISSION__GLOBAL_BURST",
		"WAVEKIT_ACTIVITY__ADMISSION__PER_DECODER_PER_SECOND",
		"WAVEKIT_ACTIVITY__ADMISSION__PER_DECODER_BURST",
	]
	return ["WAVEKIT_CONFIG", ...legacyVars, ...nestedExamples]
}

const stationKeys = [
	"name",
	"lat",
	"lon",
	"altM",
	"callsign",
	"country",
] as const
const stationOriginMap = new WeakMap<
	Config,
	Partial<Record<keyof Config["station"], StationConfigOrigin>>
>()

/** Where a configured (non-default) station field came from; both pin it against UI writes. */
export type StationConfigOrigin = Extract<StationProvenance, "yaml" | "env">

/**
 * WG4: the load-time origin of each station field set by YAML or env (absent keys are
 * unset). A config not produced by loadConfig reports set fields as yaml.
 */
export function stationOrigins(
	config: Config,
): Readonly<Partial<Record<StationField, StationConfigOrigin>>> {
	const recorded = stationOriginMap.get(config)
	const out: Partial<Record<StationField, StationConfigOrigin>> = {}
	for (const key of stationKeys) {
		if (config.station[key] === undefined) continue
		out[key] = recorded?.[key] ?? "yaml"
	}
	return out
}

/** Snapshot provenance at load time; subsequent process.env mutations cannot change it. */
export function stationIdentity(
	config: Config,
	region: BandRegion,
): StationIdentity {
	const origins = stationOriginMap.get(config)
	function field<K extends keyof Config["station"]>(key: K) {
		const provenance: StationProvenance =
			origins?.[key] ?? (config.station[key] === undefined ? "default" : "yaml")
		return { value: config.station[key] ?? null, provenance }
	}

	return {
		name: field("name"),
		lat: field("lat"),
		lon: field("lon"),
		altM: field("altM"),
		callsign: field("callsign"),
		country: field("country"),
		effectiveCountry: config.station.country ?? null,
		region,
	}
}
