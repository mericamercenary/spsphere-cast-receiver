const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "player.js"), "utf8");
const sandbox = { console, Date };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const Cast = sandbox.SpsphereCast;

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function photo(n) {
  const tiles = [];
  const span = 2000;
  for (let col = 0; col < 4; col++) {
    tiles.push({
      id: "p" + n + "-r0-c" + col,
      url: "http://phone/p" + n + "-" + col + ".jpg",
      col: col,
      row: 0,
      srcX: col * span,
      srcY: 0,
      srcW: span,
      srcH: 4000,
      padL: 1,
      padR: 1,
      padT: 0,
      padB: 0,
      texW: span + 2,
      texH: 4000,
    });
  }
  return {
    id: "p" + n,
    url: "http://phone/p" + n + ".jpg",
    width: 8000,
    height: 4000,
    posePitch: 0,
    poseRoll: 0,
    tiles: tiles,
  };
}

function harness() {
  let now = 1_000;
  const live = [];
  let retained = 0;
  let maxLive = 0;
  let maxRetained = 0;
  const requests = [];
  const statuses = [];
  const shown = [];
  const fails = [];
  const memory = [];
  let held = null;
  const session = Cast.createSession({
    timeoutMs: 45_000,
    now: function () { return now; },
    request: function (id) { requests.push(id); },
    materialize: function (payload, done) {
      if (payload.indexOf("hold:") === 0) {
        held = { payload: payload, done: done };
        return;
      }
      done(null, {
        bytes: 500_000,
        label: payload,
        oom: payload.indexOf("oom:") === 0,
      });
    },
    upload: function (img) {
      if (img.oom) return { oom: true, bytes: 0, label: img.label };
      const tex = { bytes: img.bytes, label: img.label };
      live.push(tex);
      retained += tex.bytes;
      if (live.length > maxLive) maxLive = live.length;
      if (retained > maxRetained) maxRetained = retained;
      return tex;
    },
    release: function (tex) {
      const at = live.indexOf(tex);
      if (at >= 0) live.splice(at, 1);
      retained -= tex.bytes;
    },
    onStatus: function (text) { statuses.push(text); },
    onShown: function (state) { shown.push(state.id); },
    onFail: function (reason) { fails.push(String(reason && reason.message || reason)); },
    onMemory: function (id) { memory.push(id); },
  });
  return {
    session: session,
    live: live,
    requests: requests,
    statuses: statuses,
    shown: shown,
    fails: fails,
    memory: memory,
    held: function () { return held; },
    retained: function () { return retained; },
    maxLive: function () { return maxLive; },
    maxRetained: function () { return maxRetained; },
    advance: function (ms) { now += ms; session.tick(now); },
  };
}

function deliver(session, id, data) {
  session.noteChunk({
    type: "chunk",
    id: id,
    token: session.token,
    i: 0,
    n: 1,
    data: data || ("bytes:" + id),
  });
}

assert(Cast.DEFAULT_DPS === 9, "auto-pan default should be half of 18");

const show = harness();
const between = [];
for (let n = 1; n <= 6; n++) {
  show.session.open(photo(n));
  if (n > 1) between.push(show.retained());
  photo(n).tiles.forEach(function (tile) { deliver(show.session, tile.id); });
  assert(show.shown[show.shown.length - 1] === "p" + n, "photo " + n + " shown");
  assert(show.live.length === 4, "only the current photo's textures stay live");
}
assert(show.maxLive() === 4, "max live textures " + show.maxLive());
assert(show.maxRetained() === 2_000_000, "retained bytes " + show.maxRetained());
assert(between.every(function (bytes) { return bytes === 0; }), "previous photo was released before the next upload");

const marathon = harness();
for (let n = 1; n <= 24; n++) {
  const entry = photo(100 + n);
  marathon.session.open(entry);
  entry.tiles.forEach(function (tile) { deliver(marathon.session, tile.id); });
  assert(marathon.live.length === 4, "a long show leaked textures at photo " + n + ", live " + marathon.live.length);
  assert(marathon.retained() === 2_000_000, "a long show kept " + marathon.retained() + " bytes at photo " + n);
}
assert(marathon.maxLive() === 4, "peak live textures over 24 photos was " + marathon.maxLive());
assert(show.statuses.indexOf("busy") >= 0, "loading spinner state");
assert(show.statuses.indexOf("Loading...") < 0, "no loading sentence on the TV");
assert(!/photo \d|°|\d+ of \d+|Waiting|Couldn't/.test(show.statuses.join(" ")), "no words or counters on the TV");

const cancel = harness();
cancel.session.open(photo(1));
deliver(cancel.session, photo(1).tiles[0].id);
deliver(cancel.session, photo(1).tiles[1].id, "hold:late");
assert(cancel.held(), "second tile is in flight");
cancel.session.open(photo(2));
cancel.held().done(null, { bytes: 500_000, label: "late" });
assert(cancel.live.every(function (tex) { return tex.label !== "late"; }), "a cancelled tile is not uploaded");
assert(cancel.requests.indexOf("p2-r0-c0") >= 0, "the next photo was requested");
deliver(cancel.session, "p2-r0-c0");
assert(cancel.live.length === 1, "only the new photo's finished tile is live");

const timed = harness();
timed.session.open(photo(3));
const firstAsks = timed.requests.filter(function (id) { return id === "p3-r0-c0"; }).length;
timed.advance(45_001);
const retried = timed.requests.filter(function (id) { return id === "p3-r0-c0"; }).length;
assert(retried === firstAsks + 1, "one retry after the timeout");
timed.advance(45_001);
assert(timed.statuses[timed.statuses.length - 1] === "error", "failure is not drawn as text");
assert(timed.live.length === 0, "a failed photo leaves no textures");

const oom = harness();
oom.session.open(photo(4));
deliver(oom.session, "p4-r0-c0", "oom:p4");
assert(oom.memory.length === 0, "the TV does not ask for a smaller copy");
assert(oom.live.length === 0, "an out-of-memory upload is not kept");
assert(oom.shown.length === 0, "an upload that fits nothing is not shown");
assert(oom.statuses[oom.statuses.length - 1] === "", "oom leaves the screen without a status string");
assert(!/Loading|smaller|Waiting|Couldn't/.test(oom.statuses.join(" ")), "oom is not drawn as text");

const flash = harness();
let reopen = 0;
flash.session.hooks.materialize = function (payload, done) {
  const img = { bytes: 500_000, label: payload, done: done };
  done(null, img);
  done(new Error("src-cleared"), img);
};
flash.session.hooks.dropImage = function (img) {
  reopen += 1;
  if (img && img.done) img.done(new Error("src-cleared"));
};
flash.session.open(photo(1));
photo(1).tiles.forEach(function (tile) { deliver(flash.session, tile.id); });
assert(flash.shown[0] === "p1", "a second decode callback still shows the photo");
assert(flash.live.length === 4, "clearing the image source does not release the photo");
assert(flash.fails.length === 0, "the late error is not a failed show");
assert(flash.memory.length === 0, "the late error does not ask for a smaller copy");
assert(reopen === 4, "each tile still drops its decoded image");

const look = Cast.viewCenterUv(0, 0);
assert(Math.abs(look.u - 0.5) < 1e-6 && Math.abs(look.v - 0.5) < 1e-6, "yaw 0 looks at the middle, got " + look.u + "," + look.v);
const quarter = Cast.viewCenterUv(90, 0);
assert(Math.abs(quarter.u - 0.75) < 1e-6, "yaw 90 looks at u=0.75, got " + quarter.u);

const budgetTiles = photo(9).tiles;
const oneTile = budgetTiles[0].texW * budgetTiles[0].texH * 4;
const kept = Cast.planResidence(budgetTiles, 8000, 4000, { u: 0.4, v: 0.5, halfU: 0.02, halfV: 0.1 }, 8192, oneTile);
const holders = [];
kept.forEach(function (slot, index) { if (slot.resident) holders.push(index); });
assert(holders.length === 1 && holders[0] === 1, "a tight budget keeps the tile in view, got " + holders.join(","));
assert(kept[1].window.bytes <= oneTile, "the resident tile fits the budget");
assert(kept[1].window.full, "the view tile is not downscaled");

const wide = {
  id: "wide",
  srcX: 0,
  srcY: 0,
  srcW: 3000,
  srcH: 100,
  padL: 0,
  padR: 0,
  padT: 0,
  padB: 0,
  texW: 3000,
  texH: 100,
};
const cropped = Cast.planResidence([wide], 3000, 100, { u: 0.5, v: 0.5, halfU: 0.1, halfV: 0.2 }, 2048, 1e15);
assert(cropped[0].resident, "a tile larger than MAX_TEXTURE_SIZE still covers the view");
assert(cropped[0].window.texW === 2048 && cropped[0].window.texH === 100, "the window is a 1:1 crop, got " + cropped[0].window.texW);
assert(!cropped[0].window.full, "the crop is not a scaled-down copy of the whole tile");
assert(cropped[0].window.srcX <= 1500 && 1500 < cropped[0].window.srcX + cropped[0].window.srcW, "the crop covers the view center");

const left = { srcX: 0, srcY: 0, srcW: 4, srcH: 4, padL: 1, padR: 1, padT: 0, padB: 0, texW: 6, texH: 4 };
const right = { srcX: 4, srcY: 0, srcW: 4, srcH: 4, padL: 1, padR: 1, padT: 0, padB: 0, texW: 6, texH: 4 };
const atLeftEdge = Cast.tileTexCoord(0.5, 0.5, left, 8, 4);
const atRightStart = Cast.tileTexCoord(0.5, 0.5, right, 8, 4);
assert(Math.abs(atLeftEdge.x * 6 - 5) < 1e-9, "left tile samples its right pad boundary");
assert(Math.abs(atRightStart.x * 6 - 1) < 1e-9, "right tile samples its left pad boundary");
assert(Cast.tileTexCoord(0.51, 0.5, left, 8, 4) === null, "past the unique edge is the next tile");

function wideTiles(id, cols, span) {
  const tiles = [];
  for (let col = 0; col < cols; col++) {
    tiles.push({
      id: id + "-c" + col,
      url: "http://phone/" + id + "-" + col + ".jpg",
      col: col,
      row: 0,
      srcX: col * span,
      srcY: 0,
      srcW: span,
      srcH: 1000,
      padL: 1,
      padR: 1,
      padT: 0,
      padB: 0,
      texW: span + 2,
      texH: 1000,
    });
  }
  return {
    id: id,
    url: "http://phone/" + id + ".jpg",
    width: cols * span,
    height: 1000,
    posePitch: 0,
    poseRoll: 0,
    tiles: tiles,
  };
}

function sampleCovered(entry) {
  return Cast.coversSphere(entry.tiles, entry.width, entry.height);
}

const row = harness();
const names = ["A", "B", "C", "A"];
const rendered = [];
names.forEach(function (name, pass) {
  const entry = wideTiles(name, 4, 2048);
  row.session.open(entry);
  if (pass === 3) {
    row.session.noteChunk({
      type: "chunk",
      id: entry.tiles[0].id,
      token: 1,
      i: 0,
      n: 9,
      data: "stale-from-the-first-A",
    });
    assert(row.shown.length === 3, "a stale chunk for the reused id does not finish the photo");
  }
  entry.tiles.forEach(function (tile) {
    deliver(row.session, tile.id, "pixels:" + name + ":" + tile.id + ":pass" + pass);
  });
  assert(row.shown[row.shown.length - 1] === name, name + " pass " + pass + " shown");
  assert(row.live.length === entry.tiles.length, name + " rendered every tile");
  assert(row.live.every(function (tex) { return tex.label.indexOf("pixels:" + name + ":") === 0; }), name + " pixels are this photo");
  assert(sampleCovered(entry), name + " covers the whole sphere");
  rendered.push(name);
});
assert(rendered.join(",") === "A,B,C,A", "A then B then C then A each rendered");

const half = harness();
const partial = wideTiles("half", 2, 4096);
partial.tiles = [partial.tiles[0]];
partial.width = 8192;
half.session.open(partial);
deliver(half.session, partial.tiles[0].id, "only-left");
assert(half.shown.length === 0, "a tile that covers half the width is not shown");
assert(half.fails.indexOf("coverage") >= 0, "partial coverage is a failure");
assert(!Cast.coversSphere(partial.tiles, partial.width, partial.height), "half a photo leaves a gap");
assert(Cast.coversSphere(wideTiles("full", 2, 4096).tiles, 8192, 1000), "both halves cover longitude");

const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
assert(page.indexOf("Waiting for photos") < 0, "receiver html has no waiting text");
assert(page.indexOf("Loading...") < 0, "receiver html has no loading text");
assert(page.indexOf("customNamespaces") >= 0, "the cast namespace is registered before start");
assert(page.indexOf("cast-media-player") >= 0, "the default cast overlay is hidden");
assert(page.indexOf('id="busy"') >= 0, "loading is a spinner");
assert(page.indexOf('type === "fov"') >= 0, "fov messages reach the player");

const fovSandbox = { console: console, Date: Date, performance: { now: function () { return 0; } }, __castSend: function () {} };
fovSandbox.window = fovSandbox;
fovSandbox.document = {
  getElementById: function () {
    return { hidden: true, textContent: "", classList: { add: function () {}, remove: function () {} } };
  },
};
fovSandbox.requestAnimationFrame = function () { return 1; };
fovSandbox.cancelAnimationFrame = function () {};
vm.createContext(fovSandbox);
vm.runInContext(code, fovSandbox);

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

const seqPlayer = fovSandbox.SpsphereCast.create(bareCanvas());
const seqShown = [];
fovSandbox.__castSend = function (msg) {
  if (msg && msg.type === "photo" && msg.ok) seqShown.push(msg.id);
};
function openOnPlayer(entry) {
  seqPlayer.setQueue([entry]);
  seqPlayer.play();
  const session = seqPlayer.session;
  session.hooks.materialize = function (payload, done) {
    done(null, { label: payload });
  };
  session.hooks.upload = function (img) { return { label: img.label }; };
  return session;
}
const sessionKept = [];
["A", "B", "C", "A"].forEach(function (name, pass) {
  const entry = wideTiles(name, 4, 2048);
  const session = openOnPlayer(entry);
  sessionKept.push(session);
  if (pass === 3) {
    seqPlayer.noteChunk({
      type: "chunk",
      id: entry.tiles[0].id,
      token: 1,
      i: 0,
      n: 9,
      data: "stale-from-the-first-A",
    });
    assert(seqShown.length === 3, "a stale chunk does not finish the second A");
    assert(session.shown === false, "the receiver is not stuck in loaded");
    assert(session.pending !== null, "the new photo is still loading, not dropped");
  }
  let drainGuard = 0;
  while (session.pending && !session.shown && drainGuard < 12) {
    const pending = session.pending;
    seqPlayer.noteChunk({
      type: "chunk",
      id: pending.id,
      token: pending.token,
      i: 0,
      n: 1,
      data: "pixels:" + name + ":" + pending.id,
    });
    drainGuard += 1;
  }
  assert(seqShown[seqShown.length - 1] === name, "player showed " + name);
  assert(session.shown === true, name + " left loading");
  assert(seqPlayer._busy === false, name + " hid the spinner");
  assert(seqPlayer._tileDraw.length > 0 && seqPlayer._tileDraw.length < entry.tiles.length, name + " draws the view, not the whole photo");
  assert(seqPlayer._tileDraw.every(function (piece) {
    return piece.tex && piece.tex.label.indexOf("pixels:" + name + ":") === 0;
  }), name + " pixels are on the sphere");
  const shownGaps = seqPlayer.frameGaps();
  assert(shownGaps.misses === 0, name + " stays covered by the overview, " + shownGaps.first);
});
assert(seqShown.join(",") === "A,B,C,A", "player rendered A, B, C, then A again");
assert(sessionKept.every(function (session) { return session === seqPlayer.session; }), "the chunk listener stays attached");

const zoomed = fovSandbox.SpsphereCast.create({
  width: 320,
  height: 180,
  clientWidth: 320,
  clientHeight: 180,
  style: {},
  getContext: function () { return null; },
});
zoomed.setFov(40);
for (let i = 0; i < 80; i++) zoomed.stepAim(50);
assert(Math.abs(zoomed.fov - 40) < 1, "fov springs to the control and stays there, got " + zoomed.fov);
zoomed.play();
for (let i = 0; i < 40; i++) zoomed.stepAim(50);
assert(Math.abs(zoomed.fov - 40) < 1, "play does not snap the zoom back to 75, got " + zoomed.fov);

const store = Cast.backingStoreSize(960, 540, 2, 1920, 1080);
assert(store.width === 1920 && store.height === 1080, "backing store caps a dense panel at 1920x1080, got " + store.width + "x" + store.height);
const capped = Cast.backingStoreSize(1920, 1080, 2, 3840, 2160);
assert(capped.width === 1920 && capped.height === 1080, "a 4K framebuffer is capped at the TV output");
const fallback = Cast.backingStoreSize(0, 0, 1, 0, 0);
assert(fallback.width === 1920 && fallback.height === 1080, "an empty panel still renders at 1920x1080");
const pot = Cast.potSize(4098, 2048);
assert(pot.w === 8192 && pot.h === 2048, "a non power-of-two tile pads without scaling");
const mesh = Cast.sphere(128, 256, true);
assert(mesh.count === 128 * 256 * 6, "the sphere is dense enough");
assert(mesh.indices.BYTES_PER_ELEMENT === 4, "a 128x256 mesh needs 32-bit indices");
const pageText = page.toLowerCase();
assert(page.indexOf("°") < 0, "the receiver page has no degree readout");

function shortestYaw(delta) {
  const wrapped = ((delta % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}
const aim = fovSandbox.SpsphereCast.create(bareCanvas());
aim.items = ["photo"];
aim.yaw = 80;
aim.applyAim({ seq: 1, yaw: 200, pitch: 12, roll: -4, fov: 75, anchor: true });
for (let i = 0; i < 50; i++) aim.stepAim(16);
assert(Math.abs(shortestYaw(aim.yaw - 80)) < 2, "the first sample does not jump to the phone compass, got " + aim.yaw);
assert(Math.abs(aim.pitch - 12) < 1, "pitch still follows gravity, got " + aim.pitch);
assert(Math.abs(aim.roll - -4) < 1, "roll still follows gravity, got " + aim.roll);
assert(aim.manual === true, "aim holds auto-pan");
const held = aim.yaw;
aim.applyAim({ seq: 2, yaw: 230, pitch: 12, roll: -4, fov: 75, anchor: false });
aim.stepAim(16);
const nudged = Math.abs(shortestYaw(aim.yaw - held));
assert(nudged > 0.4 && nudged < 25, "yaw eases toward the heading change, got " + aim.yaw);
for (let i = 0; i < 80; i++) aim.stepAim(16);
assert(Math.abs(shortestYaw(aim.yaw - 110)) < 2, "yaw follows the heading since the hold started, got " + aim.yaw);
aim.playing = true;
const parked = aim.yaw;
aim.advance(2000);
assert(Math.abs(shortestYaw(aim.yaw - parked)) < 1, "auto-pan does not overwrite a manual yaw");

["A", "B", "A"].forEach(function (name) {
  const entry = wideTiles("stop-" + name, 4, 2048);
  const session = openOnPlayer(entry);
  let stopGuard = 0;
  while (session.pending && !session.shown && stopGuard < 12) {
    const pending = session.pending;
    seqPlayer.noteChunk({
      type: "chunk",
      id: pending.id,
      token: pending.token,
      i: 0,
      n: 1,
      data: "pixels:" + name + ":" + pending.id,
    });
    stopGuard += 1;
  }
  assert(seqShown[seqShown.length - 1] === "stop-" + name, "after stop the receiver showed " + name);
  assert(seqPlayer._tileDraw.every(function (piece) {
    return piece.tex && piece.tex.label.indexOf("pixels:" + name + ":") === 0;
  }), name + " replaced the previous photo");
  assert(seqPlayer._glLost !== true, "stop does not drop the GL context");
  seqPlayer.stop();
  assert(seqPlayer._tileDraw.length === 0, "stop releases the photo");
  assert(seqPlayer.session, "stop keeps the receiver session for the next cast");
});

const startup = Cast.receiverStartup();
assert(startup.disableIdleTimeout === true, "idle timeout stays off");
assert(startup.maxInactivity >= 31 * 60, "inactivity window covers more than half an hour");
assert(startup.skipMplLoad === false, "the media player stays loaded");
assert(startup.streamType === "LIVE", "the show is a live media session");
assert(page.indexOf("receiverStartup") >= 0, "the receiver page uses the shared idle options");
assert(page.indexOf("heartbeat") >= 0, "the receiver page sends heartbeats");
assert(page.indexOf("getPlayerManager") >= 0, "the page keeps PlayerManager out of idle");

let idleClock = 0;
const guard = new Cast.IdleGuard(function () { return idleClock; });
guard.show();
let beats = 0;
for (let sec = 0; sec < 31 * 60; sec++) {
  idleClock += 1000;
  if (guard.tick()) beats += 1;
  assert(guard.state === "PLAYING", "a photo on screen never returns to idle");
}
assert(beats >= 120, "31 minutes of heartbeats, got " + beats);

const solo = fovSandbox.SpsphereCast.create(bareCanvas());
solo.setQueue([solidPhoto("solo")]);
assert(solo.playing === true && solo.items.length === 1, "one photo starts turning");
solo._integrate(30 * 60 * 1000);
assert(solo.index === 0, "a single photo never advances");
assert(solo.phase === "pan", "a single photo never fades out");
assert(solo.playing === true, "a single photo does not end");
assert(solo.itemDegrees > Cast.ROTATIONS * 360, "it keeps turning past two revolutions, got " + solo.itemDegrees);
solo.noteSender();
const marked = solo._lastSender;
assert(solo.senderTimedOut(marked + 15 * 1000) === false, "a 15s heartbeat is inside the silence window");
assert(solo.senderTimedOut(marked + Cast.SENDER_TIMEOUT_MS) === false, "exactly 45s of silence is not yet a drop");
assert(solo.senderTimedOut(marked + Cast.SENDER_TIMEOUT_MS + 1) === true, "only a real gap releases the show");
guard.pause();
idleClock += startup.heartbeatMs;
assert(guard.tick() === true, "a paused show still heartbeats");
assert(guard.state === "PAUSED", "pause is not the screensaver idle state");

function solidPhoto(id) {
  return {
    id: id,
    url: "http://phone/" + id + ".jpg",
    width: 64,
    height: 32,
    tiles: [{
      id: id + "-c0",
      col: 0,
      row: 0,
      srcX: 0,
      srcY: 0,
      srcW: 64,
      srcH: 32,
      padL: 1,
      padR: 1,
      padT: 0,
      padB: 0,
      texW: 66,
      texH: 32,
    }],
  };
}

const pre = fovSandbox.SpsphereCast.create(bareCanvas());
pre._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
pre._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
pre.manual = true;
pre.setQueue([solidPhoto("preA"), solidPhoto("preB")]);
function pump(session) {
  let guardCount = 0;
  while (session && session.pending && guardCount < 12) {
    const pending = session.pending;
    session.noteChunk({
      type: "chunk",
      id: pending.id,
      token: pending.token,
      i: 0,
      n: 1,
      data: pending.id,
    });
    guardCount += 1;
  }
}
pump(pre.session);
assert(pre._tileDraw.length === 1 && pre._tileDraw[0].tex.label === "preA-c0", "A is on screen");
assert(pre._standby && pre._standby.pending, "the next photo is requested while A is showing");
pump(pre._standby);
assert(pre._standby.shown === true, "B is decoded before the switch");
assert(pre._tileDraw[0].tex.label === "preA-c0", "preloading B does not change the picture");
pre.next();
assert(typeof pre._fullFrameMs === "number" && pre._fullFrameMs < 100, "preloaded switch took " + pre._fullFrameMs);
assert(pre._tileDraw[0].tex.label === "preB-c0", "the swap shows B");
pre.noteChunk({
  type: "chunk",
  id: "preB-c0",
  token: 1,
  i: 0,
  n: 9,
  data: "stale-preload",
});
assert(pre._tileDraw[0].tex.label === "preB-c0", "a stale token does not replace the preloaded photo");

const partialShow = fovSandbox.SpsphereCast.create(bareCanvas());
partialShow._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
partialShow._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
partialShow.manual = true;
const second = {
  id: "preD",
  url: "http://phone/preD.jpg",
  width: 128,
  height: 32,
  tiles: [0, 1].map(function (col) {
    return {
      id: "preD-c" + col,
      col: col,
      row: 0,
      srcX: col * 64,
      srcY: 0,
      srcW: 64,
      srcH: 32,
      padL: 1,
      padR: 1,
      padT: 0,
      padB: 0,
      texW: 66,
      texH: 32,
    };
  }),
};
partialShow.setQueue([solidPhoto("preC"), second]);
pump(partialShow.session);
assert(partialShow._standby && partialShow._standby.pending, "D starts in the background");
const firstPiece = partialShow._standby.pending;
partialShow._standby.noteChunk({
  type: "chunk",
  id: firstPiece.id,
  token: firstPiece.token,
  i: 0,
  n: 1,
  data: firstPiece.id,
});
assert(partialShow._standby.pending && partialShow._standby.pending.id === "preD-c1", "the other opening strip is requested before the swap");
assert(partialShow._standby.loaded.length === 1, "the front strip is the one that preloaded");
partialShow.next();
assert(partialShow.index === 1, "next advances while D is still loading");
assert(partialShow.frameCover().black === false, "an unfinished next is not a black frame");
assert(partialShow.frameGaps().misses === 0, "the low-res sphere covers the unfinished next");
const inflight = partialShow.session && partialShow.session.pending;
assert(inflight && inflight.id === "preD-c1", "the other hemisphere is requested once the photo is showing");
partialShow.noteChunk({
  type: "chunk",
  id: inflight.id,
  token: inflight.token,
  i: 0,
  n: 1,
  data: inflight.id,
});
assert(partialShow.index === 1, "D stays selected once both tiles are resident");
assert(partialShow.session.loaded.length === 2, "the in-flight preload chunk is not discarded");
assert(partialShow.session.shown === true, "D finishes after the skip");
assert(partialShow._tileDraw.length === 2, "the swap draws every tile of D");
assert(partialShow._tileDraw.every(function (piece) {
  return piece.tex && piece.tex._mip === true && piece.tex.label.indexOf("preD-") === 0;
}), "D's mipmapped tiles replace C");

const alphas = Cast.compositeAlphas;
assert(alphas(0, true, true).oldAlpha === 1 && alphas(0, true, true).newAlpha === 0, "the fade starts on the old photo");
assert(alphas(0, true, true).oldAlpha !== 0 || alphas(0, true, true).newAlpha !== 0, "the fade is never a black frame");
assert(alphas(Cast.TILE_FADE_MS / 2, true, true).oldAlpha === 1, "the old photo stays opaque under the fade");
assert(Math.abs(alphas(Cast.TILE_FADE_MS / 2, true, true).newAlpha - 0.5) < 1e-9, "the new photo fades in");
assert(alphas(Cast.TILE_FADE_MS, true, true).newAlpha === 1, "the fade ends on the new photo");
assert(alphas(0, false, false).clear === false, "an empty frame does not clear a picture that is already up");

const spin = fovSandbox.SpsphereCast.create(bareCanvas());
spin.items = ["a", "b"];
spin.playing = true;
spin.manual = false;
spin.speed = 9;
spin._panBlend = 1;
spin.yaw = 0;
spin._pumpFrame(16);
const yawStep = 9 * 16 / 1000;
assert(Math.abs(spin.yaw - yawStep) < 1e-6, "yaw advances with the frame dt, got " + spin.yaw);
const yawAfter = spin.yaw;
spin._pumpFrame(16);
assert(Math.abs((spin.yaw - yawAfter) - yawStep) < 1e-6, "equal frames take equal yaw steps");
const beforeSpike = spin.yaw;
spin._pumpFrame(40);
const spike = spin.yaw - beforeSpike;
const rawSpike = 9 * 40 / 1000;
assert(spike > yawStep && spike < rawSpike, "a long frame is smoothed instead of hitching, got " + spike);
let catchup = 0;
for (let i = 0; i < 30; i++) {
  spin._pumpFrame(16);
  catchup += 16;
}
const expected = beforeSpike + rawSpike + 9 * catchup / 1000;
assert(Math.abs(spin.yaw - expected) < 0.05, "smoothed frames still land on the timestamp, got " + spin.yaw + " vs " + expected);
const parkedYaw = spin.yaw;
spin._pumpFrame(0);
assert(spin.yaw === parkedYaw, "a zero-length frame does not move yaw");
assert(spin.pitch === 0 && spin._vp === 0, "a settled spring does not disturb auto-pan");

const paced = fovSandbox.SpsphereCast.create(bareCanvas());
let pacedUploads = 0;
paced._uploadTile = function (img) {
  pacedUploads += 1;
  return { label: img.label, bytes: 4, _mip: true };
};
paced._enqueueUpload({ label: "t0", _deferUpload: true }, { id: "t0" }, false, function () {});
paced._enqueueUpload({ label: "t1", _deferUpload: true }, { id: "t1" }, false, function () {});
paced._pumpFrame(16);
assert(pacedUploads === 1, "one frame uploads one tile, got " + pacedUploads);
assert(paced._maxUploadsPerFrame <= 1, "upload pacing stays at one");
paced._pumpFrame(16);
assert(pacedUploads === 2, "the next frame takes the queued tile");

function twoTile(id) {
  return {
    id: id,
    url: "http://phone/" + id + ".jpg",
    width: 128,
    height: 32,
    tiles: [0, 1].map(function (col) {
      return {
        id: id + "-c" + col,
        col: col,
        row: 0,
        srcX: col * 64,
        srcY: 0,
        srcW: 64,
        srcH: 32,
        padL: 1,
        padR: 1,
        padT: 0,
        padB: 0,
        texW: 66,
        texH: 32,
      };
    }),
  };
}

const capBox = { holdBack: true };
const capSession = Cast.createSession({
  request: function () {},
  materialize: function (payload, done) { done(null, { label: payload }); },
  upload: function (img) {
    if (String(img.label).indexOf("-c1") >= 0 && capBox.holdBack) {
      return { deferred: true, _evicted: true, bytes: 1 };
    }
    return { label: img.label, bytes: 4, _mip: true };
  },
  release: function () {},
});
capSession.preload(twoTile("cap"));
deliver(capSession, "cap-c0", "cap-c0");
assert(capSession.orderPos === 1, "the first standby tile is kept");
assert(capSession.pending && capSession.pending.id === "cap-c1", "the second tile is the one that may not fit");
deliver(capSession, "cap-c1", "cap-c1");
assert(capSession.budgetFull === true, "a tile that does not fit stops the standby preload");
assert(capSession.orderPos === 1, "the deferred tile is retried instead of skipped");
assert(!capSession.loaded.some(function (piece) {
  return piece.tex && (piece.tex.deferred || piece.tex._evicted);
}), "a placeholder is not part of the standby set");
capBox.holdBack = false;
capSession.resume();
assert(capSession.pending && capSession.pending.id === "cap-c1", "resume asks for the tile that was deferred");
deliver(capSession, "cap-c1", "cap-c1");
assert(Cast.sessionReady(capSession), "the retried tile completes the set");

const hold = fovSandbox.SpsphereCast.create(bareCanvas());
hold._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
hold._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
hold.manual = true;
hold.setQueue([solidPhoto("holdA"), twoTile("holdB")]);
pump(hold.session);
const firstHold = hold._standby.pending;
hold._standby.noteChunk({ type: "chunk", id: firstHold.id, token: firstHold.token, i: 0, n: 1, data: firstHold.id });
hold._standby.budgetFull = true;
hold._standby.pending = null;
hold._gpuBytes = 180 * 1024 * 1024;
const shownTex = hold._tileDraw[0].tex;
hold._resident = [{ tex: shownTex, bytes: hold._gpuBytes, u: 0.5, v: 0.5 }];
const deleted = [];
const realDelete = hold._deleteTex.bind(hold);
hold._deleteTex = function (tex) {
  deleted.push(tex && tex.label);
  realDelete(tex);
};
hold.next();
assert(hold._holdFrame === false, "next cancels the GPU hold");
assert(hold.index === 1, "next leaves the full-GPU photo immediately");
assert(hold.frameCover().black === false, "leaving a full GPU is not a black frame");
assert(hold.frameGaps().misses === 0, "the low-res sphere covers a next that is still short a tile");
const resumed = hold.session && hold.session.pending;
assert(resumed && resumed.id === "holdB-c1", "the missing tile is requested on the photo next selected");
hold._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
hold.noteChunk({ type: "chunk", id: resumed.id, token: resumed.token, i: 0, n: 1, data: resumed.id });
assert(hold.index === 1, "the photo next selected stays put when its last tile arrives");
assert(hold._tileDraw.length === 2, "the sharp tiles replace the overview once they fit");

const fadeLife = fovSandbox.SpsphereCast.create(bareCanvas());
const released = [];
fadeLife._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
fadeLife._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
fadeLife._deleteTex = function (tex) { released.push(tex && tex.label); };
fadeLife.manual = true;
fadeLife.setQueue([solidPhoto("fadeA"), solidPhoto("fadeB")]);
pump(fadeLife.session);
pump(fadeLife._standby);
fadeLife._gpuBytes = Cast.GPU_CAP + 1;
fadeLife.next();
assert(!fadeLife._switchLog.some(function (entry) { return entry.path === "snapshot"; }), "a full GPU does not copy a black snapshot");
assert(fadeLife._fading === true, "the previous photo crossfades under the next one");
assert(fadeLife._fadeFrom && fadeLife._fadeFrom[0].tex.label === "fadeA-c0", "the old tiles stay up during the crossfade");
assert(released.indexOf("fadeA-c0") < 0, "old textures stay until the crossfade ends");
assert(fadeLife._snapOn === false, "the swap does not cover the new photo with a snapshot");
assert(fadeLife._tileDraw[0].tex.label === "fadeB-c0", "the new photo is drawn on top");
assert(fadeLife._fadeLimit === Cast.CROSSFADE_MS, "the overlap is about 1.2s");
assert(fadeLife.frameCover().black === false, "the crossfade is not a black frame");
fadeLife._pumpFrame(600);
const mid = Cast.compositeAlphas(fadeLife._fadeMs, true, true, fadeLife._fadeLimit);
assert(mid.oldAlpha === 1 && Math.abs(mid.newAlpha - 0.5) < 0.02, "halfway, the old photo is still opaque and the new one is half in");
assert(fadeLife._fading === true, "the fade is still running at 600ms");
fadeLife._pumpFrame(700);
assert(fadeLife._fading === false, "the fade ends after about 1.2s");
assert(released.indexOf("fadeA-c0") >= 0, "old textures are released when the crossfade ends");
assert(fadeLife._tileDraw[0].tex.label === "fadeB-c0", "the new photo is the one left on screen");

function mulberry32(seed) {
  let value = seed >>> 0;
  return function () {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertOnePhoto(player, what) {
  function check(list, name) {
    if (!list || !list.length) return;
    const photos = {};
    list.forEach(function (piece) {
      const label = piece.tex && piece.tex.label || "";
      const photoId = label.replace(/-c\d+$/, "");
      photos[photoId] = (photos[photoId] || 0) + 1;
    });
    const keys = Object.keys(photos);
    assert(keys.length === 1, what + " " + name + " mixed " + keys.join(","));
    const entry = player.entries.filter(function (item) { return item.id === keys[0]; })[0];
    if (entry && photos[keys[0]] === entry.tiles.length) return;
    const gaps = player.frameGaps();
    const base = player._bases && player._bases[keys[0]];
    assert(base && base.tex && !base.tex._evicted, what + " " + name + " is a partial set with no overview");
    assert(gaps.misses === 0, what + " " + name + " partial set left a hole " + gaps.first);
  }
  check(player._tileDraw, "draw");
  check(player._fadeFrom, "fade");
  const covered = player.frameGaps();
  assert(covered.misses === 0, what + " uncovered " + covered.first);
}

function deliverPending(session) {
  if (!session || !session.pending) return false;
  const pending = session.pending;
  session.noteChunk({
    type: "chunk",
    id: pending.id,
    token: pending.token,
    i: 0,
    n: 1,
    data: pending.id,
  });
  return true;
}

for (let seed = 1; seed <= 40; seed++) {
  const rand = mulberry32(seed);
  const fuzz = fovSandbox.SpsphereCast.create(bareCanvas());
  fuzz._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
  fuzz._uploadTile = function (img) { return { label: img.label, bytes: 32, _mip: true }; };
  fuzz.manual = true;
  const photos = [0, 1, 2].map(function (n) { return twoTile("s" + seed + "p" + n); });
  fuzz.setQueue(photos);
  pump(fuzz.session);
  for (let step = 0; step < 24; step++) {
    const roll = rand();
    if (roll < 0.34) deliverPending(fuzz._standby) || deliverPending(fuzz._back) || deliverPending(fuzz.session);
    else if (roll < 0.55) fuzz.next();
    else if (roll < 0.7) fuzz.previous();
    else if (roll < 0.85) fuzz._pumpFrame(8 + rand() * 40);
    else if (fuzz.session && fuzz.session.entry) {
      fuzz.noteChunk({
        type: "chunk",
        id: fuzz.session.entry.tiles[0].id,
        token: 1,
        i: 0,
        n: 9,
        data: "stale-" + seed,
      });
    }
    assertOnePhoto(fuzz, "seed " + seed + " step " + step);
    assert(fuzz._maxUploadsPerFrame <= 1, "fuzz upload pacing");
  }
  for (let step = 0; step < 16; step++) {
    deliverPending(fuzz.session);
    deliverPending(fuzz._standby);
    deliverPending(fuzz._back);
    if (fuzz.index < photos.length - 1) fuzz.next();
    assertOnePhoto(fuzz, "seed " + seed + " flush " + step);
  }
  assert(fuzz.index === photos.length - 1, "seed " + seed + " stayed on photo " + fuzz.index);
  assert(fuzz._tileDraw.length === 2, "seed " + seed + " did not finish on a full photo");
}

const autoWait = fovSandbox.SpsphereCast.create(bareCanvas());
autoWait._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
autoWait._uploadTile = function (img) { return { label: img.label, bytes: 32, _mip: true }; };
autoWait.manual = true;
autoWait.setQueue([twoTile("autoA"), twoTile("autoB")]);
pump(autoWait.session);
autoWait.manual = false;
autoWait.playing = true;
autoWait.itemDegrees = Cast.ROTATIONS * 360 - 0.01;
const yawBefore = autoWait.yaw;
autoWait._pumpFrame(16);
assert(autoWait.index === 0, "auto-advance waits until the opening strip is in");
assert(autoWait._tileDraw[0].tex.label.indexOf("autoA") === 0, "the old photo keeps drawing");
assert(autoWait.itemDegrees >= Cast.ROTATIONS * 360, "the turn timer is not restarted while waiting");
assert(autoWait.yaw !== yawBefore, "yaw keeps moving while the next photo loads");
const autoFirst = autoWait._standby.pending;
autoWait._standby.noteChunk({
  type: "chunk",
  id: autoFirst.id,
  token: autoFirst.token,
  i: 0,
  n: 1,
  data: autoFirst.id,
});
assert(autoWait.index === 1, "auto-advance commits once the opening strip covers the view");
assert(autoWait.frameCover().black === false, "the swap is not a black frame");
assert(autoWait._tileDraw.some(function (piece) {
  return piece.tex && piece.tex.label.indexOf("autoB") === 0;
}), "the next photo is on screen");
assert(autoWait.phase === "pan", "a tile swap does not freeze yaw in the slideshow fade");
const autoRest = autoWait.session && autoWait.session.pending;
assert(autoRest && autoRest.id === "autoB-c1", "the other strip is still requested after the swap");
autoWait.noteChunk({
  type: "chunk",
  id: autoRest.id,
  token: autoRest.token,
  i: 0,
  n: 1,
  data: autoRest.id,
});
assert(autoWait.index === 1, "the new photo stays once the second strip arrives");
assert(autoWait._tileDraw.length === 2, "auto-advance shows the full next photo");

const aimPan = fovSandbox.SpsphereCast.create(bareCanvas());
aimPan.items = ["a", "b"];
aimPan.playing = true;
aimPan.manual = false;
aimPan.yaw = 40;
aimPan.applyAim({ seq: 1, yaw: 10, pitch: 5, roll: 0, fov: 70, anchor: false });
assert(aimPan.manual === false && aimPan.yaw === 40, "auto-pan ignores an unanchored pose");
assert(aimPan._ignoredAim === 1, "the ignored pose is counted");
aimPan.applyAim({ seq: 2, yaw: 12, pitch: 1, roll: 0, fov: 70, anchor: true });
assert(aimPan.manual === true, "an anchored hold still takes the camera");

const lowCap = fovSandbox.SpsphereCast.create(bareCanvas());
lowCap._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
lowCap._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
lowCap.manual = true;
lowCap.setQueue([solidPhoto("lowA"), twoTile("lowB")]);
pump(lowCap.session);
const lowFirst = lowCap._standby.pending;
lowCap._standby.noteChunk({ type: "chunk", id: lowFirst.id, token: lowFirst.token, i: 0, n: 1, data: lowFirst.id });
lowCap._standby.budgetFull = true;
lowCap._standby.pending = null;
lowCap._gpuBytes = 64 * 1024 * 1024;
lowCap.next();
assert(lowCap.index === 1, "next does not wait for the rest of a short preload");
assert(lowCap._holdFrame === false, "next cancels the preload hold");
assert(lowCap.frameCover().black === false, "the wait for the rest of the photo is not black");
assert(lowCap.frameGaps().misses === 0, "a short preload still covers the sphere");
const lowRest = lowCap.session && lowCap.session.pending;
assert(lowRest && lowRest.id === "lowB-c1", "the missing tile is requested for the photo next selected");
lowCap.noteChunk({ type: "chunk", id: lowRest.id, token: lowRest.token, i: 0, n: 1, data: lowRest.id });
assert(lowCap.index === 1, "the new photo stays once it can draw");
assert(lowCap.frameCover().black === false, "the switch itself is not a black frame");
lowCap._pumpFrame(lowCap._snapFadeMs);
assert(lowCap._snapOn === false, "the low-cap fade completes");

const pacedDepth = fovSandbox.SpsphereCast.create(bareCanvas());
pacedDepth._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
pacedDepth._uploadTile = function (img) { return { label: img.label, bytes: 32, _mip: true }; };
pacedDepth.setPace(1);
pacedDepth.manual = true;
pacedDepth.setQueue([twoTile("paceA"), twoTile("paceB")]);
pump(pacedDepth.session);
assert(pacedDepth._standby && pacedDepth._standby.pending, "the next photo starts while the current one is showing");
pump(pacedDepth._standby);
assert(pacedDepth._standby.loaded.length >= 1, "the view-first tile preloads during the current photo");
assert(!pacedDepth._standby.pending, "the other hemisphere waits so it does not compete with the photo on screen");

const gone = fovSandbox.SpsphereCast.create(bareCanvas());
gone._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
gone._uploadTile = function (img) { return { label: img.label, bytes: 64, _mip: true }; };
gone.manual = true;
gone.setQueue([solidPhoto("memA")]);
pump(gone.session);
const residentTex = { id: "memA-c0" };
gone._gpuBytes = 4096;
gone._resident.push({ id: "memA-c0", tex: residentTex, bytes: 4096, u: 0.5, v: 0.5 });
gone._tileDraw = [{ tex: residentTex, tile: solidPhoto("memA").tiles[0] }];
gone._uploadQueue.push({ img: { label: "pending" }, tile: { id: "q" }, done: function () {} });
gone._decodeQueue.push({ payload: "decoded", done: function () {} });
gone._snapOn = true;
gone._snapTex = { id: "snap" };
fovSandbox.SpsphereCast.trackUrl("blob:photo");
const beforeStop = gone.memoryUsage();
assert(beforeStop.gpuBytes > 0 && beforeStop.textures === 2 && beforeStop.objectUrls === 1, "a shown photo keeps the overview and its tile");
assert(beforeStop.pendingUploads === 1 && beforeStop.pendingDecodes === 1 && beforeStop.snap === true, "queues and the snapshot are resident");
gone.onSenderGone("sender-disconnected");
const afterStop = gone.memoryUsage();
assert(Cast.memoryCleared(afterStop), "disconnect frees textures, got " + JSON.stringify(afterStop));
assert(gone._snapTex == null && gone._snapOn === false, "the snapshot texture is dropped");
assert(!gone.session.entry && !gone._standby && !gone.session.pending, "the tile session is dropped");
gone._senderSeen = true;
gone._lastSender = Date.now() - Cast.SENDER_TIMEOUT_MS - 5;
assert(gone.senderTimedOut(Date.now()) === true, "a missed heartbeat is a sender timeout");
gone.setQueue([solidPhoto("memB")]);
pump(gone.session);
gone._gpuBytes = 2048;
gone._resident.push({ id: "memB-c0", tex: { id: "memB-c0" }, bytes: 2048, u: 0.5, v: 0.5 });
gone._snapTex = { id: "snap2" };
const beforeRecast = gone.memoryUsage();
gone.onSenderGone("sender-disconnected");
const afterRecast = gone.memoryUsage();
assert(beforeRecast.gpuBytes > 0 && beforeRecast.snap === true, "a recast allocates photo memory again");
assert(Cast.memoryCleared(afterRecast), "stopping the recast returns to baseline, got " + JSON.stringify(afterRecast));

const front = { srcX: 0, srcY: 0, srcW: 100, srcH: 50, id: "front" };
const back = { srcX: 100, srcY: 0, srcW: 100, srcH: 50, id: "back" };
const viewLook = { u: 0.1, v: 0.5, halfU: 0.08, halfV: 0.2 };
assert(Cast.tileInView(front, 200, 50, viewLook) === true, "the tile in front of the camera is drawn");
assert(Cast.tileInView(back, 200, 50, viewLook) === false, "the tile behind the camera is skipped");

function sphereGrid(cols, rows) {
  const tiles = [];
  const width = cols * 100;
  const height = rows * 50;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.push({
        id: "p" + row + "-" + col,
        srcX: col * 100,
        srcY: row * 50,
        srcW: 100,
        srcH: 50,
      });
    }
  }
  return { tiles, width, height };
}

const poles = sphereGrid(4, 2);
for (const yaw of [0, 90, 180, 270]) {
  for (const pitch of [89.9, -89.9]) {
    for (const fov of [30, 120]) {
      const view = { yaw, pitch, roll: 0, fov, aspect: 16 / 9 };
      for (const tile of poles.tiles) {
        const north = tile.srcY === 0;
        const south = tile.srcY + tile.srcH === poles.height;
        if (pitch > 0 && !north) continue;
        if (pitch < 0 && !south) continue;
        assert(
          Cast.tileInView(tile, poles.width, poles.height, view) === true,
          "pole tile " + tile.id + " stays drawn at yaw " + yaw + " pitch " + pitch + " fov " + fov,
        );
      }
    }
  }
}

const pitches = [-89.9, -85, -60, -30, 0, 30, 60, 85, 89.9];
const yaws = [];
for (let yaw = 0; yaw < 360; yaw += 30) yaws.push(yaw);
for (const fov of [30, 120]) {
  for (const pitch of pitches) {
    for (const yaw of yaws) {
      const sweep = Cast.coverageMisses(poles.tiles, poles.width, poles.height, yaw, pitch, fov, 16 / 9);
      assert(sweep.misses === 0, "uncovered view " + sweep.first + " (" + sweep.misses + ")");
    }
  }
}

const pitchPlayer = Cast.create(bareCanvas());
pitchPlayer.manual = true;
pitchPlayer._tpitch = -90;
for (let i = 0; i < 30; i++) pitchPlayer._ease(100);
assert(pitchPlayer.pitch <= -89.5 && pitchPlayer.pitch >= -Cast.PITCH_LIMIT - 0.01, "pitch reaches straight down, got " + pitchPlayer.pitch);
pitchPlayer._tpitch = 90;
for (let i = 0; i < 30; i++) pitchPlayer._ease(100);
assert(pitchPlayer.pitch >= 89.5 && pitchPlayer.pitch <= Cast.PITCH_LIMIT + 0.01, "pitch reaches straight up, got " + pitchPlayer.pitch);

const keptPole = Cast.create(bareCanvas());
keptPole.yaw = 180;
keptPole.pitch = 89.9;
keptPole.fov = 30;
const poleTile = { id: "zenith", srcX: 0, srcY: 0, srcW: 100, srcH: 50 };
keptPole._resident = [{
  id: "zenith",
  tex: {},
  bytes: 64,
  u: 0.125,
  v: 0.125,
  tile: poleTile,
  spanW: 400,
  spanH: 100,
}];
keptPole._gpuBytes = 64;
assert(keptPole._evictDistant(keptPole._lodView()) === false, "a visible pole tile is not evicted");
assert(keptPole._resident.length === 1, "the pole tile stays resident");
const patch = Cast.tilePatch(front, 200, 50);
const full = Cast.sphere(128, 256, true);
assert(patch.count < full.count / 10, "a tile patch is much smaller than the full sphere, " + patch.count + " vs " + full.count);

const steady = Cast.paceDt(0, 0, 16);
assert(steady.step === 16, "the first steady frame uses its own dt");
const again = Cast.paceDt(steady.ema, steady.debt, 16);
assert(again.step === 16, "a steady dt is not smoothed away");

const slow = fovSandbox.SpsphereCast.create(bareCanvas());
slow._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
slow._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
slow.manual = true;
slow.setQueue([twoTile("slowA"), twoTile("slowB")]);
pump(slow.session);
assert(slow.frameCover().black === false, "the photo on screen is a real frame");
slow._uploadDelayMs = 5000;
slow.manual = false;
slow.playing = true;
slow.itemDegrees = Cast.ROTATIONS * 360 - 0.01;
let slowBlack = 0;
let slowHeld = true;
for (let t = 0; t < 12000; t += 16) {
  const waiting = slow._standby && slow._standby.pending;
  if (waiting) {
    slow.noteChunk({
      type: "chunk",
      id: waiting.id,
      token: waiting.token,
      i: 0,
      n: 1,
      data: waiting.id,
    });
  }
  slow._pumpFrame(16);
  if (slow.frameCover().black) slowBlack += 1;
  if (t < 4500 && slow.index !== 0) slowHeld = false;
}
assert(slowBlack === 0, "a 5s upload throttle produced " + slowBlack + " black frames");
assert(slowHeld, "the old photo stays up while the next upload is still throttled");
assert(slow._switchLog.some(function (entry) { return entry.path === "advance" || entry.path === "preload"; }), "the advance logs why the next photo was not ready");
assert(slow.index === 1, "the show advances once the throttled upload can draw");
assert(slow.frameCover().source === "tiles", "the new photo is drawable");
assert((slow._blackFrames || 0) === 0, "no frame was cleared to black during the throttled switch");
assert(typeof slow._fullFrameMs === "number", "advance-to-frame time is recorded");

assert(Cast.panLookaheadDeg(18, 1500) >= 18 * 1.5 * 2, "lookahead is at least speed x latency x 2");
assert(Cast.panLookaheadDeg(18, 1500) >= 18 * 3, "fast speed keeps several seconds of pan queued");
const aheadOrder = Cast.tileLoadOrder(wideTiles("ord", 8, 1000).tiles, 8000, 1000, {
  u: 0.5, v: 0.5, halfU: 0.04, halfV: 0.08, yaw: 0, pitch: 0, fov: 20, aspect: 16 / 9,
  lookaheadDeg: 54, panSign: 1,
});
assert(aheadOrder.indexOf(5) < aheadOrder.indexOf(1), "tiles ahead of the pan are requested before tiles behind, got " + aheadOrder.join(","));

const behindTile = { id: "behind", srcX: 0, srcY: 0, srcW: 100, srcH: 50 };
const behindTex = { id: "behind" };
const aheadTile = { id: "ahead", srcX: 200, srcY: 0, srcW: 100, srcH: 50 };
const aheadTex = { id: "ahead" };
const offscreen = Cast.create(bareCanvas());
offscreen.yaw = 0;
offscreen.pitch = 0;
offscreen.fov = 30;
offscreen._tileW = 400;
offscreen._tileH = 100;
offscreen._resident = [
  { tex: aheadTex, bytes: 64, u: 0.625, v: 0.25, tile: aheadTile, spanW: 400, spanH: 100 },
  { tex: behindTex, bytes: 64, u: 0.125, v: 0.25, tile: behindTile, spanW: 400, spanH: 100 },
];
offscreen._tileDraw = [];
offscreen._gpuBytes = Cast.GPU_CAP + 128;
assert(offscreen._evictDistant(offscreen._lodView()) === true, "auto-pan frees a strip behind the camera when a new upload needs the room");
assert(behindTex._evicted === true, "the freed tile is the one behind the pan");
assert(aheadTex._evicted !== true, "a tile ahead of the pan stays resident");
const steered = Cast.create(bareCanvas());
steered.yaw = 180;
steered.pitch = 40;
steered.fov = 30;
steered.manual = true;
steered._presented = true;
steered._tileW = 400;
steered._tileH = 100;
const keptBehind = { id: "kept-behind" };
steered._resident = [
  { tex: keptBehind, bytes: 64, u: 0.125, v: 0.25, tile: behindTile, spanW: 400, spanH: 100 },
];
steered._gpuBytes = 64;
assert(steered._evictDistant(steered._lodView()) === false, "controller mode does not evict a strip of the current photo");
assert(keptBehind._evicted !== true, "the strip behind the new aim stays resident");
const freedPreload = [];
steered._standby = { dispose: function () { freedPreload.push("standby"); }, entry: { id: "next" } };
steered._back = { dispose: function () { freedPreload.push("back"); } };
steered._uploadQueue = [{ standby: true }, { standby: false, tile: { id: "current" } }];
steered.applyAim({ seq: 1, anchor: true, yaw: 30, pitch: 15, roll: 0, fov: 70 });
assert(steered.manual === true, "aim holds the controller");
assert(steered._standby == null && steered._back == null, "controller mode drops the next-photo preload");
assert(freedPreload.indexOf("standby") >= 0 && freedPreload.indexOf("back") >= 0, "half-loaded next-photo textures are released");
assert(steered._uploadQueue.length === 1 && steered._uploadQueue[0].standby === false, "a current-photo upload stays queued");
steered._tileDraw = [{ tile: { id: "open", row: 0, col: 0 }, tex: { _mip: true }, _focusAt: 40, _revealDone: true }];
steered.applyAim({ seq: 2, yaw: 80, pitch: -20, roll: 0, fov: 70 });
assert(steered._tileDraw[0]._focusAt === 40 && steered._tileDraw[0]._revealDone === true, "looking around does not reset a strip that already opened");
assert(offscreen._resident.some(function (item) { return item.tex === aheadTex; }), "the ahead tile is still in the resident set");
const baseOnly = { id: "base", _base: true };
offscreen._resident = [{ tex: baseOnly, bytes: Cast.BASE_BYTES, u: 0.5, v: 0.5, tile: { _base: true, srcX: 0, srcY: 0, srcW: 400, srcH: 100 }, spanW: 400, spanH: 100, _base: true }];
offscreen._gpuBytes = Cast.BASE_BYTES;
assert(offscreen._evictDistant(offscreen._lodView()) === false, "the full-sphere overview is not evicted");
const nearTile = { id: "near", srcX: 150, srcY: 0, srcW: 100, srcH: 50 };
const nearTex = { id: "near" };
offscreen._resident = [{ tex: nearTex, bytes: 64, u: 0.5, v: 0.25, tile: nearTile, spanW: 400, spanH: 100 }];
offscreen._tileDraw = [{ tex: nearTex, tile: nearTile }];
offscreen._gpuBytes = 64;
assert(offscreen._evictDistant(offscreen._lodView()) === false, "the tile in front of the camera stays through the preload");

const early = fovSandbox.SpsphereCast.create(bareCanvas());
early._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
early._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
early.manual = true;
early.fov = 12;
early.yaw = 22.5;
early.setPace(1);
early.setQueue([solidPhoto("earlyA"), wideTiles("earlyB", 8, 1000)]);
pump(early.session);
assert(early._standby && early._standby.pending, "the next photo starts preloading during the current one");
let earlyGuard = 0;
while (early._standby && !early._standby._viewCovered() && early._standby.pending && earlyGuard < 8) {
  const earlyPending = early._standby.pending;
  early.noteChunk({
    type: "chunk",
    id: earlyPending.id,
    token: earlyPending.token,
    i: 0,
    n: 1,
    data: earlyPending.id,
  });
  earlyGuard += 1;
}
assert(early._standby && early._standby._viewCovered(), "the next photo's view is ready before the rotation ends");
assert(
  early._standby.loaded.length < early.entries[1].tiles.length,
  "tiles outside the view are not required before the switch, got " + early._standby.loaded.length,
);
assert(early.index === 0 && early.frameCover().black === false, "the current photo stays up while the rest is still out");
early.manual = false;
early.playing = true;
early._blackFrames = 0;
early.itemDegrees = Cast.ROTATIONS * 360 - 0.01;
early._pumpFrame(16);
if (early.index === 0) {
  assert(early._standby && early._standby._lookaheadCovered && !early._standby._lookaheadCovered(), "the hold is the lookahead band, not the view");
  let lookGuard = 0;
  while (early.index === 0 && early._standby && lookGuard < 8) {
    const lookPending = early._standby.pending;
    if (!lookPending) break;
    early.noteChunk({ type: "chunk", id: lookPending.id, token: lookPending.token, i: 0, n: 1, data: lookPending.id });
    early._pumpFrame(16);
    lookGuard += 1;
  }
}
assert(early.frameCover().black === false, "crossing to a view-ready photo is not black");
assert((early._blackFrames || 0) === 0, "the switch does not clear the frame");
assert(early.index === 1, "the show crossfades once the view and the tiles ahead of it can draw");
assert(early.frameCover().source === "tiles", "the new view is what gets drawn");
assert(
  early._switchLog.some(function (entry) { return entry.path === "advance" || entry.path === "preload" || entry.path === "first-frame"; }),
  "the advance logs why the next photo was or was not preloaded",
);

const lazyShow = fovSandbox.SpsphereCast.create(bareCanvas());
lazyShow._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
lazyShow._uploadTile = function (img) { return { label: img.label, bytes: 64, _mip: true }; };
lazyShow.manual = true;
lazyShow.setQueue([
  solidPhoto("lazyA"),
  { id: "lazyB", url: "http://phone/lazyB.jpg", width: 128, height: 32 },
]);
pump(lazyShow.session);
lazyShow.manual = false;
lazyShow.playing = true;
lazyShow.itemDegrees = Cast.ROTATIONS * 360 - 0.01;
lazyShow._pumpFrame(16);
assert(lazyShow.index === 0, "a photo with no tiles yet does not replace the one on screen");
assert(lazyShow.frameCover().black === false, "waiting for a retile is not a black frame");
assert(
  lazyShow._switchLog.some(function (entry) { return entry.path === "advance" && String(entry.reason).indexOf("next-has-no-tiles") === 0; }),
  "the advance logs that the next photo was not tiled yet",
);
lazyShow.retile("lazyB", twoTile("lazyB"));
let lazyGuard = 0;
while (lazyShow.index === 0 && lazyGuard < 8) {
  const lazyPending = lazyShow._standby && lazyShow._standby.pending;
  if (!lazyPending) break;
  lazyShow.noteChunk({ type: "chunk", id: lazyPending.id, token: lazyPending.token, i: 0, n: 1, data: lazyPending.id });
  lazyShow._pumpFrame(16);
  lazyGuard += 1;
}
assert(lazyShow.index === 1, "retile lets the show advance once the next view can draw");
assert(lazyShow.frameCover().black === false, "the retile swap is not black");
assert(lazyShow.frameCover().source === "tiles", "the retiled photo is drawable");

const fast = fovSandbox.SpsphereCast.create(bareCanvas());
const fastFetches = [];
fovSandbox.__castSend = function (msg) {
  if (msg && msg.type === "fetch") fastFetches.push(msg.id);
};
fast._injectImage = function (payload) { return { label: payload, width: 32, height: 16 }; };
fast._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
fast._uploadDelayMs = 1500;
fast.setSpeed(18);
fast.fov = 75;
fast.manual = false;
const fastGrid = wideTiles("fast", 12, 1000);
fast.setQueue([fastGrid]);
assert(fast._bases && fast._bases.fast && fast._bases.fast.tex._bytes === Cast.BASE_BYTES, "the overview is charged at 64x32, not as a level-0 tile");
assert(fast._gpuBytes === Cast.BASE_BYTES, "level 0 has not been uploaded yet, gpu " + fast._gpuBytes);
assert(fast._lookaheadDeg() >= 54, "fast pan looks at least 54° ahead at 1.5s, got " + fast._lookaheadDeg());
const fastSeen = {};
let fastMisses = 0;
let fastWhere = "";
for (let t = 0; t < 8000; t += 16) {
  const session = fast.session;
  if (session && session.assemblers) {
    Object.keys(session.assemblers).forEach(function (id) {
      const box = session.assemblers[id];
      if (!box || fastSeen[id]) return;
      fastSeen[id] = true;
      session.noteChunk({ type: "chunk", id: id, token: box.token, i: 0, n: 1, data: id });
    });
  }
  fast._pumpFrame(16);
  const gaps = fast.frameGaps();
  if (gaps.misses) {
    fastMisses += gaps.misses;
    fastWhere = gaps.first + " t=" + t;
    break;
  }
}
assert(fastMisses === 0, "fast pan with a 1.5s upload left a hole: " + fastWhere);
assert(fast._uploadLatencyMs >= 1400 && fast._uploadLatencyMs <= 2200, "slow-path upload latency was " + fast._uploadLatencyMs);
const fastStartU = Cast.viewCenterUv(Cast.startingYawForEntry(fastGrid), 0).u;
const fastViewCol = Cast.columnAtU(fastGrid.tiles, fastGrid.width, fastStartU);
function fastDelta(id) {
  const col = Number(String(id).split("-c")[1]);
  let delta = col - fastViewCol;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return delta;
}
const fastAhead = fastFetches.findIndex(function (id) { return fastDelta(id) > 0; });
const fastBehind = fastFetches.findIndex(function (id) { return fastDelta(id) < 0; });
assert(fastAhead >= 0 && (fastBehind < 0 || fastAhead < fastBehind), "an ahead tile is requested before the tile behind the camera, fetches " + fastFetches.join(","));
assert(fast.frameCover().black === false, "the throttled pan is never a black frame");
assert(fast.frameCover().source === "tiles", "the overview counts as a covered frame");

const skips = fovSandbox.SpsphereCast.create(bareCanvas());
skips._injectImage = function (payload) { return { label: payload, width: 32, height: 16 }; };
skips._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
skips.manual = true;
skips.setQueue([
  solidPhoto("skipA"),
  wideTiles("skipB", 8, 1000),
  solidPhoto("skipC"),
  solidPhoto("skipD"),
]);
pump(skips.session);
assert(skips.index === 0 && skips._standby && skips._standby.pending, "the next photo is preloading");
skips.next();
assert(skips.index === 1, "next during preload advances immediately, index " + skips.index);
assert(skips._awaitingSwap === false, "next cancels the preload hold");
assert(skips.frameGaps().misses === 0, "the skipped-to photo is covered before its sharp tiles: " + skips.frameGaps().first);
assert(skips.frameCover().black === false, "next during preload is not black");
assert(skips._bases.skipB && skips._bases.skipB.tex && !skips._bases.skipB.tex._evicted, "the new photo has its low-res sphere");
skips.next();
skips.next();
assert(skips.index === 3, "three rapid next taps land on the latest photo, index " + skips.index);
assert(skips.frameGaps().misses === 0, "rapid next never uncovers the frame");
skips.previous();
assert(skips.index === 2, "previous steps back from the coalesced target, index " + skips.index);

const holdSkip = fovSandbox.SpsphereCast.create(bareCanvas());
holdSkip._injectImage = function (payload) { return { label: payload, width: 32, height: 16 }; };
holdSkip._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
holdSkip.manual = true;
holdSkip.setQueue([solidPhoto("heldA"), wideTiles("heldB", 8, 1000), solidPhoto("heldC")]);
pump(holdSkip.session);
holdSkip.manual = false;
holdSkip.playing = true;
holdSkip.itemDegrees = Cast.ROTATIONS * 360 - 0.01;
holdSkip._pumpFrame(16);
assert(holdSkip.index === 0 && holdSkip._awaitingSwap === true, "auto-advance holds while the next lookahead is not ready");
const heldGaps = holdSkip.frameGaps();
assert(heldGaps.misses === 0, "the photo that keeps panning has no hole: " + heldGaps.first);
holdSkip.next();
assert(holdSkip.index === 1, "next during a view-ready hold still advances, index " + holdSkip.index);
assert(holdSkip._awaitingSwap === false, "the manual skip clears the hold");
assert(holdSkip.itemDegrees === 0, "the new photo restarts its pan clock");
assert(holdSkip.frameGaps().misses === 0, "the hold-skip is covered by the low-res sphere");
holdSkip.previous();
assert(holdSkip.index === 0, "previous during that show steps back immediately, index " + holdSkip.index);
assert(holdSkip.frameCover().black === false, "previous is not a black frame");
holdSkip.previous();
assert(holdSkip.index === 2, "previous wraps to the latest target instead of sticking, index " + holdSkip.index);
assert(holdSkip.frameGaps().misses === 0, "wrapped previous stays covered");

assert(Cast.acceptCastMessage("{") === null, "malformed JSON is dropped");
assert(Cast.acceptCastMessage("x".repeat(3 * 1024 * 1024)) === null, "an oversized string is dropped");
assert(Cast.acceptCastMessage('{"type":"nope"}') === null, "an unknown type is dropped");
assert(Cast.acceptCastMessage('{"type":"play"}').type === "play", "play is accepted");
assert(Cast.acceptCastMessage('{"type":"heartbeat"}').type === "heartbeat", "heartbeat is accepted");
const poisoned = Cast.acceptCastMessage('{"type":"queue","ws":"javascript:alert(1)","items":[]}');
assert(poisoned === null, "a javascript aim socket rejects the message");
const aimed = Cast.acceptCastMessage('{"type":"queue","ws":"ws://192.168.1.8:5000/c/0123456789abcdef0123456789abcdef/aim","items":[]}');
assert(aimed && aimed.ws.indexOf("ws://192.168.1.8") === 0, "a LAN aim socket is kept");
assert(Cast.acceptAimSocket("ws://evil.example/c/0123456789abcdef0123456789abcdef/aim") === "", "a public host is not an aim socket");
assert(Cast.acceptAimSocket("http://192.168.1.8:5000/c/0123456789abcdef0123456789abcdef/aim") === "", "http is not an aim socket");
const many = [];
for (let i = 0; i < 80; i++) many.push({ id: "n" + i, url: "http://phone/" + i + ".jpg" });
const cappedQueue = Cast.acceptCastMessage({ type: "queue", items: many });
assert(cappedQueue.items.length === 40, "a queue is capped at 40 items");
assert(Cast.httpUrl("javascript:alert(1)") === "", "script URLs are not photos");
assert(Cast.httpUrl("http://phone/a.jpg") === "http://phone/a.jpg", "http photo URLs stay");
const bigBin = new ArrayBuffer(80 * 1024);
assert(Cast.acceptCastMessage(bigBin) === null, "an oversized binary frame is dropped");
const aimBin = new ArrayBuffer(32);
assert(Cast.acceptCastMessage(aimBin) === aimBin, "a small binary frame is kept for aim decode");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const handleAt = html.indexOf("function handle");
const noteAt = html.indexOf("noteSender", handleAt);
const acceptAt = html.indexOf("acceptCastMessage", handleAt);
assert(acceptAt > handleAt && acceptAt < noteAt, "garbage is rejected before the sender timer refreshes");
assert(html.indexOf("_disconnectGrace") > 0, "a sender drop waits instead of stopping the show");
assert(html.indexOf("armSenderGrace") > 0, "a recent phone message does not start the disconnect clock");
assert(html.indexOf('src="logo.png"') > 0, "the loading mark uses the app icon");
assert(html.indexOf('alt=""') > 0, "the loading mark has no text");
assert(Cast.armSenderGrace(0, 1000, 2000, 1, Cast.SENDER_TIMEOUT_MS) === 0, "a sender that is still connected does not arm the grace");
assert(Cast.armSenderGrace(0, 1000, 2000, 0, Cast.SENDER_TIMEOUT_MS) === 0, "a message inside the silence window does not arm the grace");
assert(Cast.armSenderGrace(0, 1000, 1000 + Cast.SENDER_TIMEOUT_MS, 0, Cast.SENDER_TIMEOUT_MS) === 1000 + Cast.SENDER_TIMEOUT_MS, "real silence arms the grace");
assert(Cast.armSenderGrace(5000, 1000, 90000, 0, Cast.SENDER_TIMEOUT_MS) === 5000, "the grace clock is not restarted");
assert(Cast.shouldTryLan(true, false, "http://192.168.1.8:9/a.jpg") === true, "a private http tile is loaded over Wi-Fi");
assert(Cast.shouldTryLan(true, false, "http://10.0.0.4/a.jpg") === true, "a 10.x address is private");
assert(Cast.shouldTryLan(true, true, "http://192.168.1.8/a.jpg") === false, "a failed LAN path is not tried again");
assert(Cast.shouldTryLan(false, false, "http://192.168.1.8/a.jpg") === false, "lan false stays on Cast messages");
assert(Cast.shouldTryLan(true, false, "https://192.168.1.8/a.jpg") === false, "https to the phone is not the LAN server");
assert(Cast.shouldTryLan(true, false, "http://example.com/a.jpg") === false, "a public host is not the phone");
assert(html.indexOf("innerHTML") < 0, "the receiver page does not inject HTML");
assert(code.indexOf("innerHTML") < 0, "the player does not inject HTML");
assert(Cast.acceptCastMessage('{"type":"debug","on":true}').on === true, "the debug tint message is accepted");
assert(html.indexOf('msg.type === "debug"') > 0, "the page routes the tint without drawing a label");
assert(html.indexOf(">Tint") < 0 && html.indexOf("textContent") < 0, "the TV page has no tint label");

const rightEdge = Cast.overviewSample(0.98, 64);
const leftEdge = Cast.overviewSample(0.02, 64);
const midSample = Cast.overviewSample(0.5, 64);
assert(rightEdge >= 60, "u near 1 samples the right of the overview, got column " + rightEdge);
assert(leftEdge <= 3, "u near 0 samples the left of the overview, got column " + leftEdge);
assert(midSample > leftEdge && midSample < rightEdge, "the middle of the photo is not the right edge");
assert(Cast.brokenOverviewSample(0.1, 8000, 64) === 63, "the old srcW/texW scale clamped the overview to its right edge");
assert(Cast.brokenOverviewSample(0.98, 8000, 64) === 63, "the old scale made every longitude the same texel");

const bandView = { u: 0.5, v: 0.5, halfU: 0.12, halfV: 0.2, lookaheadDeg: 40, panSign: 1, fov: 75, aspect: 16 / 9, yaw: 0, pitch: 0 };
const bandAhead = { srcX: 5500, srcY: 0, srcW: 500, srcH: 1000 };
const bandBehind = { srcX: 0, srcY: 0, srcW: 500, srcH: 1000 };
const bandFront = { srcX: 4000, srcY: 0, srcW: 500, srcH: 1000 };
assert(Cast.tileInResidentBand(bandFront, 8000, 4000, bandView) === true, "the tile in front stays resident");
assert(Cast.tileInResidentBand(bandAhead, 8000, 4000, bandView) === true, "the lookahead tile stays resident");
assert(Cast.tileInResidentBand(bandBehind, 8000, 4000, bandView) === false, "a tile behind the camera is not kept");

const overviewFirst = fovSandbox.SpsphereCast.create(bareCanvas());
const overviewFetches = [];
fovSandbox.__castSend = function (msg) {
  if (msg && msg.type === "fetch") overviewFetches.push(msg.id);
};
overviewFirst._injectImage = function (payload) {
  return { label: payload, width: 64, height: 32 };
};
overviewFirst.manual = true;
overviewFirst.fov = 75;
const overviewPhoto = wideTiles("cover", 8, 1000);
overviewPhoto.overview = { id: "cover:overview", url: "http://phone/cover-overview.jpg", texW: 64, texH: 32 };
overviewFirst.setQueue([overviewPhoto]);
assert(overviewFetches[0] === "cover:overview", "the overview is still the first request, got " + overviewFetches.join(","));
assert(overviewFetches.length > 1, "front tiles are requested without waiting for the overview, got " + overviewFetches.join(","));
assert(overviewFirst._busy === false, "the show does not sit on the loading spinner");
assert(!overviewFirst._tileDraw || overviewFirst._tileDraw.length === 0, "no sharp tile is drawn before its bytes arrive");
const overviewPending = overviewFirst.session.pending;
assert(overviewPending && overviewPending.id === "cover:overview", "the in-flight request is the overview");
overviewFirst.noteChunk({
  type: "chunk",
  id: overviewPending.id,
  token: overviewPending.token,
  i: 0,
  n: 1,
  data: overviewPending.id,
});
const beforeLevel0 = overviewFirst.frameGaps();
assert(beforeLevel0.misses === 0, "the overview covers the frame before any level-0 tile, " + beforeLevel0.first);
assert(!overviewFirst._tileDraw || overviewFirst._tileDraw.length === 0, "level-0 has not been drawn");
assert(overviewFirst._bases.cover && overviewFirst._bases.cover._photo === true, "the overview texture is the photo, not the gray fill");
assert(overviewFetches.indexOf("cover:overview") === 0, "level-0 is not requested ahead of the overview");
const coverTile = overviewFetches.filter(function (id) { return id.indexOf("cover-c") === 0; })[0];
overviewFirst._uploadTile = function (img) { return { label: img.label, bytes: 256, _mip: true }; };
overviewFirst.noteChunk({
  type: "chunk",
  id: coverTile,
  token: overviewFirst.session.assemblers[coverTile].token,
  i: 0,
  n: 1,
  data: coverTile,
});
assert(overviewFirst._tileDraw.length === 1, "a sharp tile draws as soon as it arrives");
assert(overviewFirst._tileDraw[0]._focusAt > 0, "a live tile pulls focus instead of popping on");
assert(overviewFirst._busy === false, "the spinner stays off once the overview is up");
overviewFirst.setDebugTint(true);
assert(overviewFirst._debugTint === true, "the tint can be turned on");
overviewFirst.setDebugTint(false);
assert(overviewFirst._debugTint === false, "the tint is off again");
assert(!overviewFirst._statusText, "the tint does not put text on the TV");

const focusTile = { srcX: 1000, srcY: 1000, srcW: 1000, srcH: 1000 };
const focusClosed = { left: 0, right: 0, up: 0, down: 0 };
const focusHalf = { left: 0.55, right: 0.55, up: 0.55, down: 0.55 };
const focusOpen = { left: 1, right: 1, up: 1, down: 1 };
const curtain = { anchorV: 0.5 };
assert(Cast.focusMask(0.375, 0.5, focusTile, 4000, 3000, 0, focusClosed, curtain) === 0, "focus starts fully soft");
const focusHorizon = Cast.focusMask(0.375, 0.5, focusTile, 4000, 3000, 0.35, focusOpen, curtain);
const focusPole = Cast.focusMask(0.375, 0.34, focusTile, 4000, 3000, 0.35, focusOpen, curtain);
const focusOtherSide = Cast.focusMask(0.3, 0.5, focusTile, 4000, 3000, 0.35, focusOpen, curtain);
assert(focusHorizon > 0.95, "the horizon is already open once the wave has left the master edge, got " + focusHorizon);
assert(focusPole < 0.08, "the fade has not reached the pole yet, got " + focusPole);
assert(Math.abs(focusOtherSide - focusHorizon) < 0.08, "the same latitude is one horizontal band, got " + focusOtherSide);
assert(Cast.focusMask(0.49, 0.66, focusTile, 4000, 3000, 1, focusOpen, curtain) === 1, "a finished strip is fully sharp, including its corner");
assert(Cast.focusMask(0.375, 0.55, focusTile, 4000, 3000, 1, focusClosed, curtain) > 0.9, "a finished strip stays sharp inside when the next band has not opened");
const fadeSamples = [0, 0.25, 0.5, 0.75, 1].map(function (p) {
  return Cast.revealProgress(1000, 1000 + p * Cast.FOCUS_MS, Cast.FOCUS_MS);
});
assert(fadeSamples[0] === 0, "a tile's fade starts at 0");
assert(fadeSamples[2] > 0.2 && fadeSamples[2] < 0.8, "mid-fade is not stuck at 0 or 1, got " + fadeSamples[2]);
assert(fadeSamples[4] === 1, "a tile's fade ends at 1");
for (let fadeStep = 1; fadeStep < fadeSamples.length; fadeStep++) {
  assert(fadeSamples[fadeStep] > fadeSamples[fadeStep - 1], "fade samples keep moving, got " + fadeSamples.join(","));
}
assert(Cast.shouldStripUpload(256, 128) === false, "the overview uploads in one call");
assert(Cast.shouldStripUpload(512, 512) === false, "a 512px tile uploads in one call");
assert(Cast.shouldStripUpload(4096, 884) === false, "a full 180° strip uploads in one call");
assert(Cast.shouldStripUpload(8192, 512) === true, "a texture wider than 4096 is still sliced");

const gridTiles = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 4; col++) {
    gridTiles.push({
      id: "g" + row + "-" + col,
      row: row,
      col: col,
      srcX: col * 1000,
      srcY: row * 1000,
      srcW: 1000,
      srcH: 1000,
    });
  }
}
function gridAt(row, col) {
  return gridTiles.findIndex(function (tile) { return tile.row === row && tile.col === col; });
}
const horizonView = {
  u: 0.5, v: 0.5, halfU: 0.08, halfV: 0.1, yaw: 0, pitch: 0, fov: 40, aspect: 16 / 9,
  lookaheadDeg: 30, panSign: 1,
};
const horizonOrder = Cast.tileLoadOrder(gridTiles, 4000, 3000, horizonView);
assert(gridTiles[horizonOrder[0]].row === 1 && gridTiles[horizonOrder[0]].col === 1, "the horizon strip under the view is first");
assert(horizonOrder.indexOf(gridAt(1, 2)) < horizonOrder.indexOf(gridAt(1, 0)), "the pan direction comes before the horizon behind");
assert(horizonOrder.indexOf(gridAt(1, 2)) < horizonOrder.indexOf(gridAt(1, 3)), "the nearer pan strip comes before the one past it");
assert(horizonOrder.indexOf(gridAt(0, 1)) < horizonOrder.indexOf(gridAt(1, 0)), "the band on screen comes before the horizon behind the camera");
const upView = {
  u: 0.5, v: 0.08, halfU: 0.2, halfV: 0.2, yaw: 0, pitch: 70, fov: 60, aspect: 16 / 9,
  lookaheadDeg: 20, panSign: 1, manual: true,
};
const upOrder = Cast.tileLoadOrder(gridTiles, 4000, 3000, upView);
assert(gridTiles[upOrder[0]].row === 0, "looking up requests the strip at the center of the screen first, got row " + gridTiles[upOrder[0]].row);
const autoUp = Cast.tileLoadOrder(gridTiles, 4000, 3000, {
  u: 0.5, v: 0.08, halfU: 0.2, halfV: 0.2, yaw: 0, pitch: 70, manual: false, panSign: 1,
});
assert(gridTiles[autoUp[0]].row === 1, "auto-pan keeps the master on the horizon, got row " + gridTiles[autoUp[0]].row);

function bandGrid() {
  const colW = [2730, 2732, 2730];
  const rowH = [819, 819, 820, 819, 819];
  const tiles = [];
  let y = 0;
  for (let row = 0; row < 5; row++) {
    let x = 0;
    for (let col = 0; col < 3; col++) {
      tiles.push({
        id: "r" + row + "c" + col,
        row: row,
        col: col,
        srcX: x,
        srcY: y,
        srcW: colW[col],
        srcH: rowH[row],
      });
      x += colW[col];
    }
    y += rowH[row];
  }
  return tiles;
}
const bands = bandGrid();
const bandW = 8192;
const bandH = 4096;
const autoView = {
  u: 0.5, v: 0.5, halfU: 0.15, halfV: 0.12, yaw: 0, pitch: 0,
  manual: false, lookaheadDeg: 55, panSign: 1,
};
const noneLoaded = { loaded: function () { return false; }, revealAt: function () { return 0; } };
const onlyMaster = Cast.activeMasters(bands, bandW, bandH, autoView, noneLoaded);
assert(onlyMaster.length === 1 && onlyMaster[0].id === "r2c1", "only the horizon master is requested first, got " + onlyMaster.map(function (t) { return t.id; }).join(","));
const fadingMasters = Cast.activeMasters(bands, bandW, bandH, autoView, {
  loaded: function (tile) { return tile.id === "r2c1"; },
  revealAt: function (col, row) { return col === 1 && row === 2 ? 0.4 : 0; },
});
assert(fadingMasters.some(function (tile) { return tile.id === "r1c1"; }) && fadingMasters.some(function (tile) { return tile.id === "r3c1"; }), "the bands above and below start downloading once the master has arrived");
assert(!fadingMasters.some(function (tile) { return tile.id === "r0c1" || tile.id === "r4c1"; }), "the poles wait until the band in front of them has arrived");
assert(fadingMasters.some(function (tile) { return tile.col === 0; }) && fadingMasters.some(function (tile) { return tile.col === 2; }), "the neighboring 120° horizon strips start during the fade");
assert(Cast.FOCUS_MS === 1800, "the strip fade is 1.8s");
assert(Cast.fetchUnlocked(bands.find(function (t) { return t.id === "r1c1"; }), bands, 2, function (tile) {
  return tile.id === "r2c1";
}) === true, "tier 1 can download while the master is still fading");
assert(Cast.fetchUnlocked(bands.find(function (t) { return t.id === "r0c1"; }), bands, 2, function (tile) {
  return tile.id === "r2c1";
}) === false, "tier 2 does not download until tier 1 has arrived");
const seamPad = 32;
const seamSrc = 2730;
const seamContent = seamPad + seamSrc + seamPad;
const seamTex = 4096;
const seamEdge = Cast.clampStripSt(1, 0.5, seamPad, 0, seamSrc, 800, seamTex, 1024, seamContent, 800);
assert(seamEdge.x <= seamContent - 0.5 + 1e-6, "the right seam stays inside the real gutter, got " + seamEdge.x);
assert(seamEdge.x < seamTex - 1, "the right seam does not sample the power-of-two pad");
const noGutter = Cast.clampStripSt(1.02, 0.5, 0, 0, seamSrc, 800, seamTex, 1024, seamSrc, 800);
assert(noGutter.x <= seamSrc - 0.5 + 1e-6, "without a gutter the seam clamps to the last real texel, got " + noGutter.x);
const leftStrip = { srcX: 0, srcY: 1000, srcW: 2730, srcH: 820, padL: 32, padR: 32, padT: 32, padB: 32 };
const rightStrip = { srcX: 5462, srcY: 1000, srcW: 2730, srcH: 820, padL: 32, padR: 32, padT: 32, padB: 32 };
const wrapped = Cast.unwrapStripU(0.001, rightStrip.srcX / 8192, (rightStrip.srcX + rightStrip.srcW) / 8192);
assert(wrapped > 0.99, "u just past 0 belongs to the strip that ends at 1, got " + wrapped);
const backPatch = Cast.tilePatch(rightStrip, 8192, 4096);
const frontPatch = Cast.tilePatch(leftStrip, 8192, 4096);
let backU = -1;
let frontU = 2;
for (let i = 3; i < backPatch.interleaved.length; i += 5) backU = Math.max(backU, backPatch.interleaved[i]);
for (let j = 3; j < frontPatch.interleaved.length; j += 5) frontU = Math.min(frontU, frontPatch.interleaved[j]);
assert(backU > 1, "the strip that ends at u=1 overlaps the wrap, got " + backU);
assert(frontU < 0, "the strip that starts at u=0 overlaps the wrap, got " + frontU);
assert(Cast.revealUnlocked(bands.find(function (t) { return t.id === "r1c1"; }), bands, 2, function (col, row) {
  return col === 1 && row === 2 ? 0.34 : 0;
}) === false, "tier 1 stays shut below the seam handoff");
assert(Cast.revealUnlocked(bands.find(function (t) { return t.id === "r1c1"; }), bands, 2, function (col, row) {
  return col === 1 && row === 2 ? 1 : 0;
}) === true, "tier 1 unlocks once the horizon master has passed the handoff");
assert(Cast.revealUnlocked(bands.find(function (t) { return t.id === "r0c1"; }), bands, 2, function (col, row) {
  return col === 1 && (row === 2 || row === 1) ? 1 : 0;
}) === true, "tier 2 unlocks once tier 1 in that column has passed the handoff");
assert(Cast.revealUnlocked(bands.find(function (t) { return t.id === "r0c1"; }), bands, 2, function (col, row) {
  if (col !== 1) return 0;
  if (row === 2) return 1;
  if (row === 1) return 0.34;
  return 0;
}) === false, "tier 2 stays shut while tier 1 is below the handoff");
assert(Cast.revealUnlocked(bands.find(function (t) { return t.id === "r0c1"; }), bands, 2, function (col, row) {
  if (col !== 1) return 0;
  if (row === 2) return 1;
  if (row === 1) return 0.99;
  return 0;
}) === true, "tier 2 opens while tier 1 is still finishing its feather");
const steeredView = {
  u: 0.5, v: 0.05, halfU: 0.15, halfV: 0.12, yaw: 0, pitch: 70,
  manual: true, lookaheadDeg: 55, panSign: 1,
};
const steeredMaster = Cast.activeMasters(bands, bandW, bandH, steeredView, noneLoaded);
assert(steeredMaster.length === 1 && steeredMaster[0].id === "r0c1", "controller mode masters the strip at the center of the screen, got " + steeredMaster.map(function (t) { return t.id; }).join(","));
assert(Cast.stripAnchorRow(bands, bandH, steeredView) === 0, "the manual anchor is the screen-center row");
assert(Cast.revealUnlocked(bands.find(function (t) { return t.id === "r1c1"; }), bands, 0, function () { return 0; }) === false, "the band below the screen center waits for that center strip");
assert(Cast.revealUnlocked(bands.find(function (t) { return t.id === "r1c1"; }), bands, 0, function (col, row) {
  return col === 1 && row === 0 ? 1 : 0;
}) === true, "once the screen-center strip finishes, the next band outward unlocks");
const front180 = { id: "front", col: 0, row: 2, srcX: 2048, srcY: 1638, srcW: 4096, srcH: 820, texW: 4096, texH: 820, padL: 0, padT: 0 };
const back180 = { id: "back", col: 1, row: 2, srcX: 6144, srcY: 1638, srcW: 4096, srcH: 820, texW: 4096, texH: 820, padL: 0, padT: 0 };
const hemi = [front180, back180];
assert(Cast.columnAtU(hemi, 8192, 0.5) === 0, "yaw 0 is the front 180° strip");
assert(Cast.columnAtU(hemi, 8192, 0) === 1, "the back hemisphere covers u=0");
assert(Cast.columnAtU(hemi, 8192, 0.99) === 1, "the back hemisphere covers u just before 1");
assert(Cast.columnAtU(hemi, 8192, 0.25) === 0, "the seam at the front edge stays with column 0");
assert(Cast.tileTexCoord(0.05, 0.5, back180, 8192, 4096), "u just past 0 samples the back strip");
assert(!Cast.tileTexCoord(0.5, 0.5, back180, 8192, 4096), "the front of the photo is not the back strip");

const decodeSandbox = sandbox;
const decodeTimers = [];
decodeSandbox.atob = function (data) { return Buffer.from(data, "base64").toString("binary"); };
decodeSandbox.Blob = function (parts) { this.parts = parts; };
decodeSandbox.URL = { createObjectURL: function () { return "blob:tile"; }, revokeObjectURL: function () {} };
decodeSandbox.Image = function () {
  Object.defineProperty(this, "src", {
    set: function () {
      this.width = 12;
      this.height = 8;
      if (this.onload) this.onload();
    },
  });
};
decodeSandbox.setTimeout = function (fn, ms) { decodeTimers.push({ fn: fn, ms: ms }); return decodeTimers.length; };
decodeSandbox.clearTimeout = function () {};
decodeSandbox.createImageBitmap = function () {
  return { then: function () { return { catch: function () {} }; } };
};
const decodeLogs = [];
decodeSandbox.__castSend = function (msg) { if (msg && msg.type === "log") decodeLogs.push(msg.message); };
let decoded = null;
Cast.materializeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), function (err, img) {
  decoded = { err: err, img: img };
});
decodeTimers.filter(function (timer) { return timer.ms === 0; }).forEach(function (timer) { timer.fn(); });
assert(!decoded, "a hung bitmap does not finish the tile");
decodeTimers.filter(function (timer) { return timer.ms >= 1000; }).forEach(function (timer) { timer.fn(); });
assert(decoded && decoded.img && decoded.img.width === 12, "the image path runs when the bitmap does not");
assert(decodeLogs.length > 0, "the TV tells the phone that decode fell back");

const beforeLoad = Cast.loadingProfile({ edge: 1024, bandOnly: false, msPerMb: 12, dps: 18, durationMs: 8000 });
const afterLoad = Cast.loadingProfile({ edge: 512, bandOnly: true, msPerMb: 12, dps: 18, durationMs: 8000 });
console.log("loading before", JSON.stringify(beforeLoad));
console.log("loading after", JSON.stringify(afterLoad));
assert(afterLoad.misses === 0 && beforeLoad.misses === 0, "both profiles stay covered by the overview");
assert(afterLoad.maxBusyMs <= 4.35, "a 512px upload stays inside the 4ms budget, got " + afterLoad.maxBusyMs);
assert(afterLoad.totalBusyMs < beforeLoad.totalBusyMs, "the view-only 512px path uses less main-thread time");
const beforePixels = beforeLoad.peakResident * beforeLoad.edge * beforeLoad.edge;
const afterPixels = afterLoad.peakResident * afterLoad.edge * afterLoad.edge;
assert(afterPixels < beforePixels, "the view keeps fewer full-resolution pixels, " + afterPixels + " vs " + beforePixels);
assert(afterLoad.maxFrameMs <= beforeLoad.maxFrameMs + 0.01, "frame time does not get worse");

// The phone's Cast channel: base64 chunks with the same fields CastChunks.kt writes.
function phoneSplit(id, token, jpeg) {
  const raw = 24576;
  const count = Math.max(1, Math.ceil(jpeg.length / raw));
  const parts = [];
  for (let index = 0; index < count; index++) {
    const slice = jpeg.subarray(index * raw, Math.min(jpeg.length, (index + 1) * raw));
    const data = Buffer.from(slice).toString("base64");
    const message = JSON.stringify({ type: "chunk", id: id, token: token, i: index, n: count, data: data });
    assert(message.length < 64 * 1024, "a phone chunk stays under the Cast message limit");
    parts.push(JSON.parse(message));
  }
  return parts;
}

const deviceTimers = [];
sandbox.setTimeout = function (fn, ms) { deviceTimers.push({ fn: fn, ms: ms || 0 }); return deviceTimers.length; };
sandbox.clearTimeout = function () {};
sandbox.atob = function (data) { return Buffer.from(data, "base64").toString("binary"); };
sandbox.Blob = function (parts) { this.parts = parts; };
sandbox.createImageBitmap = function () {
  const bitmap = { width: 512, height: 512, close: function () {} };
  return { then: function (ok) { ok(bitmap); return { catch: function () {} }; } };
};
const deviceSent = [];
sandbox.__castSend = function (msg) { deviceSent.push(msg); };
const deviceGl = {
  uploads: [],
  subs: [],
  disabled: [],
  uniforms: [],
  VERTEX_SHADER: 1,
  FRAGMENT_SHADER: 2,
  COMPILE_STATUS: 3,
  LINK_STATUS: 4,
  ARRAY_BUFFER: 5,
  ELEMENT_ARRAY_BUFFER: 6,
  FLOAT: 5126,
  TRIANGLES: 4,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  TEXTURE_2D: 3553,
  RGBA: 6408,
  UNSIGNED_BYTE: 5121,
  COLOR_BUFFER_BIT: 16384,
  TEXTURE0: 33984,
  DEPTH_TEST: 0x0B71,
  CULL_FACE: 0x0B44,
  CURRENT_PROGRAM: 0x8B8D,
  MAX_TEXTURE_SIZE: 0x0D33,
  _prog: null,
  createShader: function () { return {}; },
  shaderSource: function () {},
  compileShader: function () {},
  getShaderParameter: function () { return true; },
  getShaderInfoLog: function () { return ""; },
  createProgram: function () { return {}; },
  attachShader: function () {},
  linkProgram: function () {},
  getProgramParameter: function () { return true; },
  getProgramInfoLog: function () { return ""; },
  deleteProgram: function () {},
  useProgram: function (prog) { deviceGl._prog = prog; },
  getUniformLocation: function (_prog, name) { return name; },
  getAttribLocation: function () { return 0; },
  enableVertexAttribArray: function () {},
  vertexAttribPointer: function () {},
  createBuffer: function () { return {}; },
  bindBuffer: function () {},
  bufferData: function () {},
  createTexture: function () { return { id: deviceGl.uploads.length + 1 }; },
  bindTexture: function (_target, tex) { deviceGl._bound = tex; },
  texParameteri: function () {},
  pixelStorei: function () {},
  texImage2D: function () {
    const rec = { tex: deviceGl._bound, sub: false };
    if (arguments.length >= 9) {
      rec.w = arguments[3];
      rec.h = arguments[4];
    } else {
      rec.source = arguments[5];
      rec.w = rec.source && rec.source.width;
      rec.h = rec.source && rec.source.height;
    }
    deviceGl.uploads.push(rec);
  },
  texSubImage2D: function () {
    const y = arguments[4];
    deviceGl.subs.push(y);
    if (y > 0) throw new Error("chromecast rejected texSubImage2D y=" + y);
  },
  generateMipmap: function () {},
  deleteTexture: function () {},
  getExtension: function () { return null; },
  getShaderPrecisionFormat: function () { return { precision: 23 }; },
  getParameter: function (name) {
    if (name === deviceGl.CURRENT_PROGRAM) return deviceGl._prog;
    if (name === deviceGl.MAX_TEXTURE_SIZE) return 4096;
    return 0;
  },
  activeTexture: function () {},
  viewport: function () {},
  clearColor: function () {},
  clear: function () {},
  disable: function (cap) { deviceGl.disabled.push(cap); },
  enable: function () {},
  blendFunc: function () {},
  uniform1f: function (name, value) { deviceGl.uniforms.push([name, value]); },
  uniform1i: function () {},
  uniformMatrix4fv: function () {},
  drawElements: function () { deviceGl.draws = (deviceGl.draws || 0) + 1; },
  drawArrays: function () {},
  isContextLost: function () { return false; },
  finish: function () {},
  depthMask: function () {},
};
const deviceCanvas = {
  width: 1280,
  height: 720,
  clientWidth: 1280,
  clientHeight: 720,
  addEventListener: function () {},
  getContext: function (kind) {
    if (kind === "webgl2" || kind === "2d") return null;
    return deviceGl;
  },
};
let deviceClock = 8000;
const device = Cast.create(deviceCanvas);
device._focusNow = function () { return deviceClock; };
const deviceTiles = [];
for (let col = 0; col < 4; col++) {
  deviceTiles.push({
    id: "shot-r1-c" + col,
    url: "http://phone.local/shot-r1-c" + col + ".jpg",
    col: col,
    row: 1,
    srcX: col * 1000,
    srcY: 1000,
    srcW: 1000,
    srcH: 1000,
    texW: 512,
    texH: 512,
  });
}
const deviceJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x10, 0x20, 0x30, 0x40]);
assert(phoneSplit("shot:overview", 1, deviceJpeg).length === 1, "a tiny jpeg is one phone chunk");
const wideJpeg = Buffer.alloc(24576 + 9, 7);
wideJpeg[0] = 0xff;
assert(phoneSplit("shot-r1-c0", 2, wideJpeg).length === 2, "the phone splits a tile the way CastChunks does");
device.setQueue([{
  id: "shot",
  url: "http://phone.local/shot.jpg",
  width: 4000,
  height: 3000,
  overview: { id: "shot:overview", url: "http://phone.local/shot-overview.jpg", texW: 256, texH: 128 },
  tiles: deviceTiles,
}]);
assert(device._intro === "hold", "cast start holds on the title mark");
const delivered = {};
function flushDevice() {
  const due = deviceTimers.splice(0, deviceTimers.length);
  due.forEach(function (timer) { timer.fn(); });
}
function deliverFetches() {
  deviceSent.filter(function (msg) { return msg && msg.type === "fetch"; }).forEach(function (msg) {
    if (delivered[msg.id + ":" + msg.token]) return;
    delivered[msg.id + ":" + msg.token] = true;
    const bytes = msg.id.indexOf("overview") >= 0 ? deviceJpeg : wideJpeg;
    phoneSplit(msg.id, msg.token, bytes).forEach(function (part) { device.noteChunk(part); });
  });
  flushDevice();
}
for (let round = 0; round < 8; round++) {
  deliverFetches();
  device._pumpFrame(16);
  flushDevice();
  device._pumpFrame(16);
}
device._sendDiag(true);
const diag = deviceSent.filter(function (msg) { return msg && msg.type === "diag"; }).pop();
assert(diag, "the TV sends tile diagnostics the phone can show");
assert(diag.requested >= 2, "the TV requested the overview and a sharp tile, got " + diag.requested);
assert(diag.received >= 2, "the phone's chunks were received, got " + diag.received);
assert(diag.decoded >= 2, "received tiles were decoded, got " + diag.decoded);
assert(diag.uploaded >= 2, "decoded tiles were uploaded, got " + diag.uploaded);
assert(diag.errors === 0, "the phone path uploaded without an error, got " + diag.errors + " " + diag.note);
const imageUploads = deviceGl.uploads.filter(function (rec) { return rec.source && rec.source.width; });
assert(imageUploads.length >= 2, "overview and a tile reached texImage2D, got " + imageUploads.length);
assert(imageUploads.every(function (rec) { return rec.h === rec.source.height && rec.w === rec.source.width; }), "each upload is the whole image");
assert(deviceGl.subs.length === 0, "512px tiles do not use a strip that can stop halfway");
assert(!device._strip, "no strip is left blocking the queue");
assert(deviceGl.disabled.indexOf(deviceGl.DEPTH_TEST) >= 0, "depth test is off so sharp tiles can draw on the overview");
assert(device._photoFrontReady(device.session), "front tiles are ready to leave the title mark");
device._syncMark(16);
assert(device._intro === "out", "the mark crossfades once the front is ready");
assert(device._geoAt === deviceClock, "the bloom starts when the photo is shown");
const liveTile = (device._tileDraw || []).filter(function (piece) { return piece && piece.tile && !piece.tile._base; })[0];
assert(liveTile && liveTile._focusAt === deviceClock, "tiles already on the TV restart their fade with the bloom");
assert(device._revealOf(liveTile) === 0, "the fade starts fully soft");
const spanW = device._tileW || device.session.entry.width;
const spanH = device._tileH || device.session.entry.height;
assert(spanW === 4000 && spanH === 3000, "the TV knows the photo size before the fade, got " + spanW + "x" + spanH);
function readDraw() {
  deviceGl.uniforms.length = 0;
  device._drawTiles();
  const shared = {};
  const groups = [];
  let group = null;
  deviceGl.uniforms.forEach(function (pair) {
    if (pair[0] === "uGeo" || pair[0] === "uViewU" || pair[0] === "uViewV" || pair[0] === "uAnchorV") shared[pair[0]] = pair[1];
    if (pair[0] === "uU0") {
      group = {};
      groups.push(group);
    }
    if (group) group[pair[0]] = pair[1];
  });
  return { shared: shared, groups: groups };
}
function groupFor(piece) {
  const shot = readDraw();
  const u0 = piece.tile.srcX / spanW;
  const v0 = piece.tile.srcY / spanH;
  const found = shot.groups.filter(function (item) {
    return item.uKind === 0 && Math.abs(item.uU0 - u0) < 1e-3 && Math.abs(item.uV0 - v0) < 1e-3;
  })[0];
  return { shared: shot.shared, tile: found };
}
let fading = null;
(device._tileDraw || []).forEach(function (piece) {
  if (fading || !piece || !piece.tile || piece.tile._base) return;
  if (groupFor(piece).tile) fading = piece;
});
assert(fading, "a sharp tile is drawn on the photo, not discarded");
const opened = groupFor(fading);
assert(opened.tile, "the fading tile is in the draw");
assert(Math.abs((opened.tile.uU1 - opened.tile.uU0) - fading.tile.srcW / spanW) < 1e-3, "the tile uses the photo span");
assert(opened.tile.uReveal === 0, "the first device draw uploads a fully soft tile, got " + opened.tile.uReveal);
assert(opened.shared.uGeo === 0, "the geometric bloom starts at 0 when the fade starts, got " + opened.shared.uGeo);
const cu = (fading.tile.srcX + fading.tile.srcW / 2) / spanW;
const cv = (fading.tile.srcY + fading.tile.srcH / 2) / spanH;
function centerAlpha(sample) {
  return Cast.focusMask(cu, cv, fading.tile, spanW, spanH, sample.tile.uReveal, {
    left: sample.tile.uNL,
    right: sample.tile.uNR,
    up: sample.tile.uNU,
    down: sample.tile.uND,
  }, {
    viewU: sample.shared.uViewU,
    viewV: sample.shared.uViewV,
    anchorV: sample.shared.uAnchorV,
    t: sample.shared.uGeo,
  });
}
const born = device._geoAt;
const times = [];
for (let t = 0; t < Cast.FOCUS_MS; t += 16) times.push(t);
times.push(Cast.FOCUS_MS);
const revealFrames = [];
const centerFrames = [];
times.forEach(function (t) {
  deviceClock = born + t;
  const sample = groupFor(fading);
  assert(sample.tile, "the tile stays on screen through the fade at " + t);
  const expect = device._revealOf(fading);
  assert(Math.abs(sample.tile.uReveal - expect) < 1e-6, "the draw uploads this tile's clock at " + t + ", got " + sample.tile.uReveal + " vs " + expect);
  revealFrames.push(sample.tile.uReveal);
  centerFrames.push(centerAlpha(sample));
});
assert(revealFrames[0] === 0, "fade frames start at 0");
assert(revealFrames[revealFrames.length - 1] === 1, "fade frames end at 1, got " + revealFrames[revealFrames.length - 1]);
let midFrames = 0;
let maxJump = 0;
for (let i = 1; i < revealFrames.length; i++) {
  const jump = revealFrames[i] - revealFrames[i - 1];
  assert(jump > 0, "each device frame moves the fade forward");
  if (jump > maxJump) maxJump = jump;
  if (revealFrames[i] > 0.02 && revealFrames[i] < 0.98) midFrames += 1;
}
assert(midFrames >= 8, "the fade spends many frames between soft and sharp, got " + midFrames);
assert(maxJump < 0.08, "a frame does not pop the fade, got " + maxJump);
deviceClock = born + Cast.FOCUS_MS / 4;
const eased = groupFor(fading).tile.uReveal;
assert(Math.abs(eased - 0.25) < 0.02, "the fade moves in a straight line, got " + eased);
let centerBetween = 0;
for (let i = 1; i < centerFrames.length; i++) {
  assert(centerFrames[i] + 1e-6 >= centerFrames[i - 1], "tile-center sharpness never jumps backward");
  if (centerFrames[i] > 0.02 && centerFrames[i] < 0.98) centerBetween += 1;
}
assert(centerFrames[0] === 0, "the tile center starts soft, got " + centerFrames[0]);
assert(centerFrames[centerFrames.length - 1] > 0.9, "the tile center is sharp when its fade ends, got " + centerFrames[centerFrames.length - 1]);
assert(centerBetween >= 8, "the tile-center blend is not stuck at 0 or 1, got " + centerBetween);
const geoTimes = [];
for (let t = 0; t < Cast.GEO_MS; t += 16) geoTimes.push(t);
geoTimes.push(Cast.GEO_MS);
const geoFrames = [];
geoTimes.forEach(function (t) {
  deviceClock = born + t;
  geoFrames.push(groupFor(fading).shared.uGeo);
});
assert(geoFrames[0] === 0 && geoFrames[geoFrames.length - 1] === 1, "the bloom runs from 0 to 1");
let geoBetween = 0;
for (let i = 1; i < geoFrames.length; i++) {
  assert(geoFrames[i] > geoFrames[i - 1], "the bloom clock moves every frame");
  if (geoFrames[i] > 0.02 && geoFrames[i] < 0.98) geoBetween += 1;
}
assert(geoBetween >= 8, "the bloom is not stuck at 0 or 1, got " + geoBetween);
deviceClock = born + Cast.GEO_MS + 2000;
const lateDraw = groupFor(fading);
assert(lateDraw.shared.uGeo === 1, "the old bloom clock is already finished when a late tile is still opening, got " + lateDraw.shared.uGeo);
const curtainGeo = { t: 1, anchorV: 0.5 };
const lateClosed = { left: 0, right: 0, up: 0, down: 0 };
const lateCenter = Cast.focusMask(cu, cv, fading.tile, spanW, spanH, 0.35, lateClosed, curtainGeo);
const lateSameLat = Cast.focusMask(cu + (fading.tile.srcW / spanW) * 0.2, cv, fading.tile, spanW, spanH, 0.35, lateClosed, curtainGeo);
const latePole = Cast.focusMask(cu, fading.tile.srcY / spanH + (fading.tile.srcH / spanH) * 0.04, fading.tile, spanW, spanH, 0.35, lateClosed, curtainGeo);
assert(lateCenter > 0.85, "the horizon of a fading strip is already open, got " + lateCenter);
assert(Math.abs(lateSameLat - lateCenter) < 0.08, "the same latitude is one band, not a circle, got " + lateSameLat);
assert(latePole < lateCenter * 0.35, "the curtain has not reached the far edge of the strip, got " + latePole);
const readyNext = {
  id: "ready-next",
  url: "http://phone.local/ready.jpg",
  width: 4000,
  height: 3000,
  overview: { id: "ready-next:overview", url: "http://phone.local/ready-overview.jpg", texW: 256, texH: 128 },
  tiles: deviceTiles.map(function (tile) { return Object.assign({}, tile, { id: "ready-" + tile.id }); }),
};
device.entries.push(readyNext);
device._intro = "off";
device._presented = true;
device._awaitingSwap = true;
device._awaitIndex = 1;
assert(device._markWanted() === false, "the mark stays down once a photo has been presented");
const readyPool = { entry: readyNext, _overviewReady: true, loaded: [] };
readyNext.tiles.forEach(function (tile) {
  readyPool.loaded.push({ tile: tile, tex: { _mip: true, _uploadW: 512, _uploadH: 512 } });
});
device._standby = { entry: readyNext, _overviewReady: true, loaded: readyPool.loaded };
assert(device._photoFrontReady(device._standby) === true, "a preloaded next photo counts as ready");
assert(device._markWanted() === false, "a ready next photo does not cover the TV with the mark");

function crc32(buf) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}
function writePng(file, width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const zlib = require("zlib");
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}
function photoColor(u, v) {
  const band = Math.floor(u * 12) % 2;
  let r;
  let g;
  let b;
  if (v < 0.42) {
    r = 64 + band * 24;
    g = 118;
    b = 176;
  } else if (v > 0.58) {
    r = 92 + band * 28;
    g = 78;
    b = 48;
  } else {
    r = 214;
    g = 186 - band * 36;
    b = 132;
  }
  return [r, g, b];
}
function blurColor(u, v) {
  let r = 0;
  let g = 0;
  let b = 0;
  const taps = [[0, 0], [0.02, 0], [-0.02, 0], [0, 0.03], [0, -0.03]];
  taps.forEach(function (tap) {
    const sample = photoColor(Math.min(0.999, Math.max(0, u + tap[0])), Math.min(0.999, Math.max(0, v + tap[1])));
    r += sample[0];
    g += sample[1];
    b += sample[2];
  });
  return [r / taps.length * 0.55 + 18, g / taps.length * 0.55 + 18, b / taps.length * 0.55 + 22];
}
const frameW = 480;
const frameH = 240;
const frameSpanW = 4000;
const frameSpanH = 3000;
const frameCols = 4;
const frameRows = 3;
const frameTiles = [];
for (let row = 0; row < frameRows; row++) {
  for (let col = 0; col < frameCols; col++) {
    const srcX = col * 1000;
    const srcY = row * 1000;
    const cuv = (srcX + 500) / frameSpanW;
    const cvv = (srcY + 500) / frameSpanH;
    const dx = (cuv - 0.5) * 360;
    const dy = (cvv - 0.5) * 180;
    frameTiles.push({ srcX: srcX, srcY: srcY, srcW: 1000, srcH: 1000, row: row, col: col, dist: Math.hypot(dx, dy) });
  }
}
frameTiles.sort(function (a, b) { return a.dist - b.dist || a.row - b.row || a.col - b.col; });
let frameWave = 0;
let frameLast = -1;
frameTiles.forEach(function (tile) {
  if (frameLast >= 0 && tile.dist - frameLast > 1) frameWave += 1;
  frameLast = tile.dist;
  tile.born = 1650 + frameWave * 1000;
});
function frameReveal(tile, now) {
  if (now < tile.born) return 0;
  return Cast.revealProgress(tile.born, now, Cast.FOCUS_MS);
}
function framePiece(row, col) {
  if (row < 0 || row >= frameRows) return 1;
  let wrapped = col;
  if (wrapped < 0 || wrapped >= frameCols) wrapped = (wrapped + frameCols) % frameCols;
  return frameTiles.find(function (item) { return item.row === row && item.col === wrapped; }) || 1;
}
function frameNeighbors(tile, now) {
  function side(dRow, dCol) {
    const other = framePiece(tile.row + dRow, tile.col + dCol);
    if (other === 1) return 1;
    return frameReveal(other, now);
  }
  return { left: side(0, -1), right: side(0, 1), up: side(-1, 0), down: side(1, 0) };
}
function frameAlpha(u, v, now) {
  let best = 0;
  for (let i = 0; i < frameTiles.length; i++) {
    const tile = frameTiles[i];
    const u0 = tile.srcX / frameSpanW;
    const u1 = (tile.srcX + tile.srcW) / frameSpanW;
    const v0 = tile.srcY / frameSpanH;
    const v1 = (tile.srcY + tile.srcH) / frameSpanH;
    if (u < u0 || u > u1 || v < v0 || v > v1) continue;
    const alpha = Cast.focusMask(u, v, tile, frameSpanW, frameSpanH, frameReveal(tile, now), frameNeighbors(tile, now), { t: 1 });
    if (alpha > best) best = alpha;
  }
  return best;
}
const frameDir = path.join(__dirname, "..", "artifacts", "focus-frames");
[2, 3, 4, 5].forEach(function (second) {
  const now = second * 1000;
  const rgba = Buffer.alloc(frameW * frameH * 4);
  const alpha = new Float32Array(frameW * frameH);
  let partial = 0;
  frameTiles.forEach(function (tile) {
    const reveal = frameReveal(tile, now);
    if (reveal > 0.08 && reveal < 0.92) partial += 1;
  });
  assert(partial > 0, "t=" + second + "s still has a tile opening, not a finished square grid");
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const u = (x + 0.5) / frameW;
      const v = (y + 0.5) / frameH;
      const a = frameAlpha(u, v, now);
      alpha[y * frameW + x] = a;
      const sharp = photoColor(u, v);
      const soft = blurColor(u, v);
      const i = (y * frameW + x) * 4;
      rgba[i] = Math.round(soft[0] + (sharp[0] - soft[0]) * a);
      rgba[i + 1] = Math.round(soft[1] + (sharp[1] - soft[1]) * a);
      rgba[i + 2] = Math.round(soft[2] + (sharp[2] - soft[2]) * a);
      rgba[i + 3] = 255;
    }
  }
  function frameCol(px) {
    return Math.min(frameCols - 1, Math.floor(((px + 0.5) / frameW) * frameCols));
  }
  function frameRow(py) {
    return Math.min(frameRows - 1, Math.floor(((py + 0.5) / frameH) * frameRows));
  }
  let hardSteps = 0;
  let hardWhere = "";
  for (let y = 0; y < frameH; y++) {
    for (let x = 1; x < frameW; x++) {
      if (frameCol(x - 1) !== frameCol(x)) continue;
      const left = alpha[y * frameW + (x - 1)];
      const right = alpha[y * frameW + x];
      if ((left - 0.5) * (right - 0.5) < 0 && Math.abs(right - left) > 0.85) {
        hardSteps += 1;
        if (!hardWhere) hardWhere = "x=" + x + " y=" + y + " " + left.toFixed(3) + "->" + right.toFixed(3);
      }
    }
  }
  for (let y = 1; y < frameH; y++) {
    if (frameRow(y - 1) !== frameRow(y)) continue;
    for (let x = 0; x < frameW; x++) {
      const above = alpha[(y - 1) * frameW + x];
      const below = alpha[y * frameW + x];
      if ((above - 0.5) * (below - 0.5) < 0 && Math.abs(below - above) > 0.85) hardSteps += 1;
    }
  }
  assert(hardSteps === 0, "t=" + second + "s the blur/sharp boundary is feathered, hard steps " + hardSteps + " at " + hardWhere);
  frameTiles.forEach(function (tile) {
    const reveal = frameReveal(tile, now);
    if (reveal <= 0.15 || reveal >= 0.5) return;
    const u0 = tile.srcX / frameSpanW;
    const v0 = tile.srcY / frameSpanH;
    const du = tile.srcW / frameSpanW;
    const dv = tile.srcH / frameSpanH;
    const toward = tile.row < 1 ? 0.82 : tile.row > 1 ? 0.18 : 0.5;
    const away = tile.row < 1 ? 0.12 : tile.row > 1 ? 0.88 : 0.1;
    const equator = frameAlpha(u0 + du * 0.5, v0 + dv * toward, now);
    const pole = frameAlpha(u0 + du * 0.5, v0 + dv * away, now);
    const side = frameAlpha(u0 + du * 0.28, v0 + dv * toward, now);
    assert(equator > pole + 0.12, "t=" + second + "s the curtain is sharper toward the horizon, got " + equator + " vs " + pole);
    assert(Math.abs(side - equator) < 0.2, "t=" + second + "s the same latitude matches across the strip, got " + side + " vs " + equator);
  });
  writePng(path.join(frameDir, "t" + second + "s.png"), frameW, frameH, rgba);
});

function resolved(value) {
  return {
    then: function (ok, err) {
      try {
        const out = ok(value);
        if (out && typeof out.then === "function") return out;
        return resolved(out);
      } catch (error) {
        if (err) {
          const out = err(error);
          if (out && typeof out.then === "function") return out;
          return resolved(out);
        }
        return rejected(error);
      }
    },
  };
}
function rejected(error) {
  return {
    then: function (ok, err) {
      if (!err) return rejected(error);
      try {
        const out = err(error);
        if (out && typeof out.then === "function") return out;
        return resolved(out);
      } catch (next) {
        return rejected(next);
      }
    },
  };
}
const lanPhoto = {
  id: "lan-shot",
  url: "http://192.168.4.20:9/shot.jpg",
  width: 4000,
  height: 3000,
  overview: { id: "lan-shot:overview", url: "http://192.168.4.20:9/overview.jpg", texW: 256, texH: 128 },
  tiles: [{
    id: "lan-shot-r1-c0",
    url: "http://192.168.4.20:9/r1c0.jpg",
    col: 0,
    row: 1,
    srcX: 0,
    srcY: 1000,
    srcW: 1000,
    srcH: 1000,
    texW: 512,
    texH: 512,
  }],
};
const lanUrls = [];
sandbox.fetch = function (url) {
  lanUrls.push(String(url));
  return resolved({
    ok: true,
    blob: function () { return resolved({ size: 16 }); },
  });
};
const lanSentAt = deviceSent.length;
const lanPlayer = Cast.create(deviceCanvas);
lanPlayer._focusNow = function () { return 12000; };
lanPlayer.setLan(true);
lanPlayer.setQueue([lanPhoto]);
assert(lanPlayer._lan === true, "setQueue keeps the Wi-Fi flag from the queue message");
const lanFetches = deviceSent.slice(lanSentAt).filter(function (msg) { return msg && msg.type === "fetch"; });
assert(lanFetches.length === 0, "a reachable phone JPEG is not also requested as Cast chunks, got " + JSON.stringify(lanFetches));
assert(lanUrls.indexOf("http://192.168.4.20:9/overview.jpg") >= 0, "the overview is fetched from the phone, got " + lanUrls.join(","));
assert(lanUrls.indexOf("http://192.168.4.20:9/r1c0.jpg") >= 0, "the sharp tile is fetched from the phone, got " + lanUrls.join(","));
const lanUploads = deviceGl.uploads.filter(function (rec) { return rec.source && rec.source.width; }).length;
assert(lanUploads > imageUploads.length, "LAN JPEGs were uploaded from memory, got " + lanUploads);
let lanTries = 0;
sandbox.fetch = function () {
  lanTries += 1;
  return rejected(new Error("blocked"));
};
sandbox.Image = function () {
  Object.defineProperty(this, "src", {
    set: function () {
      if (this.onerror) this.onerror();
    },
  });
};
const failAt = deviceSent.length;
const failPlayer = Cast.create(deviceCanvas);
failPlayer._focusNow = function () { return 13000; };
failPlayer.setLan(true);
failPlayer.setQueue([JSON.parse(JSON.stringify(lanPhoto))]);
assert(failPlayer._lan === true && failPlayer._lanDead === false, "one LAN miss keeps Wi-Fi available");
assert(failPlayer._lanFailures === 2, "overview and the tile each count as one miss, got " + failPlayer._lanFailures);
assert(lanTries === 2, "both JPEGs try the phone before falling back, got " + lanTries);
const failFetches = deviceSent.slice(failAt).filter(function (msg) { return msg && msg.type === "fetch"; });
assert(failFetches[0] && failFetches[0].reason === "lan", "the missed JPEG falls back to a Cast fetch, got " + JSON.stringify(failFetches));
assert(failFetches.length >= 2, "the missed tiles fall back to Cast messages, got " + JSON.stringify(failFetches));
const fallbackId = failFetches[0].id;
const fallbackToken = failFetches[0].token;
phoneSplit(fallbackId, fallbackToken, deviceJpeg).forEach(function (part) { failPlayer.noteChunk(part); });
let lanGuard = 0;
while (lanGuard < 6) {
  const due = deviceTimers.splice(0, deviceTimers.length).filter(function (timer) { return timer.ms === 0; });
  if (!due.length) break;
  due.forEach(function (timer) { timer.fn(); });
  lanGuard += 1;
}
const afterFallback = deviceSent.slice(failAt).filter(function (msg) { return msg && msg.type === "fetch"; });
assert(lanTries === 2, "a Cast fallback does not start another LAN timeout, got " + lanTries + " tries and " + afterFallback.length + " fetches");
assert(afterFallback.length >= 1, "the Cast fallback still asks for the tile");
sandbox.fetch = undefined;

console.log("show-sequence ok");
