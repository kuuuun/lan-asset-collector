/* 素材采集器 · 设置页 */

const CC = self.CC;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let settings = null;
let saveTimer = null;

/**
 * 兜底网：设置页里的异步流程（读设置、写设置、探测连接）任何一步漏接，
 * 都会以「Uncaught (in promise) …」写进扩展管理页的错误列表 —— 对使用者
 * 来说那就是「插件坏了」。这里只把它降到控制台的 warn，功能不受影响。
 */
window.addEventListener('unhandledrejection', (e) => {
  try { console.warn('[素材采集器] 设置页未处理的异步错误：', e.reason); } catch (_) {}
  e.preventDefault();
});
window.addEventListener('error', (e) => {
  try { console.warn('[素材采集器] 设置页未捕获错误：', e.message); } catch (_) {}
});

/* ---------------- 工具 ---------------- */

function flash(text, ok) {
  const el = $('#saveState');
  el.textContent = text;
  el.className = ok === undefined ? '' : ok ? 'saved' : '';
  if (ok !== undefined) setTimeout(() => (el.textContent = '修改会自动保存'), 2200);
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1073741824) return (v / 1048576).toFixed(2) + ' MB';
  return (v / 1073741824).toFixed(2) + ' GB';
}

/* ---------------- 与界面同步 ---------------- */

function syncModeUI() {
  const mode = settings.mode;
  $$('input[name="mode"]').forEach((r) => {
    r.checked = r.value === mode;
    const item = r.closest('.seg-item');
    if (item) item.classList.toggle('on', r.checked);
  });
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== mode;
  });
}

function syncFormUI() {
  $('#davUrl').value = settings.webdav.baseUrl || '';
  $('#davUser').value = settings.webdav.user || '';
  $('#davPass').value = settings.webdav.pass || '';

  $('#dirTemplate').value = settings.dirTemplate || '';
  $('#nameTemplate').value = settings.nameTemplate || '';

  $('#format').value = settings.format || 'png';
  $('#quality').value = Math.round((settings.quality || 0.92) * 100);
  $('#qualityVal').textContent = Math.round((settings.quality || 0.92) * 100) + '%';
  $('#qualityField').style.opacity = settings.format === 'png' ? 0.45 : 1;

  $('#fullPageMaxHeight').value = settings.fullPageMaxHeight || 20000;
  $('#fullPageDeviceScale').checked = !!settings.fullPageDeviceScale;

  $('#altRightClick').checked = !!settings.altRightClick;
  $('#skipDuplicate').checked = !!settings.skipDuplicate;
  $('#toastInPage').checked = !!settings.toastInPage;
  $('#minSize').value = settings.minSize;

  updatePreview();
}

function updatePreview() {
  const map = CC.tokenMap(new Date(2026, 9, 10, 14, 32, 8), {
    page: '设计参考-网页标题',
    host: 'example.com',
    type: 'region',
    n: 1,
    w: 1920,
    h: 1080
  });
  const dir = CC.sanitizeRelPath(CC.render($('#dirTemplate').value || '', map));
  const base = CC.cleanBase(CC.render($('#nameTemplate').value || '', map), 90);
  $('#preview').textContent = (dir ? dir + '/' : '') + base + '.png';
}

async function refreshTarget() {
  const pill = $('#connPill');
  const t = await CC.checkTarget(settings);
  if (t.ready) {
    pill.className = 'pill ok';
    $('#connText').textContent = t.label;
  } else {
    pill.className = 'pill bad';
    $('#connText').textContent = t.reason || '未就绪';
  }

  if (settings.mode === 'fsa') {
    const h = await CC.getDirHandle().catch(() => null);
    if (!h) {
      $('#dirName').textContent = '未授权';
    } else {
      let perm = 'prompt';
      try {
        perm = await h.queryPermission({ mode: 'readwrite' });
      } catch (_) {}
      $('#dirName').textContent = h.name + (perm === 'granted' ? '' : '（授权已失效，请重新选择）');
    }
  }
}

function refreshStats() {
  const s = settings.stats || {};
  $('#stCount').textContent = s.count || 0;
  $('#stBytes').textContent = fmtSize(s.bytes || 0);
  $('#stSkipped').textContent = s.skipped || 0;
  $('#stFailed').textContent = s.failed || 0;
}

/* ---------------- 保存 ---------------- */

function save(patch, immediate) {
  clearTimeout(saveTimer);
  const doIt = async () => {
    try {
      settings = await CC.setSettings(patch);
      flash('已保存', true);
      await refreshTarget();
      try {
        // 一定要 catch：这是 Promise 形式的调用，后台若没接上（被回收 / 尚未唤醒），
        // 拒绝会变成「Uncaught (in promise)」写进扩展管理页的错误列表，而 try/catch 抓不到它。
        chrome.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => {});
      } catch (_) {}
    } catch (e) {
      // 写设置失败极少见，但要给明确提示 —— 更不能让它变成一条未捕获异常
      flash('保存失败：' + String((e && e.message) || e).slice(0, 40), false);
    }
  };
  if (immediate) return doIt();
  saveTimer = setTimeout(doIt, 320);
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  /* 模式 */
  $$('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      settings.mode = r.value;
      syncModeUI();
      await CC.setSettings({ mode: r.value });
      try {
        chrome.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => {});
      } catch (_) {}
      await refreshTarget();
      flash('已保存', true);
    });
  });

  /* WebDAV 字段 */
  const davFields = [
    ['#davUrl', 'baseUrl'],
    ['#davUser', 'user'],
    ['#davPass', 'pass']
  ];
  davFields.forEach(([sel, key]) => {
    $(sel).addEventListener('input', () => {
      const cur = Object.assign({}, settings.webdav);
      // 账号/密码不能 trim 掉中间的空白（密码可能以空格结尾），只对地址做 trim
      cur[key] = key === 'baseUrl' ? $(sel).value.trim() : $(sel).value;
      settings.webdav = cur;
      save({ webdav: cur });
    });
  });

  /* 模板 */
  ['#dirTemplate', '#nameTemplate'].forEach((sel) => {
    $(sel).addEventListener('input', () => {
      updatePreview();
      save({ dirTemplate: $('#dirTemplate').value, nameTemplate: $('#nameTemplate').value });
    });
  });

  $('#resetTpl').addEventListener('click', async () => {
    $('#dirTemplate').value = CC.DEFAULTS.dirTemplate;
    $('#nameTemplate').value = CC.DEFAULTS.nameTemplate;
    updatePreview();
    await save({ dirTemplate: CC.DEFAULTS.dirTemplate, nameTemplate: CC.DEFAULTS.nameTemplate }, true);
  });

  /* 输出 */
  $('#format').addEventListener('change', async () => {
    $('#qualityField').style.opacity = $('#format').value === 'png' ? 0.45 : 1;
    await save({ format: $('#format').value }, true);
  });

  $('#quality').addEventListener('input', () => {
    $('#qualityVal').textContent = $('#quality').value + '%';
  });
  $('#quality').addEventListener('change', async () => {
    await save({ quality: Number($('#quality').value) / 100 }, true);
  });

  $('#fullPageMaxHeight').addEventListener('change', async () => {
    await save({ fullPageMaxHeight: Math.max(1000, Number($('#fullPageMaxHeight').value) || 20000) }, true);
  });
  $('#fullPageDeviceScale').addEventListener('change', async () => {
    await save({ fullPageDeviceScale: $('#fullPageDeviceScale').checked }, true);
  });

  /* 行为 */
  [['#altRightClick', 'altRightClick'], ['#skipDuplicate', 'skipDuplicate'], ['#toastInPage', 'toastInPage']].forEach(
    ([sel, key]) => {
      $(sel).addEventListener('change', async () => {
        await save({ [key]: $(sel).checked }, true);
      });
    }
  );

  $('#minSize').addEventListener('change', async () => {
    await save({ minSize: Math.max(0, Number($('#minSize').value) || 0) }, true);
  });

  /* 目录授权 */
  $('#pickDir').addEventListener('click', async () => {
    if (!CC.canUseFsa()) {
      alert('当前浏览器不支持目录授权（File System Access API），请改用「WebDAV 直传」。');
      return;
    }
    try {
      const handle = await self.showDirectoryPicker({ mode: 'readwrite', id: 'collector-target' });
      await CC.setDirHandle(handle);
      try {
        await handle.requestPermission({ mode: 'readwrite' });
      } catch (_) {}
      await refreshTarget();
      flash('目录已授权', true);
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('授权失败：' + (e.message || e));
    }
  });

  $('#clearDir').addEventListener('click', async () => {
    await CC.clearDirHandle();
    await refreshTarget();
    flash('已清除目录授权', true);
  });

  /* 测试连接 */
  $('#testBtn').addEventListener('click', async () => {
    flash('正在测试…');
    // 先落盘再测：避免刚输入还没走完防抖，测的是旧配置
    clearTimeout(saveTimer);
    settings = await CC.setSettings({
      webdav: {
        baseUrl: $('#davUrl').value.trim(),
        user: $('#davUser').value,
        pass: $('#davPass').value
      }
    });

    if (settings.mode === 'fsa') {
      const t = await CC.checkTarget(settings);
      flash(t.ready ? '目录可写' : t.reason || '未就绪', !!t.ready);
      await refreshTarget();
      return;
    }

    const r = await CC.webdavProbe(settings.webdav, { write: true });
    if (r.ok) flash('✓ ' + (r.info || 'WebDAV 可用'), true);
    else flash('✗ ' + (r.error || '未就绪'), false);
    await refreshTarget();
  });

  /* 统计 */
  $('#resetStats').addEventListener('click', async () => {
    settings = await CC.setSettings({ stats: { count: 0, bytes: 0, lastAt: 0, skipped: 0, failed: 0 } });
    refreshStats();
    flash('统计已清零', true);
  });

  $('#clearDedup').addEventListener('click', async () => {
    await CC.clearHashes();
    flash('去重记录已清空', true);
  });

  /* 配置导入导出 */
  $('#exportCfg').addEventListener('click', () => {
    const data = JSON.stringify(settings, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lan-collector-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });

  $('#importCfg').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const obj = JSON.parse(txt);
      settings = await CC.setSettings(obj);
      syncModeUI();
      syncFormUI();
      await refreshTarget();
      refreshStats();
      flash('配置已导入', true);
    } catch (err) {
      flash('导入失败：' + (err.message || err), false);
    }
    e.target.value = '';
  });

  $('#resetAll').addEventListener('click', async () => {
    if (!confirm('恢复全部默认设置？已授权的目录和去重记录不会被清除。')) return;
    settings = await CC.resetSettings();
    syncModeUI();
    syncFormUI();
    await refreshTarget();
    refreshStats();
    flash('已恢复默认', true);
  });
}

/* ---------------- 启动 ---------------- */

(async function init() {
  settings = await CC.getSettings();
  syncModeUI();
  syncFormUI();
  refreshStats();
  bind();
  await refreshTarget();
  flash('修改会自动保存');
})();
