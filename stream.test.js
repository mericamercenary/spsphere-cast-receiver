const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "player.js"), "utf8");
const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const sandbox = { console, Date };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const Cast = sandbox.SpsphereCast;

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

assert(Cast.RECEIVER_BUILD === "20261111.1", "receiver build is 20261111.1, got " + Cast.RECEIVER_BUILD);
assert(Cast.TILE_FADE_MS === 2400, "photo fade stays 2400ms");
assert(Cast.FOCUS_HANDOFF === 0.35, "focus handoff stays 0.35");
assert(page.indexOf("player.js?v=20261111.1") >= 0, "index.html cache-busts 20261111.1");
assert(page.indexOf("function _drawGl") < 0, "the page does not rewrite the WebGL draw");
assert(code.indexOf("TILE_FADE_MS = 2400") >= 0, "player keeps the 2400ms fade");
assert(code.indexOf("FOCUS_HANDOFF = 0.35") >= 0, "player keeps the 0.35 handoff");
assert(code.indexOf("function paintStripView") >= 0, "Canvas2D remains when no stream connects");
assert(code.indexOf("this._cpuTiles && this._streamActive") >= 0, "an active stream skips the Canvas2D paint");

const aim = "ws://192.168.1.32:5000/c/0123456789abcdef0123456789abcdef/aim";
const stream = "ws://192.168.1.32:5000/c/0123456789abcdef0123456789abcdef/stream";
assert(Cast.streamUrlFromAim(aim) === stream, "the stream socket is the aim url with /stream");
assert(Cast.acceptStreamSocket(stream) === stream, "a LAN /stream socket is accepted");
assert(Cast.acceptStreamSocket(aim) === "", "the aim socket is not a stream socket");
assert(Cast.acceptStreamSocket("ws://evil.example/c/0123456789abcdef0123456789abcdef/stream") === "", "a public host is not a stream socket");
assert(Cast.acceptAimSocket(aim) === aim, "the aim socket check is unchanged");

assert(Cast.streamProbe(true, true) === null, "a WebGL TV does not probe for a phone stream");
const probe = Cast.streamProbe(false, true);
assert(probe && probe.type === "stream-probe" && probe.webgl === false && probe.mse === true, "no-WebGL probe offers a stream");
assert(probe.modes[0] === "h264-mse" && probe.modes[1] === "jpeg-ws", "probe order is h264-mse then jpeg-ws");
assert(probe.log === "stream probe webgl=0 mse=1 modes=h264-mse,jpeg-ws", "probe log got " + (probe && probe.log));
assert(probe.build === "20261111.1", "probe names the build");
const jpegOnly = Cast.streamProbe(false, false);
assert(jpegOnly.modes.length === 1 && jpegOnly.modes[0] === "jpeg-ws", "without MSE the probe is jpeg-ws only");
assert(jpegOnly.log.indexOf("mse=0") >= 0, "the probe log records mse=0");

const chosen = Cast.streamChoose(true, { mode: "h264-mse", codec: "avc1.64001F", ws: stream });
assert(chosen.mode === "h264-mse" && chosen.codec === "avc1.64001F", "h264-mse keeps the phone codec");
assert(chosen.ws === stream, "choice keeps a valid stream url");
assert(chosen.choiceLog === "stream choice h264-mse", "choice log");
assert(chosen.announceLog === "stream announce h264-mse", "announce log");
assert(chosen.announce.type === "stream-announce" && chosen.announce.mode === "h264-mse", "announce message");
assert(chosen.announce.build === "20261111.1", "announce names the build");
const downgraded = Cast.streamChoose(false, { mode: "h264-mse" });
assert(downgraded.mode === "jpeg-ws", "h264 is jpeg-ws when the TV has no MediaSource");
const fromAim = Cast.streamChoose(true, { mode: "jpeg-ws", ws: aim });
assert(fromAim.ws === stream, "an aim url in the choice becomes the stream socket");
assert(Cast.streamChoose(true, { mode: "nope" }) === null, "an unknown mode is rejected");
const accepted = Cast.acceptCastMessage({ type: "stream", mode: "h264-mse", ws: stream });
assert(accepted && accepted.ws === stream, "a stream cast message is accepted");
assert(Cast.acceptCastMessage({ type: "stream", mode: "h264-mse", ws: "javascript:alert(1)" }) === null, "a bad stream url drops the message");
assert(Cast.acceptCastMessage({ type: "queue", ws: aim, items: [] }).ws === aim, "queue still requires an aim socket");

const init = new Uint8Array([0, 0, 0, 8, 97, 118, 99, 67, 1, 0x64, 0x00, 0x1f]);
assert(Cast.codecFromAvcC(init) === "avc1.64001F", "avcC becomes the MSE codec, got " + Cast.codecFromAvcC(init));
assert(Cast.jpegFrame(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) === true, "a JPEG starts with FFD8FF");
assert(Cast.jpegFrame(new Uint8Array([0, 0, 0, 1])) === false, "an fMP4 chunk is not a JPEG");
assert(
  Cast.socketDisconnectLog("aim", aim, 1006, "going away") === "aim disconnect remote=" + aim + " code=1006 reason=going away",
  "aim disconnect names remote, code, and reason"
);
assert(
  Cast.socketDisconnectLog("stream", stream, 1005, "") === "stream disconnect remote=" + stream + " code=1005 reason=",
  "stream disconnect uses the same fields"
);

const host = {
  width: 320, height: 180, style: {},
  addEventListener: function () {},
  getContext: function () { return null; },
};
const tv = Cast.create(host);
assert(tv.wantsPhoneStream() === true, "no WebGL context asks the phone to stream");
tv._gl = {};
assert(tv.wantsPhoneStream() === false, "a live WebGL context does not ask for a stream");

assert(page.indexOf('sendLog(SpsphereCast.socketDisconnectLog("aim"') >= 0, "the page logs aim disconnect remote/code/reason");
assert(page.indexOf("h264-mse") >= 0 && page.indexOf("jpeg-ws") >= 0, "the page implements both stream modes");
assert(page.indexOf("MediaSource") >= 0 && page.indexOf("addSourceBuffer") >= 0, "h264-mse uses MediaSource");
assert(page.indexOf("stream fallback canvas2d") >= 0, "a missed stream falls back to Canvas2D");
assert(page.indexOf("stream socket open ") >= 0, "the page logs the stream socket opening");
assert(page.indexOf("stream frame ") >= 0, "the page logs stream frames");
assert(page.indexOf('msg.type === "stream"') >= 0, "the page accepts the stream choice");
assert(page.indexOf("maybeProbeStream()") >= 0, "the page sends the stream probe");
assert(page.indexOf('id="streamVideo"') >= 0 && page.indexOf('id="streamFrame"') >= 0, "stream picture elements are on the page");
const script = page.split("<script>").pop().split("</script>")[0];
new Function(script);

console.log("stream ok");
