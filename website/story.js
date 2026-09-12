/* Sprint Coder website — scroll-driven story.
 * No dependencies. Each [data-scene] section is a tall wrapper with a sticky
 * .scene-stage inside. Scroll position inside the wrapper becomes a 0..1
 * progress value, which is mapped to per-phase CSS custom properties
 * (--s-<phase>) and a few discrete class/attribute toggles. CSS does the rest.
 */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }
  function ease(t) {
    return t * t * (3 - 2 * t);
  }
  function seg(p, a, b) {
    return ease(clamp((p - a) / (b - a), 0, 1));
  }
  function formatCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var PHASES = {
    story: {
      rise: [0, 0.12],
      type: [0.15, 0.3],
      send: [0.3, 0.34],
      leader: [0.36, 0.42],
      team: [0.43, 0.47],
      hire1: [0.44, 0.48],
      hire2: [0.48, 0.52],
      hire3: [0.52, 0.56],
      w1: [0.58, 0.68],
      w2: [0.6, 0.78],
      w3: [0.74, 0.86],
      diff: [0.62, 0.7],
      ask: [0.7, 0.74],
      ok: [0.76, 0.8],
      done: [0.82, 0.9],
    },
    control: {
      diff: [0.03, 0.3],
      cmd: [0.32, 0.4],
      policy: [0.42, 0.5],
      ok: [0.52, 0.58],
      out: [0.62, 0.9],
    },
    providers: {
      roll: [0.06, 0.92],
    },
  };

  var header = document.querySelector('.site-header');
  var headerH = 0;

  function parseRange(el) {
    var parts = (el.getAttribute('data-range') || '0,1').split(',');
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  }

  function buildScene(el) {
    var name = el.getAttribute('data-scene');
    var stage = el.querySelector('.scene-stage');
    var phases = PHASES[name] || {};
    var scene = {
      el: el,
      stage: stage,
      name: name,
      phases: phases,
      p: -1,
      flags: [],
      ranged: [],
      typed: [],
      counters: [],
      states: [],
      progress: stage.querySelector('.scene-progress > b'),
    };

    stage.querySelectorAll('[data-on]').forEach(function (node) {
      var phase = node.getAttribute('data-on');
      if (phases[phase]) scene.flags.push({ node: node, phase: phase });
    });
    stage.querySelectorAll('[data-range]').forEach(function (node) {
      scene.ranged.push({ node: node, range: parseRange(node) });
    });
    stage.querySelectorAll('[data-typed]').forEach(function (node) {
      scene.typed.push({
        node: node,
        text: node.getAttribute('data-typed'),
        phase: node.getAttribute('data-phase'),
        len: -1,
      });
    });
    stage.querySelectorAll('[data-count]').forEach(function (node) {
      scene.counters.push({
        node: node,
        target: parseInt(node.getAttribute('data-count'), 10),
        phase: node.getAttribute('data-phase'),
        value: -1,
      });
    });
    stage.querySelectorAll('[data-state-phase]').forEach(function (node) {
      scene.states.push({ node: node, phase: node.getAttribute('data-state-phase') });
    });

    if (name === 'providers') {
      scene.picker = stage.querySelector('.picker');
      scene.items = Array.prototype.slice.call(stage.querySelectorAll('.picker-list > li'));
      scene.kinds = Array.prototype.slice.call(stage.querySelectorAll('.provider-kind'));
    }
    return scene;
  }

  function applyScene(scene, p) {
    if (p === scene.p) return;
    scene.p = p;

    var style = scene.stage.style;
    var values = {};
    style.setProperty('--p', p.toFixed(4));

    Object.keys(scene.phases).forEach(function (key) {
      var range = scene.phases[key];
      var v = seg(p, range[0], range[1]);
      values[key] = v;
      style.setProperty('--s-' + key, v.toFixed(4));
    });

    scene.flags.forEach(function (f) {
      f.node.classList.toggle('is-on', values[f.phase] >= 0.5);
    });

    scene.ranged.forEach(function (r) {
      r.node.classList.toggle('is-active', p >= r.range[0] && p < r.range[1]);
    });

    scene.typed.forEach(function (t) {
      var v = values[t.phase] || 0;
      var len = Math.round(v * t.text.length);
      if (len !== t.len) {
        t.len = len;
        t.node.textContent = t.text.slice(0, len);
      }
    });

    scene.counters.forEach(function (c) {
      var v = values[c.phase] || 0;
      var value = Math.round(v * c.target);
      if (value !== c.value) {
        c.value = value;
        c.node.textContent = formatCount(value);
      }
    });

    scene.states.forEach(function (s) {
      var v = values[s.phase] || 0;
      var state = v <= 0 ? 'ready' : v >= 0.999 ? 'done' : 'running';
      if (s.node.getAttribute('data-state') !== state) s.node.setAttribute('data-state', state);
    });

    if (scene.name === 'providers') applyPicker(scene, p);

    if (scene.progress) scene.progress.style.transform = 'scaleX(' + p.toFixed(4) + ')';
  }

  function applyPicker(scene, p) {
    var range = scene.phases.roll;
    var count = scene.items.length;
    if (!count) return;
    var step = (range[1] - range[0]) / (count - 1);
    var roll = 0;
    for (var k = 0; k < count - 1; k += 1) {
      var a = range[0] + k * step;
      roll += seg(p, a, a + step * 0.62);
    }
    scene.stage.style.setProperty('--roll', roll.toFixed(4));

    var active = Math.round(roll);
    if (active !== scene.active) {
      scene.active = active;
      scene.items.forEach(function (li, i) {
        li.classList.toggle('is-active', i === active);
      });
      var kind = scene.items[active].getAttribute('data-kind');
      scene.stage.setAttribute('data-kind', kind);
      scene.kinds.forEach(function (node) {
        node.classList.toggle('is-active', node.getAttribute('data-kind') === kind);
      });
    }
  }

  /* Geometry that only changes on resize: read once, not per frame. */
  function layout() {
    headerH = header ? header.offsetHeight : 0;
    scenes.forEach(function (scene) {
      scene.travel = scene.el.offsetHeight - scene.stage.offsetHeight;
    });
  }

  function measure(scene) {
    if (scene.travel <= 0) return 1;
    var top = scene.el.getBoundingClientRect().top;
    return clamp((headerH - top) / scene.travel, 0, 1);
  }

  var scenes = Array.prototype.map.call(document.querySelectorAll('[data-scene]'), buildScene);

  /* Reveal-on-scroll for regular sections */
  var revealTargets = document.querySelectorAll('[data-reveal]');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealTargets.forEach(function (node) {
      node.classList.add('in');
    });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );
    revealTargets.forEach(function (node) {
      observer.observe(node);
    });
  }

  if (reduceMotion) {
    /* Static final-state layout; see the html:not(.js) rules in styles.css. */
    document.documentElement.classList.remove('js');
    return;
  }

  var ticking = false;
  function frame() {
    ticking = false;
    /* All layout reads first, then all style writes: one reflow per frame. */
    var progress = scenes.map(measure);
    scenes.forEach(function (scene, i) {
      applyScene(scene, progress[i]);
    });
  }
  function schedule() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(frame);
    }
  }

  function relayout() {
    layout();
    schedule();
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', relayout);
  window.addEventListener('load', relayout);
  layout();
  frame();
})();
