/*
 * 集成测试：用 Node 加载「真实的」lib/util.js + store.js + webdav.js + saver.js，
 * 只给 chrome.storage 与 indexedDB 打桩，然后调用 CC.saveAsset 走完整保存链路。
 * 目的：验证命名模板、日期子目录、去重、以及最终文件真的写进了 WebDAV。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* ---------- 打桩：chrome.storage.local ---------- */
const mem = new Map();
const chromeStub = {
  storage: {
    local: {
      async get(key) {
        return mem.has(key) ? { [key]: mem.get(key) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) mem.set(k, v);
      }
    }
  }
};

/* ---------- 打桩：indexedDB（够 store.js 用即可） ---------- */
function makeIDB() {
  const data = new Map();
  const req = (getter) => {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try {
        r.result = getter();
        r.onsuccess && r.onsuccess();
      } catch (e) {
        r.error = e;
        r.onerror && r.onerror();
      }
    });
    return r;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const t = { oncomplete: null, onerror: null, onabort: null, error: null };
      t.objectStore = () => ({
        get: (k) => req(() => data.get(k)),
        put: (v, k) => req(() => void data.set(k, v)),
        delete: (k) => req(() => void data.delete(k))
      });
      // 用宏任务提交，确保此前排队的微任务（读写结果）都已回调完成
      setTimeout(() => t.oncomplete && t.oncomplete(), 0);
      return t;
    }
  };
  return { open: () => req(() => db) };
}

const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  Blob,
  fetch,
  btoa,
  atob,
  AbortController,
  setTimeout,
  clearTimeout,
  URL,
  Response,
  Headers,
  Request,
  // Uint8Array / ArrayBuffer 必须用宿主版本：util.js 里 crypto.subtle.digest 会
  // 检查 realm，若传入 vm 自带的 ArrayBuffer，Node 的 webcrypto 会拒绝。
  // 浏览器里两者同 realm，不存在这个问题 —— 纯属打桩环境的约束。
  Uint8Array,
  ArrayBuffer,
  crypto: webcrypto,
  chrome: chromeStub,
  indexedDB: makeIDB()
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['lib/util.js', 'lib/store.js', 'lib/webdav.js', 'lib/saver.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const CC = sandbox.CC;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' → ' + extra : ''}`); }
}

/* ---------- 配置成 webdav 模式 ---------- */
await CC.setSettings({
  mode: 'webdav',
  webdav: { baseUrl: 'http://127.0.0.1:8081/', user: 'tester', pass: 's3cret', timeout: 20000 },
  dirTemplate: '{yyyy}-{mm}-{dd}',
  nameTemplate: '{hh}{mi}{ss}-{page}-{n}',
  format: 'png',
  skipDuplicate: true
});

const settings = await CC.getSettings();
console.log('── 0. 目标就绪判定 ──');
const target = await CC.checkTarget(settings);
check('webdav 模式应判定为就绪', target.ready === true, JSON.stringify(target));

console.log('\n── 0.5 KV 存取（去重指纹与序号的基础）──');
const missing = await CC.idbGet('definitely-not-set');
check('取不存在的键应得到 undefined（而不是一个对象）', missing === undefined, String(missing));
await CC.idbSet('probe-key', [1, 2, 3]);
const got = await CC.idbGet('probe-key');
check('写入后应能原样读回', Array.isArray(got) && got.length === 3, JSON.stringify(got));
const s1 = await CC.nextSeq();
const s2 = await CC.nextSeq();
check('序号应从 1 起单调递增', s1 === 1 && s2 === 2, `${s1},${s2}`);

console.log('── 1. saveAsset 完整链路 ──');
const png = new Uint8Array(fs.readFileSync(path.join(root, 'assets/icons/128.png')));

const hex = await CC.sha256Hex(png).catch((e) => 'ERR:' + e.message);
check('sha256Hex 能算出摘要（去重的前提）', /^[0-9a-f]{64}$/.test(hex), hex);
const base = {
  bytes: png,
  mime: 'image/png',
  type: 'region',
  page: '设计参考',
  pageTitle: '设计参考 · 测试页',
  host: 'example.com',
  sourceUrl: 'https://example.com/design'
};

const r1 = await CC.saveAsset({ ...base });
check('首次采集应成功', r1.ok === true, JSON.stringify(r1));
const re = /^\d{4}-\d{2}-\d{2}\/\d{6}-设计参考-(\d+)\.png$/;
const m1 = re.exec(r1.path || '');
check('路径应为 日期目录/时分秒-页面名-序号.png', !!m1, r1.path);

const r2 = await CC.saveAsset({ ...base });
check('相同内容第二次应被去重跳过', r2.ok === true && r2.duplicated === true, JSON.stringify(r2));

settings.skipDuplicate = false;
await CC.setSettings({ skipDuplicate: false });
const r3 = await CC.saveAsset({ ...base });
const m3 = re.exec(r3.path || '');
check('关闭去重后应写出另一份', r3.ok === true && r3.path !== r1.path, JSON.stringify(r3));
check('序号应严格递增', !!m1 && !!m3 && Number(m3[1]) > Number(m1[1]), `${m1 && m1[1]} -> ${m3 && m3[1]}`);

console.log('\n── 1.5 文件夹规则：只看「子目录模板」 ──');
// 规则（v1.5.4 起写进文档）：最终路径 = 目标目录 + 子目录模板 + '/' + 文件名模板。
// 模板留空（或只剩非法字符 / 空白）→ 不再建子目录，图片直接落在目标目录里；
// 填了内容就一定建 —— 与用哪个采集入口、什么网站、几张图都无关。
await CC.setSettings({ dirTemplate: '' });
const rFlat = await CC.saveAsset({ ...base });
const flatRe = /^\d{6}-设计参考-\d+\.png$/;
check('子目录模板留空 → 不进文件夹，直接落在目标目录', flatRe.test(rFlat.path || ''), rFlat.path);

await CC.setSettings({ dirTemplate: '   ' });
const rBlank = await CC.saveAsset({ ...base });
check('子目录模板只有空格 → 同样不进文件夹', flatRe.test(rBlank.path || ''), rBlank.path);

await CC.setSettings({ dirTemplate: '{host}' });
const rHost = await CC.saveAsset({ ...base });
check('子目录模板写 {host} → 按站点分文件夹', /^example\.com\/\d{6}-设计参考-\d+\.png$/.test(rHost.path || ''), rHost.path);

await CC.setSettings({ dirTemplate: '{yyyy}-{mm}-{dd}' });

console.log('\n── 2. 目标未配置时的提示 ──');
await CC.setSettings({ webdav: { user: '' } });
const t2 = await CC.checkTarget(await CC.getSettings());
check('未填账号应明确提示去填账号', t2.ready === false && /账号/.test(t2.reason || ''), JSON.stringify(t2));

console.log(`\n${JSON.stringify({ pass, fail })}`);
if (r1.path) console.log('FIRST_PATH=' + r1.path);
process.exit(fail ? 1 : 0);
