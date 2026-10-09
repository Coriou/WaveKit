import { Text } from "ink"
import { Component, type ReactNode } from "react"
import { sanitize } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

interface Props {
	children: ReactNode
}
interface State {
	message: string | null
}

/** Any thrown value, Error or not, becomes one sanitised line. */
function messageOf(thrown: unknown): string {
	const raw =
		thrown instanceof Error
			? thrown.message
			: typeof thrown === "string"
				? thrown
				: String(thrown)
	return sanitize(raw).trim() || "?"
}

/**
 * Wraps the whole frame (spec §6.6). The app's key hook lives above it, so q and r stay
 * live; `r` remounts it through a new key. The fallback keeps the 1-column gutter (§8).
 */
export class ErrorBoundary extends Component<Props, State> {
	override state: State = { message: null }

	static getDerivedStateFromError(thrown: unknown): State {
		return { message: messageOf(thrown) }
	}

	override render(): ReactNode {
		if (this.state.message !== null) {
			return (
				<Text wrap="truncate-end">
					{` wavekit: render error ${glyphs().sep} ${this.state.message} ${glyphs().sep} q quit`}
				</Text>
			)
		}
		return this.props.children
	}
}
