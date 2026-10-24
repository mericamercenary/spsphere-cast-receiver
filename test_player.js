const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "player.js"), "utf8");
const sandbox = {
  console: console,
  Date: Date,
  performance: { now: function () { return 0; } },
  __castSend: function () {},
};
sandbox.window = sandbox;
sandbox.document = {
  getElementById: function (id) {
    if (!sandbox.__marks) sandbox.__marks = {};
    if (!sandbox.__marks[id]) {
      sandbox.__marks[id] = {
        hidden: true,
        style: {},
        textContent: "",
        classList: { add: function () {}, remove: function () {} },
      };
    }
    return sandbox.__marks[id];
  },
};
sandbox.requestAnimationFrame = function () { return 1; };
sandbox.cancelAnimationFrame = function () {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const Cast = sandbox.SpsphereCast;

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function bareCanvas() {
  return {
    width: 320,
    height: 180,
    clientWidth: 320,
    clientHeight: 180,
    style: {},
    getContext: function () { return null; },
  };
}

function install(player) {
  player._injectImage = function (payload) {
    return { label: payload, width: 32, height: 16 };
  };
  player._uploadTile = function (img) {
    return { label: img && img.label, bytes: 64, _mip: true };
  };
}

function pump(session, limit) {
  let guard = 0;
  const cap = limit || 24;
  while (session && session.pending && guard < cap) {
    const pending = session.pending;
    session.noteChunk({
      type: "chunk",
      id: pending.id,
      token: pending.token,
      i: 0,
      n: 1,
      data: pending.id,
    });
    guard += 1;
  }
  return guard;
}

function deliver(player, pending) {
  player.noteChunk({
    type: "chunk",
    id: pending.id,
    token: pending.token,
    i: 0,
    n: 1,
    data: pending.id,
  });
}

function rowsPhoto(id) {
  const tiles = [];
  for (let row = 0; row < 3; row++) {
    tiles.push({
      id: id + "-r" + row,
      url: "http://10.0.0.8/" + id + "-r" + row + ".jpg",
      col: 0,
      row: row,
      srcX: 0,
      srcY: row * 1000,
      srcW: 2000,
      srcH: 1000,
      texW: 512,
      texH: 256,
    });
  }
  return {
    id: id,
    url: "http://10.0.0.8/" + id + ".jpg",
    width: 2000,
    height: 3000,
    overview: { id: id + ":overview", url: "http://10.0.0.8/" + id + "-overview.jpg", texW: 64, texH: 32 },
    tiles: tiles,
  };
}

const clock = { t: 10000 };
const player = Cast.create(bareCanvas());
player._focusNow = function () { return clock.t; };
install(player);
player.manual = true;
player.setQueue([rowsPhoto("live"), rowsPhoto("next")]);
assert(player._presented !== true, "startup has not presented a photo yet");
assert(player._intro === "hold", "startup holds the title mark");
assert(player._markWanted() === true, "the mark is up before the first photo");

const session = player.session;
const sessionId = session;
let guard = 0;
while (session.loaded.filter(function (piece) { return piece.tile && !piece.tile._overview; }).length < 1 && session.pending && guard < 8) {
  deliver(player, session.pending);
  guard += 1;
}
assert(session.loaded.some(function (piece) { return piece.tile && piece.tile.row === 1; }), "the horizon strip is on the session");
const horizon = session.loaded.filter(function (piece) { return piece.tile && piece.tile.row === 1; })[0];
const horizonFocus = horizon._focusAt;
assert(horizonFocus === clock.t, "the horizon fade starts when the strip uploads");
const urlsBefore = session.entry.tiles.map(function (tile) { return tile.url; });
player._presented = true;
player._intro = "off";
player._syncMark(16);
assert(player._intro !== "hold", "sync does not bring the mark back after the photo is up");

clock.t += 400;
const retileItem = rowsPhoto("live");
retileItem.tiles.forEach(function (tile) { tile.url = tile.url.replace(".jpg", "-fresh.jpg"); });
retileItem.overview.url = "http://10.0.0.8/live-overview-fresh.jpg";
player.retile("live", retileItem);
assert(player.session === sessionId, "retile keeps the session that is already showing");
assert(player._awaitingSwap !== true, "retile does not arm a swap of the photo already on screen");
assert(!player._standby || !player._standby.entry || player._standby.entry.id !== "live", "retile does not preload a second copy of the live photo");
assert(player.entries[0] === player.session.entry, "the queue points at the session entry, not a new object");
assert(player.session.entry.tiles[0].url.indexOf("-fresh.jpg") > 0, "tile urls update on the live entry");
assert(player.session.entry.overview.url.indexOf("fresh") > 0, "the overview url updates on the live entry");
assert(urlsBefore[0] !== player.session.entry.tiles[0].url, "the url actually changed");
assert(horizon._focusAt === horizonFocus, "already-loaded strips do not restart their fade");
assert(player._markWanted() === false, "retile does not ask for the title mark");
assert(player._intro !== "hold", "retile does not put the mark back on screen");
player._awaitingSwap = true;
player._awaitIndex = 1;
player._intro = "hold";
assert(player._markWanted() === false, "once a photo has been presented the mark stays off");
player._syncMark(16);
assert(player._intro !== "hold", "a swap does not re-enter the title hold");
player._awaitingSwap = false;
player._awaitIndex = null;

const activeBase = player._bases[player.session.entry.id];
const activeTex = activeBase && activeBase.tex;
const activeLabel = activeTex && activeTex.label;
assert(activeTex, "the live photo has a base texture");
if (!player._standby || !player._standby.entry || player._standby.entry.id !== "next") {
  player._standby = player._newSession();
  player._standby.preload(player.entries[1]);
}
assert(player._standby && player._standby.entry && player._standby.entry.id === "next", "the next photo can preload beside the live one");
let overviewBox = null;
const standbyBoxes = player._standby.assemblers || {};
Object.keys(standbyBoxes).forEach(function (id) {
  if (standbyBoxes[id] && standbyBoxes[id].tile && standbyBoxes[id].tile._overview) overviewBox = standbyBoxes[id];
});
assert(overviewBox, "standby asked for its own overview");
deliver(player, { id: overviewBox.id, token: overviewBox.token });
const standbyBase = player._bases[player._standby.entry.id];
assert(standbyBase && standbyBase.tex && standbyBase.tex !== activeTex, "standby overview lands on the next photo's base");
assert(player._bases[player.session.entry.id].tex === activeTex, "standby overview does not replace the live base texture");
assert((player._bases[player.session.entry.id].tex.label || "") === (activeLabel || ""), "the live base label is unchanged");
assert(String(standbyBase.tex.label || "").indexOf("next") >= 0, "the standby base received the next overview, got " + standbyBase.tex.label);

const lanTimers = [];
sandbox.setTimeout = function (fn, ms) {
  lanTimers.push({ fn: fn, ms: ms });
  return lanTimers.length;
};
sandbox.clearTimeout = function () {};
sandbox.Image = function () {};
sandbox.fetch = undefined;
const lanSent = [];
sandbox.__castSend = function (msg) { lanSent.push(msg); };
const lanPlayer = Cast.create(bareCanvas());
lanPlayer._focusNow = function () { return 40000; };
install(lanPlayer);
lanPlayer.setLan(true);
const wide = rowsPhoto("lan");
wide.tiles = [0, 1, 2, 3].map(function (col) {
  return {
    id: "lan-c" + col,
    url: "http://192.168.1.20/lan-c" + col + ".jpg",
    col: col,
    row: 0,
    srcX: col * 500,
    srcY: 0,
    srcW: 500,
    srcH: 1000,
    texW: 256,
    texH: 256,
  };
});
wide.width = 2000;
wide.height = 1000;
wide.overview.url = "http://192.168.1.20/lan-overview.jpg";
lanPlayer.setQueue([wide]);
const lanWaits = lanTimers.filter(function (timer) { return timer.ms === Cast.LAN_PROBE_TIMEOUT_MS; });
assert(Cast.LAN_PROBE_TIMEOUT_MS === 5000, "the first LAN try waits 5000ms");
assert(Cast.LAN_TIMEOUT_MS === 8000, "a proven LAN waits 8000ms");
assert(Cast.LAN_FAIL_LIMIT === 4, "LAN tolerates 3 misses and drops on the 4th");
assert(lanWaits.length === 2, "overview plus the strip under the lens is the LAN probe, got " + lanWaits.length);
assert(lanPlayer.session._inFlight() === 1, "the centered strip is in flight before the next column, got " + lanPlayer.session._inFlight());
lanWaits[0].fn();
assert(lanPlayer._lan === true, "a timeout keeps the LAN flag");
assert(lanPlayer._lanDead === false, "a single probe timeout does not kill LAN");
assert(lanPlayer._lanFailures === 1, "the timeout counts as one failure, got " + lanPlayer._lanFailures);
const fallback = lanSent.filter(function (msg) { return msg && msg.type === "fetch" && msg.reason === "lan"; });
assert(fallback.length === 1, "that request falls back to Cast, got " + JSON.stringify(fallback));

const miss = Cast.create(bareCanvas());
miss.setLan(true);
for (let n = 0; n < 3; n++) {
  const before = lanTimers.length;
  miss._loadLan("miss-" + n, n + 1, "http://10.1.1.1/m" + n + ".jpg");
  const timer = lanTimers.slice(before).filter(function (item) { return item.ms === Cast.LAN_PROBE_TIMEOUT_MS; }).pop();
  assert(timer, "miss " + n + " armed a probe timer");
  timer.fn();
}
assert(miss._lanFailures === 3 && miss._lanDead === false && miss._lan === true, "three misses still leave LAN up");
const beforeFourth = lanTimers.length;
miss._loadLan("miss-3", 4, "http://10.1.1.1/m3.jpg");
lanTimers.slice(beforeFourth).filter(function (item) { return item.ms === Cast.LAN_PROBE_TIMEOUT_MS; }).pop().fn();
assert(miss._lanFailures === 4 && miss._lanDead === true && miss._lan === true, "the fourth consecutive miss drops LAN fetches");

sandbox.Image = function () {
  Object.defineProperty(this, "src", {
    set: function () {
      this.width = 8;
      this.height = 8;
      if (this.onload) this.onload();
    },
  });
};
miss._loadLan("miss-ok", 9, "http://10.1.1.1/ok.jpg");
assert(miss._lanFailures === 0, "a LAN success clears the failure run");
miss.setLan(true);
assert(miss._lanDead === false && miss._lanFailures === 0, "setLan arms a fresh Wi-Fi attempt");

assert(Cast.TILE_FADE_MS === 2400, "photo-to-photo tile fade is 2400ms");
assert(Cast.FOCUS_MS === 1800, "focus fade is 1800ms");
assert(Math.abs(Cast.FOCUS_FEATHER - 0.65) < 1e-9, "the wave feather is 0.65 of a strip");
assert(Math.abs(Cast.FOCUS_HANDOFF - 0.35) < 1e-9, "the next strip joins at 0.35, got " + Cast.FOCUS_HANDOFF);
assert(Math.abs(Cast.REVEAL_HANDOFF - 0.35) < 1e-9, "reveal handoff matches focus handoff, got " + Cast.REVEAL_HANDOFF);
const born = 1000;
assert(Math.abs(Cast.revealProgress(born, born + Cast.FOCUS_MS / 4, Cast.FOCUS_MS) - 0.25) < 1e-9, "reveal progress is linear at one quarter");
assert(Math.abs(Cast.revealProgress(born, born + Cast.FOCUS_MS / 2, Cast.FOCUS_MS) - 0.5) < 1e-9, "reveal progress is linear at halfway");
const ease = Cast.easeInOut(0.25);
assert(Math.abs(Cast.revealProgress(born, born + Cast.FOCUS_MS * 0.25, Cast.FOCUS_MS) - ease) > 0.05, "reveal progress is not the rounded ease");

const band = { srcX: 0, srcY: 1000, srcW: 2000, srcH: 1000 };
const mid = Cast.focusMask(0.25, 0.5, band, 2000, 3000, 0.5, { left: 0, right: 0, up: 0, down: 0 }, { anchorV: 0.5 });
const side = Cast.focusMask(0.02, 0.5, band, 2000, 3000, 0.5, { left: 0, right: 0, up: 0, down: 0 }, { anchorV: 0.5 });
assert(Math.abs(mid - side) < 1e-6, "the same latitude is flat, with no corner pinch, got " + mid + " vs " + side);
assert(Math.abs(mid - 1) < 1e-6, "the master edge is fully sharp halfway through, got " + mid);
const back = { srcX: 6144, srcY: 1638, srcW: 4096, srcH: 820 };
const wrappedEdge = Cast.focusMask(0.02, 0.5, back, 8192, 4096, 1, {}, { anchorV: 0.5 });
const wrappedMid = Cast.focusMask(0, 0.5, back, 8192, 4096, 1, {}, { anchorV: 0.5 });
assert(wrappedEdge === 1 && wrappedMid === 1, "column 1 stays sharp across the wrap, got " + wrappedEdge + " " + wrappedMid);
assert(code.indexOf("focusMask(uu,v)") >= 0, "the shader masks the unwrapped u");
assert(code.indexOf("focusMask(uu,uv.y)") >= 0, "the fallback shader masks the unwrapped u");
assert(code.indexOf("smoothstep(0.0,0.08,ex)") < 0, "the strip fade has no horizontal pinch");
assert(code.indexOf("smoothstep(0.0,0.14,ey)") < 0, "the strip fade has no vertical pinch");
assert(code.indexOf("return wave*fx*fy") < 0, "the strip fade is not a rounded product");
assert(code.indexOf("worldFromPhoto") >= 0, "strip vertices are un-straightened before they are drawn");
assert(code.indexOf("0.5/180.0") < 0, "the vertical seam is not a half-degree overlap");
const finished = { srcX: 2048, srcY: 1638, srcW: 4096, srcH: 820, row: 2, col: 0 };
const under = { srcX: 2048, srcY: 2458, srcW: 4096, srcH: 819, row: 3, col: 0 };
const edgeSeam = 2458 / 4096;
const edgeParent = Cast.focusMask(0.5, edgeSeam, finished, 8192, 4096, Cast.FOCUS_HANDOFF + Cast.FOCUS_FEATHER / 2, { down: Cast.FOCUS_FEATHER / 2 }, { anchorV: 0.5 });
const edgeChild = Cast.focusMask(0.5, edgeSeam, under, 8192, 4096, Cast.FOCUS_FEATHER / 2, { up: Cast.FOCUS_HANDOFF + Cast.FOCUS_FEATHER / 2 }, { anchorV: 0.5 });
assert(Math.abs(edgeParent - edgeChild) < 0.02, "the wave is continuous across the seam, got " + edgeParent + " / " + edgeChild);
const bottom = Cast.focusMask(0.5, (2458 - 1) / 4096, finished, 8192, 4096, 1, { down: 0 }, { anchorV: 0.5 });
assert(bottom === 1, "a finished strip stays sharp at its bottom edge, got " + bottom);
const upperPatch = Cast.tilePatch({ srcX: 0, srcY: 1638, srcW: 4096, srcH: 820, padT: 32, padB: 32, padL: 32, padR: 32 }, 8192, 4096);
const lowerPatch = Cast.tilePatch({ srcX: 0, srcY: 2458, srcW: 4096, srcH: 819, padT: 32, padB: 32, padL: 32, padR: 32 }, 8192, 4096);
function patchV(mesh, max) {
  let v = max ? -1 : 2;
  for (let i = 4; i < mesh.interleaved.length; i += 5) v = max ? Math.max(v, mesh.interleaved[i]) : Math.min(v, mesh.interleaved[i]);
  return v;
}
assert(patchV(upperPatch, true) - edgeSeam < 1.5 / 4096, "the upper strip does not spill a blur band past the seam");
assert(edgeSeam - patchV(lowerPatch, false) < 1.5 / 4096, "the lower strip does not spill a blur band past the seam");
const photoDir = [0.3, 0.4, 0.8660254];
const worldDir = Cast.undoPose(photoDir, 0.35, -0.2);
const roundDir = Cast.applyPose(worldDir, 0.35, -0.2);
assert(Math.abs(roundDir[0] - photoDir[0]) < 1e-5 && Math.abs(roundDir[1] - photoDir[1]) < 1e-5 && Math.abs(roundDir[2] - photoDir[2]) < 1e-5, "un-straightening a strip puts it back on the photo");
const gutterTile = { row: 2, col: 0, srcX: 10, srcY: 20, srcW: 100, srcH: 80, padL: 4, padR: 6, padT: 3, padB: 5, texW: 110, texH: 88 };
const fullWin = Cast.windowFromCrop(gutterTile, 0, 0, 110, 88);
assert(fullWin.row === 2 && fullWin.col === 0, "a crop keeps its strip address");
assert(fullWin.padL === 4 && fullWin.padR === 6 && fullWin.padT === 3 && fullWin.padB === 5, "a full crop keeps every gutter, got " + fullWin.padB);
assert(fullWin.srcX === 10 && fullWin.srcY === 20 && fullWin.srcW === 100 && fullWin.srcH === 80, "a full crop keeps the source rectangle");
const partial = Cast.windowFromCrop(gutterTile, 0, 80, 20, 8);
assert(partial && partial.padB === 5 && partial.padT === 0 && partial.srcH === 3, "a crop into the bottom gutter keeps padB, got " + (partial && partial.padB));

const child = rowsPhoto("live").tiles.find(function (tile) { return tile.row === 0; });
const parentAmount = function (amount) {
  return Cast.revealUnlocked(child, rowsPhoto("live").tiles, 1, function (col, row) {
    return row === 1 ? amount : 0;
  });
};
assert(parentAmount(0.34) === false, "a child stays locked below the handoff");
assert(parentAmount(0.35) === true, "a child unlocks at the handoff");
assert(parentAmount(0.9) === true, "a child stays unlocked while the parent feather is still running");

const handoffAt = horizonFocus + Math.round(Cast.FOCUS_MS * Cast.REVEAL_HANDOFF);
clock.t = horizonFocus + Math.round(Cast.FOCUS_MS * 0.25);
const earlyChild = session.pending;
assert(earlyChild && earlyChild.id.indexOf("-r") >= 0, "a neighboring strip is waiting, got " + (earlyChild && earlyChild.id));
deliver(player, earlyChild);
const above = session.loaded.filter(function (piece) { return piece.tile && piece.tile.row !== 1; }).pop();
assert(above && above._uploadedAt === clock.t, "the child records when its upload finished");
assert(above._focusAt === handoffAt, "the child waits for the parent's leading edge, got " + above._focusAt + " vs " + handoffAt);
assert(player._revealOf(above) === 0, "the child stays soft until the seam");
clock.t = handoffAt;
assert(player._revealOf(above) === 0, "the child starts as the wave reaches the seam");
clock.t = handoffAt + Math.round(Cast.FOCUS_MS / 6);
const childReveal = player._revealOf(above);
const parentReveal = player._revealOf(horizon);
assert(Math.abs(childReveal - (1 / 6)) < 0.02, "the child continues in the same line, got " + childReveal);
assert(parentReveal < 1, "the parent has not finished, got " + parentReveal);
assert(parentReveal > Cast.REVEAL_HANDOFF, "the parent is in its feather tail, got " + parentReveal);
const spanW = 2000;
const spanH = 3000;
const seamV = above.tile.row < 1 ? (above.tile.srcY + above.tile.srcH) / spanH : above.tile.srcY / spanH;
const parentSeam = Cast.focusMask(0.5, seamV, horizon.tile, spanW, spanH, parentReveal, {}, { anchorV: 0.5 });
const childSeam = Cast.focusMask(0.5, seamV, above.tile, spanW, spanH, childReveal, {}, { anchorV: 0.5 });
assert(childSeam > 0.2, "the next band is already opening across the seam, got " + childSeam);
assert(parentSeam <= childSeam + 0.02, "the parent edge is not ahead of the band that joined at halfway, got " + parentSeam + " vs " + childSeam);

const lateClock = horizonFocus + Math.round(Cast.FOCUS_MS * 0.8);
clock.t = lateClock;
const latePending = session.pending;
assert(latePending, "the other neighbor is still outstanding");
deliver(player, latePending);
const late = session.loaded.filter(function (piece) { return piece.tile && piece.tile.id === latePending.id; })[0];
assert(late && late._focusAt === lateClock, "a strip that arrives during the tail starts immediately, got " + (late && late._focusAt));
assert(player._revealOf(late) === 0, "it joins at the soft edge instead of waiting for the parent to finish");
assert(player._revealOf(horizon) < 1, "the parent fade is still running");

function columnSeams(entry) {
  const tile = entry.tiles.filter(function (item) { return item.col === 0; })[0];
  const left = tile.srcX / entry.width;
  const right = (tile.srcX + tile.srcW) / entry.width;
  const mid = (tile.srcX + tile.srcW * 0.5) / entry.width;
  return { left: left, right: right - Math.floor(right), mid: mid - Math.floor(mid) };
}
function wrapDelta(a, b) {
  let d = Math.abs(a - b) % 1;
  if (d > 0.5) d = 1 - d;
  return d;
}
function photoFrom(id, srcX) {
  const width = 8192;
  const height = 4096;
  const srcW = width / 2;
  const tiles = [0, 1].map(function (col) {
    return {
      id: id + "-c" + col,
      url: "http://10.0.0.8/" + id + "-c" + col + ".jpg",
      col: col,
      row: 0,
      srcX: srcX + col * srcW,
      srcY: 0,
      srcW: srcW,
      srcH: height,
    };
  });
  return {
    id: id,
    url: "http://10.0.0.8/" + id + ".jpg",
    width: width,
    height: height,
    tiles: tiles,
  };
}
[photoFrom("centered", 8192 / 4), photoFrom("legacy", 0)].forEach(function (entry) {
  const seams = columnSeams(entry);
  const yaw = Cast.startingYawForEntry(entry);
  const show = Cast.create(bareCanvas());
  install(show);
  show.setQueue([entry, photoFrom(entry.id + "-next", entry.tiles[0].srcX)]);
  const view = show._lodView();
  assert(wrapDelta(view.u, seams.mid) < 1e-3, entry.id + " starts at the middle of column 0, got u " + view.u + " vs " + seams.mid);
  assert(Math.abs(wrapDelta(view.u, seams.left) - 0.25) < 1e-3, entry.id + " is 90 degrees off the left seam, got " + view.u);
  assert(Math.abs(wrapDelta(view.u, seams.right) - 0.25) < 1e-3, entry.id + " is 90 degrees off the right seam, got " + view.u);
  assert(Math.abs(yaw - show.yaw) < 1e-6, entry.id + " yaw follows the strip center");
  pump(show.session);
  assert(show._standby && show._standby.entry, entry.id + " preloads the next photo");
  const preload = show._standby.hooks.view();
  const nextSeams = columnSeams(show._standby.entry);
  assert(wrapDelta(preload.u, nextSeams.mid) < 1e-3, "standby preloads the middle of the next photo's first strip, got " + preload.u);
});

const handoff = Cast.create(bareCanvas());
handoff._focusNow = function () { return 80000; };
install(handoff);
handoff.setQueue([rowsPhoto("photo0"), rowsPhoto("photo1")]);
pump(handoff.session);
assert(handoff._standby && handoff._standby.entry && handoff._standby.entry.id === "photo1", "photo 1 preloads while photo 0 is up");
pump(handoff._standby);
const photo1Base = handoff._bases && handoff._bases.photo1;
assert(photo1Base && photo1Base.tex, "photo 1's overview is installed before the swap");
const preloaded = (handoff._standby.loaded || []).filter(function (piece) {
  return piece && piece.tile && !piece.tile._base && !piece.tile._overview;
});
assert(preloaded.length > 0, "photo 1's opening strips are loaded before the swap");
assert(preloaded.every(function (piece) { return piece._revealDone === true; }), "preloaded strips are already sharp");
const before = handoff._tileDraw.slice();
handoff._presented = true;
handoff.next();
assert(handoff.index === 1, "the show moves to photo 1");
assert(handoff._fading === true, "the old photo crossfades out");
assert(handoff._fadeFrom && handoff._fadeFrom.length === before.length && handoff._fadeFrom.length > 0, "photo 0 stays on screen during the crossfade");
assert(handoff.frameCover().black === false, "the swap is not a black frame");
handoff.session.loaded.forEach(function (piece) {
  if (!piece || !piece._revealDone) return;
  assert(handoff._revealOf(piece) === 1, "a preloaded strip is fully sharp on the first frame, got " + handoff._revealOf(piece));
});

// Verify standby view-ready / budget-full does not loop-request over 120 frames
const stormGuard = Cast.create(bareCanvas());
stormGuard._focusNow = function () { return 90000; };
install(stormGuard);
stormGuard.playing = true;
stormGuard.manual = false;
stormGuard.setQueue([rowsPhoto("sg0"), rowsPhoto("sg1")]);
pump(stormGuard.session);
assert(stormGuard._standby && stormGuard._standby.entry, "standby opened for sg1");
// Deliver opening strip so standby is view-ready, then mark budgetFull
deliver(stormGuard, stormGuard._standby.pending);
if (stormGuard._standby.pending) deliver(stormGuard, stormGuard._standby.pending);
stormGuard._gpuBytes = Cast.GPU_CAP;
stormGuard._standby.budgetFull = true;
const reqBeforeLoop = stormGuard._diagRequested;
for (let f = 0; f < 120; f++) {
  stormGuard._feedPreload();
  stormGuard._pumpFrame(16);
}
assert(stormGuard._diagRequested - reqBeforeLoop <= 4, "120 frames at GPU_CAP must not storm standby requests, delta=" + (stormGuard._diagRequested - reqBeforeLoop));

console.log("test_player ok");
