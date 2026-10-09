/**
 * Opt-in bounded CSDR ring buffers.
 *
 * The pinned CSDR allocates one ring per CLI process: 10,485,760 elements for
 * most commands and ten times that for `firdecimate` (800 MiB of complex float
 * backing). Rings are shared /dev/zero mappings, so every touched page stays
 * resident as shmem while the stage runs. WaveKit's patched CSDR
 * (scripts/native-patches/csdr-buffer-elements.patch) accepts
 * WAVEKIT_CSDR_BUFFER_ELEMENTS to shrink that ring.
 *
 * The variable is applied per stage, never process-wide, and only to stages
 * whose output was shown byte-identical to upstream by
 * scripts/native-patches/test_csdr_buffers.py:
 *
 * - `firdecimate` — the patch validates its lookahead minimum; WaveKit also
 *   computes that minimum. When the configured ring is too small it keeps
 *   the upstream ring rather than letting the stage fail at start, and the
 *   builders log that fallback at info (boundCsdrPipeline).
 * - `convert`, `fmdemod`, `amdemod`, `agc`, `dcblock`, `gain`, `limit`,
 *   `realpart` — CSDR AnyLengthModule stages with no retained input window.
 * - `shift` (offsetHz mixer, ShiftAddfast) — a FixedLengthModule of 1024
 *   samples with no filter window. canProcess needs more than 1024 elements,
 *   so up to 1024 stay unread while the runner reads 1024 more: the patch
 *   rejects a 2048 ring, and 2050+ was byte-identical to upstream
 *   (scripts/native-patches/results/2026-10-09-csdr-shift-test.json). Below
 *   2050 it keeps the upstream ring (reported like a firdecimate fallback).
 *
 * Stages left at the upstream default, and why:
 * - `lowpass`, `deemphasis` (NFM is a FIR FilterModule), `bandpass --fft`,
 *   `fft` and anything else: either they retain a filter/FFT window
 *   the patch does not size (only the runtime overrun guard protects them) or
 *   the harness does not cover them. Fixed WFM deemphasis is excluded with the
 *   NFM form to keep one rule per command.
 * - Any stage using `--async`: the patch rejects asynchronous mode.
 */

import type { Logger } from "../utils/logger.js"

/** Native setting read by the patched CSDR binary. */
export const CSDR_BUFFER_ENV = "WAVEKIT_CSDR_BUFFER_ELEMENTS"

/** Bounds enforced by the native patch. */
export const CSDR_BUFFER_MIN_ELEMENTS = 2048
export const CSDR_BUFFER_MAX_ELEMENTS = 10_485_760

/** CSDR's synchronous runner reads at most this many elements per iteration. */
const CSDR_READ_BATCH = 1024

/** `csdr shift` ring minimum: 1024 unread + a 1024 read + the empty slot (+1). */
export const CSDR_SHIFT_MINIMUM_ELEMENTS = 2050

export interface CsdrBufferPolicy {
	enabled: boolean
	/** Ring size in input elements for bounded stages. */
	elements: number
}

export const DISABLED_CSDR_BUFFER_POLICY: CsdrBufferPolicy = Object.freeze({
	enabled: false,
	elements: 65536,
})

/** AnyLengthModule commands with no retained input window. */
const STREAMING_COMMANDS = new Set([
	"convert",
	"fmdemod",
	"amdemod",
	"agc",
	"dcblock",
	"gain",
	"limit",
	"realpart",
])

/**
 * Minimum ring for `csdr firdecimate`, mirroring the native patch:
 * ceil(4 / float(transition)) + 1 taps, the decimation window, one read batch.
 * Returns null for arguments the native command would reject.
 */
export function firDecimateMinimumElements(
	decimation: number,
	transition: number,
): number | null {
	if (!Number.isInteger(decimation) || decimation <= 0) return null
	const transitionFloat = Math.fround(transition)
	if (!Number.isFinite(transitionFloat) || transitionFloat <= 0) return null
	const lookahead = Math.ceil(4 / transitionFloat) + 1
	return lookahead + decimation + CSDR_READ_BATCH
}

function parseNumber(token: string | undefined): number | null {
	if (
		token === undefined ||
		!/^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(token)
	)
		return null
	return Number(token)
}

type StageDecision =
	| { kind: "bounded" }
	| { kind: "upstream" }
	| { kind: "firFallback"; minimum: number }

function classifyStage(stage: string, elements: number): StageDecision {
	const upstream: StageDecision = { kind: "upstream" }
	const tokens = stage.trim().split(/\s+/)
	if (tokens[0] !== "csdr") return upstream
	const command = tokens[1]
	if (command === undefined || command.startsWith("-")) return upstream
	if (tokens.includes("--async")) return upstream
	if (STREAMING_COMMANDS.has(command)) return { kind: "bounded" }
	if (command === "shift") {
		return elements >= CSDR_SHIFT_MINIMUM_ELEMENTS
			? { kind: "bounded" }
			: { kind: "firFallback", minimum: CSDR_SHIFT_MINIMUM_ELEMENTS }
	}
	if (command !== "firdecimate") return upstream
	const decimation = parseNumber(tokens[2])
	// Upstream default transition when omitted.
	const transition =
		tokens[3] === undefined || tokens[3].startsWith("-")
			? 0.05
			: parseNumber(tokens[3])
	if (decimation === null || transition === null) return upstream
	const minimum = firDecimateMinimumElements(decimation, transition)
	if (minimum === null) return upstream
	return elements >= minimum
		? { kind: "bounded" }
		: { kind: "firFallback", minimum }
}

/**
 * Prefixes one shell pipeline stage with the native ring setting when the
 * policy is enabled and the stage is validated. Never alters the stage itself.
 */
export function boundCsdrStage(
	stage: string,
	policy: CsdrBufferPolicy,
): string {
	if (!policy.enabled) return stage
	return classifyStage(stage, policy.elements).kind === "bounded"
		? `${CSDR_BUFFER_ENV}=${policy.elements} ${stage}`
		: stage
}

/**
 * A stage (firdecimate or shift) kept on its upstream ring because
 * bufferElements is below its minimum.
 */
export interface CsdrFirFallback {
	stage: string
	/** Elements the native patch requires for this filter. */
	minimumElements: number
	configuredElements: number
}

export interface BoundCsdrStages {
	stages: string[]
	/** Always empty while the policy is disabled. */
	firFallbacks: CsdrFirFallback[]
}

export function boundCsdrStages(
	stages: readonly string[],
	policy: CsdrBufferPolicy = activePolicy,
): BoundCsdrStages {
	const firFallbacks: CsdrFirFallback[] = []
	const bounded = stages.map(stage => {
		if (!policy.enabled) return stage
		const decision = classifyStage(stage, policy.elements)
		if (decision.kind === "firFallback") {
			firFallbacks.push({
				stage,
				minimumElements: decision.minimum,
				configuredElements: policy.elements,
			})
		}
		return decision.kind === "bounded"
			? `${CSDR_BUFFER_ENV}=${policy.elements} ${stage}`
			: stage
	})
	return { stages: bounded, firFallbacks }
}

/**
 * Bounds a pipeline's stages and returns them joined with " | ". Logs at info
 * for each firdecimate or shift that stays on its upstream ring while the
 * policy is enabled, so the fallback is never silent.
 */
export function boundCsdrPipeline(
	stages: readonly string[],
	logger: Pick<Logger, "info">,
	policy: CsdrBufferPolicy = activePolicy,
): string {
	const result = boundCsdrStages(stages, policy)
	for (const fallback of result.firFallbacks) {
		logger.info(
			fallback,
			"csdr stage keeps the upstream ring: csdr.bufferElements is below its minimum",
		)
	}
	return result.stages.join(" | ")
}

let activePolicy: CsdrBufferPolicy = DISABLED_CSDR_BUFFER_POLICY

/**
 * Set once at startup from the validated `csdr` config section. This must run
 * before any pipeline builder (decoder start, live demod start): builders
 * read the policy each time they build a command.
 */
export function configureCsdrBuffers(policy: CsdrBufferPolicy): void {
	activePolicy = Object.freeze({ ...policy })
}

export function getCsdrBufferPolicy(): CsdrBufferPolicy {
	return activePolicy
}

/**
 * Environment for decoder/DSP shells. An inherited native setting would apply
 * to every CSDR stage, including unvalidated ones, so it is removed; bounded
 * stages receive it explicitly via boundCsdrStage().
 */
export function csdrChildEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const { [CSDR_BUFFER_ENV]: _ignored, ...rest } = env
	return rest
}
