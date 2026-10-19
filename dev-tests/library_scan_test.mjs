/*
 * 素材工作台「列目录」的协议层验证。
 *
 * 用真实的 lib/webdav.js 打本地 WebDAV 服务（dev-tests/dav_server.py），确认：
 *   - Depth:1 只列当前一层，不递归
 *   - 中文名能正确解码（群晖会给百分号编码）
 *   - href 能拼回绝对地址（缩略图与反推都要用它）
 *   - 带鉴权取字节的往返无损
 *   - 目录不存在时给的是人话，不是一个空列表
 *
 * 跑法（服务端必须与测试在同一条命令里起，否则进程被回收 → 假 fetch failed）：
 *   python dev-tests/dav_server.py <davroot> 8081 tester s3cret &
 *   node dev-tests/library_scan_test.mjs
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

for (const f of ['lib/util.js', 'lib/webdav.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const CC = sandbox.CC;

const cfg = {
  baseUrl: 'http://127.0.0.1:' + (process.env.DAV_PORT || 8081) + '/clips',
  user: 'tester',
  pass: 's3cret',
  timeout: 20000
};
const png = new Uint8Array(fs.readFileSync(path.join(root, 'assets/icons/128.png')));

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

const put1 = await CC.webdavPut(cfg, '2026-10-19/aaa.png', png, 'image/png');
const put2 = await CC.webdavPut(cfg, '2026-10-19/中文名字.png', png, 'image/png');
check('能写入测试文件', put1.ok && put2.ok, put1.error || put2.error);

const top = await CC.webdavList(cfg, '');
const topEntries = top.ok ? top.entries : [];
check('顶层只列出那一层（1 个子目录）', topEntries.length === 1, top.error);
check('子目录被识别为目录', !!topEntries[0] && topEntries[0].isDir && topEntries[0].name === '2026-10-19');
check('不递归：顶层不出现子目录里的文件', !topEntries.some((e) => e.name === 'aaa.png'));

const sub = await CC.webdavList(cfg, '2026-10-19');
const files = sub.ok ? sub.entries.filter((e) => !e.isDir) : [];
check('子目录列出 2 张图', files.length === 2, sub.error);
check('中文文件名正确解码', files.some((e) => e.name === '中文名字.png'));
check('每条都带可用的绝对地址', files.length > 0 && files.every((e) => /^http:\/\/127\.0\.0\.1:\d+\//.test(String(e.url))));
check('文件大小有值', files.length > 0 && files.every((e) => e.size === png.length));

const one = files.find((e) => e.name === 'aaa.png') || { url: '' };
const got = await CC.webdavGetBytes(cfg, one.url);
check('带鉴权取字节（缩略图/反推走这条）', got.ok && got.bytes.length === png.length, got.error);
check('字节 ↔ dataURL 往返无损', CC.dataUrlToBytes(CC.bytesToDataUrl(png, 'image/png')).length === png.length);

const miss = await CC.webdavList(cfg, '这个目录不存在');
check('不存在的目录给出明确错误', !miss.ok && /404|不存在/.test(String(miss.error)), miss.error);

const noauth = await CC.webdavList({ baseUrl: cfg.baseUrl, user: '', pass: '' }, '');
check('没填账号时直接拒绝', !noauth.ok && /账号/.test(String(noauth.error)), noauth.error);

console.log('\n' + pass + ' / ' + fail + '  (' + pass + ' pass, ' + fail + ' fail)');
process.exit(fail ? 1 : 0);
