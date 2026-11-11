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

assert(Cast.RECEIVER_BUILD === "20261111.11", "receiver build is 20261111.11, got " + Cast.RECEIVER_BUILD);
assert(Cast.TILE_FADE_MS === 2400, "photo fade stays 2400ms");
assert(Cast.FOCUS_HANDOFF === 0.35, "focus handoff stays 0.35");
assert(page.indexOf("player.js?v=20261111.11") >= 0, "index.html cache-busts 20261111.11");
assert(page.indexOf("function _drawGl") < 0, "the page does not rewrite the WebGL draw");
assert(code.indexOf("TILE_FADE_MS = 2400") >= 0, "player keeps the 2400ms fade");
assert(code.indexOf("FOCUS_HANDOFF = 0.35") >= 0, "player keeps the 0.35 handoff");
assert(code.indexOf("function paintStripView") >= 0, "Canvas2D remains when no stream connects");
assert(code.indexOf("this._cpuTiles && (this._streamActive || this._streamHold)") >= 0, "a chosen stream skips the Canvas2D mesh");

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
assert(probe.modes.length === 1 && probe.modes[0] === "jpeg-ws" && probe.h264 === false, "a no-WebGL TV is offered jpeg-ws only");
assert(probe.log === "stream probe webgl=0 mse=1 modes=jpeg-ws max=1280x720 h264=0", "probe log got " + (probe && probe.log));
const opted = Cast.streamProbe(false, true, true);
assert(opted.modes[0] === "h264-mse" && opted.h264 === true, "spsdebug=h264 is the only H.264 probe");
assert(probe.maxW === 1280 && probe.maxH === 720, "the probe asks for 720p");
const firstBreak = Cast.mseFailureAction(0);
assert(firstBreak.action === "reset" && firstBreak.message.type === "stream-reset" && firstBreak.message.maxW === 1280, "the first decode failure asks for a new init segment");
const secondBreak = Cast.mseFailureAction(1);
assert(secondBreak.action === "fallback" && secondBreak.message.reason === "mse-decode", "the second decode failure leaves H.264");
assert(Cast.isVideoRenderFailure(4, "") === true, "MediaError code 4 is a render failure");
assert(Cast.isVideoRenderFailure(3, "PIPELINE_ERROR_COULD_NOT_RENDER") === true, "the onn pipeline error is a render failure");
assert(Cast.isVideoRenderFailure(2, "append failed") === false, "a mux append error is not a render failure");
const renderBreak = Cast.streamFailureAction("video-error", 0);
assert(renderBreak.action === "fallback" && renderBreak.message.type === "stream-fallback" && renderBreak.message.reason === "video-render", "a video error does not send stream-reset");
assert(!renderBreak.message.maxW, "video-render fallback does not ask for another H.264 init");
const remembered = Cast.streamProbe(false, true, false);
assert(remembered.modes.length === 1 && remembered.modes[0] === "jpeg-ws" && remembered.h264 === false, "a TV that already failed H.264 probes jpeg only");
assert(remembered.log.indexOf("h264=0") >= 0, "the probe log says h264=0");
const blockKey = Cast.h264BlockKey("onn 1280x720");
assert(blockKey.indexOf("spsphere.h264.block.") === 0, "the block is keyed for this device");
const blockRecord = Cast.h264BlockRecord("video-render");
assert(Cast.h264Blocked(JSON.stringify(blockRecord)) === true, "a stored video-render record blocks H.264");
assert(Cast.h264Blocked("") === false && Cast.h264Blocked(null) === false, "an empty store still allows H.264");
assert(Cast.fmp4Init(new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112])) === true, "an ftyp box is an init segment");
assert(Cast.fmp4Init(new Uint8Array([0, 0, 0, 1, 65, 0, 0])) === false, "a media sample is not an init segment");
function bmff(type, payloadLen) {
  const size = 8 + payloadLen;
  const bytes = new Uint8Array(size);
  bytes[0] = (size >>> 24) & 255;
  bytes[1] = (size >>> 16) & 255;
  bytes[2] = (size >>> 8) & 255;
  bytes[3] = size & 255;
  bytes[4] = type.charCodeAt(0);
  bytes[5] = type.charCodeAt(1);
  bytes[6] = type.charCodeAt(2);
  bytes[7] = type.charCodeAt(3);
  return bytes;
}
function catBytes(parts) {
  let n = 0;
  parts.forEach(function (part) { n += part.length; });
  const out = new Uint8Array(n);
  let offset = 0;
  parts.forEach(function (part) { out.set(part, offset); offset += part.length; });
  return out;
}
const ftyp = bmff("ftyp", 8);
const moov = bmff("moov", 16);
const moof = bmff("moof", 8);
const mdat = bmff("mdat", 32);
const combined = catBytes([ftyp, moov, moof, mdat]);
const plan = Cast.mp4AppendUnits(combined);
assert(plan.units.length === 2 && plan.units[0].kind === "init" && plan.units[1].kind === "media", "init and media in one message are separate appends");
assert(plan.units[0].end === ftyp.length + moov.length && plan.units[1].end === combined.length, "the media append starts at moof");
assert(plan.rest === combined.length, "a complete message has no leftover");
assert(Cast.mp4BoxList(combined) === "ftyp:" + ftyp.length + ",moov:" + moov.length + ",moof:" + moof.length + ",mdat:" + mdat.length, "box list names type and size, got " + Cast.mp4BoxList(combined));
const partial = Cast.mp4AppendUnits(ftyp.subarray(0, 10));
assert(partial.units.length === 0 && partial.rest === 0, "a split init is not appended yet");
assert(Cast.mp4BoxList(ftyp.subarray(0, 10)).indexOf("partial:10") >= 0, "a short read is marked partial");
const joined = catBytes([ftyp.subarray(0, 10), ftyp.subarray(10), moov]);
const rejoined = Cast.mp4AppendUnits(joined);
assert(rejoined.units.length === 1 && rejoined.units[0].kind === "init", "a split init becomes one append once moov arrives");
assert(Cast.mp4Hex(new Uint8Array([0x0a, 0xff]), 2) === "0aff", "sample hex is the first bytes");
assert(page.indexOf("isTypeSupported") >= 0, "the page logs isTypeSupported for the mime");
assert(page.indexOf("createImageBitmap") >= 0 && page.indexOf("requestAnimationFrame") >= 0, "JPEG decode is off the onload path");
assert(page.indexOf("frame.onload") < 0, "JPEG frames are not waited on via img.onload");
assert(page.indexOf("stream present fps=") >= 0 && page.indexOf("jitter p95=") >= 0 && page.indexOf("reproject px p95=") >= 0, "presentation stats log fps, jitter, and reprojection");
assert(page.indexOf("OffscreenCanvas") >= 0 && page.indexOf("new Worker") >= 0, "JPEG decode can leave the main thread");
function spf1Frame(yaw, pitch, fov, overscan, id, timeMs) {
  const buf = new ArrayBuffer(38);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes[0] = 83; bytes[1] = 80; bytes[2] = 70; bytes[3] = 49;
  view.setUint16(4, 34, true);
  view.setFloat32(6, yaw, true);
  view.setFloat32(10, pitch, true);
  view.setFloat32(14, fov, true);
  view.setFloat32(18, overscan, true);
  view.setUint32(22, id, true);
  view.setFloat64(26, timeMs, true);
  bytes[34] = 0xff; bytes[35] = 0xd8; bytes[36] = 0xff; bytes[37] = 0xd9;
  return bytes;
}
const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const bareFrame = Cast.parseStreamFrame(bare);
assert(bareFrame && bareFrame.pose === null && bareFrame.jpeg.length === 4, "a bare JPEG has no pose header");
const wrapped = Cast.parseStreamFrame(spf1Frame(12.5, -3.25, 80, 0.12, 7, 1234.5));
assert(wrapped && wrapped.pose && Math.abs(wrapped.pose.yaw - 12.5) < 0.001, "SPF1 yaw is a little-endian float");
assert(Math.abs(wrapped.pose.pitch - -3.25) < 0.001 && Math.abs(wrapped.pose.fov - 80) < 0.001, "SPF1 pitch and fov survive");
assert(Math.abs(wrapped.pose.overscan - 0.12) < 0.001 && wrapped.pose.frameId === 7, "SPF1 overscan and frame id survive");
assert(wrapped.pose.timeMs === 1234.5 && wrapped.jpeg[0] === 0xff && wrapped.jpeg[1] === 0xd8, "SPF1 timestamp and JPEG follow the header");
const plainShift = Cast.streamReproject(null, { yaw: 20, pitch: 5, fov: 70 }, 1280, 720);
assert(plainShift.scale === 1 && plainShift.dx === 0 && plainShift.dy === 0, "a frame without a header is not moved");
const smallShift = Cast.streamReproject(
  { yaw: 0, pitch: 0, fov: 80, overscan: 0.15 },
  { yaw: 2, pitch: 0, fov: 80 },
  1000, 500
);
assert(smallShift.dx > 0 && smallShift.dx < 0.15 * 1000, "a small yaw change shifts inside the overscan, dx " + smallShift.dx);
const clamped = Cast.streamReproject(
  { yaw: 0, pitch: 0, fov: 80, overscan: 0.12 },
  { yaw: 90, pitch: 40, fov: 80 },
  1000, 500
);
assert(Math.abs(clamped.dx) <= 0.12 * 1000 + 0.01 && Math.abs(clamped.dy) <= 0.12 * 500 + 0.01, "a large aim change stays inside the overscan margin");
const matchedPose = Cast.streamReproject(
  { yaw: 15, pitch: -8, fov: 58.72, overscan: 0.15 },
  { yaw: 15, pitch: -8, fov: 58.72 },
  1280, 720
);
assert(matchedPose.px === 0, "aim equal to the frame pose is 0 px, got " + matchedPose.px);
const oneDegree = Cast.streamReproject(
  { yaw: 0, pitch: 0, fov: 58.72, overscan: 0.2 },
  { yaw: 1, pitch: 0, fov: 58.72 },
  1280, 720
);
assert(Math.abs(oneDegree.dx - 14.2) < 0.5, "1 degree at about 90 hfov on a 1280px canvas is about 14 px, got " + oneDegree.dx);
const still = Cast.streamStillDraw({ yaw: 40, pitch: 10, fov: 90, overscan: 0.12 });
assert(still.dx === 0 && still.dy === 0 && still.px === 0, "the default present does not follow aim");
assert(Math.abs(still.crop - (0.12 / 1.24)) < 1e-9, "overscan crops overscan/(1+2*overscan) per side, got " + still.crop);
assert(Cast.streamStillDraw(null).crop === 0, "a bare JPEG is not cropped");
assert(page.indexOf("spsReprojectDebug") >= 0 && page.indexOf("streamStillDraw") >= 0, "aim reprojection stays behind spsdebug=reproject");
const panel = Cast.jpegCanvasSize(3840, 2160);
assert(panel.w === 1280 && panel.h === 720, "a 4K backing store caps at 1280x720, got " + panel.w + "x" + panel.h);
const frameSize = Cast.jpegCanvasSize(960, 540);
assert(frameSize.w === 960 && frameSize.h === 540, "a smaller frame keeps its own size, got " + frameSize.w + "x" + frameSize.h);
const wide = Cast.jpegCanvasSize(1280, 960);
assert(wide.w === 960 && wide.h === 720, "a tall frame scales inside 1280x720, got " + wide.w + "x" + wide.h);
assert(page.indexOf("jpegCanvasSize") >= 0 && page.indexOf("devicePixelRatio") < 0, "the JPEG canvas is not sized from the panel pixel ratio");
assert(page.indexOf("width: 100%") >= 0 && page.indexOf("height: 100%") >= 0, "CSS scales the JPEG canvas to the screen");
function bitmap(name) {
  return { name: name, width: 1280, height: 720, closed: false, close: function () { this.closed = true; } };
}
const one = Cast.createJpegPipe();
const firstJob = Cast.jpegPipePush(one, { bytes: new Uint8Array([1]), pose: null });
const secondJob = Cast.jpegPipePush(one, { bytes: new Uint8Array([2]), pose: null });
assert(one.limit === 1 && firstJob.start.length === 1 && secondJob.start.length === 0, "the default pipe decodes one frame at a time");
assert(one.inFlight === 1, "a second frame waits, got " + one.inFlight);
const thirdJob = Cast.jpegPipePush(one, { bytes: new Uint8Array([3]), pose: null });
assert(thirdJob.dropped === 1, "the waiting frame is replaced by the latest");
const staleBitmap = bitmap("stale");
const staleDone = Cast.jpegPipeFinish(one, firstJob.start[0].id, staleBitmap);
assert(staleDone.show === null && staleDone.close[0] === staleBitmap && staleDone.next, "a finished frame loses to the one waiting");
staleDone.close[0].close();
assert(staleBitmap.closed === true, "the stale bitmap is closed");
const pipe = Cast.createJpegPipe(2);
const started = [];
for (let n = 0; n < 4; n++) {
  const step = Cast.jpegPipePush(pipe, { bytes: new Uint8Array([n]), pose: null });
  step.start.forEach(function (job) { started.push(job); });
  if (n < 2) assert(step.start.length === 1 && step.dropped === 0, "frame " + n + " starts immediately");
}
assert(pipe.inFlight === 2, "spsdebug=flight2 keeps two decodes in flight, got " + pipe.inFlight);
assert(started.length === 2, "the third and fourth wait, got " + started.length);
const fifth = Cast.jpegPipePush(pipe, { bytes: new Uint8Array([5]), pose: null });
assert(fifth.dropped === 1 && fifth.start.length === 0, "a newer waiting frame replaces the older one");
const newer = bitmap("newer");
const older = bitmap("older");
const won = Cast.jpegPipeFinish(pipe, started[1].id, newer);
assert(won.show === newer && won.close.length === 0, "the newer in-flight frame is shown when it finishes first");
assert(won.next && won.next.id > started[1].id, "the waiting newest frame starts when a slot frees");
const late = Cast.jpegPipeFinish(pipe, started[0].id, older);
assert(late.show === null && late.close.length === 1 && late.close[0] === older, "an older decode does not replace the newer frame");
late.close[0].close();
assert(older.closed === true, "the older bitmap is closed immediately");
const latest = bitmap("latest");
const replaced = Cast.jpegPipeFinish(pipe, won.next.id, latest);
assert(replaced.show === latest && replaced.close.indexOf(newer) >= 0, "the previous bitmap is closed when a newer one wins");
replaced.close.forEach(function (item) { item.close(); });
assert(newer.closed === true, "the replaced bitmap is closed");
assert(pipe.inFlight === 0 && pipe.current === latest, "the pipe keeps only the newest bitmap");
assert(page.indexOf("jpegPipePush") >= 0 && page.indexOf("jpegPipeFinish") >= 0, "the page uses the decode pipe");
assert(page.indexOf("var jpegFlight = 1") >= 0 && page.indexOf("spsJpegFlightDebug") >= 0, "two decodes in flight stay behind spsdebug=flight2");
assert(page.indexOf("closeJpegBitmap(closed[i])") >= 0, "the page closes bitmaps the pipe retires");
const mainWins = Cast.jpegPathChoice([40, 48, 55], [12, 18, 22]);
assert(mainWins.path === "main" && mainWins.p50 === 18, "a slower worker loses to main-thread decode, got " + mainWins.log);
assert(mainWins.log.indexOf("stream jpeg path=main decode p50=18") === 0, "the path log names main, got " + mainWins.log);
const workerWins = Cast.jpegPathChoice([8, 11, 14], [30, 36, 40]);
assert(workerWins.path === "worker" && workerWins.log.indexOf("stream jpeg path=worker decode p50=11") === 0, "a faster worker wins, got " + workerWins.log);
assert(page.indexOf("jpegPathChoice") >= 0 && page.indexOf("spsJpegBenchDebug") >= 0, "the decode benchmark stays behind spsdebug=bench");
assert(page.indexOf("ensureJpegWorker() ? \"worker\" : \"main\"") >= 0, "the default decode path is the worker");
const slowCap = Cast.streamCapDecision(60, 1280, 720, 18, null);
assert(slowCap.send === true, "a 60ms 720p decode asks the phone to shrink");
assert(JSON.stringify(slowCap.message) === '{"type":"stream-cap","maxW":854,"maxH":480,"decodeP50":60,"presentFps":18}', "cap message got " + JSON.stringify(slowCap.message));
assert(slowCap.log === "stream cap sent 854x480 decode p50=60", "cap log got " + slowCap.log);
const again = Cast.streamCapDecision(60, 1280, 720, 18, { maxW: 854, maxH: 480 });
assert(again.send === false, "the same cap is not sent again");
const fit = Cast.streamCapDecision(45, 1280, 720, 22, null);
assert(fit.message.maxW === 960 && fit.message.maxH === 540, "45ms at 720p steps to 960x540, got " + fit.message.maxW + "x" + fit.message.maxH);
const fine = Cast.streamCapDecision(25, 1280, 720, 30, null);
assert(fine.send === false && fine.message.maxW === 1280, "a decode under 30ms does not send a cap");
const raised = Cast.streamCapDecision(20, 854, 480, 28, { maxW: 854, maxH: 480 });
assert(raised.send === true && raised.message.maxW === 960 && raised.message.maxH === 540, "a faster decode raises the cap");
assert(page.indexOf('type: "stream-cap"') < 0 || page.indexOf("streamCapDecision") >= 0, "the page builds the cap with streamCapDecision");
assert(page.indexOf("streamSocket.send(text)") >= 0 && page.indexOf("aimSocket.send(text)") >= 0, "the cap goes out on the stream socket, then the aim socket");
assert(page.indexOf("jpegDecodeSamples.length < 15") >= 0 && page.indexOf("jpegCapCheckedAt < 5000") >= 0, "the cap waits for 15 frames and then 5s");
sandbox.location = { search: "?spsdebug=flight2", hash: "" };
assert(Cast.spsJpegFlightDebug() === true, "spsdebug=flight2 opts into two decodes");
sandbox.location = { search: "?spsdebug=bench", hash: "" };
assert(Cast.spsJpegBenchDebug() === true && Cast.spsJpegFlightDebug() === false, "spsdebug=bench does not enable two decodes");
sandbox.location = { search: "", hash: "" };
assert(Cast.spsJpegFlightDebug() === false && Cast.spsJpegBenchDebug() === false, "flight2 and the benchmark are off by default");
sandbox.location = { search: "?spsdebug=reproject", hash: "" };
assert(Cast.spsReprojectDebug() === true, "spsdebug=reproject opts into aim shift");
sandbox.location = { search: "", hash: "" };
assert(Cast.spsReprojectDebug() === false, "aim shift is off by default");
assert(probe.build === "20261111.11", "probe names the build");
const jpegOnly = Cast.streamProbe(false, false);
assert(jpegOnly.modes.length === 1 && jpegOnly.modes[0] === "jpeg-ws", "without MSE the probe is jpeg-ws only");
assert(jpegOnly.log.indexOf("mse=0") >= 0, "the probe log records mse=0");

const chosen = Cast.streamChoose(true, { mode: "h264-mse", codec: "avc1.64001F", ws: stream });
assert(chosen.mode === "h264-mse" && chosen.codec === "avc1.64001F", "h264-mse keeps the phone codec");
assert(chosen.ws === stream, "choice keeps a valid stream url");
assert(chosen.choiceLog === "stream choice h264-mse", "choice log");
assert(chosen.announceLog === "stream announce h264-mse", "announce log");
assert(chosen.announce.type === "stream-announce" && chosen.announce.mode === "h264-mse", "announce message");
assert(chosen.announce.build === "20261111.11", "announce names the build");
assert(Cast.usableAvcCodec("avc1.42E01E") === "avc1.42E01E", "a baseline codec is usable");
assert(Cast.usableAvcCodec("avc1.64001F") === "avc1.64001F", "a high-profile codec is usable");
assert(Cast.usableAvcCodec("avc1.000001") === "", "an Annex-B start code is not a codec");
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
const told = [];
sandbox.__castSend = function (msg) { told.push(msg); };
tv._buildAnnounced = false;
tv._announcedAt = 0;
tv.announceBuild(true);
assert(told.filter(function (msg) { return msg && msg.message === "receiver build " + Cast.RECEIVER_BUILD; }).length === 1, "the build is announced to a live sender");
told.length = 0;
tv._reportTv("canvas2d cadence");
assert(!told.some(function (msg) { return msg && String(msg.message || "").indexOf("receiver build") === 0; }), "a later canvas log does not repeat the build");
assert(told.some(function (msg) { return msg && msg.message === "canvas2d cadence"; }), "the canvas log itself is still sent");
const holdDraws = [];
const holdCtx = { fillRect: function () {}, drawImage: function () { holdDraws.push("image"); }, canvas: { width: 320, height: 180 } };
tv._cpuUnderlayPiece = function () { return { tex: { _cpuImage: { width: 64, height: 32 } } }; };
assert(tv._paintStreamHold(holdCtx, 320, 180) === 1, "the wait paints the overview, not the mesh");
assert(holdDraws.length === 1, "the overview is one stretch, got " + holdDraws.length);

assert(page.indexOf('sendLog(SpsphereCast.socketDisconnectLog("aim"') >= 0, "the page logs aim disconnect remote/code/reason");
assert(page.indexOf("h264-mse") >= 0 && page.indexOf("jpeg-ws") >= 0, "the page implements both stream modes");
assert(page.indexOf("MediaSource") >= 0 && page.indexOf("addSourceBuffer") >= 0, "h264-mse uses MediaSource");
assert(page.indexOf("STREAM_WAIT_MS = 5000") >= 0 && page.indexOf('fallbackCanvas("timeout")') >= 0, "no frame for 5s logs stream fallback canvas2d timeout");
assert(page.indexOf('type: "stream-fallback"') >= 0, "an MSE failure tells the phone with stream-fallback");
assert(page.indexOf("mse-decode") >= 0 && page.indexOf("mseFailureAction") >= 0, "a detached buffer rebuilds once, then falls back");
assert(page.indexOf('reason: "video-render"') >= 0 && page.indexOf("fallbackVideoRender") >= 0, "a video element error falls back without stream-reset");
assert(page.indexOf('onMseBroken("video-error")') < 0, "the video error path does not rebuild MSE");
assert(page.indexOf("localStorage") >= 0 && page.indexOf("h264BlockKey") >= 0, "the H.264 failure is remembered on this TV");
assert(page.indexOf("removeChild") >= 0 && page.indexOf("revokeObjectURL") >= 0, "the video element is removed and its object URL is revoked");
assert(page.indexOf("avc1.42E01E") >= 0 && page.indexOf("avc1.42001F") >= 0, "the error path logs constrained-baseline support");
assert(page.indexOf("requestVideoFrameCallback") >= 0 && page.indexOf("timeupdate") >= 0, "the video stays hidden until a frame is presented");
assert(page.indexOf("function logStreamOnce") >= 0, "decoder errors are logged once");
assert(page.indexOf("video.currentTime") >= 0 && page.indexOf("streamBuffer.remove") >= 0, "playback stays near the live edge and old ranges are removed");
assert(page.indexOf("stream socket open ") >= 0, "a mode switch logs that the stream socket is open");
assert(page.indexOf("id=\"streamHold\"") >= 0, "a neutral hold covers the canvas while the stream is pending");
assert(page.indexOf("announceBuild(true)") >= 0, "a live sender gets the build once, not on every canvas log");
assert(page.indexOf("stream socket open ") >= 0, "the page logs the stream socket opening");
assert(page.indexOf("stream frame ") >= 0, "the page logs stream frames");
assert(page.indexOf('msg.type === "stream"') >= 0, "the page accepts the stream choice");
assert(page.indexOf("maybeProbeStream()") >= 0, "the page sends the stream probe");
assert(page.indexOf('id="streamFrame"') >= 0, "the JPEG canvas is on the page");
assert(page.indexOf('id="streamVideo"') < 0, "the stream video is not in the page until the experiment creates it");
assert(page.indexOf('video.id = "streamVideo"') >= 0 && page.indexOf("stream-live") >= 0, "the H.264 experiment creates a visible full-size video");
assert(page.indexOf("if (!SpsphereCast.spsH264Debug()) return;") >= 0, "H.264 bytes do not open MediaSource unless opted in");
sandbox.location = { search: "", hash: "" };
assert(Cast.spsH264Debug() === false, "H.264 is off without spsdebug=h264");
sandbox.location = { search: "?spsdebug=h264", hash: "" };
assert(Cast.spsH264Debug() === true, "spsdebug=h264 opts into H.264");
sandbox.location = { search: "?spsdebug=mesh", hash: "" };
assert(Cast.spsH264Debug() === false, "mesh debug does not enable H.264");
const connectAt = page.indexOf("function connectStream");
const choiceAt = page.indexOf("function acceptStreamChoice");
const connectBody = page.slice(connectAt, choiceAt);
assert(connectBody.indexOf("modeChanged") >= 0 && connectBody.indexOf("releaseMse()") >= 0, "a mode switch resets the MSE state");
assert(connectBody.indexOf("new WebSocket") > connectBody.indexOf("modeChanged"), "a mode switch opens a new socket");
assert(connectBody.indexOf("!modeChanged) return") >= 0, "an open socket is kept only when the mode is unchanged");
const onlyFetches = [];
sandbox.__castSend = function (msg) {
  if (msg && msg.type === "fetch") onlyFetches.push(msg.id);
};
const onlyHost = {
  width: 320, height: 180, style: {},
  addEventListener: function () {},
  getContext: function () { return null; },
};
const only = Cast.create(onlyHost);
only.setQueue([{
  id: "only",
  url: "http://192.168.1.8/photo.jpg",
  width: 8000,
  height: 4000,
  tiles: [],
  overview: { id: "only:overview", url: "http://192.168.1.8/overview.jpg", texW: 64, texH: 32 },
}]);
assert(only.session && only.session.entry && !only.session.entry.tiles, "a queue with no strips still opens");
assert(onlyFetches.indexOf("only:overview") === 0, "the overview is requested, got " + onlyFetches.join(","));
assert(onlyFetches.length === 1, "no strip is requested, got " + onlyFetches.join(","));
const script = page.split("<script>").pop().split("</script>")[0];
new Function(script);

console.log("stream ok");
