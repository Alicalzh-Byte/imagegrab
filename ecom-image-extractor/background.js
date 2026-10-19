/**
 * 电商图片提取下载器 —— Service Worker（后台）
 *
 * 职责：
 *   1. 接收内容脚本发来的图片列表 → 存入 chrome.storage.local → 打开 gallery 预览页
 *   2. 处理预览页发来的「按原始地址下载」请求（PNG 转码失败时的兜底路径）
 *   3. 监听 chrome.downloads 状态变化，把下载结果回传给预览页做进度反馈
 *   4. 点击工具栏图标时打开预览页，查看上一次的提取结果
 *
 * 为什么 PNG 转码不放在这里：
 *   MV3 的 Service Worker 中不存在 URL.createObjectURL / FileReader，且 SW 可能在长时间
 *   异步任务（下载大图）中被回收，不适合承担图像解码与编码。因此转码在预览页（gallery.js）
 *   中完成，本文件只负责不需要图像数据的「按 URL 下载」兜底与消息转发。
 */

const STORE_KEY = 'eie_payload';
const GALLERY_PATH = 'gallery.html';

/** 打开（或聚焦）预览页 */
function openGallery() {
  chrome.tabs.create({ url: chrome.runtime.getURL(GALLERY_PATH) });
}

/** 向所有扩展页面广播消息；没有接收方时静默忽略 lastError */
function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, function () {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    /* 预览页未打开时忽略 */
  }
}

/** 持久化提取结果（Promise 化） */
function savePayload(payload) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.set({ [STORE_KEY]: payload }, function () {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * 按原始地址下载。
 * chrome.downloads.download 不依赖 host_permissions，所以即使图片域名不在授权列表里也能下载，
 * 这正好作为「无法转 PNG」时的兜底方案。
 */
function downloadByUrl(url, filename) {
  return new Promise(function (resolve, reject) {
    chrome.downloads.download({ url: url, filename: filename, saveAs: false }, function (id) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

/* ---------------- 消息转发 ---------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return undefined;

  // 内容脚本 → 后台：收到图片列表
  if (msg.type === 'IMAGES_COLLECTED') {
    (async function () {
      try {
        const payload = msg.payload || {};
        if (!Array.isArray(payload.images) || payload.images.length === 0) {
          sendResponse({ ok: false, error: '图片列表为空' });
          return;
        }

        // 落盘保存：预览页刷新或 SW 重启后依然能读到，避免只靠消息传递导致数据丢失
        await savePayload(Object.assign({}, payload, { receivedAt: Date.now() }));
        openGallery();
        sendResponse({ ok: true, count: payload.images.length });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // 异步响应，保持消息通道打开
  }

  // 预览页 → 后台：转码失败的兜底下载
  if (msg.type === 'DOWNLOAD_ORIGINAL') {
    (async function () {
      try {
        const id = await downloadByUrl(msg.url, msg.filename);
        sendResponse({ ok: true, downloadId: id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  return undefined;
});

/* ---------------- 下载状态回传（进度 / 结果反馈） ---------------- */

chrome.downloads.onChanged.addListener(function (delta) {
  if (!delta || !delta.state) return;
  const state = delta.state.current;
  if (state === 'complete' || state === 'interrupted') {
    broadcast({ type: 'DOWNLOAD_STATE', downloadId: delta.id, state: state });
  }
});

/* ---------------- 工具栏图标：打开预览页 ---------------- */

chrome.action.onClicked.addListener(function () {
  openGallery();
});
