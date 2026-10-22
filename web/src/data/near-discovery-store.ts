/**
 * What is already known at the tuned frequency, from any browser (WG12): GET
 * /api/scanner/discoveries?nearHz=&toleranceHz=&evidence=proven&limit=1, the nearest discovery with a
 * proof. The tuned card names a frequency identified before with it. `scanner:discovery` events keep the
 * answer current (a closed live-audio transmission attaches analog evidence on its own).
 *
 * The latest observation's proof (GET /api/scanner/discoveries/:id/observations?limit=1, newest first) says
 * whether the last transmission there was analog or digital: Listen's "What you hear: Auto" follows it.
 *
 * A core before WG12 refuses the query (400): the store says `unsupported` and stops asking, and the card
 * keeps what Identify named this session only.
 */
import type {
	Discovery,
	Observation,
	ScannerDiscoveryEventData,
	ScannerProof,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { isApiError } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface NearDiscoveryState {
	/** The frequency followed; null when nothing is. */
	hz: number | null
	toleranceHz: number
	/** The nearest proven discovery within `toleranceHz`, or null. */
	discovery: Discovery | null
	/** The proof of the discovery's latest observation (the last transmission), or null. */
	lastProof: ScannerProof | null
	status: "idle" | "loading" | "ready" | "unsupported" | "error"
}

const INITIAL: NearDiscoveryState = {
	hz: null,
	toleranceHz: 0,
	discovery: null,
	lastProof: null,
	status: "idle",
}

/** Analog or digital, from one transmission's proof; null when it says neither (carrier only). */
export function proofKind(
	proof: ScannerProof | null | undefined,
): "analog" | "digital" | null {
	if (!proof || proof.kind === "carrier-only") return null
	if (proof.kind === "analog-tone" || proof.kind === "analog-voice")
		return "analog"
	return proof.protocol.startsWith("analog") ? "analog" : "digital"
}

/** Coalesces discovery updates before asking for the latest observation. */
const PROOF_DELAY_MS = 400

/** A discovery with a proof (cores before WG12 send none). */
export function isProven(d: Discovery): boolean {
	return d.proof !== undefined && d.evidenceLevel !== "weak"
}

export class NearDiscoveryStore extends Store<NearDiscoveryState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	private abort: AbortController | null = null
	private supported = true
	private proofAbort: AbortController | null = null
	private proofTimer: ReturnType<typeof setTimeout> | null = null

	constructor(api: ApiClient, events: EventsClient) {
		super(INITIAL)
		this.api = api
		this.cleanup = [
			events.subscribe(["scanner"]),
			events.on("scanner:discovery", e => this.onDiscovery(e)),
			events.onReconnected(() => void this.load()),
		]
	}

	/** Follows `hz` (null stops). Loads when the frequency or the tolerance changes. */
	follow(hz: number | null, toleranceHz: number): void {
		const s = this.get()
		if (s.hz === hz && s.toleranceHz === toleranceHz) return
		this.abort?.abort()
		this.cancelProof()
		this.set({
			hz,
			toleranceHz,
			discovery: null,
			lastProof: null,
			status: this.supported ? "idle" : "unsupported",
		})
		void this.load()
	}

	/** Asks again for the followed frequency. Never rejects. */
	load(): Promise<void> {
		const { hz, toleranceHz } = this.get()
		if (hz === null || !this.supported) return Promise.resolve()
		this.abort?.abort()
		const abort = new AbortController()
		this.abort = abort
		this.update(s => ({ ...s, status: "loading" }))
		return this.api
			.get<{ items: Discovery[] }>("/api/scanner/discoveries", {
				query: {
					nearHz: Math.round(hz),
					toleranceHz: Math.round(toleranceHz),
					evidence: "proven",
					limit: 1,
				},
				signal: abort.signal,
			})
			.then(
				page => {
					if (abort.signal.aborted) return
					const d = page.items[0]
					const near =
						d && Math.abs(d.frequencyHz - hz) <= toleranceHz && isProven(d)
							? d
							: null
					this.update(s => ({
						...s,
						discovery: near,
						lastProof: near ? s.lastProof : null,
						status: "ready",
					}))
					if (near) this.loadProof(0)
				},
				(error: unknown) => {
					if (abort.signal.aborted) return
					if (isApiError(error) && error.status === 400) {
						// a core before WG12: the card keeps what it named this session
						this.supported = false
						this.update(s => ({ ...s, status: "unsupported" }))
						return
					}
					this.update(s => ({ ...s, status: "error" }))
				},
			)
	}

	private onDiscovery(e: ScannerDiscoveryEventData): void {
		const s = this.get()
		if (s.hz === null || !this.supported) return
		const d = e.discovery
		const mine = s.discovery !== null && s.discovery.id === d.id
		const absorbed =
			s.discovery !== null && (e.mergedIds ?? []).includes(s.discovery.id)
		if (e.change === "deleted") {
			if (mine) void this.load()
			return
		}
		const near = Math.abs(d.frequencyHz - s.hz)
		if (near > s.toleranceHz || !isProven(d)) {
			if (mine || absorbed) void this.load()
			return
		}
		const current = s.discovery
		if (
			mine ||
			absorbed ||
			current === null ||
			near <= Math.abs(current.frequencyHz - s.hz)
		) {
			this.update(x => ({ ...x, discovery: d, status: "ready" }))
			this.loadProof(PROOF_DELAY_MS)
		}
	}

	/** Reads the discovery's latest observation, after `delayMs` (later calls fold into one). */
	private loadProof(delayMs: number): void {
		if (this.proofTimer !== null) return
		this.proofTimer = setTimeout(() => {
			this.proofTimer = null
			const id = this.get().discovery?.id
			if (!id) return
			this.proofAbort?.abort()
			const abort = new AbortController()
			this.proofAbort = abort
			this.api
				.get<{
					items: Observation[]
				}>(`/api/scanner/discoveries/${encodeURIComponent(id)}/observations`, { query: { limit: 1 }, signal: abort.signal })
				.then(
					page => {
						if (abort.signal.aborted || this.get().discovery?.id !== id) return
						const proof = page.items[0]?.proof ?? null
						this.update(s => ({ ...s, lastProof: proof }))
					},
					() => undefined,
				)
		}, delayMs)
	}

	private cancelProof(): void {
		if (this.proofTimer !== null) clearTimeout(this.proofTimer)
		this.proofTimer = null
		this.proofAbort?.abort()
	}

	dispose(): void {
		this.abort?.abort()
		this.cancelProof()
		for (const off of this.cleanup) off()
	}
}
