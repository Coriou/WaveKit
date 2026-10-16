# Meshtastic test fixtures

Hand-written proto3 encoder for Position (port 3) and User (port 4) payloads.
Nothing here is downloaded.

The vendored `docker/scripts/meshtastic_proto/mesh_pb2.py` contains only
`Data` and `MeshPacket`. Position and User field numbers are the lane N brief's
(Meshtastic `mesh.proto`):

- Position: 1 `latitude_i` sfixed32, 2 `longitude_i` sfixed32, 3 `altitude` int32, 4 `time` fixed32
- User: 1 `id`, 2 `long_name`, 3 `short_name`, 5 `hw_model`, 6 `is_licensed`, 7 `role`

`encodePosition` and `encodeUser` omit a field that is left undefined, and write
a provided `0`, `false` or `""`. `meshPacket` builds an adapter-shaped
`MeshtasticPacket` whose `payloadB64` is the base64 of `payload`.
