/*
 * 素材采集器 · 通用工具
 * 无 chrome.* 依赖，service worker 与 content script 共用。
 * 挂载到全局 self.CC
 */
(function (root) {
  'use strict';
  const CC = (root.CC = root.CC || {});
  if (CC.__util) return;
  CC.__util = true;

  const pad = (n, l) => String(n).padStart(l || 2, '0');

  CC.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** chrome.storage.local 里的配置键（内容脚本与后台共用） */
  CC.SETTINGS_KEY = 'collector.settings.v1';

  /* ---------------- 模板 ---------------- */

  // 可用占位符：{yyyy}{yy}{mm}{dd}{hh}{mi}{ss}{ts}{rnd}{page}{host}{type}{n}{name}{w}{h}{ext}
  CC.tokenMap = function (date, extra) {
    const d = date instanceof Date ? date : new Date();
    return Object.assign(
      {
        yyyy: String(d.getFullYear()),
        yy: String(d.getFullYear()).slice(2),
        mm: pad(d.getMonth() + 1),
        dd: pad(d.getDate()),
        hh: pad(d.getHours()),
        mi: pad(d.getMinutes()),
        ss: pad(d.getSeconds()),
        ts: String(Math.floor(d.getTime() / 1000)),
        rnd: Math.random().toString(36).slice(2, 6)
      },
      extra || {}
    );
  };

  CC.render = function (tpl, map) {
    return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(map, k) && map[k] != null ? String(map[k]) : m;
    });
  };

  /* ---------------- 路径清洗 ----------------
   *
   * 三条平台规则必须同时满足，否则文件在某个系统上会写不进去：
   *
   *   1) 单段文件名上限是「字节」不是「字符」
   *      Windows NTFS 用 UTF-16 码元(255)，macOS APFS/HFS+ 与 Linux(ext4/Btrfs) 用
   *      UTF-8 字节(255)。群晖共享文件夹是 ext4/Btrfs —— 所以只要目标是 NAS，
   *      不管客户端是 Windows 还是 macOS，卡的都是 UTF-8 的 255 字节。
   *      一个汉字 3 字节，按「90 个字符」截断会得到 270 字节 → ENAMETOOLONG /
   *      WebDAV 400。必须按字节截，且不能把多字节字符劈成两半。
   *
   *   2) 非法字符集取并集：[\\/:*?"<>|] + C0 控制符。
   *      其中 `:` 只在 Windows 非法（macOS 的 POSIX 层允许，但 Finder 会显示成 `/`），
   *      一并替换掉对两边都安全。
   *
   *   3) Windows 保留设备名 CON/PRN/AUX/NUL/COM1-9/LPT1-9（带任意扩展名也一样保留）。
   *      macOS / Linux 无此限制，但为了「同一份配置两端产出一致」，统一加前缀规避。
   */

  /** 单段文件名的字节预算。留出扩展名与 -123 重名后缀的余量，取 200（硬限 255）。 */
  CC.MAX_SEG_BYTES = 200;

  /** UTF-8 字节数（按码点计，不会把代理对算成两段） */
  CC.utf8Len = function (s) {
    const str = String(s == null ? '' : s);
    let n = 0;
    for (const ch of str) {
      const c = ch.codePointAt(0);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  };

  /** 按 UTF-8 字节截断，保证不切开任何一个字符 */
  CC.sliceBytes = function (s, maxBytes) {
    const str = String(s == null ? '' : s);
    const limit = Math.max(1, Number(maxBytes) || CC.MAX_SEG_BYTES);
    if (CC.utf8Len(str) <= limit) return str;
    let out = '';
    let used = 0;
    for (const ch of str) {
      const n = CC.utf8Len(ch);
      if (used + n > limit) break;
      out += ch;
      used += n;
    }
    return out;
  };

  const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  /** Windows 保留设备名（含带扩展名的形式）加下划线前缀规避 */
  function guardReserved(name) {
    const dot = name.indexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return WIN_RESERVED.test(stem) ? '_' + name : name;
  }

  /**
   * @param s        原始片段
   * @param maxChars 字符数上限（软限，主要给目录名用）
   * 实际生效的是 min(maxChars 个字符, MAX_SEG_BYTES 字节)
   */
  CC.cleanSeg = function (s, maxChars) {
    const t = String(s == null ? '' : s)
      .normalize('NFKC')
      // C0 + DEL + C1 控制符。把 C1（\u0080-\u009f，含 NEL \u0085）也一并清掉：
      // 它们在 Windows 上会被 SMB 拒绝、在 macOS 上是不可见字符，留着只会制造怪文件名。
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      // 这里的 \s 取 JS 定义（含 \uFEFF）—— 零宽不换行空格肉眼看不见，但会让文件名对不上。
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.\s]+|[-.\s]+$/g, '');

    // 注意用 Array.from(...) 而不是 String.slice()：slice 按 UTF-16 码元数截断，
    // 而下面的字节预算与「字符数上限」都是按码点算的。对 emoji 这类代理对字符
    // （🎉 是 1 个码点 / 2 个码元 / 4 个 UTF-8 字节），两种数法能差一倍。
    let out = Array.from(t || 'untitled').slice(0, maxChars || 60).join('');
    // 字节截断后可能留下尾部的 '-' 或 '.'（Windows 不允许文件名以点/空格结尾）
    out = CC.sliceBytes(out, CC.MAX_SEG_BYTES).replace(/[-.\s]+$/, '');
    if (!out) out = 'untitled';
    return guardReserved(out);
  };

  /**
   * 目录段清理：与 cleanSeg 的唯一区别是「没内容就返回空串」，而不是兜底成 untitled。
   *
   * 为什么必须分开：文件名留空兜底成 untitled.png 是对的（文件总得有个名字），
   * 但**目录留空的语义是「不要这一层目录」**。若也走 untitled 兜底，用户把
   * 「子目录模板」清空（或只写了个 `/`、`{yyyy}/` 这种尾部带斜杠的模板）之后，
   * 文件不会落在目标目录根下，而是会凭空多出一个 `untitled/` 文件夹 ——
   * 用户看到的是「明明清空了，怎么还是有文件夹」。
   *
   * 判据用「整段里有没有字母或数字（含中日韩等任意文种）」：纯粹由符号/空白组成的段
   * （`***`、`/`、`   `、`..`）一律视为无内容而丢弃。
   */
  CC.cleanDirSeg = function (s, maxChars) {
    const raw = String(s == null ? '' : s);
    if (!/[\p{L}\p{N}]/u.test(raw)) return '';
    return CC.cleanSeg(raw, maxChars);
  };

  /** 只保留安全的相对目录，剥掉 .. / 绝对路径 / 盘符；无内容的段直接丢弃 */
  CC.sanitizeRelPath = function (p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .replace(/^[a-zA-Z]:/, '')
      .split('/')
      .map((s) => CC.cleanDirSeg(s, 60))
      .filter((s) => s && s !== '.' && s !== '..')
      .join('/');
  };

  /** 文件名主体（不含扩展名） */
  CC.cleanBase = function (s, max) {
    const t = CC.cleanSeg(s, max || 80).replace(/[.\s]+$/, '');
    if (!t) return 'untitled';
    // 剥掉尾部点号后可能重新变成保留名（例如 "NUL." → "NUL"），再兜一次
    return guardReserved(t);
  };

  /* ---------------- 类型 ---------------- */

  const MIME2EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/tiff': 'tiff',
    'image/heic': 'heic'
  };
  const EXT2MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    tif: 'image/tiff',
    tiff: 'image/tiff'
  };

  CC.extFromMime = function (mime) {
    return MIME2EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || 'png';
  };
  CC.mimeFromExt = function (ext) {
    return EXT2MIME[String(ext || '').toLowerCase().replace(/^\./, '')] || 'image/png';
  };
  CC.extFromUrl = function (url) {
    const m = String(url || '')
      .split('?')[0]
      .split('#')[0]
      .match(/\.([a-zA-Z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : '';
  };
  CC.FORMAT_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

  /* ---------------- 字节 ---------------- */

  CC.dataUrlToBytes = function (dataUrl) {
    const s = String(dataUrl || '');
    const i = s.indexOf(',');
    if (i < 0) throw new Error('非法的 dataURL');
    const meta = s.slice(0, i);
    const body = s.slice(i + 1);
    if (/;base64/i.test(meta)) {
      const bin = atob(body);
      const out = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
  };

  CC.mimeFromDataUrl = function (dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;,]+)/);
    return m ? m[1] : 'image/png';
  };

  /**
   * 字节 → dataURL。
   *
   * 必须分块拼：String.fromCharCode.apply(null, 大数组) 会爆调用栈
   * （一张几 MB 的图就是几百万个参数），分 32KB 一段是安全值。
   */
  CC.bytesToDataUrl = function (bytes, mime) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return 'data:' + (mime || 'image/png') + ';base64,' + btoa(bin);
  };

  CC.sha256Hex = async function (bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  /* ---------------- 杂项 ---------------- */

  CC.humanSize = function (n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(2) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  };

  CC.hostOf = function (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  };

  /**
   * Pinterest CDN 的「原图」地址换算。
   *
   * 地址形如 https://i.pinimg.com/<尺寸段>/ab/cd/ef/<hash>.<ext>，
   * 尺寸段是 CDN 的分辨率指令（74x / 170x / 236x / 474x / 564x / 736x / 1200x …），
   * 换成 originals 就是上传时的原始文件 —— 路径其余部分完全相同，
   * 所以不需要去解析页面数据，页面上随便一张缩略图都能逆推出原图。
   *
   * 注意：从**外站抓取**来的 pin，Pinterest 未必存了原图，originals 可能 403 或回落，
   * 调用方要准备好退回缩略图（background.js 的 collectPin 就是这么做的）。
   *
   * @returns 原图地址；域名不是 pinimg 或结构不符时返回空串（便于当判据用）
   */
  CC.pinimgOriginal = function (url) {
    try {
      const u = new URL(String(url || ''));
      if (!/(^|\.)pinimg\.com$/i.test(u.hostname)) return '';
      const m = u.pathname.match(/^\/(?:\d+x\d*|originals)\/(.+)$/i);
      if (!m || !m[1]) return '';
      return u.origin + '/originals/' + m[1];
    } catch (_) {
      return '';
    }
  };

  /**
   * 把 pinimg 地址的尺寸段换成指定尺寸（如 '736x' / '564x' / '1200x'）。
   *
   * 为什么需要这个：`/originals/` 并不是每张图都有。实测外站抓来的 pin，
   * `i.pinimg.com/originals/...` 会返回 **403 AccessDenied**（S3 的「对象不存在」），
   * 而此时页面上的 `236x` 只有几 KB。两者之间必须有一档可用的中间尺寸 ——
   * `736x` / `564x` 这类在 CDN 上普遍存在，是「拿不到原图时最不坏的选择」。
   *
   * 只对 pinimg 生效；非 pinimg 或路径里没有尺寸段时返回空串（调用方据此跳过）。
   */
  CC.pinimgSized = function (url, size) {
    try {
      const u = new URL(String(url || ''));
      if (!/(^|\.)pinimg\.com$/i.test(u.hostname)) return '';
      const m = u.pathname.match(/^\/(?:\d+x\d*|originals)\/(.+)$/i);
      if (!m || !m[1]) return '';
      const s = String(size || '').trim();
      if (!/^\d+x$/i.test(s)) return '';
      return u.origin + '/' + s + '/' + m[1];
    } catch (_) {
      return '';
    }
  };

  /**
   * 是不是 Pinterest 站点（含 pinterest.co.uk / pinterest.de 这类地区域名）。
   *
   * 用「pinterest.<TLD> 结尾」判断，不能用 `includes('pinterest')`：
   * 后者会把 `pinterest.com.evil.com`、`notpinterest.com` 一起放进来。
   * 末尾锚点是关键 —— 只有主域就是 pinterest 的地址才算。
   */
  CC.isPinterestHost = function (host) {
    const h = String(host || '').trim().toLowerCase();
    return /^(?:[a-z0-9-]+\.)*pinterest\.(?:com|com\.[a-z]{2}|co\.[a-z]{2}|[a-z]{2,3})$/.test(h);
  };

  CC.isPinterestUrl = function (url) {
    try {
      return CC.isPinterestHost(new URL(String(url)).hostname);
    } catch (_) {
      return false;
    }
  };

  /**
   * Pinterest「保存」按钮的可访问名判定 —— 保存镜像的唯一触发口。
   *
   * 为什么不按 class 找按钮：Pinterest 的 class 是混淆出来的（`X8m 1OV` 这种），
   * 每次发版都换一遍；而按钮上给人看的字（中文「保存」/ 英文「Save」）稳定得多。
   *
   * 必须排除三类：已保存（点它是取消收藏）、取消保存、收藏夹（左侧导航）。
   * 长度上限拦的是「段落里恰好有保存二字」的情况。
   */
  CC.pinSaveLabel = function (name) {
    const t = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t || t.length > 32) return false;
    if (/^(?:已保存|取消|saved|unsave)/.test(t)) return false;
    if (/^(?:保存|收藏(?!夹))/.test(t)) return true;
    // save / save to board / save image；`\b` 顺带挡住 saved
    if (/^save\b/.test(t)) return true;
    return /^pin it$/.test(t);
  };

  /** 页面标题里常见的噪音（站点名后缀等）处理 */
  CC.pageSlug = function (title, host) {
    let t = String(title || '').trim();
    if (host) {
      t = t.replace(new RegExp('[\\s\\-—|·]+' + host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '');
    }
    return CC.cleanSeg(t || host || 'page', 40);
  };

  CC.isRestrictedUrl = function (url) {
    const u = String(url || '');
    if (!u) return true;
    if (/^(chrome|edge|brave|opera|vivaldi|quark|qqbrowser|about|devtools|view-source|chrome-extension|moz-extension|file|data|blob):/i.test(u)) {
      return true;
    }
    if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org)/i.test(u)) {
      return true;
    }
    return false;
  };

  CC.uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };
})(self);
