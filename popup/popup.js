/* 觅图采集器 · 弹出面板 */

const $ = (s) => document.querySelector(s);

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        // 一律 resolve 成一个**对象**：后台被回收、尚未唤醒、或没接上时 res 是 undefined，
        // 调用方紧接着取 .stats / .version 就会抛未捕获异常 —— 那会以
        // 「Uncaught (in promise) …」的形式写进扩展管理页的错误列表，看起来像插件坏了。
        resolve(err ? { error: err.message } : (res == null ? {} : res));
      });
    } catch (e) {
      resolve({ error: String((e && e.message) || e) });
    }
  });
}

/**
 * chrome.* 的 Promise 形式：不接住就会变成「Uncaught (in promise) …」写进
 * 扩展管理页的错误列表（对使用者来说那就是「插件坏了」）。这里统一接住失败 ——
 * 这几处调用的失败都没有可做的事，界面本身已有反馈。
 */
function fire(p) {
  try {
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}

/**
 * 兜底网：万一还有漏网的未处理异步异常，也只写进控制台（console.warn），
 * 不冒到扩展管理页的错误列表里。要排查就打开弹窗的开发者控制台看这条 warn。
 */
window.addEventListener('unhandledrejection', (e) => {
  try { console.warn('[觅图采集器] 未处理的异步错误：', e.reason); } catch (_) {}
  e.preventDefault();
});
window.addEventListener('error', (e) => {
  try { console.warn('[觅图采集器] 未捕获错误：', e.message); } catch (_) {}
});

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1073741824) return (v / 1048576).toFixed(2) + ' MB';
  return (v / 1073741824).toFixed(2) + ' GB';
}

let lastStats = null;
/** 保存目标是否就绪：null = 还不知道（首次刷新前）。决定点状态条是「测连接」还是「去设置页」 */
let targetReady = null;

function setHint(text, kind) {
  const el = $('#hint');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (kind ? ' ' + kind : '');
}

/** 状态条很窄，长错误消息要截断 */
function brief(s, n) {
  const t = String(s || '');
  const max = n || 34;
  return t.length > max ? t.slice(0, max) + '…' : t;
}

async function loadStatus() {
  // 弹窗可能在被后台回话之前就被关掉；整段包住，别把异常抛成
  // 「Uncaught (in promise)」写进扩展管理页的错误列表。
  try {
    const st = await send({ type: 'status' });
    const pill = $('#status');
    const statusText = $('#statusText');
    if (!pill || !statusText) return;
    if (!st || st.error) {
      pill.className = 'status bad';
      statusText.textContent = '后台未响应';
      return;
    }
    const verEl = $('#ver');
    if (verEl) verEl.textContent = 'v' + st.version;
    lastStats = st.stats;
    const t = st.target || {};
    targetReady = !!t.ready;
    const pillNow = $('#status');
    if (pillNow) pillNow.title = t.ready ? '点击测试连接' : '点击去设置页填写保存位置';
    if (t.ready) {
      pill.className = 'status ready';
      statusText.textContent = t.label || '已就绪';
    } else {
      pill.className = 'status bad';
      statusText.textContent = t.reason || '保存目标未就绪';
    }

    // WebDAV 是网络通道：后台静默探活一次，避免 NAS 没开却显示绿灯
    if (st.mode === 'webdav' && t.ready) {
      const probe = await send({ type: 'test' });
      if (probe && probe.ok) {
        pill.className = 'status ready';
      } else if (probe && probe.error) {
        pill.className = 'status bad';
        statusText.textContent = 'NAS 不可用 · ' + brief(probe.error);
      }
    }
  } catch (_) {}
}

/* ---------------- 主功能 ---------------- */

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    // 后台继续执行，面板立即关闭，避免遮挡页面影响框选/滚动
    send({ type: 'run', action });
    window.close();
  });
});

/* ---------------- 次要功能 ---------------- */

document.querySelectorAll('[data-link]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.link;

    if (kind === 'stats') {
      const st = lastStats || (await send({ type: 'status' })).stats || {};
      const hhmmss = (() => {
        const t = Number(st.lastAt) || 0;
        if (!t) return '';
        const d = new Date(t);
        const p = (n) => String(n).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      })();
      const tail = hhmmss ? ` · 上次成功 ${hhmmss}` : '';
      if (!st.count) setHint('还没有采集记录');
      else {
        const extra = [];
        if (st.skipped) extra.push('重复跳过 ' + st.skipped);
        if (st.failed) extra.push('失败 ' + st.failed);
        // 「上次成功」不只是统计：它是判断「后台到底有没有收到请求」的唯一直接证据。
        // 刚点过保存、这个时间却纹丝不动 → 请求根本没发出去（页面脚本已失效），
        // 这时去追「保存为什么失败」是白费力气，按 F5 才是对的。
        setHint(
          `累计 ${st.count} 张 · ${fmtSize(st.bytes)}${extra.length ? '（' + extra.join('，') + '）' : ''}${tail}` +
            ' —— 刚点过保存却没变化，就按 F5 刷新页面'
        );
      }
      return;
    }

    if (kind === 'help') {
      fire(chrome.tabs.create({ url: chrome.runtime.getURL('help/help.html') }));
      window.close();
      return;
    }

    if (kind === 'open') {
      const r = await send({ type: 'openIndex' });
      if (r && r.error) setHint('打开失败：' + r.error, 'err');
      else if (r && r.hint) setHint(r.hint, 'ok');
      else window.close();
      return;
    }

    if (kind === 'options') {
      fire(chrome.runtime.openOptionsPage());
      window.close();
      return;
    }

    if (kind === 'about') {
      setHint('觅图 Mito 的浏览器采集端 · 直接写入局域网共享目录，不依赖第三方素材库软件');
      return;
    }
  });
});

/* ---------------- 复制原图 / 素材工作台 ---------------- */

/**
 * 复制原图。
 *
 * 这里刻意回报「真实像素 + 字节数」：站点普遍把缩略图放在 src、
 * 浏览器自带的「复制图片」复制的就是那张缩略图。要让 K 一眼看出
 * 这次拿到的是原图还是退回来的页面版本，所以失败回退时也明说。
 */
$('#copyImg') &&
  $('#copyImg').addEventListener('click', async () => {
    const btn = $('#copyImg');
    btn.disabled = true;
    setHint('正在读取原图…');
    try {
      const r = await send({ type: 'copy:page' });
      if (r && r.ok) {
        const px = r.w && r.h ? r.w + '×' + r.h : '';
        const size = fmtSize(r.bytes);
        const tail = r.via === 'fallback' ? '（原图不可达，已复制页面版本）' : '';
        setHint(`已复制 ${px}${px ? ' · ' : ''}${size}${tail}`, 'ok');
      } else {
        setHint('复制失败：' + brief((r && r.error) || '未知错误', 40), 'err');
      }
    } finally {
      btn.disabled = false;
    }
  });

$('#openStudio') &&
  $('#openStudio').addEventListener('click', () => {
    fire(chrome.tabs.create({ url: chrome.runtime.getURL('studio/studio.html') }));
    window.close();
  });

/* ---------------- 右键菜单自检 / 重新注册 ---------------- */

/**
 * 后台收到这条消息时会**顺手重注册一次**菜单，所以打开弹窗这个动作本身就能把
 * 丢失的右键项补回来。这里只负责把结果显示出来 —— 右键菜单由浏览器进程持有，
 * 页面里看不到，不显示出来就完全是个黑盒。
 */
async function refreshMenuState(isManual) {
  const bar = $('#menuBar');
  const text = $('#menuText');
  if (!bar || !text) return null;
  bar.className = 'menu';
  text.textContent = isManual ? '正在重新注册…' : '右键菜单：检测中…';
  const r = await send({ type: 'menu:status' });
  const m = (r && r.menu) || {};
  if (r && r.error) {
    bar.className = 'menu bad';
    text.textContent = '右键菜单：后台未响应';
    return null;
  }
  if (m.ok) {
    bar.className = 'menu ok';
    text.textContent = '图片右键菜单已就绪';
  } else {
    bar.className = 'menu bad';
    text.textContent = '右键菜单未注册：' + brief(m.error || '未知原因', 28);
  }
  return m;
}

$('#menuFix') &&
  $('#menuFix').addEventListener('click', async () => {
    const m = await refreshMenuState(true);
    if (m && m.ok) {
      setHint('已重新注册：在图片上点右键就能看到「' + (m.title || '将图片保存至觅图') + '」', 'ok');
    } else if (m) {
      setHint('注册失败：' + (m.error || '未知原因'), 'err');
    }
  });

/* ---------------- Pinterest 大图入口 ---------------- */

/**
 * Pinterest 会在图片上盖一层透明 div：右键落点不是 <img>，于是浏览器自带的
 * 「图片另存为」和我们的 `contexts:['image']` 菜单项**都不会出现** ——
 * 那个站点上原生右键这条路是死的（代码侧绕不过去）。
 * 所以给它一个不依赖右键的入口：当前页是 Pinterest 时，面板里直接出现这个按钮。
 */
/*
 * 域名判定统一走 lib/util.js 的 CC.isPinterestUrl()（末尾锚点）。
 * 原来这里有一份本地正则 `pinterest\.[a-z.]+`，它会把 `pinterest.com.evil.com` 也算成
 * Pinterest —— 同一个判断留两份实现，迟早分叉。
 */

async function setupPinEntry() {
  const btn = $('#pinGrab');
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tabs && tabs[0] && tabs[0].url) || '';
    // 域名判定统一走 lib/util.js —— 面板里原来那份本地正则把 `pinterest.com.evil.com`
    // 也算成 Pinterest（漏了末尾锚点），同一个判断不该有两份实现。
    const isPin = CC.isPinterestUrl(url);
    if (btn && isPin) btn.hidden = false;
    if (!isPin) return;

    // 「点了保存没反应」最先要排除的是「开关到底开没开」——从存储里读实际值，
    // 不猜设置页的界面状态（改完没保存、或改了另一个浏览器配置，都会在这里露出来）。
    const got = await chrome.storage.local.get(CC.SETTINGS_KEY);
    const s = (got && got[CC.SETTINGS_KEY]) || {};
    const hint = $('#hint');
    if (!hint) return;
    if (s.pinSaveMirror) {
      hint.textContent = s.pinMirrorDebug
        ? 'Pinterest 保存镜像：已开 · 诊断模式也在开（每次点击都会报判定结果）'
        : 'Pinterest 保存镜像：已开（点「保存」时顺手存一份原图）';
      hint.className = 'hint ok';
    } else {
      hint.textContent = 'Pinterest 保存镜像：未开 —— 设置 → 采集行为 → 勾上「我点保存时也存一份」';
      hint.className = 'hint';
    }
  } catch (_) {}
}

$('#pinGrab') &&
  $('#pinGrab').addEventListener('click', () => {
    // 与四个主入口一致：后台继续执行，面板立即关闭（结果由系统通知回报）
    send({ type: 'pin:collect' });
    window.close();
  });

async function setupHuaBanEntry() {
  const btn = $('#huaBanGrab');
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tabs && tabs[0] && tabs[0].url) || '';
    // 域名判定统一走 lib/util.js —— 与 setupPinEntry 同一纪律，不在这里另写一份正则
    const isHb = CC.isHuabanUrl(url);
    if (btn && isHb) btn.hidden = false;
    if (!isHb) return;

    // 「点了采集没反应」最先要排除的是「开关到底开没开」——从存储里读实际值
    const got = await chrome.storage.local.get(CC.SETTINGS_KEY);
    const s = (got && got[CC.SETTINGS_KEY]) || {};
    const hint = $('#hint');
    if (!hint) return;
    if (s.huaBanSaveMirror) {
      hint.textContent = s.huaBanMirrorDebug
        ? '花瓣网采集镜像：已开 · 诊断模式也在开（每次点击都会报判定结果）'
        : '花瓣网采集镜像：已开（点「采集」时顺手存一份原图）';
      hint.className = 'hint ok';
    } else {
      hint.textContent = '花瓣网采集镜像：未开 —— 设置 → 采集行为 → 勾上「我点采集时也存一份」';
      hint.className = 'hint';
    }
  } catch (_) {}
}

$('#huaBanGrab') &&
  $('#huaBanGrab').addEventListener('click', () => {
    send({ type: 'huaban:collect' });
    window.close();
  });

/* ---------------- 状态栏点击 = 测试连接 ---------------- */

/**
 * 未就绪时（地址/账号没填、目录没授权）点状态条 = 直接去设置页。
 * 为什么：这时点「测试连接」只会回一句「账号未填写」，而真正该做的是去填账号。
 * 配置被重置（移除扩展、换安装路径、浏览器清数据都会）时，状态条是使用者
 * 唯一能立刻看到「为什么一根文件都没存下来」的地方，别让它只是干瞪眼。
 */
$('#status') && $('#status').addEventListener('click', async () => {
  if (targetReady === false) {
    setHint('保存目标未就绪，正在打开设置页…', 'err');
    try {
      await chrome.runtime.openOptionsPage();
    } catch (_) {}
    return;
  }
  setHint('正在测试连接…');
  const r = await send({ type: 'test' });
  if (r && r.ok) {
    if (r.fsa) setHint('目录已授权，可正常写入', 'ok');
    else setHint('NAS WebDAV 正常' + (r.info ? ' · ' + r.info : ''), 'ok');
  } else {
    setHint('连接失败：' + ((r && r.error) || '未知错误'), 'err');
  }
});

/* ---------------- 面板内快捷键 ---------------- */

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const map = { '1': 'batch', '2': 'region', '3': 'viewport', '4': 'fullpage' };
  const action = map[e.key];
  if (!action) return;
  e.preventDefault();
  send({ type: 'run', action });
  window.close();
});

/**
 * 上次失败原因。
 *
 * 页内提示只活五秒，事后谁也复述不出报了什么，而排查最需要的就是那句原文。
 * 后台与内容脚本都往 `collector.lastError` 写一份，这里把它显示出来；
 * 超过一天的不显示 —— 陈年旧账比没有更误导。
 */
/**
 * 本页里跑的脚本，是不是扩展这一版。
 *
 * 为什么值得单独做一条：在 quark://extensions 点 ↻ 之后，**已打开的标签页不会自动换脚本**，
 * 里面那份的 `chrome.runtime` 已经断开。表现是点保存/Alt+右键时收到
 * 「保存失败：<浏览器英文>」，而存储里连一条失败记录都没有（因为它根本没发出去）。
 * 这个不一致只能靠版本比对发现 —— 消息通道还在时才有得比。
 */
async function checkPageScript() {
  const el = $('#staleWarn');
  if (!el) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    let ping = null;
    try {
      ping = await chrome.tabs.sendMessage(tab.id, { type: 'cc:ping' });
    } catch (_) {
      return; // 页面里没有我们的脚本（普通站点），没什么可比的
    }
    if (!ping || !ping.ok || !ping.version) return;
    const cur = chrome.runtime.getManifest().version;
    if (String(ping.version) === String(cur)) return;
    el.innerHTML =
      '本页脚本还是 <b>v' + String(ping.version) + '</b>，扩展已是 <b>v' + cur + '</b>' +
      ' —— 在这个页面按 <b>F5</b> 刷新，采集才会用上新代码。';
    el.hidden = false;
  } catch (_) {}
}

async function showLastError() {
  const el = $('#lastErr');
  if (!el) return;
  let rec = null;
  try {
    const got = await chrome.storage.local.get('collector.lastError');
    rec = got && got['collector.lastError'];
  } catch (_) {
    return;
  }
  if (!rec || !rec.message) return;
  if (!rec.at || Date.now() - rec.at > 24 * 3600 * 1000) return;
  const when = new Date(rec.at).toTimeString().slice(0, 8);
  el.textContent = '上次失败 ' + when + ' · ' + rec.message;
  el.title = [rec.where, rec.url].filter(Boolean).join(' · ');
  el.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  // 打开面板即自检一次菜单，顺带把丢失的右键项补回来
  refreshMenuState(false);
  // Pinterest 上右键这条路走不通，改用面板按钮
  setupPinEntry();
  // 花瓣网同理：面板按钮入口
  setupHuaBanEntry();
  showLastError();
  // 刷新扩展后没 F5 的标签页，在这个面板里直接点出来
  checkPageScript();
});
