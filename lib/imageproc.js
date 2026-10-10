/*
 * 素材采集器 · 页面内图像处理（内容脚本使用，依赖 DOM/Canvas）
 */
(function (root) {
  'use strict';
  const CC = (root.CC = root.CC || {});
  if (CC.__imgproc) return;
  CC.__imgproc = true;

  // 单张画布像素上限，超过则整体缩放（Chrome 画布面积上限约 2.68 亿像素）
  const MAX_AREA = 40 * 1000 * 1000;
  const MAX_DIM = 32000;

  CC.loadImage = function (src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图像解码失败'));
      img.decoding = 'sync';
      img.src = src;
    });
  };

  function outMime(opts) {
    const f = (opts && opts.format) || 'png';
    return CC.FORMAT_MIME[f] || 'image/png';
  }

  function fitScale(w, h, maxArea, maxDim) {
    const area = w * h;
    let s = 1;
    if (area > maxArea) s = Math.sqrt(maxArea / area);
    const longest = Math.max(w, h) * s;
    if (longest > maxDim) s *= maxDim / longest;
    return Math.max(0.05, Math.min(1, s));
  }

  function toDataUrl(canvas, opts) {
    const mime = outMime(opts);
    if (mime === 'image/png') return canvas.toDataURL('image/png');
    return canvas.toDataURL(mime, Math.max(0.1, Math.min(1, (opts && opts.quality) || 0.92)));
  }

  /** 按视口坐标裁剪一张截屏 */
  CC.cropDataUrl = async function (dataUrl, rect, opts) {
    const img = await CC.loadImage(dataUrl);
    const dpr = window.devicePixelRatio || 1;
    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(rect.w * dpr)));
    const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(rect.h * dpr)));

    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return { dataUrl: toDataUrl(c, opts), w: sw, h: sh };
  };

  /** 转换格式 / 等比缩放 */
  CC.convertDataUrl = async function (dataUrl, opts) {
    const img = await CC.loadImage(dataUrl);
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const s = fitScale(w, h, MAX_AREA, MAX_DIM);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext('2d');
    if (outMime(opts) !== 'image/png') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { dataUrl: toDataUrl(c, opts), w: c.width, h: c.height };
  };

  /**
   * 拼接整页截图
   * @param {Array<{y:number,dataUrl:string}>} shots 每个切片对应的真实滚动位置（CSS px）
   * @param {{width:number,height:number,dpr:number}} meta
   */
  CC.stitchDataUrl = async function (shots, meta, opts) {
    const dpr = meta.dpr || 1;
    let W = Math.round(meta.width * dpr);
    let H = Math.round(meta.height * dpr);
    const s = fitScale(W, H, MAX_AREA, MAX_DIM);
    W = Math.max(1, Math.round(W * s));
    H = Math.max(1, Math.round(H * s));

    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    for (const shot of shots) {
      let img;
      try {
        img = await CC.loadImage(shot.dataUrl);
      } catch (_) {
        continue;
      }
      const dy = Math.round(shot.y * dpr * s);
      if (dy >= H) continue;
      const remain = H - dy;
      // 该切片在目标画布中的绘制高度
      const drawH = Math.min(remain, Math.round(img.naturalHeight * s));
      if (drawH <= 0) continue;
      const srcH = Math.max(1, Math.round(drawH / s));
      ctx.drawImage(img, 0, 0, img.naturalWidth, srcH, 0, dy, W, drawH);
    }

    return { dataUrl: toDataUrl(c, opts), w: W, h: H, scaled: s < 1, scale: s };
  };
})(self);
