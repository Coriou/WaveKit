// What the connection chip says. Pure.
import type { AccessStoreState, ConnectionState } from "../../data/index.ts"

export interface ConnectionNotice {
	title: string
	detail: string | null
	busy: boolean
	tone: "quiet" | "amber"
}

/** Null while everything is fine (open socket, legacy core or a protected core with a session). */
export function connectionNotice(
	connection: ConnectionState,
	access: AccessStoreState,
	readOnly: boolean,
): ConnectionNotice | null {
	if (readOnly)
		return {
			title: "Pair this browser",
			detail: "Read-only until this browser is paired with the receiver",
			busy: false,
			tone: "amber",
		}
	if (access.access === null && access.error !== null && connection !== "open")
		return {
			title: "Can’t reach the receiver",
			detail: "Retrying…",
			busy: true,
			tone: "amber",
		}
	if (connection === "connecting")
		return { title: "Connecting…", detail: null, busy: true, tone: "quiet" }
	if (connection === "closed")
		return {
			title: "Reconnecting…",
			detail: "Live updates paused",
			busy: true,
			tone: "quiet",
		}
	return null
}
