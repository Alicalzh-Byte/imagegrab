# 图提取 ImageGrab

Chrome 浏览器扩展（Manifest V3）：在**淘宝 / 天猫 / 京东 / 拼多多商家版**的商品详情页一键提取所有商品图片，
在独立页面中集中预览、自由勾选，并批量下载为 **PNG**。

官网（GitHub Pages）：<https://alicalzh-byte.github.io/imagegrab/>

## 仓库结构

```
docs/                    官方宣传站（GitHub Pages 从 main 分支的 /docs 目录发布）
├─ index.html
├─ css/style.css
├─ js/main.js
└─ assets/favicon.svg

ecom-image-extractor/    扩展源码
├─ manifest.json         MV3 清单：权限、域名匹配、内容脚本注册
├─ content.js            内容脚本：详情页判定 + 悬浮按钮 + 图片提取
├─ content.css           悬浮按钮与轻提示样式
├─ background.js         Service Worker：消息转发、结果持久化、下载状态回传
├─ gallery.html/js/css   预览页：网格展示、勾选、转 PNG、批量下载
├─ icons/                扩展图标 16 / 32 / 48 / 128
├─ tools/                零依赖 PNG 编码器 + 图标生成脚本
└─ test/                 本地自测页与静态服务
```

## 安装扩展

1. 下载本仓库（`Code` → `Download ZIP`）并解压到本地文件夹。
2. 打开 Chrome，地址栏输入 `chrome://extensions` 回车。
3. 打开右上角「开发者模式」（Edge 在左侧边栏）。
4. 点击「加载已解压的扩展程序」，选择 `ecom-image-extractor` 目录（含 `manifest.json` 的那一层）。
5. 打开商品详情页，右下角出现紫色「获取图片」悬浮按钮，点击即可提取。

## 扩展图标

图标（16 / 32 / 48 / 128）由 `tools/make-icons.js` 生成。若需重新生成（例如改了配色或图标缺失）：

```bash
cd ecom-image-extractor
node tools/make-icons.js
```

只需要 Node.js，无任何第三方依赖。

## 本地自测

`test/` 下有一套可复现的测试设施，模拟电商详情页的各种图片形态（懒加载、srcset、背景图、平台尺寸后缀等）：

```bash
cd ecom-image-extractor
node test/serve.js 8088
# 浏览器打开 http://localhost:8088/test/selftest.html
```

自测页会断言平台判定、原图还原、相对路径补全、去重、过滤规则等 36 项，并直接显示 `PASS / FAIL` 结果。

## 官网本地预览

直接双击 `docs/index.html` 即可（纯静态，无构建步骤）。

修改主色调：编辑 `docs/css/style.css` 中 `:root` 下的 `--primary` 与 `--gradient`。
