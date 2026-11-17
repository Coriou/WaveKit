// Thin typed components over the ui.css recipes (packages/brand/docs/ui-kit.md). They map props to recipe classes
// and state attributes only; visual styles stay in ui.css.
export {
	Button,
	type ButtonProps,
	type ButtonSize,
	type ButtonVariant,
} from "./Button.tsx"
export { Chip, type ChipProps } from "./Chip.tsx"
export { cx, flag } from "./cx.ts"
export { Drawer, type DrawerProps } from "./Drawer.tsx"
export { Field, Input, type FieldProps, type InputProps } from "./Field.tsx"
export {
	HINT_HOST,
	HintMark,
	hintRow,
	useHint,
	type HintContent,
	type HintMarkProps,
} from "./Hint.tsx"
export {
	HintController,
	hintMarkEvents,
	hints,
	type HintMarkEvents,
	type HintState,
} from "./hint-controller.ts"
export {
	hintRectsMeet,
	hintRoom,
	placeHint,
	type HintPlacement,
	type HintRect,
} from "./hint-place.ts"
export { Icon, Mark, type IconName, type IconProps } from "./Icon.tsx"
export {
	IconButton,
	type IconButtonProps,
	type IconButtonSize,
} from "./IconButton.tsx"
export { Island, IslandHead, type IslandProps } from "./Island.tsx"
export { Kbd } from "./Kbd.tsx"
export { Label, type LabelProps } from "./Label.tsx"
export { Seg, type SegOption, type SegProps } from "./Seg.tsx"
export { Switch, type SwitchProps } from "./Switch.tsx"
export {
	Skeleton,
	type SkeletonProps,
	type SkeletonShape,
} from "./Skeleton.tsx"
export {
	PanelFailed,
	PanelLoading,
	PanelNotice,
	PanelProgress,
	useRetryText,
} from "./Panel.tsx"
export {
	panelView,
	retryText,
	type PanelBody,
	type PanelInput,
	type PanelNoticeKind,
	type PanelView,
} from "./panel-state.ts"
export {
	useVirtualRows,
	type VirtualRows,
	type VirtualRowsOptions,
} from "./virtual-rows.ts"
export {
	indexAt,
	prefixOffsets,
	virtualWindow,
	type VirtualWindow,
} from "./virtual.ts"
