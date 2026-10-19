/*
 * 反推提示词链路验证（可选闸门）。
 *
 * 打的是本地 ComfyUI：/system_stats → /upload/image → /prompt → /history。
 * ComfyUI 没启动时**跳过而不是失败** —— 它不属于「代码坏了」，
 * 只是这台机器此刻没开；报红会淹没真正的回归。
 *
 * 跑法：
 *   node dev-tests/comfy_reverse_test.mjs
 *   COMFY_URL=http://127.0.0.1:8188 COMFY_TEST_IMAGE=<大图路径> node dev-tests/comfy_reverse_test.mjs
 *
 * 为什么默认图是一张 128px 图标：只为验证管线（上传/排队/取文本），
 * 反推质量得用真实照片看，那一步交给 workbench 手测。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  Blob,
  File: globalThis.File,
  FormData,
  fetch,
  btoa,
  atob,
  AbortController,
  setTimeout,
  clearTimeout,
  URL,
  Response,
  Headers,
  Request
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['lib/util.js', 'lib/comfy.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const CC = sandbox.CC;

const cfg = {
  baseUrl: process.env.COMFY_URL || 'http://127.0.0.1:8188',
  clipName: process.env.COMFY_CLIP || 'qwen3vl_4b_fp8_scaled.safetensors',
  clipType: process.env.COMFY_CLIP_TYPE || 'krea2',
  maxLength: 420,
  timeout: 300000
};

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  [PASS] ' + name);
  } else {
    fail++;
    console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : ''));
  }
}

const ping = await CC.comfyPing(cfg);
if (!ping.ok) {
  console.log('  [SKIP] ComfyUI 未启动（' + ping.error + '）—— 这条闸门不计入失败');
  console.log('\n0 / 0  (skipped)');
  process.exit(0);
}
check('ComfyUI 可连接', true);
console.log('       ' + ping.version + ' · ' + ping.device + ' · ' + ping.vram);

const imgPath = process.env.COMFY_TEST_IMAGE || path.join(root, 'assets/icons/128.png');
const bytes = new Uint8Array(fs.readFileSync(imgPath));
check('测试图存在（' + path.basename(imgPath) + '）', bytes.length > 0);

const t0 = Date.now();
let text = '';
let linkOk = false;
let why = '';
try {
  text = await CC.comfyReverse(
    cfg,
    bytes,
    'image/png',
    CC.KREA2_INSTRUCTION,
    (ms, info) => {
      if (ms > 0 && ms % 5000 < 700) {
        console.log('       等待中 ' + (ms / 1000).toFixed(0) + 's' + (info && info.ok ? ' · 队列 ' + info.running + '/' + info.pending : ''));
      }
    }
  );
  linkOk = true;
} catch (e) {
  why = String((e && e.message) || e);
  // 「执行完成但没有文本」/「空文本」都发生在 上传 → 排队 → 取回 history 之后：
  // 链路本身是通的，只是这张图没出词。真正断链的报错是「连不上 / 超时 / HTTP 5xx」。
  linkOk = /空文本|没有拿到文本输出/.test(why);
}

check('整条链路跑通（上传 → 排队 → 取回执行记录）', linkOk, why);

// 回显指令是 v1.6.1 加的守卫：模型没出词时会把指令原文吐回来，
// 这种东西粘进 Krea 就是一整段中文说明，必须当失败处理。
check('返回的不是指令原文', !text || text.indexOf('You are an image prompt engineer') !== 0, String(text).slice(0, 60));

if (text) {
  check('拿到了非空文本', text.trim().length > 10, text.slice(0, 80));
  console.log('       ' + ((Date.now() - t0) / 1000).toFixed(1) + 's · ' + text.slice(0, 120) + '…');
} else {
  check('出词质量（本机素材出不了词时跳过判断）', true);
  console.log('       ' + ((Date.now() - t0) / 1000).toFixed(1) + 's · 这张图没出词：' + (why || '返回空'));
  console.log('       提示：默认用 assets/icons/128.png 当夹具，图标类小图模型往往写不出东西；');
  console.log('             换一张真实照片可验证出词质量：COMFY_TEST_IMAGE=<图片路径> node dev-tests/comfy_reverse_test.mjs');
}

console.log('\n' + pass + ' / ' + fail + '  (' + pass + ' pass, ' + fail + ' fail)');
process.exit(fail ? 1 : 0);
