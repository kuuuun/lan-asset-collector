/*
 * 跨平台（Windows / macOS / Linux）静态校验。
 *
 * 加载的是「将要打进扩展的那份」lib/util.js 与 background.js，而不是重写版，
 * 所以这里的断言失败就等于真实缺陷。
 *
 * 覆盖四件事：
 *   A. 生成的目录名 / 文件名是否同时满足三个系统的规则
 *   B. 右键菜单是否是「Billfish 式」的单张一键剪藏（只有一项、只在图片上出现）
 *   C. background.js 的「打开保存位置」提示是否按平台分流（曾经写死 Z:\）
 *   D. 仓库卫生：行尾、shebang、接收端残留、悬停采集残留、CSP、消息失败处理
 *   E. 图标：manifest 声明的每个尺寸都真实存在、能解码、边长对得上
 *
 * 运行： node dev-tests/platform_check.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ' → ' + extra : ''}`);
  }
}
function section(t) {
  console.log(`\n── ${t} ──`);
}

/* ==========================================================================
 * 三个系统的文件名规则，做成可执行的判据
 * ========================================================================== */

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 返回违规项数组；空数组 = 该名字在此系统上合法 */
function violationsWindows(name) {
  const v = [];
  if (!name) v.push('空名');
  if (/[<>:"/\\|?*]/.test(name)) v.push('含 Windows 非法字符');
  if (/[\u0000-\u001f]/.test(name)) v.push('含控制符');
  if (/[. ]$/.test(name)) v.push('以点或空格结尾');
  if (WIN_RESERVED.test(name.split('.')[0])) v.push('保留设备名');
  if (name !== '.' && name !== '..' && name.length > 255) v.push('超过 255 码元');
  return v;
}

function violationsUnix(name, { utf8 = true } = {}) {
  const v = [];
  if (!name) v.push('空名');
  if (name.includes('/')) v.push('含 /');
  if (name.includes('\u0000')) v.push('含 NUL');
  const size = utf8 ? Buffer.byteLength(name, 'utf8') : name.length;
  const limit = utf8 ? 255 : name.length;
  if (size > limit) v.push(`超过 ${limit} 字节（实际 ${size}）`);
  return v;
}

function violationsAll(name) {
  return [
    ...violationsWindows(name).map((x) => 'Windows: ' + x),
    ...violationsUnix(name, { utf8: true }).map((x) => 'macOS/Linux: ' + x),
  ];
}

/* ==========================================================================
 * A. 命名规则的平台合规性
 * ========================================================================== */

const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  URL,
  Blob,
  fetch: () => Promise.reject(new Error('no-network-in-test')),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  AbortController,
  setTimeout,
  clearTimeout,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(root, 'lib/util.js'), 'utf8'), sandbox, { filename: 'lib/util.js' });

const CC = sandbox.CC;
section('A. 命名规则的平台合规性');
check('lib/util.js 已暴露字节预算常量', typeof CC.MAX_SEG_BYTES === 'number' && CC.MAX_SEG_BYTES > 0, CC.MAX_SEG_BYTES);

const SEG_FIXTURES = [
  ['普通中文标题', '设计参考图'],
  ['英文标题', 'kitchen island detail'],
  ['含 Windows 非法字符', 'a<b>c:d"e|f?g*h'],
  ['含路径穿越', '../../windows/system32/pwn'],
  ['含正反斜杠', 'a\\b/c'],
  ['前后空白与点', '   ..leading and trailing...   '],
  ['空串', ''],
  ['纯符号', '///:::\\\\'],
  ['保留名 CON', 'CON'],
  ['保留名带扩展名', 'con.png'],
  ['保留名 NUL.', 'NUL.'],
  ['保留名 AUX.txt', 'AUX.txt'],
  ['保留名 COM7', 'com7'],
  ['C1 控制符', 'a\u0085b'],
  ['零宽不换行空格', 'a\uFEFFb'],
  ['全角字符需 NFKC', 'ＡＢＣ１２３'],
  ['超长中文（300 字）', '中文测试标题'.repeat(50)],
  ['超长英文（300 字）', 'abcdefghij'.repeat(30)],
  ['emoji（4 字节码点）', '🎉'.repeat(80)],
  ['组合字符', 'e\u0301'.repeat(100)],
  ['尾部空格', 'name   '],
  ['尾部点', 'name...'],
];

for (const [label, raw] of SEG_FIXTURES) {
  const seg = CC.cleanSeg(raw, 80);
  const bad = violationsAll(seg);
  check(`cleanSeg「${label}」三平台合法`, bad.length === 0, `${JSON.stringify(seg)} → ${bad.join('; ')}`);
}

// cleanBase 走的是 90 字符预算（saver.js 的调用点），这条曾经会产出 270 字节的中文名
const LONG_CN = '中文测试标题'.repeat(30);
const base = CC.cleanBase(LONG_CN, 90);
check(
  'cleanBase 90 字符预算下中文名不超 200 字节',
  Buffer.byteLength(base, 'utf8') <= CC.MAX_SEG_BYTES,
  `${Buffer.byteLength(base, 'utf8')} 字节`
);
check('cleanBase 结果同样三平台合法', violationsAll(base).length === 0, violationsAll(base).join('; '));

// 真实落盘路径：目录模板 + 文件名模板
const dirRel = CC.sanitizeRelPath('2026-10-10/中文目录名');
check('sanitizeRelPath 保持相对且只用 /', dirRel.split('/').every((s) => violationsAll(s).length === 0), dirRel);
check('sanitizeRelPath 剥掉盘符', !/^[a-zA-Z]:/.test(CC.sanitizeRelPath('C:\\Users\\x\\evil')), CC.sanitizeRelPath('C:\\Users\\x\\evil'));
check('sanitizeRelPath 压掉 ..', !CC.sanitizeRelPath('../../etc/passwd').split('/').includes('..'), CC.sanitizeRelPath('../../etc/passwd'));

// v1.5.4：「子目录模板留空 = 不建子目录」。这里曾经有个真 bug —— 空段走了 cleanSeg 的
// untitled 兜底，于是清空模板不会让文件落在目标目录，而是凭空多出一个 untitled/ 文件夹。
check('子目录模板留空 → 相对目录为空串（不建子目录）', CC.sanitizeRelPath('') === '', JSON.stringify(CC.sanitizeRelPath('')));
check('子目录模板只有空白 → 同样为空串', CC.sanitizeRelPath('   ') === '', JSON.stringify(CC.sanitizeRelPath('   ')));
check('子目录模板尾部带斜杠 → 不会多出 untitled 层', CC.sanitizeRelPath('2026-10-10/') === '2026-10-10', JSON.stringify(CC.sanitizeRelPath('2026-10-10/')));
check('子目录模板只有分隔符 → 为空串', CC.sanitizeRelPath('///') === '', JSON.stringify(CC.sanitizeRelPath('///')));
check('多级目录照常拼接（2026-10-10/中文目录名）', CC.sanitizeRelPath('2026-10-10/中文目录名') === '2026-10-10/中文目录名', JSON.stringify(CC.sanitizeRelPath('2026-10-10/中文目录名')));
check('文件名兜底不受影响（cleanBase 仍给 untitled）', CC.cleanBase('***', 80) === 'untitled', CC.cleanBase('***', 80));

// 字节截断不能切开多字节字符（截断后重新编码应当无损）
const emojiSeg = CC.cleanSeg('🎉'.repeat(80), 80);
check('多字节截断不产生替换字符 U+FFFD', !emojiSeg.includes('\uFFFD'), emojiSeg);

// 幂等性：清洗过的名字再清洗一次不应变形（GET /files/ 会二次清洗）
let nonIdempotent = [];
for (const [, raw] of SEG_FIXTURES) {
  const once = CC.cleanSeg(raw, 80);
  const twice = CC.cleanSeg(once, 80);
  if (once !== twice) nonIdempotent.push(`${JSON.stringify(once)} → ${JSON.stringify(twice)}`);
}
check('cleanSeg 幂等', nonIdempotent.length === 0, nonIdempotent.join(' | '));

/* ==========================================================================
 * B. background.js 的平台分流
 * ========================================================================== */

section('B. background.js 的平台分流');

let osToReport = 'mac';
/** 记录 buildMenus() 注册了哪些菜单项，供 C 段做形态断言 */
const createdMenus = [];
const chromeStub = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
    onConnect: { addListener() {} },
    getPlatformInfo: (cb) => cb({ os: osToReport, arch: 'x86-64' }),
    getURL: (p) => 'chrome-extension://test/' + p,
    openOptionsPage() {},
    lastError: null,
  },
  contextMenus: {
    removeAll: (cb) => cb && cb(),
    create: (o, cb) => {
      createdMenus.push(o);
      if (cb) cb();
    },
    // v1.5.7：注册改成了「先 create，已存在就 update」的单步写法，
    // stub 必须提供 update，否则沙箱里走到这条分支会直接抛错
    update: (id, o, cb) => {
      const hit = createdMenus.find((m) => m.id === id);
      if (hit) Object.assign(hit, o);
      if (cb) cb();
    },
    onClicked: { addListener() {} },
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  notifications: { create() {} },
  tabs: {
    create() {},
    query: () => {},
    sendMessage() {},
    captureVisibleTab: () => {},
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    // v1.5.4 切标签页 / v1.5.7 切换窗口：兜底唤醒，见 C 段断言
    onActivated: { addListener() {} },
  },
  commands: { onCommand: { addListener() {} } },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
    onChanged: { addListener() {} },
  },
  scripting: { executeScript: async () => [], insertCSS: async () => {} },
  windows: { getCurrent: () => {}, onFocusChanged: { addListener() {} } },
};

const bgSandbox = {
  // log 静音：扩展在每次 worker 启动时会打一条菜单注册日志，透传会把测试输出弄花
  console: { log() {}, info() {}, warn: console.warn, error: console.error },
  TextEncoder,
  TextDecoder,
  URL,
  Blob,
  fetch: () => Promise.reject(new Error('no-network-in-test')),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  AbortController,
  setTimeout,
  clearTimeout,
  chrome: chromeStub,
  importScripts: () => {},
};
bgSandbox.self = bgSandbox;
bgSandbox.globalThis = bgSandbox;
vm.createContext(bgSandbox);

for (const f of ['lib/util.js', 'lib/store.js', 'lib/webdav.js', 'lib/saver.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), bgSandbox, { filename: f });
}
let bgLoaded = true;
try {
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), bgSandbox, { filename: 'background.js' });
} catch (e) {
  bgLoaded = false;
  check('background.js 可在最小 chrome stub 下装载', false, String(e.message).split('\n')[0]);
}
if (bgLoaded) {
  check('background.js 可在最小 chrome stub 下装载', true);
}

const hint = typeof bgSandbox.nasLocalHint === 'function' ? bgSandbox.nasLocalHint : null;
check('background.js 暴露 nasLocalHint', typeof hint === 'function');

if (hint) {
  const BASE = 'http://192.168.31.206:5005/Works/PicStorage/clips';
  const mac = hint('mac', BASE);
  const win = hint('win', BASE);
  const linux = hint('linux', BASE);

  check('macOS 提示给出 /Volumes 挂载点', mac.includes('/Volumes/Works'), mac);
  check('macOS 提示不含 Windows 盘符 Z:', !/Z:\\/.test(mac), mac);
  check('macOS 提示含访达', mac.includes('访达'), mac);

  check('Windows 提示给出映射盘符下的相对路径', /PicStorage\\clips/.test(win), win);
  check('Windows 提示含 UNC', win.includes('\\\\192.168.31.206\\Works'), win);
  check('Windows 提示不含 /Volumes', !win.includes('/Volumes'), win);

  check('Linux 提示给出 /mnt 挂载点', linux.includes('/mnt/'), linux);
  check('Linux 提示不含 Windows 盘符', !/Z:\\/.test(linux), linux);

  check('主机名从 baseUrl 推导而非硬编码', hint('mac', 'http://nas.local:5005/a/b').includes('nas.local'), hint('mac', 'http://nas.local:5005/a/b'));
  check('共享名从 baseUrl 推导而非硬编码', hint('mac', 'http://nas.local:5005/Photo/2026').includes('/Volumes/Photo/2026'), hint('mac', 'http://nas.local:5005/Photo/2026'));
  check('baseUrl 非法时降级不抛异常', typeof hint('mac', 'not-a-url') === 'string', hint('mac', 'not-a-url'));

  const fm = bgSandbox.fileManagerName;
  check('fileManagerName 分平台', fm('mac') === '访达' && fm('win') === '资源管理器' && fm('linux') === '文件管理器', [fm('mac'), fm('win'), fm('linux')].join('/'));
}

// source 级检查：lib/ 里不应再出现写死的宿主绝对路径
const SHOULD_NOT_APPEAR = [
  { re: /Z:\\PicStorage/, file: 'lib/', why: '写死的 Windows 盘符' },
  { re: /\/Volumes\//, file: 'lib/', why: '写死的 macOS 挂载点' },
  { re: /[A-Za-z]:\\\\Users\\\\/, file: 'lib/', why: '写死的 Windows 用户目录' },
];
for (const { re, file, why } of SHOULD_NOT_APPEAR) {
  const hits = fs
    .readdirSync(path.join(root, file))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => re.test(fs.readFileSync(path.join(root, file, f), 'utf8')));
  check(`${file}*.js 无${why}`, hits.length === 0, hits.join(', '));
}

/* ==========================================================================
 * C. 右键菜单形态（Billfish 式单张一键剪藏）
 * ========================================================================== */

section('C. 右键菜单形态');

// 关键回归（v1.5.1）：菜单必须在 service worker 的**顶层**就注册好。
// 之前只挂在 onInstalled / onStartup 里，而「扩展管理页点刷新」这两条事件
// 都不会触发，右键菜单就一直停在旧标题上 —— 表现就是「右键没有变化」。
check(
  `service worker 启动即自动注册菜单（实际 ${createdMenus.length} 项）`,
  createdMenus.length === 1,
  createdMenus.length === 0 ? '顶层没有调用 buildMenus()，刷新扩展不会更新菜单' : createdMenus.map((m) => m.id).join(', ')
);

if (typeof bgSandbox.buildMenus === 'function') {
  createdMenus.length = 0;
  bgSandbox.buildMenus();
  // Chromium 会把同一扩展的「多个顶层菜单项」自动折叠成一个「扩展名 ›」二级菜单，
  // 那样一键剪藏就变成两次点击了 —— 所以这里必须恰好只有 1 项。
  check(`右键菜单只注册 1 项（实际 ${createdMenus.length} 项）`, createdMenus.length === 1, createdMenus.map((m) => m.id).join(', '));
  const m = createdMenus[0] || {};
  check('菜单项为顶层（无 parentId，不会被折叠成二级菜单）', !m.parentId, String(m.parentId));
  check("菜单项只在图片上下文出现", Array.isArray(m.contexts) && m.contexts.length === 1 && m.contexts[0] === 'image', JSON.stringify(m.contexts));
  check('菜单项标题与名称一致', m.title === '将图片保存至 LAN Collector', String(m.title));
} else {
  check('background.js 暴露 buildMenus', false, '未找到 buildMenus');
}

// 关键回归（v1.5.4）：Chromium 在「扩展集合变化」时（安装/卸载/禁用任意一个扩展，
// 例如用户删掉 Billfish 采集扩展）会重建整张右键菜单 —— 重建那一刻本扩展后台若在休眠，
// 我们这一项就缺席，而顶层 buildMenus() 只会在后台被唤醒时才重跑。所以必须挂一个高频且
// 无副作用的唤醒时机（切标签页）来兜底，否则「删掉别的插件后右键项消失」会再发生。
const bgSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
check(
  '已挂 tabs.onActivated 兜底（切标签页即唤醒后台重建菜单）',
  /chrome\.tabs\.onActivated\.addListener\s*\(/.test(bgSource),
  'background.js 里没有 tabs.onActivated 监听器'
);

// 关键回归（v1.5.7）：菜单注册必须是**单步**的。
// 原来写的是 removeAll + 回调里 create，那是「先清空、再重建」两步 —— removeAll 发出之后
// 若后台脚本刚好被回收，菜单就被清空而新的没建上，表现正是「右键里没有这一项了」。
// 改成「先 create，已存在就 update」之后，任何时刻菜单都是完整的。
// 注意用调用形式 `.removeAll(` 匹配，源码注释里正当地提到过这个 API 名字。
check(
  '菜单注册是单步的（不再先清空再重建）',
  !/contextMenus\s*\.\s*removeAll\s*\(/.test(bgSource),
  'background.js 仍在调用 contextMenus.removeAll —— 这一步会造成「清空了但没建上」的空档'
);
check(
  '改标题走 update 而不是删除重建',
  /contextMenus\s*\.\s*update\s*\(/.test(bgSource),
  'background.js 里没有 contextMenus.update'
);

// 关键回归（v1.5.7）：切窗口也补一次菜单 —— 与切标签页同一目的，多一个零成本的唤醒时机
check(
  '已挂 windows.onFocusChanged 兜底（切换窗口即唤醒后台重建菜单）',
  /chrome\.windows\.onFocusChanged\.addListener\s*\(/.test(bgSource),
  'background.js 里没有 windows.onFocusChanged 监听器'
);

// 「右键里没有这一项」是使用者最难自证的一类问题 —— 菜单由浏览器进程持有，
// 页面里看不见、扩展也查不到。所以必须有一个可见的诊断入口：弹窗显示注册结果 +
// 一键重新注册（点一下就补回来，不用跑去扩展管理页点刷新）。
const popupHtmlSrc = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
const popupJsSrc = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
check(
  '弹窗提供右键菜单状态行与重新注册按钮',
  /id="menuBar"/.test(popupHtmlSrc) && /id="menuFix"/.test(popupHtmlSrc) && /refreshMenuState/.test(popupJsSrc),
  'popup 里缺少菜单状态行 / 重新注册按钮 / refreshMenuState'
);
check(
  "后台有 menu:status 分支（弹窗打开即重注册一次）",
  /case 'menu:status'/.test(bgSource),
  'background.js 里没有 menu:status 分支'
);

if (typeof bgSandbox.fetchForClip === 'function') {
  // 沙箱里的 fetch 会直接 reject：能成功就说明根本没走网络
  const r = await bgSandbox.fetchForClip(null, 'data:image/png;base64,iVBORw0KGgo=');
  check('data: 图片直接解码，不依赖网络', !!(r && r.ok && r.bytes && r.bytes.length), JSON.stringify(r && (r.error || r.mime)));
  const r2 = await bgSandbox.fetchForClip(null, '');
  check('空图片地址给出明确错误而不是抛异常', !!(r2 && !r2.ok && r2.error), JSON.stringify(r2));
} else {
  check('background.js 暴露 fetchForClip', false, '未找到 fetchForClip');
}

/* ==========================================================================
 * D. 仓库卫生
 * ========================================================================== */

section('D. 仓库卫生');

// `.workbuddy` 是 agent 的项目记忆（metadata），不是交付内容 —— package.py 的
// EXCLUDE_DIRS 同样排除它。不跳过会让「行尾/残留」这类针对交付物的断言去管本机笔记。
const SKIP_DIRS = new Set(['dev-tests', 'node_modules', '.git', '.workbuddy']);
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.css', '.html', '.md', '.py', '.sh', '.command', '.bat', '.txt', '.yml', '.yaml']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(root).filter((p) => TEXT_EXT.has(path.extname(p).toLowerCase()));

const crlfWrong = [];
const noShebang = [];
for (const p of files) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  const raw = fs.readFileSync(p);
  const isBat = path.extname(p).toLowerCase() === '.bat';
  const crlf = raw.includes(Buffer.from('\r\n'));
  // .bat 必须 CRLF（缺了会在老 cmd 上出问题）；其余文本文件必须 LF
  if (isBat && !crlf) crlfWrong.push(`${rel} 应为 CRLF 却是 LF`);
  if (!isBat && crlf) crlfWrong.push(`${rel} 应为 LF 却含 CRLF`);
  const ext = path.extname(p).toLowerCase();
  if (['.sh', '.command'].includes(ext)) {
    if (!raw.toString('utf8').startsWith('#!')) noShebang.push(rel);
  }
}
check(`行尾符合平台约定（${files.length} 个文本文件）`, crlfWrong.length === 0, crlfWrong.join(' | '));
check('.sh/.command 均带 shebang', noShebang.length === 0, noShebang.join(', '));

// 接收端（v1.4.0 已下线）不得再出现在交付物里
const residue = [];
for (const p of files) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  if (/collector_receiver|127\.0\.0\.1:8899|run-receiver/.test(fs.readFileSync(p, 'utf8'))) residue.push(rel);
}
check('接收端残留引用已清空', residue.length === 0, residue.join(', '));
check('receiver/ 目录已移除', !fs.existsSync(path.join(root, 'receiver')));

// 悬停采集（v1.5.5 按 K 的要求整条下线）：代码与页面里不得再留下任何残骸。
// 说明：`.md` 跳过 —— README 的变更记录里会提到这些旧名字，属于历史说明而非残留。
const hoverResidue = [];
const HOVER_PAT = /ccx-hover-btn|hoverButton|placeHoverBtn|hideHoverBtn|ensureHoverBtn|hoverImg|syncHover/;
for (const p of files) {
  if (path.extname(p).toLowerCase() === '.md') continue;
  if (HOVER_PAT.test(fs.readFileSync(p, 'utf8'))) {
    hoverResidue.push(path.relative(root, p).split(path.sep).join('/'));
  }
}
check('悬停采集残骸已清空（v1.5.5 起删除该功能）', hoverResidue.length === 0, hoverResidue.join(', '));

const contentSrc = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
check(
  '内容脚本不再监听 mouseover / mouseout / scroll（悬停按钮的触发源）',
  !/addEventListener\(\s*'mouseover'/.test(contentSrc) && !/addEventListener\(\s*'mouseout'/.test(contentSrc),
  '仍存在悬停相关监听器 —— 它会在每个含图片的页面上常驻'
);

// MV3 的默认 CSP 是 script-src 'self'：页面里的**内联 <script>** 与 onclick="…" 这类
// 内联事件属性都会被拦掉，并在扩展管理页的「错误」里留下一行红字（对使用者来说
// 那看起来就像扩展坏了，即使功能本身正常）。help/help.html 曾经就有一小段内联脚本，
// 只在「安装后自动打开帮助页」时触发，所以潜伏了很久才被发现 —— 这里当闸门守着。
// （内联的 <style> 与 style="" 不受影响：MV3 默认策略不限制 style-src。）
const cspBad = [];
const missingRefs = [];
for (const p of files.filter((f) => path.extname(f).toLowerCase() === '.html')) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  const html = fs.readFileSync(p, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const body = (m[2] || '').trim();
    if (!/\bsrc\s*=/.test(attrs) && body) cspBad.push(`${rel} 有内联 <script>：${body.slice(0, 40)}`);
  }
  const inlineAttr = html.match(/\son(?:click|load|error|change|input|submit|mouse\w+|focus|blur|key\w+)\s*=/i);
  if (inlineAttr) cspBad.push(`${rel} 有内联事件属性 ${inlineAttr[0].trim()}`);
  const srcRe = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;
  let s;
  while ((s = srcRe.exec(html))) {
    const ref = s[1];
    if (/^(https?:)?\/\//.test(ref)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(p), ref))) missingRefs.push(`${rel} → ${ref}`);
  }
}
check("页面无内联 <script> / 内联事件属性（MV3 CSP: script-src 'self'）", cspBad.length === 0, cspBad.join(' | '));
check('页面 <script src> 引用的文件都存在', missingRefs.length === 0, missingRefs.join(', '));

// 跨上下文消息：Promise 形式的 sendMessage 必须带 .catch，回调形式则要自己处理 lastError。
// 漏了的话，后台被回收 / 消息没接上时会以「Uncaught (in promise)」的形式写进
// 扩展管理页的错误列表 —— 使用者只会看到一个红字，以为插件坏了。
const msgRisk = [];
for (const p of files.filter((f) => path.extname(f).toLowerCase() === '.js')) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    const k = line.indexOf('chrome.runtime.sendMessage(');
    if (k < 0) return;
    const tail = line.slice(k);
    if (/\.catch\s*\(/.test(tail)) return; // Promise 形式 + catch
    if (/,\s*(\(|function|async)/.test(tail)) return; // 回调形式
    msgRisk.push(`${rel}:${i + 1} ${line.trim().slice(0, 60)}`);
  });
}
check('sendMessage 调用都处理了失败（.catch 或回调）', msgRisk.length === 0, msgRisk.join(' | '));

// 凡是「Promise 形式」的 chrome.* 调用，都必须有人接住失败：await / .catch / 回调，
// 或者本项目的 silent()（后台）与 fire()（页面）。漏接就是一条「Uncaught (in promise)」红字 ——
// 而且 try/catch 抓不住它，这是最容易骗过自查的一类漏网。
// 白名单只列「确定会返回 Promise」的 API，避免误报。
const PROMISE_APIS =
  /chrome\.(tabs\.create|tabs\.query|tabs\.sendMessage|tabs\.captureVisibleTab|runtime\.openOptionsPage|notifications\.create|action\.setBadgeText|action\.setBadgeBackgroundColor|action\.setTitle|scripting\.\w+|storage\.\w+|contextMenus\.removeAll|contextMenus\.update|windows\.getCurrent)\s*\(/;
const pageApiRisk = [];
for (const p of files) {
  if (path.extname(p).toLowerCase() !== '.js') continue;
  const rel = path.relative(root, p).split(path.sep).join('/');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(PROMISE_APIS);
    if (!m) return;
    const tail = line.slice(m.index);
    if (/\.catch\s*\(/.test(tail)) return; // 自己接住了
    const args = tail.slice(m[0].length);
    if (/(=>|function)/.test(args) || /,\s*(\(|function|async)/.test(tail)) return; // 回调形式
    const before = line.slice(0, m.index);
    // 同一行前缀：await / silent( / fire(
    if (/await\s+$/.test(before) || /(?:silent|fire)\(\s*$/.test(before)) return;
    // 上一行结尾：silent( / fire(（包一层的写法会跨行）
    const prev = i > 0 ? lines[i - 1].trim() : '';
    if (/(?:silent|fire)\(\s*$/.test(prev)) return;
    pageApiRisk.push(`${rel}:${i + 1} ${line.trim().slice(0, 64)}`);
  });
}
check('chrome.* 的 Promise 调用都接住了失败（await / .catch / silent / 回调）', pageApiRisk.length === 0, pageApiRisk.join(' | '));

// 兜底网：页面与 service worker 都必须装 unhandledrejection / error 监听 ——
// 万一还有漏网的，只写进控制台（console.warn），不在扩展管理页冒红字
const netMissing = [];
for (const rel of ['background.js', 'popup/popup.js', 'options/options.js']) {
  const src2 = fs.readFileSync(path.join(root, rel), 'utf8');
  if (!/addEventListener\(\s*'unhandledrejection'/.test(src2) || !/addEventListener\(\s*'error'/.test(src2)) {
    netMissing.push(rel);
  }
}
check('后台与页面都装了未处理异常的兜底网', netMissing.length === 0, netMissing.join(', '));

/* ==========================================================================
 * E. 图标
 *
 * 右键菜单里那一项前面显示的图标就是扩展图标本身（contextMenus API 不支持
 * 自定义菜单项图标），所以「图标是不是好的」直接决定菜单长什么样。
 * ========================================================================== */

section('E. 图标');

/** 就地解一个 8bit RGBA 的 PNG。自己写解码是为了不引第三方依赖。 */
function decodePng(buf) {
  if (buf.subarray(0, 8).toString('latin1') !== '\u0089PNG\r\n\u001a\n') return null;
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let color = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const tag = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (tag === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
    } else if (tag === 'IDAT') {
      idat.push(data);
    } else if (tag === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || color !== 6 || !w || !h) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  const zero = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : zero;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
  }
  return { w, h, px: out };
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const iconDecl = manifest.icons || {};
const actionIcon = (manifest.action || {}).default_icon || {};

check(
  '扩展图标与工具栏图标声明的尺寸一致',
  JSON.stringify(Object.keys(iconDecl).sort()) === JSON.stringify(Object.keys(actionIcon).sort()) && Object.keys(iconDecl).length > 0,
  `icons=${JSON.stringify(Object.keys(iconDecl))} action=${JSON.stringify(Object.keys(actionIcon))}`
);

const decoded = {};
const bad = [];
for (const [size, rel] of Object.entries(iconDecl)) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    bad.push(`${rel} 不存在`);
    continue;
  }
  const img = decodePng(fs.readFileSync(abs));
  if (!img) {
    bad.push(`${rel} 不是可解码的 8bit RGBA PNG`);
    continue;
  }
  if (img.w !== Number(size) || img.h !== Number(size)) {
    bad.push(`${rel} 实际 ${img.w}x${img.h}，声明为 ${size}`);
    continue;
  }
  decoded[size] = img;
}
check(`声明的 ${Object.keys(iconDecl).length} 个图标都能解码且边长正确`, bad.length === 0, bad.join(' | '));

if (decoded['128']) {
  const px = decoded['128'].px;
  let white = 0;
  let opaque = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 200) {
      opaque++;
      if (px[i] > 245 && px[i + 1] > 245 && px[i + 2] > 245) white++;
    }
  }
  check('128 图标不是空图（含白色图形）', white > 200, `白色像素 ${white} / 不透明 ${opaque}`);
  check('128 图标四角透明（圆角被切掉）', px[3] === 0 && px[(127 * 128 + 127) * 4 + 3] === 0, `alpha00=${px[3]} alpha11=${px[(127 * 128 + 127) * 4 + 3]}`);
}

if (decoded['32'] && decoded['128']) {
  // 小尺寸是单独渲染的：放粗笔画、并省掉卡片内部的山与太阳。
  // 取绘制坐标系里同一个点 (0.60, 0.70) —— 128 上它落在山里（镂空，非白），
  // 32 上应该还是一张实心白卡。
  const at = (img, u, v) => {
    const x = Math.floor(u * img.w);
    const y = Math.floor(v * img.h);
    const o = (y * img.w + x) * 4;
    return [img.px[o], img.px[o + 1], img.px[o + 2], img.px[o + 3]];
  };
  const isWhite = (c) => c[0] > 230 && c[1] > 230 && c[2] > 230 && c[3] > 200;
  const big = at(decoded['128'], 0.6, 0.7);
  const small = at(decoded['32'], 0.6, 0.7);
  check('128 图标卡片内部有镂空的山（非纯白）', !isWhite(big), JSON.stringify(big));
  check('32 图标卡片内部为实心白（小尺寸省略细节）', isWhite(small), JSON.stringify(small));

  const a = fs.readFileSync(path.join(root, iconDecl['16']));
  const b = fs.readFileSync(path.join(root, iconDecl['128']));
  check('16 与 128 是分别渲染的（不是同一份文件）', !a.equals(b));
}

// 图标生成脚本必须是无第三方依赖的纯标准库实现
const iconGen = fs.readFileSync(path.join(root, 'tools/make_icons.py'), 'utf8');
check('tools/make_icons.py 不依赖 Pillow', !/^\s*import\s+PIL|from\s+PIL/m.test(iconGen));
check('tools/make_icons.py 逐个生成 manifest 声明的所有尺寸', Object.keys(iconDecl).every((s) => new RegExp(`\\b${s}\\b`).test(iconGen)), Object.keys(iconDecl).join(','));

/* ========================================================================== */

console.log(`\n${'='.repeat(52)}`);
console.log(JSON.stringify({ pass, fail }));
console.log(`${'='.repeat(52)}`);
process.exit(fail === 0 ? 0 : 1);
