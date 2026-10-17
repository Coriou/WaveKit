import "../styles/ui.css"

import type { HTMLAttributes, ReactNode, Ref } from "react"

import { cx } from "./cx.ts"
import { Icon } from "./Icon.tsx"
import { IconButton } from "./IconButton.tsx"

export interface DrawerProps extends Omit<
	HTMLAttributes<HTMLElement>,
	"title"
> {
	/** Heading text, also the region's accessible name. */
	title: string
	/** Header content after the title (counts, actions). */
	actions?: ReactNode
	/** Header content at the far end, just before the close button. */
	end?: ReactNode
	onClose?: () => void
	/** Accessible name of the close button; default "Close <title>". */
	closeLabel?: string
	ref?: Ref<HTMLElement>
}

/** `.wk-drawer`: the solid (never blurred) right drawer with its header and a scrolling body. */
export function Drawer({
	title,
	actions,
	end,
	onClose,
	closeLabel,
	className,
	children,
	...rest
}: DrawerProps) {
	return (
		<section
			{...rest}
			aria-label={title}
			className={cx("wk-drawer", className)}
		>
			<header className="wk-drawer-head">
				<h2 className="wk-h2">{title}</h2>
				{actions}
				<span className="wk-drawer-gap" />
				{end}
				{onClose && (
					<IconButton
						close
						label={closeLabel ?? `Close ${title.toLowerCase()}`}
						onClick={onClose}
						className="wk-drawer-close"
					>
						<Icon name="close" />
					</IconButton>
				)}
			</header>
			<div className="wk-drawer-body wk-scroll">{children}</div>
		</section>
	)
}
