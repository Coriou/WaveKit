# Live Demodulator Feature — AI Agent Handoff

> **Priority**: HIGH — Core framework feature  
> **Quality Bar**: Production-ready, state-of-the-art, zero technical debt  
> **Status**: Ready for implementation

---

## Executive Summary

Implement a **Live Demodulator** component that demodulates IQ data in real-time and streams audio over HTTP. This is a flagship feature for WaveKit — implementation must be flawless, performant, and maintainable.

**Non-negotiable quality standards:**

- Zero TypeScript errors (`npm run typecheck` must pass)
- Zero ESLint errors (`npm run lint` must pass)
- Full test coverage for new code
- Matches existing code patterns exactly
- No shortcuts, no TODOs, no placeholder implementations

---

## Project Context

### Codebase Location

```
/Users/ben/Projects/WaveKit
```

### Key Files to Study Before Implementation

| File                                  | Purpose                        | Why It Matters               |
| ------------------------------------- | ------------------------------ | ---------------------------- |
| `src/core/audio-demod-decoder.ts`     | Existing csdr pipeline builder | **Reuse patterns exactly**   |
| `src/core/tuner-relay.ts`             | TCP server with fanout branch  | Similar architecture pattern |
| `src/core/fanout-manager.ts`          | Stream multiplexing            | How to consume IQ stream     |
| `src/core/source-manager.ts`          | Source capabilities            | How to read IQ sample rate   |
| `src/api/routes/sources.ts`           | API route patterns             | Follow exact conventions     |
| `src/api/websocket/events.ts`         | WebSocket broadcasting         | Add new channel here         |
| `src/config.ts`                       | Zod schemas                    | Add config schema here       |
| `cli/source/components/dashboard.tsx` | Dashboard patterns             | Follow Ink/React patterns    |

### Tech Stack Reference

- **Runtime**: Node.js 20+, ESM modules
- **Language**: TypeScript 5.x strict mode
- **API**: Fastify with @fastify/websocket
- **CLI**: Ink (React for terminals)
- **Validation**: Zod schemas
- **Logging**: Pino (structured JSON)
- **Testing**: Vitest
- **DSP**: csdr (jketterl/csdr v0.18+)

### Code Style (MUST FOLLOW)

- Tabs for indentation
- No semicolons
- Arrow functions without parens for single params
- Type imports: `import type { Foo } from 'bar'`
- Component loggers: `createComponentLogger(parentLogger, "ComponentName")`

---

## Feature Specification

### 1. LiveDemodulator Class

**File**: `src/core/live-demodulator.ts`

**Responsibilities:**

1. Consume IQ stream from FanoutManager via dedicated branch
2. Spawn csdr demodulation pipeline as child process
3. Serve demodulated audio via embedded HTTP server
4. Support hot-reconfiguration (change params without stopping stream)
5. Emit events for WebSocket broadcasting

**Class Skeleton:**

```typescript
import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import * as http from "node:http"
import type { Readable } from "node:stream"
import { PassThrough } from "node:stream"
import type { Logger } from "../utils/logger.js"
import { createComponentLogger } from "../utils/logger.js"
import type { FanoutManager } from "./fanout-manager.js"
import type { SourceManager } from "./source-manager.js"

export interface LiveDemodConfig {
	enabled: boolean
	sourceId?: string
	httpPort: number
	modulation: "nfm" | "wfm" | "am" | "usb" | "lsb" | "dsb" | "cw" | "raw"
	bandwidth: number
	squelch: number
	noiseReduction: "off" | "voice" | "noaa-apt" | "narrow-band"
	lowPass: number
	highPass: number
	gain: number
	deEmphasis: boolean
	deEmphasisTau: 50 | 75
	audioFormat: "s16le" | "f32le"
	iqDcBlock: boolean
}

export interface LiveDemodStatus {
	enabled: boolean
	running: boolean
	sourceId: string
	sourceConnected: boolean
	sourceIqSampleRate: number
	config: LiveDemodConfig
	effectiveSampleRate: number
	decimationFactor: number
	httpUrl: string
	clientCount: number
	bytesStreamed: number
	pipelineHealth: "running" | "starting" | "stopped" | "error"
	lastError?: string
}

export interface LiveDemodEvents {
	started: () => void
	stopped: () => void
	error: (error: Error) => void
	"config-changed": (config: LiveDemodConfig) => void
	"client-connected": (clientId: string) => void
	"client-disconnected": (clientId: string) => void
}

export class LiveDemodulator extends EventEmitter {
	// Implementation required
}
```

**Critical Implementation Details:**

1. **IQ Branch Management**

   ```typescript
   // Get branch from fanout
   const branchId = `live-demod-${sourceId}`
   const branch = this.fanoutManager.addBranch({
   	id: branchId,
   	sourceId: this.config.sourceId,
   })
   // Pipe to csdr stdin
   branch.pipe(this.csdrProcess.stdin)
   ```

2. **DSP Pipeline Building** (study `audio-demod-decoder.ts` carefully)

   ```bash
   # Full pipeline with IQ DC blocking
   csdr convert -i char -o float \
     | csdr dcblock \                    # IQ-level DC blocking
     | csdr firdecimate ${decimation} ${transition} \
     | csdr fmdemod \                    # or amdemod for AM
     | csdr dcblock \                    # Audio-level DC blocking
     | csdr lowpass -f float ${cutoff} \ # Optional
     | csdr gain ${gain} \
     | csdr limit \
     | csdr deemphasis ${rate} \         # Optional
     | csdr convert -i float -o s16
   ```

3. **Decimation Calculation**

   ```typescript
   // Get IQ rate from source
   const iqSampleRate =
   	this.sourceManager.getCaps(sourceId)?.sampleRate ?? 2_400_000

   // Calculate decimation (must be integer)
   const nyquistRate = config.bandwidth * 2
   const decimation = Math.round(iqSampleRate / nyquistRate)

   // Actual output rate (may differ from config due to integer rounding)
   const effectiveSampleRate = iqSampleRate / decimation
   ```

4. **HTTP Streaming Server**

   ```typescript
   // Create server on httpPort
   this.httpServer = http.createServer((req, res) => {
   	if (req.url === "/stream" && req.method === "GET") {
   		res.writeHead(200, {
   			"Content-Type": `audio/L16;rate=${effectiveSampleRate};channels=1`,
   			"Transfer-Encoding": "chunked",
   			"Cache-Control": "no-cache",
   			Connection: "keep-alive",
   		})
   		// Pipe audio to response
   		this.audioStream.pipe(res)
   		// Handle disconnect
   		req.on("close", () => this.handleClientDisconnect(clientId))
   	}
   })
   ```

5. **Hot Reconfiguration**
   ```typescript
   async reconfigure(newConfig: Partial<LiveDemodConfig>): Promise<void> {
     // Merge with current config
     const merged = { ...this.config, ...newConfig }
     // Validate
     const validated = LiveDemodConfigSchema.parse(merged)
     // Stop current pipeline (keep branch attached)
     await this.stopPipeline()
     // Update config
     this.config = validated
     // Restart pipeline with new params
     await this.startPipeline()
     // Emit event
     this.emit("config-changed", this.config)
   }
   ```

---

### 2. Configuration Schema

**File**: `src/config.ts`

Add after existing schemas:

```typescript
export const LiveDemodConfigSchema = z.object({
	enabled: z.boolean().default(false),
	sourceId: z.string().optional(),
	httpPort: z.number().int().min(1).max(65535).default(8081),
	modulation: z
		.enum(["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"])
		.default("nfm"),
	bandwidth: z.number().int().positive().default(12500),
	squelch: z.number().min(-160).max(0).default(0),
	noiseReduction: z
		.enum(["off", "voice", "noaa-apt", "narrow-band"])
		.default("off"),
	lowPass: z.number().int().min(0).max(20000).default(0),
	highPass: z.number().int().min(0).max(5000).default(0),
	gain: z.number().min(0.1).max(100).default(10.0),
	deEmphasis: z.boolean().default(false),
	deEmphasisTau: z.union([z.literal(50), z.literal(75)]).default(50),
	audioFormat: z.enum(["s16le", "f32le"]).default("s16le"),
	iqDcBlock: z.boolean().default(true),
})

export type LiveDemodConfig = z.infer<typeof LiveDemodConfigSchema>
```

Add to main ConfigSchema:

```typescript
liveDemod: LiveDemodConfigSchema.optional(),
```

---

### 3. API Routes

**File**: `src/api/routes/live-audio.ts` (NEW)

```typescript
import type { FastifyInstance } from "fastify"
import type { LiveDemodulator } from "../../core/live-demodulator.js"

export async function liveAudioRoutes(
	fastify: FastifyInstance,
	liveDemod: LiveDemodulator,
): Promise<void> {
	// GET /api/live-audio/status
	fastify.get("/api/live-audio/status", async () => {
		return liveDemod.getStatus()
	})

	// POST /api/live-audio/start
	fastify.post("/api/live-audio/start", async () => {
		await liveDemod.start()
		return { success: true }
	})

	// POST /api/live-audio/stop
	fastify.post("/api/live-audio/stop", async () => {
		await liveDemod.stop()
		return { success: true }
	})

	// PATCH /api/live-audio/config
	fastify.patch("/api/live-audio/config", async request => {
		const updates = request.body as Partial<LiveDemodConfig>
		await liveDemod.reconfigure(updates)
		return liveDemod.getStatus()
	})

	// GET /api/live-audio/presets
	fastify.get("/api/live-audio/presets", async () => {
		return {
			nfm: { bandwidth: 12500, deEmphasis: false },
			wfm: { bandwidth: 150000, deEmphasis: true, deEmphasisTau: 50 },
			am: { bandwidth: 10000, deEmphasis: false },
			usb: { bandwidth: 2400, deEmphasis: false },
			lsb: { bandwidth: 2400, deEmphasis: false },
			dsb: { bandwidth: 6000, deEmphasis: false },
			cw: { bandwidth: 500, deEmphasis: false },
			raw: { bandwidth: 0, deEmphasis: false },
		}
	})
}
```

---

### 4. WebSocket Events

**File**: `src/api/websocket/events.ts`

Add to `WebSocketChannel` type:

```typescript
export type WebSocketChannel =
	| "decoders"
	| "metrics"
	| "sources"
	| "health"
	| "fanout"
	| "live-audio" // ADD THIS
```

Add to `ServerMessage` type:

```typescript
| "live-audio:status"
| "live-audio:config"
| "live-audio:started"
| "live-audio:stopped"
| "live-audio:error"
```

Add broadcast methods:

```typescript
broadcastLiveAudioStatus(status: LiveDemodStatus): void {
  this.broadcast("live-audio", {
    type: "live-audio:status",
    channel: "live-audio",
    data: status,
  })
}

broadcastLiveAudioConfig(config: LiveDemodConfig): void {
  this.broadcast("live-audio", {
    type: "live-audio:config",
    channel: "live-audio",
    data: config,
  })
}
```

---

### 5. Main Application Integration

**File**: `src/index.ts`

Add after FanoutManager creation:

```typescript
// Create LiveDemodulator
const liveDemod = new LiveDemodulator(
	logger,
	sourceManager,
	fanoutManager,
	config.liveDemod ?? { enabled: false, httpPort: 8081 /* defaults */ },
)

// Wire events to WebSocket broadcaster
liveDemod.on("started", () => {
	wsBroadcaster.broadcast("live-audio", {
		type: "live-audio:started",
		data: {},
	})
})
liveDemod.on("stopped", () => {
	wsBroadcaster.broadcast("live-audio", {
		type: "live-audio:stopped",
		data: {},
	})
})
liveDemod.on("config-changed", config => {
	wsBroadcaster.broadcastLiveAudioConfig(config)
})
liveDemod.on("error", err => {
	wsBroadcaster.broadcast("live-audio", {
		type: "live-audio:error",
		data: { message: err.message },
	})
})

// Register shutdown handler
shutdown.register("LiveDemodulator", async () => {
	await liveDemod.stop()
})

// Auto-start if enabled
if (config.liveDemod?.enabled) {
	await liveDemod.start()
}
```

---

### 6. CLI Dashboard

**File**: `cli/source/components/live-audio-panel.tsx` (NEW)

Full Ink/React component showing:

- Status indicator (running/stopped)
- Stream URL (copyable)
- Current configuration table
- Source info (IQ rate, decimation)
- Throughput stats
- Keyboard controls

Study `dashboard.tsx` and `source-status.tsx` for patterns.

**File**: `cli/source/app.tsx`

- Add Tab 6 for Live Audio
- Subscribe to `live-audio` WebSocket channel
- Add `liveAudioStatus` to app state

**File**: `cli/source/types.ts`

Add:

```typescript
export interface LiveAudioStatus {
	enabled: boolean
	running: boolean
	sourceId: string
	sourceConnected: boolean
	sourceIqSampleRate: number
	config: {
		modulation: string
		bandwidth: number
		squelch: number
		// ... all config fields
	}
	effectiveSampleRate: number
	decimationFactor: number
	httpUrl: string
	clientCount: number
	bytesStreamed: number
	pipelineHealth: "running" | "starting" | "stopped" | "error"
	lastError?: string
}
```

---

### 7. Documentation Updates

**File**: `README.md`

Add section after "Tuner Relay" with:

- Feature description
- Quick start commands
- Configuration reference
- API examples

**File**: `docs/API.md`

Add complete endpoint documentation with:

- Request/response schemas
- Example curl commands
- Error responses

**File**: `docs/ARCHITECTURE.md`

- Update architecture diagram
- Add LiveDemodulator component description
- Document DSP pipeline stages

**File**: `config/default.yaml`

Add `liveDemod` section with full comments (see implementation plan).

---

## Quality Checklist

Before considering this feature complete, ALL of the following MUST pass:

### Code Quality

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run lint` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] All new files follow existing code patterns exactly
- [ ] All imports use `type` keyword where appropriate
- [ ] All errors are handled gracefully (no unhandled rejections)
- [ ] All resources are cleaned up on shutdown

### Testing

- [ ] Unit tests for `LiveDemodulator` class
- [ ] Unit tests for config schema validation
- [ ] Integration tests for API endpoints
- [ ] Tests pass: `npm test`

### Documentation

- [ ] README updated with feature description
- [ ] API.md updated with endpoint documentation
- [ ] ARCHITECTURE.md updated with component description
- [ ] config/default.yaml has full documentation

### Manual Verification

- [ ] Start WaveKit with IQ source
- [ ] Start live demod via API
- [ ] Stream audio with ffplay
- [ ] Change modulation on-the-fly
- [ ] Verify IQ DC blocking works (no center spike)
- [ ] CLI dashboard shows live audio panel
- [ ] Multiple clients can stream simultaneously
- [ ] Graceful shutdown cleans up all resources

---

## Common Pitfalls to Avoid

1. **Don't reinvent pipeline patterns** — Study `audio-demod-decoder.ts` and reuse its approach
2. **Don't forget branch cleanup** — Always remove fanout branch on stop
3. **Don't block the event loop** — Use streams properly, don't buffer entire audio
4. **Don't hardcode sample rates** — Always read from source manager
5. **Don't skip validation** — Use Zod schemas for all config
6. **Don't ignore errors** — Log and emit all pipeline errors
7. **Don't forget graceful shutdown** — Register with shutdown handler

---

## Performance Considerations

1. **Pipeline efficiency**: csdr is highly optimized — don't add unnecessary stages
2. **Memory**: Use PassThrough streams, don't accumulate audio buffers
3. **CPU**: Decimation factor directly affects CPU load — higher = less work
4. **Clients**: Each HTTP client adds minimal overhead (just piping)
5. **Hot reconfigure**: Pipeline restart is fast (~100ms), no client interruption

---

## Success Criteria

This feature is complete when:

1. A user can enable live demodulation via config or API
2. Audio streams to any HTTP client (ffplay, VLC, browser)
3. All 8 modulation modes work correctly
4. IQ DC blocking removes center frequency spike
5. Configuration changes take effect immediately
6. CLI dashboard provides full visibility and control
7. All tests pass
8. All documentation is updated
9. Code review finds zero issues

---

## File Manifest

New files to create:

```
src/core/live-demodulator.ts
src/api/routes/live-audio.ts
cli/source/components/live-audio-panel.tsx
```

Files to modify:

```
src/config.ts                          # Add LiveDemodConfigSchema
src/index.ts                           # Wire LiveDemodulator
src/api/server.ts                      # Register routes
src/api/websocket/events.ts            # Add channel + broadcast methods
cli/source/app.tsx                     # Add Tab 6
cli/source/types.ts                    # Add LiveAudioStatus
cli/source/components/dashboard.tsx    # Add summary panel
config/default.yaml                    # Add liveDemod section
README.md                              # Add documentation
docs/API.md                            # Add endpoint docs
docs/ARCHITECTURE.md                   # Update diagram
```

---

_This handoff document is complete. Implement with precision._
