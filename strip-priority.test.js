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
  getElementById: function () {
    return { hidden: true, textContent: "", classList: { add: function () {}, remove: function () {} } };
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

function canvas() {
  return {
    width: 320,
    height: 180,
    clientWidth: 320,
    clientHeight: 180,
    style: {},
    getContext: function () { return null; },
  };
}

function hemisphere(id) {
  const rowH = [819, 819, 820, 819, 819];
  const cols = [
    { col: 0, srcX: 2048, srcW: 4096 },
    { col: 1, srcX: 6144, srcW: 4096 },
  ];
  const tiles = [];
  let y = 0;
  for (let row = 0; row < 5; row++) {
    for (let c = 0; c < cols.length; c++) {
      const spec = cols[c];
      tiles.push({
        id: id + "-r" + row + "c" + spec.col,
        url: "http://phone/" + id + "/" + row + "/" + spec.col + ".jpg",
        col: spec.col,
        row: row,
        srcX: spec.srcX,
        srcY: y,
        srcW: spec.srcW,
        srcH: rowH[row],
        padL: 0,
        padR: 0,
        padT: 0,
        padB: 0,
        texW: spec.srcW,
        texH: rowH[row],
      });
    }
    y += rowH[row];
  }
  return {
    id: id,
    url: "http://phone/" + id + ".jpg",
    width: 8192,
    height: 4096,
    tiles: tiles,
  };
}

function deliver(session) {
  const pending = session && session.pending;
  if (!pending) return false;
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

const photo = hemisphere("pan");
const tiles = photo.tiles;
const width = photo.width;
const height = photo.height;

assert(Cast.GPU_CAP === 384 * 1024 * 1024, "GPU cap holds the current photo and the next photo's opening strips");

const earlyU = 0.3;
const wrappedLead = Cast.panLeadDeg(0, earlyU, 1);
assert(wrappedLead < 0, "a 180° center measured through ±180° looks behind, got " + wrappedLead);
const ahead = Cast.forwardEdgeDeg(6144 / 8192, (6144 + 4096) / 8192, earlyU, 1);
assert(ahead > 140 && ahead < 200, "the incoming edge stays ahead of the camera, got " + ahead);

function viewAt(yaw) {
  const center = Cast.viewCenterUv(yaw, 0);
  return {
    u: center.u,
    v: center.v,
    halfU: 0.149,
    halfV: 0.208,
    yaw: yaw,
    pitch: 0,
    fov: 75,
    aspect: 16 / 9,
    lookaheadDeg: 55,
    panSign: 1,
    manual: false,
  };
}

function indexOf(order, row, col) {
  return order.indexOf(tiles.findIndex(function (tile) { return tile.row === row && tile.col === col; }));
}

for (let yaw = 0; yaw <= 720; yaw += 9) {
  const view = viewAt(yaw);
  const viewCol = Cast.columnAtU(tiles, width, view.u);
  const nextCol = viewCol === 0 ? 1 : 0;
  assert(Cast.columnEngaged(0, viewCol, tiles, width, view) === true, "column 0 engaged at yaw " + yaw);
  assert(Cast.columnEngaged(1, viewCol, tiles, width, view) === true, "column 1 engaged at yaw " + yaw);
  tiles.forEach(function (tile) {
    assert(Cast.tileInResidentBand(tile, width, height, view) === true, tile.id + " left the resident band at yaw " + yaw);
  });
  const order = Cast.tileLoadOrder(tiles, width, height, view);
  assert(indexOf(order, 2, viewCol) < indexOf(order, 2, nextCol), "horizon of the lens before the next hemisphere at yaw " + yaw);
  assert(indexOf(order, 1, viewCol) < indexOf(order, 2, nextCol), "front upper band before the next hemisphere at yaw " + yaw);
  assert(indexOf(order, 3, viewCol) < indexOf(order, 2, nextCol), "front lower band before the next hemisphere at yaw " + yaw);
  assert(indexOf(order, 2, nextCol) < indexOf(order, 1, nextCol), "next horizon before its upper band at yaw " + yaw);
  assert(indexOf(order, 2, nextCol) < indexOf(order, 0, viewCol), "next horizon before the unseen pole at yaw " + yaw);
  assert(indexOf(order, 1, nextCol) < indexOf(order, 0, viewCol), "next mid band before the unseen pole at yaw " + yaw);
  assert(indexOf(order, 3, nextCol) < indexOf(order, 4, viewCol), "next lower band before the south cap at yaw " + yaw);
}

const manual = viewAt(0);
manual.manual = true;
const manualOrder = Cast.tileLoadOrder(tiles, width, height, manual);
assert(indexOf(manualOrder, 1, 0) < indexOf(manualOrder, 2, 1), "steering finishes the front mid band before the other hemisphere");
assert(indexOf(manualOrder, 3, 0) < indexOf(manualOrder, 2, 1), "steering finishes the front lower band before the other hemisphere");

const standbyView = viewAt(0);
standbyView.standby = true;
const frontOnly = Cast.activeMasters(tiles, width, height, standbyView, {
  loaded: function (tile) { return tile.id === "pan-r2c0"; },
});
const frontIds = frontOnly.map(function (tile) { return tile.id; });
assert(frontIds.indexOf("pan-r1c0") >= 0 && frontIds.indexOf("pan-r3c0") >= 0, "standby prefetches the bands in the opening frustum, got " + frontIds.join(","));
assert(frontIds.indexOf("pan-r2c1") >= 0, "standby also prefetches the other horizon, got " + frontIds.join(","));
assert(frontIds.indexOf("pan-r1c1") < 0, "the other column's side bands wait until that horizon has arrived");
assert(frontIds.indexOf("pan-r0c0") < 0 && frontIds.indexOf("pan-r4c0") < 0, "standby does not prefetch pole caps");

const covered = {
  entry: photo,
  loaded: ["pan-r2c0", "pan-r1c0", "pan-r3c0"].map(function (id) {
    return { tile: tiles.find(function (tile) { return tile.id === id; }), tex: { _mip: true } };
  }),
  _viewCovered: function () { return true; },
  _lookaheadCovered: function () { return false; },
};
assert(Cast.swapReady(covered) === true, "a covered opening frustum is ready to swap without the lookahead poles");
const horizonOnly = {
  entry: photo,
  loaded: [{ tile: tiles.find(function (tile) { return tile.id === "pan-r2c0"; }), tex: { _mip: true } }],
  _overviewReady: false,
  _viewCovered: function () { return false; },
  _lookaheadCovered: function () { return false; },
};
assert(Cast.swapReady(horizonOnly) === false, "the horizon strip alone is not a swap");
horizonOnly._overviewReady = true;
assert(Cast.swapReady(horizonOnly) === true, "the overview plus the front horizon can take the screen");

const asked = [];
const ordering = Cast.createSession({
  view: function () { return viewAt(0); },
  request: function (id) { asked.push(id); },
  materialize: function (payload, done) { done(null, { width: 8, height: 8, label: payload }); },
  upload: function (img) { return { _mip: true, bytes: 8, label: img.label }; },
  release: function () {},
});
ordering.open(hemisphere("ord"));
let orderGuard = 0;
while (ordering.pending && orderGuard < 20) {
  deliver(ordering);
  orderGuard += 1;
}
function askedAt(id) {
  const at = asked.indexOf(id);
  assert(at >= 0, "never requested " + id + " (" + asked.join(",") + ")");
  return at;
}
assert(askedAt("ord-r2c0") < askedAt("ord-r1c0") && askedAt("ord-r2c0") < askedAt("ord-r3c0"), "the front horizon is first");
assert(askedAt("ord-r1c0") < askedAt("ord-r2c1") && askedAt("ord-r3c0") < askedAt("ord-r2c1"), "the screen bands come before the other hemisphere");
assert(askedAt("ord-r2c1") < askedAt("ord-r1c1") && askedAt("ord-r2c1") < askedAt("ord-r3c1"), "the incoming horizon comes before its side bands");
assert(askedAt("ord-r1c1") < askedAt("ord-r0c0") && askedAt("ord-r3c1") < askedAt("ord-r4c0"), "the incoming mid bands come before the poles");

const show = Cast.create(canvas());
show._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
show._uploadTile = function (img) { return { label: img.label, bytes: 32, _mip: true }; };
show.manual = true;
show.setQueue([hemisphere("slideA"), hemisphere("slideB")]);
assert(deliver(show.session), "the first strip is requested");
assert(!show._standby || !show._standby.entry, "the next photo waits until this one has finished its strips");
let fillGuard = 0;
while (show.session && show.session.pending && fillGuard < 16) {
  deliver(show.session);
  fillGuard += 1;
}
assert(show.session && !show.session.pending, "photo A finished, still pending " + (show.session && show.session.pending && show.session.pending.id));
assert(show._standby && show._standby.entry && show._standby.entry.id === "slideB", "the next photo starts once this one is complete");
let standbyGuard = 0;
while (show._standby && show._standby.pending && standbyGuard < 8) {
  deliver(show._standby);
  standbyGuard += 1;
}
assert(show._standby._viewCovered() === true, "the opening frustum of the next photo is on the GPU");
assert(show._standby.loaded.length === 6, "standby prefetches both columns' opening bands, got " + show._standby.loaded.length);
assert(show._preloadStatus() === "view-ready", "a covered standby is view-ready, got " + show._preloadStatus());
show.manual = false;
show.playing = true;
show.itemDegrees = Cast.ROTATIONS * 360 - 0.2;
const before = show.index;
show.advance(500);
assert(before === 0 && show.index === 1, "two rotations advance the show, index " + show.index + " awaiting " + show._awaitingSwap);
assert(show._awaitingSwap === false, "the swap does not stay parked");
assert(show._preloadStatus() !== "stalled", "the show is not stuck reporting stalled, got " + show._preloadStatus());

const resident = Cast.create(canvas());
resident.playing = true;
resident.manual = false;
resident._useTiles = true;
resident.entries = [{ id: "keep", tiles: [{ id: "x" }] }, { id: "next", tiles: [{ id: "y" }] }];
resident.items = ["keep", "next"];
resident.session = {
  entry: resident.entries[0],
  pending: null,
  loaded: [],
  _inFlight: function () { return 0; },
  _pickTile: function () { return null; },
};
resident._standby = {
  entry: resident.entries[1],
  pending: null,
  loaded: [],
  budgetFull: false,
  preloadCapped: false,
  _viewCovered: function () { return false; },
  _lookaheadCovered: function () { return false; },
  _pickTile: function () { return null; },
  resume: function () {},
  _requestCurrent: function () {},
};
resident._resident = photo.tiles.map(function (tile) {
  return {
    tex: { id: tile.id },
    bytes: 14 * 1024 * 1024,
    u: ((tile.srcX + tile.srcW / 2) % 8192) / 8192,
    v: (tile.srcY + tile.srcH / 2) / 4096,
    tile: tile,
    spanW: 8192,
    spanH: 4096,
    standby: false,
  };
});
resident._gpuBytes = 10 * 14 * 1024 * 1024;
resident._tileDraw = resident._resident.slice();
for (let yaw = 0; yaw <= 720; yaw += 15) {
  resident.yaw = yaw;
  resident._evictOffscreen();
  resident._feedPreload();
  assert(resident._resident.length === 10, "a strip of the photo on screen was evicted at yaw " + yaw);
}
resident._gpuBytes = Cast.GPU_CAP + 8 * 1024 * 1024;
resident._evictOffscreen();
assert(resident._resident.length === 10, "a 180° strip is kept even when the GPU cap is exceeded");
assert(resident._resident.every(function (item) { return item.tex._evicted !== true; }), "no active strip was deleted");

const backEdge = { srcX: 6144, srcY: 1638, srcW: 4096, srcH: 820 };
const pixel = Cast.viewPixel(backEdge, 8192, 4096, 0.02, 0.5);
assert(Math.abs(pixel.x - 2211.84) < 0.1, "u just past 0 unwraps onto the back strip, got x " + pixel.x);
const clamped = Cast.viewPixel(backEdge, 8192, 4096, 0.5, 0.5);
assert(Math.abs(clamped.x - 2048) < 0.1, "a u outside the back strip stays on its center, got x " + clamped.x);

console.log("strip-priority: ok");
