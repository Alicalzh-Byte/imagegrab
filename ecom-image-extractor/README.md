# 电商图片提取下载器（Chrome 扩展 · Manifest V3）

在淘宝 / 天猫 / 京东 / 拼多多商家版的**商品详情页**右下角注入一个「获取图片」悬浮按钮，
点击后扫描页面内的商品图片，在独立页面中集中预览、勾选，并批量下载为 **PNG**。

## 文件结构

```
ecom-image-extractor/
├─ manifest.json      # MV3 清单：权限、域名匹配、内容脚本注册
├─ content.js         # 内容脚本：详情页判定 + 悬浮按钮 + 图片提取
├─ content.css        # 悬浮按钮 / 轻提示样式（带 eie- 前缀 + !important 防污染）
├─ background.js      # Service Worker：消息转发、结果持久化、打开预览页、下载状态回传
├─ gallery.html       # 预览页结构
├─ gallery.js         # 预览页逻辑：网格渲染、勾选、转 PNG、批量下载
├─ gallery.css        # 预览页样式（响应式网格）
├─ icons/             # 16 / 32 / 48 / 128 图标（由 tools/make-icons.js 生成）
└─ tools/             # 构建与测试辅助脚本（不参与扩展运行）
   ├─ png.js          # 零依赖 PNG 编码器
   ├─ make-icons.js   # 生成扩展图标
   └─ ../test/serve.js + test/selftest.html   # 本地自测服务与自测页
```

## 安装（加载未打包扩展）

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车。
2. 右上角打开「**开发者模式**」。
3. 点击「**加载已解压的扩展程序**」，选择本目录 `ecom-image-extractor`（含 manifest.json 的那一层）。
4. 加载成功后扩展列表会出现「电商图片提取下载器」，建议点击工具栏拼图图标把它**固定**到工具栏。

> 若图标未显示：确认 `icons/` 下有 16/32/48/128.png；可执行 `node tools/make-icons.js` 重新生成。

## 使用

1. 打开淘宝 / 天猫 / 京东 / 拼多多商家版的**商品详情页**（列表页、首页不会显示按钮）。
2. 页面右下角出现紫色「**获取图片**」按钮，点击它。
3. 自动打开「商品图片预览」页：
   - 顶部：`全选` / `反选` / `已选 N / 共 M` / `下载选中`
   - 每张图：缩略图 + 尺寸信息 + 来源 + 复选框
4. 勾选需要的图片 → 点「下载选中」→ 进度条与逐张状态徽标实时更新 → 完成后顶部给出结果汇总。
5. 文件保存到浏览器**默认下载目录**，命名为 `商品图_001.png`、`商品图_002.png`……（序号补零，按勾选顺序）。

## 实现要点

- **只在详情页生效**：`detectContext()` 同时校验「域名 + 详情页路径特征」，拼多多商家后台路径不固定时用 DOM 特征兜底；非详情页不注入按钮。
- **尽量还原原图**：淘宝/天猫剥离 `xxx.jpg_430x430q90.jpg` 尺寸后缀；京东 `/n1/`→`/n0/` 并去掉 `s450x450_` 缩放前缀；拼多多去掉七牛 `imageView2` 处理参数。多个尺寸变体因此自然合并为一条（去重）。
- **懒加载兼容**：同时采集 `data-src` / `data-lazy-src` / `data-original` / `data-lazy-img` / `data-ks-lazyload`（淘宝）/ `data-actualsrc` 等 11 种属性，以及 `srcset`、`<picture><source>`、CSS `background-image`。
- **过滤规则**：剔除 1x1 像素图、`logo` / `icon` / `placeholder` / `sprite` / `avatar` 等装饰图、SVG，以及短边小于 100px 的图片。
- **尺寸判断的细节**：只有当候选地址就是元素当前已加载的那张图时才用 `naturalWidth/Height` 判断；懒加载尚未替换时尺寸视为未知并保留，避免误杀真实商品图。
- **转 PNG 放在预览页而非 Service Worker**：MV3 的 SW 里没有 `URL.createObjectURL` / `FileReader`，且会在长时间异步任务中被回收。预览页是扩展页面，凭 `host_permissions` 可跨域 `fetch`，再用 `createImageBitmap` + `canvas` 转 PNG。
- **兜底策略**：个别图片若无法转码（跨域未授权、特殊格式），自动改为「按原始地址下载」并在卡片上标注，保证至少拿到原图（`chrome.downloads.download` 不依赖 host 权限）。

## 本地自测

`test/` 下有一套可复现的测试设施（模拟电商详情页的各种图片形态）：

```bash
cd ecom-image-extractor
node test/serve.js 8088     # 启动本地静态服务 + 动态 PNG 生成
# 浏览器打开 http://localhost:8088/test/selftest.html
```

自测页会调用 `content.js` 暴露的 `window.__EIE__` 纯函数，断言平台判定、原图还原、相对路径补全、去重、过滤规则等 30+ 项；页面会直接显示 `PASS/FAIL` 数量与逐条结果。

## 已知边界

- 需在真实 Chrome 中加载扩展后，`chrome.*` API 才可用；`test/selftest.html` 只验证提取逻辑，不验证下载链路。
- 平台页面结构会变，`PLATFORM_RULES` 里的详情页路径特征（如 `item.htm`、`/npcitem`）需按实际页面按需补充。
- 图片列表存于 `chrome.storage.local`（键 `eie_payload`），刷新预览页不会丢数据；新一次提取会覆盖上一次结果。
