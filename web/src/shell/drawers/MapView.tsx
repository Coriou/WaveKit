// The Map view: it fills the window under the islands like the plot does. The Shell lazy-loads this module, so the
// map feature (and MapLibre) loads only when the Map view first opens.
import MapScreen, { type MapInsets } from "../../features/map/MapScreen.tsx"

export default function MapView({ insets }: { insets: MapInsets }) {
	return <MapScreen insets={insets} />
}
