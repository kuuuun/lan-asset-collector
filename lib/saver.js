/*
 * 素材采集器 · 保存层
 * 两条通道：webdav（NAS 自带的 WebDAV，零部署）/ fsa（浏览器授权目录）
 */
(function (root) {
  'use strict';
  const CC = (root.CC = root.CC || {});
  if (CC.__saver) return;
  CC.__saver = true;

  /* ---------------- 目标可达性 ---------------- */

  /** 返回 { ready:boolean, reason?:string, label:string } */
  CC.checkTarget = async function (settings) {
    const st = settings || (await CC.getSettings());

    if (st.mode === 'webdav') {
      const w = st.webdav || {};
      const base = String(w.baseUrl || '').trim();
      if (!/^https?:\/\//i.test(base)) return { ready: false, reason: 'WebDAV 地址未配置', label: '未配置' };
      if (!w.user) return { ready: false, reason: 'WebDAV 账号未填写（设置页里填 NAS 账号）', label: '需填账号' };
      return { ready: true, label: 'WebDAV · ' + CC.webdavLabel(w) };
    }

    if (st.mode === 'fsa') {
      const h = await CC.getDirHandle().catch(() => null);
      if (!h) {
        // 关键：不能用 CC.canUseFsa() 当这里的判据。showDirectoryPicker 是 Window 专有
        // API，service worker（v 里）永远看不到它，那样会把「尚未授权」误报成「不支持」，
        // 进而拦掉所有采集。只有确实处在有 document 的页面里时才用它来判断支持性。
        const inPage = typeof document !== 'undefined';
        const supported = !inPage || CC.canUseFsa();
        return {
          ready: false,
          reason: supported
            ? '尚未授权保存目录，请在设置页点「选择目录」'
            : '当前浏览器不支持目录授权，请改用 WebDAV 直传',
          label: supported ? '未授权' : '不支持'
        };
      }
      let perm = 'prompt';
      try {
        perm = await h.queryPermission({ mode: 'readwrite' });
      } catch (_) {
        perm = 'prompt';
      }
      if (perm !== 'granted') {
        return { ready: false, reason: '目录授权已失效，请在设置页重新授权', label: '需重新授权' };
      }
      return { ready: true, label: '目录 · ' + h.name };
    }

    // 兜底：模式值异常时按 WebDAV 处理（getSettings 已做白名单迁移，这里只是防御）
    const w = st.webdav || {};
    const base = String(w.baseUrl || '').trim();
    if (!/^https?:\/\//i.test(base)) return { ready: false, reason: 'WebDAV 地址未配置', label: '未配置' };
    if (!w.user) return { ready: false, reason: 'WebDAV 账号未填写（设置页里填 NAS 账号）', label: '需填账号' };
    return { ready: true, label: 'WebDAV · ' + CC.webdavLabel(w) };
  };

  /* ---------------- 命名 ---------------- */

  async function buildTarget(settings, ctx) {
    const seq = await CC.nextSeq();
    const map = CC.tokenMap(new Date(), {
      page: ctx.page || 'page',
      host: ctx.host || '',
      type: ctx.type || 'shot',
      name: ctx.name || '',
      n: ctx.n != null ? ctx.n : seq,
      w: ctx.w || '',
      h: ctx.h || ''
    });

    const relDir = CC.sanitizeRelPath(CC.render(settings.dirTemplate, map));
    let base = CC.cleanBase(CC.render(settings.nameTemplate, map), 90);

    // 模板里若自带图片扩展名，先剥掉，统一用真实扩展名
    base = base.replace(/\.(png|jpe?g|webp|gif|svg|avif|bmp|ico|tiff?)$/i, '') || 'untitled';

    const ext = (ctx.ext || 'png').toLowerCase();

    return { relDir, base, ext, filename: base + '.' + ext, full: (relDir ? relDir + '/' : '') + base + '.' + ext, seq };
  }

  /* ---------------- 通道实现 ---------------- */

  async function saveWebdav(settings, file, bytes, mime) {
    const w = settings.webdav || {};
    return await CC.webdavPut(w, file.full, bytes, mime || CC.mimeFromExt(file.ext), !!settings.overwrite);
  }

  async function saveFsa(settings, file, bytes) {
    const handle = await CC.getDirHandle().catch(() => null);
    if (!handle) return { ok: false, error: '尚未授权保存目录' };
    try {
      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return { ok: false, error: '目录授权已失效，请在设置页重新授权' };

      let dir = handle;
      if (file.relDir) {
        for (const seg of file.relDir.split('/')) {
          dir = await dir.getDirectoryHandle(seg, { create: true });
        }
      }
      const fh = await dir.getFileHandle(file.filename, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      return { ok: true, path: file.full };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* ---------------- 对外主入口 ---------------- */

  /**
   * @param {object} asset
   *   dataUrl  截图得到的 dataURL（与 url / bytes 三选一）
   *   url      图片地址（由调用方先抓成 bytes 更稳）
   *   bytes    Uint8Array
   *   mime     字节对应的 mime
   *   ext      扩展名（缺省由 mime 推导）
   *   type     region|viewport|fullpage|batch|single
   *   page/host/sourceUrl/pageTitle
   *   n        批量序号
   *   w/h      尺寸
   */
  CC.saveAsset = async function (asset) {
    const settings = asset.settings || (await CC.getSettings());

    let bytes = asset.bytes;
    let mime = asset.mime;

    if (!bytes && asset.dataUrl) {
      bytes = CC.dataUrlToBytes(asset.dataUrl);
      mime = mime || CC.mimeFromDataUrl(asset.dataUrl);
    }
    if (!bytes) return { ok: false, error: '没有可写入的数据' };
    if (!mime) mime = 'image/png';

    const ext = asset.ext || CC.extFromMime(mime);

    /* 去重 */
    if (settings.skipDuplicate) {
      const hex = await CC.sha256Hex(bytes).catch(() => '');
      if (hex && (await CC.seenHash(hex).catch(() => false))) {
        return { ok: true, duplicated: true, skipped: true, path: '(重复，已跳过)' };
      }
      asset._hash = hex;
    }

    const file = await buildTarget(settings, {
      page: CC.pageSlug(asset.page || asset.pageTitle, asset.host),
      host: asset.host,
      type: asset.type || 'shot',
      name: asset.name,
      n: asset.n,
      w: asset.w,
      h: asset.h,
      ext
    });

    let result;
    if (settings.mode === 'fsa') {
      result = await saveFsa(settings, file, bytes);
    } else {
      result = await saveWebdav(settings, file, bytes, mime);
    }

    if (result.ok) {
      if (asset._hash && !result.duplicated) {
        await CC.rememberHash(asset._hash).catch(() => {});
      }
      await CC.bumpStats({
        count: result.duplicated ? 0 : 1,
        bytes: result.duplicated ? 0 : bytes.length,
        skipped: result.duplicated ? 1 : 0
      }).catch(() => {});
    } else {
      await CC.bumpStats({ failed: 1 }).catch(() => {});
    }

    return result;
  };

  /** 抓取远端图片字节：优先扩展上下文 fetch（有 host_permissions，不受页面 CORS 限制） */
  CC.fetchImageBytes = async function (url, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout || 30000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: ctl.signal,
        cache: 'force-cache',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength === 0) return { ok: false, error: '空响应' };
      return { ok: true, bytes: new Uint8Array(buf), mime: mime || CC.mimeFromExt(CC.extFromUrl(url)) };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
})(self);
