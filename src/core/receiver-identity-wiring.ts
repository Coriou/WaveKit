/**
 * The production chain from the receiver identity tracker to the learned state, the
 * tuner controller and the source status (called from src/index.ts, tested on its own).
 *
 * - tracker "connection" (disconnect, new connection) -> learned state pending;
 * - tracker "settled" -> learned state binds the receiver -> tuner noteReceiverBound (onBound);
 * - the source status `receiver` field reads the learned state's view and the tuner's restore.
 */
import type {
	SourceCandidateStatus,
	SourceReceiverStatus,
} from "@wavekit/api-types"
import type { ReceiverIdentity } from "./receiver-identity.js"
import type {
	ReceiverBinding,
	ReceiverLearnedState,
} from "./receiver-identity-state.js"

export interface ReceiverWiringTracker {
	current(sourceId: string): ReceiverIdentity | undefined
	on(event: "connection", fn: (sourceId: string) => void): unknown
	on(
		event: "settled",
		fn: (
			sourceId: string,
			identity: ReceiverIdentity,
			previous: ReceiverIdentity | undefined,
		) => void,
	): unknown
}

export interface ReceiverWiringTuner {
	noteReceiverBound(
		sourceId: string,
		binding: ReceiverBinding,
		identity?: ReceiverIdentity,
	): void
	receiverTuningRestore(
		sourceId: string,
	): { restored: boolean; reason: string } | undefined
}

export interface ReceiverWiringSources {
	setReceiverStatusSource(
		source: ((id: string) => SourceReceiverStatus | undefined) | null,
	): void
	getSelectedCandidate(id: string): SourceCandidateStatus | undefined
}

/**
 * The learned state's `onBound`: the tuner learns the receiver binding (with the tracker's last
 * settled identity). `tuner` is read at each call: the controller is built after the learned state.
 */
export function receiverBoundToTuner(
	tracker: Pick<ReceiverWiringTracker, "current">,
	tuner: () => ReceiverWiringTuner | undefined,
): (sourceId: string, binding: ReceiverBinding) => void {
	return (sourceId, binding) =>
		tuner()?.noteReceiverBound(sourceId, binding, tracker.current(sourceId))
}

/** Subscribes the learned state to the tracker. */
export function wireReceiverTracker(
	tracker: ReceiverWiringTracker,
	learned: Pick<ReceiverLearnedState, "onConnection" | "onIdentity">,
): void {
	tracker.on("connection", id => {
		void learned.onConnection(id)
	})
	tracker.on("settled", (id, identity, previous) => {
		void learned.onIdentity(id, identity, previous)
	})
}

/** The source status `receiver` field, from the learned state's view and the tuner's restore. */
export function wireReceiverStatus(
	sources: ReceiverWiringSources,
	learned: Pick<ReceiverLearnedState, "view">,
	tuner: Pick<ReceiverWiringTuner, "receiverTuningRestore">,
): void {
	sources.setReceiverStatusSource(id => {
		const view = learned.view(id)
		if (!view) return undefined
		const candidate = sources.getSelectedCandidate(id)
		return {
			key: view.key,
			strength: view.strength,
			...(view.tunerType !== undefined ? { tunerType: view.tunerType } : {}),
			...(view.serial !== undefined ? { serial: view.serial } : {}),
			...(candidate?.label !== undefined
				? { candidateLabel: candidate.label }
				: {}),
			selectedBecause: candidate?.selectedBecause ?? "configured",
			learnedStateNamespace: view.learnedStateNamespace,
			namespaceState: view.namespaceState,
			restoredTuning: tuner.receiverTuningRestore(id) ?? {
				restored: false,
				reason: "not connected yet",
			},
		}
	})
}
