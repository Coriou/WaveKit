# TUNER_INTERFACE_HANDOFF.md

<!-- AI Agent Handoff Document - Optimized for Implementation -->
<!-- Last Updated: 2026-01-13 -->

## Executive Summary

**Objective:** Implement a first-class, state-of-the-art internal tuner interface for WaveKit that provides direct RTL-SDR control via RTL-TCP protocol, allowing users to tune without requiring external applications like SDR++.

**Quality Bar:** This implementation must be rock-solid, production-ready, and represent the highest quality code in the project. Every component must be explicitly typed, thoroughly tested, and seamlessly integrated. No shortcuts, no complexity without justification, no hard-to-debug layers.

**End Result:** Users can tune their RTL-SDR directly from the WaveKit CLI dashboard or API, with the option to seamlessly hand off control to an external tuner (SDR++) when desired.

---

## Quick Start

**Scope:**

- `TunerController` class in `src/core/`
- REST API endpoints in `src/api/routes/tuner.ts`
- WebSocket events via `tuner` channel
- CLI dashboard tab 8 (Ink/React) in `cli/source/components/`
- Shared types in `packages/api-types/`
- Scalable tab system (rename "Live Audio" → "Audio" for space)

**NOT in scope:** sdr-host integration, SoapySDR, direct USB control, state persistence (keep simple), frequency presets database

---

## Architecture Decision

**Chosen:** TunerController as **Primary Control Tuner** with release capability.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          WaveKit                                    │
│  ┌──────────────────┐      ┌──────────────────┐                     │
│  │  TunerController │ ───► │  SourceManager   │ ───► RTL-TCP Source │
│  │  (Primary Tuner) │      │  writeToSource() │                     │
│  └──────────────────┘      └──────────────────┘                     │
│         │                           ▲                               │
│         │ (when released)           │                               │
│         ▼                           │                               │
│  ┌──────────────────┐               │                               │
│  │   TunerRelay     │ ◄───── SDR++ connects ────────────────────────┤
│  │   (Port 7373)    │               │                               │
│  └──────────────────┘               │                               │
│         │                           │                               │
│         └── forwards commands ──────┘                               │
└─────────────────────────────────────────────────────────────────────┘
```

**Control Flow:**

1. **Default:** TunerController is the "control client" for all RTL-TCP sources
2. **User toggleable:** API endpoint / CLI to "release control" to TunerRelay
3. **When released:** TunerController stops sending commands; SDR++ (connected via TunerRelay) takes over
4. **Reclaim:** User can reclaim control via API/CLI, TunerController resumes

**Rationale:**

- First-class user experience: users can tune immediately without SDR++
- No lock-in: can hand off to SDR++ for advanced spectrum analysis
- Uses existing `writeToSource()` infrastructure
- Works with any rtl_tcp/rtlmux source
- Matches existing TunerRelay "exclusive" control policy pattern

---

## Key Files to Study Before Implementation

```
src/core/tuner-relay.ts        # RTL-TCP command parsing (COMMAND_NAMES map, encodeCommand pattern)
                                # CRITICAL: Study TunerRelayControlPolicy, controlClientId pattern
src/core/source-manager.ts     # writeToSource() method, multi-source Map pattern
                                # CRITICAL: Line 473+ for writeToSource implementation
src/core/fanout-manager.ts     # BranchConfig.sourceId pattern for multi-source
src/decoders/manager.ts        # Map-based state management pattern (gold standard)
src/api/routes/live-audio.ts   # Route pattern with Zod validation schemas
src/api/routes/tuner-relay.ts  # Existing tuner relay routes (read-only status)
src/api/websocket/events.ts    # WebSocket broadcast pattern, channel subscriptions
src/api/server.ts              # Dependency injection, route registration
cli/source/app.tsx             # Tab navigation (viewMap), keyboard handling, API calls
                                # CRITICAL: Lines 369-380 for view mapping
cli/source/components/live-audio-panel.tsx  # Component pattern to follow
packages/api-types/src/tuner.ts # Existing TunerRelayStatus types
packages/api-types/src/index.ts # Type export pattern
```

---

## RTL-TCP Command Reference

All commands are 5 bytes: `[cmd: u8][value: u32be]`

```typescript
const RTL_TCP_COMMANDS = {
	SET_FREQUENCY: 0x01,        // Hz (24MHz - 1.9GHz)
	SET_SAMPLE_RATE: 0x02,      // Hz
	SET_GAIN_MODE: 0x03,        // 0=AGC, 1=manual
	SET_GAIN: 0x04,             // 0.1 dB units (400 = 40.0 dB)
	SET_FREQ_CORRECTION: 0x05,  // PPM
	SET_IF_GAIN: 0x06,          // IF stage gain
	SET_TEST_MODE: 0x07,        // Test mode
	SET_AGC_MODE: 0x08,         // RTL2832 AGC
	SET_DIRECT_SAMPLING: 0x09,  // 0=off, 1=I, 2=Q
	SET_OFFSET_TUNING: 0x0a,    // Offset tuning
	SET_RTL_XTAL: 0x0b,         // RTL XTAL freq
	SET_TUNER_XTAL: 0x0c,       // Tuner XTAL freq
	SET_TUNER_GAIN_INDEX: 0x0d, // Gain by index
	SET_BIAS_TEE: 0x0e,         // 0=off, 1=on
	SET_TUNER_IF_GAIN: 0x0f,    // stage<<16 | gain
} as const

// Encoding function (matches tuner-relay.ts pattern)
function encodeCommand(cmd: number, value: number): Buffer {
	const buf = Buffer.alloc(5)
	buf.writeUInt8(cmd, 0)
	buf.writeUInt32BE(value >>> 0, 1)
	return buf
}
```

---

## Implementation Phases

### Phase 1: Core Types & Shared Package

**Modify:** `packages/api-types/src/tuner.ts`

Add these types alongside existing TunerRelayStatus:

```typescript
// Tuner control types (for TunerController)
export type TunerGainMode = "manual" | "agc"
export type TunerDirectSampling = "off" | "i" | "q"
export type TunerControlMode = "internal" | "external"

export interface TunerState {
	sourceId: string
	frequency: number          // Hz
	sampleRate: number         // Hz
	gainMode: TunerGainMode
	gain: number               // 0.1 dB units (0-500)
	ppm: number                // PPM correction
	agcMode: boolean           // RTL2832 AGC
	biasTee: boolean           // Bias-T power
	directSampling: TunerDirectSampling
	offsetTuning: boolean
	ifGain: number
	tunerIfGain: { stage: number; gain: number } | null
	controlMode: TunerControlMode  // "internal" = WaveKit controls, "external" = SDR++ controls
	lastCommandAt?: string
	lastError?: string
	commandCount: number
}

// API request/response types
export interface SetFrequencyRequest { hz: number }
export interface SetGainRequest { tenthsDb: number }
export interface SetGainModeRequest { mode: TunerGainMode }
export interface SetSampleRateRequest { hz: number }
export interface SetPpmRequest { ppm: number }
export interface SetBooleanRequest { enabled: boolean }
export interface SetDirectSamplingRequest { mode: TunerDirectSampling }
export interface SetControlModeRequest { mode: TunerControlMode }
export interface TunerConfigUpdate extends Partial<Omit<TunerState, 'sourceId' | 'lastCommandAt' | 'lastError' | 'commandCount'>> {}
```

---

### Phase 2: TunerController Core

**Create:** `src/core/tuner-controller.ts` (~350-400 lines)

```typescript
import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import type { SourceManager } from "./source-manager.js"
import type { TunerState, TunerGainMode, TunerDirectSampling, TunerControlMode } from "@wavekit/api-types"

// Validation constants
const VALIDATION = {
	frequency: { min: 24_000_000, max: 1_900_000_000 },
	sampleRate: { min: 225_001, max: 3_200_000 },
	gain: { min: 0, max: 500 },
	ppm: { min: -500, max: 500 },
} as const

// RTL-TCP commands (mirrored from tuner-relay.ts for consistency)
const RTL_TCP_COMMANDS = {
	SET_FREQUENCY: 0x01,
	SET_SAMPLE_RATE: 0x02,
	SET_GAIN_MODE: 0x03,
	SET_GAIN: 0x04,
	SET_FREQ_CORRECTION: 0x05,
	SET_IF_GAIN: 0x06,
	SET_TEST_MODE: 0x07,
	SET_AGC_MODE: 0x08,
	SET_DIRECT_SAMPLING: 0x09,
	SET_OFFSET_TUNING: 0x0a,
	SET_RTL_XTAL: 0x0b,
	SET_TUNER_XTAL: 0x0c,
	SET_TUNER_GAIN_INDEX: 0x0d,
	SET_BIAS_TEE: 0x0e,
	SET_TUNER_IF_GAIN: 0x0f,
} as const

// Command names for logging (matches tuner-relay.ts)
const COMMAND_NAMES: Record<number, string> = {
	0x01: "set-frequency",
	0x02: "set-sample-rate",
	0x03: "set-gain-mode",
	0x04: "set-gain",
	0x05: "set-freq-correction",
	0x06: "set-if-gain",
	0x07: "set-test-mode",
	0x08: "set-agc-mode",
	0x09: "set-direct-sampling",
	0x0a: "set-offset-tuning",
	0x0b: "set-rtl-xtal",
	0x0c: "set-tuner-xtal",
	0x0d: "set-tuner-gain-index",
	0x0e: "set-bias-tee",
	0x0f: "set-tuner-if-gain",
}

export interface TunerControllerEvents {
	"state-changed": (sourceId: string, state: TunerState) => void
	"command-sent": (sourceId: string, command: string, value: number) => void
	"control-mode-changed": (sourceId: string, mode: TunerControlMode) => void
	"error": (sourceId: string, error: Error) => void
}

export interface TunerControllerConfig {
	// Future config options
}

export class TunerController extends EventEmitter {
	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly config: TunerControllerConfig
	private tunerStates: Map<string, TunerState> = new Map()

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		config: TunerControllerConfig = {},
	) {
		super()
		this.log = createComponentLogger(logger, "TunerController")
		this.sourceManager = sourceManager
		this.config = config
	}

	// === Lifecycle ===

	initializeSource(sourceId: string): void {
		if (this.tunerStates.has(sourceId)) {
			this.log.debug({ sourceId }, "Source already initialized")
			return
		}

		// Default state: sensible defaults for immediate use
		const state: TunerState = {
			sourceId,
			frequency: 100_000_000,  // 100 MHz
			sampleRate: 2_400_000,   // 2.4 MSPS
			gainMode: "agc",
			gain: 0,
			ppm: 0,
			agcMode: true,
			biasTee: false,
			directSampling: "off",
			offsetTuning: false,
			ifGain: 0,
			tunerIfGain: null,
			controlMode: "internal",  // WaveKit controls by default
			commandCount: 0,
		}

		this.tunerStates.set(sourceId, state)
		this.log.info({ sourceId }, "Tuner source initialized")
		this.emit("state-changed", sourceId, state)
	}

	removeSource(sourceId: string): void {
		if (!this.tunerStates.has(sourceId)) return
		this.tunerStates.delete(sourceId)
		this.log.info({ sourceId }, "Tuner source removed")
	}

	// === Control Mode ===

	setControlMode(sourceId: string, mode: TunerControlMode): void {
		const state = this.validateSource(sourceId)
		if (state.controlMode === mode) return

		state.controlMode = mode
		this.log.info({ sourceId, mode }, "Control mode changed")
		this.emit("control-mode-changed", sourceId, mode)
		this.emit("state-changed", sourceId, state)
	}

	// === Tuning Commands (only when controlMode === "internal") ===

	async setFrequency(sourceId: string, hz: number): Promise<void> {
		this.validateRange("frequency", hz, VALIDATION.frequency)
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_FREQUENCY, hz)
		state.frequency = hz
		this.emitStateChanged(sourceId, state)
	}

	async setSampleRate(sourceId: string, hz: number): Promise<void> {
		this.validateRange("sampleRate", hz, VALIDATION.sampleRate)
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_SAMPLE_RATE, hz)
		state.sampleRate = hz
		this.emitStateChanged(sourceId, state)
	}

	async setGainMode(sourceId: string, mode: TunerGainMode): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "manual" ? 1 : 0
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_GAIN_MODE, value)
		state.gainMode = mode
		this.emitStateChanged(sourceId, state)
	}

	async setGain(sourceId: string, tenthsDb: number): Promise<void> {
		this.validateRange("gain", tenthsDb, VALIDATION.gain)
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_GAIN, tenthsDb)
		state.gain = tenthsDb
		this.emitStateChanged(sourceId, state)
	}

	async setPpm(sourceId: string, ppm: number): Promise<void> {
		this.validateRange("ppm", ppm, VALIDATION.ppm)
		const state = this.validateSourceForControl(sourceId)
		// PPM can be negative, need to handle signed value
		const value = ppm < 0 ? (0xffffffff + ppm + 1) : ppm
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_FREQ_CORRECTION, value)
		state.ppm = ppm
		this.emitStateChanged(sourceId, state)
	}

	async setAgcMode(sourceId: string, enabled: boolean): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_AGC_MODE, enabled ? 1 : 0)
		state.agcMode = enabled
		this.emitStateChanged(sourceId, state)
	}

	async setBiasTee(sourceId: string, enabled: boolean): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_BIAS_TEE, enabled ? 1 : 0)
		state.biasTee = enabled
		this.emitStateChanged(sourceId, state)
	}

	async setDirectSampling(sourceId: string, mode: TunerDirectSampling): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "off" ? 0 : mode === "i" ? 1 : 2
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING, value)
		state.directSampling = mode
		this.emitStateChanged(sourceId, state)
	}

	async setOffsetTuning(sourceId: string, enabled: boolean): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_OFFSET_TUNING, enabled ? 1 : 0)
		state.offsetTuning = enabled
		this.emitStateChanged(sourceId, state)
	}

	async setIfGain(sourceId: string, stage: number, gain: number): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = (stage << 16) | (gain & 0xffff)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN, value)
		state.tunerIfGain = { stage, gain }
		this.emitStateChanged(sourceId, state)
	}

	// === Bulk Update ===

	async configure(sourceId: string, updates: Partial<TunerState>): Promise<void> {
		// Apply updates sequentially, validating each
		if (updates.controlMode !== undefined) {
			this.setControlMode(sourceId, updates.controlMode)
		}
		if (updates.frequency !== undefined) {
			await this.setFrequency(sourceId, updates.frequency)
		}
		if (updates.sampleRate !== undefined) {
			await this.setSampleRate(sourceId, updates.sampleRate)
		}
		if (updates.gainMode !== undefined) {
			await this.setGainMode(sourceId, updates.gainMode)
		}
		if (updates.gain !== undefined) {
			await this.setGain(sourceId, updates.gain)
		}
		if (updates.ppm !== undefined) {
			await this.setPpm(sourceId, updates.ppm)
		}
		if (updates.agcMode !== undefined) {
			await this.setAgcMode(sourceId, updates.agcMode)
		}
		if (updates.biasTee !== undefined) {
			await this.setBiasTee(sourceId, updates.biasTee)
		}
		if (updates.directSampling !== undefined) {
			await this.setDirectSampling(sourceId, updates.directSampling)
		}
		if (updates.offsetTuning !== undefined) {
			await this.setOffsetTuning(sourceId, updates.offsetTuning)
		}
	}

	// === State Accessors ===

	getState(sourceId: string): TunerState | undefined {
		return this.tunerStates.get(sourceId)
	}

	getAllStates(): TunerState[] {
		return Array.from(this.tunerStates.values())
	}

	getRtlTcpSourceIds(): string[] {
		return Array.from(this.tunerStates.keys())
	}

	// === Private Helpers ===

	private validateSource(sourceId: string): TunerState {
		const state = this.tunerStates.get(sourceId)
		if (!state) {
			throw new Error(`Tuner source not found: ${sourceId}`)
		}
		return state
	}

	private validateSourceForControl(sourceId: string): TunerState {
		const state = this.validateSource(sourceId)
		if (state.controlMode === "external") {
			throw new Error(`Cannot send commands: control released to external tuner for ${sourceId}`)
		}
		return state
	}

	private validateRange(name: string, value: number, range: { min: number; max: number }): void {
		if (value < range.min || value > range.max) {
			throw new Error(`${name} out of range: ${value} (expected ${range.min}-${range.max})`)
		}
	}

	private async sendCommand(sourceId: string, cmd: number, value: number): Promise<void> {
		const buf = Buffer.alloc(5)
		buf.writeUInt8(cmd, 0)
		buf.writeUInt32BE(value >>> 0, 1)

		try {
			this.sourceManager.writeToSource(sourceId, buf)
			const state = this.tunerStates.get(sourceId)
			if (state) {
				state.commandCount++
				state.lastCommandAt = new Date().toISOString()
				state.lastError = undefined
			}
			const cmdName = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
			this.emit("command-sent", sourceId, cmdName, value)
			this.log.debug({ sourceId, command: cmdName, value }, "Command sent")
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const state = this.tunerStates.get(sourceId)
			if (state) {
				state.lastError = message
			}
			this.log.error({ sourceId, err: message }, "Failed to send tuner command")
			this.emit("error", sourceId, err instanceof Error ? err : new Error(message))
			throw err
		}
	}

	private emitStateChanged(sourceId: string, state: TunerState): void {
		this.emit("state-changed", sourceId, { ...state })
	}
}
```

---

### Phase 3: SourceManager Helper

**Modify:** `src/core/source-manager.ts`

Add helper method (~10 lines):

```typescript
// Add to SourceManager class (around line 1000)

/**
 * Checks if a source supports RTL-TCP tuner control.
 * Only rtl_tcp type sources can receive tuner commands.
 */
isRtlTcpSource(sourceId: string): boolean {
	const state = this.sources.get(sourceId)
	if (!state || !state.config.type) return false
	return state.config.type === "rtl_tcp"
}
```

---

### Phase 4: API Routes

**Create:** `src/api/routes/tuner.ts` (~250 lines)

```typescript
/**
 * Tuner Routes - RTL-TCP tuner control endpoints
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { TunerController } from "../../core/tuner-controller.js"
import type {
	TunerState,
	SetFrequencyRequest,
	SetGainRequest,
	SetGainModeRequest,
	SetSampleRateRequest,
	SetPpmRequest,
	SetBooleanRequest,
	SetDirectSamplingRequest,
	SetControlModeRequest,
	TunerConfigUpdate,
} from "@wavekit/api-types"

// Schemas for validation and OpenAPI
const tunerStateSchema = {
	type: "object",
	properties: {
		sourceId: { type: "string" },
		frequency: { type: "number" },
		sampleRate: { type: "number" },
		gainMode: { type: "string", enum: ["manual", "agc"] },
		gain: { type: "number" },
		ppm: { type: "number" },
		agcMode: { type: "boolean" },
		biasTee: { type: "boolean" },
		directSampling: { type: "string", enum: ["off", "i", "q"] },
		offsetTuning: { type: "boolean" },
		ifGain: { type: "number" },
		tunerIfGain: {
			type: "object",
			nullable: true,
			properties: {
				stage: { type: "number" },
				gain: { type: "number" },
			},
		},
		controlMode: { type: "string", enum: ["internal", "external"] },
		lastCommandAt: { type: "string", format: "date-time" },
		lastError: { type: "string" },
		commandCount: { type: "number" },
	},
	required: ["sourceId", "frequency", "sampleRate", "gainMode", "gain", "ppm", "controlMode", "commandCount"],
} as const

export interface TunerRoutesOptions {
	tunerController: TunerController
}

export const tunerRoutes: FastifyPluginAsync<TunerRoutesOptions> = async (
	fastify: FastifyInstance,
	options: TunerRoutesOptions,
) => {
	const { tunerController } = options

	// GET /api/tuner - List all tuner states
	fastify.get<{ Reply: TunerState[] }>(
		"/api/tuner",
		{
			schema: {
				tags: ["tuner"],
				summary: "Get all tuner states",
				description: "Returns tuner state for all RTL-TCP sources",
				response: {
					200: { type: "array", items: tunerStateSchema },
				},
			},
		},
		async () => tunerController.getAllStates(),
	)

	// GET /api/tuner/:sourceId - Get single tuner state
	fastify.get<{ Params: { sourceId: string }; Reply: TunerState }>(
		"/api/tuner/:sourceId",
		{
			schema: {
				tags: ["tuner"],
				summary: "Get tuner state",
				description: "Returns tuner state for a specific source",
				params: {
					type: "object",
					properties: { sourceId: { type: "string" } },
					required: ["sourceId"],
				},
				response: {
					200: tunerStateSchema,
					404: { type: "object", properties: { error: { type: "string" } } },
				},
			},
		},
		async (request, reply) => {
			const state = tunerController.getState(request.params.sourceId)
			if (!state) {
				return reply.status(404).send({ error: `Tuner source not found: ${request.params.sourceId}` })
			}
			return state
		},
	)

	// POST /api/tuner/:sourceId/frequency
	fastify.post<{ Params: { sourceId: string }; Body: SetFrequencyRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/frequency",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set frequency",
				body: { type: "object", properties: { hz: { type: "number" } }, required: ["hz"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setFrequency(request.params.sourceId, request.body.hz)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/gain
	fastify.post<{ Params: { sourceId: string }; Body: SetGainRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/gain",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set gain",
				body: { type: "object", properties: { tenthsDb: { type: "number" } }, required: ["tenthsDb"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setGain(request.params.sourceId, request.body.tenthsDb)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/gain-mode
	fastify.post<{ Params: { sourceId: string }; Body: SetGainModeRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/gain-mode",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set gain mode",
				body: { type: "object", properties: { mode: { type: "string", enum: ["manual", "agc"] } }, required: ["mode"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setGainMode(request.params.sourceId, request.body.mode)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/sample-rate
	fastify.post<{ Params: { sourceId: string }; Body: SetSampleRateRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/sample-rate",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set sample rate",
				body: { type: "object", properties: { hz: { type: "number" } }, required: ["hz"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setSampleRate(request.params.sourceId, request.body.hz)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/ppm
	fastify.post<{ Params: { sourceId: string }; Body: SetPpmRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/ppm",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set PPM correction",
				body: { type: "object", properties: { ppm: { type: "number" } }, required: ["ppm"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setPpm(request.params.sourceId, request.body.ppm)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/agc
	fastify.post<{ Params: { sourceId: string }; Body: SetBooleanRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/agc",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set AGC mode",
				body: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setAgcMode(request.params.sourceId, request.body.enabled)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/bias-tee
	fastify.post<{ Params: { sourceId: string }; Body: SetBooleanRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/bias-tee",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set bias-T power",
				body: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setBiasTee(request.params.sourceId, request.body.enabled)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/direct-sampling
	fastify.post<{ Params: { sourceId: string }; Body: SetDirectSamplingRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/direct-sampling",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set direct sampling mode",
				body: { type: "object", properties: { mode: { type: "string", enum: ["off", "i", "q"] } }, required: ["mode"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setDirectSampling(request.params.sourceId, request.body.mode)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/offset-tuning
	fastify.post<{ Params: { sourceId: string }; Body: SetBooleanRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/offset-tuning",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set offset tuning",
				body: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.setOffsetTuning(request.params.sourceId, request.body.enabled)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// POST /api/tuner/:sourceId/control-mode - Release/reclaim control
	fastify.post<{ Params: { sourceId: string }; Body: SetControlModeRequest; Reply: TunerState }>(
		"/api/tuner/:sourceId/control-mode",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set control mode",
				description: "Set to 'external' to release control to SDR++, 'internal' to reclaim control",
				body: { type: "object", properties: { mode: { type: "string", enum: ["internal", "external"] } }, required: ["mode"] },
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			tunerController.setControlMode(request.params.sourceId, request.body.mode)
			return tunerController.getState(request.params.sourceId)!
		},
	)

	// PATCH /api/tuner/:sourceId/config - Bulk update
	fastify.patch<{ Params: { sourceId: string }; Body: TunerConfigUpdate; Reply: TunerState }>(
		"/api/tuner/:sourceId/config",
		{
			schema: {
				tags: ["tuner"],
				summary: "Update tuner configuration",
				description: "Apply multiple tuner settings at once",
				response: { 200: tunerStateSchema },
			},
		},
		async (request, reply) => {
			await tunerController.configure(request.params.sourceId, request.body)
			return tunerController.getState(request.params.sourceId)!
		},
	)
}
```

---

### Phase 5: WebSocket Events

**Modify:** `src/api/websocket/events.ts`

Add tuner channel (~40 lines):

```typescript
// Add to WebSocketChannel type (line ~34)
export type WebSocketChannel =
	| "decoders"
	| "metrics"
	| "sources"
	| "health"
	| "fanout"
	| "live-audio"
	| "resources"
	| "tuner"      // <-- Add this

// Add to ServerMessage type (line ~54)
export interface ServerMessage {
	type:
		| ...existing types...
		| "tuner:state-changed"
		| "tuner:command-sent"
		| "tuner:control-mode-changed"
		| "tuner:error"
	// ...rest
}

// Add to isValidChannel function (line ~91)
const VALID_CHANNELS = new Set([
	"decoders", "metrics", "sources", "health", "fanout", "live-audio", "resources", "tuner",
])

// Add broadcast methods to WebSocketEventBroadcaster class
broadcastTunerStateChanged(sourceId: string, state: TunerState): void {
	this.broadcast("tuner", {
		type: "tuner:state-changed",
		channel: "tuner",
		data: { sourceId, state },
	})
}

broadcastTunerCommandSent(sourceId: string, command: string, value: number): void {
	this.broadcast("tuner", {
		type: "tuner:command-sent",
		channel: "tuner",
		data: { sourceId, command, value },
	})
}

broadcastTunerControlModeChanged(sourceId: string, mode: string): void {
	this.broadcast("tuner", {
		type: "tuner:control-mode-changed",
		channel: "tuner",
		data: { sourceId, mode },
	})
}

broadcastTunerError(sourceId: string, error: string): void {
	this.broadcast("tuner", {
		type: "tuner:error",
		channel: "tuner",
		data: { sourceId, error },
	})
}
```

---

### Phase 6: API Server Integration

**Modify:** `src/api/server.ts`

Add TunerController to dependencies and wire routes:

```typescript
// Add import (line ~30)
import type { TunerController } from "../core/tuner-controller.js"
import { tunerRoutes } from "./routes/tuner.js"

// Add to ApiServerDependencies interface (line ~59)
export interface ApiServerDependencies {
	// ...existing...
	tunerController?: TunerController | undefined
}

// Add to class fields (line ~90)
private readonly tunerController?: TunerController | undefined

// Wire in constructor (line ~97)
this.tunerController = dependencies.tunerController

// Add getter (line ~230)
getTunerController(): TunerController | undefined {
	return this.tunerController
}

// Wire events in setupEventBroadcasting (line ~258)
if (this.tunerController) {
	this.tunerController.on("state-changed", (sourceId, state) => {
		this.wsBroadcaster.broadcastTunerStateChanged(sourceId, state)
	})

	this.tunerController.on("command-sent", (sourceId, command, value) => {
		this.wsBroadcaster.broadcastTunerCommandSent(sourceId, command, value)
	})

	this.tunerController.on("control-mode-changed", (sourceId, mode) => {
		this.wsBroadcaster.broadcastTunerControlModeChanged(sourceId, mode)
	})

	this.tunerController.on("error", (sourceId, error) => {
		this.wsBroadcaster.broadcastTunerError(sourceId, error.message)
	})
}

// Register routes in registerRoutes (line ~572, after tunerRelayRoutes)
if (this.tunerController) {
	await this.app.register(tunerRoutes, {
		tunerController: this.tunerController,
	})
}
```

---

### Phase 7: Application Integration

**Modify:** `src/index.ts`

Add TunerController to main bootstrap:

```typescript
// Add import (line ~20)
import { TunerController } from "./core/tuner-controller.js"

// Create after SourceManager (around line ~280)
const tunerController = new TunerController(logger, sourceManager, {})

// Wire source events (around line ~350)
sourceManager.on("connected", sourceId => {
	if (sourceManager.isRtlTcpSource(sourceId)) {
		tunerController.initializeSource(sourceId)
	}
})

sourceManager.on("disconnected", sourceId => {
	tunerController.removeSource(sourceId)
})

// Add to ApiServer dependencies (around line ~400)
const apiServer = new ApiServer(
	{
		// ...existing...
		tunerController,
	},
	apiConfig,
)
```

---

### Phase 8: CLI Dashboard - Scalable Tabs

**Modify:** `cli/source/components/tab-bar.tsx`

Make tabs scalable and rename "Live Audio" → "Audio":

```typescript
// Update tab definitions with shorter names
const TABS: { view: View; label: string; shortLabel: string; key: string }[] = [
	{ view: "dashboard", label: "Dashboard", shortLabel: "Dash", key: "1" },
	{ view: "decoders", label: "Decoders", shortLabel: "Dec", key: "2" },
	{ view: "output", label: "Output", shortLabel: "Out", key: "3" },
	{ view: "backpressure", label: "Backpressure", shortLabel: "BP", key: "4" },
	{ view: "sources", label: "Sources", shortLabel: "Src", key: "5" },
	{ view: "live-audio", label: "Audio", shortLabel: "Aud", key: "6" },  // Renamed
	{ view: "resources", label: "Resources", shortLabel: "Res", key: "7" },
	{ view: "tuner", label: "Tuner", shortLabel: "Tun", key: "8" },  // New
]

// Render tabs with dynamic sizing based on terminal width
// Use shortLabel when width < threshold
```

---

### Phase 9: CLI Dashboard - Tuner Panel

**Create:** `cli/source/components/tuner-panel.tsx` (~300 lines)

Key features:
- Source selector (Tab to cycle when multiple RTL-TCP sources)
- Frequency display with step adjustment (brackets to change step)
- Arrow keys to tune up/down
- Gain control (+/- keys)
- Toggle controls (g=gain mode, a=AGC, b=bias-tee, d=direct sampling, o=offset)
- Control mode toggle (c=toggle internal/external)
- Visual indication of control mode (green="internal", yellow="external/SDR++ controls")
- Command counter and last command timestamp

```
┌─TUNER─────────────────────────────────────────────────────────────┐
│ Source: rtl-pi • Control: INTERNAL                               │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  FREQUENCY   144.800.000 Hz                                       │
│              Step: 100 kHz        ↑/↓ tune   [/] change step      │
│                                                                   │
│  GAIN        Mode: AGC            [g] toggle                      │
│              Level: 40.0 dB       +/- adjust (when manual)        │
│                                                                   │
│  CORRECTIONS PPM: 0               [p] adjust                      │
│              AGC: on              [a] toggle                      │
│                                                                   │
│  ADVANCED    Bias-T: off          [b] toggle                      │
│              Direct: off          [d] cycle off→I→Q               │
│              Offset: off          [o] toggle                      │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│ [c] Release control to SDR++   Commands: 42   Last: 17:30:05     │
└───────────────────────────────────────────────────────────────────┘
```

When `controlMode === "external"`:
```
│ Source: rtl-pi • Control: EXTERNAL (SDR++ has control)           │
...
│ [c] Reclaim control from SDR++                                    │
```

**Modify:** `cli/source/app.tsx`

```typescript
// Update viewMap (line ~369)
const viewMap: Record<string, View> = {
	"1": "dashboard",
	"2": "decoders",
	"3": "output",
	"4": "backpressure",
	"5": "sources",
	"6": "live-audio",
	"7": "resources",
	"8": "tuner",  // <-- Add
}

// Add to AppState (line ~47)
interface AppState {
	// ...existing...
	tunerStates: TunerState[]
}

// Subscribe to tuner channel (line ~236)
channels: [...existing, "tuner"],

// Handle tuner messages in handleMessage
case "tuner:state-changed": {
	const data = msg.data as { sourceId: string; state: TunerState } | undefined
	if (data?.state) {
		setState(prev => ({
			...prev,
			tunerStates: [
				...prev.tunerStates.filter(s => s.sourceId !== data.sourceId),
				data.state,
			],
		}))
	}
	break
}

// Add tuner-specific key handlers when activeView === "tuner"
// ... (in useInput callback around line ~344)

// Add renderView case (line ~440)
case "tuner":
	return <TunerPanel states={state.tunerStates} onCommand={performTunerAction} />
```

---

## Validation Rules

| Parameter | Min | Max | Unit | Notes |
|-----------|-----|-----|------|-------|
| frequency | 24,000,000 | 1,900,000,000 | Hz | RTL-SDR tuning range |
| sampleRate | 225,001 | 3,200,000 | Hz | Hardware limits |
| gain | 0 | 500 | 0.1 dB | 0 = 0dB, 500 = 50dB |
| ppm | -500 | 500 | PPM | Typical crystal range |
| directSampling | — | — | enum | off, i, q |

---

## Error Handling Strategy

1. **Validation errors**: Return 400 with specific message before sending command
2. **Source not found**: Return 404 with helpful message listing available sources
3. **Control mode external**: Return 409 "Cannot send commands: control released to external tuner"
4. **Write failures**: Log error, emit `error` event, update `lastError` in state
5. **Connection lost**: State preserved, commands will fail with clear error message

---

## Testing

### Unit Tests — `tests/unit/core/tuner-controller.test.ts` (~350 lines)

```typescript
describe("TunerController", () => {
	describe("command encoding", () => {
		it("encodes SET_FREQUENCY correctly", () => {
			// Verify 5-byte format: [0x01][144800000 as u32be]
		})
		// Test all 15 commands
	})

	describe("state management", () => {
		it("initializes source with default state", () => {})
		it("removes source on disconnect", () => {})
		it("maintains separate state per source", () => {})
	})

	describe("validation", () => {
		it("rejects frequency below 24MHz", () => {})
		it("rejects frequency above 1.9GHz", () => {})
		it("rejects negative gain", () => {})
		it("rejects ppm outside -500 to 500", () => {})
	})

	describe("control mode", () => {
		it("allows commands when controlMode is internal", () => {})
		it("rejects commands when controlMode is external", () => {})
		it("emits control-mode-changed event", () => {})
	})

	describe("events", () => {
		it("emits state-changed on frequency update", () => {})
		it("emits command-sent with command name", () => {})
		it("emits error on write failure", () => {})
	})
})
```

### Unit Tests — `tests/unit/api/tuner-routes.test.ts` (~250 lines)

```typescript
describe("tuner routes", () => {
	describe("GET /api/tuner", () => {
		it("returns empty array when no sources", () => {})
		it("returns all tuner states", () => {})
	})

	describe("GET /api/tuner/:sourceId", () => {
		it("returns 404 for unknown source", () => {})
		it("returns tuner state", () => {})
	})

	describe("POST /api/tuner/:sourceId/frequency", () => {
		it("returns 400 for out-of-range frequency", () => {})
		it("returns updated state on success", () => {})
	})

	describe("POST /api/tuner/:sourceId/control-mode", () => {
		it("switches to external mode", () => {})
		it("switches back to internal mode", () => {})
	})

	// ... all endpoints
})
```

### Integration Test

```bash
# 1. Start rtl_tcp
rtl_tcp -a 127.0.0.1 -p 1234

# 2. Configure WaveKit source
# config/wavekit.yaml:
# sources:
#   - id: rtl-local
#     type: rtl_tcp
#     host: 127.0.0.1
#     port: 1234
#     caps:
#       kind: iq
#       format: U8_IQ
#       sampleRate: 2400000

# 3. Test API
curl http://localhost:9000/api/tuner
curl -X POST http://localhost:9000/api/tuner/rtl-local/frequency \
  -H 'Content-Type: application/json' -d '{"hz": 144800000}'
curl http://localhost:9000/api/tuner/rtl-local

# 4. Test control release
curl -X POST http://localhost:9000/api/tuner/rtl-local/control-mode \
  -H 'Content-Type: application/json' -d '{"mode": "external"}'
# Now SDR++ connected to TunerRelay can control

# 5. Reclaim control
curl -X POST http://localhost:9000/api/tuner/rtl-local/control-mode \
  -H 'Content-Type: application/json' -d '{"mode": "internal"}'
```

---

## Files Summary

### New Files (5)
| File | Est. Lines | Purpose |
|------|-----------|---------|
| `src/core/tuner-controller.ts` | ~400 | Core tuner control logic |
| `src/api/routes/tuner.ts` | ~250 | REST API endpoints |
| `cli/source/components/tuner-panel.tsx` | ~300 | Interactive CLI panel |
| `tests/unit/core/tuner-controller.test.ts` | ~350 | Unit tests |
| `tests/unit/api/tuner-routes.test.ts` | ~250 | API route tests |

### Modified Files (9)
| File | Changes | Purpose |
|------|---------|---------|
| `packages/api-types/src/tuner.ts` | +60 lines | Add TunerController types |
| `packages/api-types/src/index.ts` | +1 line | Re-export (already exports tuner.ts) |
| `src/core/source-manager.ts` | +10 lines | Add `isRtlTcpSource()` |
| `src/api/server.ts` | +30 lines | Wire TunerController |
| `src/api/websocket/events.ts` | +50 lines | Add tuner channel |
| `src/index.ts` | +25 lines | Wire lifecycle |
| `cli/source/app.tsx` | +60 lines | Add tuner tab + state + handlers |
| `cli/source/components/tab-bar.tsx` | +20 lines | Scalable tabs, rename Audio |

---

## Success Criteria

- [ ] All 15 RTL-TCP commands implemented and tested
- [ ] Per-source state management working (multiple RTL-TCP sources)
- [ ] Control mode toggle (internal/external) working
- [ ] API endpoints respond with correct status codes
- [ ] WebSocket broadcasts state changes to subscribed clients
- [ ] CLI tuner tab with keyboard controls functional
- [ ] Tab bar scales gracefully (doesn't overflow)
- [ ] Works with rtl_tcp and rtlmux sources
- [ ] SDR++ can take over when control released
- [ ] WaveKit can reclaim control from SDR++
- [ ] Passes `pnpm ws:typecheck` and `pnpm ws:lint`
- [ ] All new unit tests pass
- [ ] No regression in existing TunerRelay functionality

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1-3: Types + Core + SourceManager | 2-3 hours |
| Phase 4-6: API + WebSocket + Server | 2-3 hours |
| Phase 7: Application Integration | 1 hour |
| Phase 8-9: CLI Dashboard + Tab Scaling | 3-4 hours |
| Testing (Unit + Integration) | 2-3 hours |
| **Total** | **10-14 hours** |
