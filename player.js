/* SPsphere Cast receiver player.
   Two full yaw turns at the horizon, then a crossfade.
   One photo keeps turning. Numbers match CastTiming.kt.
   Manual aim is an absolute pose. The TV springs toward it.
   GPano PosePitchDegrees and PoseRollDegrees level the sphere before that
   look, matching ProjectionMath.applyPose. The phone bakes cubemaps to
   equirect JPEGs with the standard face orientation, so this page samples
   equirects only. */
(function (root) {
  var ROTATIONS = 2;
  var FULL_TURN = 360;
  var DEFAULT_DPS = 18;
  var CROSSFADE_MS = 1200;
  var MIN_DPS = 6;
  var MAX_DPS = 72;
  var OMEGA = 40;
  var MIN_FOV = 20;
  var MAX_FOV = 120;

  function clampSpeed(v) {
    v = Number(v) || DEFAULT_DPS;
    if (v < MIN_DPS) return MIN_DPS;
    if (v > MAX_DPS) return MAX_DPS;
    return v;
  }

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function wrap360(v) {
    var m = v % FULL_TURN;
    return m < 0 ? m + FULL_TURN : m;
  }

  function shortest(delta) {
    var wrapped = wrap360(delta + 180) - 180;
    return wrapped === -180 ? 180 : wrapped;
  }

  function num(v, fallback) {
    var n = Number(v);
    return n === n ? n : fallback;
  }

  function isNewer(seq, last) {
    if (last < 0) return true;
    return (((seq - last) | 0) > 0);
  }

  function Player(canvas) {
    this.canvas = canvas;
    this.items = [];
    this.images = [];
    this.poses = [];
    this.index = 0;
    this.playing = false;
    this.phase = "pan";
    this.speed = DEFAULT_DPS;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.fov = 75;
    this.manual = false;
    this.held = false;
    this.ids = [];
    this._panBlend = 1;
    this.itemDegrees = 0;
    this.fadeMs = 0;
    this.fade = 0;
    this.fromIndex = 0;
    this._raf = 0;
    this._last = 0;
    this._gl = null;
    this._mode = "2d";
    this._tex = [];
    this._loaded = 0;
    this._hudAt = 0;
    this._hudText = "";
    this._anchored = false;
    this._lastSeq = -1;
    this._tyaw = 0;
    this._tpitch = 0;
    this._troll = 0;
    this._tfov = 75;
    this._vy = 0;
    this._vp = 0;
    this._vr = 0;
    this._vf = 0;
    this._baseYaw = 0;
    this._basePitch = 0;
    this._baseRoll = 0;
    this._baseFov = 75;
    this._oYaw = 0;
    this._oPitch = 0;
    this._oRoll = 0;
    this._oFov = 75;
    this._omega2 = OMEGA * OMEGA;
    this._damp = 2 * OMEGA;
    this._stepDelta = 0;
    this._stepVel = 0;
    this._echo = new ArrayBuffer(16);
    this._echoView = new DataView(this._echo);
    this._m0 = new Float32Array(16);
    this._m1 = new Float32Array(16);
    this._m2 = new Float32Array(16);
    this._proj = new Float32Array(16);
    this._view = new Float32Array(16);
    this._mvp = new Float32Array(16);
    this._setup();
  }

  Player.prototype.snapshot = function () {
    return {
      index: this.index,
      count: this.items.length,
      playing: this.playing,
      phase: this.phase,
      speed: this.speed,
      yaw: this.yaw,
      pitch: this.pitch,
      fov: this.fov,
      manual: this.manual,
      itemDegrees: this.itemDegrees,
      fade: this.phase === "fade" ? Math.max(0, Math.min(1, this.fadeMs / CROSSFADE_MS)) : 0,
      single: this.items.length <= 1,
    };
  };

  Player.prototype._resetAim = function () {
    this.manual = false;
    this._anchored = false;
    this._lastSeq = -1;
    this.pitch = 0;
    this.roll = 0;
    this.fov = 75;
    this._tyaw = 0;
    this._tpitch = 0;
    this._troll = 0;
    this._tfov = 75;
    this._vy = 0;
    this._vp = 0;
    this._vr = 0;
    this._vf = 0;
  };

  Player.prototype._loadEntry = function (entry) {
    var self = this;
    var img = new Image();
    if (needsCors(entry.url)) img.crossOrigin = "anonymous";
    img.onload = function () {
      self._loaded += 1;
      self._upload(img);
      self.draw();
    };
    img.referrerPolicy = "no-referrer";
    img.src = entry.url;
    return img;
  };

  Player.prototype.setQueue = function (urls) {
    var entries = normalizeEntries(urls);
    var self = this;
    this.ids = entries.map(function (entry) { return entry.id; });
    this.items = entries.map(function (entry) { return entry.url; });
    this.poses = entries.map(poseOf);
    this._loaded = 0;
    this._tex = [];
    this.images = entries.map(function (entry) {
      self._tex.push(null);
      return self._loadEntry(entry);
    });
    this.index = 0;
    this.fromIndex = 0;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this.itemDegrees = 0;
    this.yaw = 0;
    this._panBlend = 1;
    this.held = false;
    this._resetAim();
    this.playing = this.items.length > 0;
    this._last = 0;
    this._preloadAround();
    this._mark();
    this.draw();
  };

  Player.prototype.appendItems = function (urls) {
    var entries = normalizeEntries(urls);
    var self = this;
    entries.forEach(function (entry) {
      self.ids.push(entry.id);
      self.items.push(entry.url);
      self.poses.push(poseOf(entry));
      self._tex.push(null);
      self.images.push(self._loadEntry(entry));
    });
    this._preloadAround();
  };

  Player.prototype.removeId = function (id) {
    var at = this.ids.indexOf(String(id));
    if (at < 0 || this.ids.length < 2) return false;
    var current = this.ids[this.index];
    this.ids.splice(at, 1);
    this.items.splice(at, 1);
    this.images.splice(at, 1);
    this.poses.splice(at, 1);
    this._tex.splice(at, 1);
    if (current === String(id)) {
      this.index = Math.min(at, this.ids.length - 1);
      this.itemDegrees = 0;
    } else {
      this.index = this.ids.indexOf(current);
    }
    this.fromIndex = this.index;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this._preloadAround();
    this.draw();
    return true;
  };

  Player.prototype.moveId = function (id, to) {
    var from = this.ids.indexOf(String(id));
    if (from < 0) return false;
    to = Math.max(0, Math.min(this.ids.length - 1, to | 0));
    if (from === to) return true;
    var current = this.ids[this.index];
    function shift(list) {
      var item = list.splice(from, 1)[0];
      list.splice(to, 0, item);
    }
    shift(this.ids);
    shift(this.items);
    shift(this.images);
    shift(this.poses);
    shift(this._tex);
    this.index = this.ids.indexOf(current);
    this.fromIndex = this.index;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this._preloadAround();
    this.draw();
    return true;
  };

  Player.prototype.gotoId = function (id) {
    var at = this.ids.indexOf(String(id));
    if (at < 0) return false;
    this.index = at;
    this.fromIndex = at;
    this.phase = "pan";
    this.fade = 0;
    this.fadeMs = 0;
    this.itemDegrees = 0;
    this._preloadAround();
    this.draw();
    return true;
  };

  Player.prototype.setSpeed = function (dps) { this.speed = clampSpeed(dps); };

  Player.prototype.play = function () {
    var easeIn = this.manual || !this.playing;
    this.manual = false;
    this.held = false;
    this._anchored = false;
    this._tpitch = 0;
    this._troll = 0;
    this._tfov = 75;
    if (easeIn) this._panBlend = 0;
    if (this.items.length) this.playing = true;
    this._mark();
    this._kick();
  };

  Player.prototype.pause = function (held) {
    this.playing = false;
    if (held) this.held = true;
    this._mark();
  };

  Player.prototype._mark = function () {
    var icon = document.getElementById("hold");
    if (!icon) return;
    icon.hidden = !this.held;
  };

  Player.prototype.halt = function () {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  };

  Player.prototype.stop = function () {
    this.playing = false;
    this.held = false;
    this._panBlend = 1;
    this._mark();
    this.index = 0;
    this.fromIndex = 0;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this.itemDegrees = 0;
    this.yaw = 0;
    this._resetAim();
    this.draw();
  };

  Player.prototype.next = function () { return this._jump(1); };
  Player.prototype.previous = function () { return this._jump(-1); };
  Player.prototype.skip = function (delta) { return this._jump(delta); };

  Player.prototype._jump = function (delta) {
    var count = this.items.length;
    var at = stepIndex(this.index, count, delta, count > 1);
    if (at == null) return false;
    this.index = at;
    this.fromIndex = at;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this.itemDegrees = 0;
    if (this.manual) {
      this.playing = false;
    } else if (this.held || !this.playing) {
      var held = this.held;
      this.yaw = 0;
      this._panBlend = 1;
      this._resetAim();
      this.held = held;
      this.playing = false;
    } else {
      this.yaw = 0;
      this._panBlend = 1;
      this._resetAim();
      this.playing = count > 0;
      this._kick();
    }
    this._preloadAround();
    this._mark();
    this.draw();
    if (window.__onCastStatus) window.__onCastStatus(this.snapshot());
    return true;
  };

  Player.prototype._preloadAround = function () {
    var count = this.items.length;
    if (count <= 1) return;
    var self = this;
    [-1, 1].forEach(function (delta) {
      var at = stepIndex(self.index, count, delta, true);
      if (at == null) return;
      var img = self.images[at];
      if (!img || img._neighborReady) return;
      if (img.complete && img.width) {
        img._neighborReady = true;
        if (!self._tex[at]) self._upload(img);
        return;
      }
      if (typeof img.decode === "function") {
        img._neighborReady = true;
        img.decode().then(function () {
          if (!self._tex[at]) self._upload(img);
        }).catch(function () {});
      }
    });
  };

  Player.prototype._changed = function (before) {
    if (before !== this.index + ":" + this.phase && window.__onCastStatus) {
      window.__onCastStatus(this.snapshot());
    }
  };

  Player.prototype._integrate = function (dtMs) {
    if (!this.playing || !this.items.length || dtMs <= 0 || this.manual) return;
    var before = this.index + ":" + this.phase;
    var ramp = 1;
    if (this._panBlend < 1) {
      this._panBlend += dtMs / 1400;
      if (this._panBlend > 1) this._panBlend = 1;
      var t = this._panBlend;
      ramp = t * t * (3 - 2 * t);
    }
    var step = this.speed * ramp * dtMs / 1000;
    this.yaw = wrap360(this.yaw + step);
    if (this.phase === "fade") {
      this.fadeMs += dtMs;
      this.fade = Math.max(0, Math.min(1, this.fadeMs / CROSSFADE_MS));
      if (this.fadeMs >= CROSSFADE_MS) {
        this.phase = "pan";
        this.fadeMs = 0;
        this.fade = 0;
        this.itemDegrees = 0;
        this.fromIndex = this.index;
      }
      this._changed(before);
      return;
    }
    this.fade = 0;
    this.itemDegrees += step;
    if (this.items.length >= 2 && this.itemDegrees >= ROTATIONS * FULL_TURN) {
      this.fromIndex = this.index;
      this.index = (this.index + 1) % this.items.length;
      this.phase = "fade";
      this.fadeMs = 0;
      this.fade = 0;
      this.itemDegrees = ROTATIONS * FULL_TURN;
    }
    this._changed(before);
  };

  Player.prototype.advance = function (dtMs) {
    if (!this.playing || !this.items.length || dtMs <= 0) return this.snapshot();
    this._integrate(dtMs);
    this.draw();
    return this.snapshot();
  };

  Player.prototype._approach = function (delta, vel, dt) {
    var accel = this._omega2 * delta - this._damp * vel;
    var next = vel + accel * dt;
    this._stepDelta = next * dt;
    this._stepVel = next;
  };

  Player.prototype._ease = function (dtMs) {
    var dt = dtMs / 1000;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) return;
    if (this.manual) {
      this._approach(shortest(this._tyaw - this.yaw), this._vy, dt);
      this.yaw = wrap360(this.yaw + this._stepDelta);
      this._vy = this._stepVel;
    } else {
      this._tpitch = 0;
      this._troll = 0;
      this._tfov = 75;
    }
    this._approach(this._tpitch - this.pitch, this._vp, dt);
    this.pitch = clamp(this.pitch + this._stepDelta, -89, 89);
    this._vp = this._stepVel;
    this._approach(this._troll - this.roll, this._vr, dt);
    this.roll += this._stepDelta;
    this._vr = this._stepVel;
    this._approach(this._tfov - this.fov, this._vf, dt);
    this.fov = clamp(this.fov + this._stepDelta, MIN_FOV, MAX_FOV);
    this._vf = this._stepVel;
  };

  Player.prototype.stepAim = function (dtMs) {
    this._ease(dtMs);
  };

  Player.prototype.applyAim = function (msg) {
    if (!msg) return false;
    var seq = num(msg.seq, 0) >>> 0;
    if (!isNewer(seq, this._lastSeq)) return false;
    this._lastSeq = seq;
    var yaw = num(msg.yaw, 0);
    var pitch = num(msg.pitch, 0);
    var roll = num(msg.roll, 0);
    var fov = num(msg.fov, 75);
    if (msg.anchor || !this._anchored) {
      this._baseYaw = this.yaw;
      this._basePitch = this.pitch;
      this._baseRoll = this.roll;
      this._baseFov = this.fov;
      this._oYaw = yaw;
      this._oPitch = pitch;
      this._oRoll = roll;
      this._oFov = fov;
      this._anchored = true;
      this._vy = 0;
      this._vp = 0;
      this._vr = 0;
      this._vf = 0;
    }
    this._tyaw = wrap360(this._baseYaw + shortest(yaw - this._oYaw));
    // Pitch and roll are gravity on the phone. Yaw stays anchored so the TV
    // does not spin to the phone's compass when aiming starts.
    this._tpitch = clamp(pitch, -90, 90);
    this._troll = roll;
    this._tfov = clamp(this._baseFov + (fov - this._oFov), MIN_FOV, MAX_FOV);
    this.manual = true;
    this.playing = false;
    this._kick();
    return true;
  };

  Player.prototype.encodeEcho = function (seq, ts) {
    var view = this._echoView;
    view.setUint8(0, 2);
    view.setUint8(1, 0);
    view.setUint16(2, 0, true);
    view.setUint32(4, seq >>> 0, true);
    view.setFloat64(8, Number(ts) || 0, true);
    return this._echo;
  };

  Player.prototype._kick = function () {
    var self = this;
    if (this._raf) return;
    var loop = function (t) {
      self._raf = requestAnimationFrame(loop);
      if (!self._last) self._last = t;
      var dt = t - self._last;
      self._last = t;
      if (dt > 100) dt = 100;
      self._ease(dt);
      if (self.playing && !self.manual) self._integrate(dt);
      self.draw();
    };
    this._raf = requestAnimationFrame(loop);
  };

  Player.prototype._setup = function () {
    var gl = this.canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return;
    var vs = "attribute vec3 aPos;attribute vec2 aUv;uniform mat4 uMvp;varying vec3 vObj;void main(){vObj=aPos;gl_Position=uMvp*vec4(aPos,1.0);}";
    var fs = [
      "precision mediump float;",
      "varying vec3 vObj;",
      "uniform sampler2D uA;uniform sampler2D uB;uniform float uFade;",
      "uniform float uPitchA;uniform float uRollA;uniform float uPitchB;uniform float uRollB;",
      "const float PI=3.141592653589793;const float TWO_PI=6.283185307179586;",
      "vec3 poseToCamera(vec3 v,float pitch,float roll){",
      "  vec3 n=vec3(v.x,-v.z,v.y);",
      "  float cp=cos(pitch);float sp=sin(pitch);float cr=cos(roll);float sr=sin(roll);",
      "  vec3 p=vec3(n.x,cp*n.y+sp*n.z,-sp*n.y+cp*n.z);",
      "  vec3 c=vec3(cr*p.x-sr*p.z,p.y,sr*p.x+cr*p.z);",
      "  return vec3(c.x,c.z,-c.y);",
      "}",
      "vec2 equirectUv(vec3 d){",
      "  float lon=length(d.xz)<1e-5?0.0:atan(d.x,-d.z);",
      "  float lat=asin(clamp(d.y,-1.0,1.0));",
      "  return vec2(fract(0.5+lon/TWO_PI),clamp(0.5-lat/PI,0.0,1.0));",
      "}",
      "void main(){",
      "  vec3 dir=normalize(vObj);",
      "  vec4 a=texture2D(uA,equirectUv(poseToCamera(dir,uPitchA,uRollA)));",
      "  vec4 b=texture2D(uB,equirectUv(poseToCamera(dir,uPitchB,uRollB)));",
      "  gl_FragColor=mix(a,b,uFade);",
      "  if(gl_FragColor.a<0.05)gl_FragColor=vec4(0.04,0.05,0.07,1.0);",
      "}",
    ].join("");
    var prog = link(gl, vs, fs);
    if (!prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    this._gl = gl;
    this._mode = "webgl";
    gl.useProgram(prog);
    this._prog = prog;
    this._loc = {
      mvp: gl.getUniformLocation(prog, "uMvp"),
      fade: gl.getUniformLocation(prog, "uFade"),
      a: gl.getUniformLocation(prog, "uA"),
      b: gl.getUniformLocation(prog, "uB"),
      pitchA: gl.getUniformLocation(prog, "uPitchA"),
      rollA: gl.getUniformLocation(prog, "uRollA"),
      pitchB: gl.getUniformLocation(prog, "uPitchB"),
      rollB: gl.getUniformLocation(prog, "uRollB"),
    };
    var mesh = sphere(48, 64);
    this._count = mesh.count;
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.interleaved, gl.STATIC_DRAW);
    var stride = 20;
    var p = gl.getAttribLocation(prog, "aPos");
    var u = gl.getAttribLocation(prog, "aUv");
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 3, gl.FLOAT, false, stride, 0);
    if (u >= 0) {
      gl.enableVertexAttribArray(u);
      gl.vertexAttribPointer(u, 2, gl.FLOAT, false, stride, 12);
    }
    var ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.04, 0.05, 0.07, 1);
    this._blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 24, 32, 255]));
  };

  Player.prototype._upload = function (img) {
    if (!this._gl || !img.width) return;
    var gl = this._gl;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } catch (error) {
      this._uploadError = String(error);
    }
    var i = this.images.indexOf(img);
    if (i >= 0) this._tex[i] = tex;
  };

  Player.prototype.draw = function () {
    resize(this.canvas);
    if (this._mode === "webgl" && this._gl) this._drawGl();
    else this._draw2d();
    var now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (now - this._hudAt < 200) return;
    this._hudAt = now;
    var hud = document.getElementById("hud");
    if (!hud) return;
    var text = "photo " + (this.index + 1) + " of " + Math.max(this.items.length, 1) +
      " · " + Math.round(this.yaw) + "° · " + this.phase +
      (this.items.length <= 1 ? " · looping" : "") +
      (this.manual ? " · manual" : "") +
      " · " + this._mode +
      " · img " + this._loaded + "/" + this.images.length;
    if (text !== this._hudText) {
      this._hudText = text;
      hud.textContent = text;
    }
  };

  Player.prototype._drawGl = function () {
    var gl = this._gl;
    var w = this.canvas.width;
    var h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    fillPerspective(this._proj, this.fov, w / Math.max(h, 1), 0.05, 20);
    fillAimView(this._m0, this._m1, this._m2, this._view, this.yaw, this.pitch, this.roll);
    multiplyInto(this._mvp, this._proj, this._view);
    gl.uniformMatrix4fv(this._loc.mvp, false, this._mvp);
    gl.uniform1f(this._loc.fade, this.fade);
    var from = this.phase === "fade" ? this.fromIndex : this.index;
    var fromPose = this.poses[from] || ZERO_POSE;
    var toPose = this.poses[this.index] || ZERO_POSE;
    gl.uniform1f(this._loc.pitchA, fromPose.pitch);
    gl.uniform1f(this._loc.rollA, fromPose.roll);
    gl.uniform1f(this._loc.pitchB, toPose.pitch);
    gl.uniform1f(this._loc.rollB, toPose.roll);
    gl.uniform1i(this._loc.a, 0);
    gl.uniform1i(this._loc.b, 1);
    bindTex(gl, gl.TEXTURE0, this._tex[from] || this._blank);
    bindTex(gl, gl.TEXTURE1, this._tex[this.index] || this._blank);
    gl.drawElements(gl.TRIANGLES, this._count, gl.UNSIGNED_SHORT, 0);
  };

  Player.prototype._draw2d = function () {
    var ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    var w = this.canvas.width || 960;
    var h = this.canvas.height || 540;
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);
    var from = this.images[this.phase === "fade" ? this.fromIndex : this.index];
    var to = this.images[this.index];
    drawStrip(ctx, from, this.yaw, this.pitch, this.fov, w, h, 1);
    if (this.fade > 0 && to) {
      ctx.globalAlpha = this.fade;
      drawStrip(ctx, to, this.yaw, this.pitch, this.fov, w, h, 1);
      ctx.globalAlpha = 1;
    }
  };

  function normalizeEntries(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (typeof item === "string") out.push({ id: item, url: item, posePitch: 0, poseRoll: 0 });
      else if (item && item.url) {
        out.push({
          id: item.id != null ? String(item.id) : item.url,
          url: item.url,
          posePitch: num(item.posePitch, 0),
          poseRoll: num(item.poseRoll, 0),
        });
      }
    }
    return out;
  }

  function stepIndex(index, count, delta, loops) {
    if (count <= 1 || !delta) return null;
    var raw = index + delta;
    if (loops) return ((raw % count) + count) % count;
    if (raw < 0 || raw >= count) return null;
    return raw;
  }

  function decodeSkip(buffer) {
    if (!buffer) return null;
    var length = buffer.byteLength != null ? buffer.byteLength : buffer.length;
    if (!length || length < 8) return null;
    var view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, length);
    if (view.getUint8(0) !== 3) return null;
    var dir = view.getUint8(1);
    if (dir === 1) return 1;
    if (dir === 2) return -1;
    return null;
  }

  function decodeAim(buffer) {
    if (!buffer || buffer.byteLength < 32) return null;
    var view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length);
    if (view.getUint8(0) !== 1) return null;
    return {
      seq: view.getUint32(4, true),
      yaw: view.getFloat32(8, true),
      pitch: view.getFloat32(12, true),
      roll: view.getFloat32(16, true),
      fov: view.getFloat32(20, true),
      ts: view.getFloat64(24, true),
      anchor: (view.getUint8(1) & 1) !== 0,
    };
  }

  var ZERO_POSE = { pitch: 0, roll: 0 };

  function poseOf(entry) {
    return {
      pitch: (Number(entry.posePitch) || 0) * Math.PI / 180,
      roll: (Number(entry.poseRoll) || 0) * Math.PI / 180,
    };
  }

  function applyPose(dir, pitchRad, rollRad) {
    var x = dir[0];
    var y = dir[1];
    var z = dir[2];
    if (!pitchRad && !rollRad) return [x, y, z];
    var nx = x;
    var ny = -z;
    var nz = y;
    var cp = Math.cos(pitchRad);
    var sp = Math.sin(pitchRad);
    var cr = Math.cos(rollRad);
    var sr = Math.sin(rollRad);
    var py = cp * ny + sp * nz;
    var pz = -sp * ny + cp * nz;
    var cx = cr * nx - sr * pz;
    var cy = py;
    var cz = sr * nx + cr * pz;
    return [cx, cz, -cy];
  }

  function needsCors(url) {
    try {
      var abs = new URL(url, window.location.href);
      if (abs.protocol === "data:" || abs.protocol === "blob:") return false;
      return abs.origin !== window.location.origin;
    } catch (e) {
      return true;
    }
  }

  function drawStrip(ctx, img, yaw, pitch, fov, w, h, alpha) {
    if (!img || !img.width) return;
    var fovFrac = fov / 360;
    var center = ((0.5 + yaw / 360) % 1 + 1) % 1;
    var srcW = img.width * fovFrac;
    var srcX = center * img.width - srcW / 2;
    var aspect = w / Math.max(h, 1);
    var vFrac = (fov / aspect) / 180;
    var centerV = 0.5 - pitch / 180;
    var srcH = img.height * vFrac;
    var srcY = centerV * img.height - srcH / 2;
    if (srcY < 0) srcY = 0;
    if (srcY + srcH > img.height) srcY = Math.max(0, img.height - srcH);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (srcX < 0) {
      ctx.drawImage(img, img.width + srcX, srcY, -srcX, srcH, 0, 0, (-srcX / srcW) * w, h);
      ctx.drawImage(img, 0, srcY, srcW + srcX, srcH, (-srcX / srcW) * w, 0, ((srcW + srcX) / srcW) * w, h);
    } else if (srcX + srcW > img.width) {
      var left = img.width - srcX;
      ctx.drawImage(img, srcX, srcY, left, srcH, 0, 0, (left / srcW) * w, h);
      ctx.drawImage(img, 0, srcY, srcW - left, srcH, (left / srcW) * w, 0, ((srcW - left) / srcW) * w, h);
    } else {
      ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, w, h);
    }
    ctx.restore();
  }

  function resize(canvas) {
    var w = Math.max(2, canvas.clientWidth || 960);
    var h = Math.max(2, canvas.clientHeight || 540);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function bindTex(gl, unit, tex) {
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function sphere(latBands, lonBands) {
    var pos = [];
    var ind = [];
    for (var lat = 0; lat <= latBands; lat++) {
      var v = lat / latBands;
      for (var lon = 0; lon <= lonBands; lon++) {
        var u = lon / lonBands;
        var latRad = (0.5 - v) * Math.PI;
        var lonRad = (u - 0.5) * Math.PI * 2;
        var cosLat = Math.cos(latRad);
        pos.push(Math.sin(lonRad) * cosLat, Math.sin(latRad), -Math.cos(lonRad) * cosLat, u, v);
      }
    }
    for (var y = 0; y < latBands; y++) {
      for (var x = 0; x < lonBands; x++) {
        var a = y * (lonBands + 1) + x;
        var b = a + lonBands + 1;
        ind.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return {
      interleaved: new Float32Array(pos),
      indices: new Uint16Array(ind),
      count: ind.length,
    };
  }

  function link(gl, vsSrc, fsSrc) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    return p;
  }

  function fillPerspective(out, fovDeg, aspect, near, far) {
    var f = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
    var nf = 1 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
  }

  function fillYaw(out, yawDeg) {
    var a = -yawDeg * Math.PI / 180;
    var c = Math.cos(a);
    var s = Math.sin(a);
    out[0] = c; out[1] = 0; out[2] = s; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = -s; out[9] = 0; out[10] = c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  }

  function fillPitch(out, pitchDeg) {
    var c = Math.cos(pitchDeg * Math.PI / 180);
    var s = Math.sin(pitchDeg * Math.PI / 180);
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = c; out[6] = -s; out[7] = 0;
    out[8] = 0; out[9] = s; out[10] = c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  }

  function fillRoll(out, rollDeg) {
    var c = Math.cos(rollDeg * Math.PI / 180);
    var sr = Math.sin(rollDeg * Math.PI / 180);
    out[0] = c; out[1] = -sr; out[2] = 0; out[3] = 0;
    out[4] = sr; out[5] = c; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  }

  function fillAimView(yawM, pitchM, rollM, out, yawDeg, pitchDeg, rollDeg) {
    fillYaw(yawM, yawDeg);
    fillPitch(pitchM, pitchDeg);
    multiplyInto(out, pitchM, yawM);
    fillRoll(rollM, rollDeg);
    multiplyInto(yawM, rollM, out);
    out.set(yawM);
  }

  function multiplyInto(out, a, b) {
    for (var c = 0; c < 4; c++) {
      var b0 = b[c * 4];
      var b1 = b[c * 4 + 1];
      var b2 = b[c * 4 + 2];
      var b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
  }

  root.SpsphereCast = {
    ROTATIONS: ROTATIONS,
    DEFAULT_DPS: DEFAULT_DPS,
    CROSSFADE_MS: CROSSFADE_MS,
    OMEGA: OMEGA,
    decodeAim: decodeAim,
    decodeSkip: decodeSkip,
    stepIndex: stepIndex,
    applyPose: applyPose,
    create: function (canvas) { return new Player(canvas); },
  };
})(window);
