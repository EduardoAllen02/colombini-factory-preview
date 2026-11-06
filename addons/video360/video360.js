/*!
 * video360 — addon for the Colombini Rovereta 1 tour.
 * Floating "Watch the 360° video" card + an in-viewport WebGL 360 video player.
 * Standalone: no CDN, no dependencies, does not use the player's ?edit mode.
 * It talks to the tour through ONE line added to player.js (window.__tourBridge, see README.md);
 * without it the card still works but camera continuity is disabled (the video opens at its own front).
 */
(function () {
  'use strict';
  if (window.Video360) return;

  /* =====================================================================================
   * CONFIGURATION — edit this block (or set window.VIDEO360_CONFIG before this script).
   * Paths are relative to the page (index.html / embed.html).
   *   scenes[sceneId].sources   '8k' = original HEVC 7680x3840 (lossless remux), '4k' = H.264 3840x1920,
   *                             'mobile' = H.264 2560x1280. Any tier can be omitted.
   *   yawOffset / pitchOffset   degrees. video yaw = panorama yaw + yawOffset. Use it when the video's
   *                             "north" is not the panorama's. Same offset is removed on the way back.
   *   pauseAmbient              true = pause the tour's ambient sound while this video is open (default false:
   *                             the ambient button stays truthful). Videos always play muted, in a loop.
   *   text                      optional per-scene overrides: { en: {...}, it: {...} }
   * ===================================================================================== */
  var CONFIG = {
    scenes: {
      'p4-sirio': {
        poster: 'video/360/sirio-poster.jpg',
        yawOffset: 11,        // measured by edge correlation panorama vs video frame (see QA.md)
        pitchOffset: 0,
        pauseAmbient: false,  // NB: the audio track in video1.mp4 is digital silence (-91 dB); played muted anyway
        sources: {
          '4k': 'video/360/sirio-4k.mp4',
          'mobile': 'video/360/sirio-mobile.mp4'
        }
      },
      'p2-cassetti': {
        poster: 'video/360/drawer-poster.jpg',
        yawOffset: 0,         // video is shot from a different spot than the panorama: no offset can match
        pitchOffset: 0,
        pauseAmbient: false,  // video2.mov has no audio track
        sources: {
          '4k': 'video/360/drawer-4k.mp4',
          'mobile': 'video/360/drawer-mobile.mp4'
        }
      }
    },
    text: {
      en: { title: 'Watch the 360° video', watch: 'Watch', later: 'Later',
            back: 'Back to panorama', loading: 'Loading video…', error: 'The video could not be loaded.', region: '360° video' },
      it: { title: 'Guarda il video a 360°', watch: 'Guarda', later: 'Più tardi',
            back: 'Torna al panorama', loading: 'Caricamento video…', error: 'Impossibile caricare il video.', region: 'Video 360°' }
    },
    quality: {
      mobileMaxWidth: 860,            // same breakpoint as the tour's own mobile layout
      hevc8kCodec: 'hvc1.1.6.L180.B0',
      width8k: 7680, height8k: 3840, fps: 30, bitrate8k: 53e6,
      // adaptive downgrade (8k -> 4k -> mobile) at the same point of the video
      stallWaitingEvents: 3, stallWindowMs: 10000, stallMs: 3500,
      dropRatio: 0.25, dropMinFrames: 40
    },
    view: {                            // sensitivity, calibrated against the tour's own drag/wheel
      dragGain: 1.04, wheelGain: 0.05, minFov: 26, maxFov: 96
    },
    cardDelayMs: 1300                  // wait after arriving in a scene before the card shows
  };
  (function merge(dst, src) {
    if (!src) return;
    Object.keys(src).forEach(function (k) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object') merge(dst[k], src[k]);
      else dst[k] = src[k];
    });
  })(CONFIG, window.VIDEO360_CONFIG);

  var REDUCE = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return !!(REDUCE && REDUCE.matches); }
  var D2R = Math.PI / 180;

  /* ------------------------------------------------------------------ helpers */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function ico(path) { return '<svg class="v360-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + path + '</svg>'; }
  var ICON = {
    cam: '<rect x="2.5" y="6.5" width="13" height="11" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
    back: '<path d="m15 18-6-6 6-6"/>'
  };
  function qs(name) { try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; } }

  /* ------------------------------------------------------------------ tour access */
  function bridge() { return window.__tourBridge || null; }
  function psv() { var b = bridge(); return b && b.viewer && b.viewer.getPosition ? b.viewer : null; }

  // Scene names (EN from the tour doc, IT from i18n) — only used when the bridge is missing.
  var NAME_TO_ID = null;
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function buildNames() {
    NAME_TO_ID = {};
    try {
      var doc = JSON.parse($('tour-doc').textContent);
      (doc.scenes || []).forEach(function (sc) {
        if (!CONFIG.scenes[sc.id]) return;
        NAME_TO_ID[norm(sc.name)] = sc.id;
        var it = doc.i18n && doc.i18n.it && doc.i18n.it[sc.id + '.name'];
        if (it) NAME_TO_ID[norm(it)] = sc.id;
      });
    } catch (e) { /* no doc: DOM fallback disabled */ }
  }
  function sceneId() {
    var b = bridge();
    if (b && b.state && b.state.sceneId) return b.state.sceneId;
    if (!NAME_TO_ID) buildNames();
    var n = document.querySelector('#where .name');
    return (n && NAME_TO_ID[norm(n.textContent)]) || null;
  }
  function lang() {
    var l = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    return CONFIG.text[l] ? l : 'en';
  }
  function T(key, sid) {
    var l = lang(), sc = sid && CONFIG.scenes[sid];
    return (sc && sc.text && sc.text[l] && sc.text[l][key]) || CONFIG.text[l][key] || CONFIG.text.en[key] || '';
  }
  function gateOpen() { var g = $('gate'); return !!g && !g.classList.contains('leaving'); }
  function panelOpen() {
    var b = document.body, pf = $('plan-full'), lb = $('lightbox');
    return b.classList.contains('reading') || b.classList.contains('floors-open') || !!(pf && pf.classList.contains('on')) || !!(lb && lb.classList.contains('on'));
  }
  function isMobile() {
    var w = CONFIG.quality.mobileMaxWidth;
    if (window.matchMedia && matchMedia('(max-width:' + w + 'px)').matches) return true;
    return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600);
  }

  /* ------------------------------------------------------------------ DOM */
  var root, stage, canvas, card, thumb, head, title, btnWatch, btnLater, fab, back, loading, loadingTxt, toast;
  function build() {
    root = el('div', 'v360-root');
    stage = el('div', 'v360-stage'); stage.tabIndex = -1;
    canvas = el('canvas'); stage.appendChild(canvas);

    card = el('section', 'v360-card v360-glass');
    card.setAttribute('role', 'region');
    thumb = el('div', 'v360-thumb', ico(ICON.play));
    head = el('div', 'v360-head');                                  // blue dot + title on one line, centred against the thumbnail
    title = el('p', 'v360-title');
    head.appendChild(el('i', 'v360-dot')); head.appendChild(title);
    var act = el('div', 'v360-actions');
    btnWatch = el('button', 'v360-btn v360-btn--go'); btnWatch.type = 'button';
    btnLater = el('button', 'v360-btn v360-btn--ghost'); btnLater.type = 'button';
    act.appendChild(btnWatch); act.appendChild(btnLater);
    card.appendChild(thumb); card.appendChild(head); card.appendChild(act);

    fab = el('button', 'v360-fab v360-glass', ico(ICON.cam)); fab.type = 'button';
    fab.setAttribute('aria-expanded', 'false');

    back = el('button', 'v360-back v360-glass'); back.type = 'button';

    loading = el('div', 'v360-loading v360-glass'); loading.setAttribute('role', 'status'); loading.setAttribute('aria-live', 'polite');
    loading.appendChild(el('div', 'v360-ring')); loadingTxt = el('div', 'mono'); loading.appendChild(loadingTxt);
    toast = el('div', 'v360-toast v360-glass'); toast.setAttribute('role', 'alert');

    [stage, card, fab, back, loading, toast].forEach(function (n) { root.appendChild(n); });
    (document.getElementById("tour") || document.body).appendChild(root);   // same stacking context as the tour HUD
    applyText();

    btnWatch.addEventListener('click', function () { open(); });
    btnLater.addEventListener('click', function () { setCollapsed(true, true); });
    fab.addEventListener('click', function () { setCollapsed(false, true); });
    back.addEventListener('click', function () { close('back'); });
    bindView();
  }

  function applyText() {
    if (!root) return;
    var sid = S.scene && CONFIG.scenes[S.scene] ? S.scene : S.lastCfgScene;
    card.setAttribute('aria-label', T('region', sid));
    title.textContent = T('title', sid);
    btnWatch.innerHTML = ico(ICON.play) + '<span>' + T('watch', sid) + '</span>';
    btnLater.textContent = T('later', sid);
    fab.setAttribute('aria-label', T('title', sid)); fab.title = T('title', sid);
    back.innerHTML = ico(ICON.back) + '<span>' + T('back', sid) + '</span><span class="v360-esc mono" aria-hidden="true">ESC</span>';
    back.setAttribute('aria-label', T('back', sid));
    loadingTxt.textContent = T('loading', sid);
  }

  /* ------------------------------------------------------------------ state */
  var S = {
    scene: null, lastCfgScene: null, sceneSince: 0, collapsed: {}, cardOn: false, fabOn: false,
    open: false, closing: false, vid: null, tier: null, ambientWas: false, view0: null, cfg: null,
    toastT: 0, downgraded: false, returning: false
  };

  /* ------------------------------------------------------------------ card / fab */
  function setCollapsed(c, focus) {
    var sid = S.scene; if (!sid) return;
    S.collapsed[sid] = c;
    syncCard();
    if (focus) { try { (c ? fab : btnWatch).focus({ preventScroll: true }); } catch (e) {} }
  }
  function syncCard() {
    if (!root) return;
    var cfg = S.scene && CONFIG.scenes[S.scene];
    var eligible = !!cfg && !S.open && !S.returning && !gateOpen() && !panelOpen() && (Date.now() - S.sceneSince) >= CONFIG.cardDelayMs;
    updateLift();
    var wantCard = eligible && !S.collapsed[S.scene];
    var wantFab = eligible && !!S.collapsed[S.scene];
    if (cfg) {
      thumb.style.backgroundImage = 'url("' + cfg.poster + '")';
      S.lastCfgScene = S.scene;
    }
    if (wantCard !== S.cardOn) { S.cardOn = wantCard; card.classList.toggle('is-on', wantCard); card.setAttribute('aria-hidden', wantCard ? 'false' : 'true'); setInert(card, !wantCard); }
    if (wantFab !== S.fabOn) { S.fabOn = wantFab; fab.classList.toggle('is-on', wantFab); fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-hidden', wantFab ? 'false' : 'true'); setInert(fab, !wantFab); }
  }
  // phones: the tour opens its "About this floor" card in the same slot above the bottom bar; stack ours on top of it
  function updateLift() {
    var lift = 0;
    if (window.matchMedia && matchMedia("(max-width:" + CONFIG.quality.mobileMaxWidth + "px) and (min-height:521px)").matches) {
      var fc = $("floorcard");
      if (fc && fc.classList.contains("on")) {
        var r = fc.getBoundingClientRect(), bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar")) || 78;
        lift = Math.max(0, Math.round(window.innerHeight - r.top + 8 - (bar + 10)));
      }
    }
    if (S.lift !== lift) { S.lift = lift; root.style.setProperty("--v360-lift", lift + "px"); }
  }
  function setInert(node, on) { if ('inert' in node) node.inert = on; else node.tabIndex = on ? -1 : 0; }

  function watchTour() {
    var sid = sceneId();
    if (sid !== S.scene) {
      var prev = S.scene;
      S.scene = sid; S.sceneSince = Date.now();
      if (prev) delete S.collapsed[prev];            // collapsed state lasts only for the visit to that scene
      if (S.open) { close('scene', true); }
      applyText();
      if (sid && CONFIG.scenes[sid] && CONFIG.scenes[sid].sources['8k']) prefetchCaps();
    }
    syncCard();
  }

  /* ------------------------------------------------------------------ quality selection */
  var capsP = null, maxTex = 0, probeGL = null;
  function glMaxTexture() {
    if (maxTex) return maxTex;
    try {
      var c = document.createElement('canvas');
      var g = c.getContext('webgl2') || c.getContext('webgl');
      maxTex = g ? g.getParameter(g.MAX_TEXTURE_SIZE) : 0;
      var x = g && g.getExtension('WEBGL_lose_context'); if (x) x.loseContext();
    } catch (e) { maxTex = 0; }
    return maxTex;
  }
  function prefetchCaps() { if (!capsP) capsP = detect8k(); return capsP; }
  function detect8k() {
    var q = CONFIG.quality;
    var res = { supported: false, smooth: false, powerEfficient: false, note: '' };
    if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) { res.note = 'no mediaCapabilities'; return Promise.resolve(res); }
    return navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType: 'video/mp4; codecs="' + q.hevc8kCodec + '"', width: q.width8k, height: q.height8k, bitrate: q.bitrate8k, framerate: q.fps }
    }).then(function (r) { res.supported = !!r.supported; res.smooth = !!r.smooth; res.powerEfficient = !!r.powerEfficient; return res; })
      .catch(function (e) { res.note = String(e); return res; });
  }
  var ORDER = ['8k', '4k', 'mobile'];
  function pickTier(cfg) {
    var forced = qs('v360q');                                  // ?v360q=8k|4k|mobile (QA aid)
    if (forced && cfg.sources[forced]) return Promise.resolve(forced);
    if (isMobile() && cfg.sources.mobile) return Promise.resolve('mobile');
    if (S.downgraded || !cfg.sources['8k']) return Promise.resolve(cfg.sources['4k'] ? '4k' : 'mobile');
    var conn = navigator.connection;
    if ((conn && conn.saveData) || glMaxTexture() < CONFIG.quality.width8k) return Promise.resolve('4k');
    return prefetchCaps().then(function (c) { return (c.supported && c.smooth) ? '8k' : '4k'; });
  }
  function lowerTier(t, cfg) {
    for (var i = ORDER.indexOf(t) + 1; i < ORDER.length; i++) if (cfg.sources[ORDER[i]]) return ORDER[i];
    return null;
  }

  /* ------------------------------------------------------------------ WebGL renderer */
  var VS = 'attribute vec2 aP;varying vec2 vP;void main(){vP=aP;gl_Position=vec4(aP,0.,1.);}';
  var FS = 'precision highp float;uniform sampler2D uTex;uniform vec2 uRes;uniform float uTan;uniform vec2 uCam;varying vec2 vP;' +
    'const float PI=3.14159265359;' +
    'void main(){vec3 d=normalize(vec3(vP.x*uRes.x/uRes.y*uTan,vP.y*uTan,-1.));' +
    'float cp=cos(uCam.y),sp=sin(uCam.y),cy=cos(uCam.x),sy=sin(uCam.x);' +
    'float y1=d.y*cp-d.z*sp,z1=d.y*sp+d.z*cp;float x2=d.x*cy-z1*sy,z2=d.x*sy+z1*cy;' +
    'float lon=atan(x2,-z2),lat=asin(clamp(y1,-1.,1.));' +
    'gl_FragColor=vec4(texture2D(uTex,vec2(lon/(2.*PI)+.5,.5-lat/PI)).rgb,1.);}';

  var R = null;          // renderer instance
  function makeRenderer() {
    var gl2 = true, gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) { gl2 = false; gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' }); }
    if (!gl) return null;
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(p, 'aP'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    // full-resolution video texture: no mipmaps, no downscale, LINEAR, colours left to the browser's BT.709 decode
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl2 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var u = { tex: gl.getUniformLocation(p, 'uTex'), res: gl.getUniformLocation(p, 'uRes'), tan: gl.getUniformLocation(p, 'uTan'), cam: gl.getUniformLocation(p, 'uCam') };
    gl.uniform1i(u.tex, 0);
    return { gl: gl, tex: tex, u: u, texW: 0, texH: 0, w: 0, h: 0, lost: false, webgl2: gl2 };
  }
  function resizeCanvas() {
    if (!R) return;
    var cw = stage.clientWidth || window.innerWidth, ch = stage.clientHeight || window.innerHeight;
    var dpr = window.devicePixelRatio || 1;
    var maxPx = 3840 * 2160;                                   // keep the backing store sane on 4K + dpr 2 screens
    var s = dpr; if (cw * ch * s * s > maxPx) s = Math.sqrt(maxPx / (cw * ch));
    var w = Math.max(2, Math.round(cw * s)), h = Math.max(2, Math.round(ch * s));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    R.w = w; R.h = h; dirty = true;
  }
  function uploadFrame(v) {
    var gl = R.gl;
    gl.bindTexture(gl.TEXTURE_2D, R.tex);
    if (R.texW !== v.videoWidth || R.texH !== v.videoHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      R.texW = v.videoWidth; R.texH = v.videoHeight;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
    }
  }
  function draw() {
    if (!R || !R.texW) return;
    var gl = R.gl;
    gl.viewport(0, 0, R.w, R.h);
    gl.uniform2f(R.u.res, R.w, R.h);
    gl.uniform1f(R.u.tan, Math.tan(cam.fov * D2R / 2));
    gl.uniform2f(R.u.cam, cam.yaw, cam.pitch);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ------------------------------------------------------------------ camera + input */
  var cam = { yaw: 0, pitch: 0, fov: 60, fovT: 60, vy: 0, vp: 0 };
  var dirty = false, raf = 0, lastT = 0, newFrame = false;
  function fovRange() {
    var p = psv(), c = p && p.config;
    return { min: (c && c.minFov) || CONFIG.view.minFov, max: (c && c.maxFov) || CONFIG.view.maxFov };
  }
  function zoomToFov(z) { var r = fovRange(); return r.max + (z / 100) * (r.min - r.max); }
  function fovToZoom(f) { var r = fovRange(); return clamp((f - r.max) / (r.min - r.max) * 100, 0, 100); }

  var pointers = {}, pinch0 = 0, fov0 = 0, lastMove = 0;
  function nPointers() { return Object.keys(pointers).length; }
  // Same law as the tour: a drag across the full viewport turns the view by the full FOV (x1.04, measured), horizontally by hFov
  function radPerPx() {
    var w = stage.clientWidth || window.innerWidth, h = stage.clientHeight || window.innerHeight, v = cam.fov * D2R;
    var hf = 2 * Math.atan(Math.tan(v / 2) * w / h), g = CONFIG.view.dragGain;
    return { x: g * hf / w, y: g * v / h };
  }
  function bindView() {
    stage.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { stage.setPointerCapture(e.pointerId); } catch (x) {}
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      stage.classList.add('is-drag'); cam.vy = cam.vp = 0; lastMove = performance.now();
      if (nPointers() === 2) { var k = Object.keys(pointers); pinch0 = dist(pointers[k[0]], pointers[k[1]]); fov0 = cam.fovT; }
      stage.focus({ preventScroll: true });
    });
    stage.addEventListener('pointermove', function (e) {
      var p = pointers[e.pointerId]; if (!p) return;
      var now = performance.now(), dt = Math.max(1, now - lastMove); lastMove = now;
      if (nPointers() >= 2) {
        p.x = e.clientX; p.y = e.clientY;
        var k = Object.keys(pointers), d = dist(pointers[k[0]], pointers[k[1]]);
        if (pinch0 > 0) { var r = fovRange(); cam.fovT = clamp(fov0 * pinch0 / d, r.min, r.max); cam.fov = cam.fovT; dirty = true; }
        return;
      }
      var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      var k2 = radPerPx();
      cam.yaw -= dx * k2.x; cam.pitch = clamp(cam.pitch + dy * k2.y, -Math.PI / 2, Math.PI / 2);
      cam.vy = lerp(cam.vy, -dx * k2.x / dt, 0.5); cam.vp = lerp(cam.vp, dy * k2.y / dt, 0.5);   // rad/ms
      dirty = true;
    });
    function up(e) {
      if (!pointers[e.pointerId]) return;
      delete pointers[e.pointerId];
      if (!nPointers()) stage.classList.remove('is-drag');
      if (performance.now() - lastMove > 80) cam.vy = cam.vp = 0;
      pinch0 = 0;
    }
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up); stage.addEventListener('lostpointercapture', up);
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 600 : e.deltaY;
      var r = fovRange(), span = r.max - r.min;
      cam.fovT = clamp(cam.fovT + dy * CONFIG.view.wheelGain * span / 100, r.min, r.max);
    }, { passive: false });
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function tick(t) {
    raf = 0; if (!S.open) return;
    var dt = lastT ? Math.min(64, t - lastT) : 16; lastT = t;
    if (!nPointers() && (Math.abs(cam.vy) > 1e-6 || Math.abs(cam.vp) > 1e-6)) {          // inertia
      cam.yaw += cam.vy * dt; cam.pitch = clamp(cam.pitch + cam.vp * dt, -Math.PI / 2, Math.PI / 2);
      var f = Math.exp(-dt / 260); cam.vy *= f; cam.vp *= f; dirty = true;
      if (Math.abs(cam.vy) < 1e-6) cam.vy = 0; if (Math.abs(cam.vp) < 1e-6) cam.vp = 0;
    }
    if (Math.abs(cam.fovT - cam.fov) > 0.01) { cam.fov += (cam.fovT - cam.fov) * (1 - Math.exp(-dt / 90)); dirty = true; }
    if (newFrame && S.vid && R) { newFrame = false; try { uploadFrame(S.vid); dirty = true; } catch (e) { fail(e); return; } }
    if (dirty) { dirty = false; try { draw(); } catch (e) { fail(e); return; } }
    raf = requestAnimationFrame(tick);
  }
  function kick() { if (!raf && S.open) { lastT = 0; raf = requestAnimationFrame(tick); } }

  /* ------------------------------------------------------------------ video element + monitoring */
  var mon = { waits: [], lastTotal: 0, lastDropped: 0, badRuns: 0, timer: 0, since: 0, swapping: false, stallAt: 0, tick: 0, wraps: 0 };
  function absUrl(p) { return new URL(p, document.baseURI).href; }
  function makeVideo(url) {
    var v = document.createElement('video');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto'; v.loop = true; v.muted = v.defaultMuted = true;   // always muted, endless loop
    v.disablePictureInPicture = true; v.setAttribute('aria-hidden', 'true'); v.tabIndex = -1;
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    try { if (new URL(url).origin !== location.origin) v.crossOrigin = 'anonymous'; } catch (e) {}
    v.src = url;
    document.body.appendChild(v);
    return v;
  }
  function frameLoop(v) {
    if (v.requestVideoFrameCallback) {
      var cb = function () { if (S.vid !== v) return; newFrame = true; kick(); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      var last = -1, poll = function () { if (S.vid !== v) return; if (v.currentTime !== last) { last = v.currentTime; newFrame = true; kick(); } requestAnimationFrame(poll); };
      requestAnimationFrame(poll);
    }
  }
  function attachEvents(v) {
    v.addEventListener('error', function () { if (S.vid === v && !mon.swapping) onVideoError(); });
    v.addEventListener('playing', function () { if (S.vid === v) loading.classList.remove('is-on'); });
    var lastT = 0;                                                    // loop wrap: currentTime jumps back; give the decoder a grace period
    v.addEventListener('timeupdate', function () {
      if (S.vid !== v) return;
      if (v.currentTime < lastT - 0.5) { mon.since = performance.now(); mon.waits = []; mon.stallAt = 0; mon.wraps++; }
      lastT = v.currentTime;
    });
    v.addEventListener('waiting', function () {
      if (S.vid !== v || mon.swapping) return;
      var now = performance.now(); if (v.seeking || now - mon.since < 2500) return;
      mon.waits.push(now); mon.waits = mon.waits.filter(function (t) { return now - t < CONFIG.quality.stallWindowMs; });
      setTimeout(function () { if (S.vid === v && v.readyState < 3 && !v.paused) loading.classList.add('is-on'); }, 450);
      if (mon.waits.length >= CONFIG.quality.stallWaitingEvents) downgrade('waiting');
    });
    v.addEventListener('canplay', function () { if (S.vid === v) loading.classList.remove('is-on'); });
  }
  function startMonitor() {
    stopMonitor(); mon.waits = []; mon.badRuns = 0; mon.since = performance.now(); mon.lastTotal = mon.lastDropped = 0; mon.stallAt = 0; mon.tick = 0;
    mon.timer = setInterval(function () {
      var v = S.vid; if (!v || mon.swapping) return;
      var now = performance.now();
      // 1) one long starvation (the browser may report a single "waiting" for the whole thing)
      if (!v.paused && !v.seeking && v.readyState < 3 && now - mon.since > 2500) {
        if (!mon.stallAt) mon.stallAt = now;
        if (now - mon.stallAt >= CONFIG.quality.stallMs) { downgrade("stalled " + Math.round((now - mon.stallAt) / 1000) + "s"); return; }
      } else mon.stallAt = 0;
      // 2) dropped frames, evaluated over 2 s windows
      if (++mon.tick % 2 || v.paused || !v.getVideoPlaybackQuality) return;
      var q = v.getVideoPlaybackQuality(), dT = q.totalVideoFrames - mon.lastTotal, dD = q.droppedVideoFrames - mon.lastDropped;
      mon.lastTotal = q.totalVideoFrames; mon.lastDropped = q.droppedVideoFrames;
      if (now - mon.since < 2500) return;
      if (dT >= CONFIG.quality.dropMinFrames * 0.5 && dD / Math.max(1, dT) > CONFIG.quality.dropRatio) { if (++mon.badRuns >= 2) downgrade("dropped " + dD + "/" + dT); }
      else mon.badRuns = 0;
    }, 1000);
  }
  function stopMonitor() { clearInterval(mon.timer); mon.timer = 0; }

  // switch to a lower tier at the same point of the video, without restarting or asking anything
  function downgrade(why) {
    var cfg = S.cfg, v = S.vid; if (!cfg || !v || mon.swapping) return;
    var next = lowerTier(S.tier, cfg); if (!next) return;
    mon.swapping = true; S.downgraded = true;
    var from = S.tier, wasPaused = v.paused, t0 = v.currentTime, started = performance.now();
    var nv = makeVideo(absUrl(cfg.sources[next]));
    function done(ok) {
      if (!ok) { try { nv.remove(); } catch (e) {} mon.swapping = false; return; }
      var old = S.vid; S.vid = nv; S.tier = next; frameLoop(nv); attachEvents(nv);
      try { old.pause(); old.removeAttribute('src'); old.load(); old.remove(); } catch (e) {}
      mon.swapping = false; mon.since = performance.now(); mon.waits = []; mon.badRuns = 0; mon.lastTotal = mon.lastDropped = 0; mon.stallAt = 0;
      if (!wasPaused) nv.play().catch(function () {});
      newFrame = true; dirty = true; kick();
      log('downgrade ' + from + ' -> ' + next + ' (' + why + ') at ' + t0.toFixed(2) + 's, swap in ' + Math.round(performance.now() - started) + 'ms');
    }
    nv.addEventListener('error', function () { done(false); }, { once: true });
    nv.addEventListener('loadedmetadata', function () {
      // aim slightly ahead so the new stream lands on the frame the old one is showing when it becomes ready
      nv.currentTime = (v.currentTime + 0.25) % (v.duration || 1e9);   // wraps correctly if the swap happens at the loop point
    }, { once: true });
    nv.addEventListener('seeked', function once() {
      nv.removeEventListener('seeked', once);
      if (nv.readyState >= 3) done(true); else nv.addEventListener('canplay', function () { done(true); }, { once: true });
    });
  }

  var LOG = [];
  function log(m) { LOG.push(m); if (LOG.length > 50) LOG.shift(); if (window.console && console.info) console.info('[video360] ' + m); }

  /* ------------------------------------------------------------------ open / close */
  function ambientPause() {
    var b = $('btn-sound'); S.ambientWas = !!(b && b.classList.contains('playing'));
    if (S.ambientWas) b.click();
  }
  function ambientResume() {
    var b = $('btn-sound');
    if (S.ambientWas && b && !b.classList.contains('playing')) b.click();
    S.ambientWas = false;
  }

  function open() {
    var sid = S.scene, cfg = sid && CONFIG.scenes[sid];
    if (!cfg || S.open) return;
    S.open = true; S.closing = false; S.cfg = cfg; S.openScene = sid;
    syncCard();
    var p = psv(), pos = p ? p.getPosition() : { yaw: 0, pitch: 0 };
    var zl = p && p.getZoomLevel ? p.getZoomLevel() : 50;
    S.view0 = { yaw: pos.yaw, pitch: pos.pitch, zoom: zl };
    cam.yaw = pos.yaw + (cfg.yawOffset || 0) * D2R;
    cam.pitch = clamp(pos.pitch + (cfg.pitchOffset || 0) * D2R, -Math.PI / 2, Math.PI / 2);
    cam.fov = cam.fovT = zoomToFov(zl); cam.vy = cam.vp = 0;
    S.focusBefore = document.activeElement;
    if (cfg.pauseAmbient) ambientPause();
    document.documentElement.classList.add('v360-open');            // only the panorama's hotspot markers are parked
    back.classList.add('is-on'); loading.classList.add('is-on');
    try { back.focus({ preventScroll: true }); } catch (e) {}
    try { R = makeRenderer(); if (!R) throw new Error('WebGL unavailable'); resizeCanvas(); }
    catch (e) { return fail(e); }
    pickTier(cfg).then(function (tier) { if (!S.open || S.closing) return; startVideo(tier); });
  }

  function startVideo(tier) {
    var cfg = S.cfg; if (!cfg.sources[tier]) tier = ORDER.filter(function (t) { return cfg.sources[t]; })[0];
    S.tier = tier;
    var v = makeVideo(absUrl(cfg.sources[tier])); S.vid = v; attachEvents(v); frameLoop(v);
    var timeout = setTimeout(function () { if (S.vid === v && !S.shown) onVideoError(); }, 25000);
    var first = function () {
      if (S.vid !== v || S.shown) return;
      var okFrame = v.readyState >= 2 && v.videoWidth > 0; if (!okFrame) return;
      S.shown = true; clearTimeout(timeout);
      try { uploadFrame(v); draw(); } catch (e) { return fail(e); }
      stage.classList.add('is-on'); loading.classList.remove('is-on');
      startMonitor(); dirty = true; kick();
      log('playing tier ' + tier + ' ' + v.videoWidth + 'x' + v.videoHeight);
    };
    v.addEventListener('loadeddata', first); v.addEventListener('canplay', first); v.addEventListener('playing', first);
    var pr = v.play(); if (pr && pr.catch) pr.catch(function (e) { if (e && e.name !== 'AbortError') onVideoError(); });
  }

  function onVideoError() {
    if (!S.open || S.closing) return;
    var cfg = S.cfg, next = lowerTier(S.tier, cfg);
    if (next && !S.shown) {                                           // try the next tier before giving up
      log('error on ' + S.tier + ', trying ' + next);
      var old = S.vid; try { old.pause(); old.removeAttribute('src'); old.load(); old.remove(); } catch (e) {}
      S.vid = null; startVideo(next); return;
    }
    fail(new Error('video error'));
  }
  function fail(err) {
    log('FAIL ' + (err && err.message || err));
    var sid = S.scene;
    close('error', true);
    showToast(T('error', sid));
  }
  function showToast(msg) {
    toast.textContent = msg; toast.classList.add('is-on'); clearTimeout(S.toastT);
    S.toastT = setTimeout(function () { toast.classList.remove('is-on'); }, 4200);
  }

  function close(reason, noWrite) {
    if (!S.open || S.closing) return;
    S.closing = true; stopMonitor();
    var cfg = S.cfg, p = psv();
    // hand the camera back to the panorama while the video is still covering it
    if (!noWrite && p && S.shown) {
      try {
        var yaw = cam.yaw - (cfg.yawOffset || 0) * D2R, pitch = clamp(cam.pitch - (cfg.pitchOffset || 0) * D2R, -Math.PI / 2, Math.PI / 2);
        if (p.stopAll) p.stopAll();
        p.rotate({ yaw: yaw, pitch: pitch });
        if (p.zoom) p.zoom(fovToZoom(cam.fov));
      } catch (e) { log('write-back failed: ' + e); }
    }
    var html = document.documentElement;
    S.returning = true;
    stage.classList.remove('is-on'); back.classList.remove('is-on'); loading.classList.remove('is-on');
    ambientResume();
    if (reason !== 'scene') S.collapsed[S.openScene] = true;           // the visitor has been through it: leave the compact button
    var vid = S.vid;
    var finish = function () {
      if (vid) { try { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); } catch (e) {} }
      if (S.vid === vid) S.vid = null;
      if (R) { try { var x = R.gl.getExtension('WEBGL_lose_context'); R.gl.deleteTexture(R.tex); if (x) x.loseContext(); } catch (e) {} R = null; }
      // a lost context cannot be revived on the same canvas: swap it for a fresh one next time
      var nc = el('canvas'); stage.replaceChild(nc, canvas); canvas = nc;
      cancelAnimationFrame(raf); raf = 0; pointers = {}; stage.classList.remove('is-drag');
      html.classList.remove('v360-open');
      S.open = false; S.closing = false; S.shown = false; S.returning = false; S.tier = null; S.vid = null;
      syncCard();
      if (reason !== 'scene' && S.fabOn) { try { fab.focus({ preventScroll: true }); } catch (e) {} }
    };
    var wait = reduced() ? 20 : 450;
    setTimeout(finish, wait);
    log('close (' + reason + ')');
  }

  /* ------------------------------------------------------------------ keyboard: only Esc is ours (capture, so it runs before the player's own Esc handler).
     Everything else (arrows, i, +/-) is left to the tour: arrows change scene, which closes the video. */
  window.addEventListener('keydown', function (e) {
    if (S.open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close('esc'); }
  }, true);

  /* ------------------------------------------------------------------ boot */
  function resize() { if (R) { resizeCanvas(); kick(); } }
  function init() {
    build();
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
    new MutationObserver(function () { applyText(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    if (REDUCE && REDUCE.addEventListener) REDUCE.addEventListener('change', function () {});
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { dirty = true; kick(); } });
    setInterval(watchTour, 100);
    watchTour();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  /* tiny public handle: for QA and for hooking the card elsewhere; nothing in the tour depends on it */
  window.Video360 = {
    version: '1.0.0', config: CONFIG,
    open: open, close: function () { close('api'); },
    get state() {
      return { open: S.open, scene: S.scene, tier: S.tier, shown: S.shown, collapsed: !!S.collapsed[S.scene], cardOn: S.cardOn, fabOn: S.fabOn,
        cam: { yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov }, view0: S.view0, downgraded: S.downgraded,
        video: S.vid ? { t: S.vid.currentTime, d: S.vid.duration, w: S.vid.videoWidth, h: S.vid.videoHeight, paused: S.vid.paused, muted: S.vid.muted } : null,
        canvas: R ? { w: R.w, h: R.h, texW: R.texW, texH: R.texH, webgl2: R.webgl2 } : null, maxTex: maxTex, log: LOG.slice() };
    },
    caps: function () { return prefetchCaps(); },
    setCam: function (yawDeg, pitchDeg, fovDeg) { cam.yaw = yawDeg * D2R; cam.pitch = pitchDeg * D2R; if (fovDeg) cam.fov = cam.fovT = fovDeg; dirty = true; kick(); },
    forceDowngrade: function () { downgrade('forced'); }
  };
})();
