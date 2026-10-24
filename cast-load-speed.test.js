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

assert(Cast.TILE_FADE_MS === 2400, "TILE_FADE_MS is 2400");
assert(Math.abs(Cast.FOCUS_FEATHER - 0.65) < 1e-9, "FOCUS_FEATHER is 0.65");
assert(Math.abs(Cast.FOCUS_HANDOFF - 0.35) < 1e-9, "FOCUS_HANDOFF is 0.35");
assert(Cast.LAN_PROBE_TIMEOUT_MS === 5000, "probe budget is " + Cast.LAN_PROBE_TIMEOUT_MS);
assert(Cast.LAN_TIMEOUT_MS === 8000, "LAN timeout is " + Cast.LAN_TIMEOUT_MS);
assert(Cast.LAN_FAIL_LIMIT === 4, "LAN fail limit is " + Cast.LAN_FAIL_LIMIT);

const lan = freshPlayer();
lan.setLan(true);
clock = 5000;
const lanMark = sandbox.__timers.length;
lan.setQueue([hemisphere("lan")]);
const probes = sandbox.__timers.slice(lanMark).filter(function (timer) { return timer.ms === Cast.LAN_PROBE_TIMEOUT_MS; });
assert(probes.length >= 2, "the initial LAN fetches arm probes");
const castBefore = lan.fetches.filter(function (item) { return item.reason === "lan"; }).length;
probes[0].fn();
assert(lan._lanDead === false, "a single slow LAN fetch falls back to Cast for that tile only and does not set _lanDead");
assert(lan._lanFailures === 1, "failure count is 1 after one timeout");
const castAfter = lan.fetches.filter(function (item) { return item.reason === "lan"; });
assert(castAfter.length === castBefore + 1, "only that timed-out tile falls back to a Cast fetch");
// 3 more consecutive LAN misses reach LAN_FAIL_LIMIT (4) and set _lanDead = true
probes[1].fn();
assert(lan._lanDead === false && lan._lanFailures === 2, "2 consecutive failures still keep LAN alive");
lan._loadLan("lan-r1c0", 3, "http://192.168.1.20/lan/1/0.jpg");
sandbox.__timers[sandbox.__timers.length - 1].fn();
assert(lan._lanDead === false && lan._lanFailures === 3, "3 consecutive failures still keep LAN alive");
lan._loadLan("lan-r3c0", 4, "http://192.168.1.20/lan/3/0.jpg");
sandbox.__timers[sandbox.__timers.length - 1].fn();
assert(lan._lanDead === true && lan._lanFailures === 4, "_lanDead becomes true after LAN_FAIL_LIMIT = 4 consecutive failures");

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

// Verify single tile retry does not kill LAN for the rest of the show
const retryLan = freshPlayer();
retryLan.setLan(true);
retryLan.setQueue([hemisphere("rlan")]);
assert(retryLan._lanDead === false, "LAN starts alive");
const rlanTile = retryLan.session.entry.tiles[0];
const rlanBox = { id: rlanTile.id, token: 2, gen: retryLan.session.generation, tile: rlanTile, _tokenHeld: false };
retryLan.session._skipTile(rlanBox, "stall");
assert(retryLan._lanDead === false, "a single tile retry uses Cast for that retry without killing _lanDead");
assert(retryLan.fetches.some(function (item) { return item.id === rlanTile.id; }), "the retry was sent over Cast");

// Verify 120 frames when _gpuBytes is near GPU_CAP and standby is view-ready or budget-full do NOT loop-request
const capShow = freshPlayer();
capShow.playing = true;
capShow.manual = false;
capShow.setQueue([hemisphere("capA"), hemisphere("capB")]);
while (capShow.session && capShow.session.pending) {
  stamp(capShow.session);
  clock += STRIP_MS;
  deliverOne(capShow.session);
}
capShow._integrate(16);
assert(capShow._standby && capShow._standby.entry, "standby started for capB");
// Deliver overview + opening view (r2c0, r1c0, r3c0) on standby, then simulate GPU_CAP full on r2c1
while (capShow._standby.pending) {
  const pid = capShow._standby.pending.id;
  if (pid === "capB:overview" || pid === "capB-r2c0" || pid === "capB-r1c0" || pid === "capB-r3c0") {
    capShow._standby.noteChunk({ type: "chunk", id: pid, token: capShow._standby.pending.token, i: 0, n: 1, data: pid });
  } else {
    break;
  }
}
assert(Cast.swapReady(capShow._standby) === true, "standby is view-ready");
capShow._gpuBytes = Cast.GPU_CAP - 4 * 1024 * 1024;
capShow._uploadTile = function (img, tile, standby) {
  if (standby) return capShow._deferred(img, tile);
  return { label: img.label, bytes: 32, _mip: true };
};
if (capShow._standby.pending) {
  const defPending = capShow._standby.pending;
  capShow._standby.noteChunk({ type: "chunk", id: defPending.id, token: defPending.token, i: 0, n: 1, data: defPending.id });
}
assert(capShow._standby.budgetFull === true, "standby marked budgetFull when GPU_CAP is full");
const requestedAtCap = capShow._diagRequested;
for (let frame = 0; frame < 120; frame++) {
  clock += 16;
  capShow._feedPreload();
  capShow._pumpFrame(16);
}
const extraRequests = capShow._diagRequested - requestedAtCap;
assert(extraRequests <= 4, "120 frames near GPU_CAP must not storm requests, extra=" + extraRequests + " total=" + capShow._diagRequested);
assert(capShow._diagRequested < 40, "total requested stays bounded (" + capShow._diagRequested + "), never climbing to 50+ or 282");

// Verify softReset() and _checkHealthWatchdog() self-healing behavior
const healSent = [];
const heal = freshPlayer();
sandbox.__castSend = function (msg) {
  if (msg) healSent.push(msg);
};
heal.setLan(true);
heal.setQueue([hemisphere("healA"), hemisphere("healB")]);
while (heal.session && heal.session.pending) {
  stamp(heal.session);
  clock += STRIP_MS;
  deliverOne(heal.session);
}
heal._presented = true;
heal.yaw = 123;
heal.pitch = 15;
heal.fov = 65;
const drawnBeforeHeal = heal._tileDraw.length;
assert(drawnBeforeHeal > 0, "healA has live tiles on screen");
// Simulate a wedged storm state
heal._lanDead = true;
heal._lanDeadAt = clock - 5000;
heal._lanFailures = 4;
heal._diagRequested = 282;
heal._diagReceived = 269;
heal._diagDecoded = 118;
heal._diagUploaded = 100;
heal._diagErrors = 3;
for (let q = 0; q < 20; q++) {
  heal._decodeQueue.push({ payload: "wedged", done: function () {} });
  heal._uploadQueue.push({ img: {}, tile: {}, standby: true, done: function () {} });
}
const triggered = heal._checkHealthWatchdog(clock);
assert(triggered === true, "watchdog triggers softReset on 282/100 request storm");
assert(heal._decodeQueue.length === 0, "softReset flushes _decodeQueue");
assert(heal._uploadQueue.length === 0, "softReset flushes _uploadQueue");
assert(heal._standby === null && heal._back === null, "softReset disposes standby/back sessions");
assert(heal._lanDead === false && heal._lanFailures === 0, "softReset restores direct Wi-Fi LAN mode");
assert(heal.index === 0 && heal.entries.length === 2, "softReset preserves queue and photo index");
assert(heal.yaw === 123 && heal.pitch === 15 && heal.fov === 65, "softReset preserves camera aim");
assert(heal._tileDraw.length === drawnBeforeHeal, "softReset keeps on-screen textures so TV never flashes black");
assert(heal._diagErrors === 0 && heal._diagNote === "Soft-reset: restored normal mode", "softReset resets diagnostic error state");
assert(heal._diagRequested === drawnBeforeHeal && heal._diagUploaded === drawnBeforeHeal, "softReset resets storm counters to live tile count");
assert(healSent.some(function (m) { return m.type === "soft-reset" && m.reason === "request-storm"; }), "softReset notifies phone to flush outbound chunk backlog");
// Cooldown prevents back-to-back softReset within 8s
heal._diagRequested = 200;
assert(heal._checkHealthWatchdog(clock + 2000) === false, "watchdog respects 8s cooldown");
assert(heal._checkHealthWatchdog(clock + 9000) === true, "watchdog fires again after 8s cooldown if storm recurs");
// Degraded LAN auto-recovery after 12s
heal._lanDead = true;
heal._lanDeadAt = clock + 9000;
heal._lanFailures = 4;
heal._checkHealthWatchdog(clock + 22000);
assert(heal._lanDead === false && heal._lanFailures === 0, "watchdog re-arms LAN after 12s on Cast fallback");
assert(Cast.acceptCastMessage({ type: "soft-reset" }).type === "soft-reset", "inbound soft-reset Cast message is accepted");

assert(before >= 0, "timer log started");
console.log("cast-load-speed ok");
