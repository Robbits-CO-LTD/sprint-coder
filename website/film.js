/* Sprint Coder 公式サイト — スクロールが再生になるフィルム。依存なし。
 *
 * - [data-style="--fx: 40%"] … CSP が style 属性を禁じているため、ここで CSSOM から当てる。
 * - .scene[data-steps="0.2,0.5"] … 章。章の中のスクロール位置 0..1 を --p に入れ、
 *   しきい値を越えた数を「拍」として数える。
 * - [data-show="2"] / [data-show="1-3"] … その拍の間だけ .on が付く（"2" は 2 以降ずっと）。
 * - [data-range="0.2,0.8"] … 章の位置をその区間で 0..1 にして --r に入れる（線を引く・帯を伸ばす）。
 *   区間を終えた（--r が 1 の）要素には .is-full が付く。縦並び（.fit-off）では最後の状態（1）で見せる。
 * - [data-count="100"][data-from="1"][data-pad="3"] … 数字の表示。いちばん近い [data-range] の
 *   --r に合わせて from → count を数える（pad は桁をそろえる 0 埋め）。HTML には最後の値を書く。
 * - [data-values="0,3,9,…"] … 同じく --r に合わせて、記録から取った値の列を順に見せる（tools/make-hundred.py が作る）。
 * - [data-clock="1495"] … --r に合わせて 0:00 → 24:55 の経過時刻を見せる（値は秒）。
 * - [data-count-intro="100"] … 序章の数え上げ（000 → 100）。読み込みが遅れたとき・動きを止める設定では
 *   数えず、HTML の値のまま見せる。
 * - .scene.is-live … 章が画面に入っている間だけ付く（群れのまたたきは、これがある間だけ動く）。
 * - .scene[data-real] … 実演の章。いる間は再生バーに「実演」の札を出す（.player.is-real）。
 *   data-real-from="3" を付けると、その拍から出す。data-real-label / data-real-short で札の文言を
 *   その章だけ差し替える（別の日の実演）。
 * - [data-open-promo="promo-100"] … その id の dialog.modal（フル版の動画）を開く。値がなければ #promo-modal。
 * - video[data-src][data-poster] … 近づいたらポスターと動画を読み込み、見えている間だけ再生。
 *   章の中では、包む [data-show] が .on の間だけ再生する。
 * - [data-motion] … 動画と点滅を止めるボタン（全ページ）。選んだ状態は覚えておく。
 * - .player … 章の目印・自動再生・音・フル版（トップのみ）。
 */
(function () {
  'use strict';

  var root = document.documentElement;

  Array.prototype.forEach.call(document.querySelectorAll('[data-style]'), function (el) {
    el.getAttribute('data-style')
      .split(';')
      .forEach(function (decl) {
        var i = decl.indexOf(':');
        if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      });
  });

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) root.classList.add('rm');

  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }
  function store(key, val) {
    try {
      if (val === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, val);
    } catch (e) {
      return null;
    }
  }
  function all(sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  }

  /* ---------------------------------------------------------- 動画 */
  var videos = all('video[data-src]');
  var userStop = store('sc-motion') === 'off';
  var modals = all('dialog.modal');
  function modalOpen() {
    return modals.some(function (d) {
      return d.open;
    });
  }

  function showPoster(v) {
    if (v.dataset.poster && !v.getAttribute('poster')) v.setAttribute('poster', v.dataset.poster);
  }
  function load(v) {
    showPoster(v);
    if (v.dataset.loaded) return;
    v.dataset.loaded = '1';
    v.src = v.dataset.src;
    v.load();
  }
  function canPlay() {
    return !reduce.matches && !userStop && !modalOpen();
  }
  function setPlaying(v, on) {
    if (on && canPlay()) {
      load(v);
      if (v.paused) {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      }
    } else if (!v.paused) {
      v.pause();
    }
  }

  // 動きを減らす設定: 動画は再生せず、ポスター（静止画）だけを見せる
  if (reduce.matches) {
    videos.forEach(function (v) {
      v.removeAttribute('autoplay');
      showPoster(v);
    });
  }

  // 近づいたらポスターを読み込む（最初に全部の静止画を取りに行かない）
  var posterIO =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          function (entries) {
            entries.forEach(function (e) {
              if (e.isIntersecting) {
                showPoster(e.target);
                posterIO.unobserve(e.target);
              }
            });
          },
          { rootMargin: '150% 0px' }
        )
      : null;
  videos.forEach(function (v) {
    if (posterIO) posterIO.observe(v);
    else showPoster(v);
  });

  // 章の外の動画（下層の見出し帯・実画面の枠・最後のダウンロード欄）: 見えている間だけ再生
  var looseVideos = videos.filter(function (v) {
    return !v.closest('.scene');
  });
  var looseVisible = new Map();
  function refreshLoose() {
    looseVideos.forEach(function (v) {
      setPlaying(v, !!looseVisible.get(v));
    });
  }
  if (looseVideos.length && 'IntersectionObserver' in window) {
    var lio = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          looseVisible.set(e.target, e.isIntersecting);
          setPlaying(e.target, e.isIntersecting);
        });
      },
      { threshold: 0.05 }
    );
    looseVideos.forEach(function (v) {
      lio.observe(v);
    });
  }

  /* ---------------------------------------------------------- 動きを止めるボタン（WCAG 2.2.2） */
  var refreshScenes = function () {};
  function setMotion(off) {
    userStop = off;
    store('sc-motion', off ? 'off' : 'on');
    root.classList.toggle('motion-off', off);
    all('[data-motion]').forEach(function (b) {
      b.setAttribute('aria-pressed', off ? 'true' : 'false');
      b.textContent = off ? '動きを再開' : '動きを止める';
    });
    if (off)
      videos.forEach(function (v) {
        if (!v.paused) v.pause();
      });
    refreshLoose();
    refreshScenes();
  }
  if (reduce.matches) {
    all('[data-motion]').forEach(function (b) {
      b.hidden = true;
    });
  } else {
    all('[data-motion]').forEach(function (b) {
      b.hidden = false;
      b.addEventListener('click', function () {
        setMotion(!userStop);
      });
    });
    if (userStop) setMotion(true);
  }

  /* ---------------------------------------------------------- ヘッダー */
  var header = document.querySelector('.site-header');
  function updateHeader() {
    if (header) header.classList.toggle('is-solid', window.scrollY > 40);
  }

  /* ---------------------------------------------------------- フル版のモーダル */
  var lastOpener = null;
  var stopAuto = function () {};
  var setSound = function () {};
  function openModal(e) {
    var modal = document.getElementById(this.getAttribute('data-open-promo') || 'promo-modal');
    if (!modal || typeof modal.showModal !== 'function') return; // 古いブラウザはリンク先（動画ファイル）へ
    if (e) e.preventDefault();
    var modalVideo = modal.querySelector('video');
    lastOpener = document.activeElement;
    stopAuto();
    setSound(false, true);
    if (modalVideo) showPoster(modalVideo);
    modal.showModal();
    videos.forEach(function (v) {
      if (!v.paused) v.pause();
    });
    if (modalVideo) {
      var p = modalVideo.play();
      if (p && p.catch) p.catch(function () {});
    }
  }
  all('[data-open-promo]').forEach(function (b) {
    b.addEventListener('click', openModal);
  });
  modals.forEach(function (modal) {
    var modalVideo = modal.querySelector('video');
    modal.addEventListener('close', function () {
      if (modalVideo) modalVideo.pause();
      if (lastOpener && lastOpener.focus) lastOpener.focus();
      refreshLoose();
      refreshScenes();
    });
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.close();
    });
    var closeBtn = modal.querySelector('[data-close]');
    if (closeBtn)
      closeBtn.addEventListener('click', function () {
        modal.close();
      });
  });

  /* ---------------------------------------------------------- ダウンロード（お使いの OS を目立たせる） */
  (function markOS() {
    var ua = navigator.userAgent || '';
    var os = /Windows/i.test(ua) ? 'win' : /Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua) ? 'mac' : /Linux/i.test(ua) && !/Android/i.test(ua) ? 'linux' : '';
    if (!os) return;
    all('.dl a[data-os="' + os + '"]').forEach(function (a) {
      a.classList.add('is-you');
    });
  })();

  /* ---------------------------------------------------------- フィルム（トップ） */
  var scenes = all('.scene');
  var film = document.querySelector('.film');
  // 章がない・動きを減らす設定・読み込みが遅れて普通の表示に切り替えた後 は、普通に縦に並べる
  if (!scenes.length || !film || reduce.matches || window.__filmFallback) {
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
    if (scenes.length)
      videos.forEach(function (v) {
        v.removeAttribute('autoplay');
        showPoster(v);
      });
    return;
  }
  root.classList.add('js');
  window.__filmReady = true;

  // 序章の数え上げ（000 → 100）。遅れて読み込まれたときは数えない（100 → 000 と後から飛ばないように）
  var intro = document.querySelector('[data-count-intro]');
  if (intro && !userStop && performance.now() < 1500) {
    var goal = +intro.dataset.countIntro;
    intro.textContent = '000';
    requestAnimationFrame(function tick(ts) {
      var k = userStop ? 1 : clamp((ts - 700) / 1000, 0, 1);
      var v = k >= 1 ? goal : Math.round(goal * (1 - Math.pow(2, -10 * k)));
      intro.textContent = String(v).padStart(3, '0');
      if (k < 1) requestAnimationFrame(tick);
    });
  }

  var model = scenes.map(function (el) {
    var steps = (el.dataset.steps || '')
      .split(',')
      .filter(Boolean)
      .map(Number);
    var shows = all('[data-show]', el).map(function (n) {
      var r = n.dataset.show.split('-');
      return { el: n, a: Number(r[0]), b: r.length > 1 ? Number(r[1]) : Infinity };
    });
    var ranges = all('[data-range]', el).map(function (n) {
      var r = n.dataset.range.split(',').map(Number);
      return { el: n, a: r[0], b: r[1] };
    });
    return {
      el: el,
      steps: steps,
      shows: shows,
      ranges: ranges,
      counts: all('[data-count], [data-values], [data-clock]', el).map(function (n) {
        return {
          el: n,
          to: +n.dataset.count,
          from: +(n.dataset.from || 0),
          pad: +(n.dataset.pad || 0),
          values: n.dataset.values ? n.dataset.values.split(',') : null,
          clock: n.dataset.clock ? +n.dataset.clock : 0,
          host: n.closest('[data-range]'),
          last: null
        };
      }),
      live: false,
      videos: all('video[data-src]', el),
      step: -1,
      visible: false,
      dim: Number(el.dataset.dim || 0),
      title: el.dataset.title || '',
      no: el.dataset.no || ''
    };
  });

  // 近づいた章の動画を先に読み込む
  if ('IntersectionObserver' in window) {
    var nio = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) model[scenes.indexOf(e.target)].videos.forEach(load);
        });
      },
      { rootMargin: '100% 0px' }
    );
    scenes.forEach(function (s) {
      nio.observe(s);
    });
  }

  var vh = window.innerHeight;
  var tops = [];
  var lens = [];
  var filmEnd = 0; // 最後の章の下端（その下はダウンロード欄・フッター）
  var maxY = 0; // いちばん下までスクロールしたときの位置
  function measure() {
    checkFit();
    vh = window.innerHeight;
    tops = scenes.map(function (s) {
      return s.getBoundingClientRect().top + window.scrollY;
    });
    lens = scenes.map(function (s) {
      return Math.max(1, s.offsetHeight - vh);
    });
    var last = scenes[scenes.length - 1];
    filmEnd = last.getBoundingClientRect().bottom + window.scrollY;
    maxY = document.documentElement.scrollHeight - vh;
    placeTicks();
  }
  function chapterAt(y, slack) {
    var cur = 0;
    for (var i = 0; i < tops.length; i++) if (y >= tops[i] - slack) cur = i;
    return cur;
  }

  // 舞台（画面の高さ）に章の中身が収まらないとき（低い画面・縦長で内容が多い・文字の拡大）は、
  // .fit-off を付けて章を普通の縦並びに戻し、全部見せる。そのときは拍で動画を切り替えない
  var lowMQ = window.matchMedia('(max-height: 560px)');
  function fitOff() {
    return root.classList.contains('fit-off');
  }
  function checkFit() {
    root.classList.remove('fit-off');
    if (lowMQ.matches) {
      root.classList.add('fit-off');
      return;
    }
    var over = scenes.some(function (sc) {
      var stage = sc.querySelector('.stage');
      if (!stage) return false;
      var cs = getComputedStyle(stage);
      var limit = stage.clientHeight - parseFloat(cs.paddingBottom) + 8;
      return all(':scope > .beat', stage).some(function (b) {
        return b.offsetTop + b.offsetHeight > limit || b.offsetTop < 0;
      });
    });
    if (over) root.classList.add('fit-off');
  }
  function playScene(m) {
    m.videos.forEach(function (v) {
      var gate = fitOff() ? null : v.closest('[data-show]');
      var shown = true;
      if (fitOff()) {
        // 縦並びでは章が長いので、動画そのものが画面に入っているときだけ再生する
        var r = v.getBoundingClientRect();
        shown = r.height > 0 && r.bottom > 0 && r.top < vh;
      }
      setPlaying(v, m.visible && shown && (!gate || gate.classList.contains('on')));
    });
  }
  refreshScenes = function () {
    model.forEach(playScene);
  };

  function sceneUpdate(m, i, y) {
    var h = lens[i] + vh;
    m.visible = y + vh > tops[i] && y < tops[i] + h;
    if (m.visible !== m.live) {
      m.live = m.visible;
      m.el.classList.toggle('is-live', m.visible);
    }
    if (!m.visible && m.step !== -1 && (y + vh * 2 < tops[i] || y > tops[i] + h + vh)) {
      // 遠く離れた章は、離れるときに一度だけ止めればよい
      if (m.wasVisible) playScene(m);
      m.wasVisible = false;
      return;
    }
    var p = clamp((y - tops[i]) / lens[i], 0, 1);
    m.el.style.setProperty('--p', p.toFixed(4));
    var step = 0;
    for (var k = 0; k < m.steps.length; k++) if (p >= m.steps[k]) step = k + 1;
    if (step !== m.step) {
      m.step = step;
      m.el.setAttribute('data-step', String(step));
      m.shows.forEach(function (s) {
        s.el.classList.toggle('on', step >= s.a && step <= s.b);
      });
      m.el.classList.toggle('s-dim', m.dim > 0 && step >= m.dim);
    }
    var full = fitOff(); // 縦並びでは、線・帯・群れ・数字を最後の状態で見せる
    m.ranges.forEach(function (r) {
      var rv = full ? 1 : clamp((p - r.a) / (r.b - r.a), 0, 1);
      r.el.style.setProperty('--r', rv.toFixed(4));
      r.el._r = rv;
      r.el.classList.toggle('is-full', rv >= 1);
    });
    m.counts.forEach(function (c) {
      var r = c.host && c.host._r !== undefined ? c.host._r : 1;
      var v;
      if (c.values) v = c.values[Math.round(r * (c.values.length - 1))];
      else if (c.clock) {
        var sec = Math.round(r * c.clock);
        v = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
      } else {
        v = Math.round(c.from + (c.to - c.from) * r);
        if (c.pad) v = String(v).padStart(c.pad, '0');
      }
      v = String(v);
      if (v !== c.last) {
        c.last = v;
        c.el.textContent = v;
      }
    });
    m.wasVisible = m.visible;
    playScene(m);
  }

  /* ---------------------------------------------------------- 再生バー */
  var player = document.querySelector('.player');
  var track = player && player.querySelector('.p-track');
  var chapterEl = player && player.querySelector('.p-chapter');
  var timeEl = player && player.querySelector('.p-time');
  var playBtn = player && player.querySelector('.p-play');
  var soundBtn = player && player.querySelector('.p-sound');
  var bgm = document.getElementById('bgm');
  var ticks = [];

  var filmTop = 0;
  var filmLen = 1;
  var SPEED = 0.3; // 自動再生: 1 秒に画面の高さの 0.3 倍進む
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }

  // 章の目印はマウス用（キーボードと読み上げは、スライダーの左右キーと aria-valuetext で章を移動する）
  if (track)
    ticks = model.map(function (m, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'p-tick';
      b.tabIndex = -1;
      b.setAttribute('aria-hidden', 'true');
      b.setAttribute('data-label', m.no + ' ' + m.title);
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        stopAuto();
        jump(tops[i] + 2);
      });
      track.appendChild(b);
      return b;
    });
  function placeTicks() {
    if (!track) return;
    filmTop = tops[0];
    var last = scenes.length - 1;
    filmLen = Math.max(1, tops[last] + lens[last] - filmTop);
    ticks.forEach(function (b, i) {
      b.style.left = (((tops[i] - filmTop) / filmLen) * 100).toFixed(3) + '%';
    });
  }

  function jump(y) {
    window.scrollTo({ top: y, behavior: 'auto' });
  }

  var lastCur = -1;
  var lastHidden = null;
  var lastReal = null;
  var lastLabel = null;
  var realFull = player && player.querySelector('.p-real-full');
  var realShort = player && player.querySelector('.p-real-short');
  if (realFull) {
    realFull.dataset.text = realFull.textContent;
    realShort.dataset.text = realShort.textContent;
  }
  function updatePlayer(y) {
    if (!player) return;
    var t = clamp((y - filmTop) / filmLen, 0, 1);
    player.style.setProperty('--t', t.toFixed(4));
    var cur = chapterAt(y, vh * 0.5);
    var m = model[cur];
    if (cur !== lastCur) {
      lastCur = cur;
      var no = document.createElement('small');
      no.textContent = m.no;
      chapterEl.replaceChildren(no, document.createTextNode(m.title));
      ticks.forEach(function (tk, k) {
        tk.classList.toggle('done', k <= cur);
      });
      track.setAttribute('aria-valuenow', String(cur));
      track.setAttribute('aria-valuetext', m.no + '章 ' + m.title);
    }
    // 実演の札は拍の単位で出す（data-real-from="3" なら拍3から。図の拍では出さない）
    var real = m.el.hasAttribute('data-real') && m.step >= Number(m.el.dataset.realFrom || 0);
    if (real !== lastReal) {
      lastReal = real;
      player.classList.toggle('is-real', real);
    }
    // 札の文言は章ごと（別の日の実演の章は data-real-label で差し替える）
    var label = real ? m.el.dataset.realLabel || realFull.dataset.text : null;
    if (real && label !== lastLabel) {
      lastLabel = label;
      realFull.textContent = label;
      realShort.textContent = m.el.dataset.realShort || realShort.dataset.text;
    }
    var total = filmLen / (vh * SPEED);
    timeEl.textContent = fmt(t * total) + ' / ' + fmt(total);
    // フィルムを過ぎたら隠す（下のダウンロードと重ならないように）。隠している間は操作もできなくする
    var hidden = y > filmTop + filmLen + vh * 0.6;
    if (hidden !== lastHidden) {
      lastHidden = hidden;
      player.classList.toggle('is-hidden', hidden);
      player.inert = hidden;
    }
  }

  if (track) {
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(model.length - 1));
    var dragging = false;
    var seekFromEvent = function (e) {
      var r = track.getBoundingClientRect();
      var t = clamp((e.clientX - r.left) / r.width, 0, 1);
      jump(filmTop + t * filmLen);
    };
    var endDrag = function () {
      dragging = false;
    };
    track.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.classList.contains('p-tick')) return;
      dragging = true;
      stopAuto();
      track.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    track.addEventListener('pointermove', function (e) {
      if (dragging) seekFromEvent(e);
    });
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('lostpointercapture', endDrag);
    track.addEventListener('keydown', function (e) {
      var y = window.scrollY;
      var cur = chapterAt(y, 4);
      var to = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') to = Math.min(cur + 1, tops.length - 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') to = Math.max(cur - (y - tops[cur] < vh * 0.3 ? 1 : 0), 0);
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = tops.length - 1;
      if (to < 0) return;
      e.preventDefault();
      stopAuto();
      jump(tops[to] + 2);
    });
  }

  /* 自動再生（ページを動画のように進める） */
  var auto = false;
  var lastTs = 0;
  var autoY = 0;
  var autoSetY = 0;
  function startAuto() {
    if (auto || !player) return;
    auto = true;
    autoY = window.scrollY;
    if (autoY >= filmTop + filmLen - 4) {
      autoY = filmTop;
      jump(autoY);
    }
    autoSetY = window.scrollY;
    lastTs = 0;
    player.classList.add('is-playing');
    playBtn.setAttribute('aria-label', '一時停止');
    requestAnimationFrame(autoStep);
  }
  stopAuto = function () {
    if (!auto) return;
    auto = false;
    player.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', '自動で再生');
  };
  function autoStep(ts) {
    if (!auto) return;
    // 自分以外のスクロール（リンク・スクロールバー・キー操作）が入ったら止める
    if (Math.abs(window.scrollY - autoSetY) > 8) {
      stopAuto();
      return;
    }
    if (lastTs) {
      var dt = Math.min(0.05, (ts - lastTs) / 1000);
      autoY += vh * SPEED * dt;
      var end = filmTop + filmLen;
      if (autoY >= end) {
        jump(end);
        stopAuto();
        return;
      }
      jump(autoY);
      autoSetY = window.scrollY;
    }
    lastTs = ts;
    requestAnimationFrame(autoStep);
  }
  ['wheel', 'touchstart'].forEach(function (ev) {
    window.addEventListener(
      ev,
      function (e) {
        if (e.target && e.target.closest && e.target.closest('.player')) return;
        stopAuto();
      },
      { passive: true }
    );
  });
  if (playBtn)
    playBtn.addEventListener('click', function () {
      if (auto) stopAuto();
      else startAuto();
    });
  all('[data-autoplay]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      startAuto();
    });
  });

  /* 音（既定は消音。押したときだけ鳴らす） */
  var soundOn = false;
  setSound = function (on) {
    soundOn = on;
    if (player) player.classList.toggle('is-sound', on);
    if (soundBtn) {
      soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      soundBtn.setAttribute('aria-label', on ? '音を消す' : '音を出す');
    }
    if (!bgm) return;
    if (on) {
      bgm.volume = 0.45;
      var p = bgm.play();
      if (p && p.catch)
        p.catch(function () {
          setSound(false, true);
        });
    } else {
      bgm.pause();
    }
  };
  if (soundBtn)
    soundBtn.addEventListener('click', function () {
      setSound(!soundOn);
    });

  /* ---------------------------------------------------------- ループ */
  var ticking = false;
  var frameY = 0; // 最後に描いたときの位置（リサイズでブラウザが位置を詰める前の値）
  function frame() {
    ticking = false;
    var y = (frameY = window.scrollY);
    for (var i = 0; i < model.length; i++) sceneUpdate(model[i], i, y);
    updatePlayer(y);
    updateHeader();
  }
  function onScroll() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(frame);
    }
  }
  // 大きさが変わると章の高さ（vh）も変わる。同じ章の同じ進み具合へ戻す
  var rzPending = false;
  function remeasureKeepingPlace(prevY) {
    var y = typeof prevY === 'number' ? prevY : window.scrollY;
    // 章の外（最後の章より下: ダウンロード欄・フッター）は、フィルムの終わりからの距離を保つ
    var after = tops.length && y >= filmEnd ? y - filmEnd : -1;
    var atBottom = tops.length && y >= maxY - 2;
    var i = chapterAt(y, 0);
    var p = tops.length ? clamp((y - tops[i]) / lens[i], 0, 1) : 0;
    var before = tops.length && y < tops[0];
    measure();
    model.forEach(function (m) {
      m.step = -1;
    });
    if (atBottom) jump(maxY);
    else if (after >= 0) jump(Math.min(filmEnd + after, maxY));
    else if (y > 0 && tops.length && !before) jump(tops[i] + p * lens[i]);
    onScroll();
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () {
    if (rzPending) return;
    rzPending = true;
    var prevY = frameY;
    requestAnimationFrame(function () {
      rzPending = false;
      remeasureKeepingPlace(prevY);
    });
  });
  window.addEventListener('load', function () {
    remeasureKeepingPlace();
  });
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(function () {
      remeasureKeepingPlace();
    });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopAuto();
      if (bgm) bgm.pause();
    } else if (soundOn && bgm) {
      bgm.play().catch(function () {});
    }
  });

  measure();
  frame();
})();
