/* 素材采集器 · 弹出面板 */

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
  try { console.warn('[素材采集器] 未处理的异步错误：', e.reason); } catch (_) {}
  e.preventDefault();
});
window.addEventListener('error', (e) => {
  try { console.warn('[素材采集器] 未捕获错误：', e.message); } catch (_) {}
});

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1073741824) return (v / 1048576).toFixed(2) + ' MB';
  return (v / 1073741824).toFixed(2) + ' GB';
}

let lastStats = null;

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
      if (!st.count) setHint('还没有采集记录');
      else {
        const extra = [];
        if (st.skipped) extra.push('重复跳过 ' + st.skipped);
        if (st.failed) extra.push('失败 ' + st.failed);
        setHint(`累计 ${st.count} 张 · ${fmtSize(st.bytes)}${extra.length ? '（' + extra.join('，') + '）' : ''}`, 'ok');
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
      setHint('截图与网页图片采集器 · 直接写入局域网共享目录，不依赖第三方素材库软件');
      return;
    }
  });
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
      setHint('已重新注册：在图片上点右键就能看到「' + (m.title || '将图片保存至 LAN Collector') + '」', 'ok');
    } else if (m) {
      setHint('注册失败：' + (m.error || '未知原因'), 'err');
    }
  });

/* ---------------- 状态栏点击 = 测试连接 ---------------- */

$('#status') && $('#status').addEventListener('click', async () => {
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

document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  // 打开面板即自检一次菜单，顺带把丢失的右键项补回来
  refreshMenuState(false);
});
