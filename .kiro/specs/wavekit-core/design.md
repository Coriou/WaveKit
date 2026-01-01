# Design Document: WaveKit Core

## Overview

WaveKit is a TypeScript-based SDR stream processing framework built on Node.js streams and Fastify. The system follows an event-driven architecture where components communicate through EventEmitters and Node.js streams, enabling efficient real-time audio processing with backpressure handling.

The design prioritizes:

- **Stream-first architecture**: All audio data flows through Node.js streams with proper backpressure
- **Plugin extensibility**: Decoders are registered via a factory pattern for easy extension
- **Resilience**: Auto-reconnect, process restart, and graceful degradation
- **Observability**: Structured logging, metrics emission, and real-time event broadcasting

## Architecture

```mermaid
graph TB
    subgraph "External"
        SDR[SDR Source<br/>rtl_tcp / SDR++]
    end

    subgraph "WaveKit Core"
        SM[Source Manager]
        FM[Fanout Manager]
        FC[Format Converter]

        subgraph "Decoder System"
            DR[Decoder Registry]
            DM[Decoder Manager]
            BD[Base Decoder]

            DSD[DSD-FME Decoder]
            MM[Multimon Decoder]
            RTL[RTL433 Decoder]
        end

        subgraph "API Layer"
            API[Fastify Server]
            WS[WebSocket Handler]
            ROUTES[Route Handlers]
        end

        AO[Audio Output<br/>TCP Server]
        CFG[Config Loader]
        LOG[Logger]
    end

    subgraph "Host"
        PLAYER[Audio Player]
        CLIENT[API Client]
    end

    SDR -->|TCP| SM
    SM -->|Readable| FM
    FM -->|PassThrough| FC
    FC -->|Transform| DSD
    FC -->|Transform| MM
    FC -->|Transform| RTL

    DM --> DR
    DM --> DSD
    DM --> MM
    DM --> RTL

    DSD -->|DecoderOutput| WS
    MM -->|DecoderOutput| WS
    RTL -->|DecoderOutput| WS

    DSD -->|Audio| AO

    API --> ROUTES
    API --> WS
    ROUTES --> SM
    ROUTES --> DM

    AO -->|TCP| PLAYER
    WS -->|WebSocket| CLIENT
    API -->|HTTP| CLIENT
```

## Components and Interfaces

### Source Manager

Manages TCP connections to SDR sources with automatic reconnection using exponential backoff.

```typescript
// src/core/source-manager.ts

interface SourceConfig {
	id: string
	type: "sdrpp-network" | "rtl_tcp"
	host: string
	port: number
	format: "S16LE" | "FLOAT32LE"
	sampleRate: number
}

interface SourceStatus {
	id: string
	connected: boolean
	bytesReceived: number
	dataRate: number // KB/s
	lastError?: string
	reconnectAttempts: number
}

interface SourceManagerEvents {
	connected: (sourceId: string) => void
	disconnected: (sourceId: string, error?: Error) => void
	error: (sourceId: string, error: Error) => void
	data: (sourceId: string, chunk: Buffer) => void
	metrics: (
		sourceId: string,
		metrics: { bytesReceived: number; dataRate: number },
	) => void
}

class SourceManager extends EventEmitter {
	constructor(logger: Logger)

	connect(config: SourceConfig): Promise<Readable>
	disconnect(id: string): Promise<void>
	reconnect(id: string): Promise<void>

	getStatus(id: string): SourceStatus | undefined
	getAllStatus(): SourceStatus[]
	getStream(id: string): Readable | undefined
}
```

**Implementation Details:**

- Uses `net.Socket` for TCP connections
- Exponential backoff: 2s → 4s → 8s → 16s → 30s (max)
- Emits metrics every 5 seconds via `setInterval`
- Wraps socket in a `Readable` stream for pipeline compatibility

### Fanout Manager

Multiplexes a single audio stream to multiple consumers with independent buffering.

```typescript
// src/core/fanout-manager.ts

interface BranchConfig {
	id: string
	highWaterMark?: number // Default: 256KB (262144 bytes)
}

interface BranchStatus {
	id: string
	bufferedBytes: number
	backpressure: boolean
}

interface FanoutManagerEvents {
	backpressure: (branchId: string, bufferedBytes: number) => void
	"branch-added": (branchId: string) => void
	"branch-removed": (branchId: string) => void
}

class FanoutManager extends EventEmitter {
	constructor(logger: Logger)

	attachSource(source: Readable): void
	detachSource(): void

	addBranch(config: BranchConfig): PassThrough
	removeBranch(id: string): void

	getBranchIds(): string[]
	getBranchStatus(id: string): BranchStatus | undefined
}
```

**Implementation Details:**

- Each branch is a `PassThrough` stream with configurable `highWaterMark`
- Source data is copied to all branches via `chunk.slice()` (no shared buffers)
- When `write()` returns false, emit 'backpressure' but continue (don't block source)
- Real-time priority: drop data rather than block the source stream

### Format Converter

Transform streams for audio format conversion.

```typescript
// src/core/format-converter.ts

// Convert 32-bit float [-1.0, 1.0] to 16-bit signed integer [-32768, 32767]
function createF32ToS16Transform(): Transform

// Convert 16-bit signed integer to 32-bit float
function createS16ToF32Transform(): Transform

// Resample audio using linear interpolation
// For production, consider libsamplerate bindings
function createResampleTransform(fromRate: number, toRate: number): Transform
```

**Implementation Details:**

- F32→S16: `Math.round(sample * 32767)` clamped to [-32768, 32767]
- S16→F32: `sample / 32768`
- Resampling: Linear interpolation for simplicity; can upgrade to libsamplerate later
- All transforms operate in `objectMode: false` for raw buffer processing

### Decoder Types

Core type definitions for the decoder system.

```typescript
// src/decoders/types.ts

interface DecoderConfig {
	id: string
	type: string
	enabled: boolean
	options: Record<string, unknown>
}

type DecoderOutputType =
	| "sync"
	| "decode"
	| "call"
	| "message"
	| "signal"
	| "error"
	| "stats"

interface DecoderOutput {
	timestamp: Date
	decoder: string
	type: DecoderOutputType
	data: unknown
}

interface DecoderStats {
	bytesIn: number
	eventsOut: number
	errors: number
}

interface DecoderStatus {
	id: string
	type: string
	running: boolean
	pid?: number
	uptime: number // seconds
	stats: DecoderStats
}

interface DecoderEvents {
	output: (output: DecoderOutput) => void
	error: (error: Error) => void
	exit: (code: number | null, signal: string | null) => void
	started: () => void
	stopped: () => void
}

interface Decoder extends EventEmitter {
	readonly id: string
	readonly type: string

	start(): Promise<void>
	stop(): Promise<void>
	restart(): Promise<void>

	attachInput(stream: Readable): void
	detachInput(): void

	getOutput(): Readable // Object mode stream of DecoderOutput
	getAudioOutput(): Readable | null // Raw audio output if available
	getStatus(): DecoderStatus
}
```

### Base Decoder

Abstract base class implementing common decoder functionality.

```typescript
// src/decoders/base-decoder.ts

abstract class BaseDecoder extends EventEmitter implements Decoder {
  readonly id: string;
  readonly type: string;

  protected process: ChildProcess | null = null;
  protected inputStream: Readable | null = null;
  protected outputStream: PassThrough; // Object mode
  protected audioOutputStream: PassThrough | null = null;
  protected stats: DecoderStats = { bytesIn: 0, eventsOut: 0, errors: 0 };
  protected startTime: number = 0;

  constructor(config: DecoderConfig, protected logger: Logger);

  // Template method pattern
  protected abstract getCommand(): string;
  protected abstract getArgs(): string[];
  protected abstract parseOutput(line: string): DecoderOutput | null;

  async start(): Promise<void>;
  async stop(): Promise<void>;
  async restart(): Promise<void>;

  attachInput(stream: Readable): void;
  detachInput(): void;

  getOutput(): Readable;
  getAudioOutput(): Readable | null;
  getStatus(): DecoderStatus;
}
```

**Implementation Details:**

- Uses `child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe']`
- Stdout/stderr parsed line-by-line using `readline.createInterface`
- Graceful stop: SIGTERM → wait 5s → SIGKILL
- Auto-restart handled by DecoderManager, not BaseDecoder

### Decoder Manager

Orchestrates decoder lifecycle and coordinates with other components.

```typescript
// src/decoders/manager.ts

interface DecoderManagerConfig {
	restartDelay: number // Initial restart delay in ms
	maxRestartDelay: number // Maximum restart delay in ms
	maxRestarts: number // Max restarts before giving up (0 = unlimited)
}

class DecoderManager extends EventEmitter {
	constructor(
		registry: DecoderRegistry,
		fanout: FanoutManager,
		logger: Logger,
		config?: Partial<DecoderManagerConfig>,
	)

	// Lifecycle
	createDecoder(config: DecoderConfig): Decoder
	startDecoder(id: string): Promise<void>
	stopDecoder(id: string): Promise<void>
	restartDecoder(id: string): Promise<void>

	// Bulk operations
	startAll(): Promise<void>
	stopAll(): Promise<void>

	// Status
	getDecoder(id: string): Decoder | undefined
	getAllDecoders(): Decoder[]
	getStatus(id: string): DecoderStatus | undefined
	getAllStatus(): DecoderStatus[]
}
```

### Decoder Registry

Plugin system for registering decoder factories.

```typescript
// src/decoders/registry.ts

type DecoderFactory = (config: DecoderConfig, logger: Logger) => Decoder

class DecoderRegistry {
	private factories: Map<string, DecoderFactory> = new Map()

	register(type: string, factory: DecoderFactory): void
	unregister(type: string): boolean

	create(config: DecoderConfig, logger: Logger): Decoder
	has(type: string): boolean
	getRegisteredTypes(): string[]
}
```

### Built-in Decoders

#### DSD-FME Decoder

```typescript
// src/decoders/builtin/dsd-fme.ts

interface DsdFmeOptions {
	mode: "auto" | "dmr" | "p25" | "ysf" | "dstar" | "nxdn" | "provoice"
	output: "null" | "wav" | "udp"
	wavDir?: string
	udpHost?: string
	udpPort?: number
	extraArgs?: string[]
}

class DsdFmeDecoder extends BaseDecoder {
	constructor(config: DecoderConfig, logger: Logger)

	protected getCommand(): string // 'dsd-fme'
	protected getArgs(): string[]
	protected parseOutput(line: string): DecoderOutput | null
}
```

**Output Parsing:**

- Sync: `/Sync: (DMR|P25|YSF|DSTAR|NXDN)/` → `{ type: 'sync', data: { mode, slot? } }`
- Call: `/TG: (\d+) SRC: (\d+)/` → `{ type: 'call', data: { talkgroup, source } }`
- Error: `/FEC ERR|CRC ERR/` → `{ type: 'error', data: { message } }`

#### Multimon-ng Decoder

```typescript
// src/decoders/builtin/multimon-ng.ts

type MultimonMode =
	| "POCSAG512"
	| "POCSAG1200"
	| "POCSAG2400"
	| "FLEX"
	| "EAS"
	| "AFSK1200"
	| "FSK9600"
	| "DTMF"

interface MultimonOptions {
	modes: MultimonMode[]
	verbosity?: number
	charset?: string
}

class MultimonDecoder extends BaseDecoder {
	constructor(config: DecoderConfig, logger: Logger)

	protected getCommand(): string // 'multimon-ng'
	protected getArgs(): string[]
	protected parseOutput(line: string): DecoderOutput | null
}
```

**Output Parsing:**

- POCSAG: `/POCSAG(\d+): Address: (\d+)/` → `{ type: 'message', data: { protocol, address, message } }`
- FLEX: `/FLEX:/` → `{ type: 'message', data: { ... } }`
- DTMF: `/DTMF: (\d+)/` → `{ type: 'decode', data: { protocol: 'DTMF', digits } }`

#### RTL_433 Decoder

```typescript
// src/decoders/builtin/rtl433.ts

interface Rtl433Options {
	analyze?: boolean
	protocols?: number[]
	outputFormat?: "json" | "csv"
}

class Rtl433Decoder extends BaseDecoder {
	constructor(config: DecoderConfig, logger: Logger)

	protected getCommand(): string // 'rtl_433'
	protected getArgs(): string[]
	protected parseOutput(line: string): DecoderOutput | null
}
```

**Output Parsing:**

- Uses `-F json` flag for structured output
- Parses JSON lines directly into `{ type: 'signal', data: parsedJson }`

### API Server

Fastify-based REST and WebSocket server.

```typescript
// src/api/server.ts

interface ApiServerConfig {
	host: string
	port: number
}

class ApiServer {
	private app: FastifyInstance

	constructor(
		sourceManager: SourceManager,
		decoderManager: DecoderManager,
		audioOutput: AudioOutput,
		logger: Logger,
		config: ApiServerConfig,
	)

	async start(): Promise<void>
	async stop(): Promise<void>

	getApp(): FastifyInstance
}
```

**Route Structure:**

- `GET /health` - Health check
- `GET /api/status` - Full system status
- `GET /api/sources` - List sources
- `POST /api/sources` - Add source
- `DELETE /api/sources/:id` - Remove source
- `GET /api/decoders` - List decoders
- `GET /api/decoders/:id` - Get decoder status
- `POST /api/decoders/:id/start` - Start decoder
- `POST /api/decoders/:id/stop` - Stop decoder
- `POST /api/decoders/:id/restart` - Restart decoder
- `PATCH /api/decoders/:id` - Update decoder config

### WebSocket Events

```typescript
// src/api/websocket/events.ts

type WebSocketChannel = "decoders" | "metrics" | "sources"

interface ClientMessage {
	type: "subscribe" | "unsubscribe"
	channels: WebSocketChannel[]
}

interface ServerMessage {
	type:
		| "decoder:output"
		| "decoder:status"
		| "source:connected"
		| "source:disconnected"
		| "metrics"
	data: unknown
}

class WebSocketEventBroadcaster {
	constructor(fastify: FastifyInstance, logger: Logger)

	broadcast(channel: WebSocketChannel, message: ServerMessage): void
	getConnectedClients(): number
}
```

### Audio Output

TCP server for streaming decoded audio to host players.

```typescript
// src/core/audio-output.ts

interface AudioOutputConfig {
	port: number
	format: "S16LE" | "FLOAT32LE"
	sampleRate: number
}

class AudioOutput extends EventEmitter {
	constructor(logger: Logger, config: AudioOutputConfig)

	start(): Promise<void>
	stop(): Promise<void>

	attachSource(stream: Readable): void
	detachSource(): void

	getConnectedClients(): number
	getPort(): number
}
```

**Implementation Details:**

- Uses `net.createServer()` for TCP server
- Maintains array of connected client sockets
- Pipes source stream to all clients via fanout pattern
- Handles client disconnection gracefully

### Configuration

```typescript
// src/config.ts

import { z } from "zod"

const SourceConfigSchema = z.object({
	id: z.string(),
	type: z.enum(["sdrpp-network", "rtl_tcp"]),
	host: z.string(),
	port: z.number().int().positive(),
	format: z.enum(["S16LE", "FLOAT32LE"]),
	sampleRate: z.number().int().positive(),
})

const DecoderConfigSchema = z.object({
	id: z.string(),
	type: z.string(),
	enabled: z.boolean(),
	options: z.record(z.unknown()),
})

const ConfigSchema = z.object({
	sources: z.array(SourceConfigSchema),
	decoders: z.array(DecoderConfigSchema),
	audio: z.object({
		tcpPort: z.number().int().positive().default(8080),
		format: z.enum(["S16LE", "FLOAT32LE"]).default("S16LE"),
		sampleRate: z.number().int().positive().default(48000),
	}),
	api: z.object({
		host: z.string().default("0.0.0.0"),
		port: z.number().int().positive().default(3000),
	}),
	logging: z.object({
		level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
		dir: z.string().optional(),
	}),
})

type Config = z.infer<typeof ConfigSchema>

function loadConfig(configPath?: string): Config
```

### Logger

```typescript
// src/utils/logger.ts

import pino from "pino"

function createLogger(config: { level: string; dir?: string }): pino.Logger

// Child loggers for components
function createComponentLogger(
	parent: pino.Logger,
	component: string,
): pino.Logger
```

### Graceful Shutdown

```typescript
// src/utils/graceful-shutdown.ts

interface ShutdownHandler {
	name: string
	handler: () => Promise<void>
	timeout?: number // ms, default 5000
}

class GracefulShutdown {
	private handlers: ShutdownHandler[] = []
	private shuttingDown: boolean = false

	register(handler: ShutdownHandler): void
	unregister(name: string): void

	async shutdown(): Promise<void>

	// Call this once at startup
	installSignalHandlers(): void
}
```

## Data Models

### Source Status

```typescript
interface SourceStatus {
	id: string
	type: "sdrpp-network" | "rtl_tcp"
	host: string
	port: number
	connected: boolean
	bytesReceived: number
	dataRate: number // KB/s, rolling average
	lastError?: string
	reconnectAttempts: number
	connectedAt?: Date
}
```

### Decoder Status

```typescript
interface DecoderStatus {
	id: string
	type: string
	running: boolean
	enabled: boolean
	pid?: number
	uptime: number // seconds
	stats: {
		bytesIn: number
		eventsOut: number
		errors: number
	}
	lastOutput?: DecoderOutput
	restartCount: number
}
```

### System Status

```typescript
interface SystemStatus {
	uptime: number // seconds
	version: string
	sources: SourceStatus[]
	decoders: DecoderStatus[]
	audio: {
		outputPort: number
		clientsConnected: number
		format: string
		sampleRate: number
	}
}
```

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

### Property 1: Exponential Backoff Correctness

_For any_ sequence of N consecutive failures (connection or process restart), the delay before attempt N should be `min(2^N * baseDelay, maxDelay)` where baseDelay=2000ms and maxDelay=30000ms.

**Validates: Requirements 1.2, 4.2**

### Property 2: Source Status Completeness

_For any_ source managed by Source_Manager, calling `getStatus(id)` should return an object containing all required fields: `id`, `connected`, `bytesReceived`, `dataRate`, and `reconnectAttempts`.

**Validates: Requirements 1.7**

### Property 3: Connection Error Resilience

_For any_ TCP connection error of type ECONNREFUSED, ETIMEDOUT, or ECONNRESET, the Source_Manager should emit an 'error' event and not throw an unhandled exception.

**Validates: Requirements 1.6**

### Property 4: Fanout Data Distribution

_For any_ data chunk received by Fanout_Manager with N active branches, all N branches should receive an identical copy of the chunk (same bytes, same length).

**Validates: Requirements 2.3**

### Property 5: Branch Independence

_For any_ two branches A and B in Fanout_Manager, writing to branch A's buffer should not affect branch B's buffer state, and removing branch A should not affect data flow to branch B.

**Validates: Requirements 2.2, 2.5**

### Property 6: Backpressure Non-Blocking

_For any_ branch that reaches its highWaterMark, the source stream should continue to flow (not block), and a 'backpressure' event should be emitted for that branch.

**Validates: Requirements 2.4**

### Property 7: Format Conversion Round-Trip

_For any_ 16-bit signed integer value V in range [-32768, 32767], converting V to float and back to S16 should produce a value within ±1 of V (accounting for floating-point precision).

**Validates: Requirements 3.1, 3.2**

### Property 8: Resample Length Ratio

_For any_ audio buffer of length L samples at rate R1, resampling to rate R2 should produce a buffer of length approximately `L * (R2 / R1)` samples (within ±1 sample for rounding).

**Validates: Requirements 3.3**

### Property 9: Decoder Registry Consistency

_For any_ decoder type T registered with factory F, the registry should: (a) return true for `has(T)`, (b) include T in `getRegisteredTypes()`, (c) successfully create a decoder when `create({type: T, ...})` is called, and (d) return an error for any unregistered type U.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

### Property 10: Decoder Status Completeness

_For any_ decoder managed by Decoder_Manager, calling `getStatus(id)` should return an object containing all required fields: `id`, `type`, `running`, `uptime`, and `stats` (with `bytesIn`, `eventsOut`, `errors`).

**Validates: Requirements 4.5**

### Property 11: DSD Output Parsing

_For any_ valid dsd-fme output line matching sync, call, or error patterns, the parser should produce a DecoderOutput object with the correct `type` field and extracted data fields.

**Validates: Requirements 6.2, 6.3, 6.4**

### Property 12: DSD Mode Support

_For any_ mode in the set {auto, dmr, p25, ysf, dstar, nxdn, provoice}, creating a DSD decoder with that mode should succeed without error.

**Validates: Requirements 6.5**

### Property 13: Multimon Output Parsing

_For any_ valid multimon-ng output line matching POCSAG, FLEX, or DTMF patterns, the parser should produce a DecoderOutput object with the correct `type` field and extracted data fields.

**Validates: Requirements 7.2**

### Property 14: Multimon Mode Support

_For any_ mode in the set {POCSAG512, POCSAG1200, POCSAG2400, FLEX, EAS, AFSK1200, FSK9600, DTMF}, creating a Multimon decoder with that mode should succeed without error.

**Validates: Requirements 7.3**

### Property 15: RTL433 JSON Parsing

_For any_ valid JSON line output by rtl_433, the parser should produce a DecoderOutput object with `type: 'signal'` and the parsed JSON as the data field.

**Validates: Requirements 8.2**

### Property 16: API Status Response Completeness

_For any_ call to GET /api/status, the response should contain `uptime`, `sources` (array), `decoders` (array), and `audio` (object with `outputPort`, `clientsConnected`).

**Validates: Requirements 9.2**

### Property 17: Source CRUD Consistency

_For any_ valid source configuration S, after POST /api/sources with S, GET /api/sources should include S, and after DELETE /api/sources/:id, GET /api/sources should not include S.

**Validates: Requirements 9.3, 9.4, 9.5**

### Property 18: Decoder API State Consistency

_For any_ decoder D, after POST /api/decoders/:id/start, GET /api/decoders/:id should show `running: true`, and after POST /api/decoders/:id/stop, it should show `running: false`.

**Validates: Requirements 9.6, 9.7, 9.8**

### Property 19: WebSocket Channel Filtering

_For any_ client subscribed to channel C, the client should receive all events for channel C and no events for channels not in their subscription list.

**Validates: Requirements 10.2, 10.3, 10.4**

### Property 20: Audio Output Multi-Client Distribution

_For any_ N connected TCP clients to Audio_Output, when audio data is written to the source, all N clients should receive identical data.

**Validates: Requirements 11.2, 11.3**

### Property 21: Config Environment Override

_For any_ configuration key K with YAML value Y and environment variable value E, the loaded config should have value E (environment overrides file).

**Validates: Requirements 12.2**

### Property 22: Config Validation Errors

_For any_ invalid configuration (missing required fields, wrong types), the Config_Loader should return a Zod validation error with a descriptive message indicating the invalid field.

**Validates: Requirements 12.3, 12.4**

### Property 23: Log Entry Structure

_For any_ log entry produced by the Logger, it should contain `time` (timestamp), `level` (log level), and `component` (component name) fields.

**Validates: Requirements 13.3**

### Property 24: Graceful Shutdown Completeness

_For any_ shutdown initiated by SIGTERM, after shutdown completes: (a) all decoders should be stopped, (b) all source connections should be closed, (c) all streams should be destroyed, and (d) no new connections should be accepted.

**Validates: Requirements 14.2, 14.3, 14.4, 14.5**

## Error Handling

### Custom Error Classes

```typescript
// src/utils/errors.ts

class WaveKitError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly cause?: Error,
	) {
		super(message)
		this.name = "WaveKitError"
	}
}

class SourceConnectionError extends WaveKitError {
	constructor(host: string, port: number, cause?: Error) {
		super(
			`Failed to connect to ${host}:${port}`,
			"SOURCE_CONNECTION_ERROR",
			cause,
		)
	}
}

class DecoderSpawnError extends WaveKitError {
	constructor(decoderId: string, command: string, cause?: Error) {
		super(
			`Failed to spawn decoder ${decoderId}: ${command}`,
			"DECODER_SPAWN_ERROR",
			cause,
		)
	}
}

class DecoderParseError extends WaveKitError {
	constructor(decoderId: string, line: string) {
		super(
			`Failed to parse decoder output: ${line.substring(0, 100)}`,
			"DECODER_PARSE_ERROR",
		)
	}
}

class ConfigValidationError extends WaveKitError {
	constructor(errors: z.ZodError) {
		super(
			`Configuration validation failed: ${errors.message}`,
			"CONFIG_VALIDATION_ERROR",
		)
	}
}

class RegistryError extends WaveKitError {
	constructor(type: string) {
		super(`Unknown decoder type: ${type}`, "REGISTRY_ERROR")
	}
}
```

### Error Handling Strategy

| Error Type            | Handling Strategy                     |
| --------------------- | ------------------------------------- |
| TCP Connection Errors | Log, emit event, retry with backoff   |
| Decoder Process Exit  | Log, emit event, restart with backoff |
| Decoder Parse Errors  | Log warning, skip line, continue      |
| Config Validation     | Log error, exit with code 1           |
| API Request Errors    | Return appropriate HTTP status code   |
| WebSocket Errors      | Log, close connection gracefully      |
| Shutdown Timeout      | Log warning, force exit               |

### Stream Error Handling

All streams must have error handlers attached:

```typescript
stream.on("error", err => {
	logger.error({ err, streamId }, "Stream error")
	// Don't re-throw - handle gracefully
})
```

## Testing Strategy

### Testing Framework

- **Unit Tests**: Vitest (fast, ESM-native, TypeScript support)
- **Property-Based Tests**: fast-check (JavaScript PBT library)
- **Integration Tests**: Vitest with real processes
- **Mocking**: Vitest built-in mocking for child processes and network

### Test Configuration

```typescript
// vitest.config.ts
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
	},
})
```

### Property-Based Testing Configuration

Each property test must:

- Run minimum 100 iterations
- Reference the design document property number
- Use descriptive test names

```typescript
// Example property test structure
import { fc } from "fast-check"

describe("Format Converter", () => {
	// Feature: wavekit-core, Property 7: Format Conversion Round-Trip
	// Validates: Requirements 3.1, 3.2
	it("should round-trip S16 values within ±1", () => {
		fc.assert(
			fc.property(fc.integer({ min: -32768, max: 32767 }), s16Value => {
				const f32 = s16ToF32(s16Value)
				const roundTrip = f32ToS16(f32)
				return Math.abs(roundTrip - s16Value) <= 1
			}),
			{ numRuns: 100 },
		)
	})
})
```

### Unit Test Focus Areas

- Specific examples demonstrating correct behavior
- Edge cases (empty inputs, boundary values)
- Error conditions and exception handling
- Integration points between components

### Test File Organization

```
tests/
├── unit/
│   ├── core/
│   │   ├── source-manager.test.ts
│   │   ├── fanout-manager.test.ts
│   │   └── format-converter.test.ts
│   ├── decoders/
│   │   ├── registry.test.ts
│   │   ├── dsd-fme.test.ts
│   │   ├── multimon-ng.test.ts
│   │   └── rtl433.test.ts
│   ├── api/
│   │   └── routes.test.ts
│   └── utils/
│       ├── config.test.ts
│       └── logger.test.ts
├── integration/
│   ├── decoder-lifecycle.test.ts
│   ├── audio-pipeline.test.ts
│   └── api-websocket.test.ts
└── mocks/
    ├── tcp-server.ts
    ├── decoder-process.ts
    └── fixtures/
        ├── dsd-output.txt
        ├── multimon-output.txt
        └── rtl433-output.json
```

### Mock Strategies

| Component       | Mock Strategy                                       |
| --------------- | --------------------------------------------------- |
| TCP Connections | In-memory mock server using `net.createServer()`    |
| Child Processes | Mock `spawn()` returning fake stdout/stderr streams |
| Decoder Output  | Fixture files with real decoder output samples      |
| Timers          | Vitest fake timers for backoff testing              |
