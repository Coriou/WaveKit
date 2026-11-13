import {
	TuningLedger,
	type LedgerConnection,
	type TuningReceipt,
	type TuningWriter,
} from "../../src/core/tuning-ledger.js"
import { settleBytes } from "../../src/core/spectrum/network-settle.js"

/** rtl_tcp opcodes of the frames a fake tuner writes. */
const OPCODES: Record<string, number> = {
	"set-frequency": 0x01,
	"set-sample-rate": 0x02,
	"set-gain-mode": 0x03,
	"set-gain": 0x04,
	"set-freq-correction": 0x05,
	"set-test-mode": 0x07,
	"set-agc-mode": 0x08,
}

/**
 * A real TuningLedger fed like SourceManager feeds it, for in-process fakes without a socket: one
 * connection of `sourceId` whose session starts at `start()`, a position advanced by every payload
 * byte a fake fanout writes (`advance`), and receipts for frames a fake tuner "flushes" (`write`).
 * The settle is `settleMs` at the caps rate with no in-flight estimate (a fake has no socket
 * buffers): 0 B in flight, so B(R) = R.pos + settleMs of samples.
 */
export class FakeReceiverLedger {
	readonly ledger: TuningLedger
	settleMs: number
	readonly bps: number
	private conn: LedgerConnection
	private rateHz: number

	constructor(
		readonly sourceId: string,
		opts: { rateHz: number; settleMs: number; bytesPerSample?: number },
	) {
		this.rateHz = opts.rateHz
		this.settleMs = opts.settleMs
		this.bps = opts.bytesPerSample ?? 2
		this.ledger = new TuningLedger({
			settleLink: () => ({
				configuredSettleMs: this.settleMs,
				inFlightBytes: 0,
			}),
			frameBytes: () => this.bps,
			capsRate: () => this.rateHz,
		})
		this.conn = this.ledger.connection(sourceId)
	}

	/** The live session's first payload is about to be forwarded. */
	start(): void {
		this.conn.start()
	}

	/** Payload bytes forwarded to the source stream. */
	advance(bytes: number): void {
		const session = this.conn.session
		if (session) session.pos += bytes
	}

	/** A reconnect: the session ends; the next `start()` begins a new one. */
	reconnect(): void {
		this.conn.close()
		this.conn = this.ledger.connection(this.sourceId)
	}

	/** One frame flushed now (a fake tuner's write), with its receipt (null: none recorded). */
	write(
		command: string,
		value: number,
		writer: TuningWriter | undefined,
		jobId?: string,
	): TuningReceipt | null {
		const op = OPCODES[command]
		if (op === undefined) return null
		const frame = Buffer.alloc(5)
		frame.writeUInt8(op, 0)
		frame.writeUInt32BE(value >>> 0, 1)
		let receipt: TuningReceipt | null = null
		const done = this.conn.write(
			frame,
			writer === undefined
				? undefined
				: { writer, ...(jobId !== undefined ? { jobId } : {}) },
			r => {
				receipt = r
			},
		)
		done(null)
		if (command === "set-sample-rate") this.rateHz = value
		return receipt
	}

	/**
	 * Raw rtl_tcp frames flushed now, as SourceManager.writeToSource receipts them: the fake source
	 * manager of a real TunerController writes through this. Returns true (the write is accepted).
	 */
	writePayload(
		payload: Buffer,
		tag?: { writer: TuningWriter; jobId?: string },
		onReceipt?: (receipt: TuningReceipt | null) => void,
	): boolean {
		for (let off = 0; off + 5 <= payload.length; off += 5)
			if (payload[off] === 0x02) this.rateHz = payload.readUInt32BE(off + 1)
		this.conn.write(payload, tag, onReceipt)(null)
		return true
	}

	/** The settle in payload bytes at the current rate. */
	settleBytes(): number {
		return settleBytes(this.rateHz, this.bps, {
			configuredSettleMs: this.settleMs,
			inFlightBytes: 0,
		})
	}

	/**
	 * Receipts of `centreHz` and `rateHz` by `writer` on the live session, then the position moved
	 * past their settle (bytes other consumers took before the engine's first byte), so a branch
	 * opened now is proven from its first byte. Starts the session if needed.
	 */
	prove(
		centreHz: number,
		rateHz: number,
		writer: TuningWriter = "operator",
	): void {
		this.start()
		this.write("set-sample-rate", rateHz, writer)
		this.write("set-frequency", centreHz, writer)
		this.advance(this.settleBytes() + 4 * this.bps)
	}
}

type ReceiptHook = (
	sourceId: string,
	command: string,
	value: number,
	writer: TuningWriter | undefined,
	jobId?: string,
) => TuningReceipt | null

/**
 * A ledger for an arbiter double: the live session holds receipts of the fake tuner's current
 * centre and rate (settle 0: proven at once), and every frame the tuner writes is receipted.
 */
export function attachReceiverLedger(
	tuner: {
		states: Map<string, { frequency: number; sampleRate: number }>
		receipts: ReceiptHook | null
	},
	sourceId = "rtl",
): FakeReceiverLedger {
	const state = tuner.states.get(sourceId)!
	const ledger = new FakeReceiverLedger(sourceId, {
		rateHz: state.sampleRate,
		settleMs: 0,
	})
	ledger.prove(state.frequency, state.sampleRate)
	tuner.receipts = (_id, command, value, writer, jobId) =>
		ledger.write(command, value, writer, jobId)
	return ledger
}

/**
 * Proves `centreHz` and `rateHz` for `sourceId` on `sources` (its `tuningLedger`): receipts on a
 * live session, then `leadMs` of payload forwarded before any engine opens (bytes other consumers
 * took), so an engine's first block, and a fake host's summaries at sample 0, lie past the
 * settle. A `fanout` given advances the position by every chunk it writes (SourceManager counts
 * the payload before the fanout sees it).
 */
export function proveSource(
	sources: { tuningLedger?: TuningLedger },
	sourceId: string,
	centreHz: number,
	rateHz: number,
	opts: {
		fanout?: { ledgerFeed: { advance(bytes: number): void } | null }
		leadMs?: number
		settleMs?: number
	} = {},
): FakeReceiverLedger {
	const ledger = new FakeReceiverLedger(sourceId, {
		rateHz,
		settleMs: opts.settleMs ?? 50,
	})
	ledger.prove(centreHz, rateHz)
	ledger.advance(
		ledger.bps * Math.round((rateHz * (opts.leadMs ?? 1000)) / 1000),
	)
	sources.tuningLedger = ledger.ledger
	if (opts.fanout) opts.fanout.ledgerFeed = ledger
	return ledger
}
