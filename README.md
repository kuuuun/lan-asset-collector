# 素材采集器 · LAN Collector

仿 Billfish 采集器的浏览器扩展（Chromium 内核：夸克 / Chrome / Edge），保留它全部采集动作，
但**不写入任何素材库软件**，而是把截图和网页图片直接落进你局域网里指定的文件夹。

落盘有两条通道，默认走 **WebDAV 直传**——不需要在局域网里部署任何东西。

> 要接手维护请先读 **[HANDOVER.md](HANDOVER.md)**：代码地图、不可动摇的设计决定（改了就会重现老 bug 的那些）、
> 四套验证闸门怎么跑、故障排查表，以及**尚未验证的部分**都在那里。

| 通道 | 原理 | 是否需要部署 |
|---|---|---|
| **A. WebDAV 直传**（默认） | 扩展直接 `PUT` 到 NAS 自带的 WebDAV 服务（群晖默认 5005 端口） | **不需要**，NAS 自己就是服务端 |
| **B. 浏览器目录授权** | 用 File System Access API 写授权目录（可指向映射过的网络驱动器 `Z:\`） | 不需要，但依赖浏览器内核支持 |

> **当前这套的配置**：目标是 `\\192.168.31.206\Works\PicStorage\clips`，本机已把它映射成 `Z:\PicStorage\clips`。
> 206 是群晖 NAS 且 WebDAV 端口 5005 已开放，所以默认走通道 A：
> `http://192.168.31.206:5005/Works/PicStorage/clips`。设置页里填上 NAS 账号密码即可，不用装任何东西。

> **v1.5.7 变更（修「右键里没有存单张图片这一项」）**：
> 根因是菜单注册写成了 **`removeAll` + 回调里 `create`** —— 这是「先清空、再重建」两步：
> `removeAll` 发出之后若后台脚本被回收（内核回收得更勤的浏览器上很容易发生），
> 菜单就被清空而新的没建上，表现正是「右键里没有这一项了」；而且 `create` 的失败被
> `void chrome.runtime.lastError` 吞掉，真出问题也没人知道。
> 现改为**单步注册**：先 `create`，报「重复 id」就 `update` 覆盖 —— 全程不留空档，
> 改标题也会被刷成当前值。兜底唤醒点从「切标签页」扩到「切标签页 + 切换窗口」。
> 另补上**可见的诊断入口**：扩展面板底部新增一行菜单状态，把注册结果直接显示出来，
> 右边带「重新注册」按钮；而**打开面板这个动作本身就会重注册一次** ——
> 也就是说「点一下扩展图标」就等于「把右键菜单补回来」，不必再跑扩展管理页点刷新。
> 静态闸门 +5（禁止退回 removeAll 两步式、必须走 update、切窗口兜底、弹窗诊断入口、
> 后台 `menu:status` 分支），真机 +2（弹窗状态行真的显示已就绪、切窗口兜底在）。

> **v1.5.6 变更（把「扩展管理页冒红字」这条路彻底堵死）**：
> K 又发来一张截图 —— `Uncaught (in promise) Error: Uncaught TypeError: Cannot read properties
> of undefined (reading 'id')`，上下文 `popup/popup.html`。查证结论：
> ① 这条字符串与 **1.5.2 修掉的 `batchSave()` 空标签页 bug 一模一样**（`sender.tab` 为
> `undefined` 时读 `tab.id`），现版代码里已没有可达的空读 `.id`；弹窗脚本里更是一个 `.id`
> 都没有 —— 而截图给出的堆叠是 `popup/popup.html:0 (匿名函数)`，**没有源码行号**，
> 是堆栈丢失的拒绝、不是我们页面里某一行抛的；错误列表又会跨版本累积（要手动「全部清除」）。
> ② 顺着这条线挖出一批**真隐患**并全部修掉：后台里 `chrome.notifications.create`、
> `chrome.action.setBadgeText / setBadgeBackgroundColor / setTitle`、`chrome.tabs.create`、
> `chrome.runtime.openOptionsPage` 都是 **Promise 形式**调用，而外面只包了 `try/catch`
> —— **try/catch 抓不住 Promise 拒绝**，而这几处恰好是每次采集都会走的路径。
> 现已统一过一遍 `silent()`；`ensureContent()` / `persist()` 也补了各自的判空；
> 设置页「保存」失败会给明确提示，不再静默。
> ③ 兜底与取证：后台与弹窗、设置页都装了 `unhandledrejection` / `error` 记录网
> （只写 `console.warn`，不再往错误列表冒）；真机脚本新增三块断言 —— 走**弹窗 → 后台**
> 这条此前唯一没覆盖的采集链路（`batch` / `region` / `viewport`，真截图真落盘）、
> 全程断言后台零未处理拒绝，并**直接打开 `chrome://extensions` 读扩展管理页的错误列表、
> 断言为空**。静态闸门也补了两条：Promise 形式的 `chrome.*` 调用必须有人接住失败；
> 后台与页面必须装兜底网。
>
> **v1.5.5 变更（按 K 的要求：去掉鼠标悬停采集）**：图片上悬停浮现的「采集」按钮**整条链路已删除** ——
> 内容脚本里的按钮创建 / 定位 / 显隐逻辑、`mouseover` `mouseout` `scroll` 三个监听器、
> 样式表里的 `.ccx-hover-btn`、设置里的「采集行为 · 悬停按钮」开关、后台默认值 `hoverButton`
> 全部移除，不再留下任何监听器（此前它会在**每一个**含图片的页面上挂三个 `capture: true`
> 的全局监听器，对浏览性能是持续的负担）。
> 单图采集现在只剩两条路：**图片上右键 → 一键剪藏**，或 **`Alt`+右键**。
> 顺带说明：`图片最小边长过滤` 依然有效，但现在只作用于批量采集面板。
>
> **v1.5.4 变更（回答「什么时候进子文件夹」＋ 补一个右键菜单消失的兜底）**：
> ① 把「文件落在哪个文件夹」写成明确规则并写进文档：**只看「子目录模板」**，留空＝直接落在目标目录、
> 不进子文件夹；与采集入口 / 网站 / 图片数量统统无关。设置页与帮助页都加了这段说明。
> 写文档时顺手测出一个**真 bug**：子目录模板留空时，空段走了 `cleanSeg` 的 `untitled` 兜底，
> 结果不是「不建目录」，而是凭空多出一个 `untitled/` 文件夹（尾部带斜杠的模板如 `{yyyy}/` 也一样）。
> 已拆出 `CC.cleanDirSeg()` —— 目录段无内容就丢弃，文件名的 `untitled` 兜底保持不变。
> ② 修一个「删掉别的扩展后本扩展的右键项消失」的情况：Chromium 在**扩展集合变化**（安装 / 卸载 /
> 禁用任意一个扩展，例如删掉 Billfish 采集扩展）时会重建整张右键菜单，重建那一刻本扩展后台若在休眠，
> 这项就缺席。现已挂上 `tabs.onActivated` 兜底 —— 切一次标签页就唤醒后台并重建菜单。
>
> **v1.5.3 变更（把「Uncaught (in promise)」这类红字从根上堵掉）**：
> 扩展里所有跨上下文的消息封装现在**一律返回对象**，不会再把 `undefined` 交给调用方去取属性；
> 后台对不认识的消息也会明确回一个错误对象，而不是把消息端口一关了事
> （那会让调用方收到「The message port closed before a response was received.」）。
> 弹窗与设置页的 DOM 访问、异步流程也都补了兜底。真机验证脚本相应加了两段：
> 走**真实消息通道**把后台每个分支打一遍、把弹窗里每个入口点一遍。
>
> **v1.5.2 变更（修扩展管理页里的两条红字）**：
> ① `help/help.html` 里有一小段**内联 `<script>`**，违反 MV3 的 `script-src 'self'`，
> 只要打开过帮助页就会留下一条 Content Security Policy 违规 —— 已抽成独立的 `help/help.js`；
> ② `batchSave()` 在没有标签页时（消息来自扩展自身页面）会直接读 `tab.id` 抛未捕获异常 —— 已加保护。
> 同时新增 `dev-tests/live_browser_check.mjs`：**真的把扩展装进 Chromium 里跑一遍**，
> 抓 CSP 违规与未捕获异常，并用畸形输入把所有采集入口打一遍。
>
> **v1.5.1 变更（修一个「改了没反应」的坑）**：右键菜单此前只在 `onInstalled` / `onStartup` 里注册，
> 而在扩展管理页点「刷新」重载扩展时**这两个事件都不会触发** —— 菜单由浏览器进程持有，
> 不会随 service worker 回收而消失，于是改了标题、刷新了扩展，右键里看到的仍是旧的那一项。
> 现已把注册挪到 service worker **顶层**（每次唤醒都重跑），重载 / 唤醒 / 升级 / 启动都会同步。
>
> **v1.5.0 变更**：右键菜单标题改为 **「将图片保存至 LAN Collector」**；并换上自绘图标 ——
> 原先那个是通用的「下载箭头 + 托盘」，现在改成「照片卡 + 下落箭头」配靛蓝→青渐变，
> 由 `tools/make_icons.py` 用纯标准库生成（无 Pillow 依赖）。
>
> **v1.4.0 变更**：下线了原先的「局域网接收端（http）」第三条通道 —— 它需要额外跑一个 Python 服务，
> 而 WebDAV 已经能零部署做到同一件事。老配置里的 http 通道会被自动迁移到 WebDAV。

---

## 跨平台支持（Windows / macOS）

扩展本体（采集、截屏、WebDAV、目录授权）用的是 Chromium 通用 API，**两个系统跑的是同一份代码，
没有平台分支**。分平台的只有「本机路径怎么写」这一处提示文案：

| 项目 | Windows | macOS |
|---|---|---|
| 采集与落盘 | ✅ | ✅ |
| 通道 A（WebDAV 直传） | ✅ 零部署 | ✅ 零部署 |
| 通道 B（目录授权） | ✅ 可指向 `Z:\` | ⚠️ 可指向 `/Volumes/…`，但 Chromium 对网络卷的授权句柄在重新挂载后会失效 |
| 本机路径写法 | `Z:\PicStorage\clips` 或 UNC `\\192.168.31.206\Works\…` | 挂载后为 `/Volumes/Works/PicStorage/clips`，**不认 UNC** |

**同一个 NAS 目录在两边的写法不同**，这是最容易踩的一点：

```
Windows   Z:\PicStorage\clips
          或  \\192.168.31.206\Works\PicStorage\clips
macOS     访达 Cmd+K → smb://192.168.31.206/Works → /Volumes/Works/PicStorage/clips
Linux     mount -t cifs //192.168.31.206/Works /mnt/works → /mnt/works/PicStorage/clips
```

> 走**通道 A 时这些区别完全不存在** —— 远端只是一个 HTTP 地址，两端一致。
> 「保存位置」按钮给出的本机路径提示会按系统分流（Windows 说映射盘符、macOS 说 `/Volumes`），
> 而且主机名与共享名都从设置页的 WebDAV 地址推导，不在代码里写死。

---

## 目录结构

```
lan-asset-collector/
├── manifest.json                    扩展清单（MV3）
├── HANDOVER.md                      交接说明：代码地图、不可动摇的设计决定、验证与排查
├── background.js                    后台：快捷键 / 右键一键剪藏 / 截屏编排 / 整页拼接调度
├── lib/
│   ├── util.js                      通用工具（模板渲染、路径清洗、哈希）
│   ├── store.js                     配置读写 + IndexedDB（目录句柄 / 去重指纹 / 序号）
│   ├── webdav.js                    WebDAV 客户端（探测 / MKCOL 建目录 / PUT 写入）
│   ├── saver.js                     保存层（webdav / fsa 两条通道）
│   └── imageproc.js                 页面内 Canvas 处理（裁剪、格式转换、整页拼接）
├── content/
│   ├── content.js                   区域选择遮罩、Alt+右键、批量面板、防盗链兜底取图
│   └── content.css
├── popup/                           功能面板（对齐 Billfish 的布局）
├── options/                         设置页
├── help/help.html                   使用说明
├── assets/icons/                    图标（由 tools/make_icons.py 生成）
├── tools/make_icons.py              纯标准库 PNG 生成脚本
├── tools/package.py                 打包 + 交付前闸门（见文末）
└── dev-tests/                       开发期验证脚本（不打包，见文末）
```

---

## 安装扩展

1. 浏览器地址栏打开 `chrome://extensions`（夸克是 `quark://extensions`，或菜单里的「扩展管理」）
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选中本目录 `lan-asset-collector`
4. 首次安装会自动打开使用说明页

---

## 图标

`assets/icons/16|32|48|128.png` 全部由 `tools/make_icons.py` 生成 —— 纯标准库自己写 PNG，
**不需要 Pillow**：

```bash
python tools/make_icons.py                                  # 重新生成四个尺寸
python dev-tests/icon_preview.py assets/icons/16.png 16     # 放大到 256×256 便于肉眼检查
```

图形是「照片卡 + 自上而下的箭头」，底色是靛蓝 `#6366F1` → 天青 `#0EA5E9` 的斜向渐变，
和设置页 / 弹窗的主色同族。**16 / 32 走的是加粗版**：细笔画在小尺寸下会被抗锯齿糊掉，
所以小尺寸同时放粗笔画、并省掉卡片内部的山与太阳。要换配色或换图形，改脚本顶部那几处常量即可。

> **右键菜单里那一项前面显示的图标，就是扩展图标本身。** Chromium 的 `contextMenus` API
> 没有给单个菜单项指定图标的参数，它显示的一律取自 manifest 的 `icons` ——
> 所以「换右键菜单的图标」＝ 换 `assets/icons/`，没有别的开关。

---

## 右键菜单：一键剪藏单张图片

在网页的任意图片上点右键，菜单里会直接出现一项 **「将图片保存至 LAN Collector」**，点一下这张图就存好了 ——
和 Billfish 采集扩展的形态一致，不进二级菜单、不需要二次确认、不跳出任何窗口。

鼠标的三种来源都能处理：

| 图片来源 | 取法 |
|---|---|
| 普通 `http(s)` 图片 | 先在扩展后台直接抓（有 host 权限，不受页面 CSP / CORS 限制），失败再回页面里带页面自身的 Cookie / Referer 重试一次 —— 图片站普遍有防盗链，这一层兜底很关键 |
| 页面内的 `blob:` 图片（部分懒加载 / 编辑器生成） | `blob:` 只存在于页面作用域，后台取不到，交给内容脚本在页面里读成 dataURL |
| `data:` 内联图片 | 直接解码，不发任何请求 |

> 区域截图 / 可视区截图 / 整页滚动截图 / 批量采集四个入口放在**弹窗面板**与**快捷键**里，
> 不占用右键菜单 —— 菜单项一多，Chromium 会把它们自动折叠成「素材采集器 ›」二级菜单，
> 一键剪藏就变成两次点击了。

---

## 配置落盘通道

设置页里二选一。右上角「测试连接」会做**真实探测**：WebDAV 那条会往目标目录试写一个文件再删掉，
所以绿灯就是真的能写，不是只看配置填得全不全。

### A. WebDAV 直传（默认 · 零部署）

不需要部署任何东西 —— **NAS 自带的 WebDAV 服务就是接收端**。

```
目标地址   http://192.168.31.206:5005/Works/PicStorage/clips
NAS 账号   <你的群晖 DSM 用户名>
NAS 密码   <只存在本机浏览器里>
```

群晖的端口约定：`5005` 走 HTTP，`5006` 走 HTTPS。用 5006 的话自签证书会让浏览器直接拒绝连接，
除非证书已被信任，所以局域网内用 5005 更省事（代价是口令以 Basic 明文走，别跨公网暴露）。

确认路径与权限：

1. DSM →「套件中心」确认已装 **WebDAV Server**
2. DSM →「控制面板 → 用户」→ 选中账号 →「应用程序」里允许 **WebDAV**
3. 建议**单独建一个账号**只给 `Works` 这一个共享文件夹的权限，别用管理员
4. 地址末尾就是最终目录，日期子目录再由下面的「文件组织」模板追加

实现细节：逐级 `MKCOL` 建目录（已存在就当成功），`PUT` 写文件，
并用 `If-None-Match: *` 做同名保护 —— 同名不会被静默覆盖，而是自动加 `-1`、`-2`。

### B. 浏览器目录授权（零部署 · 依赖内核）

选一个目录即可授权。Windows 上本机 `Z:` 正好映射到 `\\192.168.31.206\Works`，
所以选 `Z:\PicStorage\clips` 和通道 A 是同一个落点；macOS 上先在访达里
`Cmd+K` 挂载 `smb://192.168.31.206/Works`，然后选 `/Volumes/Works/PicStorage/clips`。

> 这条依赖浏览器的 File System Access API。部分国产内核阉割了该能力，
> 而且 Chromium 对**网络驱动器**的支持历来不稳，因此作为备用而非首选。

---

## 功能

| 功能 | 快捷键 | 说明 |
|---|---|---|
| 一键剪藏单图 | 图片上右键 | 存这张图的**原始文件**，不重编码；形态与 Billfish 采集扩展一致 |
| 单图采集 | `Alt`+右键 | 与上面同一条取图链路 |
| 批量采集 | `Ctrl+1` | 列出页面全部图片（含背景图、懒加载、`srcset`、视频封面），勾选后抓原图 |
| 自定义区域截图 | `Ctrl+2` | 拖拽框选，松手即存 |
| 可视区域截图 | `Ctrl+3` | 当前视口 |
| 整页滚动截图 | `Ctrl+4` | 自动滚屏拼接；采集前自动隐藏 `fixed/sticky` 元素避免重影 |

> `Ctrl`+数字 被浏览器占用，因此只在**面板打开时**于插件内生效。
> 想全局触发，去 `chrome://extensions/shortcuts` 改成 `Ctrl+Shift+1..4`。

### 文件命名

模板占位符：`{yyyy} {yy} {mm} {dd} {hh} {mi} {ss} {ts} {rnd} {page} {host} {type} {n} {w} {h}`

默认：

```
子目录  {yyyy}-{mm}-{dd}
文件名  {hh}{mi}{ss}-{page}-{n}
```

即 `2026-10-10/143208-设计参考-网页标题-1.png`。`{type}` 取值为
`region` / `viewport` / `fullpage` / `batch` / `single` / `video`。

#### 什么时候进子文件夹，什么时候不进

**只看「子目录模板」这一栏**，最终路径恒为 `目标目录 + 子目录模板 + / + 文件名模板`：

| 子目录模板 | 结果 |
|---|---|
| 填了内容（默认 `{yyyy}-{mm}-{dd}`） | **进子文件夹**：`clips/2026-10-10/143208-设计参考-1.png` |
| **留空** | **不进子文件夹**：`clips/143208-设计参考-1.png` |

- 与采集入口无关：右键剪藏单图、区域 / 可视区 / 整页截图、批量采集、视频封面走同一套规则，落在同一处
- 与网站、图片数量、图片格式无关，不存在「有的进文件夹、有的不进」
- 子目录不用手工建：WebDAV 逐级 `MKCOL`，目录授权逐级创建，已存在也算成功
- 文件名模板**只决定文件名**；只有把 `{page}` / `{host}` 写进**子目录模板**才会按页面 / 站点分层（如 `{host}` → `clips/example.com/…`）
- 设置页「文件组织」下方有一行**预览**，显示的就是当前模板算出来的相对路径

#### 命名要同时满足三个系统的规则

同一份配置可能今天在 Windows 上跑、明天在 macOS 上跑，所以清洗规则取**三者的并集**：

| 规则 | 为什么 |
|---|---|
| 非法字符取并集 `\ / : * ? " < > \|` + 控制符 | 其中 `:` 只有 Windows 禁，但一并换掉对两边都安全 |
| **按 UTF-8 字节**截断到 200 字节，不是按字符 | 目标是 NAS（ext4/Btrfs）时上限是 255 **字节**；一个汉字 3 字节，按「90 个字符」截会得到 270 字节直接写失败。Windows 客户端经 SMB 写 NAS 同样卡在这个字节限制上 |
| 规避 Windows 保留设备名 `CON PRN AUX NUL COM1-9 LPT1-9` | 带扩展名（`CON.png`）一样保留；统一加 `_` 前缀 |
| 不允许以 `.` 或空格结尾 | Windows 的限制，macOS/Linux 容忍，但统一处理 |
| 长度预算按**码点数**算，不按 UTF-16 码元 | emoji 占 1 码点 / 2 码元，按码元算会把它算成两个字符，预算与实际字节数对不上 |

这套规则由 `lib/util.js` 单点实现，`dev-tests/platform_check.mjs` 用 22 组夹具逐条验证
（含超长中文、纯 emoji、组合字符、保留名、路径穿越），断言结果**同时**满足 Windows / macOS / Linux 三套约束。

---

## 已知边界

- 浏览器内部页面（`chrome://`、扩展商店、`file://`）无法采集，这是平台限制
- 批量采集抓的是**原始文件**，CDN 防盗链的图片若连页面内兜底也拿不到，会计入「失败」
- 右键剪藏的是**这一张图本身**。若站点用的是一次性签名 URL（过期即失效），存下来的是当时的字节，不受影响
- 整页截图受 Canvas 面积限制，超过约 4000 万像素会自动缩放；页面极长可在设置里调「最大高度」
- 未做「跨域 iframe 内的图片」采集，只处理顶层文档
- 走的是蒲公英 VPN 隧道（`OrayBoxVpnEnt`）到 206，大图批量采集时速度受隧道带宽限制
- **WebDAV 通道**：口令以 Basic 明文随请求发送，务必只在局域网 / VPN 内使用 5005；
  要暴露到公网请改用 HTTPS 并让证书被信任（自签证书会让浏览器直接拒绝连接）
- **目录授权通道**依赖 File System Access，部分国产内核阉割了该能力，且对网络驱动器支持不稳
- **扩展已在 Edge 无头模式里真机加载运行**：`dev-tests/live_browser_check.mjs` 用 CDP 把扩展装进
  真实 Chromium，跑通截图与落盘、并把扩展管理页的错误列表断言为空（v1.5.2 起）
- **但我从未在 macOS 机器上做端到端采集，也没能程序化验证夸克右键菜单的实际呈现** ——
  前者只覆盖到路径提示文案与命名规则约束，后者受夸克自绘右键菜单支配（详见交接文件）

---

## 隐私

所有数据只写进你自己配置的目录，不经过任何第三方服务器。扩展需要「读取所有网站数据」权限用于抓图和截屏，属此类工具的必要权限。

**WebDAV 通道**：NAS 账号密码存在本机扩展的 `chrome.storage.local` 里，只在向该 NAS 发请求时用于 Basic 鉴权，
不会发往别处。写入路径由「文件组织」模板生成，模板里的 `{page}` 等字段都会经过路径清洗，`..` 与分隔符被剥离。
更稳妥的做法是单独建一个只对该共享文件夹有权限的 NAS 账号。

扩展不开放任何本地监听端口，也不接受来自网页的连接 —— 没有可被外部写入的入口。

---

## 开发期验证（dev-tests/）

`dev-tests/` 不打包进扩展，是给改动 `lib/` 时回归用的。它把真实的 `lib/*.js` 用 Node 的 `vm`
加载进来跑，而不是重写一份逻辑，所以测的就是会装进浏览器的那份代码。

```bash
# WebDAV 协议层 + 保存链路（需要 wsgidav：pip install wsgidav cheroot）
# 注意：服务端必须与测试在**同一条命令**里起，跑完再关
python dev-tests/dav_server.py /tmp/davroot 8081 tester s3cret &
sleep 4
node dev-tests/webdav_client_test.mjs      # 鉴权、建目录、写入、同名保护
node dev-tests/save_integration_test.mjs   # 完整保存链路，含落地文件 SHA-256 校验与去重
```

> 分成两次调用的话后台进程会被回收，后续测试会以 `fetch failed` 报错 —— 那是环境问题，不是代码问题。

### 跨平台静态校验（不需要起服务端）

```bash
node dev-tests/platform_check.mjs
```

加载真实的 `lib/util.js` 与 `background.js`（用最小 `chrome` stub），分四段断言：

| 段 | 内容 |
|---|---|
| A | 命名规则 —— 22 组夹具同时满足三平台约束、字节截断不切开多字节字符、清洗幂等 |
| B | `nasLocalHint` 在 macOS 下不吐出 `Z:\`、主机名与共享名从 `baseUrl` 推导而非硬编码 |
| C | **右键菜单形态** —— 恰好只注册 1 项、无 `parentId`（不会被折叠成二级菜单）、只在 `image` 上下文出现、**标题为「将图片保存至 LAN Collector」**；`fetchForClip` 处理 `data:` 时不走网络 |
| D | 仓库卫生 —— 行尾约定（`.bat` CRLF / 其余 LF）、shebang、**接收端残留引用为零**、`receiver/` 已移除、**manifest 声明的每个图标尺寸都真实存在且是合法 PNG** |

### 交付前闸门

```bash
python tools/package.py           # 校验 + 产出 ../lan-asset-collector-v<版本>.zip
python tools/package.py --check   # 只校验不打包
```

校验项：manifest 引用的文件齐备、版本号在 `manifest.json` / `background.js` / `popup.html` /
`content.js` / `help.html` 五处一致、行尾约定、`dev-tests` 未混入、接收端无残留。
打包时把 `755` 显式写进 zip 的 `external_attr`（Windows 上压缩会丢可执行位）。
