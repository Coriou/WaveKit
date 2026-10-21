/** Mirrors the process bases’ graceful SIGTERM → SIGKILL deadline. */
export const PLACEMENT_STOP_TIMEOUT_MS = 5_000

export type PlacementActual =
	| "idle"
	| "starting"
	| "running"
	| "stopping"
	| "stopping-failed"

interface PlacementLifecycleOptions {
	start: (generation: number) => Promise<boolean>
	stop: (signal: AbortSignal) => Promise<void>
	running: () => boolean
	invalidate: () => void
	incomplete: () => void
	idle: () => void
}

/** One owner for a placement, including operations that outlive their caller. */
export class PlacementLifecycle {
	desired: "running" | "stopped" = "stopped"
	generation = 0
	decoderGeneration = 0
	runGeneration = 0
	runDecoderGeneration = 0
	error: unknown = null
	actual: PlacementActual = "idle"
	private operation: Promise<void> | undefined
	private starting = false
	/** A restart keeps running intent while its parent prepares the stopped placements. */
	private holdRunning = false
	private cancelStart: (() => void) | undefined
	private confirmStop: (() => void) | undefined
	private failedGeneration = -1
	private waiters = new Set<() => void>()

	constructor(private readonly options: PlacementLifecycleOptions) {}

	get pending(): boolean {
		return this.operation !== undefined || this.starting
	}

	record(
		desired: "running" | "stopped",
		decoderGeneration = this.decoderGeneration,
	): void {
		this.decoderGeneration = decoderGeneration
		this.desired = desired
		this.holdRunning = false
		this.error = null
		++this.generation
		if (desired === "stopped") {
			this.options.invalidate()
			this.cancelStart?.()
		}
		this.notify()
	}

	request(desired: "running" | "stopped", restart = false): Promise<void> {
		if (restart && this.options.running()) this.actual = "stopping-failed"
		this.record(desired)
		this.holdRunning = restart
		const generation = this.generation
		this.kick()
		return new Promise(resolve => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const finish = () => {
				clearTimeout(timer)
				this.waiters.delete(check)
				resolve()
			}
			const check = () => {
				if (
					generation !== this.generation ||
					!this.pending ||
					(desired === "stopped" && this.actual === "stopping-failed")
				)
					finish()
			}
			timer = setTimeout(() => {
				if (
					desired === "stopped" &&
					generation === this.generation &&
					this.desired === "stopped" &&
					(this.pending || this.options.running())
				) {
					this.actual = "stopping-failed"
					this.options.incomplete()
				}
				finish()
			}, PLACEMENT_STOP_TIMEOUT_MS)
			this.waiters.add(check)
			check()
		})
	}

	/** Adapter events confirm state; crash restart intent belongs to the scheduler. */
	exited(): void {
		if (this.options.running()) return
		this.options.invalidate()
		this.confirmStop?.()
		if (this.actual === "running") this.failedGeneration = this.generation
		else if (this.actual === "stopping-failed") this.failedGeneration = -1
		if (!this.pending) {
			this.actual = "idle"
			this.options.idle()
		}
		this.kick()
	}

	settled(): Promise<void> {
		return new Promise(resolve => {
			const check = () => {
				if (this.pending) return
				this.waiters.delete(check)
				resolve()
			}
			this.waiters.add(check)
			check()
		})
	}

	private notify(): void {
		for (const waiter of this.waiters) waiter()
	}

	kick(): void {
		this.notify()
		if (this.operation) {
			if (this.desired === "stopped" && this.options.running())
				this.cancelStart?.()
			return
		}
		if (
			this.desired === "running" &&
			this.options.running() &&
			this.actual === "running"
		) {
			this.actual = "running"
			return
		}
		if (this.desired === "stopped" && !this.options.running()) {
			if (!this.starting) {
				this.actual = "idle"
				this.options.idle()
			}
			return
		}
		if (this.desired === "running" && this.starting) return
		if (this.failedGeneration === this.generation) return
		if (
			this.desired === "running" &&
			this.holdRunning &&
			!this.options.running()
		)
			return
		const generation = this.generation
		const start = this.desired === "running" && !this.options.running()
		this.actual = start ? "starting" : "stopping"
		if (!start) this.options.invalidate()
		if (start) {
			this.runGeneration = generation
			this.runDecoderGeneration = this.decoderGeneration
			this.starting = true
			this.error = null
		}
		const operation = Promise.resolve().then(async () => {
			try {
				if (start) {
					let timer: ReturnType<typeof setTimeout> | undefined
					const abandoned = new Promise<false>(resolve => {
						this.cancelStart = () => {
							if (this.options.running()) {
								resolve(false)
								return
							}
							timer ??= setTimeout(
								() => resolve(false),
								PLACEMENT_STOP_TIMEOUT_MS,
							)
						}
					})
					const starting = this.options.start(generation).finally(() => {
						this.starting = false
						this.notify()
						clearTimeout(timer)
						this.cancelStart = undefined
						queueMicrotask(() => this.kick())
					})
					if (this.desired === "stopped") this.cancelStart?.()
					if (!(await Promise.race([starting, abandoned])))
						this.failedGeneration = generation
				} else {
					const controller = new AbortController()
					const exited = new Promise<void>(resolve => {
						this.confirmStop = resolve
					})
					try {
						await Promise.race([this.options.stop(controller.signal), exited])
					} finally {
						controller.abort()
						this.confirmStop = undefined
					}
				}
			} catch (error) {
				this.error = error
				this.failedGeneration = generation
			} finally {
				if (generation !== this.generation) this.error = null
				this.operation = undefined
				this.actual = this.options.running()
					? start && generation === this.generation
						? "running"
						: "stopping-failed"
					: "idle"
				if (
					this.starting &&
					this.desired === "stopped" &&
					!this.options.running()
				)
					this.actual = "stopping-failed"
				if (!start && this.options.running())
					this.failedGeneration = this.generation
				if (this.actual === "stopping-failed") this.options.incomplete()
				if (this.actual !== "running") this.options.invalidate()
				if (this.actual === "idle" && !this.starting) this.options.idle()
				this.kick()
				this.notify()
			}
		})
		this.operation = operation
	}
}
