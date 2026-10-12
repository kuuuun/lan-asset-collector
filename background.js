/*
 * 素材采集器 · 后台服务（MV3 service worker）
 * 负责：快捷键 / 右键菜单 / 截屏编排 / 整页拼接调度 / 统一落盘
 */
importScripts('lib/util.js', 'lib/store.js', 'lib/webdav.js', 'lib/saver.js');

const CC = self.CC;

const VERSION = '1.5.9';
const CAPTURE_GAP = 320; // 两次 captureVisibleTab 之间的最小间隔（配额：2 次/秒）

/* ================= 平台信息 =================
 * 扩展的核心逻辑与平台无关（截图、抓图、WebDAV、目录授权在 Windows 与 macOS 上
 * 是同一套 API）。唯一需要分平台的是「给人看的本机路径提示」：
 * 同一个 NAS 共享，Windows 上是 Z:\，macOS 上是 /Volumes/Works，Linux 上是 /mnt/…。
 * 之前这里写死了 Z:\，在 macOS 上会给出一个不存在的路径。
 */
const PLATFORM = (() => {
  let os = 'unknown';
  const ready = new Promise((resolve) => {
    try {
      chrome.runtime.getPlatformInfo((info) => {
        os = (info && info.os) || 'unknown';
        resolve(os);
      });
    } catch (_) {
      resolve(os);
    }
  });
  return { get: () => os, ready };
})();

/** 文件管理器在各系统里的名字 */
function fileManagerName(os) {
  if (os === 'mac') return '访达';
  if (os === 'win') return '资源管理器';
  return '文件管理器';
}

/**
 * 由已配置的 WebDAV 地址反推「本机怎么打开这个 NAS 目录」。
 * 刻意从 baseUrl 里同时取主机名与共享名/子路径，而不是再硬编码 —— 换 NAS 或换共享文件夹时
 * 只改设置页地址即可，这里的提示会跟着变。
 */
function nasLocalHint(os, baseUrl) {
  let host = '';
  let segs = [];
  try {
    const u = new URL(String(baseUrl || ''));
    host = u.hostname;
    segs = u.pathname.split('/').filter(Boolean);
  } catch (_) {
    host = '';
  }
  if (!host) return '可在群晖 File Station 里查看';
  const shared = segs[0] || 'Works';
  const tail = segs.slice(1).join('/');
  const rel = tail ? '/' + tail : '';
  if (os === 'mac') {
    return '在访达里按 Cmd+K 输入 smb://' + host + '/' + shared +
      '，挂载后通常出现在 /Volumes/' + shared + rel;
  }
  if (os === 'win') {
    return '本机 \\\\' + host + '\\' + shared + ' 映射盘符下的 ' +
      (tail ? tail.split('/').join('\\') : '') + ' 就是它，可在' + fileManagerName(os) + '里打开';
  }
  if (os === 'linux') {
    return '把 smb://' + host + '/' + shared + ' 挂到 /mnt/' + shared.toLowerCase() +
      ' 后即为 /mnt/' + shared.toLowerCase() + rel;
  }
  return '在文件管理器里打开 smb://' + host + '/' + shared;
}

/* ================= 异常收口 ================= */

/**
 * chrome.* 的「Promise 形式」调用（不给回调时）失败会**拒绝**，而 try/catch 抓不住拒绝 ——
 * 拒绝没人接就变成扩展管理页里的一条「Uncaught (in promise) …」红字。凡是这类调用都过一遍
 * silent()：失败不影响功能（角标、通知、开页面都是尽力而为），但绝不冒到错误列表里。
 */
function silent(p) {
  try {
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}

/**
 * 兜底网：service worker 里任何漏网的未处理 Promise 拒绝 / 未捕获错误，只写进控制台。
 *
 * 这类红字对使用者来说就是「插件坏了」，而它的堆叠往往是丢的（错误列表里只显示「行号 0」），
 * 排查成本极高。所以在这里收口，同时用 console.warn 留痕 —— 要排查就去看后台控制台。
 */
function installNet() {
  try {
    self.addEventListener('unhandledrejection', (e) => {
      try {
        const r = e && e.reason;
        console.warn('[LAN Collector] 未处理的异步错误：', (r && (r.message || r)) || r);
      } catch (_) {}
      if (e && e.preventDefault) e.preventDefault();
    });
    self.addEventListener('error', (e) => {
      try { console.warn('[LAN Collector] 未捕获错误：', e && e.message); } catch (_) {}
    });
  } catch (_) {}
}
installNet();

/* ================= 安装 / 生命周期 ================= */

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await CC.setSettings({});
  } catch (_) {} // 写设置失败也不该让安装回调抛出一个未捕获异常
  buildMenus();
  refreshBadge();
  if (details.reason === 'install') {
    silent(chrome.tabs.create({ url: chrome.runtime.getURL('help/help.html?first=1') }));
  }
});

chrome.runtime.onStartup.addListener(() => {
  buildMenus();
  refreshBadge();
});

/* ================= 右键菜单 ================= */

const MENU_ID = 'cc-image';
const MENU_TITLE = '将图片保存至 LAN Collector';

/**
 * 最近一次注册的结果。
 *
 * 右键菜单由**浏览器进程**持有 —— 页面里看不见、扩展也查不到，所以「右键里没有这一项」
 * 是使用者最难自证的一类问题。把结果留在后台、由弹窗显示出来，就能一眼分清
 * 「根本没注册上」和「注册上了但浏览器没显示」。
 */
let menuState = { ok: false, at: 0, error: '尚未注册' };

/**
 * 注册（或刷新）右键菜单，返回本次结果。
 *
 * 形态：整个右键菜单**只有这一项**，只在「右键点在图片上」时出现，点一下直接把这张图
 * 存进素材库 —— 不进二级菜单。别再加第二项：Chromium 会把同一扩展的多个顶层菜单项
 * 折叠成一个「扩展名 ›」二级菜单，一键剪藏就变成两次点击。
 * 区域 / 可视区 / 整页 / 批量 四个入口保留在弹窗面板与快捷键里。
 *
 * ★ 这里**故意不用 removeAll + create**。
 *   那是「先清空、再重建」两步：removeAll 发出之后若后台脚本刚好被回收（内核回收得勤的
 *   浏览器上很容易发生），菜单就被清空而新的没建上 —— 表现正是「右键里没有这一项了」。
 *   改成单步「先 create，已存在就 update」：全程不留空档，任何时刻菜单都是完整的，
 *   而且改标题后也会被 update 刷成当前值。
 */
function buildMenus() {
  return new Promise((resolve) => {
    const settle = (ok, error) => {
      menuState = { ok: !!ok, at: Date.now(), error: error || '' };
      resolve(menuState);
    };
    if (!chrome.contextMenus) return settle(false, '当前浏览器不支持右键菜单接口');

    const spec = { title: MENU_TITLE, contexts: ['image'] };
    try {
      chrome.contextMenus.create({ id: MENU_ID, title: MENU_TITLE, contexts: ['image'] }, () => {
        const err = chrome.runtime.lastError;
        if (!err) return settle(true);
        // 已存在（重复 id）→ 用 update 把标题与上下文刷成当前值
        try {
          chrome.contextMenus.update(MENU_ID, spec, () => {
            const e2 = chrome.runtime.lastError;
            settle(!e2, e2 ? e2.message : '');
          });
        } catch (e3) {
          settle(false, String((e3 && e3.message) || e3));
        }
      });
    } catch (e) {
      settle(false, String((e && e.message) || e));
    }
  });
}

/**
 * 顶层立即注册一次 —— 这行不能挪进任何事件回调里。
 *
 * 右键菜单由浏览器进程持有，后台脚本被回收后菜单不会自动回来；而「在扩展管理页点刷新」
 * 既不触发 onInstalled（只在安装/升级时来），也不触发 onStartup（只在浏览器启动时来）。
 * MV3 的后台脚本每次被唤醒都会重跑顶层代码，所以放在这里，
 * 重载 / 唤醒 / 升级 / 启动四条路径都会把菜单同步到当前代码。
 */
buildMenus();

/**
 * 兜底唤醒点：切一次标签页 / 切换一次窗口，就补一次菜单。
 *
 * 为什么需要：Chromium 在**扩展集合发生变化**时（安装 / 卸载 / 禁用任意一个扩展 ——
 * 例如把 Billfish 采集扩展删掉）会重建整张右键菜单。重建那一刻本扩展后台若在休眠，
 * 我们这一项就会缺席，而休眠中的脚本没有理由自己醒过来 —— 现象就是
 * 「删掉别的插件之后，右键保存单张图片的功能没有了」。
 *
 * 这两个时机在日常使用中最频繁、且完全无副作用；醒一次就把菜单补回来，
 * 不必让使用者专门跑去扩展管理页点「刷新」。
 *
 * 注意：不要改用 chrome.alarms —— 那要额外申请 alarms 权限，给已经加载好的未打包扩展
 * 新增权限会触发重新授权，代价大于收益。
 */
chrome.tabs.onActivated.addListener(() => buildMenus());
chrome.windows.onFocusChanged.addListener(() => buildMenus());

/* ================= 提示 ================= */

function notify(title, message) {
  try {
    silent(
      chrome.notifications.create('cc-' + CC.uid(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/128.png'),
        title: String(title || '素材采集器').slice(0, 60),
        message: String(message || '').slice(0, 200),
        silent: true
      })
    );
  } catch (_) {}
}

function flashBadge(text, color) {
  try {
    silent(chrome.action.setBadgeBackgroundColor({ color: color || '#3b82f6' }));
    silent(chrome.action.setBadgeText({ text: String(text || '') }));
    setTimeout(() => {
      try {
        silent(chrome.action.setBadgeText({ text: '' }));
      } catch (_) {}
    }, 2400);
  } catch (_) {}
}

function refreshBadge() {
  CC.getSettings()
    .then((s) => CC.checkTarget(s))
    .then((t) => {
      try {
        silent(
          chrome.action.setTitle({
            title: t.ready ? `素材采集器 ${VERSION} · ${t.label}` : `素材采集器 ${VERSION} · 未就绪`
          })
        );
      } catch (_) {}
    })
    .catch(() => {}); // 读设置/探测目标失败时静默：角标名字不更新不影响任何功能
}

/* ================= Tab 通信 ================= */

async function cc(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

async function ensureContent(tab) {
  // 这里直接读 tab.id —— 上游调用点都已 guard，但补一道自己的判空，
  // 免得将来有人绕过 guard 调用，又冒出「reading 'id' of undefined」这类红字
  if (!tab || tab.id == null) return false;
  const id = tab.id;
  const ping = await cc(id, { type: 'cc:ping' });
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['content/content.css'] });
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      files: ['lib/util.js', 'lib/imageproc.js', 'content/content.js']
    });
  } catch (e) {
    return false;
  }
  await CC.sleep(180);
  const p2 = await cc(id, { type: 'cc:ping' });
  return !!(p2 && p2.ok);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function guard(tab) {
  if (!tab || tab.id == null) return '没有可用的标签页';
  if (CC.isRestrictedUrl(tab.url)) return '浏览器内部页面不支持采集，请切换到普通网页';
  return null;
}

/* ================= 截图参数 ================= */

function shotOpts(settings) {
  const fmt = settings.format === 'keep' ? 'png' : settings.format;
  return { format: fmt, quality: settings.quality };
}

async function maybeConvert(tabId, dataUrl, settings) {
  const fmt = settings.format === 'keep' ? 'png' : settings.format;
  if (fmt === 'png') return dataUrl;
  const r = await cc(tabId, { type: 'cc:image:convert', dataUrl, opts: shotOpts(settings) });
  return (r && r.dataUrl) || dataUrl;
}

/* ================= 落盘 ================= */

async function persist(tab, dataUrl, type, extra) {
  // 同上：下面要读 tab.title / tab.url，先自己挡一道空标签页
  const noTab = guard(tab);
  if (noTab) return { ok: false, error: noTab };
  const settings = await CC.getSettings();
  const target = await CC.checkTarget(settings);
  if (!target.ready) {
    notify('保存目标未就绪', target.reason || '请先打开设置页配置保存位置');
    try {
      silent(chrome.runtime.openOptionsPage());
    } catch (_) {}
    return { ok: false, error: target.reason || '保存目标未就绪' };
  }
  const res = await CC.saveAsset(
    Object.assign(
      {
        dataUrl,
        type,
        pageTitle: tab.title,
        page: tab.title,
        host: CC.hostOf(tab.url),
        sourceUrl: tab.url
      },
      extra || {}
    )
  );
  return res;
}

function reportSave(res, label) {
  if (!res) return;
  if (res.ok) {
    if (res.duplicated) {
      flashBadge('≒', '#94a3b8');
      notify('已存在相同图片', `${label} 已采集过，本次跳过`);
    } else {
      flashBadge('✓', '#057a55');
      notify('采集成功', `${label} → ${res.path || ''}`);
    }
  } else {
    flashBadge('!', '#b91c1c');
    notify('采集失败', res.error || '未知错误');
  }
}

/* ================= 四种采集 ================= */

async function captureRegion(tab) {
  const bad = guard(tab);
  if (bad) return notify('无法采集', bad);
  if (!(await ensureContent(tab))) return notify('无法采集', '当前页面不允许注入采集器');

  await cc(tab.id, { type: 'cc:toast', text: '拖拽选择要采集的区域', kind: '', ms: 2200 });
  const rect = await cc(tab.id, { type: 'cc:region:pick' });
  // 用户按 Esc 取消时返回 null；返回体必须带合法的数值坐标才算有效
  if (!rect || rect.error || typeof rect.x !== 'number' || typeof rect.w !== 'number') return;

  await CC.sleep(200);
  let shot;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    return notify('采集失败', '截屏被拒绝：' + String((e && e.message) || e));
  }

  const settings = await CC.getSettings();
  const cropped = await cc(tab.id, {
    type: 'cc:image:crop',
    dataUrl: shot,
    rect,
    opts: shotOpts(settings)
  });
  if (!cropped || !cropped.dataUrl) return notify('采集失败', '区域裁剪失败');

  const res = await persist(tab, cropped.dataUrl, 'region', { w: cropped.w, h: cropped.h });
  reportSave(res, '区域截图');
  return res;
}

async function captureViewport(tab) {
  const bad = guard(tab);
  if (bad) return notify('无法采集', bad);
  if (!(await ensureContent(tab))) return notify('无法采集', '当前页面不允许注入采集器');

  await CC.sleep(120);
  let shot;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    return notify('采集失败', '截屏被拒绝：' + String((e && e.message) || e));
  }
  const settings = await CC.getSettings();
  shot = await maybeConvert(tab.id, shot, settings);
  const res = await persist(tab, shot, 'viewport', {});
  reportSave(res, '可视区域截图');
  return res;
}

async function captureFullPage(tab) {
  const bad = guard(tab);
  if (bad) return notify('无法采集', bad);
  if (!(await ensureContent(tab))) return notify('无法采集', '当前页面不允许注入采集器');

  const settings = await CC.getSettings();
  await cc(tab.id, { type: 'cc:progress', text: '正在测量页面高度…', ratio: 0 });

  const meta = await cc(tab.id, { type: 'cc:fullpage:prepare', opts: { lazy: true } });
  if (!meta || meta.error || !meta.height) {
    await cc(tab.id, { type: 'cc:progress', hide: true });
    return notify('采集失败', (meta && meta.error) || '页面尺寸获取失败');
  }

  const fullHeight = Math.round(meta.height);
  const height = Math.min(fullHeight, Math.max(600, Number(settings.fullPageMaxHeight) || 20000));
  const viewport = Math.max(200, Math.round(meta.viewport));
  const dpr = settings.fullPageDeviceScale ? meta.dpr || 1 : 1;

  const positions = [];
  for (let p = 0; p < height - 1; p += viewport) positions.push(p);
  const lastPos = Math.max(0, height - viewport);
  if (!positions.length || positions[positions.length - 1] < lastPos - 2) positions.push(lastPos);

  const shots = [];
  let failed = 0;
  try {
    for (let i = 0; i < positions.length; i++) {
      const r = await cc(tab.id, { type: 'cc:fullpage:scroll', y: positions[i] });
      await CC.sleep(CAPTURE_GAP);
      let du;
      try {
        du = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (e) {
        failed++;
        continue;
      }
      shots.push({ y: r && typeof r.y === 'number' ? r.y : positions[i], dataUrl: du });
      await cc(tab.id, {
        type: 'cc:progress',
        text: `正在截取第 ${i + 1}/${positions.length} 屏`,
        ratio: (i + 1) / positions.length
      });
    }

    if (!shots.length) throw new Error('没有截到任何画面');

    await cc(tab.id, { type: 'cc:progress', text: '正在拼接整页…', ratio: 0.96 });
    const stitched = await cc(tab.id, {
      type: 'cc:fullpage:stitch',
      shots,
      meta: { width: meta.width, height, dpr },
      opts: shotOpts(settings)
    });
    if (!stitched || !stitched.dataUrl) throw new Error('拼接失败');

    const res = await persist(tab, stitched.dataUrl, 'fullpage', { w: stitched.w, h: stitched.h });
    reportSave(res, '整页截图' + (failed ? `（${failed} 屏失败）` : ''));
    return res;
  } catch (e) {
    notify('采集失败', String((e && e.message) || e));
  } finally {
    await cc(tab.id, { type: 'cc:fullpage:restore' });
    await cc(tab.id, { type: 'cc:progress', hide: true });
  }
}

async function openBatch(tab) {
  const bad = guard(tab);
  if (bad) return notify('无法采集', bad);
  if (!(await ensureContent(tab))) return notify('无法采集', '当前页面不允许注入采集器');
  const settings = await CC.getSettings();
  const r = await cc(tab.id, { type: 'cc:batch:open', minSize: settings.minSize });
  if (r && r.count === 0) notify('批量采集', '当前页面没有找到符合条件的图片');
  return r;
}

/* ================= 图片抓取与保存 ================= */

function guessExt(url, mime) {
  const fromUrl = CC.extFromUrl(url);
  if (fromUrl && CC.mimeFromExt(fromUrl) !== 'image/png') return fromUrl;
  if (fromUrl) return fromUrl;
  return CC.extFromMime(mime);
}

async function batchSave(tab, items, meta) {
  // 先挡一道空标签页：这条消息理论上都来自内容脚本（sender.tab 一定有），但
  // 也可能来自扩展自己的页面 —— 那种情况下 sender.tab 是 undefined，而下面既要
  // 读 tab.title / tab.url，又要在每张图的循环里回写进度 cc(tab.id, …)，
  // 会抛「Cannot read properties of undefined (reading 'title' / 'id')」，
  // 并在扩展管理页的「错误」里留下一条未捕获异常（保存目标配好、真的走到这一步才会触发）。
  const noTab = guard(tab);
  if (noTab) {
    notify('批量采集失败', noTab);
    return { ok: 0, failed: items.length, duplicated: 0, error: noTab };
  }
  const settings = await CC.getSettings();
  const target = await CC.checkTarget(settings);
  if (!target.ready) {
    notify('保存目标未就绪', target.reason || '请先配置保存位置');
    return { ok: 0, failed: items.length, duplicated: 0, error: target.reason };
  }

  let ok = 0;
  let failed = 0;
  let duplicated = 0;
  const page = CC.pageSlug((meta && meta.pageTitle) || tab.title, CC.hostOf((meta && meta.sourceUrl) || tab.url));
  const host = CC.hostOf((meta && meta.sourceUrl) || tab.url);

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await cc(tab.id, {
      type: 'cc:progress',
      text: `正在采集 ${i + 1}/${items.length}`,
      ratio: i / items.length
    });

    const fetched = await CC.fetchImageBytes(it.url, 30000);
    if (!fetched.ok) {
      failed++;
      continue;
    }
    const res = await CC.saveAsset({
      bytes: fetched.bytes,
      mime: fetched.mime,
      ext: guessExt(it.url, fetched.mime),
      type: 'batch',
      n: i + 1,
      w: it.w,
      h: it.h,
      page,
      host,
      pageTitle: (meta && meta.pageTitle) || tab.title,
      sourceUrl: it.url,
      settings
    });
    if (res.ok) {
      if (res.duplicated) duplicated++;
      else ok++;
    } else {
      failed++;
    }
    if (i % 3 === 2) await CC.sleep(60); // 稍微让出主线程
  }

  const parts = [`成功 ${ok}`];
  if (duplicated) parts.push(`重复 ${duplicated}`);
  if (failed) parts.push(`失败 ${failed}`);
  if (ok) flashBadge(String(ok), '#057a55');
  else flashBadge('!', '#b91c1c');
  notify('批量采集完成', parts.join(' · '));
  return { ok, failed, duplicated };
}

/**
 * 把「一张图的地址」变成字节。三条来源各走各的路：
 *   data:  直接解码，不该再去 fetch
 *   blob:  属于页面作用域，service worker 拿不到 → 交给内容脚本读
 *   http:  先用扩展上下文抓（有 host_permissions，不受页面 CSP/CORS 限制），
 *          失败再回页面里用页面自己的 Cookie / Referer 重试一次 —— 图片站大多有防盗链，
 *          只有带着页面来源的请求才拿得到（Billfish 也是这么干的）
 */
async function fetchForClip(tab, url) {
  const u = String(url || '');
  if (!u) return { ok: false, error: '没有图片地址' };

  if (/^data:/i.test(u)) {
    const bytes = CC.dataUrlToBytes(u);
    return bytes ? { ok: true, bytes, mime: CC.mimeFromDataUrl(u) || 'image/png' } : { ok: false, error: '图片数据无效' };
  }

  const viaPage = async () => {
    if (!tab || tab.id == null) return { ok: false, error: '没有可用的标签页' };
    if (!(await ensureContent(tab))) return { ok: false, error: '无法在当前页面读取图片' };
    const r = await cc(tab.id, { type: 'cc:image:fetch', url: u });
    if (r && r.ok && r.dataUrl) {
      const b = CC.dataUrlToBytes(r.dataUrl);
      if (b) return { ok: true, bytes: b, mime: r.mime || CC.mimeFromDataUrl(r.dataUrl) || 'image/png' };
    }
    return { ok: false, error: (r && (r.error || r.message)) || '无法读取图片' };
  };

  if (/^blob:/i.test(u)) return await viaPage();

  const direct = await CC.fetchImageBytes(u, 30000);
  if (direct.ok) return direct;
  const fallback = await viaPage();
  return fallback.ok ? fallback : { ok: false, error: direct.error || fallback.error };
}

async function singleSave(tab, payload) {
  const settings = await CC.getSettings();
  const target = await CC.checkTarget(settings);
  if (!target.ready) return { ok: false, error: target.reason || '保存目标未就绪' };

  // 首选地址抓不到时，退到 fallbackUrl 再抓一次。
  // 为什么需要：「大图」常常是**推算**出来的（Pinterest 的 originals），而推算出的地址未必
  // 真的存在 —— 从外站抓取来的 pin，Pinterest 根本没存原图。宁可拿到缩略图也不空手而归。
  const order = [payload.url];
  if (payload.fallbackUrl && payload.fallbackUrl !== payload.url) order.push(payload.fallbackUrl);

  let fetched = null;
  let used = payload.url || '';
  if (payload.dataUrl) {
    const bytes = CC.dataUrlToBytes(payload.dataUrl);
    fetched = bytes
      ? { ok: true, bytes, mime: CC.mimeFromDataUrl(payload.dataUrl) || 'image/png' }
      : { ok: false, error: '图片数据无效' };
  } else {
    for (const url of order) {
      fetched = await fetchForClip(tab, url);
      if (fetched.ok) {
        used = url;
        break;
      }
    }
  }
  if (!fetched || !fetched.ok) return { ok: false, error: (fetched && fetched.error) || '图片抓取失败' };

  // 只有 http(s) 才适合从地址里猜扩展名；data:/blob: 一律按 mime 定
  const ext = payload.ext || (/^https?:/i.test(used || '') ? guessExt(used, fetched.mime) : CC.extFromMime(fetched.mime));

  return await CC.saveAsset({
    bytes: fetched.bytes,
    mime: fetched.mime,
    ext,
    type: 'single',
    w: payload.w,
    h: payload.h,
    page: CC.pageSlug(payload.pageTitle, CC.hostOf(payload.sourceUrl)),
    host: CC.hostOf(payload.sourceUrl),
    pageTitle: payload.pageTitle,
    sourceUrl: used,
    settings
  });
}

/* ================= 入口分发 ================= */

/**
 * Pinterest 大图采集（由弹窗的「采集本页大图」按钮触发）。
 *
 * 为什么单独开一条路：Pinterest 会在图片上盖一层透明 div，右键落点不是 <img> ——
 * 浏览器既不出自带的「图片另存为」，也不出我们的 `contexts:['image']` 菜单项，
 * 原生右键在这类站点上是死的。所以给它一个完全绕开右键的入口：点扩展图标 → 面板按钮。
 *
 * 取图策略：内容脚本把页面上的 pinimg 地址换算成 originals 原图 → **先按原图抓**；
 * 失败（从外站抓取来的 pin，Pinterest 未必存了原图，会 403 或回落）**再退回页面上那张图**，
 * 宁可拿到小的也不空手而归。
 */
async function collectPin(tabArg) {
  const tab = tabArg && tabArg.id != null ? tabArg : await activeTab();
  const bad = guard(tab);
  if (bad) {
    notify('无法采集', bad);
    return { ok: false, error: bad };
  }
  if (!(await ensureContent(tab))) {
    notify('无法采集', '当前页面不允许注入采集器');
    return { ok: false, error: '当前页面不允许注入采集器' };
  }

  const scan = await cc(tab.id, { type: 'pin:scan' });
  if (!scan || scan.error || (!scan.orig && !scan.url)) {
    const msg = (scan && scan.error) || '本页没有找到 Pinterest 图片';
    notify('没有找到大图', msg);
    return { ok: false, error: msg };
  }

  const base = {
    w: scan.w,
    h: scan.h,
    pageTitle: scan.title || (tab && tab.title) || '',
    sourceUrl: (tab && tab.url) || ''
  };
  const attempts = [];
  if (scan.orig) attempts.push(scan.orig);
  if (scan.url && scan.url !== scan.orig) attempts.push(scan.url);

  let res = null;
  for (const url of attempts) {
    res = await singleSave(tab, Object.assign({ url }, base));
    if (res && res.ok) break;
  }
  reportSave(res, 'Pinterest 大图');
  return res || { ok: false, error: '采集失败' };
}

async function runAction(action, tabArg) {
  const tab = tabArg || (await activeTab());
  switch (action) {
    case 'region':
      return await captureRegion(tab);
    case 'viewport':
      return await captureViewport(tab);
    case 'fullpage':
      return await captureFullPage(tab);
    case 'batch':
      return await openBatch(tab);
    default:
      return null;
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  const map = {
    'region-shot': 'region',
    'viewport-shot': 'viewport',
    'fullpage-shot': 'fullpage',
    'batch-collect': 'batch'
  };
  if (map[command]) await runAction(map[command], tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'cc-image') return;
  try {
    // info.srcUrl 是浏览器认出的那张图，多半是站点故意渲染的**缩略图**（Pinterest 全是 236x）。
    // 能按 CDN 规则逆推出原图就用原图，推不出就原样；缩略图留作抓取失败时的退路。
    const srcUrl = info.srcUrl || '';
    const res = await singleSave(tab, {
      url: CC.pinimgOriginal(srcUrl) || srcUrl,
      fallbackUrl: srcUrl,
      w: info.width,
      h: info.height,
      pageTitle: (tab && tab.title) || '',
      sourceUrl: (tab && tab.url) || info.pageUrl || ''
    });
    // 右键剪藏是「一键动作」，成功与否都要有明确回声，不能只闪一下角标
    reportSave(res, '图片');
  } catch (e) {
    notify('采集失败', String((e && e.message) || e));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  const done = (p) =>
    Promise.resolve(p)
      .then((r) => sendResponse(r == null ? { ok: true } : r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));

  switch (msg.type) {
    case 'run': {
      done(runAction(msg.action, undefined));
      return true;
    }

    case 'batch:save':
      done(batchSave(sender.tab, msg.items || [], { pageTitle: msg.pageTitle, sourceUrl: msg.sourceUrl }));
      return true;

    case 'single:save':
      done(singleSave(sender.tab, msg));
      return true;

    case 'pin:collect':
      // 弹窗触发时 sender.tab 是 undefined（消息来自扩展自身页面）——
      // collectPin 内部会退回 chrome.tabs.query 找活动标签页
      done(collectPin(sender.tab));
      return true;

    case 'status':
      done(
        CC.getSettings().then(async (s) => ({
          version: VERSION,
          mode: s.mode,
          target: await CC.checkTarget(s),
          stats: s.stats,
          settings: s
        }))
      );
      return true;

    case 'menu:status':
      // 弹窗每次打开都会走这里：**顺手重注册一次**右键菜单。
      // 于是「点一下扩展图标」就等于「把右键菜单补回来」，不用跑去扩展管理页点刷新。
      done(
        buildMenus().then((m) => ({
          ok: true,
          menu: m,
          menuId: MENU_ID,
          menuTitle: MENU_TITLE,
          extId: chrome.runtime.id
        }))
      );
      return true;

    case 'test':
      done(
        CC.getSettings().then(async (s) => {
          if (s.mode === 'fsa') {
            const t = await CC.checkTarget(s);
            return { ok: !!t.ready, fsa: true, label: t.label, error: t.ready ? undefined : t.reason };
          }
          // 只做连接与鉴权探测，不做写入（面板打开不该往 NAS 写东西）
          const r = await CC.webdavProbe(s.webdav, { write: false });
          return Object.assign({ webdav: true }, r);
        })
      );
      return true;

    case 'openOptions':
      silent(chrome.runtime.openOptionsPage());
      sendResponse({ ok: true });
      return true;

    case 'openIndex':
      done(
        CC.getSettings().then(async (s) => {
          const os = await PLATFORM.ready;
          if (s.mode === 'webdav') {
            return {
              ok: true,
              hint:
                '文件直接写进 NAS 的 ' + CC.webdavLabel(s.webdav) + '。' +
                nasLocalHint(os, s.webdav && s.webdav.baseUrl)
            };
          }
          const t = await CC.checkTarget(s);
          return {
            ok: true,
            hint: t.ready
              ? '文件写进已授权目录「' + t.label.replace(/^目录 · /, '') + '」——在' +
                fileManagerName(os) + '里打开该文件夹即可'
              : t.reason
          };
        })
      );
      return true;

    case 'resetStats':
      done(CC.setSettings({ stats: { count: 0, bytes: 0, lastAt: 0, skipped: 0, failed: 0 } }).then(() => ({ ok: true })));
      return true;

    case 'settingsChanged':
      refreshBadge();
      sendResponse({ ok: true });
      return true;

    default:
      // 明确回一嗓子，别不声不响地 return：发送方（尤其是用 Promise 形式调用的）
      // 会收到「The message port closed before a response was received.」，
      // 在扩展管理页里就是一条「Uncaught (in promise)」红字。
      sendResponse({ ok: false, error: '未知指令：' + String(msg.type) });
      return;
  }
});
