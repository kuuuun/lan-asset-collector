/*
 * 用 Node 加载「真实的」lib/util.js + lib/webdav.js，对本地 WebDAV 服务跑协议时序。
 * 验证的是将要打进扩展的那份代码，而不是重写版。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 只注入 vm 上下文里没有的宿主/Web API；Object/Array/Promise/Uint8Array 等
// 由 vm 自带，注入宿主的反而会造成原型不一致。
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
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['lib/util.js', 'lib/webdav.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const CC = sandbox.CC;

const BASE = 'http://127.0.0.1:8081/';
const cfg = { baseUrl: BASE, user: 'tester', pass: 's3cret', timeout: 20000 };

const png = new Uint8Array(fs.readFileSync(path.join(root, 'assets/icons/128.png')));
let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${extra ? ' → ' + extra : ''}`);
  }
}

console.log('── 1. 鉴权探测 ──');
const badUser = await CC.webdavProbe({ ...cfg, pass: 'wrong-password' }, { write: false });
check('错密码应被识别为鉴权失败', badUser.ok === false && /401|密码|账号/.test(badUser.error || ''), JSON.stringify(badUser));

const noUser = await CC.webdavProbe({ ...cfg, user: '' }, { write: false });
check('未填账号应给出明确提示', noUser.ok === false && /账号/.test(noUser.error || ''), JSON.stringify(noUser));

const badHost = await CC.webdavProbe({ ...cfg, baseUrl: 'http://127.0.0.1:9/nope' }, { write: false });
check('端口不对应报无法连接', badHost.ok === false, JSON.stringify(badHost));

const badPath = await CC.webdavProbe({ ...cfg, baseUrl: BASE + 'not-exist-dir' }, { write: false });
check('路径不存在应报 404 类提示', badPath.ok === false && /404|不存在/.test(badPath.error || ''), JSON.stringify(badPath));

const okProbe = await CC.webdavProbe(cfg, { write: true });
check('正常配置（含试写试删）应通过', okProbe.ok === true, JSON.stringify(okProbe));

console.log('\n── 2. 逐级建目录 + 写入 ──');
const r1 = await CC.webdavPut(cfg, '2026-10-10/143208-selftest-1.png', png, 'image/png', false);
check('首次写入应成功', r1.ok === true && r1.path === '2026-10-10/143208-selftest-1.png', JSON.stringify(r1));

const r2 = await CC.webdavPut(cfg, '设计素材/参考/网页截图-01.png', png, 'image/png', false);
check('中文+深层路径应自动建目录并成功', r2.ok === true, JSON.stringify(r2));

const r3 = await CC.webdavPut(cfg, '设计素材/参考/网页截图-01.png', png, 'image/png', false);
check('同名不覆盖应自动改名 -1', r3.ok === true && /-1\.png$/.test(r3.path || ''), JSON.stringify(r3));

const r4 = await CC.webdavPut(cfg, '设计素材/参考/网页截图-01.png', png, 'image/png', true);
check('显式 overwrite 应写回原名', r4.ok === true && r4.path === '设计素材/参考/网页截图-01.png', JSON.stringify(r4));

const r5 = await CC.webdavPut({ ...cfg, pass: 'wrong-password' }, 'x/y.png', png, 'image/png', false);
check('错密码写入应明确报鉴权失败', r5.ok === false && /鉴权|401|403/.test(r5.error || ''), JSON.stringify(r5));

console.log('\n── 3. 落盘校验（由容器外的脚本核对文件系统）──');
console.log(JSON.stringify({ pass, fail }));
process.exit(fail ? 1 : 0);
