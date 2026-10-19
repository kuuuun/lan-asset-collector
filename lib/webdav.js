/*
 * 素材采集器 · WebDAV 通道
 * 直接用 HTTP 的 PUT 把文件写进 NAS 的 WebDAV 服务（群晖 5005/5006 端口）。
 * 不需要在局域网里部署任何接收端 —— NAS 自己就是服务端。
 */
(function (root) {
  'use strict';
  const CC = (root.CC = root.CC || {});
  if (CC.__webdav) return;
  CC.__webdav = true;

  /* ---------------- 小工具 ---------------- */

  /** UTF-8 安全的 base64（账号密码可能是中文） */
  function b64(s) {
    const bytes = new TextEncoder().encode(String(s));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function authHeaders(cfg) {
    if (!cfg || !cfg.user) return {};
    return { Authorization: 'Basic ' + b64(cfg.user + ':' + (cfg.pass || '')) };
  }

  function trimBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function encPath(rel) {
    return String(rel || '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  }

  function isHttp(url) {
    return /^https?:\/\//i.test(String(url || '').trim());
  }

  /** 统一发请求：带鉴权、带超时、不走缓存 */
  async function req(cfg, method, url, opt) {
    const o = opt || {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(5000, Number(cfg.timeout) || 60000));
    const init = {
      method,
      headers: Object.assign({}, authHeaders(cfg), o.headers || {}),
      signal: ctl.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow'
    };
    if (o.body !== undefined) init.body = o.body;
    try {
      const res = await fetch(url, init);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  function errText(e) {
    if (e && e.name === 'AbortError') return '连接超时';
    const m = String((e && e.message) || e || '');
    if (/Failed to fetch|NetworkError|network/i.test(m)) {
      return '无法连接（地址或端口不对，或被防火墙挡住）';
    }
    return m || '未知错误';
  }

  /* ---------------- 连通性 / 鉴权 / 可写性探测 ---------------- */

  /**
   * @param config  { baseUrl, user, pass, timeout }
   * @param opt     { write:boolean } 是否再做一次真实写入+删除
   * @returns { ok, error?, baseUrl?, info? }
   */
  CC.webdavProbe = async function (config, opt) {
    const cfg = config || {};
    const base = trimBase(cfg.baseUrl);

    if (!isHttp(base)) return { ok: false, error: '地址未配置完整（需以 http:// 或 https:// 开头）' };
    if (!cfg.user) return { ok: false, error: '未填写账号' };

    const dir = base + '/';
    let res;
    try {
      res = await req(cfg, 'PROPFIND', dir, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body:
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'
      });
    } catch (e) {
      return { ok: false, error: errText(e) };
    }

    if (res.status === 401) return { ok: false, error: '账号或密码不正确（HTTP 401）' };
    if (res.status === 403) return { ok: false, error: '该账号没有此目录的 WebDAV 权限（HTTP 403）' };
    if (res.status === 404) return { ok: false, error: '路径不存在（HTTP 404）——检查 WebDAV 根路径是否正确' };
    if (res.status === 405) return { ok: false, error: '该地址不是 WebDAV 服务（HTTP 405）' };
    if (res.status !== 207 && res.status !== 200) {
      return { ok: false, error: 'WebDAV 返回 HTTP ' + res.status };
    }

    if (!opt || !opt.write) return { ok: true, baseUrl: dir, info: '连接与鉴权正常' };

    const probeUrl = dir + '_collector_probe.txt';
    try {
      const put = await req(cfg, 'PUT', probeUrl, {
        headers: { 'Content-Type': 'text/plain' },
        body: new Blob(['lan-collector-probe'], { type: 'text/plain' })
      });
      if (put.status === 401 || put.status === 403) {
        return { ok: false, error: '能读取但不能写入（PUT HTTP ' + put.status + '）' };
      }
      if (put.status >= 300) return { ok: false, error: '写入被拒（PUT HTTP ' + put.status + '）' };
    } catch (e) {
      return { ok: false, error: '写入测试失败：' + errText(e) };
    }

    let cleaned = true;
    try {
      await req(cfg, 'DELETE', probeUrl, {});
    } catch (_) {
      cleaned = false;
    }
    return {
      ok: true,
      baseUrl: dir,
      info: cleaned ? '连接、鉴权、写入均正常' : '写入正常（探测文件未能删除，可手工清理 _collector_probe.txt）'
    };
  };

  /* ---------------- 逐级建目录 ---------------- */

  /** MKCOL 每一级；已存在（405/301/200）都算成功 */
  async function ensureDir(cfg, base, relDir) {
    const segs = String(relDir || '').split('/').filter(Boolean);
    let cur = base;
    for (const seg of segs) {
      cur = cur + '/' + encodeURIComponent(seg);
      let res;
      try {
        res = await req(cfg, 'MKCOL', cur, {});
      } catch (e) {
        throw new Error('创建目录「' + seg + '」失败：' + errText(e));
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('创建目录「' + seg + '」被拒绝（HTTP ' + res.status + '）');
      }
      // 201 已创建；405 already exists；301 重定向到带斜杠的目录；200 部分服务端这样回
      if (res.status !== 201 && res.status !== 200 && res.status !== 301 && res.status !== 405) {
        throw new Error('创建目录「' + seg + '」失败（HTTP ' + res.status + '）');
      }
    }
    return cur;
  }

  /* ---------------- 写入 ---------------- */

  /**
   * @param config    { baseUrl, user, pass, timeout }
   * @param relPath   相对 baseUrl 的路径，如 "2026-10-10/143208-设计参考-1.png"
   * @param bytes     Uint8Array / Blob
   * @param mime      Content-Type
   * @param overwrite true 覆盖同名；false 时同名自动加 -1、-2
   * @returns { ok, path?, error? }
   */
  CC.webdavPut = async function (config, relPath, bytes, mime, overwrite) {
    const cfg = config || {};
    const base = trimBase(cfg.baseUrl);
    if (!isHttp(base)) return { ok: false, error: 'WebDAV 地址未配置' };

    const segs = String(relPath || '').split('/').filter(Boolean);
    const filename = segs.pop();
    if (!filename) return { ok: false, error: '文件名为空' };
    const relDir = segs.join('/');

    let dirUrl;
    try {
      dirUrl = await ensureDir(cfg, base, relDir);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }

    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';

    for (let i = 0; i < 500; i++) {
      const name = i === 0 ? filename : stem + '-' + i + ext;
      const url = dirUrl + '/' + encodeURIComponent(name);
      const headers = { 'Content-Type': mime || 'application/octet-stream' };
      // 用条件请求保护同名文件；若服务端不支持该头，退化为直接覆盖
      if (!overwrite) headers['If-None-Match'] = '*';

      let res;
      try {
        res = await req(cfg, 'PUT', url, { headers, body: bytes });
      } catch (e) {
        return { ok: false, error: '写入失败：' + errText(e) };
      }

      if (res.status === 412) continue; // 同名已存在 → 换一个序号
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: '鉴权失败（HTTP ' + res.status + '），请检查账号密码与 WebDAV 权限' };
      }
      if (res.status === 409) return { ok: false, error: '父目录不存在或结构冲突（HTTP 409）' };
      if (res.status === 423) return { ok: false, error: '文件被锁定（HTTP 423）' };
      if (res.status >= 300) return { ok: false, error: 'HTTP ' + res.status };

      return { ok: true, path: (relDir ? relDir + '/' : '') + name };
    }
    return { ok: false, error: '同名文件过多，已放弃' };
  };

  /* ---------------- 列目录（素材工作台用） ---------------- */

  /** 从 href 里取最后一段并解码（群晖会给百分号编码的中文） */
  function nameOf(href) {
    let p = String(href || '');
    try {
      p = new URL(p, 'http://x').pathname;
    } catch (_) {}
    const segs = p.split('/').filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : '';
    try {
      return decodeURIComponent(last);
    } catch (_) {
      return last;
    }
  }

  function isSelfHref(href, dirHref) {
    const norm = (s) => {
      try {
        return decodeURI(new URL(s, 'http://x').pathname).replace(/\/+$/, '');
      } catch (_) {
        return String(s || '').replace(/\/+$/, '');
      }
    };
    return norm(href) === norm(dirHref);
  }

  /**
   * 列一级目录（Depth: 1，**不递归**）。
   *
   * 刻意不递归：素材目录下可能有上万个文件，递归一次能把浏览器和 NAS 一起拖住；
   * 工作台是「进到哪一层看哪一层」，点文件夹再列下一层。
   *
   * @param relDir 相对 baseUrl 的子路径，'' = 目标目录本身
   * @returns { ok, entries:[{name,href,url,isDir,size,lastmod,mime}], dirUrl, error? }
   */
  CC.webdavList = async function (config, relDir) {
    const cfg = config || {};
    const base = trimBase(cfg.baseUrl);
    if (!isHttp(base)) return { ok: false, error: 'WebDAV 地址未配置' };
    if (!cfg.user) return { ok: false, error: 'WebDAV 账号未填写' };

    const segs = String(relDir || '')
      .split('/')
      .filter(Boolean);
    const dirUrl = base + '/' + segs.map(encodeURIComponent).join('/') + (segs.length ? '/' : '');

    let res;
    try {
      res = await req(cfg, 'PROPFIND', dirUrl, {
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body:
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<D:propfind xmlns:D="DAV:"><D:prop>' +
          '<D:displayname/><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getcontenttype/>' +
          '</D:prop></D:propfind>'
      });
    } catch (e) {
      return { ok: false, error: errText(e) };
    }

    if (res.status === 404) return { ok: false, error: '目录不存在（HTTP 404）' };
    if (res.status === 401 || res.status === 403) return { ok: false, error: '没有该目录的读取权限（HTTP ' + res.status + '）' };
    if (res.status !== 207 && res.status !== 200) return { ok: false, error: '列目录失败（HTTP ' + res.status + '）' };

    const xml = await res.text();
    const entries = [];
    // 不引 DOMParser：这个函数后台也要能用（MV3 service worker 里没有 DOM）。
    // DAV 的 multistatus 结构稳定，按 response 块切、再各取几个标签足够用。
    const blocks = String(xml).match(/<[^>]*:?response\b[\s\S]*?<\/[^>]*:?response>/gi) || [];
    for (const b of blocks) {
      const hrefM = b.match(/<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i);
      if (!hrefM) continue;
      const href = hrefM[1].trim();
      if (isSelfHref(href, dirUrl)) continue;

      const isDir = /<[^>]*:?collection\s*\/?>/i.test(b);
      const sizeM = b.match(/<[^>]*:?getcontentlength[^>]*>(\d+)</i);
      const modM = b.match(/<[^>]*:?getlastmodified[^>]*>([\s\S]*?)<\/[^>]*:?getlastmodified>/i);
      const typeM = b.match(/<[^>]*:?getcontenttype[^>]*>([\s\S]*?)<\/[^>]*:?getcontenttype>/i);
      let url = href;
      if (!/^https?:\/\//i.test(url)) {
        try {
          url = new URL(href, base + '/').href;
        } catch (_) {}
      }
      const name = nameOf(href);
      if (!name) continue;
      entries.push({
        name,
        href,
        url,
        isDir,
        size: sizeM ? Number(sizeM[1]) : 0,
        lastmod: modM ? modM[1].trim() : '',
        mime: typeM ? typeM[1].trim().toLowerCase() : ''
      });
    }

    // 目录优先、再按名字排（NAS 上取回的顺序不可依赖）
    entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return { ok: true, entries, dirUrl };
  };

  /** 带鉴权取一张图的字节（缩略图 / 反推取图都用它） */
  CC.webdavGetBytes = async function (config, url, timeout) {
    const cfg = Object.assign({}, config || {});
    if (timeout) cfg.timeout = timeout;
    let res;
    try {
      res = await req(cfg, 'GET', url, {});
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = await res.arrayBuffer();
    if (!buf || !buf.byteLength) return { ok: false, error: '空响应' };
    return { ok: true, bytes: new Uint8Array(buf), mime: mime || 'image/jpeg' };
  };

  CC.webdavReady = function (cfg) {
    return !!(cfg && isHttp(cfg.baseUrl) && cfg.user);
  };

  CC.webdavLabel = function (cfg) {
    const base = trimBase(cfg && cfg.baseUrl);
    if (!base) return '未配置';
    return base.replace(/^https?:\/\//i, '');
  };
})(self);
