import { createHash, randomBytes } from "node:crypto"
import { performance } from "node:perf_hooks"
import { accessPairRequestSchema } from "@wavekit/api-types"
import type { AccessDeviceKind } from "@wavekit/api-types"
import { WaveKitError } from "../utils/errors.js"
import {
	admissionDenial,
	flowDenial,
	flowSuccess,
	SessionCookies,
} from "./cookies.js"
import type { AccessFlowResult } from "./cookies.js"
import type { AccessRandomBytes } from "./credentials.js"
import type { AccessPolicy } from "./policy.js"
import type { SessionStore } from "./sessions.js"
import type { AccessRequest } from "./types.js"

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const CODE_TTL_MS = 10 * 60_000
const WINDOW_MS = 60_000
const MAX_CODES = 4
const MAX_ADDRESSES = 128
const ADDRESS_IDLE_MS = 10 * 60_000

export interface PairingServiceOptions {
	policy: AccessPolicy
	sessions: SessionStore
	random?: AccessRandomBytes
	monotonicNow?: () => number
}

interface PendingCode {
	expiresAt: number
	reserved: boolean
}

interface AddressBucket {
	attempts: number[]
	lastAt: number
}

export interface PairedSession {
	deviceId: string
	expiresAt: number
	csrfToken: string
}

export interface IssuedPairingCode {
	code: string
	expiresInSeconds: number
}

function normalizeCode(input: string): string | null {
	if (!/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(input)) return null
	const code = input.replace("-", "").toUpperCase()
	return [...code].every(character => alphabet.includes(character))
		? code
		: null
}

function hashCode(code: string): string {
	return createHash("sha256").update(code, "ascii").digest("hex")
}

/** Process-local codes; only committed session creation consumes a reservation. */
export class PairingService {
	#policy: AccessPolicy
	#sessions: SessionStore
	#cookies: SessionCookies
	#random: AccessRandomBytes
	#clock: () => number
	#lastNow = 0
	#unavailable = false
	#codes = new Map<string, PendingCode>()
	#addresses = new Map<string, AddressBucket>()
	#globalAttempts: number[] = []

	constructor(options: PairingServiceOptions) {
		if (
			!options.policy.usesSessionStore(options.sessions) ||
			(options.random !== undefined && typeof options.random !== "function") ||
			(options.monotonicNow !== undefined &&
				typeof options.monotonicNow !== "function")
		)
			throw new WaveKitError(
				"Invalid pairing configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#policy = options.policy
		this.#sessions = options.sessions
		this.#cookies = new SessionCookies(options.policy)
		this.#random = options.random ?? randomBytes
		this.#clock = options.monotonicNow ?? (() => performance.now())
	}

	#now(): number {
		try {
			const now = this.#clock()
			if (
				!Number.isFinite(now) ||
				now < 0 ||
				now > Number.MAX_SAFE_INTEGER - CODE_TTL_MS
			)
				throw new WaveKitError("Pairing unavailable", "ACCESS_UNAVAILABLE")
			this.#lastNow = Math.max(this.#lastNow, now)
			return this.#lastNow
		} catch {
			this.#unavailable = true
			throw new WaveKitError("Pairing unavailable", "ACCESS_UNAVAILABLE")
		}
	}

	#prune(now: number): void {
		for (const [hash, code] of this.#codes)
			if (!code.reserved && code.expiresAt <= now) this.#codes.delete(hash)
		this.#globalAttempts = this.#globalAttempts.filter(
			at => at > now - WINDOW_MS,
		)
		for (const [address, bucket] of this.#addresses) {
			if (bucket.lastAt <= now - ADDRESS_IDLE_MS)
				this.#addresses.delete(address)
			else bucket.attempts = bucket.attempts.filter(at => at > now - WINDOW_MS)
		}
	}

	#allowAttempt(address: string, now: number): boolean {
		const existing = this.#addresses.get(address)
		if (
			this.#globalAttempts.length >= 60 ||
			(existing?.attempts.length ?? 0) >= 5 ||
			(!existing && this.#addresses.size >= MAX_ADDRESSES)
		)
			return false
		const bucket = existing ?? { attempts: [], lastAt: now }
		bucket.attempts.push(now)
		bucket.lastAt = now
		this.#addresses.set(address, bucket)
		this.#globalAttempts.push(now)
		return true
	}

	issue(request: AccessRequest): AccessFlowResult<IssuedPairingCode> {
		const admission = this.#policy.evaluate(request)
		if (admission.kind === "deny") return admissionDenial(admission)
		const { headers } = admission
		if (
			request.surface !== "api" ||
			request.transport !== "http" ||
			request.method !== "POST" ||
			request.rawTarget !== "/api/access/pairing-codes"
		)
			return flowDenial(400, "MALFORMED_REQUEST", headers)
		if (
			admission.kind !== "authenticated" ||
			admission.principal.kind !== "machine"
		)
			return flowDenial(403, "MACHINE_REQUIRED", headers)
		if (this.#unavailable || this.#sessions.unavailable)
			return flowDenial(503, "ACCESS_UNAVAILABLE", headers)
		try {
			const now = this.#now()
			this.#prune(now)
			if (this.#codes.size >= MAX_CODES)
				return flowDenial(429, "PAIRING_CAPACITY", headers)
			for (let attempt = 0; attempt < 8; attempt++) {
				const bytes = this.#random(10)
				if (!(bytes instanceof Uint8Array) || bytes.length !== 10)
					return flowDenial(503, "ACCESS_UNAVAILABLE", headers)
				const code = [...bytes].map(byte => alphabet[byte & 31]).join("")
				const hash = hashCode(code)
				if (this.#codes.has(hash)) continue
				this.#codes.set(hash, { expiresAt: now + CODE_TTL_MS, reserved: false })
				return flowSuccess(
					{
						code: `${code.slice(0, 5)}-${code.slice(5)}`,
						expiresInSeconds: CODE_TTL_MS / 1000,
					},
					headers,
					undefined,
					201,
				)
			}
		} catch {
			/* Errors never expose random-provider or clock causes. */
		}
		return flowDenial(503, "ACCESS_UNAVAILABLE", headers)
	}

	async redeem(
		request: AccessRequest,
		body: unknown,
	): Promise<AccessFlowResult<PairedSession>> {
		const boundary = this.#policy.validatePairingRequest(request)
		if (boundary.kind === "deny") return admissionDenial(boundary)
		const { headers } = boundary
		if (this.#unavailable || this.#sessions.unavailable)
			return flowDenial(503, "ACCESS_UNAVAILABLE", headers)
		let now: number
		try {
			now = this.#now()
		} catch {
			return flowDenial(503, "ACCESS_UNAVAILABLE", headers)
		}
		this.#prune(now)
		if (!this.#allowAttempt(request.remoteAddress, now))
			return flowDenial(429, "PAIRING_RATE_LIMITED", {
				...headers,
				"Retry-After": "60",
			})
		// Strict parse (unknown keys, including prototype names, refused) before any
		// reservation; a refused body never touches the code. The name is never logged.
		const parsed = accessPairRequestSchema.safeParse(body)
		const code = parsed.success ? normalizeCode(parsed.data.code) : null
		if (!parsed.success || !code)
			return flowDenial(400, "MALFORMED_REQUEST", headers)
		const label: { name?: string; kind?: AccessDeviceKind } = {}
		if (parsed.data.name !== undefined) label.name = parsed.data.name
		if (parsed.data.kind !== undefined) label.kind = parsed.data.kind
		const hash = hashCode(code)
		const pending = this.#codes.get(hash)
		if (!pending || pending.reserved || pending.expiresAt <= now)
			return flowDenial(401, "PAIRING_INVALID", headers)
		// Synchronous reservation closes concurrent redemption before the first await.
		pending.reserved = true
		try {
			const created = await this.#sessions.create(label)
			if (created.kind === "capacity")
				return flowDenial(429, created.code, headers)
			this.#codes.delete(hash)
			const committed = this.#sessions.lookupByPrincipal(created.principalId)
			if (!committed)
				return flowDenial(
					this.#sessions.unavailable ? 503 : 401,
					this.#sessions.unavailable ? "ACCESS_UNAVAILABLE" : "AUTH_REQUIRED",
					headers,
				)
			return flowSuccess(
				{
					deviceId: committed.principalId,
					expiresAt: committed.expiresAt,
					csrfToken: committed.csrfToken,
				},
				headers,
				this.#cookies.issue(created.cookieValue, created.cookieMaxAgeSeconds),
				201,
			)
		} catch {
			return flowDenial(503, "ACCESS_UNAVAILABLE", headers)
		} finally {
			if (this.#codes.get(hash) === pending) {
				pending.reserved = false
				try {
					if (pending.expiresAt <= this.#now()) this.#codes.delete(hash)
				} catch {
					this.#codes.delete(hash)
				}
			}
		}
	}
}
