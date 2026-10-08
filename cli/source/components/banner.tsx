import type { ReactElement } from "react"
import type { Line } from "../ui/line.js"
import { LineView } from "./lines.js"

export function Banner({ line }: { line: Line }): ReactElement {
	return <LineView line={line} />
}
