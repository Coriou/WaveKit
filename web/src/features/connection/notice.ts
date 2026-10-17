// What the connection chip says. Pure.
import type { AccessStoreState, ConnectionState } from "../../data/index.ts"

export interface ConnectionNotice {
	title: string
	detail: string | null
	busy: boolean
	tone: "quiet" | "amber"
	/** The chip opens the pairing sheet (a protected core that pairs browsers). */
	pair: boolean
}

/** Null while everything is fine (open socket, legacy core or a protected core with a session). */
export function connectionNotice(
	connection: ConnectionState,
	access: AccessStoreState,
	readOnly: boolean,
): ConnectionNotice | null {
	if (readOnly) {
		const pair =
			access.access?.mode === "protected" &&
			access.access.bootstrap.access.pairingAvailable
		return {
			title: "Pair this browser",
			detail: pair
				? "Read-only until paired · Enter a code"
				: "Read-only · This receiver is not pairing browsers",
			busy: false,
			tone: "amber",
			pair,
		}
	}
	if (access.access === null && access.error !== null && connection !== "open")
		return {
			title: "Can’t reach the receiver",
			detail: "Retrying…",
			busy: true,
			tone: "amber",
			pair: false,
		}
	if (connection === "connecting")
		return {
			title: "Connecting…",
			detail: null,
			busy: true,
			tone: "quiet",
			pair: false,
		}
	if (connection === "closed")
		return {
			title: "Reconnecting…",
			detail: "Live updates paused",
			busy: true,
			tone: "quiet",
			pair: false,
		}
	return null
}

/** What the pairing sheet says when POST /api/access/pair fails (`code` from the core, null otherwise). */
export function pairError(code: string | null, answered: boolean): string {
	switch (code) {
		case "PAIRING_INVALID":
			return "That code is not valid. It may be used or older than 10 minutes; ask for a new one."
		case "MALFORMED_REQUEST":
			return "Check the code (ten letters or digits) and the name."
		case "PAIRING_RATE_LIMITED":
			return "Too many tries. Wait a minute, then try again."
		case "SESSION_CAPACITY":
			return "The receiver has as many paired browsers as it allows. Remove one in Settings › Devices on a paired browser."
		case "ORIGIN_FORBIDDEN":
		case "HOST_FORBIDDEN":
			return "The receiver does not accept this address. Add it to access.allowedOrigins."
		case "ACCESS_UNAVAILABLE":
			return "The receiver is restarting. Try again in a moment."
		default:
			return answered
				? "Pairing failed. Try again."
				: "Can’t reach the receiver. Try again."
	}
}
