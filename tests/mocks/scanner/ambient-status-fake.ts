import type { EventEmitter } from "node:events"

/** Older ambient tests supply a manager subset; provide its current eligibility contract. */
export function ambientStatusFake(decoders: EventEmitter): void {
	const manager = decoders as EventEmitter & {
		getAllStatus(): {
			id: string
			owner?: string
			running?: boolean
			health?: string
		}[]
		getStatus?: (id: string) => unknown
	}
	const original = manager.getStatus?.bind(manager)
	manager.getStatus = id => {
		const status = original
			? original(id)
			: manager.getAllStatus().find(status => status.id === id)
		return status && typeof status === "object"
			? { running: true, health: "running", ...status }
			: undefined
	}
}
