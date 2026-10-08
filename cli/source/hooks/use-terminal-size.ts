import { useStdout } from "ink"
import { useEffect, useRef, useState } from "react"

export interface TerminalSize {
	columns: number
	rows: number
}

/**
 * Ink only listens to 'resize' when not in CI, so subscribe directly. Debounce
 * 50 ms; on any shrink write one clear so re-wrapped old lines leave no residue.
 */
export function useTerminalSize(debounceMs = 50): TerminalSize {
	const { stdout } = useStdout()
	const read = (): TerminalSize => ({
		columns: stdout.columns || 80,
		rows: stdout.rows || 24,
	})
	const [size, setSize] = useState<TerminalSize>(read)
	const last = useRef(size)
	useEffect(() => {
		let timer: NodeJS.Timeout | null = null
		const onResize = (): void => {
			if (timer) clearTimeout(timer)
			timer = setTimeout(() => {
				const next = { columns: stdout.columns || 80, rows: stdout.rows || 24 }
				const prev = last.current
				if (next.columns < prev.columns || next.rows < prev.rows)
					stdout.write("\x1b[2J\x1b[H")
				last.current = next
				setSize(next)
			}, debounceMs)
		}
		stdout.on("resize", onResize)
		return () => {
			stdout.off("resize", onResize)
			if (timer) clearTimeout(timer)
		}
	}, [stdout, debounceMs])
	return size
}
