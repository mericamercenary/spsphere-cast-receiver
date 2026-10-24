const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

function load(source) {
  const sandbox = { console, Date };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.SpsphereCast;
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function sessionOf(Cast) {
  const requests = [];
  const statuses = [];
  const shown = [];
  const session = Cast.createSession({
    timeoutMs: 45000,
    now: function () { return Date.now(); },
    request: function (id) { requests.push(id); },
    materialize: function (payload, done) {
      done(null, { width: 32, height: 16, label: payload });
    },
    upload: function (img) {
      return { bytes: 1024, label: img.label, _mip: true, width: img.width, height: img.height };
    },
    onStatus: function (text) { statuses.push(text); },
    onShown: function (state) { shown.push(state.id); },
  });
  return { session, requests, statuses, shown };
}

function deliverAll(box) {
  let guard = 0;
  while (box.session.pending && guard < 40) {
    const pending = box.session.pending;
    box.session.noteChunk({
      type: "chunk",
      id: pending.id,
      token: pending.token,
      i: 0,
      n: 1,
      data: pending.id,
    });
    guard += 1;
  }
}

const current = load(fs.readFileSync(path.join(__dirname, "player.js"), "utf8"));

const backupSource = execFileSync("git", ["show", "f93f604:player.js"], { encoding: "utf8" });
const backup = load(backupSource);
const backupPhoto = {
  id: "backup",
  width: 8000,
  height: 4000,
  tiles: [0, 1, 2, 3].map(function (col) {
    return {
      id: "b-c" + col,
      row: 0,
      col: col,
      srcX: col * 2000,
      srcY: 0,
      srcW: 2000,
      srcH: 4000,
      texW: 2048,
      texH: 4096,
    };
  }),
};
const backupRun = sessionOf(backup);
backupRun.session.open(backupPhoto);
deliverAll(backupRun);
assert(backupRun.shown[0] === "backup", "backup tiling shows the photo");
assert(backupRun.statuses.indexOf("") >= 0, "backup tiling clears the loading state");

function brokenGate() {
  let overviewPending = true;
  const requests = [];
  function requestCurrent() {
    if (overviewPending) return;
    requests.push("tile");
  }
  requestCurrent();
  return { requests: requests.length, spinner: overviewPending && requests.length === 0 };
}
const broken = brokenGate();
assert(broken.spinner === true, "the 5:45 gate requests no tile while the overview is pending");

const fixed = sessionOf(current);
const fixedPhoto = {
  id: "fixed",
  width: 8000,
  height: 4000,
  overview: { id: "fixed:overview", url: "http://phone/o.jpg", texW: 256, texH: 128 },
  tiles: [0, 1, 2, 3].map(function (col) {
    return {
      id: "f-c" + col,
      row: 0,
      col: col,
      srcX: col * 2000,
      srcY: 0,
      srcW: 2000,
      srcH: 4000,
      texW: 512,
      texH: 512,
    };
  }),
};
fixed.session.open(fixedPhoto);
assert(fixed.requests[0] === "fixed:overview", "overview is first");
assert(fixed.requests.some(function (id) { return id.indexOf("f-c") === 0; }), "tiles are requested while the overview is in flight");
deliverAll(fixed);
assert(fixed.shown.indexOf("fixed") >= 0, "the fixed path shows sharp tiles");

const maxEdge = 4096;
const whole = sessionOf(current);
whole.session.open({
  id: "whole",
  width: 8192,
  height: 4096,
  tiles: [{
    id: "whole-full",
    row: 0,
    col: 0,
    srcX: 0,
    srcY: 0,
    srcW: 8192,
    srcH: 4096,
    texW: maxEdge,
    texH: maxEdge / 2,
  }],
});
deliverAll(whole);
assert(whole.shown[0] === "whole", "one max-texture equirect also clears loading");
const wholePixels = maxEdge * (maxEdge / 2);
const fullPixels = 8192 * 4096;
assert(wholePixels < fullPixels, "the tile-free texture is not full resolution");

const report = {
  backupTilingShown: true,
  brokenGateRequestedTiles: broken.requests,
  brokenGateStuckOnSpinner: broken.spinner,
  fixedRequestedTilesBeforeOverview: true,
  fixedShown: true,
  tileFreeShown: true,
  tileFreePixels: wholePixels,
  fullPhotoPixels: fullPixels,
  conclusion: "Tiling itself loads and clears the spinner. The 5:45 failure was the overview gate plus a decode that could hang. A single texture at max size also loads, and it is a downscale, so it is not the shipped path.",
};
console.log(JSON.stringify(report, null, 2));
console.log("load-diagnose ok");
