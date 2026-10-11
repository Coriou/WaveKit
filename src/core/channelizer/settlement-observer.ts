import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import type { SourceCaps } from "../../config.js"
import { WaveKitError } from "../../utils/errors.js"
import { MAX_SETTLEMENT_TOKEN, isSettlementToken } from "./protocol.js"
import type { SettlementTransport } from "./settlement-transport.js"
import type {
	ChannelProvider,
	ChannelRequestResult,
	DecoderChannelRequest,
} from "./types.js"

export type ProofState = "pending" | "settled" | "unknown" | "failed"
interface CleanupSuccess {
	readonly ok: true
}
interface CleanupFailure {
	readonly ok: false
	readonly state: "unknown" | "failed"
	readonly detail: string
}
export type CleanupOutcome = CleanupSuccess | CleanupFailure
export type SettlementFinalOutcome = CleanupOutcome
export type ProcessDisposition =
	| "assignedStarting"
	| "assignedNoProcess"
	| "childOwned"
export type LocalKind =
	| "server"
	| "endpoint"
	| "bootstrap"
	| "candidate"
	| "directory"
	| "connector"
export type ComponentKind =
	| "decoder"
	| "classifier"
	| "analog"
	| "filesystem"
	| "operation"
export interface ResourceEnvelope {
	readonly cpu: number
	readonly bytes: number
}
export interface DownstreamEnvelopes {
	readonly decoder: ResourceEnvelope
	readonly classifier: ResourceEnvelope
	readonly analog: ResourceEnvelope
}
export interface ProcessSourceSnapshot {
	readonly sourceId: string
	readonly generation: number
	readonly sampleRateHz: number
	readonly centerHz: number
}
export interface AcquisitionIdentitySpec {
	readonly activation: "decoder" | "direct"
	readonly sourceId: string
	readonly decoderId: string
	readonly expectedRequest: DecoderChannelRequest
	readonly scannerAttempt: object
	readonly expectedInputCaps: {
		readonly kind: "iq"
		readonly format: "U8_IQ"
		readonly sampleRate: number
		readonly centerFreq: number
	}
	readonly signal?: AbortSignal
}
export interface ObservedGrantBinding {
	readonly sourceId: string
	readonly decoderId: string
	readonly channelId: string
	readonly generation: number
	readonly realised: {
		readonly outputRateHz: number
		readonly format: "cu8" | "cf32"
		readonly filterTaps: number
		readonly groupDelaySamples: number
	}
	readonly process: ProcessClaim
	readonly send: SendClaim
}
export interface AcquisitionSnapshot {
	readonly scannerAttempt: object
	readonly logical: "queued" | "acquiring" | "granted" | "terminal"
	readonly currentBinding: ObservedGrantBinding | undefined
	readonly ended: boolean
	/** Sticky loss of continuity for the selected grant; never resource proof. */
	readonly continuityLost: boolean
	readonly native: ProofState
	readonly local: ProofState
	readonly components: Readonly<Record<ComponentKind, ProofState>>
}
export interface ProcessSnapshot {
	readonly process: ProcessClaim
	readonly source: ProcessSourceSnapshot
	readonly disposition: ProcessDisposition
	readonly startupSealed: boolean
	readonly native: ProofState
	readonly start: ProofState
	readonly stdio: ProofState
	readonly locals: readonly {
		readonly kind: LocalKind
		readonly state: ProofState
	}[]
}
export interface SettlementSnapshot {
	readonly receipts: number
	readonly owners: {
		readonly V: number
		readonly P: number
		readonly L: number
	}
	readonly queued: number
	readonly admissionSealed: boolean
	readonly processes: readonly ProcessSnapshot[]
	readonly acquisitions: readonly AcquisitionSnapshot[]
}
export interface PermitLedgerSnapshot {
	readonly committed: ResourceEnvelope
	readonly processResiduals: ResourceEnvelope
	readonly nativeAttempts: ResourceEnvelope
	readonly downstream: DownstreamEnvelopes
}
export interface AdmissionSnapshot {
	readonly version: number
	readonly baseline: ResourceEnvelope
	readonly limits: ResourceEnvelope
	readonly committed: ResourceEnvelope
	readonly available: ResourceEnvelope
}

const KEY = Symbol("settlement ownership")
const OK: CleanupOutcome = Object.freeze({ ok: true })
const unknown = (): CleanupOutcome => ({
	ok: false,
	state: "unknown",
	detail: "channel settlement proof incomplete",
})
const failed = (): CleanupOutcome => ({
	ok: false,
	state: "failed",
	detail: "channel settlement cleanup failed",
})
const denied = (): ChannelRequestResult => ({
	ok: false,
	reasonCode: "channelizer-unavailable",
	detail: "channel settlement capacity unavailable",
})
const components: readonly ComponentKind[] = [
	"decoder",
	"classifier",
	"analog",
	"filesystem",
	"operation",
]
const downstreamKinds = ["decoder", "classifier", "analog"] as const
const zero = (): ResourceEnvelope => ({ cpu: 0, bytes: 0 })
function validEnvelope(x: ResourceEnvelope): boolean {
	return (
		Number.isFinite(x.cpu) &&
		x.cpu >= 0 &&
		Number.isSafeInteger(x.bytes) &&
		x.bytes >= 0
	)
}
function copyEnvelope(x: ResourceEnvelope): ResourceEnvelope {
	return Object.freeze({ cpu: x.cpu, bytes: x.bytes })
}
function sum(xs: readonly ResourceEnvelope[]): ResourceEnvelope | undefined {
	let cpu = 0,
		bytes = 0
	for (const x of xs) {
		if (!validEnvelope(x)) return undefined
		cpu += x.cpu
		bytes += x.bytes
		if (!Number.isFinite(cpu) || !Number.isSafeInteger(bytes)) return undefined
	}
	return { cpu, bytes }
}
function aggregate(states: readonly ProofState[]): ProofState {
	if (states.includes("failed")) return "failed"
	if (states.includes("unknown")) return "unknown"
	return states.every(x => x === "settled") ? "settled" : "pending"
}
function state(outcome: CleanupOutcome | undefined): ProofState {
	return outcome ? (outcome.ok ? "settled" : outcome.state) : "pending"
}
function assertKey(key: symbol): void {
	if (key !== KEY)
		throw new WaveKitError(
			"invalid settlement identity",
			"CHANNELIZER_UNAVAILABLE",
		)
}

interface Cell {
	readonly cost: ResourceEnvelope
	readonly kind: "N" | "R" | "decoder" | "classifier" | "analog"
	active: boolean
}
interface PermitData {
	readonly ledger: ObservedPermitLedger
	readonly token: object
	readonly cells: Cell[]
	status: "prepared" | "committed" | "aborted"
}
const permits = new WeakMap<PreparedObservedPermit, PermitData>()
const tokens = new WeakSet<object>()
export class PreparedObservedPermit {
	private readonly brand = KEY
	constructor(key: symbol, data: PermitData) {
		assertKey(key)
		assertKey(this.brand)
		permits.set(this, data)
	}
}

interface LedgerBank {
	limits: ResourceEnvelope
	baseline: ResourceEnvelope
	version: number
	exhausted: boolean
	readonly cells: Set<Cell>
}
const ledgerBanks = new WeakMap<ObservedPermitLedger, LedgerBank>()
export class ObservedPermitLedger {
	private limits: ResourceEnvelope
	private baseline: ResourceEnvelope
	private version = 0
	private exhausted = false
	private readonly cells = new Set<Cell>()
	constructor(limits: ResourceEnvelope, baseline: ResourceEnvelope) {
		if (!validEnvelope(limits) || !validEnvelope(baseline))
			throw new WaveKitError(
				"invalid settlement envelope",
				"CHANNELIZER_UNAVAILABLE",
			)
		this.limits = copyEnvelope(limits)
		this.baseline = copyEnvelope(baseline)
		ledgerBanks.set(this, {
			limits: this.limits,
			baseline: this.baseline,
			version: 0,
			exhausted: false,
			cells: this.cells,
		})
	}
	prepareObservedPermit(
		requestToken: object,
		sixShapeN: readonly ResourceEnvelope[],
		sixProvisionalR: readonly ResourceEnvelope[],
		downstream: DownstreamEnvelopes,
	): PreparedObservedPermit | undefined {
		if (
			!tokens.has(requestToken) ||
			sixShapeN.length !== 6 ||
			sixProvisionalR.length !== 6
		)
			return undefined
		const cells: Cell[] = []
		for (const [kind, envelopes] of [
			["N", sixShapeN],
			["R", sixProvisionalR],
		] as const)
			for (const cost of envelopes) {
				if (!validEnvelope(cost)) return undefined
				cells.push({ kind, cost: copyEnvelope(cost), active: false })
			}
		for (const kind of downstreamKinds) {
			const cost = downstream[kind]
			if (!validEnvelope(cost)) return undefined
			cells.push({ kind, cost: copyEnvelope(cost), active: false })
		}
		if (!sum(cells.map(x => x.cost))) return undefined
		return new PreparedObservedPermit(KEY, {
			ledger: this,
			token: requestToken,
			cells,
			status: "prepared",
		})
	}
	updateAdmission(
		expectedVersion: number,
		baseline: ResourceEnvelope,
		limits: ResourceEnvelope,
	): boolean {
		if (
			this.exhausted ||
			expectedVersion !== this.version ||
			!validEnvelope(baseline) ||
			!validEnvelope(limits)
		)
			return false
		if (this.version === Number.MAX_SAFE_INTEGER) {
			this.exhausted = true
			ledgerBanks.get(this)!.exhausted = true
			return false
		}
		this.baseline = copyEnvelope(baseline)
		this.limits = copyEnvelope(limits)
		this.version++
		Object.assign(ledgerBanks.get(this)!, {
			baseline: this.baseline,
			limits: this.limits,
			version: this.version,
		})
		return true
	}
	admissionSnapshot(): AdmissionSnapshot {
		const committed = this.total()
		return {
			version: this.version,
			baseline: copyEnvelope(this.baseline),
			limits: copyEnvelope(this.limits),
			committed,
			available: {
				cpu: Math.max(0, this.limits.cpu - this.baseline.cpu - committed.cpu),
				bytes: Math.max(
					0,
					this.limits.bytes - this.baseline.bytes - committed.bytes,
				),
			},
		}
	}
	snapshot(): PermitLedgerSnapshot {
		const costs = (kind: Cell["kind"]) =>
			sum([...this.cells].filter(x => x.kind === kind).map(x => x.cost)) ??
			zero()
		return {
			committed: this.total(),
			processResiduals: costs("R"),
			nativeAttempts: costs("N"),
			downstream: {
				decoder: costs("decoder"),
				classifier: costs("classifier"),
				analog: costs("analog"),
			},
		}
	}
	private total(): ResourceEnvelope {
		return (
			sum([...this.cells].map(x => x.cost)) ?? {
				cpu: Infinity,
				bytes: Number.MAX_SAFE_INTEGER,
			}
		)
	}
}
function commitPermit(data: PermitData): boolean {
	const bank = ledgerBanks.get(data.ledger)
	if (!bank || data.status !== "prepared" || bank.exhausted) return false
	const total = sum([
		bank.baseline,
		...[...bank.cells].map(x => x.cost),
		...data.cells.map(x => x.cost),
	])
	if (!total || total.cpu > bank.limits.cpu || total.bytes > bank.limits.bytes)
		return false
	data.status = "committed"
	for (const cell of data.cells) {
		cell.active = true
		bank.cells.add(cell)
	}
	return true
}

interface RegistryData {
	receipts: number
	V: number
	P: number
	L: number
	queued: number
	readonly providers: Set<ProviderLifetime>
}
const registries = new WeakMap<SettlementRegistry, RegistryData>()
interface ProviderData {
	readonly registry: SettlementRegistry
	sealed: boolean
	released: boolean
	observer: ChannelSettlementObserver | undefined
	readonly handles: Set<ObservedAcquisitionHandle>
	readonly processes: Set<ProcessClaim>
	readonly locals: Map<string, LocalCleanupClaim>
	readonly listeners: Set<LocalCleanupClaim>
	readonly transports: Map<ProcessClaim, SettlementTransport>
	firstFailure: CleanupOutcome | undefined
	final: SettlementFinalOutcome | undefined
}
const providers = new WeakMap<ProviderLifetime, ProviderData>()
interface LocalData {
	readonly provider: ProviderLifetime
	outcome: CleanupOutcome | undefined
	attempt: (() => Promise<CleanupOutcome>) | undefined
	remover: (() => void) | undefined
	running: Promise<CleanupOutcome> | undefined
	readonly changed: () => void
}
const locals = new WeakMap<LocalCleanupClaim, LocalData>()
interface ComponentData {
	readonly handle: ObservedAcquisitionHandle
	readonly kind: ComponentKind
	begun: boolean
	sealed: boolean
	outcome: CleanupOutcome | undefined
}
const componentRecords = new WeakMap<ConsumerComponent, ComponentData>()
interface HandleData {
	readonly observer: ChannelSettlementObserver
	readonly spec: AcquisitionIdentitySpec
	readonly controller: AbortController
	permit: PreparedObservedPermit | undefined
	armed: boolean
	canceled: boolean
	intercepted: boolean
	taken: boolean
	actual: DecoderChannelRequest | undefined
	tx: ObservedTransaction | undefined
	queued: boolean
	released: boolean
	logical: AcquisitionSnapshot["logical"]
	terminal: boolean
	ended: boolean
	binding: ObservedGrantBinding | undefined
	continuityLost: boolean
	pendingContinuityNotification: SendClaim | undefined
	readonly listeners: Set<() => void>
	readonly components: Map<ComponentKind, ConsumerComponent>
	abortListener: (() => void) | undefined
	endNotified: boolean
}
const handles = new WeakMap<ObservedAcquisitionHandle, HandleData>()
interface TransactionData {
	readonly handle: ObservedAcquisitionHandle
	readonly permit: PermitData
	readonly processCells: {
		cell: Cell
		process: ProcessClaim | undefined
		released: boolean
	}[]
	readonly sendCells: {
		cell: Cell
		send: SendClaim | undefined
		receiptReturned: boolean
		released: boolean
	}[]
	readonly shared: Set<ProcessClaim>
}
const transactions = new WeakMap<ObservedTransaction, TransactionData>()
interface ProcessData {
	readonly tx: ObservedTransaction
	readonly cell: Cell
	disposition: ProcessDisposition
	sealed: boolean
	decision:
		| "notCalled"
		| "calling"
		| "supportedNoReturn"
		| "returned"
		| "uncertain"
	child: ChildProcess | undefined
	close: boolean
	start: boolean
	stdio: boolean
	nativeRefunded: boolean
	released: boolean
	nextToken: bigint
	issued: bigint
	readonly sends: Map<string, SendClaim>
	readonly current: Map<string, SendClaim>
	readonly locals: Map<LocalKind, Set<LocalCleanupClaim>>
}
const processes = new WeakMap<ProcessClaim, ProcessData>()
interface SendData {
	readonly tx: ObservedTransaction
	readonly cell: Cell
	phase: "pending" | "opened" | "terminal"
	captured: "opened" | "rejected" | "closed" | undefined
	recorded: boolean
	disposed: boolean
	connector: LocalCleanupClaim | undefined
	released: boolean
	continuityLost: boolean
}
const sends = new WeakMap<SendClaim, SendData>()

function providerData(provider: ProviderLifetime): ProviderData {
	const data = providers.get(provider)
	if (!data)
		throw new WaveKitError(
			"invalid settlement provider",
			"CHANNELIZER_UNAVAILABLE",
		)
	return data
}
function failure(provider: ProviderLifetime, outcome: CleanupOutcome): void {
	const p = providerData(provider)
	if (!outcome.ok && !p.firstFailure) p.firstFailure = outcome
}
function notify(handle: ObservedAcquisitionHandle): void {
	const h = handles.get(handle)
	if (!h) return
	for (const listener of [...h.listeners]) {
		try {
			listener()
		} catch {
			failure(h.observer.provider, failed())
		}
	}
}
function localClaim(
	provider: ProviderLifetime,
	changed: () => void,
): LocalCleanupClaim {
	return new LocalCleanupClaim(KEY, {
		provider,
		changed,
		outcome: undefined,
		attempt: undefined,
		remover: undefined,
		running: undefined,
	})
}
function localSettled(claim: LocalCleanupClaim): boolean {
	return locals.get(claim)?.outcome?.ok === true
}
function nativeProcess(p: ProcessData): boolean {
	return (
		p.disposition === "assignedNoProcess" ||
		(p.disposition === "childOwned" && p.close && p.start && p.stdio)
	)
}
function handleComponentsSettled(h: HandleData): boolean {
	return components.every(kind => {
		const component = h.components.get(kind)
		return (
			component !== undefined &&
			componentRecords.get(component)?.outcome?.ok === true
		)
	})
}
function metadataSettled(h: HandleData): boolean {
	return handleComponentsSettled(h) && h.listeners.size === 0
}
function refund(data: PermitData, cell: Cell): void {
	if (cell.active) {
		cell.active = false
		ledgerBanks.get(data.ledger)!.cells.delete(cell)
	}
}

/** Recompute only bounded charged records. No callbacks run in this accounting pass. */
function reconcile(provider: ProviderLifetime): void {
	const v = providerData(provider),
		r = registries.get(v.registry)!
	for (const process of v.processes) {
		const p = processes.get(process)!,
			tx = transactions.get(p.tx)!
		if (nativeProcess(p) && !p.nativeRefunded) {
			p.nativeRefunded = true
			refund(tx.permit, p.cell)
		}
	}
	for (const handle of v.handles) {
		const h = handles.get(handle)!
		if (!h.tx) {
			if (h.terminal && h.intercepted && metadataSettled(h))
				releaseHandle(handle, h, v, r)
			continue
		}
		const tx = transactions.get(h.tx)!
		if (h.terminal) {
			for (const slot of tx.processCells)
				if (!slot.process && !slot.released) {
					slot.released = true
					r.P--
					refund(tx.permit, slot.cell)
				}
			for (const slot of tx.sendCells)
				if (!slot.send && !slot.released) {
					if (!slot.receiptReturned) {
						slot.receiptReturned = true
						r.receipts--
					}
					refund(tx.permit, slot.cell)
					if (metadataSettled(h)) {
						slot.released = true
						r.L--
					}
				}
			for (const kind of downstreamKinds) {
				const component = h.components.get(kind)
				if (component && componentRecords.get(component)?.outcome?.ok) {
					const cell = tx.permit.cells.find(x => x.kind === kind)
					if (cell) refund(tx.permit, cell)
				}
			}
		}
		for (const slot of tx.sendCells) {
			if (!slot.send || slot.released) continue
			const s = sends.get(slot.send)!,
				p = processes.get(slot.send.process)!
			const native =
				nativeProcess(p) || (s.disposed && s.phase === "terminal" && s.recorded)
			if (h.terminal && native && !slot.receiptReturned) {
				slot.receiptReturned = true
				r.receipts--
			}
			if (
				h.terminal &&
				native &&
				metadataSettled(h) &&
				(!s.connector || localSettled(s.connector))
			) {
				slot.released = true
				s.released = true
				r.L--
				refund(tx.permit, slot.cell)
				p.sends.delete(slot.send.token)
				if (p.current.get(slot.send.id) === slot.send)
					p.current.delete(slot.send.id)
			}
		}
		const allCells = tx.permit.cells.every(x => !x.active)
		if (
			h.terminal &&
			allCells &&
			tx.sendCells.every(x => x.released) &&
			metadataSettled(h)
		)
			releaseHandle(handle, h, v, r)
	}
	for (const process of v.processes) {
		const p = processes.get(process)!
		if (
			!p.released &&
			nativeProcess(p) &&
			p.sends.size === 0 &&
			[...p.locals.values()].every(xs => [...xs].every(localSettled))
		) {
			p.released = true
			r.P--
			v.processes.delete(process)
			v.transports.delete(process)
			const slot = transactions
				.get(p.tx)!
				.processCells.find(x => x.process === process)
			if (slot) slot.released = true
		}
	}
}
function releaseHandle(
	handle: ObservedAcquisitionHandle,
	h: HandleData,
	v: ProviderData,
	r: RegistryData,
): void {
	if (h.released) return
	h.released = true
	if (h.queued) {
		r.queued--
		h.queued = false
	}
	if (h.abortListener && h.spec.signal)
		h.spec.signal.removeEventListener("abort", h.abortListener)
	h.abortListener = undefined
	h.listeners.clear()
	v.handles.delete(handle)
	tokens.delete(handle.requestToken)
}

export class LocalCleanupClaim {
	private readonly brand = KEY
	constructor(key: symbol, data: LocalData) {
		assertKey(key)
		assertKey(this.brand)
		locals.set(this, data)
	}
	settle(outcome: CleanupOutcome): void {
		const d = locals.get(this)!
		if (d.outcome) return
		d.outcome = outcome.ok
			? OK
			: { ok: false, state: outcome.state, detail: outcome.detail }
		failure(d.provider, d.outcome)
		d.changed()
	}
}
export class ConsumerComponent {
	private readonly brand = KEY
	constructor(key: symbol, data: ComponentData) {
		assertKey(key)
		assertKey(this.brand)
		componentRecords.set(this, data)
	}
	begin(): boolean {
		const d = componentRecords.get(this)!,
			h = handles.get(d.handle)!
		if (
			!h.tx ||
			!h.binding ||
			(h.spec.activation === "direct" && d.kind === "decoder") ||
			d.begun ||
			d.sealed ||
			d.outcome ||
			h.canceled ||
			h.ended ||
			providerData(h.observer.provider).sealed
		)
			return false
		d.begun = true
		return true
	}
	sealNeverStarted(): boolean {
		const d = componentRecords.get(this)!
		if (d.begun || d.outcome) return false
		d.sealed = true
		d.outcome = OK
		const h = handles.get(d.handle)!
		reconcile(h.observer.provider)
		notify(d.handle)
		return true
	}
	settle(outcome: CleanupOutcome): void {
		const d = componentRecords.get(this)!
		if (d.outcome) return
		if (!d.begun) d.sealed = true
		d.outcome = outcome.ok
			? OK
			: { ok: false, state: outcome.state, detail: outcome.detail }
		const h = handles.get(d.handle)!
		failure(h.observer.provider, d.outcome)
		reconcile(h.observer.provider)
		notify(d.handle)
	}
}

export class ProviderLifetime {
	private readonly brand = KEY
	readonly identity = Object.freeze({})
	constructor(key: symbol, data: ProviderData) {
		assertKey(key)
		assertKey(this.brand)
		providers.set(this, data)
	}
	ownCleanup(
		kind: "construction" | "endpoint" | "bootstrap" | "connector",
		attempt: () => Promise<CleanupOutcome>,
	): LocalCleanupClaim | undefined {
		const d = providerData(this)
		if (d.released || d.sealed || d.locals.has(kind)) return undefined
		const claim = localClaim(this, () => reconcile(this))
		locals.get(claim)!.attempt = attempt
		d.locals.set(kind, claim)
		return claim
	}
	ownListener(removeExactListener: () => void): LocalCleanupClaim | undefined {
		const d = providerData(this)
		if (d.released || d.sealed || d.listeners.size >= 8) return undefined
		const claim = localClaim(this, () => reconcile(this))
		locals.get(claim)!.remover = removeExactListener
		d.listeners.add(claim)
		return claim
	}
	sealAdmission(): void {
		providerData(this).observer?.sealAdmission()
		providerData(this).sealed = true
	}
	async attemptLocalCleanup(): Promise<readonly CleanupOutcome[]> {
		const d = providerData(this)
		const tasks: Promise<readonly CleanupOutcome[]>[] = []
		for (const claim of d.locals.values()) {
			const local = locals.get(claim)!
			if (!local.running)
				local.running = Promise.resolve()
					.then(() => local.attempt?.() ?? unknown())
					.catch(() => failed())
					.then(outcome => {
						claim.settle(outcome)
						return outcome
					})
			tasks.push(local.running.then(outcome => [outcome]))
		}
		for (const transport of d.transports.values())
			tasks.push(transport.cleanup().catch(() => [failed()]))
		const results = await Promise.allSettled(tasks)
		const outcomes = results.flatMap(x =>
			x.status === "fulfilled" ? x.value : [failed()],
		)
		for (const outcome of outcomes) failure(this, outcome)
		return outcomes
	}
	disposeListenersIfSettled(): CleanupOutcome {
		const d = providerData(this)
		reconcile(this)
		if (
			!d.sealed ||
			d.handles.size ||
			d.processes.size ||
			[...d.locals.values()].some(x => !localSettled(x))
		)
			return unknown()
		for (const claim of d.listeners) {
			const local = locals.get(claim)!
			if (!local.outcome) {
				try {
					local.remover?.()
					claim.settle(OK)
				} catch {
					claim.settle(failed())
				}
			}
		}
		if ([...d.listeners].some(x => !localSettled(x)))
			return d.firstFailure ?? unknown()
		if (!d.released) {
			d.released = true
			d.observer?.releaseProviderReferences(KEY)
			d.locals.clear()
			d.listeners.clear()
			const r = registries.get(d.registry)!
			r.V--
			r.providers.delete(this)
		}
		return OK
	}
	inspectFinal(producerOutcome: CleanupOutcome): SettlementFinalOutcome {
		const d = providerData(this)
		if (d.final) return d.final
		failure(this, producerOutcome)
		const listenerOutcome = this.disposeListenersIfSettled()
		d.final = d.firstFailure ?? listenerOutcome
		return d.final
	}
}
export class SettlementRegistry {
	private readonly brand = KEY
	constructor() {
		assertKey(this.brand)
		registries.set(this, {
			receipts: 0,
			V: 0,
			P: 0,
			L: 0,
			queued: 0,
			providers: new Set(),
		})
	}
	registerProviderLifetime(): ProviderLifetime | undefined {
		const r = registries.get(this)!
		if (r.V + r.P + r.L >= 128) return undefined
		const provider = new ProviderLifetime(KEY, {
			registry: this,
			sealed: false,
			released: false,
			observer: undefined,
			handles: new Set(),
			processes: new Set(),
			locals: new Map(),
			listeners: new Set(),
			transports: new Map(),
			firstFailure: undefined,
			final: undefined,
		})
		r.V++
		r.providers.add(provider)
		return provider
	}
	createObserver(provider: ProviderLifetime): ChannelSettlementObserver {
		const d = providerData(provider)
		if (d.registry !== this || d.released)
			throw new WaveKitError(
				"invalid settlement lifetime",
				"CHANNELIZER_UNAVAILABLE",
			)
		d.observer ??= new ChannelSettlementObserver(KEY, provider)
		return d.observer
	}
	snapshot(): SettlementSnapshot {
		const r = registries.get(this)!
		const vs = [...r.providers].map(providerData)
		return {
			receipts: r.receipts,
			owners: { V: r.V, P: r.P, L: r.L },
			queued: r.queued,
			admissionSealed: vs.length > 0 && vs.every(x => x.sealed),
			processes: vs.flatMap(x => [...x.processes].map(processSnapshot)),
			acquisitions: vs.flatMap(x => [...x.handles].map(h => h.snapshot())),
		}
	}
}
export class ObservedTransaction {
	private readonly brand = KEY
	constructor(key: symbol, data: TransactionData) {
		assertKey(key)
		assertKey(this.brand)
		transactions.set(this, data)
	}
}

export class ObservedAcquisitionHandle {
	private readonly brand = KEY
	readonly requestToken = Object.freeze({})
	constructor(key: symbol, data: HandleData) {
		assertKey(key)
		assertKey(this.brand)
		handles.set(this, data)
		tokens.add(this.requestToken)
	}
	get binding(): ObservedGrantBinding | undefined {
		return handles.get(this)!.binding
	}
	attachPermit(permit: PreparedObservedPermit): boolean {
		const h = handles.get(this)!,
			data = permits.get(permit)
		if (
			h.released ||
			h.canceled ||
			h.permit ||
			!data ||
			data.status !== "prepared" ||
			data.token !== this.requestToken
		)
			return false
		h.permit = permit
		return true
	}
	arm(): boolean {
		const h = handles.get(this)!,
			v = providerData(h.observer.provider)
		if (
			!h.permit ||
			h.armed ||
			h.canceled ||
			h.intercepted ||
			h.released ||
			v.sealed
		)
			return false
		for (const other of v.handles) {
			const record = handles.get(other)!
			if (
				other !== this &&
				!record.intercepted &&
				record.spec.sourceId === h.spec.sourceId &&
				record.spec.decoderId === h.spec.decoderId
			)
				return false
		}
		h.armed = true
		return true
	}
	cancel(): void {
		const h = handles.get(this)!
		if (h.canceled || h.released) return
		h.canceled = true
		h.ended = true
		// Fence intake before abort can synchronously reenter the manager.
		h.observer.publishEnded(this)
		notify(this)
		h.controller.abort()
		if (!h.tx) h.observer.finishAcquisition(this)
	}
	revokeUnclaimedArm(): boolean {
		const h = handles.get(this)!
		if (h.intercepted || h.tx || h.released) return false
		h.armed = false
		h.intercepted = true
		h.canceled = true
		h.ended = true
		h.observer.publishEnded(this)
		notify(this)
		h.observer.finishAcquisition(this)
		return true
	}
	onChange(listener: () => void): () => void {
		const h = handles.get(this)!
		if (h.released) return () => {}
		if (h.listeners.size >= 8)
			throw new WaveKitError(
				"settlement notification capacity unavailable",
				"CHANNELIZER_UNAVAILABLE",
			)
		h.listeners.add(listener)
		return () => {
			h.listeners.delete(listener)
			reconcile(h.observer.provider)
		}
	}
	retainComponent(kind: ComponentKind): ConsumerComponent | undefined {
		const h = handles.get(this)!
		if (
			h.released ||
			h.terminal ||
			h.components.has(kind) ||
			!components.includes(kind)
		)
			return undefined
		const component = new ConsumerComponent(KEY, {
			handle: this,
			kind,
			begun: false,
			sealed: false,
			outcome: undefined,
		})
		h.components.set(kind, component)
		return component
	}
	snapshot(): AcquisitionSnapshot {
		const h = handles.get(this)!,
			tx = h.tx ? transactions.get(h.tx) : undefined
		const native = tx
			? aggregate(
					tx.sendCells
						.filter(x => x.send)
						.map(x => {
							const send = x.send!,
								s = sends.get(send)!,
								p = processes.get(send.process)!
							return nativeProcess(p) ||
								(s.disposed && s.phase === "terminal" && s.recorded)
								? "settled"
								: p.decision === "uncertain"
									? "unknown"
									: "pending"
						}),
				)
			: h.terminal
				? "settled"
				: "pending"
		const local = aggregate(
			tx?.sendCells
				.filter(x => x.send)
				.map(x =>
					state(
						sends.get(x.send!)!.connector
							? locals.get(sends.get(x.send!)!.connector!)!.outcome
							: OK,
					),
				) ?? [],
		)
		const states = Object.fromEntries(
			components.map(kind => [
				kind,
				h.components.has(kind)
					? state(componentRecords.get(h.components.get(kind)!)!.outcome)
					: h.terminal && !h.binding
						? "settled"
						: "pending",
			]),
		) as Record<ComponentKind, ProofState>
		return {
			scannerAttempt: h.spec.scannerAttempt,
			logical: h.logical,
			currentBinding: h.binding,
			ended: h.ended,
			continuityLost: h.continuityLost,
			native,
			local,
			components: states,
		}
	}
}

export class ProcessClaim {
	private readonly brand = KEY
	constructor(
		key: symbol,
		readonly provider: ProviderLifetime,
		readonly source: ProcessSourceSnapshot,
		data: ProcessData,
	) {
		assertKey(key)
		assertKey(this.brand)
		processes.set(this, data)
	}
	beginSpawn(): boolean {
		const p = processes.get(this)!
		if (
			p.sealed ||
			handles.get(transactions.get(p.tx)!.handle)!.canceled ||
			handles.get(transactions.get(p.tx)!.handle)!.terminal ||
			p.decision !== "notCalled" ||
			p.released
		)
			return false
		p.decision = "calling"
		return true
	}
	recordReturnedChild(child: ChildProcess): void {
		const p = processes.get(this)!
		if (p.child === child) return
		// A returned child always creates owned liability, even if startup was canceled/no PID.
		if (p.child || p.disposition === "assignedNoProcess") {
			p.decision = "uncertain"
			failure(this.provider, unknown())
			return
		}
		p.child = child
		p.disposition = "childOwned"
		p.decision = "returned"
		reconcile(this.provider)
	}
	recordSupportedNoReturn(): void {
		const p = processes.get(this)!
		if (p.decision === "calling" && !p.child) p.decision = "supportedNoReturn"
	}
	recordUncertainSpawn(): void {
		const p = processes.get(this)!
		if (!p.child) p.decision = "uncertain"
	}
	sealStartup(): void {
		processes.get(this)!.sealed = true
	}
	recordNoProcess(): boolean {
		const p = processes.get(this)!,
			h = handles.get(transactions.get(p.tx)!.handle)!
		if (p.disposition === "assignedNoProcess") return true
		if (
			!p.sealed ||
			!h.terminal ||
			!p.start ||
			p.child ||
			p.issued !== 0n ||
			(p.decision !== "notCalled" && p.decision !== "supportedNoReturn")
		)
			return false
		p.disposition = "assignedNoProcess"
		reconcile(this.provider)
		return true
	}
	recordActualClose(): void {
		const p = processes.get(this)!
		if (p.child) {
			p.close = true
			reconcile(this.provider)
		}
	}
	recordStartSettled(): void {
		processes.get(this)!.start = true
		this.recordNoProcess()
		reconcile(this.provider)
	}
	recordStdioSettled(): void {
		processes.get(this)!.stdio = true
		reconcile(this.provider)
	}
	retainLocal(kind: LocalKind): LocalCleanupClaim | undefined {
		const p = processes.get(this)!
		if (
			p.released ||
			p.sealed ||
			p.disposition === "assignedNoProcess" ||
			kind === "connector"
		)
			return undefined
		let slots = p.locals.get(kind)
		if (!slots) {
			slots = new Set()
			p.locals.set(kind, slots)
		}
		// Reuse only completed protocol candidate slots; no completed candidate history grows under P.
		for (const claim of slots) if (localSettled(claim)) slots.delete(claim)
		const cap = kind === "candidate" ? 5 : kind === "directory" ? 2 : 1
		if (slots.size >= cap) return undefined
		const claim = localClaim(this.provider, () => reconcile(this.provider))
		slots.add(claim)
		return claim
	}
}
export class SendClaim {
	private readonly brand = KEY
	constructor(
		key: symbol,
		readonly process: ProcessClaim,
		readonly id: string,
		readonly token: string,
		data: SendData,
	) {
		assertKey(key)
		assertKey(this.brand)
		sends.set(this, data)
	}
	retainConnector(): LocalCleanupClaim | undefined {
		const s = sends.get(this)!
		if (
			s.connector ||
			s.released ||
			handles.get(transactions.get(s.tx)!.handle)!.terminal
		)
			return undefined
		s.connector = localClaim(this.process.provider, () =>
			reconcile(this.process.provider),
		)
		return s.connector
	}
}
function processSnapshot(process: ProcessClaim): ProcessSnapshot {
	const p = processes.get(process)!
	return {
		process,
		source: process.source,
		disposition: p.disposition,
		startupSealed: p.sealed,
		native: nativeProcess(p)
			? "settled"
			: p.decision === "uncertain"
				? "unknown"
				: "pending",
		start: p.start ? "settled" : "pending",
		stdio: p.stdio ? "settled" : "pending",
		locals: [...p.locals].flatMap(([kind, claims]) =>
			[...claims].map(claim => ({
				kind,
				state: state(locals.get(claim)!.outcome),
			})),
		),
	}
}
function requestMatches(
	actual: DecoderChannelRequest,
	expected: DecoderChannelRequest,
): boolean {
	return (
		actual.centerHz === expected.centerHz &&
		actual.bandwidthHz === expected.bandwidthHz &&
		actual.transitionHz === expected.transitionHz &&
		actual.outputRateHz === expected.outputRateHz &&
		actual.format === expected.format &&
		(actual.format === "cu8"
			? (actual.gain ?? 1) === (expected.gain ?? 1)
			: actual.gain === undefined && expected.gain === undefined)
	)
}

type AdapterListener = Parameters<EventEmitter["on"]>[1]
interface DecoderListenerRecord {
	readonly listener: AdapterListener
	readonly claim: LocalCleanupClaim
	readonly remove: () => void
	registered: boolean
	removed: boolean
}
class ForwardingProvider extends EventEmitter implements ChannelProvider {
	private decoderListener: DecoderListenerRecord | undefined
	override on(event: string | symbol, listener: AdapterListener): this {
		if (event !== "channel-invalidated")
			throw new WaveKitError(
				"unsupported settlement adapter listener",
				"CHANNELIZER_UNAVAILABLE",
			)
		if (this.decoderListener)
			throw new WaveKitError(
				"settlement decoder listener already owned",
				"CHANNELIZER_UNAVAILABLE",
			)
		const registration = {
			identity: Object.freeze({
				adapter: this,
				provider: this.observer.provider,
				underlying: this.underlying,
				event,
				listener,
				incarnation: Object.freeze({}),
			}),
			registered: false,
			removed: false,
		}
		const remove = () => {
			if (registration.removed) return
			super.off(event, listener)
			if (super.listeners(event).includes(listener))
				throw new WaveKitError(
					"settlement listener removal incomplete",
					"CHANNELIZER_UNAVAILABLE",
				)
			registration.removed = true
		}
		const claim = this.observer.provider.ownListener(remove)
		if (!claim)
			throw new WaveKitError(
				"settlement listener capacity unavailable",
				"CHANNELIZER_UNAVAILABLE",
			)
		// Capture exact original registration before the public .on effect.
		this.decoderListener = Object.assign(registration, {
			listener,
			claim,
			remove,
		})
		try {
			const result = super.on(event, listener)
			this.decoderListener.registered = true
			return result
		} catch (error: unknown) {
			if (!super.listeners(event).includes(listener)) {
				this.decoderListener.removed = true
				claim.settle(OK)
			}
			throw error
		}
	}
	override off(
		event: string | symbol,
		listener: (...args: never[]) => void,
	): this {
		const record = this.decoderListener
		if (
			event !== "channel-invalidated" ||
			!record ||
			record.listener !== listener
		)
			return super.off(event, listener as (...args: unknown[]) => void)
		try {
			record.remove()
			record.claim.settle(OK)
		} catch {
			record.claim.settle(failed())
		}
		return this
	}
	constructor(
		private readonly observer: ChannelSettlementObserver,
		private readonly underlying: ChannelProvider,
	) {
		super()
	}
	requestChannel(
		sourceId: string,
		decoderId: string,
		request: DecoderChannelRequest,
		caps: SourceCaps | undefined,
		signal?: AbortSignal,
	): Promise<ChannelRequestResult> {
		const v = providerData(this.observer.provider)
		const matching = [...v.handles].filter(handle => {
			const h = handles.get(handle)!
			return (
				!h.released &&
				h.spec.sourceId === sourceId &&
				h.spec.decoderId === decoderId
			)
		})
		if (!matching.length) {
			return signal === undefined
				? this.underlying.requestChannel(sourceId, decoderId, request, caps)
				: this.underlying.requestChannel(
						sourceId,
						decoderId,
						request,
						caps,
						signal,
					)
		}
		if (matching.length !== 1) return Promise.resolve(denied())
		const handle = matching[0]!,
			h = handles.get(handle)!,
			expected = h.spec.expectedInputCaps
		if (h.intercepted) return Promise.resolve(denied())
		// Consume this exact invocation before validation or any call into the manager.
		h.intercepted = true
		const armed = h.armed
		h.armed = false
		if (
			!armed ||
			h.canceled ||
			v.sealed ||
			!caps ||
			caps.kind !== "iq" ||
			caps.format !== "U8_IQ" ||
			!Number.isFinite(caps.sampleRate) ||
			!Number.isFinite(caps.centerFreq) ||
			caps.sampleRate !== expected.sampleRate ||
			caps.centerFreq !== expected.centerFreq ||
			!requestMatches(request, h.spec.expectedRequest)
		) {
			this.observer.finishAcquisition(handle)
			return Promise.resolve(denied())
		}
		h.actual = request
		return this.underlying
			.requestChannel(sourceId, decoderId, request, caps, h.controller.signal)
			.then(result => {
				if (!result.ok) return result
				const decoder = h.components.get("decoder")
				if (
					!h.tx ||
					h.canceled ||
					h.ended ||
					v.sealed ||
					!h.binding ||
					h.binding.channelId !== result.channelId ||
					h.binding.generation !== result.generation ||
					(h.spec.activation === "decoder" && (!decoder || !decoder.begin()))
				) {
					h.ended = true
					this.observer.publishEnded(handle)
					notify(handle)
					void this.underlying
						.releaseChannel(result.channelId)
						.catch(() => failure(this.observer.provider, failed()))
					return denied()
				}
				return result
			})
	}
	releaseChannel(id: string): Promise<void> {
		return this.underlying.releaseChannel(id)
	}
	currentGeneration(sourceId: string): number {
		return this.underlying.currentGeneration(sourceId)
	}
}

type GrantListener = (
	handle: ObservedAcquisitionHandle,
	binding: ObservedGrantBinding,
) => void
interface GrantSubscription {
	listener: GrantListener | undefined
	readonly claim: LocalCleanupClaim
	active: boolean
}
interface EndSubscription {
	listener: ((handle: ObservedAcquisitionHandle) => void) | undefined
	readonly claim: LocalCleanupClaim
	active: boolean
}
export class ChannelSettlementObserver {
	private underlying: ChannelProvider | undefined
	private forwarding: ForwardingProvider | undefined
	private grantSubscription: GrantSubscription | undefined
	private endSubscription: EndSubscription | undefined
	subscribeGrants(
		listener: (
			handle: ObservedAcquisitionHandle,
			binding: ObservedGrantBinding,
		) => void,
	): () => void {
		if (this.grantSubscription)
			throw new WaveKitError(
				"settlement grant subscription already owned",
				"CHANNELIZER_UNAVAILABLE",
			)
		let record:
			| NonNullable<ChannelSettlementObserver["grantSubscription"]>
			| undefined
		const remove = () => {
			if (record) {
				record.active = false
				record.listener = undefined
			}
		}
		const claim = this.provider.ownListener(remove)
		if (!claim)
			throw new WaveKitError(
				"settlement listener capacity unavailable",
				"CHANNELIZER_UNAVAILABLE",
			)
		record = { listener, claim, active: true }
		this.grantSubscription = record
		return () => {
			remove()
			if (record && !record.active && record.listener === undefined)
				claim.settle(OK)
			reconcile(this.provider)
		}
	}
	subscribeEnded(
		listener: (handle: ObservedAcquisitionHandle) => void,
	): () => void {
		if (this.endSubscription)
			throw new WaveKitError(
				"settlement end subscription already owned",
				"CHANNELIZER_UNAVAILABLE",
			)
		let record:
			| NonNullable<ChannelSettlementObserver["endSubscription"]>
			| undefined
		const remove = () => {
			if (record) {
				record.active = false
				record.listener = undefined
			}
		}
		const claim = this.provider.ownListener(remove)
		if (!claim)
			throw new WaveKitError(
				"settlement listener capacity unavailable",
				"CHANNELIZER_UNAVAILABLE",
			)
		record = { listener, claim, active: true }
		this.endSubscription = record
		return () => {
			remove()
			if (record && !record.active && record.listener === undefined)
				claim.settle(OK)
			reconcile(this.provider)
		}
	}
	/** Private publication outside every atomic bank transition. */
	publishEnded(handle: ObservedAcquisitionHandle): void {
		const h = handles.get(handle)
		if (!h || h.observer !== this || h.endNotified) return
		h.endNotified = true
		const record = this.endSubscription
		const listener = record?.listener
		if (record?.active && listener) {
			try {
				listener(handle)
			} catch {
				failure(this.provider, failed())
			}
		}
	}
	constructor(
		key: symbol,
		readonly provider: ProviderLifetime,
	) {
		assertKey(key)
	}
	allocateAcquisition(
		spec: AcquisitionIdentitySpec,
	): ObservedAcquisitionHandle | undefined {
		const v = providerData(this.provider),
			r = registries.get(v.registry)!
		if (
			v.sealed ||
			v.released ||
			r.queued >= 64 ||
			(spec.activation !== "decoder" && spec.activation !== "direct") ||
			typeof spec.scannerAttempt !== "object" ||
			spec.scannerAttempt === null
		)
			return undefined
		for (const handle of v.handles)
			if (handles.get(handle)!.spec.scannerAttempt === spec.scannerAttempt)
				return undefined
		const h = new ObservedAcquisitionHandle(KEY, {
			observer: this,
			spec: {
				...spec,
				expectedRequest: Object.freeze({ ...spec.expectedRequest }),
				expectedInputCaps: Object.freeze({ ...spec.expectedInputCaps }),
			},
			controller: new AbortController(),
			permit: undefined,
			armed: false,
			canceled: false,
			intercepted: false,
			taken: false,
			actual: undefined,
			tx: undefined,
			queued: true,
			released: false,
			logical: "queued",
			terminal: false,
			ended: false,
			binding: undefined,
			continuityLost: false,
			pendingContinuityNotification: undefined,
			listeners: new Set(),
			components: new Map(),
			abortListener: undefined,
			endNotified: false,
		})
		r.queued++
		v.handles.add(h)
		if (spec.signal) {
			const record = handles.get(h)!
			record.abortListener = () => h.cancel()
			spec.signal.addEventListener("abort", record.abortListener, {
				once: true,
			})
			if (spec.signal.aborted) h.cancel()
		}
		return h
	}
	bindProvider(provider: ChannelProvider): ChannelProvider {
		if (this.underlying) {
			if (this.underlying !== provider)
				throw new WaveKitError(
					"settlement provider already bound",
					"CHANNELIZER_UNAVAILABLE",
				)
			return this.forwarding!
		}
		if (
			providerData(this.provider).sealed ||
			providerData(this.provider).released
		)
			throw new WaveKitError(
				"settlement lifetime sealed",
				"CHANNELIZER_UNAVAILABLE",
			)
		const adapter = new ForwardingProvider(this, provider)
		const invalidated = (
			sourceId: string,
			generation: number,
			ids: string[],
			cause?: string,
		) => adapter.emit("channel-invalidated", sourceId, generation, ids, cause)
		const discontinuity = (
			id: string,
			generation: number,
			sampleIndex: number,
			dropped: number,
			cause: "queue-overflow" | "input-gap",
		) => {
			this.publishPendingContinuity(id, generation)
			adapter.emit(
				"channel-discontinuity",
				id,
				generation,
				sampleIndex,
				dropped,
				cause,
			)
		}
		const a = this.provider.ownListener(() => {
			provider.off("channel-invalidated", invalidated)
			if (
				!(provider instanceof EventEmitter) ||
				provider.listeners("channel-invalidated").includes(invalidated)
			)
				throw new WaveKitError(
					"settlement listener removal incomplete",
					"CHANNELIZER_UNAVAILABLE",
				)
		})
		const b = this.provider.ownListener(() => {
			provider.off("channel-discontinuity", discontinuity)
			if (
				!(provider instanceof EventEmitter) ||
				provider.listeners("channel-discontinuity").includes(discontinuity)
			)
				throw new WaveKitError(
					"settlement listener removal incomplete",
					"CHANNELIZER_UNAVAILABLE",
				)
		})
		if (!a || !b)
			throw new WaveKitError(
				"settlement listener capacity unavailable",
				"CHANNELIZER_UNAVAILABLE",
			)
		this.underlying = provider
		this.forwarding = adapter
		provider.on("channel-invalidated", invalidated)
		provider.on("channel-discontinuity", discontinuity)
		return adapter
	}
	takeAcquisition(
		sourceId: string,
		decoderId: string,
		actualRequest: DecoderChannelRequest,
	): ObservedAcquisitionHandle | undefined {
		const v = providerData(this.provider)
		for (const handle of v.handles) {
			const h = handles.get(handle)!
			if (
				h.intercepted &&
				!h.taken &&
				!h.canceled &&
				h.actual === actualRequest &&
				h.spec.sourceId === sourceId &&
				h.spec.decoderId === decoderId
			) {
				h.taken = true
				return handle
			}
		}
		return undefined
	}
	tryReserveObservedTransaction(
		handle: ObservedAcquisitionHandle,
	): ObservedTransaction | undefined {
		const h = handles.get(handle),
			v = providerData(this.provider),
			r = registries.get(v.registry)!
		const permit = h?.permit ? permits.get(h.permit) : undefined
		if (
			!h ||
			h.observer !== this ||
			!h.taken ||
			h.tx ||
			h.canceled ||
			v.sealed ||
			!permit ||
			permit.token !== handle.requestToken ||
			permit.status !== "prepared"
		)
			return undefined
		if (
			r.receipts + 6 > 128 ||
			r.V + r.P + r.L + 12 > 128 ||
			!commitPermit(permit)
		) {
			permit.status = "aborted"
			return undefined
		}
		// Both banks now committed; nothing below invokes foreign code or notifications.
		r.receipts += 6
		r.P += 6
		r.L += 6
		const tx = new ObservedTransaction(KEY, {
			handle,
			permit,
			processCells: permit.cells
				.filter(x => x.kind === "R")
				.map(cell => ({ cell, process: undefined, released: false })),
			sendCells: permit.cells
				.filter(x => x.kind === "N")
				.map(cell => ({
					cell,
					send: undefined,
					receiptReturned: false,
					released: false,
				})),
			shared: new Set(),
		})
		h.tx = tx
		h.logical = "acquiring"
		h.queued = false
		r.queued--
		return tx
	}
	claimProcess(
		tx: ObservedTransaction,
		source: ProcessSourceSnapshot,
	): ProcessClaim | undefined {
		const t = transactions.get(tx),
			v = providerData(this.provider)
		if (
			!t ||
			handles.get(t.handle)!.observer !== this ||
			handles.get(t.handle)!.terminal ||
			handles.get(t.handle)!.canceled ||
			v.sealed
		)
			return undefined
		const slot = t.processCells.find(x => !x.process && !x.released)
		if (
			!slot ||
			source.sourceId !== handles.get(t.handle)!.spec.sourceId ||
			source.sampleRateHz !==
				handles.get(t.handle)!.spec.expectedInputCaps.sampleRate ||
			source.centerHz !==
				handles.get(t.handle)!.spec.expectedInputCaps.centerFreq ||
			!Number.isSafeInteger(source.generation) ||
			source.generation < 0 ||
			!Number.isFinite(source.centerHz) ||
			!Number.isFinite(source.sampleRateHz) ||
			source.sampleRateHz <= 0
		)
			return undefined
		const process = new ProcessClaim(
			KEY,
			this.provider,
			Object.freeze({ ...source }),
			{
				tx,
				cell: slot.cell,
				disposition: "assignedStarting",
				sealed: false,
				decision: "notCalled",
				child: undefined,
				close: false,
				start: false,
				stdio: false,
				nativeRefunded: false,
				released: false,
				nextToken: 1n,
				issued: 0n,
				sends: new Map(),
				current: new Map(),
				locals: new Map(),
			},
		)
		slot.process = process
		v.processes.add(process)
		return process
	}
	shareProcess(tx: ObservedTransaction, process: ProcessClaim): boolean {
		const t = transactions.get(tx),
			p = processes.get(process),
			v = providerData(this.provider)
		if (
			!t ||
			!p ||
			process.provider !== this.provider ||
			p.released ||
			p.sealed ||
			handles.get(t.handle)!.observer !== this ||
			handles.get(t.handle)!.terminal ||
			handles.get(t.handle)!.canceled ||
			process.source.sourceId !== handles.get(t.handle)!.spec.sourceId ||
			process.source.sampleRateHz !==
				handles.get(t.handle)!.spec.expectedInputCaps.sampleRate ||
			process.source.centerHz !==
				handles.get(t.handle)!.spec.expectedInputCaps.centerFreq ||
			v.sealed
		)
			return false
		if (p.tx === tx || t.shared.has(process)) return true
		const slot = t.processCells.find(x => !x.process && !x.released)
		if (!slot) return false
		slot.released = true
		refund(t.permit, slot.cell)
		registries.get(v.registry)!.P--
		t.shared.add(process)
		return true
	}
	claimSend(
		tx: ObservedTransaction,
		process: ProcessClaim,
		id: string,
	): SendClaim | undefined {
		const t = transactions.get(tx),
			p = processes.get(process),
			v = providerData(this.provider)
		if (
			!t ||
			!p ||
			process.provider !== this.provider ||
			p.released ||
			p.sealed ||
			p.disposition !== "childOwned" ||
			(p.tx !== tx && !t.shared.has(process)) ||
			handles.get(t.handle)!.terminal ||
			handles.get(t.handle)!.canceled ||
			handles.get(t.handle)!.observer !== this ||
			v.sealed ||
			!/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
			p.current.has(id) ||
			p.nextToken > MAX_SETTLEMENT_TOKEN
		)
			return undefined
		const slot = t.sendCells.find(x => !x.send && !x.released)
		if (!slot) return undefined
		const token = String(p.nextToken)
		p.issued = p.nextToken
		p.nextToken++
		const send = new SendClaim(KEY, process, id, token, {
			tx,
			cell: slot.cell,
			phase: "pending",
			captured: undefined,
			recorded: false,
			disposed: false,
			connector: undefined,
			released: false,
			continuityLost: false,
		})
		slot.send = send
		p.sends.set(token, send)
		p.current.set(id, send)
		return send
	}
	/** Capture only manager-owned current native identity, before public reentry. */
	captureDiscontinuity(
		process: ProcessClaim,
		id: string,
		generation: number,
	): SendClaim | undefined {
		const p = processes.get(process)
		if (
			!p ||
			process.provider !== this.provider ||
			p.released ||
			p.sealed ||
			p.close ||
			generation !== process.source.generation
		)
			return undefined
		const send = p.current.get(id)
		if (!send || send.process !== process || p.sends.get(send.token) !== send)
			return undefined
		const s = sends.get(send)!
		const handle = transactions.get(s.tx)!.handle,
			h = handles.get(handle)!
		if (
			s.phase !== "opened" ||
			!s.recorded ||
			s.released ||
			s.disposed ||
			h.observer !== this ||
			h.released ||
			h.canceled ||
			h.ended ||
			(h.terminal && !h.binding) ||
			(h.binding && h.binding.send !== send)
		)
			return undefined
		s.continuityLost = true
		if (h.binding?.send === send && !h.continuityLost) {
			h.continuityLost = true
			h.pendingContinuityNotification = send
		}
		return send
	}
	/** Delivery only: the public ID/generation event cannot manufacture a gap. */
	private publishPendingContinuity(id: string, generation: number): void {
		const v = providerData(this.provider)
		if (v.handles.size > 192) {
			failure(this.provider, failed())
			this.sealAdmission()
			return
		}
		for (const handle of [...v.handles]) {
			const send = handles.get(handle)!.pendingContinuityNotification
			if (send?.id === id && send.process.source.generation === generation)
				this.publishCapturedDiscontinuity(send)
		}
	}
	/** Idempotent fallback when an earlier public listener throws or reenters. */
	publishCapturedDiscontinuity(send: SendClaim): void {
		const s = sends.get(send)
		if (!s || send.process.provider !== this.provider) return
		const handle = transactions.get(s.tx)!.handle,
			h = handles.get(handle)!
		if (h.observer !== this || h.pendingContinuityNotification !== send) return
		h.pendingContinuityNotification = undefined
		if (
			h.released ||
			h.canceled ||
			h.ended ||
			h.binding?.send !== send ||
			h.binding.process !== send.process ||
			h.binding.channelId !== send.id ||
			h.binding.generation !== send.process.source.generation
		)
			return
		notify(handle)
	}
	captureTerminal(
		process: ProcessClaim,
		id: string,
		kind: "opened" | "rejected" | "closed",
	): SendClaim | undefined {
		const p = processes.get(process)
		if (!p || process.provider !== this.provider) return undefined
		const send = p.current.get(id)
		if (!send) return undefined
		const s = sends.get(send)!
		if (s.phase === "pending" && (kind === "opened" || kind === "rejected")) {
			s.phase = kind === "opened" ? "opened" : "terminal"
		} else if (
			(s.phase === "pending" || s.phase === "opened") &&
			kind === "closed"
		)
			s.phase = "terminal"
		else return undefined
		s.captured = kind
		s.recorded = false
		if (s.phase === "terminal") p.current.delete(id)
		return send
	}
	recordTerminal(
		send: SendClaim,
		kind: "opened" | "rejected" | "closed",
	): void {
		const s = sends.get(send)
		if (!s || send.process.provider !== this.provider || s.captured !== kind)
			return
		s.recorded = true
		reconcile(this.provider)
	}
	recordDisposed(process: ProcessClaim, token: string, id: string): boolean {
		const p = processes.get(process)
		if (!p || process.provider !== this.provider || !isSettlementToken(token))
			return false
		const send = p.sends.get(token)
		if (!send) return BigInt(token) <= p.issued
		if (send.id !== id) return false
		const s = sends.get(send)!
		if (s.disposed) return true
		s.disposed = true
		reconcile(this.provider)
		return true
	}
	recordGrant(send: SendClaim, binding: ObservedGrantBinding): void {
		const s = sends.get(send)
		if (
			!s ||
			send.process.provider !== this.provider ||
			s.phase !== "opened" ||
			!s.recorded
		)
			return
		const h = handles.get(transactions.get(s.tx)!.handle)!
		if (
			h.terminal ||
			h.binding ||
			h.canceled ||
			h.ended ||
			binding.send !== send ||
			binding.process !== send.process ||
			binding.channelId !== send.id ||
			binding.sourceId !== h.spec.sourceId ||
			binding.decoderId !== h.spec.decoderId ||
			binding.generation !== send.process.source.generation
		)
			return
		h.binding = Object.freeze({
			...binding,
			realised: Object.freeze({ ...binding.realised }),
		})
		// A gap can arrive after opened while connector completion is still pending.
		// Transfer only this selected send's bit before grant/result callbacks.
		h.continuityLost ||= s.continuityLost
		h.logical = "granted"
		const handle = transactions.get(s.tx)!.handle,
			record = this.grantSubscription
		const listener = record?.listener
		if (record?.active && listener) {
			try {
				listener(handle, h.binding)
			} catch {
				failure(this.provider, failed())
			}
		}
		notify(handle)
	}
	endGrant(send: SendClaim, _cause: string): void {
		const s = sends.get(send)
		if (!s || send.process.provider !== this.provider) return
		const handle = transactions.get(s.tx)!.handle,
			h = handles.get(handle)!
		if (h.binding?.send !== send || h.ended) return
		h.ended = true
		this.publishEnded(handle)
		notify(handle)
	}
	finishAcquisition(handle: ObservedAcquisitionHandle): void {
		const h = handles.get(handle)
		if (!h || h.observer !== this || h.terminal) return
		h.terminal = true
		h.logical = "terminal"
		if (!h.binding) h.ended = true
		if (h.abortListener && h.spec.signal)
			h.spec.signal.removeEventListener("abort", h.abortListener)
		h.abortListener = undefined
		if (h.tx) {
			const tx = transactions.get(h.tx)!
			// Missing failed-acquisition slots have no escaped activation capability. Successful grants require explicit slots.
			if (!h.binding) {
				for (const kind of components)
					if (!h.components.has(kind)) {
						const c = new ConsumerComponent(KEY, {
							handle,
							kind,
							begun: false,
							sealed: true,
							outcome: OK,
						})
						h.components.set(kind, c)
					}
			}
			for (const slot of tx.processCells) slot.process?.recordNoProcess()
		} else {
			for (const kind of components)
				if (!h.components.has(kind))
					h.components.set(
						kind,
						new ConsumerComponent(KEY, {
							handle,
							kind,
							begun: false,
							sealed: true,
							outcome: OK,
						}),
					)
			if (h.permit) {
				const permit = permits.get(h.permit)!
				if (permit.status === "prepared") permit.status = "aborted"
			}
		}
		reconcile(this.provider)
		if (h.ended) this.publishEnded(handle)
		notify(handle)
	}
	sealAdmission(): void {
		const v = providerData(this.provider)
		if (v.sealed) return
		v.sealed = true
		for (const handle of [...v.handles]) handle.cancel()
		for (const process of v.processes) process.sealStartup()
	}
	releaseProviderReferences(key: symbol): void {
		if (key !== KEY) return
		this.underlying = undefined
		this.forwarding = undefined
		this.grantSubscription = undefined
		this.endSubscription = undefined
	}
	attemptLocalCleanup(): Promise<readonly CleanupOutcome[]> {
		return this.provider.attemptLocalCleanup()
	}
	inspectFinal(producerOutcome: CleanupOutcome): SettlementFinalOutcome {
		return this.provider.inspectFinal(producerOutcome)
	}
	snapshot(): SettlementSnapshot {
		return providerData(this.provider).registry.snapshot()
	}
}

/** Concrete process transports, never a foreign callback in a bank transaction. */
export function registerSettlementTransport(
	process: ProcessClaim,
	transport: SettlementTransport,
): boolean {
	const p = processes.get(process)
	if (!p || p.released) return false
	const v = providerData(process.provider)
	if (v.transports.has(process)) return false
	v.transports.set(process, transport)
	return true
}
