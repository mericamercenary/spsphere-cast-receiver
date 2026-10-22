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

On start the page sends `{type:"limits", maxTexture}` from `gl.MAX_TEXTURE_SIZE`. A photo arrives as tiles of that size. The page asks for each tile with `{type:"fetch", id, token}`, assembles the base64 `chunk` messages that echo that token, and uploads that tile before asking for the next. A chunk for an older token is ignored, so the next photo cannot get stuck on the previous transfer. The previous photo's textures, images, and blob URLs are dropped before the next photo starts. A load that stalls for 45 seconds is tried once more. Tiles stay at full resolution. If one tile is larger than `MAX_TEXTURE_SIZE`, or the GPU cannot hold every tile at once, the page uploads a 1:1 window of the tiles in the current view and loads the rest as the view moves. It does not downscale and it does not ask the phone for a smaller copy. A failed load is written with `console.warn` and the last frame that drew stays on screen. Tile edges use clamp-to-edge. A one-pixel overlap copied from the neighbor hides the seam.

Each photo may include `posePitch` and `poseRoll` in degrees (GPano `PosePitchDegrees` and `PoseRollDegrees`). The player rotates the sphere by that pose before the pan and the remote, matching the phone viewer (`ProjectionMath.applyPose`). Pitch above zero points the image center up. Roll above zero tilts the right side down. Missing or zero tags leave the photo as it was.

The phone bakes cubemaps, fisheye, and cylindrical photos into full-resolution equirectangular images before the TV sees them, then splits those images into tiles. Cubemap faces are sampled in the standard orientation (PTGui / Blender / Unity). This page does not unpack a cubemap layout. Preview queues that are plain image URLs still use one texture each, so `preview.html` can run without a phone.

## How photos reach the TV

The receiver page is HTTPS. The photo bytes are not on that host. While a show is running, the phone serves the JPEGs on the LAN:

`http://<phone-lan-ip>:<port>/c/<token>/<name>.jpg`

The queue message from the phone carries those URLs, plus `ws://<phone-lan-ip>:<port>/c/<token>/aim` for live aim. The phone and the TV have to be on the same Wi-Fi. The server stops when the show stops. A random token is the only access check.

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
