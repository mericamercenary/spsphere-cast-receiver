# SPSphere Cast receiver

Custom Web Receiver for App ID `ECDFEF92`. The TV draws each photo on the inside of a sphere and pans the yaw at the horizon at 9°/s. Two full turns take 80 seconds, then the next photo. One photo keeps turning. The screen shows no text, counters, titles, or debug readouts. A spinner with no label is the only overlay, and only while tiles are loading.

The page does not use the Default Media Receiver.

## Files

Host these next to each other:

- `index.html` — the receiver page registered in the Cast console
- `player.js` — the sphere player, loaded with a relative URL

`preview.html` and `samples/` are for a desktop check. The TV does not request them. Do not add a `<base href>` that points at another directory. The Cast SDK script is the only absolute URL, and it is `https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js`.

The folder can live at the site root or any subpath. `https://example.com/spsphere/cast-receiver/index.html` works. The console receiver URL has to be that full `index.html` address, not the parent directory.

## What the TV does

Auto-pan is two full yaw turns at the leveled horizon (9° per second), then the next photo. One photo keeps turning. The phone remote sends pan, zoom, pause, play, previous, next, and queue edits (append, remove, move, goto). Letting go of the remote resumes auto-pan after 10 seconds. Pause holds the view until play. Play eases the pan back in from the current yaw.

On start the page sends `{type:"caps"}` (device memory, `MAX_TEXTURE_SIZE`, GPU renderer, a one-time upload measurement, WebGL2) and `{type:"limits", maxTexture}`. A photo arrives as tiles of that size. The phone has already built the mip chain: level 0 is the full-resolution JPEG, and the smaller levels are a box filter sent as extra chunks on the same tile id (`level` greater than 0). The page asks for each tile with `{type:"fetch", id, token}`, assembles those chunks, and uploads each level. It does not call `generateMipmap` when the phone sent the chain, and it does not resize the photo. `preview.html` queues that have no mip levels still generate them on the GPU. A chunk for an older token is ignored. A load that stalls for 45 seconds is tried once more. Tiles stay at full resolution. If one tile is larger than `MAX_TEXTURE_SIZE`, or the GPU cannot hold every tile at once, the page says so and keeps the last frame. It does not downscale and it does not ask the phone for a smaller copy. The phone may set `preload` on a weak TV so only the view-first tiles of the next photo are fetched before the switch; the rest stream after it. The phone box-filters the whole equirect to a 64×32 overview and the TV asks for that JPEG before any level-0 tile. It stays on the GPU and is drawn under the sharp tiles, so a region that has not uploaded yet is that downscale instead of the empty clear color. The overview is sampled as a full-sphere equirect (its texture width is the shader width), and it is charged at its own size. Level-0 tiles are 512px, gutter included, and only the frustum plus the pan lookahead stay resident. Decode uses createImageBitmap so it leaves the main thread, and a frame uploads at most one tile slice inside a 4ms budget. A `{type:"debug", on:true}` message, or the TV Info key, tints overview blue and tiles amber. It is off by default and never writes text on the TV. Auto-pan requests the tiles ahead of the yaw, at least `speed × upload latency × 2` and at least three seconds at the current speed, before it requests tiles behind the camera, and it does not evict a tile that is still ahead. The crossfade waits until that lookahead band is resident; until then the current photo keeps panning. Previous and Next cancel that wait and change photos immediately. Repeated taps land on the latest photo. The new photo shows the overview first, then its sharp tiles. The canvas backing store is capped at 1920×1080. MSAA is off. Each frame draws the tiles whose patch on the sphere meets the view frustum, as a mesh for that patch, not a full sphere. The test uses the patch's 3D bounds, not its yaw span: at a pole every longitude meets, so a yaw test was hiding the far half of the sky or the ground. A tile that touches the zenith or the nadir is kept whenever pitch, plus half the vertical field of view and a small margin, reaches that pole, and a visible tile is never evicted. Pitch runs to ±89.9°. Tile edges use clamp-to-edge and a 32-pixel gutter copied from the neighbor, including the wrap at 0°/360°. The shader uses explicit gradients only near that edge. Uploads stay at one slice per frame, under about 4 ms, and the frame loop does not call `getError` or `readPixels`. Every photo change copies the current frame into a 1920×1080 snapshot, releases the old tile textures, and fades that frozen snapshot out over the new photo for 1.2 seconds (configurable from 200 ms to 5 s). The pan keeps the same yaw. A single photo keeps turning and never advances or goes idle. The phone's foreground service sends a heartbeat every 15 seconds while the app is still open, including with the screen off. Stopping the show, a Cast sender disconnect, the app being killed, or 45 seconds without a message from the phone frees every texture, standby buffer, decoded image, blob URL, pending tile queue, and the snapshot. The receiver keeps a live media session and sends a heartbeat so the TV does not fall back to the screensaver.

Each photo may include `posePitch` and `poseRoll` in degrees (GPano `PosePitchDegrees` and `PoseRollDegrees`). The player rotates the sphere by that pose before the pan and the remote, matching the phone viewer (`ProjectionMath.applyPose`). Pitch above zero points the image center up. Roll above zero tilts the right side down. Missing or zero tags leave the photo as it was.

The phone bakes cubemaps, fisheye, and cylindrical photos into full-resolution equirectangular images before the TV sees them, then splits those images into tiles. Cubemap faces are sampled in the standard orientation (PTGui / Blender / Unity). This page does not unpack a cubemap layout. Preview queues that are plain image URLs still use one texture each, so `preview.html` can run without a phone.

## How photos reach the TV

The receiver page is HTTPS. The photo bytes are not on that host. While a show is running, the phone serves the JPEGs on the LAN:

`http://<phone-lan-ip>:<port>/c/<token>/<name>.jpg`

The queue message from the phone carries those URLs, plus `ws://<phone-lan-ip>:<port>/c/<token>/aim` for live aim. The phone and the TV have to be on the same Wi-Fi. The server stops when the show stops. A random token is the only access check.

Custom messages are checked before they refresh the sender timer. A message larger than 2 MB, a binary frame larger than 64 KB, malformed JSON, or an unknown `type` is dropped. The aim socket is accepted only as `ws://` or `wss://` to an IP or localhost, on the `/c/<token>/aim` path. Photo URLs have to be `http` or `https`. Nothing on the page is written with `innerHTML`, so a title cannot become markup.

The phone answers every image response, including the CORS preflight, with:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Private-Network: true`
- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
- `Access-Control-Allow-Headers: *`
- `Cross-Origin-Resource-Policy: cross-origin`

The page loads each JPEG with `crossorigin="anonymous"` and `referrerpolicy="no-referrer"`, so WebGL can read the pixels and Chrome's private-network check can succeed. `data:` and `blob:` URLs skip CORS.

That does not turn off mixed content. An HTTPS page asking for `http://192.168.x.x` is insecure content. Chromecast can allow it per application (`ALLOW_INSECURE_CONTENT` in the device config). A Google TV Cast WebView may still block the request or refuse to upgrade an IP address to HTTPS. There is no header the phone can send that overrides that. The live show does not depend on that HTTP fetch. The queue sets `chunks: true` and `lan: false`, and the TV loads each tile over Cast custom messages. The LAN URLs stay on the queue item as a fallback address. The same rule applies to `ws://`: the page tries the LAN socket first, and if it never opens, aim, previous, and next still arrive as Cast custom messages on `urn:x-cast:com.cameron.viewer360`.

Do not add `upgrade-insecure-requests`. That would rewrite the phone URLs to HTTPS, and the phone does not serve TLS.

## Register the URL

The sender is already built with App ID `ECDFEF92`. In the Cast Developer Console, set this application's receiver URL to the HTTPS address of `index.html` (replace the placeholder). The Google TV is already a registered test device. Unpublished receivers only appear on registered devices.

`preview.html` plays the pan without a Cast device. `preview.html?selftest=1` checks that two turns advance the queue and that a single photo does not. `preview.html?aimtest=1` checks the aim spring. `preview.html?posetest=1` checks that a positive pose pitch samples below the image center, which is the GPano sign.
