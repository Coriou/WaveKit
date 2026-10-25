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
 *
 * Band inspection UX req 3.3: the shown record is ordered like the scanner store's cache (write-order.ts):
 * an answer or event for the same id applies only when its (revision, read revision, client sequence) is
 * at least the held one, and answers and events from a store epoch left behind (a restart) are dropped.
 */
import type {
	Discovery,
	Observation,
	ScannerDiscoveryEventData,
	ScannerProof,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { keysBefore } from "./write-order.ts"
import type { WriteKeys } from "./write-order.ts"
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
	/** The order of the shown record (null when none is shown). */
	private held: WriteKeys | null = null
	private seq = 0
	/** The core's store epoch: undefined until the first answer, null for an older core. */
	private epoch: string | null | undefined = undefined
	private readonly retired: (string | null)[] = []

	constructor(api: ApiClient, events: EventsClient) {
		super(INITIAL)
		this.api = api
		this.cleanup = [
			events.subscribe(["scanner"]),
			events.on("scanner:discovery", e => this.onDiscovery(e)),
			events.on("scanner:discoveries-resync", () => void this.load()),
			events.onReconnected(() => void this.load()),
		]
	}

	/** Follows `hz` (null stops). Loads when the frequency or the tolerance changes. */
	follow(hz: number | null, toleranceHz: number): void {
		const s = this.get()
		if (s.hz === hz && s.toleranceHz === toleranceHz) return
		this.abort?.abort()
		this.cancelProof()
		this.held = null
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
		const seq = ++this.seq
		this.abort?.abort()
		const abort = new AbortController()
		this.abort = abort
		this.update(s => ({ ...s, status: "loading" }))
		return this.api
			.get<{
				items: Discovery[]
				storeEpoch?: string
				storeRevision?: number
			}>("/api/scanner/discoveries", {
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
					if (abort.signal.aborted || !this.admit(page.storeEpoch)) return
					const d = page.items[0]
					const found =
						d && Math.abs(d.frequencyHz - hz) <= toleranceHz && isProven(d)
							? d
							: null
					const read = this.epoch === null ? seq : (page.storeRevision ?? 0)
					const keys = found ? this.keysOf(found, read, seq) : null
					const shown = this.get().discovery
					const held = this.held
					// something newer about the shown record arrived while this was asked
					const stale =
						shown !== null &&
						held !== null &&
						(found === null || found.id === shown.id
							? keys === null
								? held.rev > read
								: keysBefore(keys, held)
							: false)
					if (stale) {
						this.update(s => ({ ...s, status: "ready" }))
						return
					}
					const near = found
					this.held = keys
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
		if (s.hz === null || !this.supported || !this.admit(e.storeEpoch)) return
		const seq = ++this.seq
		const d = e.discovery
		const mine = s.discovery !== null && s.discovery.id === d.id
		const absorbed =
			s.discovery !== null && (e.mergedIds ?? []).includes(s.discovery.id)
		// band inspection UX req 3.2: a truncated merge may have absorbed the shown one unnamed
		const truncated = e.mergedTruncated === true && s.discovery !== null
		if (e.change === "deleted") {
			if (mine || absorbed || truncated) void this.load()
			return
		}
		if (truncated && !mine && !absorbed) {
			void this.load()
			return
		}
		const near = Math.abs(d.frequencyHz - s.hz)
		if (near > s.toleranceHz || !isProven(d)) {
			if (mine || absorbed) void this.load()
			return
		}
		const current = s.discovery
		const keys = this.keysOf(
			d,
			this.epoch === null ? seq : (e.revision ?? 0),
			seq,
		)
		// an older word on the shown record (a delayed event) changes nothing
		if (mine && this.held !== null && keysBefore(keys, this.held)) return
		if (
			mine ||
			absorbed ||
			current === null ||
			near <= Math.abs(current.frequencyHz - s.hz)
		) {
			this.held = keys
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
				}>(`/api/scanner/discoveries/${encodeURIComponent(id)}/observations`, {
					query: { limit: 1 },
					signal: abort.signal,
				})
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

	/** The keys of `d` read at `read`: an older core (no epoch) orders by the client sequence only. */
	private keysOf(d: Discovery, read: number, seq: number): WriteKeys {
		return this.epoch === null
			? { rev: seq, read: seq, seq }
			: { rev: d.revision ?? 0, read, seq }
	}

	/** False for an answer or event from an epoch left behind; a new epoch forgets the held order. */
	private admit(epoch: string | undefined): boolean {
		const e = epoch ?? null
		if (this.epoch === undefined) {
			this.epoch = e
			return true
		}
		if (e === this.epoch) return true
		if (this.retired.includes(e)) return false
		this.retired.push(this.epoch)
		if (this.retired.length > 8) this.retired.shift()
		this.epoch = e
		this.held = null
		return true
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
