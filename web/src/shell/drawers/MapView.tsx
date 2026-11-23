// The Map view: it fills the window under the islands like the plot does. The Shell lazy-loads this module, so the
// map feature (and MapLibre) loads only when the Map view first opens. Its chrome stands where the shell layout puts it.
import MapScreen, {
	type MapPlacementProps,
} from "../../features/map/MapScreen.tsx"

export default function MapView(props: MapPlacementProps) {
	return <MapScreen {...props} />
}
