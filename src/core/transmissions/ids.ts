/**
 * Transmission ids: `tx_` + the scanner's dependency-free monotonic ULID, re-exported here so
 * core modules name transmissions without importing the scanner.
 */
import { ulid } from "../scanner/ids.js"

export { ulid }

/** A new txId at `atMs` (floored: the ULID takes whole milliseconds). */
export function newTxId(atMs: number): string {
	return `tx_${ulid(Math.max(0, Math.floor(atMs)))}`
}
