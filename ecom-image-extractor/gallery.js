/**
 * 商品图片预览页逻辑
 *
 * 流程：
 *   读取 chrome.storage.local 中的提取结果 → 网格渲染缩略图 + 尺寸 + 复选框
 *   → 勾选后点击「下载选中」→ 逐张 fetch → 解码 → canvas 转 PNG → chrome.downloads 保存
 *
 * 为什么转码放在这里而不是后台：
 *   本页是扩展页面，拥有完整 DOM / canvas / URL.createObjectURL，且凭 host_permissions
 *   可直接跨域 fetch 图片（不受 CORS 限制），是唯一能稳定完成「图片 → PNG」的位置。
 */
(function () {
  'use strict';

  const STORE_KEY = 'eie_payload';
  const CONCURRENCY = 3; // 并发下载数，过高会占用大量内存
  const FILENAME_PREFIX = '商品图_';

  /** 选中的图片索引集合 */
  const selected = new Set();
  let images = [];
  let downloading = false;

  const $ = function (id) {
    return document.getElementById(id);
  };

  /* ---------------- 通用工具 ---------------- */

  /** chrome.storage.local.get → Promise */
  function storageGet(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(key, function (data) {
        void chrome.runtime.lastError;
        resolve(data && data[key]);
      });
    });
  }

  /** chrome.runtime.sendMessage → Promise */
  function sendMessage(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /** chrome.downloads.download → Promise */
  function downloadsDownload(options) {
    return new Promise(function (resolve, reject) {
      chrome.downloads.download(options, function (id) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
  }

  /** 序号补零：1 → 001 */
  function pad(n) {
    return String(n).padStart(3, '0');
  }

  /** 从地址中猜扩展名，用于兜底下载时的文件名 */
  function guessExt(url) {
    const m = /\.(jpe?g|png|webp|gif|bmp|avif)(?:$|\?|#)/i.exec(url);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }

  /* ---------------- 图片转 PNG ---------------- */

  /**
   * 下载图片并统一编码为 PNG。
   * 解码优先用 createImageBitmap，失败时退回 <img> 方式（兼容 SVG 等）。
   * @param {string} url
   * @returns {Promise<Blob>} PNG Blob
   */
  async function convertToPng(url) {
    const resp = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const blob = await resp.blob();
    if (!blob || blob.size === 0) throw new Error('文件为空');
    if (/^text\/html|^application\/json/i.test(blob.type || '')) throw new Error('返回内容不是图片');

    let source = null;
    let cleanup = function () {};

    if (typeof createImageBitmap === 'function') {
      try {
        source = await createImageBitmap(blob);
        cleanup = function () {
          if (source && typeof source.close === 'function') source.close();
        };
      } catch (e) {
        source = null; // 退回 <img> 路径
      }
    }

    if (!source) {
      const objUrl = URL.createObjectURL(blob);
      source = await new Promise(function (resolve, reject) {
        const node = new Image();
        node.onload = function () {
          resolve(node);
        };
        node.onerror = function () {
          reject(new Error('图片解码失败'));
        };
        node.src = objUrl;
      });
      // 必须等 canvas 绘制完成后再释放，否则图像会失效
      cleanup = function () {
        URL.revokeObjectURL(objUrl);
      };
    }

    const w = source.width || source.naturalWidth || 0;
    const h = source.height || source.naturalHeight || 0;
    if (!w || !h) {
      cleanup();
      throw new Error('图片尺寸无效');
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);

    const png = await new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b);
        else reject(new Error('PNG 编码失败'));
      }, 'image/png');
    });

    cleanup();
    return png;
  }

  /**
   * 下载单张图片。
   * 成功 → 保存 PNG；转码失败 → 交给后台按原始地址下载（并标注原因）。
   * @param {{url:string}} item
   * @param {number} seq 文件名序号
   * @returns {Promise<{status:'ok'|'fallback'|'fail',filename?:string,reason?:string}>}
   */
  async function downloadOne(item, seq) {
    const baseName = FILENAME_PREFIX + pad(seq) + '.png';

    try {
      const png = await convertToPng(item.url);
      const objUrl = URL.createObjectURL(png);
      try {
        await downloadsDownload({ url: objUrl, filename: baseName, saveAs: false });
      } finally {
        // 延迟释放：确保下载任务已开始读取该 blob
        setTimeout(function () {
          URL.revokeObjectURL(objUrl);
        }, 120000);
      }
      return { status: 'ok', filename: baseName };
    } catch (e) {
      // 兜底：按原始地址下载（可能是跨域未授权或特殊格式），保证用户至少拿到原图
      const filename = FILENAME_PREFIX + pad(seq) + '.' + guessExt(item.url);
      const res = await sendMessage({ type: 'DOWNLOAD_ORIGINAL', url: item.url, filename: filename });
      if (res && res.ok) {
        return { status: 'fallback', filename: filename, reason: e.message };
      }
      return { status: 'fail', reason: (res && res.error) || e.message };
    }
  }

  /* ---------------- 渲染 ---------------- */

  function updateCount() {
    $('countInfo').textContent = '已选 ' + selected.size + ' / 共 ' + images.length;

    const allChecked = images.length > 0 && selected.size === images.length;
    const someChecked = selected.size > 0 && !allChecked;
    const checkAll = $('checkAll');
    checkAll.checked = allChecked;
    checkAll.indeterminate = someChecked;

    $('btnDownload').disabled = downloading || selected.size === 0;
    $('btnDownload').textContent = downloading
      ? '下载中…'
      : selected.size
        ? '下载选中（' + selected.size + '）'
        : '下载选中';
  }

  function renderGrid() {
    const grid = $('grid');
    grid.textContent = '';

    const frag = document.createDocumentFragment();

    images.forEach(function (item, index) {
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.index = String(index);

      // 复选框
      const checkLabel = document.createElement('label');
      checkLabel.className = 'card-check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.index = String(index);
      box.checked = selected.has(index);
      box.addEventListener('change', function () {
        if (box.checked) selected.add(index);
        else selected.delete(index);
        updateCount();
      });
      checkLabel.appendChild(box);

      // 缩略图
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '商品图 ' + pad(index + 1);
      img.src = item.url;
      thumb.appendChild(img);

      // 状态徽标（下载过程中显示）
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.role = 'badge';
      thumb.appendChild(badge);

      // 信息区
      const info = document.createElement('div');
      info.className = 'info';

      const sizeText = item.known && item.width && item.height
        ? item.width + ' × ' + item.height
        : '尺寸未知';
      const sizeEl = document.createElement('span');
      sizeEl.className = 'size';
      sizeEl.textContent = sizeText;

      const srcEl = document.createElement('span');
      srcEl.className = 'source';
      srcEl.textContent = item.source || '未知来源';

      info.appendChild(sizeEl);
      info.appendChild(srcEl);

      // 原始地址链接
      const link = document.createElement('a');
      link.className = 'link';
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = item.url;
      link.textContent = item.url;

      card.appendChild(checkLabel);
      card.appendChild(thumb);
      card.appendChild(info);
      card.appendChild(link);

      frag.appendChild(card);
    });

    grid.appendChild(frag);
  }

  function setItemStatus(index, status, text) {
    const card = $('grid').querySelector('.card[data-index="' + index + '"]');
    if (!card) return;
    const badge = card.querySelector('[data-role="badge"]');
    if (!badge) return;
    badge.className = 'badge' + (status ? ' badge--' + status : '');
    badge.textContent = text || '';
  }

  /* ---------------- 下载主流程 ---------------- */

  function setProgress(done, total, text) {
    $('progressWrap').hidden = false;
    $('progressFill').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    $('progressText').textContent = text;
  }

  async function downloadSelected() {
    if (downloading) return;

    const list = Array.from(selected).sort(function (a, b) {
      return a - b;
    });
    if (!list.length) return;

    downloading = true;
    updateCount();
    $('summary').hidden = true;

    // 文件名序号按「选中顺序」从 1 开始
    const seqOf = new Map();
    list.forEach(function (index, i) {
      seqOf.set(index, i + 1);
    });

    const results = { ok: 0, fallback: 0, fail: 0 };
    const failures = [];
    let done = 0;

    setProgress(0, list.length, '准备开始下载…');

    // 简单并发池：固定 CONCURRENCY 个 worker 从队列里取任务
    const queue = list.slice();
    async function worker() {
      while (queue.length) {
        const index = queue.shift();
        const item = images[index];

        setItemStatus(index, 'processing', '处理中');

        let result;
        try {
          result = await downloadOne(item, seqOf.get(index));
        } catch (e) {
          result = { status: 'fail', reason: e.message };
        }

        if (result.status === 'ok') {
          results.ok++;
          setItemStatus(index, 'ok', '已下载 PNG');
        } else if (result.status === 'fallback') {
          results.fallback++;
          setItemStatus(index, 'warn', '已下载原图');
        } else {
          results.fail++;
          setItemStatus(index, 'fail', '失败');
          failures.push({ url: item.url, reason: result.reason });
        }

        done++;
        setProgress(done, list.length, '已完成 ' + done + ' / ' + list.length);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, list.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    downloading = false;
    updateCount();

    // 结果反馈
    const summary = $('summary');
    summary.textContent = '';
    summary.hidden = false;

    const head = document.createElement('div');
    head.className = 'summary-head';
    head.textContent =
      '下载完成：成功转 PNG ' +
      results.ok +
      ' 张' +
      (results.fallback ? '，回退为原图 ' + results.fallback + ' 张' : '') +
      (results.fail ? '，失败 ' + results.fail + ' 张' : '');
    summary.appendChild(head);

    if (failures.length) {
      const detail = document.createElement('ul');
      detail.className = 'summary-list';
      failures.slice(0, 8).forEach(function (f) {
        const li = document.createElement('li');
        li.textContent = f.reason + ' — ' + f.url;
        detail.appendChild(li);
      });
      summary.appendChild(detail);
    }

    setProgress(list.length, list.length, '已提交 ' + list.length + ' 个下载任务到浏览器下载目录');
  }

  /* ---------------- 事件绑定 ---------------- */

  $('checkAll').addEventListener('change', function (e) {
    selected.clear();
    if (e.target.checked) {
      images.forEach(function (_, i) {
        selected.add(i);
      });
    }
    $('grid')
      .querySelectorAll('input[type="checkbox"][data-index]')
      .forEach(function (box) {
        box.checked = selected.has(Number(box.dataset.index));
      });
    updateCount();
  });

  $('btnInvert').addEventListener('click', function () {
    const next = new Set();
    images.forEach(function (_, i) {
      if (!selected.has(i)) next.add(i);
    });
    selected.clear();
    next.forEach(function (i) {
      selected.add(i);
    });
    $('grid')
      .querySelectorAll('input[type="checkbox"][data-index]')
      .forEach(function (box) {
        box.checked = selected.has(Number(box.dataset.index));
      });
    updateCount();
  });

  $('btnDownload').addEventListener('click', function () {
    downloadSelected();
  });

  // 监听后台回传的下载状态，用于兜底路径的完成反馈
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'DOWNLOAD_STATE' && !downloading) {
      setProgress(1, 1, msg.state === 'complete' ? '浏览器已完成一个下载任务' : '有下载任务被中断');
    }
  });

  /* ---------------- 初始化 ---------------- */

  (async function init() {
    const payload = await storageGet(STORE_KEY);

    if (!payload || !Array.isArray(payload.images) || payload.images.length === 0) {
      $('emptyState').hidden = false;
      $('pageMeta').textContent = '暂无数据';
      updateCount();
      return;
    }

    images = payload.images;

    const when = payload.collectedAt ? new Date(payload.collectedAt).toLocaleString() : '';
    $('pageMeta').textContent =
      '来源：' +
      (payload.pageTitle || '（无标题）') +
      (when ? ' · 提取于 ' + when : '') +
      ' · 共 ' + images.length + ' 张';

    renderGrid();
    updateCount();
  })();
})();
