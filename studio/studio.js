/*
 * 素材采集器 · 素材工作台
 *
 * 只扫「当前选择的目录」，不递归：进来先列目标目录（WebDAV 的 baseUrl / 已授权目录），
 * 点文件夹才往下一层走 —— 素材目录动辄上万张图，一次性递归会把浏览器和 NAS 一起拖住。
 *
 * 两条通道都由本页直接处理（扩展页有 DOM，能解析 XML、能拿 File 对象）：
 *   webdav：列目录走后台（带 Basic 鉴权），缩略图由后台取字节 + offscreen 缩放
 *   fsa   ：直接读已授权的目录句柄，缩略图用本页的 objectURL
 *
 * 复制图片 / 反推提示词都交给后台：前者要 offscreen 写剪贴板，
 * 后者要跑本地 ComfyUI（Qwen3-VL 4B + Krea 2 提示词结构）。
 */

const CC = self.CC;
const $ = (s) => document.querySelector(s);

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg|tiff?|heic)$/i;
const MAX_ITEMS = 800;

const state = {
  settings: null,
  mode: 'webdav',
  rel: '',
  rootHandle: null,
  entries: [],
  sel: null,
  filter: '',
  objectUrls: [],
  revTimer: null,
  queuePoll: null,
  revStart: 0,
  seq: 0
};

/* ---------------- 与后台通信 ---------------- */

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { error: err.message } : res == null ? {} : res);
      });
    } catch (e) {
      resolve({ error: String((e && e.message) || e) });
    }
  });
}

window.addEventListener('unhandledrejection', (e) => {
  try {
    console.warn('[素材工作台] 未处理的异步错误：', e.reason);
  } catch (_) {}
  e.preventDefault();
});
window.addEventListener('error', (e) => {
  try {
    console.warn('[素材工作台] 未捕获错误：', e.message);
  } catch (_) {}
});

/* ---------------- 小工具 ---------------- */

function toast(text, kind, ms) {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms || 3600);
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** UTF-8 安全的 base64（WebDAV 账号可能是中文） */
function b64(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function authHeader() {
  const w = (state.settings && state.settings.webdav) || {};
  if (!w.user) return {};
  return { Authorization: 'Basic ' + b64(w.user + ':' + (w.pass || '')) };
}

function revokeAll() {
  for (const u of state.objectUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch (_) {}
  }
  state.objectUrls = [];
}

function track(url) {
  state.objectUrls.push(url);
  return url;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/* ---------------- 顶栏 ---------------- */

async function paintTarget() {
  const t = await CC.checkTarget(state.settings);
  $('#targetText').textContent = t.ready ? t.label : t.reason || '保存目标未就绪';
}

async function pingComfy() {
  const pill = $('#comfyPill');
  const text = $('#comfyText');
  pill.className = 'pill';
  text.textContent = 'ComfyUI 检测中…';
  const r = await send({ type: 'comfy:ping' });
  if (r && r.ok) {
    pill.className = 'pill ok';
    text.textContent = 'ComfyUI ' + (r.version || '已连接') + (r.device ? ' · ' + r.device.replace(/NVIDIA GeForce /, '') : '');
  } else {
    pill.className = 'pill bad';
    text.textContent = 'ComfyUI 离线：' + String((r && r.error) || '未响应').slice(0, 40);
  }
}

/* ---------------- 列目录 ---------------- */

async function listWebdav(rel) {
  const r = await send({ type: 'lib:list', path: rel });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '列目录失败' };
  return {
    ok: true,
    items: (r.entries || []).map((e) => ({
      name: e.name,
      isDir: e.isDir,
      url: e.url,
      size: e.size,
      mtime: e.lastmod,
      mime: e.mime,
      kind: 'webdav'
    }))
  };
}

async function dirAt(rel) {
  let h = state.rootHandle;
  const segs = String(rel || '').split('/').filter(Boolean);
  for (const seg of segs) h = await h.getDirectoryHandle(seg);
  return h;
}

async function listFsa(rel) {
  if (!state.rootHandle) return { ok: false, error: '尚未授权目录' };
  let perm = 'granted';
  try {
    perm = await state.rootHandle.queryPermission({ mode: 'readwrite' });
  } catch (_) {}
  if (perm !== 'granted') {
    try {
      perm = await state.rootHandle.requestPermission({ mode: 'readwrite' });
    } catch (_) {}
  }
  if (perm !== 'granted') return { ok: false, error: '目录授权已失效，请到设置页重新授权' };

  const dir = await dirAt(rel);
  const items = [];
  for await (const ent of dir.values()) {
    if (ent.kind === 'directory') {
      items.push({ name: ent.name, isDir: true, kind: 'fsa', handle: ent });
    } else if (IMAGE_EXT.test(ent.name)) {
      let file = null;
      try {
        file = await ent.getFile();
      } catch (_) {}
      if (!file) continue;
      items.push({
        name: ent.name,
        isDir: false,
        kind: 'fsa',
        handle: ent,
        file,
        size: file.size,
        mtime: new Date(file.lastModified).toString()
      });
    }
  }
  items.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { ok: true, items };
}

async function load() {
  const seq = ++state.seq;
  revokeAll();
  closePanel();
  $('#grid').innerHTML = '';
  $('#empty').hidden = true;
  $('#count').textContent = '正在读取…';

  let res;
  try {
    res = state.mode === 'fsa' ? await listFsa(state.rel) : await listWebdav(state.rel);
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (seq !== state.seq) return; // 用户已经点到别的目录了

  if (!res.ok) {
    $('#count').textContent = '';
    $('#empty').hidden = false;
    $('#emptyTitle').textContent = '读不到这个目录';
    $('#emptyDesc').textContent = res.error || '未知错误';
    return;
  }

  state.entries = res.items;
  const imgs = state.entries.filter((e) => !e.isDir);
  const dirs = state.entries.filter((e) => e.isDir);
  const shown = state.entries.slice(0, MAX_ITEMS);
  $('#count').textContent = dirs.length + ' 个文件夹 · ' + imgs.length + ' 张图片';

  if (!state.entries.length) {
    $('#empty').hidden = false;
    $('#emptyTitle').textContent = '这个目录是空的';
    $('#emptyDesc').textContent = '换个目录，或先采集几张图再回来刷新。';
    return;
  }
  if (state.entries.length > MAX_ITEMS) {
    toast('目录里有 ' + state.entries.length + ' 项，只显示前 ' + MAX_ITEMS + ' 项');
  }

  const grid = $('#grid');
  const frag = document.createDocumentFragment();
  for (const it of shown) frag.appendChild(it.isDir ? folderCard(it) : imageCard(it));
  grid.appendChild(frag);
  applyFilter();
  renderCrumbs();
}

/* ---------------- 卡片 ---------------- */

const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2.4h8A2 2 0 0 1 21 10v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

function folderCard(it) {
  const el = document.createElement('div');
  el.className = 'card folder';
  el.innerHTML = FOLDER_SVG;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = it.name;
  el.appendChild(name);
  el.addEventListener('click', () => {
    state.rel = state.rel ? state.rel + '/' + it.name : it.name;
    load();
  });
  return el;
}

function imageCard(it) {
  const el = document.createElement('div');
  el.className = 'card';
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const ph = document.createElement('span');
  ph.className = 'ph';
  ph.textContent = '◍';
  thumb.appendChild(ph);

  const cap = document.createElement('div');
  cap.className = 'cap';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = it.name;
  name.title = it.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = it.size ? CC.humanSize(it.size) : '';
  cap.appendChild(name);
  cap.appendChild(sub);

  el.appendChild(thumb);
  el.appendChild(cap);
  el.addEventListener('click', () => select(it, el));

  it._card = el;
  it._thumb = thumb;
  observe(it);
  return el;
}

/* ---------------- 缩略图懒加载 ---------------- */

const thumbQueue = [];
let active = 0;
const THUMB_CONCURRENCY = 3;

const io = new IntersectionObserver(
  (rows) => {
    for (const r of rows) {
      if (!r.isIntersecting) continue;
      const it = r.target._item;
      if (!it || it._loaded) continue;
      it._loaded = true;
      io.unobserve(r.target);
      thumbQueue.push(it);
      pumpThumbs();
    }
  },
  { rootMargin: '240px' }
);

function observe(it) {
  it._card._item = it;
  io.observe(it._card);
}

function pumpThumbs() {
  while (active < THUMB_CONCURRENCY && thumbQueue.length) {
    const it = thumbQueue.shift();
    active++;
    makeThumb(it)
      .catch(() => {})
      .then(() => {
        active--;
        pumpThumbs();
      });
  }
}

async function makeThumb(it) {
  if (!it._thumb) return;
  let src = '';
  if (it.kind === 'fsa' && it.file) {
    src = track(URL.createObjectURL(it.file));
  } else if (it.kind === 'webdav') {
    const r = await send({ type: 'lib:thumb', url: it.url });
    if (!r || !r.ok) return;
    src = r.dataUrl;
  }
  if (!src) return;
  const img = document.createElement('img');
  img.alt = it.name;
  img.loading = 'lazy';
  img.src = src;
  it._thumb.innerHTML = '';
  it._thumb.appendChild(img);
}

/* ---------------- 面板 ---------------- */

function closePanel() {
  $('#panel').hidden = true;
  state.sel = null;
  document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
  stopRevTimer();
  $('#revBox').hidden = true;
}

async function select(it, el) {
  if (state.sel === it) {
    closePanel();
    return;
  }
  document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
  if (el) el.classList.add('sel');
  state.sel = it;

  $('#panel').hidden = false;
  $('#selName').textContent = it.name;
  $('#selName').title = it.name;
  $('#revBox').hidden = true;
  $('#revStatus').textContent = '';
  $('#revTime').textContent = '';
  $('#revText').value = '';

  const bits = [];
  if (it.size) bits.push(CC.humanSize(it.size));
  if (it.mtime) bits.push(fmtDate(it.mtime));
  if (it.isDir === false && it.mime) bits.push(it.mime);
  bits.push(state.mode === 'fsa' ? '本地授权目录' : 'NAS');
  $('#selMeta').textContent = bits.filter(Boolean).join(' · ');

  const prev = $('#selImg');
  prev.removeAttribute('src');
  const src = await previewSrc(it);
  if (src && state.sel === it) prev.src = src;
}

async function previewSrc(it) {
  if (it.kind === 'fsa' && it.file) return track(URL.createObjectURL(it.file));
  if (it.kind === 'webdav') {
    const r = await send({ type: 'lib:thumb', url: it.url });
    return r && r.ok ? r.dataUrl : '';
  }
  return '';
}

/* ---------------- 复制图片 ---------------- */

async function payloadOf(it) {
  if (it.kind === 'fsa' && it.file) return { dataUrl: await fileToDataUrl(it.file) };
  return { url: it.url };
}

async function copySelected() {
  const it = state.sel;
  if (!it) return;
  $('#copyBtn').disabled = true;
  try {
    const p = await payloadOf(it);
    const r = await send(Object.assign({ type: 'copy:image' }, p));
    if (r && r.ok) {
      toast('已复制到剪贴板 · ' + r.w + '×' + r.h + ' · ' + CC.humanSize(r.bytes), 'ok');
    } else {
      toast('复制失败：' + ((r && r.error) || '未知错误'), 'err');
    }
  } finally {
    $('#copyBtn').disabled = false;
  }
}

/* ---------------- 反推提示词 ---------------- */

function stopRevTimer() {
  clearInterval(state.revTimer);
  state.revTimer = null;
  clearInterval(state.queuePoll);
  state.queuePoll = null;
}

function startRevTimer() {
  stopRevTimer();
  state.revStart = Date.now();
  state.revTimer = setInterval(() => {
    const s = ((Date.now() - state.revStart) / 1000).toFixed(1);
    $('#revTime').textContent = s + ' s';
  }, 200);

  // 反推和出图共用同一个 ComfyUI 队列：K 正在跑图时会排在后面。
  // 不把队列状态显出来，界面就是一个不动的转圈，看起来像卡死。
  state.queuePoll = setInterval(async () => {
    const q = await send({ type: 'comfy:queue' });
    if (q && q.ok) {
      $('#revStatus').textContent =
        '推理中 · ComfyUI 队列：运行 ' + q.running + ' · 等待 ' + q.pending;
    }
  }, 3000);
}

async function reverseSelected() {
  const it = state.sel;
  if (!it) return;
  $('#revBox').hidden = false;
  $('#revBtn').disabled = true;
  $('#revText').value = '';
  $('#revStatus').textContent = '正在读取图片…';
  startRevTimer();

  try {
    const p = await payloadOf(it);
    $('#revStatus').textContent = '正在上传到 ComfyUI…';
    const r = await send(Object.assign({ type: 'comfy:reverse' }, p));
    stopRevTimer();
    if (r && r.ok) {
      $('#revText').value = r.text || '';
      // 跨机时把「上传了什么」写出来：压过就说明体积降了多少，没压就是原图
      const up = r.uploaded || null;
      const upTxt = up && up.bytes
        ? ' · 上传 ' + (up.shrunk ? up.w + '×' + up.h + ' · ' + CC.humanSize(up.bytes) + '（压缩自 ' + CC.humanSize(up.before) + '）' : CC.humanSize(up.bytes))
        : '';
      $('#revStatus').textContent = '完成 · ' + ((r.ms || 0) / 1000).toFixed(1) + ' 秒' + upTxt;
      $('#revTime').textContent = '';
    } else {
      $('#revStatus').textContent = '失败：' + ((r && r.error) || '未知错误');
    }
  } catch (e) {
    stopRevTimer();
    $('#revStatus').textContent = '失败：' + String((e && e.message) || e);
  } finally {
    $('#revBtn').disabled = false;
  }
}

async function copyPrompt() {
  const t = $('#revText').value.trim();
  if (!t) {
    toast('还没有反推结果', 'err');
    return;
  }
  try {
    await navigator.clipboard.writeText(t);
    toast('提示词已复制', 'ok');
  } catch (_) {
    // 极少数内核会拒绝扩展页的写剪贴板，退回「选中 + execCommand」
    $('#revText').select();
    const ok = document.execCommand && document.execCommand('copy');
    toast(ok ? '提示词已复制' : '复制失败，请手动 Ctrl+C', ok ? 'ok' : 'err');
  }
}

/* ---------------- 打开原图 ---------------- */

async function openOriginal() {
  const it = state.sel;
  if (!it) return;
  if (it.kind === 'fsa' && it.file) {
    window.open(track(URL.createObjectURL(it.file)), '_blank');
    return;
  }
  try {
    const res = await fetch(it.url, { headers: authHeader(), credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    window.open(track(URL.createObjectURL(blob)), '_blank');
  } catch (e) {
    toast('打开失败：' + String((e && e.message) || e), 'err');
  }
}

/* ---------------- 面包屑 / 过滤 ---------------- */

function renderCrumbs() {
  const nav = $('#crumbs');
  nav.innerHTML = '';
  const segs = String(state.rel || '').split('/').filter(Boolean);

  const root = document.createElement('button');
  root.textContent = state.mode === 'fsa' ? (state.rootHandle ? state.rootHandle.name : '根目录') : '目标目录';
  root.addEventListener('click', () => {
    state.rel = '';
    load();
  });
  nav.appendChild(root);

  let acc = '';
  segs.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    nav.appendChild(sep);
    acc = acc ? acc + '/' + seg : seg;
    if (i === segs.length - 1) {
      const cur = document.createElement('span');
      cur.className = 'cur';
      cur.textContent = seg;
      nav.appendChild(cur);
    } else {
      const b = document.createElement('button');
      b.textContent = seg;
      const target = acc;
      b.addEventListener('click', () => {
        state.rel = target;
        load();
      });
      nav.appendChild(b);
    }
  });
}

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  let n = 0;
  for (const it of state.entries) {
    const el = it._card;
    if (!el) continue;
    const hit = !q || it.name.toLowerCase().includes(q);
    el.hidden = !hit;
    if (hit) n++;
  }
  if (q) $('#count').textContent = '匹配 ' + n + ' 项';
}

/* ---------------- 事件绑定 ---------------- */

$('#refreshBtn').addEventListener('click', () => load());
$('#comfyPill').addEventListener('click', () => pingComfy());
$('#optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage().catch(() => {}));
$('#closePanel').addEventListener('click', () => closePanel());
$('#copyBtn').addEventListener('click', () => copySelected());
$('#revBtn').addEventListener('click', () => reverseSelected());
$('#openBtn').addEventListener('click', () => openOriginal());
$('#copyRev').addEventListener('click', () => copyPrompt());
$('#againRev').addEventListener('click', () => reverseSelected());
$('#filter').addEventListener('input', (e) => {
  state.filter = e.target.value;
  applyFilter();
});

/* ---------------- 启动 ---------------- */

(async function init() {
  state.settings = await CC.getSettings();
  state.mode = state.settings.mode;
  if (state.mode === 'fsa') {
    state.rootHandle = await CC.getDirHandle().catch(() => null);
  }
  await paintTarget();
  await pingComfy();
  load();
})();
