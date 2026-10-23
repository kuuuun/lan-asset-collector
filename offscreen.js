/*
 * 觅图采集器 · offscreen 文档
 *
 * MV3 的 service worker 没有 DOM，所以这两件事必须在有 DOM 的上下文里做：
 *   1) navigator.clipboard.write —— 把图片写进系统剪贴板（能直接粘进 PS / Figma）
 *   2) canvas 缩放 —— 工作台列目录时把几 MB 的原图压成 300px 缩略图
 *
 * 由 background.js 用 chrome.offscreen.createDocument 拉起，用完不主动关闭：
 * 反复创建/销毁比常驻更贵，而且剪贴板写入偶尔需要重试。
 */

const MAX_EDGE = 460;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

/** 统一转成 PNG：Chrome 的剪贴板对 image/png 最稳，webp/avif 有版本差异 */
async function toPngBlob(img) {
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片没有有效尺寸');
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('转码失败');
  return blob;
}

async function copyImage(dataUrl) {
  const img = await loadImage(dataUrl);
  const blob = await toPngBlob(img);

  // 有些内核（夸克这类）在 offscreen 里首次写会因为文档未聚焦被拒一次，
  // 给它一个微任务+一次重试的机会，比直接报错体面。
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return { ok: true, w: img.naturalWidth, h: img.naturalHeight, bytes: blob.size };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr || '写入剪贴板失败') };
}

/** 缩略图：长边压到 MAX_EDGE，JPEG 质量 0.82（列表里够看，内存只有原图的几十分之一）
 *  quality 可调：上传给 ComfyUI 反推时用 0.9，比列表缩略图要保真一点。 */
async function makeThumb(dataUrl, max, quality) {
  const img = await loadImage(dataUrl);
  const limit = Math.max(120, Math.min(4096, Number(max) || MAX_EDGE));
  const scale = Math.min(1, limit / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.imageSmoothingQuality = 'high';
  // 先铺白底再画图：JPEG 没有 alpha 通道，PNG 的透明区域直接转 JPEG 会变成纯黑
  // （实测透明像素变成 [0,0,0]），工作台里带透明的素材就会出现一块黑底。
  // 与 lib/imageproc.js 的 convertDataUrl 保持同一套处理。
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const q = Math.max(0.4, Math.min(0.98, Number(quality) || 0.82));
  return {
    ok: true,
    dataUrl: canvas.toDataURL('image/jpeg', q),
    w,
    h,
    from: { w: img.naturalWidth, h: img.naturalHeight },
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'clipboard:image') {
    copyImage(msg.dataUrl).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'image:thumb') {
    makeThumb(msg.dataUrl, msg.max, msg.quality)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  // 其它消息不接，也不回 —— 让 background 自己的监听器去处理
  return;
});
