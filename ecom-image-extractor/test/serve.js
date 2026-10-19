/**
 * 本地测试用静态服务（无第三方依赖）
 *
 * 用途：
 *   1. 把扩展根目录作为静态目录提供出去，使 /content.js、/content.css 可被测试页加载
 *   2. 任意 /img/** 路径都动态返回一张 PNG，尺寸从路径里的「宽x高」解析，解析不到则用 600x600
 *      —— 这样测试页可以精确控制「每张图有多少像素」，从而验证尺寸过滤与懒加载逻辑
 *
 * 用法：node test/serve.js [端口]   （默认 8088）
 * 访问：http://localhost:8088/test/selftest.html
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { solidPng } = require('../tools/png.js');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8088;
const DEFAULT_SIZE = 600;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/** 从路径里取第一个「宽x高」，例如 /img/900x700.png_430x430q90.jpg → 900x700 */
function sizeFromPath(urlPath) {
  const m = /(\d{2,5})x(\d{2,5})/.exec(urlPath);
  if (!m) return { w: DEFAULT_SIZE, h: DEFAULT_SIZE };
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** 由尺寸推一个颜色，方便肉眼区分不同图片 */
function colorFor(w, h) {
  return [(w * 3) % 156 + 60, (h * 5) % 156 + 60, (w + h) % 156 + 60];
}

/** 返回一张 PNG */
function sendPng(res, urlPath) {
  const size = sizeFromPath(urlPath);
  const buf = solidPng(size.w, size.h, colorFor(size.w, size.h));
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

/** 返回静态文件 */
function sendFile(res, urlPath) {
  const rel = urlPath === '/' ? '/test/selftest.html' : urlPath;
  const file = path.join(ROOT, rel);

  // 防目录穿越：必须落在扩展根目录内
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, function (err, buf) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    urlPath = req.url;
  }

  if (urlPath.indexOf('/img/') === 0) {
    sendPng(res, urlPath);
    return;
  }
  sendFile(res, urlPath);
});

server.listen(PORT, function () {
  console.log('测试服务已启动：http://localhost:' + PORT + '/test/selftest.html');
  console.log('图片动态生成：/img/<宽>x<高>.png（例如 /img/800x600.png）');
});
