const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "player.js"), "utf8");
const sandbox = {
  console: console,
  Date: Date,
  performance: { now: function () { return 0; } },
  setTimeout: function (fn, ms) {
    sandbox.__timers.push({ fn: fn, ms: ms });
    return sandbox.__timers.length;
  },
  clearTimeout: function () {},
  Image: function () {},
  __timers: [],
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
    width: 1280,
    height: 720,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    addEventListener: function () {},
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
        url: "http://192.168.1.20/" + id + "/" + row + "/" + spec.col + ".jpg",
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
    url: "http://192.168.1.20/" + id + ".jpg",
    width: 8192,
    height: 4096,
    overview: {
      id: id + ":overview",
      url: "http://192.168.1.20/" + id + "-overview.jpg",
      texW: 64,
      texH: 32,
    },
    tiles: tiles,
  };
}

function freshPlayer() {
  const fetches = [];
  sandbox.__castSend = function (msg) {
    if (msg && msg.type === "fetch") fetches.push({ id: msg.id, token: msg.token, reason: msg.reason || "", at: clock });
  };
  const player = Cast.create(canvas());
  player._focusNow = function () { return clock; };
  player._injectImage = function (payload) { return { label: payload, width: 8, height: 8 }; };
  player._uploadTile = function (img) { return { label: img.label, bytes: 32, _mip: true }; };
  player.fetches = fetches;
  return player;
}

let clock = 0;
const STRIP_MS = 150;
const screen = ["r2c0", "r1c0", "r3c0"];
const six = ["r2c0", "r1c0", "r3c0", "r2c1", "r1c1", "r3c1"];
const poles = ["r0c0", "r4c0", "r0c1", "r4c1"];

function indexOfId(list, id) {
  return list.findIndex(function (item) { return item.id === id; });
}

function pieceReady(player, id) {
  const loaded = player.session && player.session.loaded || [];
  return loaded.some(function (piece) {
    return piece && piece.tile && piece.tile.id === id && piece.tex && !piece.tex.deferred;
  });
}

function stamp(session) {
  if (!session || !session.assemblers) return;
  Object.keys(session.assemblers).forEach(function (id) {
    const box = session.assemblers[id];
    if (box && box._deliverAt == null) box._deliverAt = clock + STRIP_MS;
  });
}

function deliverOne(session) {
  if (!session || !session.assemblers) return false;
  let box = null;
  Object.keys(session.assemblers).forEach(function (id) {
    const candidate = session.assemblers[id];
    if (!candidate || candidate._deliverAt == null || candidate._deliverAt > clock) return;
    if (!box || candidate._deliverAt < box._deliverAt) box = candidate;
  });
  if (!box) return false;
  session.noteChunk({ type: "chunk", id: box.id, token: box.token, i: 0, n: 1, data: box.id });
  return true;
}

const show = freshPlayer();
show.playing = true;
show.manual = false;
const current = hemisphere("ord");
const upcoming = hemisphere("next");
const before = sandbox.__timers.length;
show.setQueue([current, upcoming]);

let standbyDuringSix = 0;
let guard = 0;
while (guard < 30 && !six.every(function (name) { return pieceReady(show, "ord-" + name); })) {
  guard += 1;
  stamp(show.session);
  let soonest = null;
  Object.keys(show.session.assemblers).forEach(function (id) {
    const box = show.session.assemblers[id];
    if (!box || box._deliverAt == null) return;
    if (soonest == null || box._deliverAt < soonest) soonest = box._deliverAt;
  });
  assert(soonest != null, "the pipe stalled before the six strips, fetched " + show.fetches.map(function (item) { return item.id; }).join(","));
  clock = soonest;
  const beforeCount = show.fetches.length;
  assert(deliverOne(show.session), "a due strip did not deliver");
  show.fetches.slice(beforeCount).forEach(function (item) {
    if (item.id.indexOf("next") === 0) standbyDuringSix += 1;
  });
  if (!six.every(function (name) { return pieceReady(show, "ord-" + name); })) show._integrate(1);
}
assert(guard < 30, "the six strips did not finish");
assert(standbyDuringSix === 0, "standby requested " + standbyDuringSix + " times while the six strips were loading");

let poleGuard = 0;
while (poleGuard < 12 && poles.some(function (name) { return show.fetches.every(function (item) { return item.id !== "ord-" + name; }); })) {
  poleGuard += 1;
  stamp(show.session);
  let soonest = null;
  Object.keys(show.session.assemblers || {}).forEach(function (id) {
    const box = show.session.assemblers[id];
    if (!box || box._deliverAt == null) return;
    if (soonest == null || box._deliverAt < soonest) soonest = box._deliverAt;
  });
  if (soonest == null) break;
  clock = soonest;
  if (!deliverOne(show.session)) break;
}
assert(poles.every(function (name) { return show.fetches.some(function (item) { return item.id === "ord-" + name; }); }), "pole caps were not requested: " + show.fetches.map(function (item) { return item.id; }).join(", "));

function askedAt(id) {
  const at = show.fetches.findIndex(function (item) { return item.id === id; });
  assert(at >= 0, "never requested " + id + " (" + show.fetches.map(function (item) { return item.id; }).join(", ") + ")");
  return at;
}
assert(askedAt("ord:overview") < askedAt("ord-r2c0"), "overview is before the front horizon");
assert(askedAt("ord-r2c0") < askedAt("ord-r1c0") && askedAt("ord-r2c0") < askedAt("ord-r3c0"), "the front horizon is before the rest of the TV");
assert(askedAt("ord-r1c0") < askedAt("ord-r2c1") && askedAt("ord-r3c0") < askedAt("ord-r2c1"), "r2c1 must not be requested before the screen");
assert(askedAt("ord-r2c1") < askedAt("ord-r1c1") && askedAt("ord-r2c1") < askedAt("ord-r3c1"), "the incoming horizon is before its side bands");
six.forEach(function (name) {
  poles.forEach(function (pole) {
    assert(askedAt("ord-" + name) < askedAt("ord-" + pole), name + " is requested before " + pole);
  });
});
let frontAt = null;
show.session.loaded.forEach(function (piece) {
  if (!piece || !piece.tile || !piece._uploadedAt) return;
  if (screen.indexOf(piece.tile.id.replace("ord-", "")) < 0) return;
  if (frontAt == null || piece._uploadedAt > frontAt) frontAt = piece._uploadedAt;
});
assert(frontAt != null && frontAt < 650, "front screen downloaded in " + frontAt + "ms");
assert(screen.every(function (name) { return pieceReady(show, "ord-" + name); }), "the front screen is resident");

show._integrate(40);
const standbyFetch = show.fetches.filter(function (item) { return item.id.indexOf("next") === 0; });
assert(standbyFetch.length > 0, "standby preloads once the six strips are in, before the two-turn swap");
assert(show.itemDegrees < Cast.ROTATIONS * 360, "the show has not reached the swap yet, degrees " + show.itemDegrees);

function sharp(piece) {
  return show._revealOf(piece);
}
const frontPieces = screen.map(function (name) {
  return show.session.loaded.filter(function (piece) { return piece.tile && piece.tile.id === "ord-" + name; })[0];
});
assert(frontPieces.every(Boolean), "front pieces are addressable");
let sharpAt = null;
for (let t = clock; t <= 4000; t += 10) {
  clock = t;
  if (frontPieces.every(function (piece) { return sharp(piece) >= 1; })) {
    sharpAt = t;
    break;
  }
}
assert(sharpAt != null && sharpAt < 3000, "front screen is sharp at " + sharpAt + "ms");

const lan = freshPlayer();
lan.setLan(true);
clock = 5000;
const lanMark = sandbox.__timers.length;
lan.setQueue([hemisphere("lan")]);
const probes = sandbox.__timers.slice(lanMark).filter(function (timer) { return timer.ms === Cast.LAN_PROBE_TIMEOUT_MS; });
assert(Cast.LAN_PROBE_TIMEOUT_MS === 5000, "probe budget is " + Cast.LAN_PROBE_TIMEOUT_MS);
assert(Cast.LAN_TIMEOUT_MS === 8000, "a proven LAN waits 8000ms");
assert(Cast.LAN_FAIL_LIMIT === 4, "LAN dies after four misses");
assert(probes.length >= 1, "the first LAN try arms a probe");
assert(probes.every(function (timer) { return timer.ms === 5000; }), "the first try is a 5s probe, not an 8s wait");
const castBefore = lan.fetches.filter(function (item) { return item.reason === "lan"; }).length;
probes[0].fn();
assert(lan._lanDead === false, "the first probe miss does not leave LAN");
assert(lan._lanFailures === 1, "the probe counts as one miss, got " + lan._lanFailures);
const castAfter = lan.fetches.filter(function (item) { return item.reason === "lan"; });
assert(castAfter.length > castBefore, "the probe falls back to a Cast fetch");
if (lan.session && lan.session.hooks && lan.session.hooks.onTileRetry) {
  lan.session.hooks.onTileRetry({ id: "lan-retry" });
  lan.session.hooks.request("lan-retry", 3);
}
assert(lan._lanDead === false, "a tile retry does not kill LAN");
assert(lan.fetches.some(function (item) { return item.id === "lan-retry" && item.reason === "retry"; }), "the retry goes over Cast");

function sessionHarness(timeoutMs) {
  const requests = [];
  let now = 1000;
  let held = null;
  const session = Cast.createSession({
    timeoutMs: timeoutMs || 45000,
    now: function () { return now; },
    request: function (id, token) { requests.push({ id: id, token: token }); },
    view: function () {
      return {
        u: 0.5, v: 0.5, halfU: 0.15, halfV: 0.21,
        yaw: 0, pitch: 0, fov: 75, aspect: 16 / 9,
        lookaheadDeg: 55, panSign: 1, manual: false,
      };
    },
    materialize: function (payload, done) {
      if (String(payload).indexOf("slow:") === 0) {
        held = function () { done(null, { width: 8, height: 8, label: payload }); };
        return;
      }
      if (String(payload).indexOf("fail:") === 0) {
        done(new Error("boom"));
        return;
      }
      done(null, { width: 8, height: 8, label: payload });
    },
    upload: function (img) { return { _mip: true, bytes: 8, label: img.label }; },
    release: function () {},
    onTileRetry: function () { session._sawRetry = (session._sawRetry || 0) + 1; session._lanOff = true; },
  });
  return {
    session: session,
    requests: requests,
    advance: function (ms) { now += ms; session.tick(now); },
    releaseSlow: function () {
      assert(held, "nothing was waiting on decode");
      const finish = held;
      held = null;
      finish();
    },
  };
}

function deliverToken(session, id, token, payload) {
  session.noteChunk({ type: "chunk", id: id, token: token, i: 0, n: 1, data: payload || id });
}

const race = sessionHarness();
const racePhoto = hemisphere("race");
race.session.open(racePhoto);
assert((race.session._openTokens[1] | 0) === 2, "overview and r2c0 both hold token 1, got " + race.session._openTokens[1]);
deliverToken(race.session, "race-r2c0", 1, "slow:race-r2c0");
assert(race.session.assemblers["race-r2c0"] == null, "r2c0 left the assembler for decode");
assert((race.session._openTokens[1] | 0) === 2, "decode must keep the token alive");
deliverToken(race.session, "race:overview", 1, "race-overview");
assert(race.session._overviewReady === true, "the overview applied");
assert((race.session._openTokens[1] | 0) >= 1, "overview finishing must not drop r2c0's token, got " + race.session._openTokens[1]);
race.releaseSlow();
assert(race.session.loaded.some(function (piece) { return piece.tile && piece.tile.id === "race-r2c0"; }), "r2c0 loads after the overview applied first");
assert(racePhoto.tiles.filter(function (tile) { return tile.id === "race-r2c0"; })[0]._skip !== true, "r2c0 was not skipped");

function openAgain(label) {
  const run = sessionHarness();
  run.session.token = 7;
  run.session.open(hemisphere("a"));
  run.session.open(hemisphere(label));
  const lead = run.requests.filter(function (item) { return item.id === label + "-r2c0"; }).pop();
  assert(lead, label + " asked for r2c0");
  assert(lead.token === 1, label + " still asks for the front horizon at token 1, got " + lead.token);
  return run;
}

const pushed = openAgain("push");
deliverToken(pushed.session, "push:overview", 1, "push-overview");
deliverToken(pushed.session, "push-r2c0", 1, "push-r2c0");
assert(pushed.session.loaded.some(function (piece) { return piece.tile && piece.tile.id === "push-r2c0"; }), "token 1 push loads r2c0 on a later open");

const fetched = openAgain("fetch");
const issued = fetched.requests.filter(function (item) { return item.id === "fetch-r2c0"; }).pop();
const box = fetched.session.assemblers["fetch-r2c0"];
assert(box, "r2c0 is in flight");
box.token = issued.token + 5;
fetched.session._openTokens[box.token] = (fetched.session._openTokens[box.token] | 0) + 1;
deliverToken(fetched.session, "fetch:overview", 1, "fetch-overview");
deliverToken(fetched.session, "fetch-r2c0", box.token, "fetch-r2c0");
assert(fetched.session.loaded.some(function (piece) { return piece.tile && piece.tile.id === "fetch-r2c0"; }), "the token the TV fetched also loads r2c0");

const retry = sessionHarness(1000);
let retries = 0;
retry.session.hooks.onTileRetry = function () { retries += 1; retry.session._castRetry = true; };
const retryPhoto = hemisphere("retry");
retry.session.open(retryPhoto);
deliverToken(retry.session, "retry:overview", 1, "retry-overview");
assert(retry.session._overviewReady === true, "overview is up before the horizon stalls");
const horizon = retryPhoto.tiles.filter(function (tile) { return tile.id === "retry-r2c0"; })[0];
retry.advance(1001);
assert(horizon._skip !== true, "the first stall does not skip r2c0");
assert(retries === 1, "the stall retries, got " + retries);
assert(retry.session._castRetry === true, "the retry is marked for Cast");
const again = retry.requests.filter(function (item) { return item.id === "retry-r2c0"; });
assert(again.length >= 2, "r2c0 is requested again, got " + again.length);
deliverToken(retry.session, "retry-r2c0", again[again.length - 1].token, "retry-r2c0");
assert(retry.session.loaded.some(function (piece) { return piece.tile && piece.tile.id === "retry-r2c0"; }), "the Cast retry loads r2c0");
assert(horizon._skip !== true, "a recovered horizon stays in the grid");

const giveUp = sessionHarness(500);
const givePhoto = hemisphere("give");
giveUp.session.open(givePhoto);
deliverToken(giveUp.session, "give:overview", 1, "give-overview");
const anchor = givePhoto.tiles.filter(function (tile) { return tile.id === "give-r2c0"; })[0];
for (let n = 0; n < Cast.TILE_RETRIES; n++) giveUp.advance(501);
assert(anchor._skip !== true, "r2c0 survives " + Cast.TILE_RETRIES + " retries");
giveUp.advance(501);
assert(anchor._skip === true, "r2c0 can be skipped only after the retries");
const child = givePhoto.tiles.filter(function (tile) { return tile.id === "give-r1c0"; })[0];
assert(Cast.fetchUnlocked(child, givePhoto.tiles, 2, function () { return false; }) === true, "a skipped horizon does not deadlock the band above it");
const masters = Cast.activeMasters(givePhoto.tiles, givePhoto.width, givePhoto.height, { u: 0.5, v: 0.5, panSign: 1, lookaheadDeg: 55 }, {
  loaded: function () { return false; },
});
assert(masters.some(function (tile) { return tile.id === "give-r2c1"; }), "the other horizon is still reachable after the anchor is skipped");

assert(Cast.TILE_FADE_MS === 2400, "photo fade stays 2400ms");
assert(Math.abs(Cast.FOCUS_FEATHER - 0.65) < 1e-9, "feather stays 0.65");
assert(Math.abs(Cast.FOCUS_HANDOFF - 0.35) < 1e-9, "handoff stays 0.35");

const storm = freshPlayer();
storm.playing = true;
storm.manual = false;
clock = 20000;
storm.setQueue([hemisphere("stormA"), hemisphere("stormB")]);
let stormGuard = 0;
while (stormGuard < 40 && storm.session && storm.session.pending) {
  stormGuard += 1;
  stamp(storm.session);
  let soonest = null;
  Object.keys(storm.session.assemblers || {}).forEach(function (id) {
    const box = storm.session.assemblers[id];
    if (!box || box._deliverAt == null) return;
    if (soonest == null || box._deliverAt < soonest) soonest = box._deliverAt;
  });
  if (soonest == null) break;
  clock = soonest;
  if (!deliverOne(storm.session)) break;
}
storm._activeBusy = function () { return false; };
for (let kick = 0; kick < 8 && (!storm._standby || !storm._standby.entry); kick++) storm._feedPreload();
let standbyGuard = 0;
while (standbyGuard < 20 && storm._standby && storm._standby.pending) {
  standbyGuard += 1;
  stamp(storm._standby);
  let soonest = null;
  Object.keys(storm._standby.assemblers || {}).forEach(function (id) {
    const box = storm._standby.assemblers[id];
    if (!box || box._deliverAt == null) return;
    if (soonest == null || box._deliverAt < soonest) soonest = box._deliverAt;
  });
  if (soonest == null) break;
  clock = soonest;
  if (!deliverOne(storm._standby)) break;
  storm._feedPreload();
}
assert(storm._standby && storm._standby.entry, "photo 2 started preloading");
storm._standby.budgetFull = true;
storm._standby.preloadCapped = true;
const beforeLoop = storm.fetches.length;
for (let frame = 0; frame < 180; frame++) {
  storm._feedPreload();
  if (storm._standby && storm._standby._requestCurrent) storm._standby._requestCurrent();
}
assert(storm.fetches.length === beforeLoop, "a full GPU does not re-request the same standby strips, grew by " + (storm.fetches.length - beforeLoop));
assert(storm.fetches.length <= 22, "a two-photo show stays within 22 requests, got " + storm.fetches.length);
storm._standby._overviewReady = false;
storm._standby._viewCovered = function () { return false; };
storm._standby.loaded = storm._standby.loaded.filter(function (piece) { return piece && piece.tile && piece.tile._overview; });
storm._standby.budgetFull = true;
const beforeCap = storm.fetches.length;
for (let frame = 0; frame < 120; frame++) storm._feedPreload();
assert(storm.fetches.length === beforeCap, "budget-full with nothing to evict stays paused, grew by " + (storm.fetches.length - beforeCap));

assert(before >= 0, "timer log started");

const heal = freshPlayer();
heal.playing = true;
clock = 1000;
heal.setQueue([hemisphere("healA"), hemisphere("healB")]);
const keptDraw = [{ tex: { id: "on-screen", _mip: true } }];
const keptBases = { healA: { tex: { id: "base" } } };
heal._tileDraw = keptDraw;
heal._bases = keptBases;
heal._diagRequested = 50;
heal._diagUploaded = 10;
heal._decodeQueue = new Array(18).fill({ payload: "j" });
heal._uploadQueue = new Array(18).fill({ img: {}, tile: { id: "queued" } });
heal._decoding = 3;
heal._uploading = true;
heal._lan = true;
heal._lanDead = true;
heal._lanFailures = 4;
heal._lanDeadSince = clock - 20000;
if (heal.session && heal.session.entry && heal.session.entry.tiles[0]) {
  heal.session.entry.tiles[0]._skip = true;
  heal.session.budgetFull = true;
  heal.session.assemblers.stuck = { id: "stuck", gen: heal.session.generation };
}
const notes = [];
sandbox.__castSend = function (msg) { notes.push(msg); };
assert(heal._checkHealthWatchdog() === true, "a request gap over 28 soft-resets");
assert(heal._decodeQueue.length === 0 && heal._decoding === 0, "the decode queue is cleared");
assert(heal._uploadQueue.length === 0 && heal._uploading === false, "the upload queue is cleared");
assert(heal._lanDead === false && heal._lanFailures === 0, "Wi-Fi is armed again after a lockup");
assert(heal._tileDraw === keptDraw && heal._bases === keptBases, "the photo on screen stays where it is");
assert(!heal.session.assemblers.stuck && heal.session.budgetFull === false, "stuck assemblers and the GPU pause are cleared");
assert(heal.session.entry.tiles[0]._skip !== true, "the current photo can request a skipped strip again");
assert(notes.some(function (msg) { return msg && msg.type === "soft-reset" && msg.reason === "tile-backlog"; }), "the phone hears the soft reset");
clock = 2000;
heal._diagRequested = 90;
heal._diagUploaded = 0;
assert(heal._checkHealthWatchdog() === false, "a second lockup inside 8s does not reset again");
const calm = freshPlayer();
calm.playing = true;
clock = 20000;
calm.setQueue([hemisphere("calm")]);
calm._diagRequested = 20;
calm._diagUploaded = 12;
assert(calm._checkHealthWatchdog() === false, "a normal photo is not treated as a lockup");
calm.session.pending = { id: "calm-r2c0", token: 1, started: clock - 11000 };
assert(calm._checkHealthWatchdog() === true, "a tile wedged for more than 10s soft-resets");
const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
assert(page.indexOf('msg.type === "soft-reset"') >= 0, "the receiver page applies a phone soft reset");
assert(page.indexOf('msg.type === "lan"') >= 0, "the receiver page can turn Wi-Fi back on");

assert(Cast.acceptCastMessage({ type: "soft-reset" }).type === "soft-reset", "acceptCastMessage allows soft-reset");
assert(Cast.acceptCastMessage({ type: "lan", enabled: true }).type === "lan", "acceptCastMessage allows lan");
console.log("cast-load-speed ok");
