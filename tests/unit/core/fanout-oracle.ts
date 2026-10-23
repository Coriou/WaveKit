import { PassThrough } from "node:stream"

interface OracleBranchConfig {
	id: string
	highWaterMark: number
	deferred?: boolean
	startup?: { highWaterMark: number; durationMs: number }
}

export function createFanoutOracle(configs: OracleBranchConfig[]) {
	const branches = configs.map(config => {
		const stream = new PassThrough({ highWaterMark: config.highWaterMark })
		const chunks: Buffer[] = []
		const result = {
			get output(): number[] {
				return Array.from(Buffer.concat(chunks))
			},
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
			totalBytesWritten: 0,
			transitions: [] as ("bp" | "drain")[],
		}
		stream.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})
		stream.pause()
		let refusing = false
		let startupDraining = false
		let startupMark = config.startup?.highWaterMark
		const timer = config.startup
			? setTimeout(() => {
					startupMark = undefined
					startupDraining = stream.writableLength >= config.highWaterMark
				}, config.startup.durationMs)
			: undefined
		return {
			id: config.id,
			stream,
			result,
			write(chunk: Buffer) {
				if (config.deferred) return
				result.totalBytesWritten += chunk.length
				if (
					startupDraining &&
					!stream.destroyed &&
					!stream.writableEnded &&
					stream.writableLength < config.highWaterMark
				)
					startupDraining = false
				if (startupDraining || refusing) {
					result.droppedBytesTotal += chunk.length
					result.droppedChunksTotal++
					return
				}
				const accepted = stream.write(chunk)
				if (
					startupMark === undefined
						? !accepted
						: stream.writableLength > startupMark
				) {
					refusing = true
					result.transitions.push("bp")
					stream.once("drain", () => {
						refusing = false
						result.transitions.push("drain")
					})
				}
			},
			dispose() {
				clearTimeout(timer)
				stream.destroy()
			},
		}
	})
	return {
		branches,
		distribute(chunk: Buffer) {
			for (const branch of branches) branch.write(chunk)
		},
		consume(id: string, bytes: number) {
			branches.find(branch => branch.id === id)?.stream.read(bytes)
		},
		dispose() {
			for (const branch of branches) branch.dispose()
		},
	}
}
