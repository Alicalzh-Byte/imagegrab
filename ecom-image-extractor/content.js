/**
 * 电商图片提取下载器 —— 内容脚本 (content script)
 *
 * 职责：
 *   1. 判断当前页是否淘宝 / 天猫 / 京东 / 拼多多商家版的「商品详情页」，是则注入右下角悬浮按钮
 *   2. 点击按钮后扫描页面内的商品图片（含懒加载属性、srcset、背景图）
 *   3. 过滤图标 / logo / 占位图 / 1x1 像素图 / 小于 100x100 的图，补全绝对路径、去重、尽量还原原图
 *   4. 通过 chrome.runtime.sendMessage 把图片列表交给扩展后台
 *
 * 文件结构上分为两区：
 *   一、纯函数区：无副作用，挂在 window.__EIE__ 上，可被 test/selftest.html 直接调用测试
 *   二、初始化区：有副作用（注入按钮、绑定事件），仅在命中详情页时执行
 */
(function () {
  'use strict';

  /* ============================================================
   * 一、常量
   * ============================================================ */

  /** 小于该边长（px）的图片视为图标 / 占位图 */
  const MIN_SIZE = 100;
  /** 背景图扫描的最大元素数量，避免超大页面卡顿 */
  const MAX_BG_SCAN = 6000;
  const BTN_ID = 'eie-floating-btn';
  const TOAST_ID = 'eie-toast';
  /** 详情页判定失败时的兜底轮询间隔（应对站内 SPA 切换） */
  const REINJECT_INTERVAL = 3000;

  /** 明显的图标 / 占位图 / 装饰图 URL 特征 */
  const JUNK_PATTERN = /(1x1|spacer|\/blank|grey\.(gif|png|jpg)|placeholder|sprite|avatar|favicon|qrcode|\/icon|\/logo|_icon\.|_logo\.|loading\.(gif|png|jpe?g)|\.svg(\?|#|$))/i;

  /**
   * 懒加载属性的候选名，覆盖三个平台与常见懒加载库：
   *   淘宝 / 天猫：data-ks-lazyload、data-src
   *   京东：data-lazy-img、data-original（详情大图）
   *   拼多多：data-src、data-original
   */
  const LAZY_ATTRS = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-lazyload',
    'data-lazy-img',
    'data-ks-lazyload',
    'data-actualsrc',
    'data-echo',
    'data-url',
    'data-image',
    'data-img'
  ];

  /** 高清 / 大图变体属性（部分站点把原图单独放一份） */
  const HI_ATTRS = ['data-hi', 'data-big', 'data-large', 'data-zoom-image', 'data-origin-src'];

  /* ============================================================
   * 二、纯函数区（无副作用，可单独测试）
   * ============================================================ */

  /**
   * 把相对地址补全为绝对地址。
   * @param {string} raw 原始地址（可能为空、协议相对、或带引号）
   * @param {string} base 基准地址（通常是 document.baseURI）
   * @returns {string} 绝对地址；非法或不可用地址返回空串
   */
  function absolutize(raw, base) {
    if (!raw) return '';
    let url = String(raw).trim().replace(/^['"]|['"]$/g, '');
    if (!url) return '';

    // 内联数据、blob、脚本伪协议一律丢弃（大多是不可用的占位图或非图片资源）
    if (/^(data|blob|javascript|about|chrome-extension|chrome):/i.test(url)) return '';

    // 协议相对地址：//img.alicdn.com/xxx.jpg → https://img.alicdn.com/xxx.jpg
    if (/^\/\//.test(url)) url = 'https:' + url;

    try {
      return new URL(url, base || undefined).href;
    } catch (e) {
      return '';
    }
  }

  /**
   * 尽量把缩略图地址还原成原图地址（平台差异兼容）。
   *
   *   淘宝 / 天猫：img.alicdn.com/.../O1CN01xxx.jpg_430x430q90.jpg → 去掉 _430x430q90.jpg 后缀
   *   京东：img14.360buyimg.com/n1/s450x450_jfs/t1/xxx.jpg → /n1/ 是尺寸分档（/n0/ 才是原图），
   *        再去掉 s450x450_ 缩放前缀
   *   拼多多：img.pddpic.com/xxx.jpg?imageView2/2/w/450 → 去掉七牛图片处理参数
   *
   * @param {string} rawUrl
   * @returns {string} 尽量为原图的地址
   */
  function upgradeToOriginal(rawUrl) {
    let out = String(rawUrl);
    const q = out.indexOf('?');
    let path = q === -1 ? out : out.slice(0, q);
    const query = q === -1 ? '' : out.slice(q);

    // 淘宝 / 天猫系：形如 xxx.jpg_430x430q90.jpg（含 .jpg_.webp 形式）
    if (/alicdn\.com|taobaocdn\.com|tbcdn\.cn/i.test(out) || /\.(jpe?g|png|webp|gif)_/i.test(path)) {
      path = path.replace(/(\.(?:jpe?g|png|webp|gif))_.*$/i, '$1');
    }

    // 京东系：尺寸分档（/n1/ 等，/n0/ 才是原图）+ 缩放前缀（s450x450_）
    // 判据用 CDN 域名，或典型的 /n\d+/ + s\d+x\d+_ 路径特征（后者便于在本地测试页复现）
    if (/360buyimg\.com/i.test(out) || (/\/n\d+\//i.test(path) && /\/s\d+x\d+_/i.test(path))) {
      path = path.replace(/\/n\d+\//i, '/n0/').replace(/\/s\d+x\d+_/i, '/');
    }

    out = path + query;

    // 拼多多系：七牛图片处理参数
    if (/pddpic\.com/i.test(out)) {
      out = out.replace(/\?(?:[^?#]*(?:imageView2|imageslim|imageMogr2)[^?#]*)$/i, '');
    }

    return out;
  }

  /**
   * 从 srcset 中挑出最大的一张（避免同一张图产生多个尺寸变体）。
   * 支持 "a.jpg 1x, b.jpg 2x" 与 "a.jpg 400w, b.jpg 800w" 两种写法。
   * @param {string} srcset
   * @returns {string} 最大候选的地址
   */
  function pickLargestFromSrcset(srcset) {
    if (!srcset) return '';
    const parts = String(srcset).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    let best = '';
    let bestScore = -1;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i].split(/\s+/);
      const url = seg[0];
      if (!url) continue;
      let score = 1;
      if (seg[1]) {
        const m = /^(\d+(?:\.\d+)?)(w|x)$/i.exec(seg[1]);
        if (m) score = parseFloat(m[1]);
      }
      if (score >= bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best;
  }

  /**
   * 量取图片尺寸。优先用真实像素尺寸（naturalWidth/Height），
   * 其次用 width/height 属性，最后用渲染尺寸；都拿不到时返回 known:false。
   * @param {Element} el
   * @returns {{w:number,h:number,known:boolean}}
   */
  function measure(el) {
    if (!el) return { w: 0, h: 0, known: false };

    const natW = el.naturalWidth || 0;
    const natH = el.naturalHeight || 0;
    if (natW > 0 || natH > 0) return { w: natW, h: natH, known: true };

    if (el.tagName === 'IMG') {
      const aW = parseInt(el.getAttribute('width') || '', 10);
      const aH = parseInt(el.getAttribute('height') || '', 10);
      if (aW > 0 || aH > 0) return { w: aW || 0, h: aH || 0, known: true };
    }

    if (typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        return { w: Math.round(r.width), h: Math.round(r.height), known: true };
      }
    }

    return { w: 0, h: 0, known: false };
  }

  /**
   * 扫描 root 下的所有商品图片。
   * @param {Element} [root] 扫描根节点，默认 document
   * @param {Window}  [win]  用于取计算样式，默认 window
   * @returns {Array<{url:string,width:number,height:number,known:boolean,source:string}>}
   */
  function collectImages(root, win) {
    root = root || document;
    win = win || window;
    const doc = root.ownerDocument || root;
    const base = (doc && doc.baseURI) || (win.location && win.location.href) || '';

    const out = [];
    const seen = new Set();

    /**
     * 候选地址是否就是该 <img> 当前真正加载的那张图。
     * 只有「是」的时候，naturalWidth / naturalHeight 才代表这张图的真实像素；
     * 懒加载尚未替换（src 还是占位图、真图在 data-src 里）时，natural 尺寸属于占位图，不能用。
     */
    function isCurrentSource(el, abs) {
      if (!el || el.tagName !== 'IMG' || !abs) return false;
      const cur = absolutize(el.currentSrc || '', base);
      const attr = absolutize(el.getAttribute('src') || '', base);
      return abs === cur || abs === attr;
    }

    /**
     * 尝试收录一张图（内部统一做：补全 → 还原原图 → 过滤 → 去重）
     */
    function add(rawUrl, el, source) {
      const abs = absolutize(rawUrl, base);
      if (!abs) return;

      const finalUrl = upgradeToOriginal(abs);
      if (JUNK_PATTERN.test(finalUrl)) return;

      // 尺寸过滤：能测到尺寸且过小则丢弃；尺寸未知（懒加载未替换、背景图元素）则保留，避免漏掉真图
      const size =
        el && el.tagName === 'IMG' && !isCurrentSource(el, abs)
          ? { w: 0, h: 0, known: false }
          : measure(el);
      if (size.known && (size.w < MIN_SIZE || size.h < MIN_SIZE)) return;

      // 去重：还原原图后，同一张图的多个尺寸变体会自然合并成一条
      if (seen.has(finalUrl)) return;
      seen.add(finalUrl);

      out.push({
        url: finalUrl,
        width: size.w,
        height: size.h,
        known: size.known,
        source: source || 'unknown'
      });
    }

    // ---- 1) <img> 标签：src / 懒加载属性 / srcset / 高清变体 ----
    const imgs = root.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const el = imgs[i];

      // srcset 存在时只取其中最大（最清晰）的一张，避免同一张图产生多个尺寸变体；
      // 没有 srcset 时退回 src / currentSrc（currentSrc 是浏览器实际选中的那张）
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        add(pickLargestFromSrcset(srcset), el, 'srcset');
      } else {
        add(el.currentSrc || el.getAttribute('src'), el, 'img');
      }

      for (let k = 0; k < LAZY_ATTRS.length; k++) {
        const v = el.getAttribute(LAZY_ATTRS[k]);
        if (v) add(v, el, 'lazy:' + LAZY_ATTRS[k]);
      }

      for (let k = 0; k < HI_ATTRS.length; k++) {
        const v = el.getAttribute(HI_ATTRS[k]);
        if (v) add(v, el, 'hi:' + HI_ATTRS[k]);
      }
    }

    // ---- 2) <picture> 内的 <source srcset> ----
    const sources = root.querySelectorAll('source[srcset]');
    for (let i = 0; i < sources.length; i++) {
      add(pickLargestFromSrcset(sources[i].getAttribute('srcset')), sources[i].parentElement, 'picture');
    }

    // ---- 3) 挂在任意元素上的懒加载属性（部分站点把地址放在 li / div 上）----
    const holderSelector = LAZY_ATTRS.map(function (a) { return '[' + a + ']'; }).join(',');
    const holders = root.querySelectorAll(holderSelector);
    for (let i = 0; i < holders.length; i++) {
      const el = holders[i];
      if (el.tagName === 'IMG' || el.tagName === 'SOURCE') continue; // 前面已处理过
      for (let k = 0; k < LAZY_ATTRS.length; k++) {
        const v = el.getAttribute(LAZY_ATTRS[k]);
        if (v) add(v, el, 'attr:' + LAZY_ATTRS[k]);
      }
    }

    // ---- 4) CSS 背景图（促销图、规格图常用背景图实现）----
    const all = root.querySelectorAll('*');
    const limit = Math.min(all.length, MAX_BG_SCAN);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      let style;
      try {
        style = win.getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (!style || style.display === 'none' || style.visibility === 'hidden') continue;

      const bg = style.backgroundImage;
      if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;

      const re = /url\((['"]?)([^)'"]+)\1\)/gi;
      let m;
      while ((m = re.exec(bg))) add(m[2], el, 'background');
    }

    return out;
  }

  /* ---------------- 平台与详情页判定 ---------------- */

  /**
   * 各平台的域名与详情页特征。
   * hostTest  命中域名；pageTest 命中详情页路径（满足其一即可）
   */
  const PLATFORM_RULES = [
    {
      name: 'taobao',
      label: '淘宝/天猫',
      hostTest: /(^|\.)(taobao|tmall)\.com$/i,
      pageTest: [/item\.htm/i, /\/item\//i, /detail\.tmall\.com/i, /world\.taobao\.com\/item/i]
    },
    {
      name: 'jd',
      label: '京东',
      hostTest: /(^|\.)jd\.com$/i,
      pageTest: [/item\.jd\.com\/\d+/i, /\/\d+\.html($|\?)/i, /npcitem/i]
    },
    {
      name: 'pinduoduo',
      label: '拼多多',
      hostTest: /(^|\.)(pinduoduo|yangkeduo)\.com$/i,
      pageTest: [/[?&]goods_id=/i, /goods\d*\.html/i, /\/goods\//i, /goods_detail/i, /mms\.pinduoduo\.com\/.*goods/i]
    }
  ];

  /**
   * 拼多多商家后台的商品页路径不固定，用 DOM 特征兜底判断。
   * @returns {boolean}
   */
  function isLikelyGoodsDom() {
    if (typeof document === 'undefined' || !document.querySelector) return false;
    return !!document.querySelector(
      '#goods-detail, .goods-detail, #goods-info, .goods-info, ' +
        '[class*="goodsDetail"], [class*="goods-detail"], [class*="goods_info"]'
    );
  }

  /**
   * 判断给定地址属于哪个平台的商品详情页。
   * @param {string} [href] 默认取当前页面地址
   * @returns {string|null} 平台名（taobao / jd / pinduoduo）或 null
   */
  function detectContext(href) {
    const target = href || (typeof location !== 'undefined' ? location.href : '');
    let host = '';
    let path = target;
    try {
      const u = new URL(target);
      host = u.hostname;
      path = u.pathname + u.search;
    } catch (e) {
      return null;
    }

    for (let i = 0; i < PLATFORM_RULES.length; i++) {
      const rule = PLATFORM_RULES[i];
      if (!rule.hostTest.test(host)) continue;

      const matched = rule.pageTest.some(function (re) {
        return re.test(path) || re.test(target);
      });
      if (matched) return rule.name;

      // 拼多多商家版兜底：路径不固定时看 DOM 特征
      if (rule.name === 'pinduoduo' && isLikelyGoodsDom()) return rule.name;
    }
    return null;
  }

  /* ---------------- 把纯函数暴露给测试页 ---------------- */

  try {
    window.__EIE__ = {
      MIN_SIZE: MIN_SIZE,
      absolutize: absolutize,
      upgradeToOriginal: upgradeToOriginal,
      pickLargestFromSrcset: pickLargestFromSrcset,
      measure: measure,
      collectImages: collectImages,
      detectContext: detectContext
    };
  } catch (e) {
    /* ignore */
  }

  /* ============================================================
   * 三、初始化区（有副作用）
   * ============================================================ */

  /** 扩展是否仍可用（扩展被重载后 chrome.runtime 会失效） */
  function runtimeAlive() {
    try {
      return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** 把 chrome.runtime.sendMessage 包成 Promise，便于用 async/await */
  function sendMessage(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 右下角轻提示
   */
  let toastTimer = null;
  function showToast(text, duration) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      document.body.appendChild(el);
    }
    el.textContent = text;
    // 强制 reflow 让过渡生效
    void el.offsetWidth;
    el.classList.add('eie-show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('eie-show');
    }, duration || 3000);
  }

  function setBusy(btn, busy) {
    btn.dataset.busy = busy ? '1' : '0';
    btn.disabled = !!busy;
    btn.innerHTML = busy
      ? '<span class="eie-spin"></span><span>提取中…</span>'
      : '<span>获取图片</span>';
  }

  /**
   * 点击按钮：提取 → 交给后台 → 后台打开预览页
   */
  async function handleClick(btn) {
    if (btn.dataset.busy === '1') return;
    setBusy(btn, true);

    try {
      const images = collectImages(document, window);

      if (!images.length) {
        showToast('未找到符合条件的商品图片（已过滤图标、占位图与小于 ' + MIN_SIZE + '×' + MIN_SIZE + ' 的图片）', 4200);
        return;
      }

      const res = await sendMessage({
        type: 'IMAGES_COLLECTED',
        payload: {
          images: images,
          pageUrl: location.href,
          pageTitle: document.title,
          platform: detectContext(location.href),
          collectedAt: Date.now()
        }
      });

      if (!res || !res.ok) {
        throw new Error((res && res.error) || '后台未响应');
      }

      showToast('已提取 ' + images.length + ' 张图片，正在打开预览页…', 3200);
    } catch (e) {
      showToast('提取失败：' + (e && e.message ? e.message : String(e)), 4200);
    } finally {
      setBusy(btn, false);
    }
  }

  /**
   * 注入右下角悬浮按钮
   */
  function injectButton(platform) {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = '提取本页商品图片（' + platform + '）';
    btn.innerHTML = '<span>获取图片</span>';
    btn.addEventListener('click', function () {
      handleClick(btn);
    });

    // 放到 body 上，避免被宿主页面的容器裁掉
    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  /**
   * 初始化：只在命中平台详情页时注入按钮
   */
  function init() {
    if (!runtimeAlive()) return; // 扩展已卸载 / 更新，静默退出
    if (!detectContext(location.href)) return; // 非目标详情页 → 不显示按钮
    if (document.getElementById(BTN_ID)) return; // 已注入

    injectButton(detectContext(location.href));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 站内 SPA 切换（如从列表页进入详情页）时补注入；扩展失效则停止轮询
  const guard = setInterval(function () {
    if (!runtimeAlive()) {
      clearInterval(guard);
      return;
    }
    init();
  }, REINJECT_INTERVAL);
})();
