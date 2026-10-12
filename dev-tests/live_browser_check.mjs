/*
 * 真实浏览器加载验证 —— 把扩展真的装进 Chromium 里跑一遍，而不是只看静态断言。
 *
 * 为什么需要它：静态测试能证明「代码符合规则」，证明不了「浏览器接受它」。
 * 扩展管理页里那些红字（CSP 违规、未捕获异常）只在真的加载、真的打开过某个页面之后
 * 才会出现 —— help/help.html 的内联 <script> 就是这样潜伏了很久才被发现。
 *
 * 这个脚本做的事：
 *   1. 用一个**独立的临时 profile** 启动 Edge/Chrome，只加载本扩展
 *   2. 连上 CDP，认领扩展的 service worker，收它的 console 与未捕获异常
 *   3. 逐个打开扩展自己的页面（帮助 / 弹窗 / 设置），收页面的 CSP 违规与异常
 *   4. 在后台脚本里用「畸形输入」把所有采集入口打一遍，看谁会抛未捕获异常
 *   5. 若本机有可用的 wsgidav，还会起一个本地 WebDAV，把「保存目标已就绪」这条
 *      分支也走通（那是很多空值保护唯一会真正执行的路径）
 *
 * 用完即删 profile，不碰用户的浏览器数据。不打包（dev-tests/ 永不进包）。
 *
 * 用法：
 *   node dev-tests/live_browser_check.mjs
 *   CC_BROWSER="C:/Program Files/Quark/Quark.exe" node dev-tests/live_browser_check.mjs
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const BROWSERS = [
  process.env.CC_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Quark\\Quark.exe',
].filter(Boolean);

const PY_CANDIDATES = [
  'C:/Users/guok_1528/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
  'C:/Users/guok_1528/.workbuddy/binaries/python/envs/default/bin/python',
];

let pass = 0;
let fail = 0;
let skip = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' → ' + extra : ''}`); }
}
function note(msg) { console.log(`  [SKIP] ${msg}`); skip++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.log('[SKIP] 本机没有找到可用于验证的 Chromium 浏览器');
  console.log(JSON.stringify({ pass: 0, fail: 0, skipped: true }));
  process.exit(0);
}

const PORT = 9300 + (process.pid % 300);
const DAV_PORT = 8300 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-'));
const davRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dav-'));

const args = [
  `--user-data-dir=${profile}`,
  `--load-extension=${ROOT}`,
  `--disable-extensions-except=${ROOT}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  // headless=new 支持扩展，且没有窗口/首次运行向导来阻塞启动
  '--headless=new',
  '--disable-gpu',
  // 新版本 Chromium 默认关掉了命令行加载扩展的开关，这一条把它放回来
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  'about:blank',
];

/* ---------- 极简 CDP 客户端 ---------- */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const events = [];
    const api = {
      events,
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          // 超时保护：页面被 window.close() 关掉时，CDP 请求会永远不返回，
          // 没有这一道整个脚本就挂死了（踩过一次）。
          const timer = setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时：' + method)); }
          }, 8000);
          pending.set(id, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); },
          });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_) {} },
    };
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
}

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return await r.json();
}

/** 把一堆 CDP 事件里的 CSP 违规与未捕获异常摘出来 */
function harvest(evts, where, cspHits, exceptions) {
  for (const e of evts) {
    if (e.method === 'Log.entryAdded') {
      const text = String(((e.params || {}).entry || {}).text || '');
      if (/Content Security Policy/i.test(text)) cspHits.push(`${where}: ${text.slice(0, 140)}`);
    }
    if (e.method === 'Runtime.exceptionThrown') {
      const d = ((e.params || {}).exceptionDetails || {}).exception || {};
      exceptions.push(`${where}: ${d.description || d.value || 'unknown'}`);
    }
  }
}

function killTree(pid) {
  try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch (_) {}
}

console.log('========================================================');
console.log('  真实浏览器加载验证');
console.log('========================================================');
console.log(`  浏览器  ：${path.basename(browser)}`);
console.log(`  profile ：${profile}`);

const cspHits = [];
const exceptions = [];
let child = null;
let davChild = null;
let swCdp = null;

try {
  // ---------- 可选的本地 WebDAV（把「目标已就绪」这条分支也走通） ----------
  const py = PY_CANDIDATES.find((p) => fs.existsSync(p));
  const davScript = path.join(here, 'dav_server.py');
  if (py && fs.existsSync(davScript)) {
    try {
      davChild = spawn(py, [davScript, davRoot, String(DAV_PORT), 'tester', 's3cret'], { stdio: 'ignore' });
      for (let i = 0; i < 20; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${DAV_PORT}/`, { method: 'PROPFIND', headers: { Depth: '0' } });
          if (r.status) break;
        } catch (_) {}
        await sleep(300);
      }
      console.log(`  本地 WebDAV：http://127.0.0.1:${DAV_PORT}/`);
    } catch (_) { davChild = null; }
  } else {
    console.log('  本地 WebDAV：不可用（没找到带 wsgidav 的解释器）');
  }

  // ---------- 启动浏览器 ----------
  child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
  let up = false;
  for (let i = 0; i < 70; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { up = true; break; }
    } catch (_) {}
    await sleep(300);
  }
  check('浏览器已启动并开放调试端口', up, `调试端口 ${PORT} 未就绪`);
  if (!up) throw new Error('无法连接浏览器调试端口');

  // ---------- 认领扩展的 service worker ----------
  let swTarget = null;
  let extId = '';
  for (let i = 0; i < 40; i++) {
    const targets = await listTargets();
    const t = targets.find((x) => x.type === 'service_worker'
      && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url || ''));
    if (t) { swTarget = t; extId = new URL(t.url).host; break; }
    await sleep(300);
  }
  check('扩展被浏览器接受并启动了后台脚本', !!swTarget, '没找到扩展的 service worker（可能加载被拒）');

  if (swTarget) {
    swCdp = await connect(swTarget.webSocketDebuggerUrl);
    swCdp.events.length = 0;
    await swCdp.send('Runtime.enable');
    await swCdp.send('Log.enable');
    await sleep(300);
    // 在 service worker 里挂一对记录器。扩展管理页里那些「Uncaught (in promise)」红字
    // 追不出源头（堆栈常常是丢的，只显示「行号 0」），所以这里自己抓一遍：
    // 只要后台出现过未处理的拒绝，测试就直接红。
    await swCdp.send('Runtime.evaluate', {
      expression: [
        'globalThis.__rej = [];',
        'globalThis.__err = [];',
        'if (!globalThis.__netHooked) {',
        '  globalThis.__netHooked = true;',
        '  self.addEventListener("unhandledrejection", (e) => {',
        '    const r = e && e.reason;',
        '    globalThis.__rej.push(String((r && (r.message || r)) || r));',
        '  });',
        '  self.addEventListener("error", (e) => { globalThis.__err.push(String((e && e.message) || "")); });',
        '}',
        '"hooked"',
      ].join('\n'),
      returnByValue: true,
    });
    harvest(swCdp.events, 'background.js', cspHits, exceptions);
  }

  // ---------- 后台脚本里的畸形输入探测 ----------
  const probes = [];
  if (swCdp) {
    // 把目标指到本地 WebDAV（若可用），这样 checkTarget 会返回 ready —— 
    // 那是「保存目标就绪」这条分支唯一的入口，很多空值保护只有走到这里才会被执行
    const base = davChild ? `http://127.0.0.1:${DAV_PORT}/` : 'http://127.0.0.1:9/x';
    const expr = [
      'globalThis.__probe = [];',
      'const T = async (name, fn) => {',
      '  try { const r = await fn(); globalThis.__probe.push([name, "ok", String(JSON.stringify(r)).slice(0, 60)]); }',
      '  catch (e) { globalThis.__probe.push([name, "THROW", String((e && e.message) || e)]); }',
      '};',
      `await self.CC.setSettings({ mode: "webdav", webdav: { baseUrl: ${JSON.stringify(base)}, user: "tester", pass: "s3cret", timeout: 3000 } });`,
      'const target = await self.CC.checkTarget(await self.CC.getSettings());',
      'globalThis.__probe.push(["-- target ready", target.ready ? "yes" : "no", String(target.reason || "")]);',
      // 消息来自扩展自身页面时，sender.tab 就是 undefined —— 这里等价复现
      'await T("singleSave(undefined, {...})", () => self.singleSave(undefined, { url: "data:image/png;base64,iVBORw0KGgo=" }));',
      'await T("batchSave(undefined, [item])", () => self.batchSave(undefined, [{ url: "data:image/png;base64,iVBORw0KGgo=" }], {}));',
      'await T("openBatch(undefined)", () => self.openBatch(undefined));',
      'await T("captureRegion(undefined)", () => self.captureRegion(undefined));',
      'await T("captureViewport(undefined)", () => self.captureViewport(undefined));',
      'await T("captureFullPage(undefined)", () => self.captureFullPage(undefined));',
      'await T("fetchForClip(undefined, data:)", () => self.fetchForClip(undefined, "data:image/png;base64,iVBORw0KGgo="));',
      'await T("fetchForClip(undefined, blob:)", () => self.fetchForClip(undefined, "blob:https://example.com/x"));',
      // v1.5.8：Pinterest 大图采集。无标签页时必须回结构化错误而不是抛异常
      'await T("collectPin(undefined)", () => self.collectPin(undefined));',
      // v1.5.9：单图采集的 fallbackUrl 退路。首选地址无效时要继续尝试退路，且全程不抛异常
      'await T("singleSave(fallbackUrl 退路)", () => self.singleSave(undefined, { url: "", fallbackUrl: "data:image/png;base64,iVBORw0KGgo=" }));',
      'return JSON.stringify(globalThis.__probe);',
    ].join('\n');

    const r = await swCdp.send('Runtime.evaluate', {
      expression: `(async () => {\n${expr}\n})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      check('后台脚本入口探测可执行', false, JSON.stringify(r.exceptionDetails).slice(0, 200));
    } else {
      try { probes.push(...JSON.parse(r.result.value || '[]')); } catch (_) {}
      const throws = probes.filter((p) => p[1] === 'THROW');
      check(
        `后台入口对「无标签页」输入返回结构化错误而不是抛异常（${probes.length - throws.length}/${probes.length}）`,
        throws.length === 0,
        throws.map((p) => `${p[0]}: ${p[2]}`).join(' | ')
      );
      const ready = probes.find((p) => p[0] === '-- target ready');
      if (ready && ready[1] === 'yes') console.log('  [INFO] 本地 WebDAV 已就绪，保存分支已走通');
      else note('本地 WebDAV 未就绪，保存分支未走通（这不是失败）');
    }
    await sleep(300);
    harvest(swCdp.events, 'background.js', cspHits, exceptions);
  }

  // ---------- 用真实的消息通道把每个分支打一遍 ----------
  // 放在弹窗页面里做（见下面 PAGES 循环）：从 service worker 给自己发是**不通**的 ——
  // Chrome 不会把消息投回发送者所在的 context，只会得到
  // 「Could not establish connection. Receiving end does not exist.」（踩过一次）。
  // 那段直接调用探测负责的是另一个关键差异：sender.tab 为 undefined 的情形
  // —— 真实弹窗不属于任何标签页，它发消息时就是这个样子。

  // ---------- 逐个打开扩展自己的页面 ----------
  const PAGES = [
    { label: 'help.html', rel: 'help/help.html?first=1' },
    { label: 'popup.html', rel: 'popup/popup.html' },
    { label: 'options.html', rel: 'options/options.html' },
  ];

  if (extId) {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browserCdp = await connect(ver.webSocketDebuggerUrl);

    for (const P of PAGES) {
      const url = `chrome-extension://${extId}/${P.rel}`;
      const created = await browserCdp.send('Target.createTarget', { url });
      await sleep(1400);

      const t = (await listTargets()).find((x) => x.id === created.targetId);
      check(`${P.label} 能在扩展环境里打开`, !!t, '未找到该页面的 target');
      if (!t) continue;

      const c = await connect(t.webSocketDebuggerUrl);
      c.events.length = 0;
      await c.send('Runtime.enable');
      await c.send('Log.enable');
      await sleep(700);

      // 页面渲染出内容了（说明它自己的脚本跑通了）
      const dom = await c.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ text: (document.body.innerText || "").trim().length, title: document.title })',
        returnByValue: true,
      });
      const info = JSON.parse((dom.result && dom.result.value) || '{}');
      check(`${P.label} 渲染出了内容（${info.text} 字符）`, info.text > 40, JSON.stringify(info));

      if (P.label === 'help.html') {
        const h = await c.send('Runtime.evaluate', {
          expression: "JSON.stringify({ ext: !!document.querySelector('script[src=\"help.js\"]'), inline: (document.documentElement.innerHTML.match(/<script(?![^>]*src=)/gi) || []).length, shown: !document.getElementById('first').hidden })",
          returnByValue: true,
        });
        const hi = JSON.parse((h.result && h.result.value) || '{}');
        check('帮助页只用外部脚本（无内联 <script>）', hi.ext === true && hi.inline === 0, JSON.stringify(hi));
        check('首次提示条在 ?first=1 时真的显示出来', hi.shown === true, JSON.stringify(hi));
      }

      if (P.label === 'popup.html') {
        // 记录器：弹窗里任何未处理的 Promise 拒绝 / 未捕获错误都留一份。
        // 装完再主动把初始化跑一遍，确保 loadStatus() 这条最容易出事的路径被看着。
        await c.send('Runtime.evaluate', {
          expression: [
            'window.__rej = [];',
            'window.__err = [];',
            'window.addEventListener("unhandledrejection", (e) => {',
            '  const r = e && e.reason;',
            '  window.__rej.push(String((r && (r.message || r)) || r));',
            '});',
            'window.addEventListener("error", (e) => { window.__err.push(String((e && e.message) || "")); });',
            'try { loadStatus(); } catch (_) {}',
            '"hooked"',
          ].join('\n'),
          returnByValue: true,
        });
        await sleep(500);

        const p = await c.send('Runtime.evaluate', {
          expression: "JSON.stringify({ ver: (document.getElementById('ver') || {}).textContent || '' })",
          returnByValue: true,
        });
        const pi = JSON.parse((p.result && p.result.value) || '{}');
        const manifestVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
        check(`弹窗显示的版本号是最新的（${pi.ver}）`, pi.ver === 'v' + manifestVer, `${pi.ver} vs v${manifestVer}`);

        // v1.5.7：弹窗里那行菜单状态必须自己变成「已就绪」。
        // 这条同时验证了诊断入口本身可用 —— 使用者打开面板就能直接看到右键菜单注册上没有，
        // 不用再去猜「右键里为什么没有这一项」。
        await sleep(700);
        const mb = await c.send('Runtime.evaluate', {
          expression:
            "JSON.stringify({ cls: (document.getElementById('menuBar') || {}).className || '', txt: (document.getElementById('menuText') || {}).textContent || '' })",
          returnByValue: true,
        });
        const mbi = JSON.parse((mb.result && mb.result.value) || '{}');
        check(
          `弹窗里的右键菜单状态行显示已就绪（${mbi.txt}）`,
          /\bok\b/.test(mbi.cls) && /已就绪/.test(mbi.txt),
          `class=${mbi.cls} text=${mbi.txt}`
        );

        // v1.5.8：Pinterest 大图入口必须存在，且在「非 Pinterest 页面」上保持隐藏
        // （弹窗本身开在 chrome-extension:// 页面，正是非 Pinterest 的情形）。
        const pg = await c.send('Runtime.evaluate', {
          expression:
            "JSON.stringify({ has: !!document.getElementById('pinGrab'), hidden: !!(document.getElementById('pinGrab') || {}).hidden })",
          returnByValue: true,
        });
        let pgi = {};
        try { pgi = JSON.parse((pg.result && pg.result.value) || '{}'); } catch (_) {}
        check(
          '弹窗有 Pinterest 大图入口，且非 Pinterest 页面上保持隐藏',
          pgi.has === true && pgi.hidden === true,
          JSON.stringify(pgi)
        );

        // 走真实的消息通道把后台的每个分支都打一遍（上面的直接调用绕过了 onMessage，
        // 测不到「消息包装/回复」这一层）。这里从弹窗页面发，sender.tab 是它自己。
        const msgs = [
          ['status', { type: 'status' }],
          ['test', { type: 'test' }],
          ['openIndex', { type: 'openIndex' }],
          ['settingsChanged', { type: 'settingsChanged' }],
          ['run/batch', { type: 'run', action: 'batch' }],
          ['single:save', { type: 'single:save', url: 'data:image/png;base64,iVBORw0KGgo=' }],
          ['batch:save', { type: 'batch:save', items: [{ url: 'data:image/png;base64,iVBORw0KGgo=' }] }],
          ['pin:collect', { type: 'pin:collect' }],
          ['unknown', { type: 'no-such-message' }],
        ];
        const chan = await c.send('Runtime.evaluate', {
          expression: [
            '(async () => {',
            '  const out = [];',
            '  const S = (msg) => new Promise((res) => {',
            '    const t = setTimeout(() => res("TIMEOUT"), 9000);',
            '    try {',
            '      chrome.runtime.sendMessage(msg, (r) => {',
            '        clearTimeout(t);',
            '        if (chrome.runtime.lastError) return res("LASTERR: " + chrome.runtime.lastError.message);',
            '        res(r === undefined ? "NO_REPLY" : "ok");',
            '      });',
            '    } catch (e) { clearTimeout(t); res("THROW: " + String(e && e.message)); }',
            '  });',
            `  const MSGS = ${JSON.stringify(msgs)};`,
            '  for (const pair of MSGS) { out.push([pair[0], await S(pair[1])]); }',
            '  return JSON.stringify(out);',
            '})()',
          ].join('\n'),
          awaitPromise: true,
          returnByValue: true,
        });
        let rows = [];
        try { rows = JSON.parse((chan.result && chan.result.value) || '[]'); } catch (_) {}
        // 每一条都应当在得到回复（含「未知指令」那条 —— 后台会明确回一个错误对象，
        // 而不是把消息端口一关了事）
        const broken = rows.filter((x) => x[1] !== 'ok');
        check(
          `后台每个消息分支都给出了回复（${rows.length - broken.length}/${msgs.length}）`,
          rows.length === msgs.length && broken.length === 0,
          broken.map((x) => `${x[0]}: ${x[1]}`).join(' | ')
        );
        await sleep(400);

        // 把弹窗里的入口逐个点一遍 —— 真实用户报的错就是点这里点出来的。
        // 顺序有讲究：「帮助 / 设置」会 window.close()，必须留在最后点。
        const clickOne = async (selector, label) => {
          try {
            const r = await c.send('Runtime.evaluate', {
              expression: `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return 'missing'; b.click(); return 'clicked'; })()`,
              returnByValue: true,
            });
            return { label, result: String((r.result && r.result.value) || '') };
          } catch (e) {
            return { label, result: 'ERR: ' + String((e && e.message) || e).slice(0, 60) };
          }
        };

        const clicked = [];
        for (const [sel, label] of [
          ['#status', 'status'],
          ['[data-link="stats"]', 'stats'],
          ['[data-link="about"]', 'about'],
          ['[data-link="open"]', 'open'],
        ]) {
          clicked.push(await clickOne(sel, label));
          await sleep(350);
        }
        const badClick = clicked.filter((x) => !['clicked', 'missing'].includes(x.result));
        check(
          `弹窗里 ${clicked.length} 个入口点一遍都不抛异常`,
          clicked.length === 4 && badClick.length === 0,
          badClick.map((x) => `${x.label}: ${x.result}`).join(' | ')
        );

        // 弹窗这一路点完之后，看有没有漏网的异步异常 —— K 截图里那条红字的上下文
        // 就是 popup/popup.html，所以这里必须站着看一遍
        const rej = await c.send('Runtime.evaluate', {
          expression: 'JSON.stringify({ rej: window.__rej || [], err: window.__err || [] })',
          returnByValue: true,
        });
        let rj = {};
        try { rj = JSON.parse((rej.result && rej.result.value) || '{}'); } catch (_) {}
        const pageProblems = [].concat(rj.rej || [], rj.err || []);
        check('弹窗里没有未处理的异步异常 / 未捕获错误', pageProblems.length === 0, pageProblems.join(' | '));

        // 这两个会关掉弹窗（也就是关掉我们正在观测的这个 target），放最后
        for (const [sel, label] of [['[data-link="help"]', 'help'], ['[data-link="options"]', 'options']]) {
          const r = await clickOne(sel, label);
          console.log(`  [INFO] 弹窗入口 ${label} → ${r.result}`);
          await sleep(400);
        }
        await sleep(400);
      }

      harvest(c.events, P.label, cspHits, exceptions);
      c.close();
    }
    // ---------- 悬停采集已下线（v1.5.5）：真实页面上悬停图片不该再冒出任何按钮 ----------
    // 内容脚本只注入 http/https，所以这里用内置 http 起一个临时页面：
    // 页面里放一张 400×400 的图（源图 128px，满足旧版悬停按钮的全部尺寸判据），
    // 然后真的派发 mouseover —— 哪天悬停逻辑被加回来，这条会立刻红。
    if (swCdp) {
      const probePage = '<!doctype html><meta charset="utf-8"><title>hover probe</title>'
        + '<style>body{margin:0}#pic{width:400px;height:400px}</style>'
        + '<img id="pic" src="/pic.png" alt="">';
      const iconPath = path.join(ROOT, 'assets/icons/128.png');
      const srv = http.createServer((req, res) => {
        if (/pic\.png/.test(req.url || '')) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(fs.readFileSync(iconPath));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(probePage);
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const hp = srv.address().port;
      let probeId = '';
      try {
        const created = await browserCdp.send('Target.createTarget', { url: `http://127.0.0.1:${hp}/` });
        probeId = created.targetId;
        await sleep(1800);
        const t = (await listTargets()).find((x) => x.id === probeId);
        check('本地测试页能在浏览器里打开', !!t, '未找到 target');
        if (t) {
          // 内容脚本真的注入了吗？用后台给这个标签页发 cc:ping —— 没回复的话，
          // 下面那条「没有按钮」就是假通过（页面根本没有内容脚本）。
          const ping = await swCdp.send('Runtime.evaluate', {
            expression: [
              '(async () => {',
              '  const tabs = await chrome.tabs.query({});',
              `  const t = tabs.find((x) => (x.url || "").indexOf(":${hp}/") >= 0);`,
              '  if (!t) return "NO_TAB";',
              '  return await new Promise((res) => {',
              '    try {',
              '      chrome.tabs.sendMessage(t.id, { type: "cc:ping" }, (r) => {',
              '        res(chrome.runtime.lastError ? "ERR: " + chrome.runtime.lastError.message : JSON.stringify(r));',
              '      });',
              '    } catch (e) { res("THROW: " + String(e && e.message)); }',
              '  });',
              '})()',
            ].join('\n'),
            awaitPromise: true,
            returnByValue: true,
          });
          const pr = String((ping.result && ping.result.value) || '');
          check('内容脚本已注入测试页（cc:ping 有回复）', /"ok"\s*:\s*true/.test(pr), pr.slice(0, 120));

          const c = await connect(t.webSocketDebuggerUrl);
          c.events.length = 0;
          await c.send('Runtime.enable');
          await sleep(400);
          const r = await c.send('Runtime.evaluate', {
            expression: [
              '(async () => {',
              '  const wait = (ms) => new Promise((q) => setTimeout(q, ms));',
              '  const img = document.getElementById("pic");',
              '  const b = img.getBoundingClientRect();',
              '  const x = b.left + b.width / 2, y = b.top + b.height / 2;',
              '  for (const type of ["mouseover", "mousemove", "pointerover", "pointermove"]) {',
              '    img.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));',
              '  }',
              '  await wait(500);',
              '  return JSON.stringify({',
              '    natural: img.naturalWidth,',
              '    btn: !!document.querySelector(".ccx-hover-btn"),',
              '    cls: document.querySelectorAll("[class*=ccx-hover]").length',
              '  });',
              '})()',
            ].join('\n'),
            awaitPromise: true,
            returnByValue: true,
          });
          let ho = {};
          try { ho = JSON.parse((r.result && r.result.value) || '{}'); } catch (_) {}
          check(
            `真实页面上悬停图片不再出现采集按钮（源图 ${ho.natural}px）`,
            ho.btn === false && ho.cls === 0,
            '仍然出现了 .ccx-hover-btn —— 悬停采集没删干净'
          );
          // ---------- 真机把「弹窗触发采集」这条链路走一遍 ----------
          // 这是此前唯一没有覆盖的路径：消息来自扩展自己的页面时 sender.tab 是 undefined，
          // 后台只能靠 chrome.tabs.query 找活动标签页 —— 历史上那条
          // 「Cannot read properties of undefined (reading 'id')」就出在这条线上。
          // 现在拿一个真实的活动标签页，把 batch / region / viewport 三个入口各跑一次。
          if (swCdp) {
            const escPage = () =>
              c.send('Runtime.evaluate', {
                expression:
                  'window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"',
                returnByValue: true,
              });
            const drive = (action, wait) =>
              swCdp.send('Runtime.evaluate', {
                expression: [
                  '(async () => {',
                  '  try {',
                  `    const r = await self.runAction(${JSON.stringify(action)}, undefined);`,
                  '    return JSON.stringify({ ok: true, r: String(JSON.stringify(r) || "").slice(0, 56) });',
                  '  } catch (e) { return JSON.stringify({ ok: false, e: String((e && e.message) || e) }); }',
                  '})()',
                ].join('\n'),
                awaitPromise: wait !== false,
                returnByValue: true,
              });

            const read = (x) => {
              try { return JSON.parse((x.result && x.result.value) || '{}'); } catch (_) { return { ok: false, e: '解析失败' }; }
            };

            // batch：往页面里注入勾选面板 → 用 Esc 关掉
            const jb = read(await drive('batch'));
            await sleep(800);
            await escPage();
            await sleep(300);

            // region：会一直等着用户拖框 → 不等它，先发 Esc 取消（和真人按 Esc 一样）
            await drive('region', false);
            await sleep(900);
            await escPage();
            await sleep(700);

            // viewport：真截一张并落盘（保存目标已指向本地 WebDAV）
            const jv = read(await drive('viewport'));
            await sleep(500);

            const drove = [['batch', jb], ['region', null], ['viewport', jv]];
            const bad = drove.filter((x) => x[1] && !x[1].ok);
            check(
              `弹窗触发的采集入口在真机上都不抛异常（${drove.length - bad.length}/${drove.length}）`,
              bad.length === 0,
              bad.map((x) => `${x[0]}: ${x[1].e}`).join(' | ')
            );
            console.log(
              '  [INFO] ' + drove.map((x) => `${x[0]}→${x[1] ? (x[1].r || (x[1].ok ? 'ok' : 'X')) : 'Esc 取消'}`).join('  ')
            );
            harvest(swCdp.events, 'background.js', cspHits, exceptions);
          }

          harvest(c.events, 'hover probe', cspHits, exceptions);
          c.close();
        }
      } finally {
        srv.close();
        if (probeId) {
          try { await browserCdp.send('Target.closeTarget', { targetId: probeId }); } catch (_) {}
        }
      }
    }

    browserCdp.close();
  }

  // ---------- 后台脚本里跑的到底是哪份代码 ----------
  if (swCdp) {
    const v = await swCdp.send('Runtime.evaluate', { expression: 'VERSION', returnByValue: true });
    const ver = (v.result && v.result.value) || '';
    const manifestVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
    check(`后台脚本版本与 manifest 一致（${ver} / ${manifestVer}）`, ver === manifestVer, `${ver} vs ${manifestVer}`);

    // ---------- 右键菜单在真实浏览器里到底注册上没有 ----------
    // contextMenus 没有「查询」接口，但 update 一个不存在的 id 会回 lastError（"Cannot find menu item"），
    // 而 update 已存在的 id 只是把标题重设成同一个值 —— 所以这是一个无副作用的探针。
    // 这条断言守的是「删掉别的扩展之后菜单项消失」那类问题：菜单必须真的挂在浏览器进程里。
    const menuSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
    // 从常量声明里取标题。注意别再去匹配 create(...) 里的字面量 ——
    // v1.5.7 起注册用的是 MENU_ID / MENU_TITLE 两个常量，匹配不到会取到空串，
    // 那样探针会把菜单标题真的清成空（虽然下一次注册会刷回来，但没必要的副作用）。
    const titleInSrc = (menuSrc.match(/const MENU_TITLE = '([^']+)'/) || [])[1] || '将图片保存至 LAN Collector';
    const m = await swCdp.send('Runtime.evaluate', {
      expression: [
        '(async () => {',
        '  const menu = await new Promise((res) => {',
        '    try {',
        `      chrome.contextMenus.update('cc-image', { title: ${JSON.stringify(titleInSrc)} }, () => {`,
        '        res(chrome.runtime.lastError ? "ERR: " + chrome.runtime.lastError.message : "ok");',
        '      });',
        '    } catch (e) { res("THROW: " + String(e && e.message)); }',
        '  });',
        '  const wake = !!(chrome.tabs && chrome.tabs.onActivated && chrome.tabs.onActivated.hasListeners',
        '    && chrome.tabs.onActivated.hasListeners());',
        '  const wake2 = !!(chrome.windows && chrome.windows.onFocusChanged && chrome.windows.onFocusChanged.hasListeners',
        '    && chrome.windows.onFocusChanged.hasListeners());',
        '  return JSON.stringify({ menu, wake, wake2 });',
        '})()',
      ].join('\n'),
      awaitPromise: true,
      returnByValue: true,
    });
    let mo = {};
    try { mo = JSON.parse((m.result && m.result.value) || '{}'); } catch (_) {}
    check(
      '右键菜单在浏览器里已注册（cc-image 存在）',
      mo.menu === 'ok',
      String(mo.menu || '探针无返回')
    );
    check(
      '已挂 tabs.onActivated 兜底（切标签页即重建菜单）',
      mo.wake === true,
      '监听器未注册，删掉别的扩展后菜单可能不再自动补回'
    );
    check(
      '已挂 windows.onFocusChanged 兜底（切换窗口即重建菜单）',
      mo.wake2 === true,
      '监听器未注册'
    );

    // 全程跑完，回头看看后台里攒下的未处理异常 —— 一条都不能有
    const net = await swCdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ rej: globalThis.__rej || [], err: globalThis.__err || [] })',
      returnByValue: true,
    });
    let no = {};
    try { no = JSON.parse((net.result && net.result.value) || '{}'); } catch (_) {}
    check('后台全程没有未处理的 Promise 拒绝', (no.rej || []).length === 0, (no.rej || []).join(' | '));
    check('后台全程没有未捕获错误', (no.err || []).length === 0, (no.err || []).join(' | '));
    harvest(swCdp.events, 'background.js', cspHits, exceptions);
  }

  // ---------- 直接读扩展管理页的错误列表 ----------
  // K 看到的那条红字就在这一页。最直接的证明是「这一页现在是空的」。
  // chrome:// 内部页能不能脚本化取决于浏览器，读不到就只记一条 SKIP，不算失败。
  if (extId) {
    try {
      const van = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const bc = await connect(van.webSocketDebuggerUrl);
      const et = await bc.send('Target.createTarget', { url: `chrome://extensions/?id=${extId}` });
      await sleep(2200);
      const tgt = (await listTargets()).find((x) => x.id === et.targetId);
      if (!tgt) {
        note('打不开 chrome://extensions，跳过「错误列表为空」这条');
        bc.close();
      } else {
        const ec = await connect(tgt.webSocketDebuggerUrl);
        await ec.send('Runtime.enable');
        await sleep(1200);
        const r2 = await ec.send('Runtime.evaluate', {
          expression: [
            '(() => {',
            '  const texts = [];',
            '  const walk = (root) => {',
            '    for (const el of root.querySelectorAll("*")) {',
            '      if (el.shadowRoot) walk(el.shadowRoot);',
            '      else if (!el.children.length && el.textContent) texts.push(el.textContent.trim());',
            '    }',
            '  };',
            '  walk(document);',
            '  const bad = texts.filter((t) => /Uncaught|Cannot read properties of|Content Security Policy/i.test(t));',
            '  return JSON.stringify({ bad: bad.slice(0, 3), total: texts.length });',
            '})()',
          ].join('\n'),
          returnByValue: true,
        });
        let eo = {};
        try { eo = JSON.parse((r2.result && r2.result.value) || '{}'); } catch (_) {}
        if (!eo.total) note('扩展管理页读不到内容（浏览器不允许脚本化内部页）');
        else {
          check('扩展管理页的错误列表为空', (eo.bad || []).length === 0, (eo.bad || []).join(' | '));
          console.log(`  [INFO] 扩展管理页读到 ${eo.total} 个文本节点，命中错误关键词 ${(eo.bad || []).length} 条`);
        }
        ec.close();
        try { await bc.send('Target.closeTarget', { targetId: et.targetId }); } catch (_) {}
        bc.close();
      }
    } catch (e) {
      note('读取扩展管理页失败：' + String((e && e.message) || e).slice(0, 80));
    }
  }

  // ---------- 总判定 ----------
  check('没有任何 CSP 内联脚本违规', cspHits.length === 0, cspHits.join(' | '));
  check('没有任何未捕获异常', exceptions.length === 0, exceptions.join(' | '));
} catch (e) {
  check('验证流程跑通', false, String((e && e.message) || e));
} finally {
  try { if (swCdp) swCdp.close(); } catch (_) {}
  if (child) { killTree(child.pid); await sleep(500); }
  if (davChild) { killTree(davChild.pid); }
  for (const dir of [profile, davRoot]) {
    if (path.basename(dir).startsWith('cc-')) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

console.log('====================================================');
console.log(JSON.stringify({ pass, fail, skipped: skip }));
console.log('====================================================');
