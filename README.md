# SPSphere Cast receiver

Custom Web Receiver for App ID `ECDFEF92`. The TV draws each photo on the inside of a sphere and pans the yaw at the horizon at 9°/s. Two full turns take 80 seconds, then the next photo. One photo keeps turning. The screen shows no text, counters, titles, or debug readouts. The show starts on the soft overview immediately. The spinner is not held over the picture.

The page does not use the Default Media Receiver.

## Files

Host these next to each other:

- `index.html` — the receiver page registered in the Cast console
- `player.js` — the sphere player, loaded with a relative URL
- `logo.png` — the loading mark, the same bitmap as the Android launcher icon

`preview.html` and `samples/` are for a desktop check. The TV does not request them. Do not add a `<base href>` that points at another directory. The Cast SDK script is the only absolute URL, and it is `https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js`.

The folder can live at the site root or any subpath. `https://example.com/spsphere/cast-receiver/index.html` works. The console receiver URL has to be that full `index.html` address, not the parent directory.

## What the TV does

Auto-pan is two full yaw turns at the leveled horizon (9° per second), then the next photo. One photo keeps turning. The phone remote sends pan, zoom, pause, play, previous, next, and queue edits (append, remove, move, goto). Letting go of the remote resumes auto-pan after 10 seconds. Pause holds the view until play. Play eases the pan back in from the current yaw.

On start the page sends `{type:"caps"}` (device memory, `MAX_TEXTURE_SIZE`, GPU renderer, a one-time upload measurement, WebGL2) and `{type:"limits", maxTexture}`. A photo arrives as 180° latitude strips that fit that texture edge. The front strip is centered on yaw 0°, so the seam is not down the middle of the screen. Level 0 is the full-resolution JPEG. The page asks for each tile with `{type:"fetch", id, token}`, assembles those chunks, and uploads the decoded bitmap in one `texImage2D`. Full-resolution strips stay NPOT with clamp-to-edge and linear filtering. The GPU does not pad them or build a mip chain. The page does not resize the photo. `preview.html` queues that have no mip levels still generate them on the GPU. A chunk for an older token is ignored. A load that stalls for 45 seconds is tried once more. Tiles stay at full resolution. If one tile is larger than `MAX_TEXTURE_SIZE`, or the GPU cannot hold every tile at once, the page says so and keeps the last frame. It does not downscale and it does not ask the phone for a smaller copy. The phone may set `preload` on a weak TV so only the view-first tiles of the next photo are fetched before the switch; the rest stream after it. The phone sends a softened 256×128 overview of the whole equirect. The TV asks for it first and also asks for the tiles in front immediately, so a slow overview cannot block the sharp image. The overview stays on the GPU and is drawn under the sharp tiles. Unloaded areas sample that overview with a small blur, so they look out of focus rather than gray or pixelated. Each strip fades in over about 1.4 seconds from the master strip toward the far edge of that band, with feathered seams. The next band does not start fading until the master has finished opening. Its download starts as soon as the master JPEG has arrived, so the top and bottom bands are not waiting out that fade. Auto-pan's master is the 0° horizon strip under the camera (the front 180°), then the bands above and below it, with the back hemisphere requested before the view reaches it. Steering makes the strip at the center of the screen the master and cascades outward from there. While the remote is steering, or the show is paused, every strip of the current photo stays on the GPU and the next photo is not preloaded. Auto-pan trims strips behind the camera only when the next photo needs that memory. Decode tries `createImageBitmap` and, if that errors or does not finish within 1.2s, uses an image element instead. A frame uploads at most one tile slice inside a 4ms budget. A decode or stall warning is sent to the phone as `{type:"log"}` and shown in Cast diagnostics, not on the TV. A `{type:"debug", on:true}` message, or the TV Info key, tints overview blue and tiles amber. It is off by default and never writes text on the TV. Auto-pan requests the tiles ahead of the yaw, at least `speed × upload latency × 2` and at least three seconds at the current speed, before it requests tiles behind the camera, and it does not evict a tile that is still ahead. The crossfade waits until that lookahead band is resident; until then the current photo keeps panning. Previous and Next cancel that wait and change photos immediately. Repeated taps land on the latest photo. The new photo shows the overview first, then its sharp tiles. The canvas backing store is capped at 1920×1080. MSAA is off. Each frame draws the tiles whose patch on the sphere meets the view frustum, as a mesh for that patch, not a full sphere. The test uses the patch's 3D bounds, not its yaw span: at a pole every longitude meets, so a yaw test was hiding the far half of the sky or the ground. A tile that touches the zenith or the nadir is kept whenever pitch, plus half the vertical field of view and a small margin, reaches that pole, and a visible tile is never evicted. Pitch runs to ±89.9°. Tile edges use clamp-to-edge and a 32-pixel gutter copied from the neighbor, including the wrap at 0°/360°. The shader uses explicit gradients only near that edge. Uploads stay at one slice per frame, under about 4 ms, and the frame loop does not call `getError` or `readPixels`. Every photo change copies the current frame into a 1920×1080 snapshot, releases the old tile textures, and fades that frozen snapshot out over the new photo for 1.2 seconds (configurable from 200 ms to 5 s). The pan keeps the same yaw. A single photo keeps turning and never advances or goes idle. The phone's foreground service sends a heartbeat every 15 seconds while the app is still open, including with the screen off. Stopping the show, a Cast sender disconnect, the app being killed, or 45 seconds without a message from the phone frees every texture, standby buffer, decoded image, blob URL, pending tile queue, and the snapshot. The receiver keeps a live media session and sends a heartbeat so the TV does not fall back to the screensaver.

Each photo may include `posePitch` and `poseRoll` in degrees (GPano `PosePitchDegrees` and `PoseRollDegrees`). The player rotates the sphere by that pose before the pan and the remote, matching the phone viewer (`ProjectionMath.applyPose`). Pitch above zero points the image center up. Roll above zero tilts the right side down. Missing or zero tags leave the photo as it was.

The phone bakes cubemaps, fisheye, and cylindrical photos into full-resolution equirectangular images before the TV sees them, then splits those images into tiles. Cubemap faces are sampled in the standard orientation (PTGui / Blender / Unity). This page does not unpack a cubemap layout. Preview queues that are plain image URLs still use one texture each, so `preview.html` can run without a phone.

## How photos reach the TV

The receiver page is HTTPS. The photo bytes are not on that host. While a show is running, the phone serves the JPEGs on the LAN:

`http://<phone-lan-ip>:<port>/c/<token>/<name>.jpg`

The queue message from the phone carries those URLs, plus `ws://<phone-lan-ip>:<port>/c/<token>/aim` for live aim. The phone and the TV have to be on the same Wi-Fi. The server stops when the show stops. A random token is the only access check.

Custom messages are checked before they refresh the sender timer. A message larger than 2 MB, a binary frame larger than 64 KB, malformed JSON, or an unknown `type` is dropped. The aim socket is accepted only as `ws://` or `wss://` to an IP or localhost, on the `/c/<token>/aim` path. Photo URLs have to be `http` or `https`. Nothing on the page is written with `innerHTML`, so a title cannot become markup.

The phone encodes every strip of a photo at once, on a pool of workers, and sends photo 1 as soon as it is baked. Later photos in the same cast bake in the background. Tile JPEGs are quality 90. The softened overview is quality 93. Both stay in phone RAM. The queue message is followed immediately by the overview and the front horizon strip on the Cast channel, at token 1, so the TV does not wait a round trip for that first strip. An HTTPS receiver that cannot `fetch` the phone's `http://` URL tries an image element before giving up on LAN, and one miss keeps the rest of that show on Cast chunks. While the show is running the phone holds a partial wake lock plus Wi-Fi locks `WIFI_MODE_FULL_HIGH_PERF` and, on Android 10 and later, `WIFI_MODE_FULL_LOW_LATENCY`, so the radio does not power-save between requests. Image responses send `Connection: keep-alive`.

The phone answers every image response, including the CORS preflight, with:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Private-Network: true`
- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
- `Access-Control-Allow-Headers: *`
- `Cross-Origin-Resource-Policy: cross-origin`

The page loads each JPEG with `crossorigin="anonymous"` and `referrerpolicy="no-referrer"`, so WebGL can read the pixels and Chrome's private-network check can succeed. `data:` and `blob:` URLs skip CORS.

That does not turn off mixed content. An HTTPS page asking for `http://192.168.x.x` is insecure content. Chromecast can allow it per application (`ALLOW_INSECURE_CONTENT` in the device config). A Google TV Cast WebView may still block the request or refuse to upgrade an IP address to HTTPS. There is no header the phone can send that overrides that. The queue sets `chunks: true` and `lan: true`. The TV tries each private `http://` JPEG first, with a 2.2 second timeout. The first miss turns that path off and the same tile is requested as `{type:"fetch", id, token, reason:"lan"}`. Later tiles then use Cast messages immediately, so a blocked LAN does not add a timeout to every tile. `lan: false`, an `https` URL, or a public host never tries the phone. The same rule applies to `ws://`: the page tries the LAN socket first, and if it never opens, aim, previous, and next still arrive as Cast custom messages on `urn:x-cast:com.cameron.viewer360`.

The first frame is the app icon, `logo.png` (the launcher bitmap), on the dark background. There is no title and no spinner text. It crossfades once the overview and the master strip are up. That strip fades from soft to sharp over about 1.4 seconds. The bands beyond it stay on the overview until the strip in front of them has finished fading, and those bands start downloading as soon as the strip in front of them has arrived.

Do not add `upgrade-insecure-requests`. That would rewrite the phone URLs to HTTPS, and the phone does not serve TLS.

## Register the URL

The sender is already built with App ID `ECDFEF92`. In the Cast Developer Console, set this application's receiver URL to the HTTPS address of `index.html` (replace the placeholder). The Google TV is already a registered test device. Unpublished receivers only appear on registered devices.

`preview.html` plays the pan without a Cast device. `preview.html?selftest=1` checks that two turns advance the queue and that a single photo does not. `preview.html?aimtest=1` checks the aim spring. `preview.html?posetest=1` checks that a positive pose pitch samples below the image center, which is the GPano sign.
