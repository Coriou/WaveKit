/**
 * dsd-fme confirm interpreter (spec § 6.4, § 6.6, H2): `link` lines drive acceptance (second
 * CRC-clean line with the same value); call events add the call id once an identity is accepted.
 */
import { z } from "zod"
import type { DsdFmeLinkLine } from "../../../../decoders/builtin/dsd-fme-link.js"
import type {
	DecodeEvidence,
	DiscoveryMetadataInput,
	IdentityKind,
	ScannerProtocol,
} from "../../types.js"
import { DQ_DC_ADMIT_HZ } from "../../detection-quality-contract.js"
import { evidenceBase } from "./double-match.js"
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"

const CallDataSchema = z
	.object({
		callId: z.string().min(1),
		protocol: z
			.enum([
				"dmr",
				"p25p1",
				"p25p2",
				"ysf",
				"dstar",
				"nxdn48",
				"nxdn96",
				"provoice",
			])
			.nullable(),
		talkgroup: z.number().nullable().optional(),
		source: z.number().nullable().optional(),
		slot: z.number().optional(),
		encrypted: z.boolean().optional(),
		startedAt: z.string().optional(),
		endedAt: z.string().optional(),
		duration: z.number().optional(),
		wavFile: z.string().optional(),
		flags: z
			.object({
				encrypted: z.boolean().optional(),
				falsePositiveSuppressed: z.boolean().optional(),
				wavFileUpdate: z.boolean().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough()

/** Internal flag consumed by the DC gate before evidence enters the public DTO. */
export type DsdFmeDecodeEvidence = DecodeEvidence & { voiceLc?: boolean }

export type DsdFmeCallData = z.infer<typeof CallDataSchema>
export type DsdFmeScannerEvent =
	| { kind: "link"; line: DsdFmeLinkLine }
	| { kind: "call_start" | "call_end"; at: number; call: DsdFmeCallData }

const IDENTITY_KIND: Partial<Record<ScannerProtocol, IdentityKind>> = {
	dmr: "dmr-cc",
	p25p1: "p25-nac",
	nxdn48: "nxdn-ran",
	nxdn96: "nxdn-ran",
	ysf: "ysf-dgid",
	dstar: "dstar-call",
	dpmr: "dpmr-cc",
}

export function toDsdFmeScannerEvent(
	out: DecoderOutputLike,
): DsdFmeScannerEvent | null {
	if (out.type !== "call_start" && out.type !== "call_end") return null
	const parsed = CallDataSchema.safeParse(out.data)
	if (!parsed.success) return null
	return { kind: out.type, at: out.timestamp.getTime(), call: parsed.data }
}

function linkProtocol(
	p: DsdFmeLinkLine["protocol"],
	state: InterpreterState,
): ScannerProtocol {
	switch (p) {
		case "dmr":
			return "dmr"
		case "p25":
			return "p25p1"
		case "nxdn":
			return state.nxdn
		case "ysf":
			return "ysf"
		case "dstar":
			return "dstar"
		case "dpmr":
			return "dpmr"
	}
}

function identityValue(line: DsdFmeLinkLine): string | undefined {
	switch (line.protocol) {
		case "dmr":
		case "dpmr":
			return line.cc !== undefined ? String(line.cc) : undefined
		case "p25":
			return line.nac !== undefined && line.nac.trim() !== ""
				? line.nac.trim().toUpperCase()
				: undefined
		case "nxdn":
			return line.ran !== undefined ? String(line.ran) : undefined
		case "ysf":
			return line.dgid !== undefined ? String(line.dgid) : undefined
		case "dstar": {
			const call = line.callsign?.trim().toUpperCase()
			return call !== undefined && call !== "" ? call : undefined
		}
	}
}

/** Identity key protocol for a call event (P25 phase 2 and both NXDN share the link-line key). */
function keyProtocol(
	p: DsdFmeCallData["protocol"],
	state: InterpreterState,
): ScannerProtocol | null {
	switch (p) {
		case "dmr":
		case "ysf":
		case "dstar":
			return p
		case "p25p1":
		case "p25p2":
			return "p25p1"
		case "nxdn48":
		case "nxdn96":
			return state.nxdn
		default:
			return null
	}
}

function build(
	protocol: ScannerProtocol,
	state: InterpreterState,
	at: number,
	metadata: Partial<DiscoveryMetadataInput>,
	encrypted: boolean,
	idProtocol: ScannerProtocol = protocol,
): DsdFmeDecodeEvidence {
	const ev: DsdFmeDecodeEvidence = {
		...evidenceBase(state, at),
		contentVerified: true,
		protocol,
		metadata,
	}
	const value = state.accepted.get(`${idProtocol}:id`)
	const kind = IDENTITY_KIND[idProtocol]
	if (value !== undefined && kind !== undefined) ev.identity = { kind, value }
	if (encrypted) ev.encrypted = true
	return ev
}

function interpretLink(
	line: DsdFmeLinkLine,
	state: InterpreterState,
): DsdFmeDecodeEvidence[] {
	const protocol = linkProtocol(line.protocol, state)
	// Missing verification on old/malformed events is the weaker answer.
	const clean =
		line.verified === true && line.crcErr === false && (line.fecErrs ?? 0) === 0
	if (!clean) {
		// A call DTO must not revive an identity from an earlier checked burst.
		state.accepted.delete(`${protocol}:id`)
		if (line.crcErr || (line.fecErrs ?? 0) > 0) return []
		const ev: DecodeEvidence = {
			...evidenceBase(state, line.at),
			protocol,
			metadata: {},
		}
		if (
			line.protocol === "dmr" &&
			Number.isInteger(line.cc) &&
			line.cc !== undefined &&
			line.cc >= 0 &&
			line.cc <= 15
		) {
			const key = `dmr:hint:${line.cc}`
			state.accepted.set(key, String(Number(state.accepted.get(key) ?? 0) + 1))
		}
		if (line.protocol === "dmr") {
			let count = 0
			for (let cc = 0; cc < 16; cc++) {
				const seen = Number(state.accepted.get(`dmr:hint:${cc}`) ?? 0)
				if (seen > count) {
					count = seen
					ev.unverifiedCc = cc
				}
			}
		}
		return [ev]
	}
	const m = state.match
	const metadata: Partial<DiscoveryMetadataInput> = {}
	let hits = false
	let encrypted = false
	/** A clean line confirms a value already accepted, or accepts it on its second clean occurrence (H2). */
	const hit = (key: string, value: string): boolean => {
		const yes =
			(clean && m.isAccepted(key, value)) || m.accept(key, value, clean)
		if (yes) hits = true
		return yes
	}
	const id = identityValue(line)
	if (id !== undefined && hit(`${protocol}:id`, id)) {
		state.accepted.set(`${protocol}:id`, id)
		if (line.protocol === "dstar") metadata.callsigns = [id]
	}
	if (line.tg !== undefined && hit(`${protocol}:tg`, line.tg))
		metadata.talkgroups = [line.tg]
	if (line.src !== undefined && hit(`${protocol}:src`, line.src))
		metadata.sources = [line.src]
	if (line.slot !== undefined && hit(`${protocol}:slot`, String(line.slot)))
		metadata.slots = [line.slot]
	if (line.protocol !== "dstar" && line.callsign !== undefined) {
		const call = line.callsign.trim().toUpperCase()
		if (call !== "" && hit(`${protocol}:call`, call))
			metadata.callsigns = [call]
	}
	if (line.encrypted === true && hit(`${protocol}:enc`, "1")) encrypted = true
	if (!hits) return []
	const ev = build(protocol, state, line.at, metadata, encrypted)
	if (
		line.protocol === "dmr" &&
		(id === undefined || !m.isAccepted(`${protocol}:id`, id))
	) {
		delete ev.identity
		state.accepted.delete(`${protocol}:id`)
	}
	if (
		line.voiceLc === true &&
		metadata.talkgroups?.length &&
		metadata.sources?.length
	) {
		ev.voiceLc = true
		state.accepted.set(`${protocol}:lc:${line.tg}:${line.src}`, "1")
	}
	return [ev]
}

function interpretCall(
	ev: Extract<DsdFmeScannerEvent, { kind: "call_start" | "call_end" }>,
	state: InterpreterState,
): DsdFmeDecodeEvidence[] {
	const c = ev.call
	if (
		c.flags?.falsePositiveSuppressed === true ||
		c.flags?.wavFileUpdate === true
	)
		return []
	const key = keyProtocol(c.protocol, state)
	if (key === null || c.protocol === null || c.protocol === "provoice")
		return []
	if (!state.accepted.has(`${key}:id`)) return []
	const metadata: Partial<DiscoveryMetadataInput> = {}
	const tg =
		c.talkgroup !== null && c.talkgroup !== undefined
			? String(c.talkgroup)
			: undefined
	const src =
		c.source !== null && c.source !== undefined ? String(c.source) : undefined
	if (tg !== undefined && state.match.isAccepted(`${key}:tg`, tg))
		metadata.talkgroups = [tg]
	if (src !== undefined && state.match.isAccepted(`${key}:src`, src))
		metadata.sources = [src]
	const claimsEncrypted = c.encrypted === true || c.flags?.encrypted === true
	const encrypted = claimsEncrypted && state.match.isAccepted(`${key}:enc`, "1")
	const protocol: ScannerProtocol =
		c.protocol === "nxdn48" || c.protocol === "nxdn96" ? state.nxdn : c.protocol
	return [
		{
			...build(protocol, state, ev.at, metadata, encrypted, key),
			callId: c.callId,
			...(state.accepted.get(`${key}:lc:${tg}:${src}`) === "1" &&
			metadata.talkgroups?.length &&
			metadata.sources?.length
				? { voiceLc: true }
				: {}),
		},
	]
}

export function interpretDsdFme(
	ev: DsdFmeScannerEvent,
	state: InterpreterState,
): DsdFmeDecodeEvidence[] {
	return ev.kind === "link"
		? interpretLink(ev.line, state)
		: interpretCall(ev, state)
}

/** Reuse the scanner DC admission width; sync/headers at DC need paired voice LC. */
export function guardDsdFmeEvidence(
	ev: DecodeEvidence,
	targetHz: number,
	centreHz: number | undefined,
): DecodeEvidence {
	const { voiceLc, ...publicEvidence } = ev as DsdFmeDecodeEvidence
	if (
		!isDsdFmeProtocol(ev.protocol) ||
		(voiceLc === true &&
			ev.metadata.talkgroups?.length &&
			ev.metadata.sources?.length)
	)
		return publicEvidence
	if (
		centreHz !== undefined &&
		Number.isFinite(centreHz) &&
		Number.isFinite(targetHz) &&
		Math.abs(targetHz - centreHz) > DQ_DC_ADMIT_HZ
	)
		return publicEvidence
	const {
		identity: _identity,
		callId: _callId,
		encrypted: _encrypted,
		...rest
	} = publicEvidence
	return { ...rest, contentVerified: false, metadata: {} }
}

export function isDsdFmeProtocol(protocol: ScannerProtocol): boolean {
	return [
		"dmr",
		"p25p1",
		"p25p2",
		"nxdn48",
		"nxdn96",
		"ysf",
		"dstar",
		"dpmr",
	].includes(protocol)
}
