import type {
	ReceiverControlEvidence,
	ReceiverHeaderEvidence,
} from "@wavekit/api-types"
import {
	freezeReceiverData,
	isDetachedPlainData,
	receiverPolicySchema,
} from "./types.js"
import type {
	ReceiverRestCommandPolicy,
	SourceReceiverEvidence,
} from "./types.js"

/** Protocol metadata only: no admitted numeric argument bounds or hardware facts. */
export const RECEIVER_CONTROL_METADATA = freezeReceiverData([
	{ id: "frequency", unit: "Hz", opcode: 1, kind: "integer-range" },
	{ id: "sampleRate", unit: "Hz", opcode: 2, kind: "integer-ranges" },
	{ id: "gainMode", unit: "enum", opcode: 3, kind: "enum" },
	{ id: "gain", unit: "tenthsDb", opcode: 4, kind: "integer-range" },
	{ id: "ppm", unit: "ppm", opcode: 5, kind: "integer-range" },
	{ id: "ifGain", unit: "rawInteger", opcode: 6, kind: "integer-range" },
	{ id: "testMode", unit: "boolean", opcode: 7, kind: "boolean" },
	{ id: "agcMode", unit: "boolean", opcode: 8, kind: "boolean" },
	{ id: "directSampling", unit: "enum", opcode: 9, kind: "enum" },
	{ id: "offsetTuning", unit: "boolean", opcode: 10, kind: "boolean" },
	{ id: "rtlXtal", unit: "Hz", opcode: 11, kind: "integer-range" },
	{ id: "tunerXtal", unit: "Hz", opcode: 12, kind: "integer-range" },
	{ id: "gainIndex", unit: "index", opcode: 13, kind: "integer-range" },
	{ id: "biasTee", unit: "boolean", opcode: 14, kind: "boolean" },
	{ id: "tunerIfGain", unit: "stageRawPair", opcode: 15, kind: "uint16-pair" },
] as const)

/** Detach and validate once, before any evidence read. No production fallback. */
export function prepareReceiverPolicy(
	input: ReceiverRestCommandPolicy,
): ReceiverRestCommandPolicy | null {
	if (!isDetachedPlainData(input)) return null
	const parsed = receiverPolicySchema.safeParse(input)
	if (!parsed.success) return null
	for (let i = 0; i < RECEIVER_CONTROL_METADATA.length; i++) {
		const expected = RECEIVER_CONTROL_METADATA[i]
		const row = parsed.data[i]
		if (
			!row ||
			!expected ||
			row.id !== expected.id ||
			row.opcode !== expected.opcode ||
			row.unit !== expected.unit ||
			row.rule.kind !== expected.kind
		)
			return null
		if (row.rule.kind === "integer-ranges") {
			const [first, second] = row.rule.ranges
			if (first.max >= second.min) return null
		}
		if (row.rule.kind === "enum") {
			const values =
				row.id === "gainMode" ? ["manual", "agc"] : ["off", "i", "q"]
			if (
				row.rule.values.length !== values.length ||
				values.some(
					(value, index) =>
						row.rule.kind !== "enum" || row.rule.values[index] !== value,
				)
			)
				return null
		}
	}
	return freezeReceiverData(parsed.data)
}

/** Accept exactly a detached RTL0 capture, never ASCII's high-bit masking. */
export function parseRtlPeerHeader(
	bytes: Buffer,
): { readonly tunerType: number; readonly gainCount: number } | null {
	if (
		!Buffer.isBuffer(bytes) ||
		bytes.length !== 12 ||
		bytes[0] !== 0x52 ||
		bytes[1] !== 0x54 ||
		bytes[2] !== 0x4c ||
		bytes[3] !== 0x30
	)
		return null
	return Object.freeze({
		tunerType: bytes.readUInt32BE(4),
		gainCount: bytes.readUInt32BE(8),
	})
}

/** Evidence invariants are validated by the provider before this projection. */
export function projectReceiverHeader(
	evidence: SourceReceiverEvidence,
): ReceiverHeaderEvidence {
	if (evidence.source.type !== "rtl_tcp")
		return { state: "not-applicable", reason: "non-rtl-transport" }
	if (evidence.source.kind !== "iq")
		return { state: "not-applicable", reason: "non-iq-source" }
	if (evidence.source.format !== "U8_IQ")
		return { state: "unknown", reason: "format-not-captured" }
	if (evidence.connection !== "connected")
		return { state: "unknown", reason: "not-connected" }
	if (evidence.header.capture === "partial")
		return { state: "unknown", reason: "partial-header" }
	if (evidence.header.capture !== "complete")
		return { state: "unknown", reason: "awaiting-header" }
	const parsed =
		evidence.header.bytes === null
			? null
			: parseRtlPeerHeader(evidence.header.bytes)
	if (
		!parsed ||
		evidence.sessionId === null ||
		evidence.header.capturedAt === null
	)
		return { state: "unknown", reason: "invalid-header" }
	return {
		state: "advertised",
		provenance: "rtl-peer-header",
		sessionId: evidence.sessionId,
		observedAt: new Date(evidence.header.capturedAt).toISOString(),
		...parsed,
	}
}

export function projectReceiverControls(
	policy: ReceiverRestCommandPolicy,
	rtlTransport: boolean,
): ReceiverControlEvidence[] {
	return policy.map(row => ({
		id: row.id,
		unit: row.unit,
		command: {
			state: "implemented",
			opcode: row.opcode,
			validation: {
				authority: "admitted-rest-argument-policy",
				rule: structuredClone(row.rule),
			},
		},
		transport: rtlTransport
			? { state: "applicable", reason: "rtl-tcp" }
			: { state: "not-applicable", reason: "non-rtl-transport" },
		physical: { state: "unknown", reason: "no-qualified-readback" },
		currentValue: {
			state: "unknown",
			reason: "session-qualified-command-evidence-not-provided",
		},
	}))
}
