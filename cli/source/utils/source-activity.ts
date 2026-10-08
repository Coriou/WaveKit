import type { SourceStatus } from "../types.js"

export const SOURCE_SNAPSHOT_TIMEOUT_MS = 15000

/** Snapshot freshness is independent of the server's sample freshness. */
export function sourceActivityLabel(
	source: SourceStatus,
	snapshotFresh: boolean,
): string {
	if (!snapshotFresh) return "status stale"
	return (
		source.activity?.state ?? (source.connected ? "connected" : "disconnected")
	)
}

export function sourceSnapshotFresh(
	receivedAt: number | null,
	now: number,
): boolean {
	return receivedAt !== null && now - receivedAt < SOURCE_SNAPSHOT_TIMEOUT_MS
}
