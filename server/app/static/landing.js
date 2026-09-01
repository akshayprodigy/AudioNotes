/*
  Landing page motion: a WebGL hero, scroll reveals, and a phone that tilts.

  Written by hand rather than pulled from a CDN, for the same reason the page loads no fonts from
  Google: a site whose headline is "nothing leaves your phone" should make no third-party requests
  at all, and anyone who opens the network tab is precisely the customer this product wants. The
  hero is a single full-screen fragment shader — about 4 KB — where a 3D library would have been
  600 KB and one more domain in the waterfall.

  Everything here is decoration and every part of it fails soft. No WebGL, an old driver, a
  reduced-motion preference, or a thrown exception all leave a page that still reads correctly:
  the CSS paints its own gradient behind the canvas, and the reveal class resolves to its final
  state rather than hiding content it never got round to showing.
*/
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ------------------------------------------------------------------ reveals */

  /*
    Reveal-on-scroll, with the failure mode chosen deliberately. If IntersectionObserver is
    missing the elements are shown immediately: content hidden by a CSS class that nothing will
    ever remove is invisible content, which is a far worse bug than an animation that did not run.
  */
  function reveals() {
    var items = document.querySelectorAll('.rise');
    if (!('IntersectionObserver' in window) || reduced.matches) {
      for (var i = 0; i < items.length; i++) items[i].classList.add('in');
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          io.unobserve(e.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
    );
    items.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ------------------------------------------------------------------ chrome */

  function nav() {
    var el = document.querySelector('.nav');
    if (!el) return;
    var onScroll = function () {
      el.classList.toggle('stuck', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* Pointer parallax on the phone. Coarse pointers get the resting angle and no listener: on a
     touchscreen the only way to "hover" is to touch, and a tilt that fires on tap reads as a
     rendering fault rather than an effect. */
  function phone() {
    var el = document.querySelector('.phone');
    if (!el || reduced.matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var frame = 0;
    window.addEventListener(
      'pointermove',
      function (e) {
        if (frame) return;
        frame = requestAnimationFrame(function () {
          frame = 0;
          var cx = window.innerWidth / 2;
          var cy = window.innerHeight / 2;
          var dx = (e.clientX - cx) / cx;
          var dy = (e.clientY - cy) / cy;
          el.style.setProperty('--ry', (-13 + dx * 9).toFixed(2) + 'deg');
          el.style.setProperty('--rx', (12 - dy * 7).toFixed(2) + 'deg');
        });
      },
      { passive: true }
    );
  }

  /* ------------------------------------------------------------------ hero */

  var VERT = [
    'attribute vec2 p;',
    'void main(){ gl_Position = vec4(p, 0.0, 1.0); }'
  ].join('\n');

  /*
    Layered sound ribbons with fake depth.

    Each layer is a horizontal line displaced by a sum of sines at incommensurate frequencies, so
    the crests never line up into an obvious repeat. Layers further "back" are dimmer, slower and
    lower in amplitude, which is what reads as depth — there is no camera and no geometry here,
    only ordering and falloff, and at this scale the eye cannot tell the difference.

    The glow is 1/distance rather than a smoothstep band: it gives a bloom that stays soft when
    two ribbons cross, where a hard band would show a seam.
  */
  var FRAG = [
    'precision highp float;',
    'uniform vec2  uRes;',
    'uniform float uTime;',
    'uniform vec2  uMouse;',
    'uniform vec3  uA;',
    'uniform vec3  uB;',
    'uniform float uDark;',
    '',
    'float ribbon(vec2 uv, float seed, float t){',
    '  float y = 0.0;',
    '  y += sin(uv.x * 1.7 + t * 0.65 + seed * 2.3) * 0.26;',
    '  y += sin(uv.x * 2.9 - t * 0.44 + seed * 4.1) * 0.15;',
    '  y += sin(uv.x * 4.7 + t * 0.31 + seed * 1.7) * 0.08;',
    '  y += sin(uv.x * 8.3 - t * 0.27 + seed * 5.9) * 0.035;',
    '  return y;',
    '}',
    '',
    'void main(){',
    '  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;',
    '  uv.x += uMouse.x * 0.06;',
    '  uv.y -= uMouse.y * 0.03;',
    '',
    '  vec3 col = vec3(0.0);',
    '  const float N = 7.0;',
    '  for (float i = 0.0; i < N; i += 1.0) {',
    '    float d  = i / N;',                     // 0 = front, 1 = back
    '    float sc = 1.0 - d * 0.45;',            // back ribbons are shallower
    '    float y  = ribbon(uv * vec2(1.0 + d * 0.35, 1.0), i, uTime) * sc + (d - 0.5) * 0.30;',
    '    float dist = abs(uv.y - y);',
    '    float glow = 0.0030 / (dist + 0.0035);',
    '    glow *= 1.0 - d * 0.62;',               // depth falloff
    '    col += mix(uA, uB, d * 0.85 + 0.08) * glow;',
    '  }',
    '',
    /* Vignette and a horizontal fade, so the ribbons dissolve rather than getting cut off by the
       edge of the canvas. */
    '  float edge = smoothstep(1.35, 0.35, abs(uv.x));',
    '  col *= edge;',
    '  col *= smoothstep(0.95, 0.15, abs(uv.y) - 0.10);',
    '',
    /*
       Light and dark need opposite things here, which is why both are tuned rather than one being
       derived from the other. On black, a thin bright ribbon glows and needs holding back. On
       near-white the same ribbon is competing with the background rather than adding to it, and
       the first attempt — dimming colour and alpha together — made it invisible: the effect was
       there, drawing every frame, and could not be seen at all.
    */
    '  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);',
    '  col *= mix(0.90, 1.0, uDark);',
    '  gl_FragColor = vec4(col, a * mix(0.78, 0.90, uDark));',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    return sh;
  }

  /** #RRGGBB from a CSS custom property, as 0..1 floats. One source of truth: the stylesheet. */
  function cssColor(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    var m = /^#?([0-9a-f]{6})$/i.exec(v);
    if (!m) return [0.29, 0.34, 0.82];
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function hero() {
    var cv = document.getElementById('field');
    if (!cv || reduced.matches) return;

    var gl = cv.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false })
      || cv.getContext('experimental-webgl');
    if (!gl) return;

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    var uRes = gl.getUniformLocation(prog, 'uRes');
    var uTime = gl.getUniformLocation(prog, 'uTime');
    var uMouse = gl.getUniformLocation(prog, 'uMouse');
    var uA = gl.getUniformLocation(prog, 'uA');
    var uB = gl.getUniformLocation(prog, 'uB');
    var uDark = gl.getUniformLocation(prog, 'uDark');

    var dark = window.matchMedia('(prefers-color-scheme: dark)');
    function palette() {
      var a = cssColor('--primary', '#4A56D2');
      var b = cssColor('--primary-2', '#7A5AE0');
      gl.uniform3f(uA, a[0], a[1], a[2]);
      gl.uniform3f(uB, b[0], b[1], b[2]);
      gl.uniform1f(uDark, dark.matches ? 1.0 : 0.0);
    }
    palette();
    if (dark.addEventListener) dark.addEventListener('change', palette);

    /* Capped at 1.5x. A shader this fill-heavy at native density on a 3x phone screen costs far
       more battery than the effect is worth, and the ribbons are soft enough that nobody can see
       the difference. */
    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var w = Math.floor(cv.clientWidth * dpr);
      var h = Math.floor(cv.clientHeight * dpr);
      if (cv.width === w && cv.height === h) return;
      cv.width = w;
      cv.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
    size();
    window.addEventListener('resize', size, { passive: true });

    var mx = 0, my = 0, tx = 0, ty = 0;
    window.addEventListener(
      'pointermove',
      function (e) {
        tx = (e.clientX / window.innerWidth) * 2 - 1;
        ty = (e.clientY / window.innerHeight) * 2 - 1;
      },
      { passive: true }
    );

    /* Stops rendering the moment the hero scrolls away or the tab is hidden. A landing page that
       keeps a GPU busy after you have scrolled past it is a rude thing to ship. */
    var visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        if (visible) tick();
      }, { threshold: 0 }).observe(cv);
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && visible) tick();
    });

    var running = false;
    var t0 = performance.now();
    function tick() {
      if (running) return;
      running = true;
      requestAnimationFrame(function loop(now) {
        if (!visible || document.hidden) { running = false; return; }
        size();
        mx += (tx - mx) * 0.045;
        my += (ty - my) * 0.045;
        gl.uniform1f(uTime, (now - t0) / 1000);
        gl.uniform2f(uMouse, mx, my);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        requestAnimationFrame(loop);
      });
    }
    tick();
  }

  function boot() {
    // Each part is independent: a throw in the hero must not cost the page its scroll reveals.
    [reveals, nav, phone, hero].forEach(function (fn) {
      try { fn(); } catch (e) { /* decoration only */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
