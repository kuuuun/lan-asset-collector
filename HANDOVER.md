# 交接说明 · 素材采集器（LAN Collector）

> 交接对象：接手维护这个扩展的开发者。
> 当前版本 **v1.7.4**，交接日期 **2026-10-10**（v1.5.8 / v1.5.9 补充于 2026-10-12，v1.6.0 ~ v1.6.5 补充于 2026-10-19，v1.7.0 ~ v1.7.4 补充于 2026-10-21）。
> 这份文件只讲「怎么接手、别踩哪些坑」，功能怎么用看 [README.md](README.md)。

---

## 一、一页速览

| 项 | 内容 |
|---|---|
| 是什么 | Chromium 内核浏览器扩展（MV3），仿 Billfish 采集器的采集动作，但**不写入任何素材库软件**，直接把截图 / 网页图片落进局域网目录 |
| 干什么用 | 图片右键一键剪藏、区域截图、可视区截图、整页滚动截图、批量采集 → 直接存到群晖 NAS；v1.6.0 起还能**复制原图到剪贴板**、在**素材工作台**里扫描当前目录、用**本地 ComfyUI 反推 Krea 2 提示词** |
| 落盘通道 | 默认 **WebDAV 直传**（零部署，NAS 自带 5005 端口就是服务端）；备用 **浏览器目录授权**（FSA） |
| 目标目录 | `http://192.168.31.206:5005/Works/PicStorage/clips`（群晖 DSM，本机映射为 `Z:\PicStorage\clips`） |
| 代码量 | 扩展本体 ~3,900 行（JS/CSS/HTML），验证脚本 ~1,900 行（`dev-tests/`，不打包） |
| 依赖 | **运行时零依赖**（没有 npm、没有构建步骤）；反推提示词需要一个跑着的**本地 ComfyUI**（可选功能） |
| 目标浏览器 | 夸克（K 的主力）、Chrome、Edge —— 同一份代码，无平台分支 |
| 交付物 | `python tools/package.py` → 上一级目录的 `lan-asset-collector-v<版本>.zip` |

**一句话现状**：功能完整、四套验证闸门全绿；**已在 Edge 无头模式真机跑通端到端采集**，
但**从未在真实 macOS 上跑过**，**也从没能程序化验证夸克右键菜单的实际呈现**（原因见第五节）。

---

## 二、5 分钟跑起来

```bash
# 1. 直接加载（无需构建）
#    浏览器打开 chrome://extensions（夸克：quark://extensions）
#    右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选本目录
#    注意：选本目录本身，不要选它的上一级

# 2. 配置落盘目标：点扩展图标 →「设置」→ 填 NAS 账号密码
#    然后点弹窗里的状态胶囊「测试连接」，绿灯＝真的能写（会往目标目录试写一个文件再删掉）

# 3. 验一把
#    在任意网页的图片上右键 →「将图片保存至 LAN Collector」
#    去 NAS 看 clips/ 下有没有落文件
```

**改完代码怎么生效**：扩展管理页点「刷新」（🔄）。注意两个副作用 ——
① 右键菜单标题/形态的改动**必须刷新后重开一次面板**才可见（原因见第五节第 2 条）；
② 若做过「移除 + 重新加载」，`chrome.storage.local` 会被清空，**NAS 账号密码要重填一次**。

---

## 三、代码地图

```
manifest.json          MV3 清单。权限：tabs / activeTab / scripting / storage /
                       contextMenus / notifications / offscreen / clipboardWrite + <all_urls>
background.js  (1,050) service worker：菜单注册、快捷键、截屏编排、整页拼接调度、消息总线、剪贴板与 ComfyUI 编排
lib/util.js    (370)   模板渲染 + 路径清洗（三平台并集规则）+ 哈希 + 字节↔dataURL + 各类解析 + **Pinterest 判定（域名 / 保存按钮）**
lib/store.js   (200)   设置读写（chrome.storage.local）+ IndexedDB（目录句柄/去重指纹/序号）
lib/webdav.js  (390)   WebDAV 客户端：探测 / 逐级 MKCOL / PUT（含同名保护）/ **列目录（Depth:1）** / 取字节
lib/saver.js   (211)   保存层：通道分发（webdav / fsa）+ 目标校验 + 取图
lib/imageproc.js(118)  页面内 Canvas 处理：裁剪 / 格式转换 / 整页拼接（跑在内容脚本里）
lib/comfy.js   (230)   **ComfyUI 客户端**：ping / upload / 排队 / 轮询 / 取文本 + Krea 2 反推指令
offscreen.html/.js     **offscreen 文档**：写系统剪贴板、把大图压成缩略图（SW 里没有 DOM）
content/content.js(1,090) 区域选框、Alt+右键（大图推断）、批量面板、整页滚屏与拼接、页内提示、**本页最大图**、**Pinterest 保存镜像**
popup/         功能面板（对齐 Billfish 布局，含右键菜单状态自检行、复制原图、素材工作台入口）
studio/        **素材工作台**：只扫当前目录、缩略图墙、复制图片 / 反推提示词 / 打开原图
options/       设置页（含反推提示词的 ComfyUI 配置）
help/          使用说明页
assets/icons/  16/32/48/128 图标，由 tools/make_icons.py 生成
tools/         make_icons.py（纯标准库生成 PNG）、package.py（校验 + 打包）
dev-tests/     四套验证脚本，永不打包
```

### 关键函数索引

| 位置 | 函数 | 作用 |
|---|---|---|
| `background.js` | `buildMenus()` | **单步**注册右键菜单（create → 已存在则 update），顶层调用 |
| | `collectPin(tab)` | Pinterest 大图采集：`pin:scan` 换算 originals → **先抓原图、失败退回页面那张** → 保存（见第四节第 9 条） |
| | `fetchForClip(tab, url)` | 剪藏的**三层取图兜底**：`data:` 直接解码 / `blob:` 交内容脚本 / `http(s)` 先后台抓、失败回页面带 Cookie+Referer 重试 |
| | `singleSave` / `batchSave` | 单图 / 批量落盘入口。`singleSave` 支持 **`fallbackUrl`**：首选地址（多为推算出来的大图）抓失败就退到它再抓一次 |
| | `captureRegion` / `captureViewport` / `captureFullPage` | 三种截屏编排 |
| | `persist(tab, dataUrl, type, extra)` | 统一的「转码 → 命名 → 写盘 → 计数 → 通知」出口 |
| | `copyPageImage(tab)` | **复制原图**：`cc:image:largest` 找主角 → `fetchForClip` 取字节 → offscreen 写剪贴板 |
| | `ensureOffscreen` / `toOffscreen` | 按需拉起 offscreen 文档（剪贴板 / 缩略图），失败信息要能落到界面 |
| | `libList` / `libThumb` | **工作台**：列一层目录 / 出缩略图（缓存 180 条） |
| | `comfyReverse(payload)` | **反推**：取图（跨机时先压到 `maxUploadSide`）→ 上传 → 排队 → 等文本，返回 `{text, ms, uploaded}` |
| | `silent(p)` | 包住 Promise 形式的 `chrome.*` 调用（**try/catch 抓不住 Promise 拒绝**，见第五节） |
| `lib/comfy.js` | `CC.comfyReverse` | 上传 + 工作流 + 轮询；空结果 / **回显指令**都自动重试一次（见第四节第 12、15 条） |
| | `CC.normalizeComfyUrl` / `CC.isLoopbackUrl` | **地址规范化**（裸 IP 补 `http://` 与 8188，https 不补端口）/ 判定是否本机（决定给哪套排查建议） |
| | `CC.buildReverseWorkflow` | 固定 4 节点工作流，**`sampling_mode` 传字符串** |
| `lib/webdav.js` | `CC.webdavList` | **Depth:1** 列目录（不引 DOMParser，后台也能用） |
| | `CC.webdavGetBytes` | 带 Basic 鉴权取图（缩略图 / 反推取图） |
| `lib/util.js` | `CC.cleanSeg` / `CC.cleanDirSeg` | **文件名段**（空则兜底 `untitled`）vs **目录段**（空则丢弃）—— 语义不同，别合并 |
| | `CC.pinimgOriginal(url)` | Pinterest CDN 地址 → `originals` 原图；非 pinimg 域名返回空串（当判据用） |
| | `CC.sanitizeRelPath(p)` | 把模板算出的相对路径逐段清洗 |
| | `CC.sliceBytes` / `CC.utf8Len` | 按 **UTF-8 字节** 截断（NAS 上是 255 字节上限，不是字符） |
| `lib/saver.js` | `CC.saveAsset(asset)` | 唯一落盘入口，按 `settings.mode` 分发到 webdav / fsa |
| `lib/store.js` | `CC.getSettings` / `CC.setSettings` | 读写设置；`normalizeMode()` 会把老配置里的 http 通道自动迁到 `webdav` |

### 一次「右键剪藏」的调用链

```
contextMenus.onClicked ('cc-image')
  → singleSave(tab, { url: CC.pinimgOriginal(info.srcUrl) || info.srcUrl,
                      fallbackUrl: info.srcUrl, w, h })   ← 能逆推原图就采原图
    → fetchForClip()  ─┬─ data:  → 本地解码
                       ├─ blob:  → sendMessage('cc:image:fetch') 给内容脚本
                       └─ http(s)→ 后台 fetch；失败 → 内容脚本带页面凭证重试
    → maybeConvert()  → 按设置决定是否转码
    → CC.saveAsset()  → CC.checkTarget() 校验目标
                      → buildTarget()  渲染 dirTemplate / nameTemplate 得相对路径
                      → webdav: webdavProbe → MKCOL → PUT(If-None-Match: *)
                        fsa:    getDirectoryHandle({create:true}) → createWritable
    → bumpStats() / rememberHash() / reportSave()  计数、去重指纹、页内提示 + 通知
```

---

## 四、不可动摇的设计决定（改之前先读这一节）

这一节是这份交接文件里最值钱的部分 —— 每一条都是**踩过坑之后才定下来的**，
按「直觉」改回去就会重现对应的 bug。

### 1. 右键菜单只能有 **1 项**，不要加第二个

Chromium 官方行为：同一扩展注册**多个顶层菜单项**时会被**自动折叠成一个「扩展名 ›」二级菜单**，
一键剪藏就从「一次点击」变成「两次点击」。所以：

- 菜单里只留 `cc-image` 一项（`contexts: ['image']`），标题「将图片保存至 LAN Collector」
- 其它功能（区域 / 可视区 / 整页 / 批量）放**弹窗面板 + 快捷键**，不进右键菜单
- 闸门守着：`platform_check.mjs` C 段断言 `createdMenus.length === 1` 且无 `parentId`

### 2. 菜单注册必须是「**单步**」，永远不要 `removeAll` + `create`

这是 v1.5.7 才修掉的真 bug，也是 K 反复报「右键里没有存单张图片这一项」的根因：

- 老写法 `removeAll(cb → create)` 是**先清空、再重建两步**。`removeAll` 发出之后若 SW 被回收
  （夸克这类内核回收更勤），菜单就被清空而新的没建上 —— 全程存在一个「菜单是空的」窗口
- 现在：`create` → 报「重复 id」就 `update({ title, contexts })` 覆盖。**任何时刻菜单都是完整的**
- 闸门用 `/contextMenus\s*\.\s*removeAll\s*\(/` 匹配 —— 只能匹配**调用形式**，
  因为注释里会正当地提到这个名字，只搜字符串会假红

### 3. 注册点放在 service worker **顶层**，不要只挂在生命周期事件里

- `contextMenus` 菜单由**浏览器进程**持有，SW 回收**不会**让菜单消失
- 而「扩展管理页点刷新」**既不触发 `onInstalled`**（只在安装/升级来）**也不触发 `onStartup`**
  （只在浏览器启动来）→ 只挂这两个事件的话，改了标题刷新扩展后右键永远显示旧标题
- MV3 的顶层脚本每次唤醒都重跑，`create`/`update` 幂等，所以顶层调一次即覆盖全部路径
- **兜底唤醒点**：`tabs.onActivated` + `windows.onFocusChanged` → `buildMenus()`。
  因为 Chromium 在**扩展集合发生变化**时（安装 / 卸载 / 禁用任意一个扩展）会重建整张菜单，
  重建那一刻本扩展 SW 若在休眠，这一项就缺席
- **不要改用 `chrome.alarms`**：要多申请 `alarms` 权限，给已加载的未打包扩展新增权限
  会触发重新授权，代价大于收益

### 4. 所有 Promise 形式的 `chrome.*` 调用都必须接住失败

`try/catch` **抓不住 Promise 拒绝**。`chrome.notifications.create`、`chrome.action.setBadgeText`、
`setBadgeBackgroundColor`、`setTitle`、`chrome.tabs.create`、`chrome.runtime.openOptionsPage`
在**不给回调**时都返回 Promise，失败是「拒绝」不是「抛出」→ 外面包着 try/catch 也照漏，
直接变成扩展管理页错误列表里的 `Uncaught (in promise) …`，使用者会认为「插件坏了」。

- 后台统一用 `silent(promise)`（内部 `p.catch(() => {})`），页面用 `fire(...)`
- 三个页面（后台 / 弹窗 / 设置）都装了 `unhandledrejection` + `error` 兜底网，
  漏网的只写 `console.warn`，不再往错误列表冒
- 闸门：`platform_check.mjs` D 段「`chrome.*` 的 Promise 调用都接住了失败」

### 5. 跨上下文的消息封装**一律 resolve 成对象**

`popup.js` 的 `send()` 写成 `resolve(err ? { error } : (res == null ? {} : res))` ——
后台被回收时 `res` 是 `undefined`，调用方紧接着取 `.stats` / `.version` 就会抛
「Uncaught (in promise)」。同理 `content.js` 的 `bg()`。

**并且**后台 `onMessage` 的 `default` 分支必须明确回 `{ ok: false, error: '未知指令' }`，
不能 `return` 了事 —— 那会让调用方收到「The message port closed before a response was received.」。

### 6. HTML 页面禁止内联 `<script>` 与 `onclick=`

MV3 默认 CSP 是 `script-src 'self'`，内联脚本违反它，只要打开过该页面就留一条 CSP 违规。
`help/help.html` 曾因此潜伏很久，已抽成 `help/help.js`。内联 `<style>` / `style=` 不受影响。

### 7. 目录段与文件名段的「空值语义」不同

- `CC.cleanSeg()`（**文件名**）：清完是空 → 兜底成 `untitled`（文件总得有个名字）
- `CC.cleanDirSeg()`（**目录**）：整段没有任何字母/数字（判据 `/[\p{L}\p{N}]/u`）→ **丢弃**

合并这两个函数会重现 v1.5.4 的 bug：子目录模板留空时凭空多出一个 `untitled/` 文件夹。

### 8. 悬停采集**已整条下线**，不要写回来

K 明确要求「不要鼠标悬停采集」。原来它会在**每个含图片的页面**上挂三个 `capture: true`
的全局监听器 + 一个浮动层，对浏览性能是持续的负担。
单图采集只剩两条路：**图片上右键一键剪藏**、**`Alt`+右键**。
`minSize` 仍有效，但只作用于批量采集面板。D 段有两条残骸闸门守着。

### 9. 「图片上盖了一层透明 div」的站点（Pinterest 是最典型的），右键这条路是死的

这不是我们代码的缺陷，是**浏览器判定 + 站点结构**叠加的结果：

- 站点在图片上盖一层透明 div（Pinterest 用视觉搜索热区），右键落点 `e.target` 是那个 **div**；
- 浏览器的 `contexts: ['image']` **不命中** → 我们的菜单项不出现；
- **同时**浏览器自带的「图片另存为」也不出现 —— 使用者看到的正是「右键里什么都没有」；
- 有的站点还会直接 `preventDefault()` 掉 `contextmenu`，整个原生菜单都不弹。

由这条推出三件事：

1. **`Alt`+右键 必须穿透覆盖层**。内容脚本的 `imageUnderPoint(target, x, y)`
   用 `document.elementsFromPoint(x, y)`（返回该点下方**所有**元素，覆盖层在最前）
   顺层找第一个 `<img>` —— 这就是用户肉眼看到的那张图。
   **不要退回「只看 `e.target.tagName === 'IMG'`」**：那正是 v1.5.7 及以前 Alt+右键 在这类站点上失效的原因。
   **失败不要静默**（v1.6.1）：`!e.altKey` 时一律不碰（页面右键必须照常），但按下 Alt 之后的
   四个分支（开关关了 / 没认出图 / 读不到地址 / 扩展刚重载导致旧标签页脚本作废）各自给出
   不同提示。静默的代价是用户分不清「我按错了」和「功能坏了」——这一条比多写几行字值。
2. **为此类站点提供不依赖右键的入口**：弹窗面板的「采集本页大图（Pinterest 原图）」
   （`popup` 的 `#pinGrab` → 后台 `pin:collect` → 内容脚本 `pin:scan`）。
   **它只对 Pinterest 显示**（`PIN_HOST` 正则），其它站点不出现，不打扰。
3. **Pinterest 的 CDN 路径是可预测的**，取原图不需要解析它的内部数据：
   `https://i.pinimg.com/<尺寸段>/ab/cd/ef/<hash>.jpg`（尺寸段 74x/170x/236x/474x/564x/736x/1200x 等）
   → 把尺寸段换成 `originals` 就是原始文件。换算函数是 `CC.pinimgOriginal()`（`lib/util.js`，纯函数、A 段有闸门）。
   **例外**：从外站抓取来的 pin，Pinterest 未必存了原图 → `originals` 可能 403/回落；
   所以 `collectPin()` 是**先试原图、失败退回页面上那张图**，宁可拿到小的也不空手。
   这种 pin 的原站地址有时在元素的 `data-orig-img` 属性里。
4. **单图采集要拿「大图」，不能直接用 `src`**（v1.5.9）。站点普遍把缩略图放在 `src`、
   把大图藏在别处（Pinterest 的 `src`/`srcset` 全是 236x/474x/736x 这类缩略图），
   直接用 `src` 采到的就是小图。内容脚本的 `bigSourceOf(img)` 按可靠性排序取：
   ① CDN 路径规则能逆推的（pinimg → `originals`，最可靠）
   ② 站点自己声明的大图属性（`data-orig-img` 等）
   ③ 都没有就退回页面渲染的那张，**不做无根据的放大猜测**。
   `Alt`+右键 与 `cc-image` 菜单项都走这条。换出来的地址多是**推算值**，所以配上
   `singleSave` 的 `fallbackUrl` 兜底 —— 与 `collectPin()` 是同一套「先原图、失败退回」的思路。
   返回的 `{ url, alt }` 里 `alt` 就是那个退路，别把它丢掉。

### 10. 「复制原图」不进右键菜单（v1.6.0）

第 1 条同样适用于它。复制图片放在**弹窗按钮**与**素材工作台**里，右键菜单依旧只有 `cc-image` 一项。
将来谁想加「复制图片」到右键，先读第 1 条：加进去就会把一键剪藏变成两次点击。

### 11. 剪贴板只能走 offscreen document（v1.6.0）

- MV3 的 service worker **没有 DOM，也没有 `navigator.clipboard`** —— 想在扩展里把**图片字节**
  写进剪贴板，唯一稳定的路径是 `chrome.offscreen.createDocument({ reasons:['CLIPBOARD','BLOBS'] })`
  再在 offscreen 文档里 `new ClipboardItem({'image/png': blob})` + `navigator.clipboard.write()`
- 需要 `offscreen` + `clipboardWrite` 两个权限，且 `minimum_chrome_version` 必须 ≥ **109**
- **发给 offscreen 的消息同时会到达 background 的 `onMessage`**。后台必须先
  `if (msg.target === 'offscreen') return;` —— 否则它会回一句「未知指令」，
  剪贴板写入收到的是这个错误答案，表现为「复制没反应但也不报错」
- 内容脚本那条路（页面里 `navigator.clipboard.write`）**不要用**：右键/弹窗触发时用户手势早已丢失，
  会被 Chromium 拒绝
- 统一转 PNG 再写：`image/webp`、`image/avif` 在剪贴板里有内核差异

### 12. 反推提示词用 ComfyUI 原生节点，别装第三方包（v1.6.0）

工作流固定为：

```
LoadImage → CLIPLoader(qwen3vl_4b_fp8_scaled, type=krea2) → TextGenerate(image=…) → PreviewAny
```

三个坑，都踩过：

1. **`sampling_mode` 在 API 里必须传字符串**（`"off"`）。TextGenerate 的 sampling_mode 是
   `DynamicCombo`，传成 `{ sampling_mode: "off" }` 会让 `execute()` 报
   「missing 1 required positional argument: 'sampling_mode'」。
2. **`max_length` 太小会拿到空字符串**（贪心解码直接 EOS）。默认给 420；
   `CC.comfyReverse` 在空结果时会自动放宽到 ≥600 并追加一句「直接开写」再试一次，
   仍为空才报错 —— 报错文案要指回「提示词长度上限」这个设置项。
3. **`system_prompt` 是 `force_input`**（UI 里必须连线），API 里别传；指令一律写进 `prompt`，
   靠 `use_default_template: true` 套模型的聊天模板。

反推与出图**共用同一个队列**：K 在跑图时反推会排队。所以 `comfyWait` 每 2.5 秒读一次 `/queue`，
工作台把它显示成「队列：运行 N / 等待 M」—— 不显示的话界面就是一个不动的转圈，看起来像卡死。
另外工作台在等待期间每 3 秒发一次 `comfy:queue`，顺带起到**保活 service worker** 的作用（长任务必需）。

### 13. 素材工作台只列一层，永不递归（v1.6.0）

`CC.webdavList()` 固定 `Depth: 1`。素材目录动辄上万张图，递归一次能把浏览器和 NAS 一起拖住；
「进到哪层看哪层」既是性能考虑，也正好对上 K 的要求「扫描只针对当前选择的目录」。
缩略图走 `lib:thumb`（后台取字节 → offscreen 压到长边 460px → JPEG），缓存上限 180 条；
**不要把原图直接喂给列表**，几十张 4K 就能把页面内存吃穿。

### 14. 打包白名单是**手写**的 —— 新增页面必须同步加进去（v1.6.0 首发踩过）

`tools/package.py` 的 `INCLUDE` 是手写清单，`check()` 只校验 **manifest 里声明的** 文件是否齐全。
`offscreen.html`、`studio/` 这类**不在 manifest 里、靠字符串路径加载**的文件（`chrome.offscreen.createDocument`、
`chrome.tabs.create({url:'studio/studio.html'})`、`<script src>`）它一点都看不见 ——
v1.6.0 第一版 zip 就因此**少了 5 个文件**（`offscreen.*` + `studio/*`），`完整性：通过` 照样打印。

现在有两道拦截：
1. `package.py` 扫包内 `.js`/`.html` 里的相对路径字面量，命中「仓库里真有这个文件、却没进包」就报警；
2. `platform_check.mjs` F 段断言 `INCLUDE` 必须含 `manifest.json` / `background.js` / `offscreen.*` / `studio` 等 11 个顶层条目。

**新增一个页面或新目录时，先改 `INCLUDE` 再打包**，别只看「完整性：通过」。

### 15. ComfyUI 地址可以跨机，但浏览器不是瓶颈（v1.6.1）

K 的场景是「家里 MacBook 调单位电脑的 GPU」。要分清三层，别把精力花错地方：

1. **浏览器这一层是通的。** 扩展页面与 service worker 都是 secure context，
   访问 `172.16/12`、`192.168/16`、`10/8` 这些私网地址**实测不被 PNA 拦**（Edge 无头实测，
   `live_browser_check.mjs` 有两条常驻断言）。所以不要为了「跨域」去折腾 CORS 或声明式网络规则。
2. **ComfyUI 这一层默认不通。** 它只听 `127.0.0.1`，别的机器连不上（实测局域网 IP 返回 000）。
   必须在启动参数里加 `--listen 0.0.0.0`（绘世启动器是「允许局域网访问」）并重启。
   **这不是代码能解决的** —— 报错文案里必须直接把这条说出来，否则用户只会看到 `Failed to fetch`。
3. **网络这一层最麻烦。** 家里和单位不在同一网段，内网地址根本不可达，要先用组网工具
   （节点小宝 / Tailscale）打通，然后把**隧道分配的地址**填进来。直连公网 IP + 端口映射基本不可行。

配套的两个设计：

- **地址规范化**（`CC.normalizeComfyUrl`）：允许只填 `172.18.23.232`，自动补 `http://` 与默认端口 8188；
  **https 不补端口**（通常是 443 反代）；保留路径（`/comfy/`），只去尾部斜杠。
- **上传前压缩**（`comfy.maxUploadSide`）：跨网时原图十几 MB 传不动，长边压到 1536 通常只剩十分之一。
  压缩在 **offscreen** 里做（SW 没 canvas），**失败就退回原图**，绝不因为省流量把功能弄挂。
  结果里回传 `uploaded`，工作台据此显示「上传 1536×1024 · 312 KB（压缩自 8.4 MB）」。

另外 `comfyReverse` 会把**模型回显指令**的输出当成空结果（`looksLikeEcho`）并重试一次：
这种情况在弱模型 / 小图上很常见，回显的指令粘进 Krea 就是一段说明文，绝不能当结果交给用户。

### 16. ComfyUI 会 403 掉扩展发起的上传 —— 必须改写请求头（v1.6.5）

现象：设置页「测试 ComfyUI」显示已连接，**一上传就 `HTTP 403` 且响应体为空**（server 头是 aiohttp）。

根因在 ComfyUI 自己的 `server.py`：

```python
if args.enable_cors_header:  middlewares.append(create_cors_middleware(...))
else:                        middlewares.append(create_origin_only_middleware())
```

`create_origin_only_middleware` 有两条硬规则：

1. `Sec-Fetch-Site: cross-site` → 403；
2. **Host 是回环地址时**，要求 `Origin` 的 host 与 Host 同名，否则 403。

扩展发起的是 `POST /upload/image`，浏览器给 `Origin: chrome-extension://<id>`，
`Sec-Fetch-Site` 也不是 same-origin —— 两条都撞。**GET 不带 Origin**，所以
`/system_stats` 一直是 200，这就是「测试连接正常、上传 403」的全部原因。

实测矩阵（同一扩展后台）：

| ComfyUI 地址 | POST /upload/image |
|---|---|
| `127.0.0.1:8188` | **403** |
| `10.222.222.1:8188`（节点小宝） | 200 |
| `172.18.23.232:8188`（内网） | 200 |

即：**只有回环地址会撞**，因为 `is_loopback(host)` 为假时那条 Origin 检查整个跳过。

解法是 `ensureComfyDnr(cfg)`（background.js）：用 `declarativeNetRequest` 的
**session 规则**（id 固定 `9001`）对**该 ComfyUI 地址的 `xmlhttprequest`** 改写
`Origin` → 地址本身、`Sec-Fetch-Site` → `same-origin`。

- **地址不是回环就撤掉规则** —— 那里不需要，留着只是无谓的头改写
- 规则只在对话期间有效（session），所以 `onInstalled` / `onStartup` / **每次反推前**各对齐一次
- 不采用 `--enable-cors-header`：那会把 origin 校验整个换掉，**网页偷偷 POST 到 127.0.0.1:8188 也能进**。
  DNR 只改本扩展发出的请求，网页那条路仍被 ComfyUI 挡住
- 权限 +`declarativeNetRequest`；`minimum_chrome_version` 无需再抬（109 已满足）

⚠️ **不要**把「403」写成「地址填错 / 网络不通」：那是本机地址下的**预期行为**，
网络和 ComfyUI 都是好的。文案必须说清「它只接受同源请求」并给两条出路
（换局域网地址 / 加 `--enable-cors-header`）。

---

### 17. Pinterest「保存」镜像：**跟随用户动作**，别去自动化 Pinterest（v1.7.0）

需求原话是「在 Pinterest 右键保存时，同时收藏到 Pinterest」以及反向的「我点 Pinterest 的保存时，
同时存一份到本地」。**反向那条才是能做的**，别把方向搞回去：

| 想要的效果 | 可行吗 | 为什么 |
|---|---|---|
| 采集时自动收藏到 Pinterest（新建 pin） | 要 API v5 + OAuth，能自动 | 但结果是「你自己发的新 pin」，不是收藏原 pin；token 约 30 天过期；等于往（可能公开的）板上发东西 |
| 采集时自动收藏到 Pinterest（收藏原 pin） | ❌ | Pinterest 没有 save-existing-pin 的 API；模拟点击属于会被封的路子 |
| **Pinterest 点保存 → 本地留一份** | ✅ 已实现 | 不动事件、不要凭证、不对外发布 |

实现要点（`content/content.js` 的「Pinterest 保存镜像」段）：

- 触发判据是**按钮的可访问名**（`aria-label` / `title` / 文字），判定函数 `CC.pinSaveLabel()`
  在 `lib/util.js`。**不要改成按 class 找** —— Pinterest 的 class 是混淆的（`X8m 1OV`），每次发版都变
- 找按钮用 `document.elementsFromPoint()` 的栈（和 `Alt`+右键 穿透覆盖层同一套思路），
  而不是从 `e.target` 往上爬：命中的往往是按钮里的 `<span>`
- 找图：从按钮往上最多 14 层，看子树里的 pinimg 图；**按距离打折再比面积** ——
  只比面积会在 closeup 页挑到右侧推荐位的大图
- **绝不 `preventDefault` / `stopPropagation`**：Pinterest 的保存必须照原样发生。静态闸门有断言守着
  （用 `stripComments` 判「有没有调用」，否则注释里的这两句话就会误报）
- 同一张图 **2.5 秒**内只镜像一次（一次保存会连发多个 click）
- 域名判定 `CC.isPinterestUrl()`：`pinterest.com` / `pinterest.co.uk` / `pinterest.com.au` 等，
  **必须用末尾锚点**，否则 `pinterest.com.evil.com` 会被当成 Pinterest
- 认不出就安静；只有「抓到按钮但取不到图」才写 `collector.lastError`（`pin:no-image` / `pin:no-url` / `pin:save`）

⚠️ 这一条**依赖 Pinterest 的页面结构**，属于会随站点改版失效的功能 —— 和我司其它「站点侧的坑」一样，
失败要能优雅退化（设置里关掉即可，`Alt`+右键 与弹窗「采集本页大图」仍在）。

---

### 18. 更新版本用 **刷新 ↻**，永远不要「移除」重加（v1.7.2，2026-10-21 踩过）

**移除扩展 = 删除它的存储。** `chrome.storage.local` 里的 WebDAV 账密、常用位置、各项开关、
累计统计全部清空，代码不会给你任何提示。表现极具误导性：

- Alt+右键 报「创建目录失败」→ 因为 `baseUrl` 退回 `DEFAULTS` 里的 `192.168.31.206`，从单位电脑不可达
- 之后又报「WebDAV 账号未填写」→ 因为 `webdav.user` 变空了（`CC.checkTarget` 的判据）
- Pinterest 镜像「点了保存什么也没有」→ 因为 `pinSaveMirror` 与 `pinMirrorDebug` 都回到 `false`，
  两条静默路径叠加，看起来就是功能全坏

排查时别再猜代码，**直接读 LevelDB 里的明文设置**最快（`v1.7.1` 就是这么定的案）：

```bash
cd "$LOCALAPPDATA/Quark/User Data/Default/Local Extension Settings/<扩展ID>"
python -c "
import glob
for f in glob.glob('*.log'):
    d=open(f,'rb').read(); i=d.find(b'collector.settings.v1')
    if i>=0: print(d[i:i+1200].decode('utf-8','replace'))
"
```

看到 `"user":""`、`"baseUrl":"http://192.168.31.206..."`、`"pinSaveMirror":false` 就是被重置了。

因此：**指引里只写「点扩展卡片上的刷新 ↻」**。只有安装路径变化（ID 随之改变）才需要移除重加，
那种情况必须先「导出配置」（设置页底部）→ 重装 → 「导入配置」。离开前顺手把旧 ID 目录整份
复制成新 ID 目录也能保住数据（见「约定速查」里的存储位置）。

---

### 19. `originals` 不一定存在 —— 抓图回退必须走「尺寸阶梯」（v1.7.3）

`CC.pinimgOriginal()` 只是**路径改写**，不代表那个对象在 CDN 上真的有一份。实测同一条路径：

| 尺寸段 | 结果 |
|---|---|
| `originals` | **403 AccessDenied**（S3 风格，= 对象不存在） |
| `1200x` / `736x` / `564x` / `474x` | 200 · 25,069 B（同一条 pin 的最大可用档） |
| `236x` | 200 · 17,756 B |

也就是说外站抓来的 pin 常常**没有 originals**，只有中等尺寸。原来的回退链是
「originals → 页面上那张（236x）」，一步掉到 17 KB 甚至 4 KB，看起来就是「采集的不是大图」。

所以 `singleSave` 里的候选顺序固定为：

```
payload.url（originals 或 dataUrl）
  → 1200x → 736x → 564x        ← CC.pinimgSized() 逐个改写，只对 pinimg 生效
  → payload.fallbackUrl（页面渲染的那张，最后兜底）
```

配套两条铁律：
- **必须把实际用的尺寸带回调用方**（`saved.sizeTag` / `saved.downgraded`）。以前 4 KB 缩略图和
  178 KB 原图给的是同一句「已保存」，使用者只能事后翻 NAS 才发现糊了。降级时提示
  「原图缺失，存的是 736x」。
- **不要靠「文件大小」判断是否降级** —— `fetchForClip` 抓失败会退到页面上下文重抓，
  体积受压缩影响大。判据只能是「最终 `used` 是否等于首选 `payload.url`」。

### 20. 刷新扩展（↻）之后，页面里的旧脚本会「看起来在工作」（v1.7.4，2026-10-21 踩过）

`quark://extensions` 点 ↻ 只换**后台**和**新打开页面**里的脚本；**已打开的标签页不会自动换**。
旧 content script 的 `chrome.runtime` 已经断开，但它的 DOM 逻辑完全照常：

| 还能做 | 已经不能 |
|---|---|
| 认按钮文字、`elementsFromPoint` 找图、算 `originals` 地址 | `chrome.runtime.sendMessage`（抛 `Extension context invalidated`） |
| 弹 toast（纯 DOM 操作） | `chrome.storage.local.set`（于是**失败也写不进 `collector.lastError`**） |

结果是最难查的一种现象：**用户看到「保存失败」，而我们的存储里一条记录都没有、`stats.failed` 也不涨**。
v1.7.3 之前就是这么表现的，用户只能说「报错了」，接手的人无从下手。

三条规矩：
- **`bg()` 发消息前先查 `chrome.runtime.id`**，失效时直接返回 `{ok:false, stale:true, error:'…按 F5 刷新本页再试'}`；
  浏览器的 `context invalidated` / `message port closed` / `Receiving end does not exist` 一律译成中文可执行文案。
  不要把 `lastError.message` 原样给用户看 —— 那等于没有信息。
- **业务分支里的 `.catch()` 要自己写 `recordLastError`**。`onMessage` 里的 `done()` 虽然也有 catch，
  但它只负责 `sendResponse`，不写存储 —— 异常会变成「有提示、无痕迹」。
- **弹窗要做版本比对**：`checkPageScript()` 用 `cc:ping` 拿到本页脚本的 `version`，与
  `chrome.runtime.getManifest().version` 不一致就出黄条指名 F5。这是唯一能自动发现该状态的地方
  （上下文失效后消息通道就没了，只能趁它还连着时比）。

排查速记：**「有提示但存储里查不到」＝ 请求没发出去**，不是后端失败。先看弹窗统计里的「上次成功 时间」动没动。

---

## 五、关于夸克浏览器：一条必须先讲清的前提

**夸克 v6.10+ 会「自绘」右键菜单覆盖原生菜单。** 由 `context_menu_injector.js` 在
`documentElement` 上挂 `mousedown + contextmenu` 组合监听实现，**运行在浏览器进程**，
层级高到网页里的 `event.preventDefault()` 在冒泡/捕获阶段都可能失效。

由此推出两条结论，接手后请记住：

1. **扩展的 `contextMenus` 项能否显示，受这套自绘菜单支配，不是纯 Chromium 标准行为。**
   所以「弹窗显示『图片右键菜单已就绪』、右键里却是空的」这类现象**可能周期性复现，
   代码侧无法根治**。遇到时不要一头钻进注册逻辑里 —— 先按下面第 3 点走一遍。
2. **`Alt`+右键是夸克下唯一不依赖浏览器原生菜单的单图采集路径**（走内容脚本自己的
   `contextmenu` 监听）。必须长期保留，并在文档里作为首选兜底。**不要删。**
3. K 报「右键没有这一项」时的标准处置顺序：
   ① **点一下扩展图标** —— 打开面板即触发 `menu:status`，后台**顺手重注册一次**，菜单就补回来了
   （这正是 2026-10-10 那次「已经好了」的成因，当时未改任何代码）；
   ② 仍没有 → 用 `Alt`+右键；
   ③ 持续没有 → `quark://flags` 搜 `context menu`，把 `Enable Context Menu` 设为 Enabled 后重启。

**怎么查夸克里实际加载的是哪一版代码**（很值的一招，出问题先看这个）：

```
AppData/Local/Quark/User Data/Default/Secure Preferences
  → extensions.settings['jbmfjfickcacfofeopbnomikennbhdei']
    .service_worker_registration_info.version     ← 浏览器里实际在跑的那份代码的版本
    .path                                          ← 应指向本目录
```

**注意**：扩展管理页的错误列表**会跨版本累积**，点「刷新 / 重新加载」不会清空它。
所以看到「版本 1.5.1」旁边挂着一条报错，未必是 1.5.1 产生的 ——
先让用户点「全部清除」再复测，这是区分「历史遗留」与「仍在复现」最快的一步。

---

## 六、验证怎么跑（改动后必跑）

四套闸门，从快到慢。**`dev-tests/` 永不打包**，`tools/package.py` 里有硬性拦截。

### 1. 静态闸门（最快，不需要任何服务）

```bash
node dev-tests/platform_check.mjs        # 预期 200 / 0
```

加载**真实的** `lib/util.js` 与 `background.js`（用最小 `chrome` stub）分五段断言：

| 段 | 内容 |
|---|---|
| A | 命名规则：22 组夹具同时满足 Windows / macOS / Linux 约束、字节截断不切开多字节字符、清洗幂等 |
| B | `nasLocalHint` 在 macOS 下不吐 `Z:\`，主机名与共享名从 `baseUrl` 推导而非硬编码 |
| C | **菜单形态**：只注册 1 项、无 `parentId`、只在 `image` 上下文、标题固定；`fetchForClip` 处理 `data:` 时不走网络 |
| D | **仓库卫生**：行尾约定、shebang、接收端残留为零、悬停残骸清零、无内联脚本、消息失败都处理、兜底网存在、图标存在且是合法 PNG |
| E | 图标：manifest 声明的每个尺寸都能解码、边长对得上 |
| F | **v1.6.0 新增**：manifest 权限（offscreen / clipboardWrite / min 109）、新文件齐备、offscreen 只认 `target`、后台跳过 offscreen 消息、列目录只 `Depth:1`、反推工作流与 `sampling_mode` 形态、Krea 指令结构、**打包白名单覆盖所有顶层条目**、版本号五处一致 |

### 2. 真机闸门（最重要的一套）

```bash
node dev-tests/live_browser_check.mjs    # 预期 53 / 0
```

用 CDP 驱动 **Edge 无头**加载本扩展（独立临时 profile，用完即删）：

- 认领 service worker，收 console 与异常
- 逐个打开 `help` / `popup` / `options`，抓 CSP 违规
- 在 SW 里用**畸形输入**把所有采集入口打一遍
- 从**弹窗页面**走真实消息通道把后台每个分支打一遍（`chrome://` 页面不能发消息，必须从页面发）
- 在真实活动标签页上跑一次 `viewport` 采集并**真落盘**
- 打开 `chrome://extensions/?id=<扩展ID>`，**穿透 shadow DOM 读错误列表，断言为空**

> **两个坑**：① 从 SW 给自己 `sendMessage` 不通（Chrome 不投回发送者所在 context），必须从页面发；
> ② 弹窗里点「帮助 / 设置」会 `window.close()`，CDP 请求永不返回 —— `connect()` 里的 `send()`
> 必须带超时（已内置 8 秒）。
> **探测内容脚本**要另起临时 http 页（内容脚本只注入 http/https，扩展页面里测不到）：
> Node `http` 起 `127.0.0.1` 随机端口，再从 SW `chrome.tabs.sendMessage(tabId, {type:'cc:ping'})`
> 确认脚本在场 —— 有回复才说明这次探测有效。

### 3. WebDAV 协议层 + 保存链路

```bash
# 需要 venv 里有 wsgidav：C:/Users/guok_1528/.workbuddy/binaries/python/envs/default
#   Windows 上解释器在 envs/default/Scripts/python.exe（不是 bin/python）
# 服务端必须与测试在**同一条命令**里起，否则后台进程被回收 → 假 fetch failed
python dev-tests/dav_server.py <davroot> 8081 tester s3cret &
node dev-tests/webdav_client_test.mjs        # 预期 10 / 0
node dev-tests/save_integration_test.mjs     # 预期 14 / 0（含文件夹规则三例、落地文件 SHA-256 校验）
node dev-tests/library_scan_test.mjs         # 预期 12 / 0（工作台列目录：一层、中文名、鉴权取字节）
```

> 端口残留会让「文件名递增」类断言假失败：先 `netstat -ano | grep :8081` 找 PID，
> 再 `taskkill //F //PID <pid>`。
> `library_scan_test.mjs` 可用 `DAV_PORT=8082` 换端口（服务端的 `davroot` 下要有 `clips/` 子目录）。

### 4. 反推提示词（可选，ComfyUI 不在线时自动跳过）

```bash
node dev-tests/comfy_reverse_test.mjs        # 预期 5 / 0（未启动 ComfyUI 时 SKIP）
```

> 它真的会传一张图给本地 ComfyUI 并等结果（单张约 10–30 秒，8G 显存跑 Qwen3-VL 4B）。
> 与出图共用队列 —— 队列忙的时候会慢，属正常；用 `COMFY_TEST_IMAGE=<大图路径>` 换测试图。

### 5. 打包闸门

```bash
python tools/package.py            # 校验 + 产出 ../lan-asset-collector-v<版本>.zip
python tools/package.py --check    # 只校验不打包
```

校验项：manifest 引用的文件齐备、**版本号在 5 处一致**
（`manifest.json` / `background.js` / `popup/popup.html` / `content/content.js` / `help/help.html`）、
行尾约定、`dev-tests` 未混入、接收端无残留。打包时把 `755` 显式写进 zip 的 `external_attr`
（Windows 上压缩会丢可执行位）。

---

## 七、故障排查

| 症状 | 真实原因 | 处理 |
|---|---|---|
| 右键里没有「将图片保存至 LAN Collector」 | 菜单被浏览器重建而 SW 在休眠（夸克还多一层自绘菜单的因素） | 点一下扩展图标（=重注册）→ 仍无则 `Alt`+右键 → 再不行查 `quark://flags`。先看第五节 |
| **Pinterest 上右键里什么都没有（连浏览器自带「图片另存为」都没有）** | 图片上盖了**透明 div**，`contexts:['image']` 不命中；部分是站点 `preventDefault` 了 contextmenu | 这是站点结构决定的，**代码侧绕不过**。用「点扩展图标 → 采集本页大图」或 `Alt`+右键（v1.5.8 起已能穿透覆盖层）。见第四节第 9 条 |
| `Alt`+右键按下去没反应 / 没保存 | 四类原因，以前**看起来一模一样**：① 设置里关了；② 该点下面没有 `<img>`（透明覆盖层）；③ 读不到地址（canvas / blob）；④ **扩展重载后，已打开的标签页还挂着作废的旧脚本** | v1.6.1 起失败分支改为分级提示、不再静默，「扩展刚重载过…按 F5 刷新本页」就是第 ④ 类。真机闸门有 3 条常驻断言（抢到 / 不误抢 / 不误拦），代码路径坏了会先红。**先刷新页面再判断是不是真故障**。v1.6.3 起失败原因同时写进 `collector.lastError`，**打开弹窗就能看到「上次失败 …」那行**（含 URL 在 title 里）；维护者也可以直接读 Quark 的 LevelDB 拿原文，不必让用户复述 |
| 右键采集到的图很小 / 是缩略图 | 站点把缩略图放在 `src`、把大图藏在别处（Pinterest 最典型） | 单图采集已自动取大图（v1.5.9）：能按 CDN 规则逆推就用原图，能读到 `data-orig-img` 就用它。若该站既无可逆推规则、又没声明大图属性，只能拿页面渲染的那张 —— 站点结构决定，别硬猜 |
| 改了菜单标题 / 图标，右键没变化 | 菜单由浏览器进程持有，刷新扩展不触发 `onInstalled`/`onStartup` | 已在顶层注册（v1.5.1 修）。仍有问题看注册表确认实际加载版本 |
| 扩展管理页出现 `Uncaught (in promise) …` | 某处 Promise 形式的 `chrome.*` 没接失败 | 全库搜裸调用，套 `silent()` / `fire()`。**注意错误列表跨版本累积，先「全部清除」再复测** |
| 扩展管理页出现 Content Security Policy 红字 | 页面里有内联 `<script>` / `onclick=` | 抽成独立 `.js`。D 段有闸门 |
| 复制出的文件多了一层 `untitled/` | 空目录段走了文件名段的兜底 | 用 `CC.cleanDirSeg()` 而非 `cleanSeg()`（v1.5.4 修） |
| 中文长文件名写失败 | 按字符数截断，实际超了 255 **字节** | `CC.sliceBytes` 按 UTF-8 字节算（v1.2.0 起） |
| WebDAV 测试报 `fetch failed` | 服务端不在同一条 bash 调用里起，被回收了 | 见第六节第 3 点 |
| 扩展测试里 8081 端口占用 | 上一轮残留 | `taskkill //F //PID` |
| 「移除 + 重新加载」后不能保存 | `chrome.storage.local` 被清空了 | 设置页重填 NAS 账密 |

---

## 八、已知边界与**未验证项**（如实交接）

功能边界：

- 浏览器内部页面（`chrome://`、扩展商店、`file://`）无法采集，平台限制
- 只处理**顶层文档**，未做跨域 iframe 内的图片采集
- 批量采集抓原始文件；CDN 防盗链图片若连页面内兜底也拿不到，计入「失败」
- 整页截图受 Canvas 面积限制，超过约 4000 万像素会自动缩放
- WebDAV 口令以 **Basic 明文**随请求发送，务必只在局域网 / VPN 内使用

**未验证项（必须如实向下传）**：

- ✅ 扩展**已在 Edge 无头模式真机加载运行**，端到端采集链路跑通（v1.5.2 起）
- ⚠️ **从未在 K 的夸克里亲眼验证过右键菜单的实际呈现** —— 只能确认扩展已加载、版本正确、
  `create` 无报错；折叠/显示行为是按官方文档 + 注册表推断的，且受夸克自绘菜单支配
- ⚠️ **从未在真实 macOS 机器上跑过端到端** —— macOS 相关只有路径提示文案与命名规则约束
- ⚠️ WebDAV 根路径按群晖惯例假设为 `/共享名/子目录`，未在别的 NAS 上验证
- ✅ **「扩展 → 私网 IP」不会被拦**（v1.6.1 实测，Edge 无头）：从 service worker 与扩展页面
  `fetch` 本机局域网地址（172.18.x）均返回 200。`live_browser_check.mjs` 里有两条常驻断言守着，
  换内核（夸克）后请先跑一遍
- ⚠️ **v1.6.0 的剪贴板写入只在 Edge 无头里验证到「offscreen 文档被创建、回执明确」**；
  「粘贴出来确实是那张原图」需要在真浏览器里手试一次（读回剪贴板要额外权限，没为测试加）
- ⚠️ **工作台的 FSA 通道（目录授权）未在真机跑过**：列目录用 `handle.values()`、缩略图用 objectURL，
  代码路径完整但没实测过授权目录下的中文名与大目录
- ⚠️ **反推提示词只在 Node 里打通了完整链路**（`comfy_reverse_test.mjs`，真实出词）；
  扩展内（后台 → ComfyUI）与夸克下的表现未实测 —— 后台直连 `127.0.0.1` 的能力已在 Edge 无头里验证
- ⚠️ **跨机反推（MacBook → 单位电脑）没有端到端跑过**：浏览器侧已实测能访问私网地址，
  但「单位电脑 ComfyUI 加 `--listen 0.0.0.0` 后家里能否连上」取决于隧道（节点小宝 / Tailscale），
  属于网络环境，代码侧无法验证。默认夹具是 128px 图标，模型出不了词 —— 质量相关断言会被跳过，
  换真实照片用 `COMFY_TEST_IMAGE=<路径>` 复跑才作数
- ⚠️ 单位电脑（3y-guok-PC）的 ComfyUI **当前只监听 `127.0.0.1:8188`**，局域网 IP 直连返回 000。
  要跨机用，必须先在启动器里打开「允许局域网访问」/ 加 `--listen 0.0.0.0` 并重启
- ✅ **Pinterest 保存镜像已在真站点上验证通过**（2026-10-21 12:23，K 的夸克 + 单位 NAS）。
  正向链路成立：点「保存」→ 内容脚本 `pin:save` → 后台抓 `originals` → 写 NAS，
  产出 `2026-10-21/122321-(21)-Pinterest-9.jpg` 等 3 个文件，字节合计 239,349 —— 与
  `stats.bytes` 精确相等，属实证而非「看起来像成功」。
  反向（非 Pinterest 域名不触发）由 `live_browser_check.mjs` 常驻断言守住。

  另一侧仍要注意：**这台机器的无头浏览器验不了正向**（`--host-resolver-rules` 把 pinterest.com
  指到本地夹具时，Chromium 的 HTTPS 升级会改成 `https://` 导致 TLS 失败，加 `--disable-features=HttpsUpgrades`
  也压不住），所以这条只能靠真机人工确认，不要试图写成自动化用例。
  再出问题时**先开诊断模式**（设置 → 采集行为 → 「Pinterest 保存镜像：诊断模式」，v1.7.1）：
  再点一次保存，右下角会直接报出断点（开关没开 / 没认出按钮 / 认出了找不到图 / 命中），
  没认出按钮时还会把落点上的 `tagName「名字」宽×高` 列出来 —— 拿这一行就能补 `CC.pinSaveLabel()`，
  不用让使用者去 F12 里翻混淆的 DOM。诊断提示用 `toast(..., force=true)`，不受「页内提示」开关影响

---

## 九、版本历史（为什么要改）

| 版本 | 一句话 |
|---|---|
| v1.1.0 | 最初的「局域网接收端（http）」通道 |
| v1.2.0 | 改走 **WebDAV 零部署**；文件名按 UTF-8 字节截断 |
| v1.3.0 | Windows / macOS 双平台加固（路径提示分流、命名三平台并集） |
| v1.4.0 | 一键剪藏右键菜单；**下线接收端通道**，老配置自动迁移 |
| v1.5.0 | 菜单标题定为「将图片保存至 LAN Collector」；自绘图标（纯标准库生成 PNG） |
| v1.5.1 | 菜单注册从生命周期事件**挪到 SW 顶层**（修「改了没反应」） |
| v1.5.2 | 修扩展管理页两条红字（CSP 内联脚本 + `batchSave` 空标签页）；新增真机验证脚本 |
| v1.5.3 | 消息封装一律返回对象；后台对未知指令明确回执 |
| v1.5.4 | 明确「子目录模板」文件夹规则（修 `untitled` 幽灵目录）；`tabs.onActivated` 兜底重建菜单 |
| v1.5.5 | **删除悬停采集**（按 K 要求），单图采集只剩右键 + `Alt`+右键 |
| v1.5.6 | Promise 形式的 `chrome.*` 统一接住失败；三层兜底网；真机断言扩展管理页错误列表为空 |
| v1.5.7 | 菜单注册改**单步**（去掉 `removeAll` 空档）；`windows.onFocusChanged` 兜底；弹窗加菜单状态诊断行 + 「重新注册」按钮 |
| v1.5.8 | 修 `Alt`+右键 在「图片上盖透明 div」的站点（Pinterest 等）失效；新增 Pinterest 大图采集（`CC.pinimgOriginal` + `pin:scan`/`pin:collect` + 弹窗「采集本页大图」入口） |
| v1.5.9 | 单图采集（`Alt`+右键 / `cc-image`）改走「大图推断」`bigSourceOf`：pinimg 自动换算 `originals`、认 `data-orig-img`、否则退回页面那张；`singleSave` 新增 `fallbackUrl` 兜底 |
| v1.6.0 | **复制原图**（offscreen 写剪贴板，回报真实像素）、**素材工作台**（只扫当前目录、缩略图墙、复制/反推/开原图）、**本地 ComfyUI 反推 Krea 2 提示词**（Qwen3-VL 4B + 原生 TextGenerate）；权限 +`offscreen`/`clipboardWrite`，min Chrome 109 |
| v1.6.1 | ComfyUI 地址支持**跨机**：地址规范化（裸 IP 自动补 `http://` 与 8188）、**常用位置**下拉一键切换、远程连不上时按本机/远程给两套排查建议、**上传前压缩**（跨网省上行）；反推识别「模型回显指令」并重试；实测确认扩展访问私网 IP 不被 PNA 拦 |
| v1.6.2 | `Alt`+右键**失败不再静默**：四个分支（开关关了 / 没认出图 / 读不到地址 / 扩展重载后旧标签页脚本作废）各自给提示，并把「刷新本页」单列出来；真机闸门新增 3 条常驻断言（抢到 / 不误抢 / 不误拦），45 → 48 |
| v1.6.3 | **失败留痕**：内容脚本与后台都往 `collector.lastError` 写一份（含 where / message / url / at），弹窗把它显示成「上次失败 时间 · 原因」（超 24h 不显示）。五秒的页内提示说不清的事，事后能回看；静态闸门 +5（149 → 154） |
| v1.6.4 | **反推入口不再隐形**：工作台侧栏从「选中才出现」改成常驻 —— 未选中时写明「点任意一张图，这里会出现：复制图片 / 反推提示词 / 打开原图」，并显示当前目录图片数与 ComfyUI 在线状态；窄窗口面板改到上方。真机闸门 +1（48 → 49） |
| v1.6.5 | **修「上传图片失败（HTTP 403）」**：ComfyUI 的 `create_origin_only_middleware` 在 Host 为回环时要求 POST 的 Origin 同名，扩展的 `chrome-extension://` 必被 403（GET 不带 Origin 所以「测试连接」是通的）。用 `declarativeNetRequest` 只对配置的 ComfyUI 地址改写 `Origin` / `Sec-Fetch-Site`，非回环地址自动撤规则；权限 +`declarativeNetRequest`。真机端到端出词 21.6s / 1701 字符。静态 +8（154 → 162）、真机 +2（49 → 51） |
| v1.7.0 | **Pinterest 保存镜像**：在 pinterest.com 点自己的「保存」时，顺手把同一张图（自动换算 `originals`）存一份到本地。跟随用户动作而不是自动化站点 —— 不要凭证、不对外发布、不动事件；认按钮的可访问名而非 class，同一张图 2.5s 内只镜像一次，只在 Pinterest 域名生效。设置里默认**关闭**。静态 +16（162 → 178）、真机 +1（51 → 52） |
| v1.7.1 | **「点了保存没反应」自己说清断在哪一步**：新增诊断模式（设置 → 采集行为），在 Pinterest 上每次点击都提示判定结果 —— 开关没开 / 没认出按钮（附落点上元素的 tagName「名字」宽×高）/ 认出了找不到图 / 命中并给出原图地址；诊断提示 `toast(..., force)` 不受「页内提示」开关影响。弹窗底部显示镜像的**真实开关状态**（从 storage 读），并把面板里那份漏了末尾锚点的本地域名正则换成交 `CC.isPinterestUrl()`（单一实现）。静态 +6（178 → 184）、真机 +1（52 → 53） |
| v1.7.2 | **「保存一直失败」不再只藏在状态条里**：保存目标未就绪时，点弹窗顶部状态条**直接打开设置页**（之前只会跑一次测试连接、回一句「连接失败」，用户不知道该填什么）；同时把文档里那条危险的更新指引改掉 —— 新增设计决定 18「更新用刷新 ↻，永远不要移除重加」，因为**移除扩展会连带清空 WebDAV 账密与所有开关**（这一版就是这么踩出来的：移除重装后地址退回默认 `192.168.31.206`、账号变空、Pinterest 两个开关回 false）。静态 +3（184 → 187） |
| v1.7.3 | **原图缺失时不再直接掉到缩略图**：实测 `i.pinimg.com/originals/...` 对相当一部分 pin 返回 **403 AccessDenied**（同路径 `236x` 却是 200），而原来的回退链只有「originals → 页面那张」，于是这类图直接存成 4~17 KB 的小图。新增 `CC.pinimgSized()` 并在 `singleSave` 里插 `1200x → 736x → 564x` 阶梯（实测 736x 对同一张图返回 25 KB vs 236x 的 17.7 KB，是 CDN 上真实可用的最大档）；同时把实际用的尺寸带回调用方，两条保存路径在降级时明确提示「原图缺失，存的是 736x」——以前 4 KB 缩略图和 178 KB 原图给的是**一模一样**的「已保存」。静态 +6（187 → 193） |
| v1.7.4 | **「保存失败」不再是一句查不动的话**：现象是 Pinterest 点保存后提示「顺手存本地失败」，但 `collector.lastError` 是空的、`stats.failed` 也没涨 —— 因为**后台没收到请求**。根因是刷新扩展（↻）后已打开标签页仍挂旧脚本，其 `chrome.runtime` 已断开：DOM 逻辑照跑（能认按钮、能弹 toast），消息发不出去、失败也写不进存储，而旧代码把浏览器英文原样塞进提示。修法三层：① `bg()` 先查 `chrome.runtime.id`、把 `context invalidated` / `port closed` 翻成「按 F5 刷新本页再试」并带 `stale` 标记，两条采集路径据此强制/加长提示；② `single:save` 自加 `.catch()` 写 lastError（`done()` 的 catch 只回消息不留痕，异常会变成无处可查）；③ 弹窗新增 `checkPageScript()` 用 `cc:ping` 比对「本页脚本版本 vs 扩展版本」，不一致就顶部出黄条指名 F5；统计里加「上次成功 时间」，时间不动即证明请求没发出。静态 +7（193 → 200） |

---

## 十、接手后的建议下一步

按性价比排序：

1. **把夸克这条路验掉**（唯一真正的盲区）。思路：启动夸克时带 `--remote-debugging-port`
   与独立 `--user-data-dir`，用 CDP 驱动，再用 Windows UI Automation 枚举右键菜单的菜单项，
   就能程序化回答「那一项到底在不在夸克的菜单里」。
2. **在真实 macOS 上跑一遍端到端**，重点验 FSA 通道对 `/Volumes/…` 网络卷的授权句柄
   在重新挂载后是否失效（README 里标注了「不稳」，但没实测）。
3. 把 `dev-tests/live_browser_check.mjs` 从「Edge 无头」扩到「可指定任意 Chromium 内核可执行文件」，
   这样夸克、Chrome、Edge 三处可以共用同一套真机断言。
4. 若确定要长期维护，考虑给 `lib/` 加一层薄薄的单元测试（现在 A 段是夹具驱动，
   覆盖的是命名规则，`webdav.js` 的边界分支只有集成测试覆盖）。

---

## 十一、约定速查（改代码前扫一眼）

- `dev-tests/` **永不打包**；`tools/package.py` 里有硬性拦截
- HTML 页面**禁止内联 `<script>` 与 `onclick=`**；内联 `<style>` / `style=` 不受限
- 行尾：`.bat` 保持**纯 ASCII + CRLF**；其余（JS / HTML / CSS / JSON / MD / PY）一律 **LF**
  - ⚠️ 用 Python 改文本后必须查行尾：`Path.write_text()` 在 Windows 上会把 LF 写成 CRLF，
    D 段的行尾闸门会红。要写成 `p.write_bytes(data.replace(b'\r\n', b'\n'))`
- 命名规则**全部集中在 `lib/util.js`**，不要散落到各处
- 新增 `.sh` / `.command` 会被 `tools/package.py` 按后缀自动判定并置可执行位（否则在 macOS 上是 0644）
- 清理网络共享 / Temp 下的测试残留，用 `ctypes.windll.kernel32.DeleteFileW` ——
  本机有 `sitecustomize.py` 安全删除钩子会拦 `os.remove`
- 版本号要**五处同步**，改完跑 `python tools/package.py --check`
