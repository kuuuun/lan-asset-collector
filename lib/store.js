/*
 * 素材采集器 · 配置与本地存储
 * 设置 -> chrome.storage.local ；目录句柄 / 去重指纹 -> IndexedDB
 */
(function (root) {
  'use strict';
  const CC = (root.CC = root.CC || {});
  if (CC.__store) return;
  CC.__store = true;

  const KEY = CC.SETTINGS_KEY;

  const DEFAULTS = {
    /* 保存通道（只留零部署的两条）：
     *   'webdav' = 直接 PUT 到 NAS 自带的 WebDAV 服务（默认，推荐）
     *   'fsa'    = 浏览器授权目录（依赖内核支持与网络盘可用性）
     * 注：v1.4.0 起下线了「局域网接收端（http）」通道，老配置由 getSettings() 自动迁移。
     */
    mode: 'webdav',

    /* 群晖 NAS 的 WebDAV：默认端口 5005(http) / 5006(https)。
     * baseUrl 直接写到目标文件夹为止，后面的子目录由「文件组织」模板决定。 */
    webdav: {
      baseUrl: 'http://192.168.31.206:5005/Works/PicStorage/clips',
      user: '',
      pass: '',
      timeout: 60000
    },

    /* 文件组织：相对 WebDAV 目标目录 / 授权目录 */
    dirTemplate: '{yyyy}-{mm}-{dd}',
    nameTemplate: '{hh}{mi}{ss}-{page}-{n}',

    /* 截图输出格式：keep=不改动 / png / jpeg / webp */
    format: 'png',
    quality: 0.92,

    /* 采集行为 */
    altRightClick: true,
    minSize: 120,
    skipDuplicate: true,
    toastInPage: true,
    notifyOnDone: true,

    /* 整页截图 */
    fullPageMaxHeight: 20000, // 单位：CSS px
    fullPageDeviceScale: false, // 是否按设备像素比输出（体积大）

    stats: { count: 0, bytes: 0, lastAt: 0, skipped: 0, failed: 0 }
  };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function merge(base, patch) {
    if (!isObj(patch)) return base;
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      if (isObj(pv) && isObj(out[k])) out[k] = merge(out[k], pv);
      else if (pv !== undefined) out[k] = pv;
    }
    return out;
  }

  CC.DEFAULTS = DEFAULTS;

  /** 通道白名单：老配置里的 http（局域网接收端）或任何脏值一律落到 webdav */
  function normalizeMode(s) {
    if (s.mode !== 'webdav' && s.mode !== 'fsa') s.mode = 'webdav';
    return s;
  }

  CC.getSettings = async function () {
    try {
      const got = await chrome.storage.local.get(KEY);
      return normalizeMode(merge(DEFAULTS, got[KEY] || {}));
    } catch (_) {
      return normalizeMode(merge(DEFAULTS, {}));
    }
  };

  CC.setSettings = async function (patch) {
    const cur = await CC.getSettings();
    const next = merge(cur, patch);
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  };

  CC.resetSettings = async function () {
    await chrome.storage.local.set({ [KEY]: merge(DEFAULTS, {}) });
    return merge(DEFAULTS, {});
  };

  CC.bumpStats = async function (delta) {
    const s = await CC.getSettings();
    const st = Object.assign({ count: 0, bytes: 0, lastAt: 0, skipped: 0, failed: 0 }, s.stats || {});
    st.count += delta.count || 0;
    st.bytes += delta.bytes || 0;
    st.skipped += delta.skipped || 0;
    st.failed += delta.failed || 0;
    if (delta.count) st.lastAt = Date.now();
    await CC.setSettings({ stats: st });
    return st;
  };

  /* ---------------- IndexedDB ---------------- */

  const DB_NAME = 'lan-collector';
  const DB_VER = 1;
  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction('kv', mode);
          const store = t.objectStore('kv');
          let req;
          try {
            req = fn(store);
          } catch (e) {
            reject(e);
            return;
          }
          // 注意：结果必须是 req.result，不能用
          //   req.result !== undefined ? req.result : req
          // 那种写法在「键不存在」时会把 IDBRequest 对象本身返回出去。它是个 truthy 对象，
          // 于是 seenHash() 拿到一个没有 indexOf 的东西而抛错、rememberHash() 永远写不进
          // 新指纹 —— 结果是「跳过重复图片」彻底失效（各通道都一样）。
          t.oncomplete = () => resolve(req ? req.result : undefined);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  CC.idbGet = (k) => tx('readonly', (s) => s.get(k));
  CC.idbSet = (k, v) => tx('readwrite', (s) => s.put(v, k));
  CC.idbDel = (k) => tx('readwrite', (s) => s.delete(k));

  /* 目录句柄 */
  CC.getDirHandle = () => CC.idbGet('dirHandle');
  CC.setDirHandle = (h) => CC.idbSet('dirHandle', h);
  CC.clearDirHandle = () => CC.idbDel('dirHandle');

  /* 去重指纹（上限 20000 条，超出丢最旧的） */
  CC.seenHash = async function (hex) {
    const arr = (await CC.idbGet('hashes')) || [];
    return arr.indexOf(hex) >= 0;
  };
  CC.rememberHash = async function (hex) {
    let arr = (await CC.idbGet('hashes')) || [];
    arr.push(hex);
    if (arr.length > 20000) arr = arr.slice(arr.length - 20000);
    await CC.idbSet('hashes', arr);
  };
  CC.clearHashes = () => CC.idbDel('hashes');

  /* 文件名序号，保证 {n} 单调递增 */
  CC.nextSeq = async function () {
    const cur = Number(await CC.idbGet('seq')) || 0;
    const next = cur + 1;
    await CC.idbSet('seq', next);
    return next;
  };

  CC.canUseFsa = function () {
    return typeof self.showDirectoryPicker === 'function';
  };
})(self);
