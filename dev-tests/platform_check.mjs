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

// v1.5.8：Pinterest 原图换算。路径规则写错不会报错，只会静默拿到缩略图 —— 所以这里守着。
const PIN_THUMB = 'https://i.pinimg.com/236x/ab/cd/ef/abcdef1234.jpg';
check(
  'pinimgOriginal 把尺寸段换算成 originals',
  CC.pinimgOriginal(PIN_THUMB) === 'https://i.pinimg.com/originals/ab/cd/ef/abcdef1234.jpg',
  CC.pinimgOriginal(PIN_THUMB)
);
check(
  'pinimgOriginal 对 564x / 1200x / 74x 同样生效',
  ['564x', '1200x', '74x'].every(
    (s) => CC.pinimgOriginal(`https://i.pinimg.com/${s}/a/b/c/d.jpg`) === 'https://i.pinimg.com/originals/a/b/c/d.jpg'
  )
);
check(
  'pinimgOriginal 已是 originals 时幂等',
  CC.pinimgOriginal('https://i.pinimg.com/originals/a/b/c/d.jpg') === 'https://i.pinimg.com/originals/a/b/c/d.jpg'
);
check(
  'pinimgOriginal 对非 pinimg 域名 / 空值返回空串（可当判据用）',
  CC.pinimgOriginal('https://example.com/236x/a.jpg') === '' &&
    CC.pinimgOriginal('') === '' &&
    CC.pinimgOriginal('not-a-url') === ''
);
check(
  'pinimgOriginal 不被仿冒域名骗过（i.pinimg.com.evil.com）',
  CC.pinimgOriginal('https://i.pinimg.com.evil.com/236x/a/b/d.jpg') === ''
);

/* ---- v1.7.3：originals 不一定存在，中间要有一档可用的尺寸 ---- */
// 实测证据：i.pinimg.com/originals/bf/66/d8/bf66d848…jpg → 403 AccessDenied，
// 而同路径的 236x → 200（17.7 KB）。也就是「推出来的原图」经常根本不存在。
check(
  'pinimgSized 把缩略图尺寸段换成指定尺寸',
  CC.pinimgSized(PIN_THUMB, '736x') === 'https://i.pinimg.com/736x/ab/cd/ef/abcdef1234.jpg',
  CC.pinimgSized(PIN_THUMB, '736x')
);
check(
  'pinimgSized 对 originals / 带高度的尺寸段同样生效',
  CC.pinimgSized('https://i.pinimg.com/originals/a/b/c/d.jpg', '564x') ===
    'https://i.pinimg.com/564x/a/b/c/d.jpg' &&
    CC.pinimgSized('https://i.pinimg.com/236x148/a/b/c/d.jpg', '1200x') ===
      'https://i.pinimg.com/1200x/a/b/c/d.jpg'
);
check(
  'pinimgSized 拒绝非法尺寸、非 pinimg 域名、仿冒域名',
  CC.pinimgSized(PIN_THUMB, 'huge') === '' &&
    CC.pinimgSized(PIN_THUMB, '736') === '' &&
    CC.pinimgSized('https://example.com/236x/a.jpg', '736x') === '' &&
    CC.pinimgSized('https://i.pinimg.com.evil.com/236x/a/b/d.jpg', '736x') === ''
);
// 阶梯本身：单测只验函数，这里验后台真的把它用上了（否则函数是死的）
const bgSrcEarly = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const contentSrcEarly = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
check(
  'singleSave 在 originals 与页面缩略图之间插了尺寸阶梯',
  /for \(const size of \['1200x', '736x', '564x'\]\)/.test(bgSrcEarly) &&
    /CC\.pinimgSized\(payload\.url, size\)/.test(bgSrcEarly)
);
check(
  '降级时把「实际用的尺寸」带回给调用方（否则提示无法区分原图/缩略图）',
  /saved\.downgraded = used !== payload\.url/.test(bgSrcEarly) &&
    /saved\.sizeTag = m \? m\[1\] : ''/.test(bgSrcEarly)
);
check(
  '两条保存路径都会在降级时说明原因（Alt+右键 / Pinterest 镜像）',
  (contentSrcEarly.match(/原图缺失，存的是 /g) || []).length >= 2
);

/* ---- 上下文失效：刷新扩展后没 F5 的标签页，必须自述而不是伪装成「保存失败」 ---- */
check(
  '内容脚本先确认上下文还在，再发消息',
  /function runtimeAlive\(\)/.test(contentSrcEarly) &&
    /if \(!runtimeAlive\(\)\) return resolve/.test(contentSrcEarly)
);
check(
  '浏览器的英文 lastError 被翻成「下一步该做什么」',
  /function bgError\(/.test(contentSrcEarly) &&
    /MSG_STALE/.test(contentSrcEarly) &&
    /按 F5 刷新本页再试/.test(contentSrcEarly)
);
check(
  '后台无响应不再被当成「成功」（空回执也要走失败分支）',
  /res == null\) return resolve\(Object\.assign\(\{ ok: false \}/.test(contentSrcEarly)
);
check(
  '两条采集路径都用 stale 标记决定是否强制/加长提示',
  (contentSrcEarly.match(/res && res\.stale/g) || []).length >= 2
);
check(
  'single:save 的异常自己也写 lastError（done 的 catch 不写，异常会变成无处可查）',
  /'内部异常：'/.test(bgSrcEarly) && /recordLastError\('single:save', m/.test(bgSrcEarly)
);
const popupHtmlEarly = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
const popupJsEarly = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
check(
  '弹窗能发现「本页脚本是旧版」并直接指着 F5',
  /id="staleWarn"/.test(popupHtmlEarly) &&
    /function checkPageScript/.test(popupJsEarly) &&
    /cc:ping/.test(popupJsEarly)
);
check(
  '弹窗统计给出「上次成功 时间」——判断后台到底有没有收到请求',
  /上次成功 /.test(popupJsEarly)
);

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

// v1.5.8：Pinterest 这类「图片上盖透明 div」的站点，右键这条路走不通
// （浏览器自带的「图片另存为」和我们 contexts:['image'] 的菜单项都不出现）。
// 所以必须有一条不依赖右键的入口：弹窗按钮 → 后台 pin:collect → 内容脚本 pin:scan。
check(
  '弹窗提供 Pinterest 大图入口（#pinGrab）',
  /id="pinGrab"/.test(popupHtmlSrc) && /pin:collect/.test(popupJsSrc),
  'popup 里缺少 #pinGrab 或它没有发 pin:collect'
);
check(
  'background.js 暴露 collectPin（Pinterest 大图采集）',
  typeof bgSandbox.collectPin === 'function',
  '未找到 collectPin'
);
check(
  "后台有 pin:collect 消息分支",
  /case 'pin:collect'/.test(bgSource),
  'background.js 里没有 pin:collect 分支'
);

// v1.5.9：单图采集的「大图推断」与 fallbackUrl 退路。
// 站点普遍把缩略图放在 src、把大图藏在别处（Pinterest 的 src/srcset 全是 236x/474x/736x），
// 单图采集若直接用 img.src，采到的就是页面上那张小图 —— 必须走 bigSourceOf。
// 而推算出来的地址未必真的存在（从外站抓取来的 pin 没有 originals），所以要留 fallbackUrl 退路。
// （涉及 contentSrc 的断言在 C 段，那边才定义这个变量）
check(
  'singleSave 支持 fallbackUrl（首选抓失败就退回再抓）',
  /payload\.fallbackUrl/.test(bgSource) && /\(fetched && fetched\.error\)/.test(bgSource),
  'background.js 的 singleSave 没有处理 fallbackUrl'
);
check(
  '原生右键菜单项（cc-image）也做 pinimg 原图换算',
  /CC\.pinimgOriginal\(srcUrl\)/.test(bgSource),
  'cc-image 分支没有换算原图，右键采到的仍是缩略图'
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

// v1.5.8：图片上盖透明 div 的站点（Pinterest 是最典型的），右键落点不是 <img>。
// Alt+右键 必须能穿透覆盖层找到用户真正看到的那张图 —— 退回「只看 e.target 是不是 IMG」
// 就会在这类站点上静默失效（那正是 v1.5.7 及以前的实现）。
check(
  '内容脚本用 elementsFromPoint 穿透图片覆盖层',
  /document\.elementsFromPoint/.test(contentSrc),
  'content.js 不再穿透覆盖层，Alt+右键 在 Pinterest 上会失效'
);
// v1.5.9：单图采集要拿「大图」，不能直接用 src（站点把缩略图放 src、大图藏在别处）。
check(
  '内容脚本有 bigSourceOf（大图推断）',
  /function bigSourceOf\s*\(/.test(contentSrc),
  'content.js 里没有 bigSourceOf'
);
check(
  'Alt+右键 走大图推断，并把页面那张留作退路',
  /bigSourceOf\(img\)/.test(contentSrc) && /fallbackUrl:\s*alt/.test(contentSrc),
  'Alt+右键 仍直接使用 img.currentSrc/img.src —— 在 Pinterest 上采到的还是缩略图'
);
check(
  '内容脚本不再只认 e.target 是 <img>（旧 isCollectableImage 已移除）',
  !/isCollectableImage/.test(contentSrc),
  '仍存在 isCollectableImage —— 它只看 e.target，覆盖层场景会漏'
);
check(
  '内容脚本有 pin:scan 分支（Pinterest 大图扫描）',
  /case 'pin:scan'/.test(contentSrc),
  'content.js 里没有 pin:scan 分支'
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

/* ==========================================================================
 * F. v1.6.0：复制原图 / 素材工作台 / 反推提示词
 * ========================================================================== */

section('F. v1.6.0 新增能力（剪贴板 / 工作台 / ComfyUI）');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const bgSrc = read('background.js');
const comfySrc = read('lib/comfy.js');
const offSrc = read('offscreen.js');

check('manifest 版本与后台常量一致', manifest.version === (bgSrc.match(/const VERSION = '([^']+)'/) || [])[1], manifest.version);

// 剪贴板：MV3 里唯一稳定的路径是 offscreen + clipboardWrite，两者缺一不可
check('manifest 申请了 offscreen 权限', (manifest.permissions || []).includes('offscreen'), JSON.stringify(manifest.permissions));
check('manifest 申请了 clipboardWrite 权限', (manifest.permissions || []).includes('clipboardWrite'));
check(
  'minimum_chrome_version ≥ 109（offscreen API 下限）',
  Number(manifest.minimum_chrome_version) >= 109,
  manifest.minimum_chrome_version
);

const NEW_FILES = [
  'offscreen.html',
  'offscreen.js',
  'lib/comfy.js',
  'studio/studio.html',
  'studio/studio.css',
  'studio/studio.js'
];
const missing = NEW_FILES.filter((f) => !fs.existsSync(path.join(root, f)));
check('新增文件齐备', missing.length === 0, missing.join(', '));

check('offscreen 用 ClipboardItem 写图片', /ClipboardItem/.test(offSrc) && /navigator\.clipboard\.write/.test(offSrc));
check('offscreen 会转 PNG（webp/avif 在剪贴板里不稳）', /image\/png/.test(offSrc));
check('offscreen 只认 target=offscreen 的消息', /msg\.target\s*!==\s*'offscreen'/.test(offSrc));

// 后台如果把发给 offscreen 的消息当未知指令回执，剪贴板写入会收到错误答案
check('后台跳过 target=offscreen 的消息', /msg\.target\s*===\s*'offscreen'/.test(bgSrc));
check('后台有 copy:page 分支', /case 'copy:page'/.test(bgSrc));
check('后台有 lib:list 分支', /case 'lib:list'/.test(bgSrc));
check('后台有 comfy:reverse 分支', /case 'comfy:reverse'/.test(bgSrc));
check('复制走「大图推断」而不是直接拿 src', /cc:image:largest/.test(bgSrc) && /cc:image:largest/.test(read('content/content.js')));

// 列目录必须只列一层：递归会把大目录拖死
check('工作台只做 Depth:1 列目录', /Depth:\s*'1'/.test(read('lib/webdav.js')) && !/Depth:\s*'infinity'/i.test(read('lib/webdav.js')));
check('工作台不递归遍历', !/for\s*\(.*values\(\)[\s\S]{0,200}?listFsa\(/.test(read('studio/studio.js')));

// 反推：工作流用 ComfyUI 原生节点，sampling_mode 必须是字符串（传对象会报 missing argument）
check('反推工作流用 TextGenerate + PreviewAny', /'TextGenerate'/.test(comfySrc) && /'PreviewAny'/.test(comfySrc));
check('sampling_mode 以字符串传递', /sampling_mode:\s*'off'/.test(comfySrc));
check('反推指令是 Krea 2 的结构', /Krea 2 Turbo/.test(comfySrc) && /composition and camera/.test(comfySrc));
check('反推会剥掉模型的开场白', /cleanPromptText/.test(comfySrc));
check('页面拿得到队列状态（避免看起来卡死）', /comfyQueueInfo/.test(comfySrc) && /comfy:queue/.test(bgSrc));

/* ---- v1.6.1：ComfyUI 地址可以指向另一台机器（家里 MacBook 调单位电脑） ---- */

// 地址规范化的真实函数拿来跑一遍，而不是只看字符串
const comfySandboxFile = path.join(root, 'lib/comfy.js');
vm.runInContext(fs.readFileSync(comfySandboxFile, 'utf8'), sandbox, { filename: 'lib/comfy.js' });

check(
  '地址规范化：只填 IP 也补成完整 URL（http + 默认 8188）',
  CC.normalizeComfyUrl('172.18.23.232') === 'http://172.18.23.232:8188',
  CC.normalizeComfyUrl('172.18.23.232')
);
check(
  '地址规范化：保留显式端口与尾部路径（反代场景）',
  CC.normalizeComfyUrl('https://nas.local/comfy/') === 'https://nas.local/comfy',
  CC.normalizeComfyUrl('https://nas.local/comfy/')
);
check('地址规范化：空值与垃圾输入返回空串', CC.normalizeComfyUrl('   ') === '' && CC.normalizeComfyUrl('') === '');
check(
  '能区分本机与远程地址（决定给哪套排查建议）',
  CC.isLoopbackUrl('127.0.0.1:8188') && CC.isLoopbackUrl('localhost:8188') && !CC.isLoopbackUrl('172.18.23.232:8188')
);
check(
  '远程连不上时给出 --listen / 防火墙 / 隧道 三条',
  /--listen/.test(comfySrc) && /防火墙/.test(comfySrc) && /隧道/.test(comfySrc)
);

const storeSrc = read('lib/store.js');
check('设置里存得下常用位置', /profiles:\s*\[\]/.test(storeSrc) && /comfyProfiles/.test(read('options/options.html')));
check('设置里有「上传前压到长边」', /maxUploadSide/.test(storeSrc) && /id="comfyMaxSide"/.test(read('options/options.html')));
check(
  '反推上传前会按设置压缩（跨网省上行）',
  /maxUploadSide/.test(bgSrc) && /image:thumb/.test(bgSrc) && /quality: 0\.9/.test(bgSrc)
);
check('缩略图函数支持指定质量', /quality/.test(offSrc) && /toDataURL\('image\/jpeg', q\)/.test(offSrc));
check(
  '帮助页讲了「用另一台电脑的 ComfyUI」',
  /用另一台电脑的 ComfyUI/.test(read('help/help.html')) && /--listen 0\.0\.0\.0/.test(read('help/help.html'))
);
check('设置页加载了 comfy.js（规范化与判定要用）', /lib\/comfy\.js/.test(read('options/options.html')));

// 三个新页面同样禁止内联脚本
for (const page of ['studio/studio.html', 'offscreen.html']) {
  const html = read(page);
  check(`${page} 无内联 <script>`, !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
  check(`${page} 无 onclick=`, !/\son\w+\s*=/i.test(html));
}

/* ---- v1.6.5：ComfyUI 的 origin 校验会 403 掉扩展的上传 ---- */
{
  const manifest2 = JSON.parse(read('manifest.json'));
  check(
    '声明了 declarativeNetRequest（改写请求头要用）',
    (manifest2.permissions || []).includes('declarativeNetRequest'),
    JSON.stringify(manifest2.permissions)
  );
  check(
    '后台有改写规则的函数与固定 id',
    /async function ensureComfyDnr/.test(bgSrc) && /COMFY_DNR_ID = 9001/.test(bgSrc)
  );
  check(
    '只改 Origin 与 Sec-Fetch-Site 两个头',
    /header: 'Origin', operation: 'set'/.test(bgSrc) && /header: 'Sec-Fetch-Site', operation: 'set'/.test(bgSrc)
  );
  check(
    '规则只作用于 xmlhttprequest（不碰页面导航/子资源）',
    /resourceTypes: \['xmlhttprequest'\]/.test(bgSrc)
  );
  check(
    '只在地址是回环时才留规则，其它地址会撤掉',
    /CC\.isLoopbackUrl\(base\)/.test(bgSrc) && /removeRuleIds: \[COMFY_DNR_ID\]/.test(bgSrc)
  );
  check(
    '安装与启动时都对齐一次（session 规则关浏览器就没了）',
    (bgSrc.match(/refreshComfyDnr\(\)/g) || []).length >= 2
  );
  check('反推前会再对齐一次地址', /await ensureComfyDnr\(cfg\)/.test(bgSrc));
  check(
    '403 的报错说清了原因与两条出路',
    /HTTP 403/.test(comfySrc) && /--enable-cors-header/.test(comfySrc) && /局域网地址/.test(comfySrc)
  );
}

/* ---- v1.6.3：失败留痕（Alt+右键 静默 → 分级提示 → 能回看原文） ---- */
check(
  '内容脚本把失败原因写进 collector.lastError',
  /'collector\.lastError'/.test(contentSrc) && /function recordErr/.test(contentSrc)
);
check('Alt+右键的失败分支逐个留痕（不止一条）', (contentSrc.match(/recordErr\('alt:/g) || []).length >= 3);
check(
  '后台在 single:save 失败时也留痕（右键菜单与 Alt+右键 共用）',
  /function recordLastError/.test(bgSrc) && /recordLastError\('single:save'/.test(bgSrc)
);
check(
  '弹窗能显示上次失败原因（不必让用户复述五秒前的提示）',
  /id="lastErr"/.test(read('popup/popup.html')) && /showLastError/.test(read('popup/popup.js'))
);
check(
  '重载扩展后提示刷新页面（旧标签页脚本作废的典型症状）',
  /context invalidated/.test(contentSrc) && /刷新本页/.test(contentSrc)
);

// 打包白名单必须覆盖所有会被扩展加载的顶层条目
// （v1.6.0 首发时白名单漏了 offscreen.* 与 studio/ → zip 里少了 5 个文件，
//   而 manifest 只声明 background/popup/options，查不出来。这里先红。）
const pkgSrc = read('tools/package.py');
for (const entry of ['manifest.json', 'background.js', 'offscreen.html', 'offscreen.js',
                     'lib', 'content', 'popup', 'options', 'studio', 'help', 'assets']) {
  check(`打包白名单含 ${entry}`, new RegExp(`"${entry.replace(/\./g, '\\.')}"`).test(pkgSrc));
}
check('打包会抓「按路径加载」的漏项', /代码里按路径引用了未打进包的文件/.test(pkgSrc));

// 版本号五处一致（package.py 也查，这里先红，免得打包时才发现）
const VERSION_SPOTS = [
  ['manifest.json', /"version"\s*:\s*"([\d.]+)"/],
  ['background.js', /const VERSION = '([\d.]+)'/],
  ['popup/popup.html', /id="ver">v([\d.]+)</],
  ['studio/studio.html', /id="ver">v([\d.]+)</],
  ['content/content.js', /version:\s*'([\d.]+)'/],
  ['help/help.html', /版本 ([\d.]+) ·/]
];
const versions = VERSION_SPOTS.map(([f, re]) => {
  const m = read(f).match(re);
  return { f, v: m ? m[1] : '(未找到)' };
});
check('版本号五处一致', new Set(versions.map((x) => x.v)).size === 1, versions.map((x) => `${x.f}=${x.v}`).join(' · '));

/* ---- v1.7.0：在 Pinterest 点「保存」时顺手存一份到本地 ---- */
section('G. v1.7.0 Pinterest 保存镜像');

check(
  '能从地址认出 Pinterest 主域',
  CC.isPinterestUrl('https://www.pinterest.com/pin/123/') && CC.isPinterestUrl('https://pinterest.com/'),
  String(CC.isPinterestUrl('https://www.pinterest.com/pin/123/'))
);
check(
  '地区域名也认（co.uk / de / com.au / co.kr）',
  CC.isPinterestHost('pinterest.co.uk') &&
    CC.isPinterestHost('www.pinterest.de') &&
    CC.isPinterestHost('pinterest.com.au') &&
    CC.isPinterestHost('pinterest.co.kr')
);
check(
  '仿冒域名不算 Pinterest',
  !CC.isPinterestUrl('https://pinterest.com.evil.com/x') &&
    !CC.isPinterestUrl('https://notpinterest.com/') &&
    !CC.isPinterestUrl('https://evil.com/?u=pinterest.com')
);
check('空值与垃圾输入不抛异常', CC.isPinterestUrl('') === false && CC.isPinterestUrl('not a url') === false);

check(
  '认中英文保存按钮',
  CC.pinSaveLabel('保存') && CC.pinSaveLabel('保存到图板') && CC.pinSaveLabel('Save') && CC.pinSaveLabel('Save to board')
);
check(
  '已保存 / 取消 / 收藏夹 / Saved 一律不算',
  !CC.pinSaveLabel('已保存') && !CC.pinSaveLabel('取消保存') && !CC.pinSaveLabel('收藏夹') && !CC.pinSaveLabel('Saved')
);
check(
  '段落里的「保存」不当按钮（长度上限）',
  !CC.pinSaveLabel('这张图片的保存状态会随着你选择的图板而变化，请先在上方选择你要保存到的图板再来点保存按钮')
);

// 镜像代码块：既不打断 Pinterest 的保存，也不能自己重复触发
const mirrorSec = contentSrc.slice(
  contentSrc.indexOf('Pinterest「保存」镜像'),
  contentSrc.indexOf('消息处理')
);
check('内容脚本里有保存镜像的入口', mirrorSec.length > 500 && /lastPinMirror/.test(mirrorSec));
// 判断「有没有调用」，而不是「有没有提到」——镜像段的注释里正大光明写着这两句纪律
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check(
  '镜像绝不 preventDefault / stopPropagation',
  !/\.(?:preventDefault|stopPropagation)\s*\(/.test(stripComments(mirrorSec))
);
check('同一张图 2.5 秒内只镜像一次', /2500/.test(mirrorSec));
check('镜像复用 single:save（与 Alt+右键 同一条落盘链路）', /type: 'single:save'/.test(mirrorSec));
check('镜像取的是大图（走 bigSourceOf）', /bigSourceOf\(img\)/.test(mirrorSec));
check('只在 Pinterest 站点生效', /ON_PINTEREST/.test(mirrorSec) && /CC\.isPinterestUrl\(location\.href\)/.test(mirrorSec));

check('默认关闭（不擅自往 NAS 写）', /pinSaveMirror: false/.test(storeSrc), 'store.js 的默认值');
check('内容脚本的兜底设置也有这个开关', /pinSaveMirror: false/.test(contentSrc));
check(
  '设置页有开关并接线',
  /id="pinSaveMirror"/.test(read('options/options.html')) && /pinSaveMirror/.test(read('options/options.js'))
);

/* ---- v1.7.1：「点了保存没反应」必须能自己说清断在哪一步 ---- */
check(
  '诊断模式默认关闭，且设置页能开',
  /pinMirrorDebug: false/.test(storeSrc) &&
    /id="pinMirrorDebug"/.test(read('options/options.html')) &&
    /pinMirrorDebug/.test(read('options/options.js'))
);
check(
  '诊断会把落点上的元素摊开（不用让人去翻混淆的 DOM）',
  /function describePoint/.test(mirrorSec) && /elementsFromPoint/.test(mirrorSec) && /function nameOf/.test(mirrorSec)
);
check(
  '诊断覆盖三种断点：开关没开 / 没认出按钮 / 认出了找不到图',
  (mirrorSec.match(/if \(dbg\)/g) || []).length >= 3
);
check(
  '诊断提示不被「页内提示」开关挡住（否则排查时自己也看不见）',
  /function toast\(text, kind, ms, force\)/.test(contentSrc) && /!settings\.toastInPage && !force/.test(contentSrc)
);
check(
  '弹窗把镜像开关的真实存储值显示出来（先排除「根本没开」）',
  /pinSaveMirror/.test(read('popup/popup.js')) && /SETTINGS_KEY/.test(read('popup/popup.js'))
);
check(
  '域名判定只有一份实现（弹窗不再自己写正则）',
  !/const PIN_HOST/.test(read('popup/popup.js')) && /lib\/util\.js/.test(read('popup/popup.html'))
);

/* ---- v1.7.2：「保存目标未就绪」时状态条必须是一条去设置页的路 ---- */
// 配置被重置（移除扩展 / 换路径 / 清浏览器数据）后，表现是「保存一直失败但原因只有一行小字」。
// 这时点状态条如果还是只跑「测试连接」，用户会看到「连接失败」却不知道该填什么。
check(
  '未就绪时点状态条去设置页（而不是只报连接失败）',
  /let targetReady = null/.test(read('popup/popup.js')) &&
    /if \(targetReady === false\)[\s\S]{0,220}openOptionsPage\(\)/.test(read('popup/popup.js'))
);
check(
  '状态条在未就绪时改掉悬浮提示（否则仍写着「点击测试连接」）',
  /pillNow\.title = t\.ready \? '点击测试连接' : '点击去设置页填写保存位置'/.test(read('popup/popup.js'))
);
// 这条是给人看的：文档里必须明确「更新不要点移除」，否则下次还会丢配置
check(
  '说明文档写明「更新不要移除扩展」（移除会清空存储）',
  /不要点「移除」|不要用「移除」来更新版本/.test(read('README.md')) &&
    /不要用「移除」来更新版本/.test(read('help/help.html'))
);

/* ========================================================================== */

console.log(`\n${'='.repeat(52)}`);
console.log(JSON.stringify({ pass, fail }));
console.log(`${'='.repeat(52)}`);
process.exit(fail === 0 ? 0 : 1);
