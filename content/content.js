/*
 * 素材采集器 · 内容脚本
 * 负责：区域选择遮罩 / Alt+右键 / 批量采集面板 / 整页截图度量与拼接 / 页内提示
 */
(function () {
  'use strict';
  const CC = self.CC;
  if (!CC || CC.__contentReady) return;
  CC.__contentReady = true;

  const SKEY = CC.SETTINGS_KEY;

  /* ================= 设置 ================= */

  const FALLBACK = {
    altRightClick: true,
    pinSaveMirror: false,
    pinMirrorDebug: false,
    minSize: 120,
    toastInPage: true,
    format: 'png',
    quality: 0.92
  };

  let settings = Object.assign({}, FALLBACK);

  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get(SKEY);
      const s = got && got[SKEY];
      if (s) settings = Object.assign({}, FALLBACK, s);
    } catch (_) {}
  }

  /* ================= 失败留痕 ================= */

  /**
   * 把失败原因写进扩展存储（`collector.lastError`）。
   *
   * 为什么值得单独存一份：页内提示 5 秒就消失，事后谁也说不清当时报了什么，
   * 而排查最需要的就是那句原文。存在这里之后，弹窗能直接显示，
   * 维护者也能从存储里读到 —— 不用让用户复述。
   */
  function recordErr(where, message, extra) {
    try {
      chrome.storage.local.set({
        'collector.lastError': Object.assign(
          { at: Date.now(), where: String(where || ''), message: String(message || '') },
          extra || {}
        )
      });
    } catch (_) {}
  }

  /* ================= 设置 ================= */

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SKEY]) {
        settings = Object.assign({}, FALLBACK, changes[SKEY].newValue || {});
      }
    });
  } catch (_) {}

  /* ================= 与后台通信 ================= */

  /**
   * 上下文已失效（在 quark://extensions 点过刷新 ↻，但本页没 F5）。
   *
   * 这时候本页里还是**旧脚本**：它的 DOM 逻辑照常跑（能定位按钮、能算原图地址、
   * 甚至能弹 toast），但 `chrome.runtime` / `chrome.storage` 已经断开。
   * 结果是「保存失败」但后台一条记录都没有 —— 最难查的那种：
   * 用户看到报错，我们在存储里却什么都找不到。
   */
  const MSG_STALE = '扩展刚更新过，本页脚本已失效 —— 按 F5 刷新本页再试';
  const MSG_NORESP = '后台没有响应（可能刚被浏览器回收）—— 再点一次，或刷新本页';

  function runtimeAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /** 把浏览器的英文 lastError 翻成「用户下一步该做什么」 */
  function bgError(message) {
    const m = String(message || '');
    if (/context invalidated|Extension context invalidated/i.test(m)) {
      return { error: MSG_STALE, stale: true };
    }
    if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(m)) {
      return { error: MSG_NORESP, stale: true };
    }
    return { error: m };
  }

  function bg(msg) {
    return new Promise((resolve) => {
      if (!runtimeAlive()) return resolve(Object.assign({ ok: false }, bgError('context invalidated')));
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return resolve(Object.assign({ ok: false }, bgError(err.message)));
          // 后台被回收 / 没接上时 res 是 undefined，调用方紧接着取属性会抛异常；
          // 统一兜成空对象，让调用方只需判断 ok / error 两个字段。
          if (res == null) return resolve(Object.assign({ ok: false }, bgError('message port closed')));
          resolve(res);
        });
      } catch (e) {
        resolve(Object.assign({ ok: false }, bgError((e && e.message) || e)));
      }
    });
  }

  /* ================= 页内提示 ================= */

  let toastBox = null;

  /**
   * 页内提示。
   *
   * @param force 无视「在页面右下角显示操作提示」这个开关 —— 只有诊断模式用。
   *   诊断模式下使用者**主动要**看见判定过程，被自己的提示开关挡住就白搭了。
   */
  function toast(text, kind, ms, force) {
    if (!settings.toastInPage && !force) return;
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'ccx-toasts';
      document.documentElement.appendChild(toastBox);
    }
    const el = document.createElement('div');
    el.className = 'ccx-toast' + (kind ? ' ccx-' + kind : '');
    if (kind === 'wait') {
      const sp = document.createElement('div');
      sp.className = 'ccx-spin';
      el.appendChild(sp);
    }
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    toastBox.appendChild(el);
    const life = ms || (kind === 'wait' ? 60000 : kind === 'err' ? 5200 : 2600);
    if (kind !== 'wait') {
      setTimeout(() => {
        el.style.transition = 'opacity .25s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 260);
      }, life);
    }
    return el;
  }

  function closeToast(el) {
    if (el && el.parentNode) el.remove();
  }

  /* ================= 进度条 ================= */

  let progressEl = null;

  function progress(text, ratio) {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.className = 'ccx-progress';
      progressEl.innerHTML =
        '<div class="ccx-spin"></div><span class="ccx-progress-text"></span>' +
        '<div class="ccx-progress-bar"><i></i></div>';
      document.documentElement.appendChild(progressEl);
    }
    progressEl.querySelector('.ccx-progress-text').textContent = text;
    if (typeof ratio === 'number') {
      progressEl.querySelector('.ccx-progress-bar > i').style.width =
        Math.max(0, Math.min(100, Math.round(ratio * 100))) + '%';
    }
  }

  function closeProgress() {
    if (progressEl) progressEl.remove();
    progressEl = null;
  }

  /* ================= 区域选择 ================= */

  let regionLayer = null;

  function pickRegion() {
    return new Promise((resolve) => {
      if (regionLayer) return resolve(null);

      const layer = document.createElement('div');
      layer.className = 'ccx-layer ccx-region-layer';

      const sel = document.createElement('div');
      sel.className = 'ccx-region-sel';
      sel.style.display = 'none';
      const sizeTag = document.createElement('span');
      sizeTag.className = 'ccx-region-size';
      sel.appendChild(sizeTag);

      const hLine = document.createElement('div');
      hLine.className = 'ccx-cross-h';
      hLine.style.display = 'none';
      const vLine = document.createElement('div');
      vLine.className = 'ccx-cross-v';
      vLine.style.display = 'none';

      const tip = document.createElement('div');
      tip.className = 'ccx-region-tip';
      tip.innerHTML = '按住左键拖拽框选 · <b>Esc</b> 取消';

      layer.append(sel, hLine, vLine, tip);
      document.documentElement.appendChild(layer);
      regionLayer = layer;

      let sx = 0;
      let sy = 0;
      let dragging = false;

      const clamp = (v, max) => Math.max(0, Math.min(max, v));

      function draw(x0, y0, x1, y1) {
        const l = Math.min(x0, x1);
        const t = Math.min(y0, y1);
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);
        sel.style.display = 'block';
        sel.style.left = l + 'px';
        sel.style.top = t + 'px';
        sel.style.width = w + 'px';
        sel.style.height = h + 'px';
        sizeTag.textContent = Math.round(w) + ' × ' + Math.round(h);
        return { x: l, y: t, w, h };
      }

      function cleanup() {
        layer.removeEventListener('mousedown', onDown, true);
        layer.removeEventListener('mousemove', onMove, true);
        layer.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('keydown', onKey, true);
        if (regionLayer === layer) regionLayer = null;
        layer.remove();
      }

      function onDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        draw(sx, sy, sx, sy);
      }

      function onMove(e) {
        if (!dragging) {
          hLine.style.display = 'block';
          vLine.style.display = 'block';
          hLine.style.top = e.clientY + 'px';
          vLine.style.left = e.clientX + 'px';
          return;
        }
        e.preventDefault();
        draw(sx, sy, e.clientX, e.clientY);
      }

      function onUp(e) {
        if (!dragging) return;
        dragging = false;
        e.preventDefault();
        e.stopPropagation();
        const rect = draw(sx, sy, e.clientX, e.clientY);
        if (rect.w < 5 || rect.h < 5) {
          sel.style.display = 'none';
          sizeTag.textContent = '';
          return;
        }
        cleanup();
        resolve(rect);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup();
          resolve(null);
        }
      }

      layer.addEventListener('mousedown', onDown, true);
      layer.addEventListener('mousemove', onMove, true);
      layer.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
    });
  }

  /* ================= 整页截图 ================= */

  let pageState = null;

  function measurePage() {
    const de = document.documentElement;
    const b = document.body;
    const height = Math.max(
      de.scrollHeight,
      de.offsetHeight,
      b ? b.scrollHeight : 0,
      b ? b.offsetHeight : 0,
      window.innerHeight
    );
    const width = Math.max(de.clientWidth || 0, window.innerWidth);
    return { width, height, viewport: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  }

  function hideFixedElements() {
    const hidden = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    const cap = Math.min(all.length, 6000);
    for (let i = 0; i < cap; i++) {
      const el = all[i];
      if (!el || el.className === undefined) continue;
      if (typeof el.className === 'string' && el.className.indexOf('ccx-') >= 0) continue;
      let pos = '';
      try {
        pos = getComputedStyle(el).position;
      } catch (_) {
        continue;
      }
      if (pos === 'fixed' || pos === 'sticky') {
        hidden.push([el, el.style.visibility]);
        el.style.visibility = 'hidden';
      }
    }
    return hidden;
  }

  function restoreFixed(hidden) {
    (hidden || []).forEach(([el, prev]) => {
      try {
        el.style.visibility = prev || '';
      } catch (_) {}
    });
  }

  async function fullPagePrepare(opts) {
    if (pageState) return measurePage();
    const before = { x: window.scrollX, y: window.scrollY };
    const de = document.documentElement;
    const prevBehavior = de.style.scrollBehavior;
    de.style.scrollBehavior = 'auto';

    pageState = { before, prevBehavior, hidden: [], lazy: !!(opts && opts.lazy !== false) };

    // 预滚动一次，触发懒加载
    if (pageState.lazy) {
      const m = measurePage();
      const step = Math.max(300, Math.round(m.viewport * 1.5));
      let y = 0;
      let guard = 0;
      while (y < m.height - m.viewport && guard++ < 40) {
        window.scrollTo(0, y);
        await CC.sleep(90);
        y += step;
      }
      window.scrollTo(0, m.height);
      await CC.sleep(400);
      window.scrollTo(0, 0);
      await CC.sleep(260);
    }

    pageState.hidden = hideFixedElements();
    const m = measurePage();
    return m;
  }

  function fullPageScroll(y) {
    window.scrollTo(0, y);
    return window.scrollY;
  }

  function fullPageRestore() {
    if (!pageState) return;
    restoreFixed(pageState.hidden);
    try {
      document.documentElement.style.scrollBehavior = pageState.prevBehavior || '';
      window.scrollTo(pageState.before.x, pageState.before.y);
    } catch (_) {}
    pageState = null;
  }

  /* ================= 图片候选收集 ================= */

  function absUrl(u) {
    try {
      return new URL(u, location.href).href;
    } catch (_) {
      return '';
    }
  }

  const LAZY_ATTRS = [
    'data-src',
    'data-original',
    'data-lazy-src',
    'data-lazyload',
    'data-actualsrc',
    'data-echo',
    'data-url',
    'data-image'
  ];

  function collectCandidates(minSize) {
    const map = new Map();
    const min = Math.max(0, Number(minSize) || 0);

    function add(raw, w, h, kind) {
      const url = absUrl(raw);
      if (!url) return;
      if (/^data:/.test(url) && url.length < 2048) return; // 极小的内联图标直接忽略
      if (/^https?:/i.test(url) === false && !/^data:/.test(url)) return;
      const ew = Number(w) || 0;
      const eh = Number(h) || 0;
      if (min > 0 && ew > 0 && eh > 0 && (ew < min || eh < min)) return;
      const key = url;
      const prev = map.get(key);
      if (prev) {
        prev.w = Math.max(prev.w, ew);
        prev.h = Math.max(prev.h, eh);
        return;
      }
      map.set(key, { url, w: ew, h: eh, kind });
    }

    // <img>
    document.querySelectorAll('img').forEach((img) => {
      const url = img.currentSrc || img.src || '';
      if (url) add(url, img.naturalWidth, img.naturalHeight, 'img');
      LAZY_ATTRS.forEach((a) => {
        const v = img.getAttribute(a);
        if (v) add(v, img.naturalWidth, img.naturalHeight, 'img');
      });
      const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (ss) {
        const best = ss
          .split(',')
          .map((s) => s.trim().split(/\s+/))
          .filter((p) => p[0])
          .sort((a, b) => (parseFloat(b[1]) || 1) - (parseFloat(a[1]) || 1))[0];
        if (best) add(best[0], img.naturalWidth, img.naturalHeight, 'img');
      }
    });

    // <picture><source>
    document.querySelectorAll('picture source[srcset]').forEach((s) => {
      const first = (s.getAttribute('srcset') || '').split(',')[0];
      if (first) add(first.trim().split(/\s+/)[0], 0, 0, 'img');
    });

    // <video poster>
    document.querySelectorAll('video[poster]').forEach((v) => {
      add(v.getAttribute('poster'), 0, 0, 'video');
    });

    // CSS 背景图
    const all = document.body ? document.body.querySelectorAll('*') : [];
    const cap = Math.min(all.length, 7000);
    for (let i = 0; i < cap; i++) {
      const el = all[i];
      if (!el || typeof el.className !== 'string') continue;
      if (el.className.indexOf('ccx-') >= 0) continue;
      let bgi = '';
      try {
        bgi = getComputedStyle(el).backgroundImage;
      } catch (_) {
        continue;
      }
      if (!bgi || bgi === 'none' || bgi.indexOf('url(') < 0) continue;
      const re = /url\((['"]?)([^'")]+)\1\)/g;
      let m;
      while ((m = re.exec(bgi))) {
        const r = el.getBoundingClientRect();
        add(m[2], Math.round(r.width), Math.round(r.height), 'bg');
      }
    }

    // 指向图片文件的链接
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i.test(href)) {
        add(href, 0, 0, 'link');
      }
    });

    // 大图优先
    const list = Array.from(map.values());
    list.sort((a, b) => b.w * b.h - a.w * a.h);
    return list;
  }

  /* ================= 批量采集面板 ================= */

  let batchLayer = null;

  function openBatchPanel(minSize) {
    if (batchLayer) return { count: 0 };

    const items = collectCandidates(minSize);
    const selected = new Set(items.map((it) => it.url));

    const layer = document.createElement('div');
    layer.className = 'ccx-layer ccx-panel-mask';

    const panel = document.createElement('div');
    panel.className = 'ccx-panel';

    panel.innerHTML =
      '<div class="ccx-panel-head">' +
      '<span class="ccx-panel-title">批量采集</span>' +
      '<span class="ccx-panel-count"></span>' +
      '<div class="ccx-panel-tools">' +
      '<label style="font-size:12px;color:#64748b">最小边长</label>' +
      '<input class="ccx-input ccx-min" type="number" min="0" step="20" value="' +
      (Number(minSize) || 0) +
      '">' +
      '<button class="ccx-btn ccx-all">全选</button>' +
      '<button class="ccx-btn ccx-none">全不选</button>' +
      '<button class="ccx-btn ccx-invert">反选</button>' +
      '</div></div>' +
      '<div class="ccx-panel-body"><div class="ccx-grid"></div></div>' +
      '<div class="ccx-panel-foot">' +
      '<span class="ccx-foot-tip" style="font-size:12px;color:#64748b"></span>' +
      '<div style="margin-left:auto;display:flex;gap:8px">' +
      '<button class="ccx-btn ccx-cancel">取消</button>' +
      '<button class="ccx-btn ccx-btn-primary ccx-save">采集选中</button>' +
      '</div></div>';

    layer.appendChild(panel);
    document.documentElement.appendChild(layer);
    batchLayer = layer;

    const grid = panel.querySelector('.ccx-grid');
    const countEl = panel.querySelector('.ccx-panel-count');
    const footTip = panel.querySelector('.ccx-foot-tip');
    const saveBtn = panel.querySelector('.ccx-save');
    const minInput = panel.querySelector('.ccx-min');

    let current = items;

    function render() {
      grid.innerHTML = '';
      if (!current.length) {
        grid.innerHTML = '<div class="ccx-empty" style="grid-column:1/-1">没有找到符合条件的图片</div>';
      }
      const frag = document.createDocumentFragment();
      current.forEach((it) => {
        const card = document.createElement('div');
        card.className = 'ccx-card' + (selected.has(it.url) ? ' ccx-on' : '');
        card.title = it.url;

        const img = document.createElement('img');
        img.className = 'ccx-card-thumb';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.src = it.url;
        img.onerror = () => {
          img.style.opacity = '0.25';
        };

        const tick = document.createElement('div');
        tick.className = 'ccx-card-tick';
        tick.textContent = '✓';

        const meta = document.createElement('div');
        meta.className = 'ccx-card-meta';
        const sizeTxt = it.w && it.h ? it.w + '×' + it.h : '尺寸未知';
        meta.textContent = sizeTxt + ' · ' + it.kind;

        card.append(img, tick, meta);
        card.addEventListener('click', () => {
          if (selected.has(it.url)) selected.delete(it.url);
          else selected.add(it.url);
          card.classList.toggle('ccx-on', selected.has(it.url));
          updateCount();
        });
        frag.appendChild(card);
      });
      grid.appendChild(frag);
      updateCount();
    }

    function updateCount() {
      countEl.textContent = selected.size + ' / ' + current.length;
      saveBtn.textContent = '采集选中（' + selected.size + '）';
      saveBtn.disabled = selected.size === 0;
      footTip.textContent = '点击缩略图切换选中状态';
    }

    function close() {
      window.removeEventListener('keydown', onKey, true);
      layer.remove();
      if (batchLayer === layer) batchLayer = null;
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener('keydown', onKey, true);

    panel.querySelector('.ccx-all').addEventListener('click', () => {
      current.forEach((it) => selected.add(it.url));
      render();
    });
    panel.querySelector('.ccx-none').addEventListener('click', () => {
      current.forEach((it) => selected.delete(it.url));
      render();
    });
    panel.querySelector('.ccx-invert').addEventListener('click', () => {
      current.forEach((it) => {
        if (selected.has(it.url)) selected.delete(it.url);
        else selected.add(it.url);
      });
      render();
    });
    panel.querySelector('.ccx-cancel').addEventListener('click', close);

    const doFilter = () => {
      const v = Number(minInput.value) || 0;
      current = items.filter((it) => {
        if (!v) return true;
        if (!it.w || !it.h) return true;
        return it.w >= v && it.h >= v;
      });
      render();
    };
    minInput.addEventListener('change', doFilter);
    minInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doFilter();
    });

    saveBtn.addEventListener('click', async () => {
      const picked = current.filter((it) => selected.has(it.url));
      close();
      if (!picked.length) return;
      const t = toast('正在采集 ' + picked.length + ' 张图片…', 'wait');
      progress('准备中…', 0);
      const res = await bg({
        type: 'batch:save',
        items: picked.map((p) => ({ url: p.url, w: p.w, h: p.h })),
        pageTitle: document.title,
        sourceUrl: location.href
      });
      closeToast(t);
      closeProgress();
      const ok = (res && res.ok) || 0;
      const fail = (res && res.failed) || 0;
      const dup = (res && res.duplicated) || 0;
      const parts = ['成功 ' + ok];
      if (dup) parts.push('重复跳过 ' + dup);
      if (fail) parts.push('失败 ' + fail);
      toast(parts.join(' · '), fail && !ok ? 'err' : 'ok', 5000);
    });

    render();
    return { count: items.length };
  }

  /* ================= 单图采集 ================= */

  /**
   * 找出「这一点下面真正的那张图」。
   *
   * 为什么不能只看 e.target 是不是 <img>：不少站点会在图片上盖一层**透明 div**
   * （Pinterest 的视觉搜索热区是最典型的一个，还有各种自定义右键拦截层）。
   * 此时 e.target 是那个 div —— 既不是 <img>，浏览器的 `contexts:['image']` 判定
   * 也不会命中，所以连浏览器自带的「图片另存为」都一起消失。
   *
   * document.elementsFromPoint() 会把该点下方的**所有**元素按层级返回（覆盖层在最前），
   * 顺着往下找第一个 <img> 即可 —— 那就是用户肉眼看到的那张图。
   */
  function imageUnderPoint(target, x, y) {
    if (target && target.tagName === 'IMG') return target;
    const hasPt = typeof x === 'number' && typeof y === 'number';
    if (hasPt && typeof document.elementsFromPoint === 'function') {
      for (const el of document.elementsFromPoint(x, y) || []) {
        if (el && el.tagName === 'IMG') return el;
      }
    }
    if (hasPt) {
      // 退化路径：覆盖层与图片往往同处一个容器。往上最多找 3 层，
      // 只认「确实盖住这个点」的那张图 —— 避免误抓同容器里的站点 logo 之类。
      let box = target;
      for (let i = 0; i < 3 && box; i++) {
        const imgs = box.querySelectorAll ? box.querySelectorAll('img') : [];
        for (const im of imgs) {
          const r = im.getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return im;
        }
        box = box.parentElement;
      }
    }
    return null;
  }

  /* ================= Pinterest 大图 ================= */

  /** 元素当前是否可见（有尺寸、没被 display/visibility/opacity 藏起来、与视口有交集） */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0)) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /**
   * 扫出页面上的 Pinterest 图片候选。
   *
   * 不猜「当前是哪一个 pin」—— closeup 页里最大的那张可见图就是大图本身，
   * 瀑布流里最大的一张缩略图所对应的 originals 也还是同一张原图。够用且不依赖
   * Pinterest 随时会改的内部数据结构。
   */
  function pinCandidates() {
    const out = [];
    const seen = new Set();
    const push = (url, w, h, front) => {
      const u = String(url || '').trim().split(/\s+/)[0];
      if (!/^https?:\/\/[^/]*pinimg\.com\//i.test(u)) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.push({ url: u, w: Number(w) || 0, h: Number(h) || 0, front: !!front });
    };
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      const nat = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      push(img.currentSrc || img.src || '', img.naturalWidth, img.naturalHeight, isVisible(img) && nat > 100000);
      const ss = img.getAttribute && img.getAttribute('srcset');
      if (ss) for (const part of String(ss).split(',')) push(part, 0, 0, false);
      const orig = img.getAttribute && img.getAttribute('data-orig-img');
      if (orig) push(orig, 0, 0, false);
    }
    return out;
  }

  function pinScan() {
    const cands = pinCandidates();
    if (!cands.length) return { error: '本页没有找到 Pinterest 图片' };
    // 有自然尺寸的优先；在「可见且够大」的那批里挑面积最大的
    const withArea = cands.filter((c) => c.w * c.h > 0);
    const pool = withArea.length ? withArea : cands;
    const best = pool.slice().sort((a, b) => (b.front - a.front) || (b.w * b.h - a.w * a.h))[0];
    const h1 = document.querySelector('h1');
    return {
      ok: true,
      url: best.url,
      orig: CC.pinimgOriginal(best.url) || '',
      w: best.w,
      h: best.h,
      title: (h1 && h1.textContent) || document.title || ''
    };
  }

  /* ================= 大图推断 ================= */

  /** 解析 srcset，按分辨率描述符从大到小返回候选地址（同一张图的不同尺寸） */
  function srcsetLargest(img) {
    const ss = (img.getAttribute && (img.getAttribute('srcset') || img.getAttribute('data-srcset'))) || '';
    if (!ss) return [];
    return String(ss)
      .split(',')
      .map((part) => {
        const m = String(part).trim().match(/^(\S+)(?:\s+(\d+)w|\s+([\d.]+)x)?$/);
        if (!m) return null;
        return { url: m[1], w: m[2] ? Number(m[2]) : m[3] ? Math.round(Number(m[3]) * 1000) : 0 };
      })
      .filter(Boolean)
      .sort((a, b) => b.w - a.w)
      .map((p) => p.url);
  }

  /**
   * 推断「这张图在页面上对应的最大版本」。
   *
   * 站点普遍把缩略图放在 `src`、把大图藏在别处：Pinterest 的 src/srcset 全是 236x/474x/736x
   * 这类缩略图，点进 pin 详情页看到的那张才是大图。所以单图采集不能直接拿 `src`。
   *
   * 两条路，按可靠性排序：
   *   ① pinimg 的尺寸段是纯路径规则 → 任意一张缩略图都能逆推出 originals 原图（确定，不怕改名）
   *   ② 站点显式声明的大图属性（`data-orig-img` 等）→ 信站点自己给的
   * 都没有时就老实退回页面上渲染的那张，不做无根据的放大猜测。
   *
   * @returns `{ url, alt }`：url 是首选大图；alt 是页面实际渲染的那张，抓取失败时的退路
   */
  function bigSourceOf(img) {
    const page = String(img.currentSrc || img.src || '').trim();
    const cands = [];
    const feed = (v) => {
      const u = String(v || '').trim().split(/\s+/)[0];
      if (u) cands.push(u);
    };

    if (img.getAttribute) {
      for (const a of ['data-orig-img', 'data-original', 'data-large', 'data-hires', 'data-full']) feed(img.getAttribute(a));
    }
    feed(page);
    for (const u of srcsetLargest(img)) feed(u);

    // ① CDN 路径规则能逆推原图 —— 最可靠，优先
    for (const u of cands) {
      const orig = CC.pinimgOriginal(u);
      if (orig) return { url: orig, alt: page || u };
    }
    // ② 站点自己声明的大图属性
    const explicit = String((img.getAttribute && img.getAttribute('data-orig-img')) || '').trim().split(/\s+/)[0];
    if (explicit) return { url: explicit, alt: page };
    // ③ 退回页面渲染的那张
    return { url: page, alt: page };
  }

  /* ================= 本页最大图 ================= */

  /**
   * 「本页最大的那张图」—— 弹窗里的「复制原图」用。
   *
   * 关键是不能拿 img.src：站点普遍把缩略图放在 src、把大图藏在 srcset/自定义属性里
   * （Pinterest 的 src 全是 236x）。所以先按**渲染出来的面积**挑出主角，再交给
   * bigSourceOf 逆推大图地址；尺寸回报的是 naturalWidth/Height（真实像素，
   * 用户一眼就能看出拿到的到底是不是原图）。
   */
  function largestImage() {
    let best = null;
    let bestScore = 0;
    for (const img of document.images) {
      if (!isVisible(img)) continue;
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      const r = img.getBoundingClientRect();
      const w = nw || Math.round(r.width);
      const h = nh || Math.round(r.height);
      if (w < 64 || h < 64) continue; // 略过图标、间隔图、追踪像素
      const score = w * h;
      if (score > bestScore) {
        bestScore = score;
        best = img;
      }
    }
    if (!best) return { error: '本页没有可见的图片' };

    const pick = bigSourceOf(best);
    if (!pick || !pick.url) return { error: '这张图的地址读不到（可能是 canvas 或受保护资源）' };
    return {
      ok: true,
      url: pick.url,
      alt: pick.alt && pick.alt !== pick.url ? pick.alt : '',
      w: best.naturalWidth || 0,
      h: best.naturalHeight || 0
    };
  }

  /* ================= Alt + 右键 ================= */

  document.addEventListener(
    'contextmenu',
    (e) => {
      // 不按 Alt 一律不碰 —— 页面自己的右键菜单必须照常弹。
      // 按下 Alt 之后的失败分支不再静默：以前四种不同的原因（开关关了 /
      // 没认出图 / 读不到地址 / 扩展刚重载）看起来全是「没反应」，
      // 用户没法判断是自己按错还是真坏了。能说话的地方就说话。
      if (!e.altKey) return;
      if (!settings.altRightClick) {
        toast('Alt + 右键采集已在设置里关闭（设置 → 采集行为）', 'err', 4000);
        return;
      }
      const img = imageUnderPoint(e.target, e.clientX, e.clientY);
      if (!img) {
        recordErr('alt:no-image', '这一下没认出图片', { page: location.href });
        toast('这一下没认出图片（可能被透明覆盖层挡住）—— 可改用右键菜单，或在弹窗里点「采集本页大图」', 'err', 5000);
        return;
      }
      // 取「大图」而不是页面上那张缩略图；把缩略图作为抓取失败时的退路
      const pick = bigSourceOf(img);
      if (!pick || !pick.url) {
        recordErr('alt:no-url', '读不到这张图的地址', { page: location.href });
        toast('读不到这张图的地址（可能是 canvas 或受保护资源）', 'err', 4000);
        return;
      }
      const alt = pick.alt && pick.alt !== pick.url ? pick.alt : '';
      e.preventDefault();
      e.stopPropagation();
      const t = toast('正在采集图片…', 'wait');
      bg({
        type: 'single:save',
        url: pick.url,
        fallbackUrl: alt,
        w: img.naturalWidth,
        h: img.naturalHeight,
        pageTitle: document.title,
        sourceUrl: location.href
      }).then((res) => {
        closeToast(t);
        if (res && res.ok) {
          // 降级说明：原图不存在时后台会退到 736x/564x（甚至页面缩略图），
          // 不给提示的话「已保存」三个字会掩盖「这张其实糊了」，只能事后翻 NAS 才发现。
          const tag = res.downgraded && res.sizeTag ? '（原图缺失，存的是 ' + res.sizeTag + '）' : '';
          toast(
            res.duplicated ? '这张图已采集过，已跳过' : '已保存到素材库' + tag,
            res.duplicated ? '' : (tag ? '' : 'ok'),
            tag ? 4200 : 3000
          );
          return;
        }
        const why = String((res && (res.error || res.message)) || '未知错误');
        recordErr('alt:save', why, { url: pick.url, page: location.href, w: img.naturalWidth, h: img.naturalHeight });
        // 重载扩展后，已打开的标签页仍挂着**旧的那份脚本**，它的 chrome.runtime 已经作废。
        // 这是「刚才还能用、改完就不动了」最常见的原因，必须说清是刷新页面而不是功能坏了。
        // 文案已在 bg() 里统一成中文（MSG_STALE / MSG_NORESP），这里只管放大显示时长。
        if (res && res.stale) {
          toast(why, 'err', 6000, true);
          return;
        }
        toast('采集失败：' + why, 'err');
      });
    },
    true
  );

  /* ================= Pinterest「保存」镜像 ================= */

  /**
   * 我在 Pinterest 点「保存」的时候，顺手把同一张图存一份到本地。
   *
   * 为什么是这个方向（而不是让采集去触发 Pinterest 保存）：Pinterest 没有「收藏
   * 已有 pin」的 API，自己去点页面上的保存属于会被封的路子；而用户本来就要保存这一次，
   * 我们只是同时留个底 —— 不涉及对外发布、不需要 token、也不会 30 天过期。
   *
   * 三条纪律：
   *   ① **绝不动事件**（不 preventDefault / 不 stopPropagation）—— Pinterest 自己的保存必须照原样发生
   *   ② 认按钮的**可访问名**，不认 class —— class 是混淆的，每次发版都变
   *   ③ 认不出来就安静 —— 这功能是白捡的，不该在页面上乱弹提示
   */
  const ON_PINTEREST = CC.isPinterestUrl(location.href);

  /** 点击点上「像保存按钮」的那个元素：aria-label / title / 文字 三选一，外加尺寸上限 */
  function saveButtonAt(x, y) {
    const stack = (document.elementsFromPoint && document.elementsFromPoint(x, y)) || [];
    const fits = (el) => {
      if (!el || el.nodeType !== 1 || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      // 按钮的量级；页头、卡片容器、整块面板都远大于这个盒子
      if (r.width < 8 || r.height < 8 || r.width > 360 || r.height > 140) return false;
      return (
        CC.pinSaveLabel(el.getAttribute && el.getAttribute('aria-label')) ||
        CC.pinSaveLabel(el.getAttribute && el.getAttribute('title')) ||
        CC.pinSaveLabel(el.textContent)
      );
    };
    for (const el of stack) {
      if (fits(el)) return el;
      // 命中的往往是按钮里的 <span>，往上一层再看一次就够（再往上就落到卡片容器上了，
      // 那上面也可能糊着「保存」二字，会误判）
      if (el && fits(el.parentElement)) return el.parentElement;
    }
    return null;
  }

  /**
   * 这颗「保存」按钮管的是哪张图。
   *
   * 瀑布流里按钮和图片在同一张卡片下，中间隔着一串混淆 div —— 所以从按钮往上爬，
   * 每层看子树里有没有 pinimg 图片。找到之后不能只挑面积最大的：closeup 页的
   * 右侧推荐位全是大图，会串到别的 pin 上。按「离点击点的距离」打折，取综合分最高的。
   */
  function pinImageFor(btn, x, y) {
    let box = btn;
    for (let i = 0; i < 14 && box; i++) {
      const imgs = box.querySelectorAll ? box.querySelectorAll('img') : [];
      let best = null;
      let bestScore = 0;
      for (const im of imgs) {
        const u = String(im.currentSrc || im.src || '');
        if (!/^https?:\/\/[^/]*pinimg\.com\//i.test(u)) continue;
        const r = im.getBoundingClientRect();
        const dx = x >= r.left && x <= r.right ? 0 : Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
        const dy = y >= r.top && y <= r.bottom ? 0 : Math.min(Math.abs(y - r.top), Math.abs(y - r.bottom));
        const dist = Math.hypot(dx, dy);
        if (dist > 900) continue; // 同一容器里太远的那张不归这颗按钮管
        const area = (im.naturalWidth || r.width) * (im.naturalHeight || r.height);
        const score = area / (1 + dist / 120);
        if (score > bestScore) {
          bestScore = score;
          best = im;
        }
      }
      if (best) return best;
      box = box.parentElement;
    }
    // 按钮直接盖在图片上时（瀑布流悬停保存），走和 Alt+右键 一样的覆盖层穿透
    return imageUnderPoint(null, x, y);
  }

  /** 元素的名字：aria-label → title → 文字。诊断与日志都用它 */
  function nameOf(el) {
    if (!el || el.nodeType !== 1) return '';
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    return (
      norm(el.getAttribute && el.getAttribute('aria-label')) ||
      norm(el.getAttribute && el.getAttribute('title')) ||
      norm(el.textContent)
    );
  }

  /**
   * 诊断用：把点击点上的前几个元素摊开（tagName / 名字 / 尺寸）。
   *
   * 「点了没反应」最难的地方是**看不出中间断在哪一步**：可能开关没开、可能按钮没被认出来、
   * 也可能认出了按钮却找不到图。这段把落点上的元素一并报出来，一眼定位，
   * 不用让人去 F12 里翻那堆混淆的 class。
   */
  function describePoint(x, y) {
    const stack = (document.elementsFromPoint && document.elementsFromPoint(x, y)) || [];
    const bits = [];
    for (const el of stack.slice(0, 4)) {
      if (!el || el.nodeType !== 1) continue;
      const r = el.getBoundingClientRect();
      const nm = nameOf(el).slice(0, 14);
      bits.push(el.tagName.toLowerCase() + (nm ? '「' + nm + '」' : '') + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
    return bits.join(' / ') || '（空）';
  }

  /* 一次保存可能触发多个 click（按钮里套按钮、React 重渲染）→ 同一张图 2.5 秒内只做一次 */
  let lastPinMirror = { url: '', at: 0 };

  document.addEventListener(
    'click',
    (e) => {
      if (!ON_PINTEREST) return;
      // 诊断模式：把每个「为什么没做」都说出来。默认关闭，只在排查「点了没反应」时打开。
      const dbg = !!settings.pinMirrorDebug;
      if (!settings.pinSaveMirror) {
        if (dbg) toast('保存镜像：开关没打开（设置 → 采集行为）', 'err', 5000, true);
        return;
      }
      if (e.button !== 0) return;
      const btn = saveButtonAt(e.clientX, e.clientY);
      if (!btn) {
        if (dbg) {
          toast('保存镜像：没认出「保存」按钮 · 落点上是 ' + describePoint(e.clientX, e.clientY), 'err', 9000, true);
        }
        return;
      }
      const img = pinImageFor(btn, e.clientX, e.clientY);
      if (!img) {
        if (dbg) toast('保存镜像：认出按钮「' + nameOf(btn).slice(0, 12) + '」但没找到对应的图', 'err', 9000, true);
        recordErr('pin:no-image', '点到了保存按钮，但附近没找到对应的图片', { page: location.href });
        return;
      }
      // 和 Alt+右键 一样取「大图」：pinimg 的尺寸段能逆推出 originals
      const pick = bigSourceOf(img);
      if (!pick || !pick.url) {
        if (dbg) toast('保存镜像：图找到了，但读不到它的地址', 'err', 9000, true);
        recordErr('pin:no-url', '读不到这张图的地址', { page: location.href });
        return;
      }
      const now = Date.now();
      if (pick.url === lastPinMirror.url && now - lastPinMirror.at < 2500) return;
      lastPinMirror = { url: pick.url, at: now };
      if (dbg) {
        toast('保存镜像：命中「' + nameOf(btn).slice(0, 10) + '」→ ' + pick.url.slice(-28), '', 3500, true);
      }

      const alt = pick.alt && pick.alt !== pick.url ? pick.alt : '';
      bg({
        type: 'single:save',
        url: pick.url,
        fallbackUrl: alt,
        w: img.naturalWidth,
        h: img.naturalHeight,
        pageTitle: document.title,
        sourceUrl: location.href
      }).then((res) => {
        if (res && res.ok) {
          if (!res.duplicated) {
            const tag = res.downgraded && res.sizeTag ? '（原图缺失，存的是 ' + res.sizeTag + '）' : '';
            toast('已顺手存一份到素材库' + tag, tag ? '' : 'ok', tag ? 4200 : 2200);
          }
          return;
        }
        const why = String((res && (res.error || res.message)) || '未知错误');
        recordErr('pin:save', why, { url: pick.url, page: location.href });
        // 上下文失效时这个提示必须穿透「页内提示」开关：用户之所以来问，就是因为
        // 之前那条失败提示里塞的是浏览器英文原文，看不出该做什么。
        toast('顺手存本地失败：' + why, 'err', res && res.stale ? 6000 : 3200, !!(res && res.stale));
      });
    },
    true
  );

  /* ================= 消息处理 ================= */

  /** blob → dataURL。blob: 地址只存在于页面作用域，service worker 拿不到，只能这里读 */
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }

  /**
   * 在页面里取一张图。相比在扩展后台 fetch，这里带上页面自身的 Cookie 与 Referer，
   * 因此能拿到有防盗链 / 需要登录态的图床图片 —— 后台那一路是拿不到的，只作为首选尝试。
   */
  async function fetchImageAsDataUrl(url) {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const blob = await res.blob();
      if (!blob || !blob.size) return { ok: false, error: '空响应' };
      return { ok: true, dataUrl: await blobToDataUrl(blob), mime: String(blob.type || '').toLowerCase() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'cc:ping':
        return { ok: true, version: '1.7.4' };

      case 'cc:toast':
        toast(msg.text || '', msg.kind || '', msg.ms);
        return { ok: true };

      case 'cc:progress':
        if (msg.hide) closeProgress();
        else progress(msg.text || '处理中…', typeof msg.ratio === 'number' ? msg.ratio : undefined);
        return { ok: true };

      case 'cc:region:pick':
        return await pickRegion();

      case 'cc:image:crop': {
        const out = await CC.cropDataUrl(msg.dataUrl, msg.rect, msg.opts || {});
        return out;
      }

      case 'cc:image:fetch':
        return await fetchImageAsDataUrl(msg.url);

      case 'cc:image:convert':
        return await CC.convertDataUrl(msg.dataUrl, msg.opts || {});

      case 'cc:fullpage:prepare':
        return await fullPagePrepare(msg.opts || {});

      case 'cc:fullpage:scroll':
        return { y: fullPageScroll(msg.y) };

      case 'cc:fullpage:stitch':
        return await CC.stitchDataUrl(msg.shots || [], msg.meta || {}, msg.opts || {});

      case 'cc:fullpage:restore':
        fullPageRestore();
        return { ok: true };

      case 'cc:batch:open':
        return openBatchPanel(msg.minSize);

      case 'pin:scan':
        return pinScan();

      case 'cc:image:largest':
        return largestImage();

      default:
        return { error: '未知指令 ' + msg.type };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('cc:') !== 0) return;
    Promise.resolve(handle(msg))
      // 注意：null 必须原样返回（区域选择被取消时靠它判断），只有 undefined 才补 {ok:true}
      .then((r) => sendResponse(r === undefined ? { ok: true } : r))
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  });

  loadSettings();
})();
