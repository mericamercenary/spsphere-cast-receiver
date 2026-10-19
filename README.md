# SPSphere Cast receiver

Custom Web Receiver for App ID `ECDFEF92`. The TV draws each photo on the inside of a sphere and pans the yaw at the horizon. Two full turns, then a crossfade to the next photo. One photo keeps turning.

The page does not use the Default Media Receiver.

## Files

Host these next to each other:

- `index.html` — the receiver page registered in the Cast console
- `player.js` — the sphere player, loaded with a relative URL

`preview.html` and `samples/` are for a desktop check. The TV does not request them. Do not add a `<base href>` that points at another directory. The Cast SDK script is the only absolute URL, and it is `https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js`.

The folder can live at the site root or any subpath. `https://example.com/spsphere/cast-receiver/index.html` works. The console receiver URL has to be that full `index.html` address, not the parent directory.

## What the TV does

Auto-pan is two full yaw turns at the leveled horizon, then the next photo. One photo keeps turning. The phone remote sends pan, zoom, pause, play, previous, next, and queue edits (append, remove, move, goto). Letting go of the remote resumes auto-pan after 10 seconds. Pause holds the view until play. Play eases the pan back in from the current yaw.

Each photo may include `posePitch` and `poseRoll` in degrees (GPano `PosePitchDegrees` and `PoseRollDegrees`). The player rotates the sphere by that pose before the pan and the remote, matching the phone viewer (`ProjectionMath.applyPose`). Pitch above zero points the image center up. Roll above zero tilts the right side down. Missing or zero tags leave the photo as it was.

The phone bakes cubemaps, fisheye, and cylindrical photos into equirectangular JPEGs before the TV sees them. Cubemap faces are sampled in the standard orientation (PTGui / Blender / Unity). This page does not unpack a cubemap layout.

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

That does not turn off mixed content. An HTTPS page asking for `http://192.168.x.x` is insecure content. Chromecast can allow it per application (`ALLOW_INSECURE_CONTENT` in the device config). A Google TV Cast WebView may still block the request or refuse to upgrade an IP address to HTTPS. There is no header the phone can send that overrides that. If the TV blocks it, the sphere stays empty. The same rule applies to `ws://`: the page tries the LAN socket first, and if it never opens, aim, previous, and next still arrive as Cast custom messages on `urn:x-cast:com.cameron.viewer360`. If the LAN photo fails (error, or no answer in 10 s) and the phone's `queue` message had `chunks: true`, the TV asks for the bytes over the Cast channel instead, one photo at a time, current photo first:

- TV → phone: `{type: "fetch", id, reason}`
- phone → TV: `{type: "chunk", id, i, n, data}` where `data` is base64 of at most 32 KiB of the JPEG (keeps each Cast message under the 64 KB limit), `i` is 0-based and `n` is the chunk count. Or `{type: "fetchError", id, message}`.

After one LAN failure the TV skips the LAN for the rest of that queue. A transfer that makes no progress for 20 s fails. Without `chunks: true` (older phone apps) a LAN error is shown at once, and a photo still not delivered after 30 s shows a message but keeps waiting.

The TV reports every photo back to the phone: `{type: "photo", id, ok: true, via: "lan"|"cast", width, height}` or `{type: "error", id, message}` where `message` starts with `Couldn't load photo:`. The same text is shown in the middle of the TV while that photo is current. A later `photo` ok for the same id clears it.

## Textures

WebGL 1 samples black from a texture whose size is not a power of two unless its wrap mode is `CLAMP_TO_EDGE`. Real photos are 5376, 5760, 7680 wide, so the player clamps and wraps longitude in the shader. Photos wider than 4096 (or the GPU's `MAX_TEXTURE_SIZE`, if smaller) are shrunk on a canvas first. Only the current photo and its neighbours hold a GPU texture. The bundled samples are 1024x512, a power of two, which is why the desktop preview never showed the black sphere.

Do not add `upgrade-insecure-requests`. That would rewrite the phone URLs to HTTPS, and the phone does not serve TLS.

## Register the URL

The sender is already built with App ID `ECDFEF92`. In the Cast Developer Console, set this application's receiver URL to the HTTPS address of `index.html` (replace the placeholder). The Google TV is already a registered test device. Unpublished receivers only appear on registered devices.

`preview.html` plays the pan without a Cast device. `preview.html?selftest=1` checks that two turns advance the queue and that a single photo does not. `preview.html?aimtest=1` checks the aim spring. `preview.html?posetest=1` checks that a positive pose pitch samples below the image center, which is the GPano sign.
