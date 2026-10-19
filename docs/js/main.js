/* ============================================================
   图提取 ImageGrab · 官网交互脚本
   功能：汉堡菜单 / 滚动吸顶 / 当前区块高亮 / 视口淡入动画 / 版权年份
   说明：纯原生 JS，无任何依赖；未使用 IntersectionObserver 时自动降级
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 元素引用 ---------------- */
  var nav = document.getElementById('navbar');
  var navToggle = document.getElementById('navToggle');
  var navMenu = document.getElementById('navMenu');
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
  var MOBILE_BREAKPOINT = 768; // 与 CSS 中的 768px 断点保持一致

  /* 导航链接对应的目标区块：[{ id, el, link }] */
  var targets = navLinks
    .map(function (link) {
      var href = link.getAttribute('href') || '';
      if (href.charAt(0) !== '#' || href.length < 2) return null;
      var el = document.getElementById(href.slice(1));
      if (!el) return null;
      return { id: href.slice(1), el: el, link: link };
    })
    .filter(Boolean);

  /* ================= 1. 移动端汉堡菜单 ================= */
  function setMenuOpen(open) {
    if (!nav || !navToggle) return;
    nav.classList.toggle('is-open', open);
    // 同步无障碍属性：屏幕阅读器据此播报展开状态
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  }

  function isMenuOpen() {
    return !!(nav && nav.classList.contains('is-open'));
  }

  if (navToggle) {
    navToggle.addEventListener('click', function (event) {
      event.stopPropagation();
      setMenuOpen(!isMenuOpen());
    });
  }

  /* 点击菜单里的链接后自动收起（否则移动端会挡住内容） */
  if (navMenu) {
    navMenu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setMenuOpen(false);
    });
  }

  /* 点击页面其他区域关闭菜单 */
  document.addEventListener('click', function (event) {
    if (isMenuOpen() && nav && !nav.contains(event.target)) setMenuOpen(false);
  });

  /* Esc 关闭菜单，并把焦点还给按钮 */
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isMenuOpen()) {
      setMenuOpen(false);
      if (navToggle) navToggle.focus();
    }
  });

  /* 窗口从移动端放大到桌面端时，收起移动菜单并复位状态 */
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (window.innerWidth >= MOBILE_BREAKPOINT) setMenuOpen(false);
      updateNavState();
    }, 120);
  });

  /* ================= 2. 滚动吸顶 + 当前区块高亮 ================= */
  /* 判断「探测线」当前落在哪个区块里，从而点亮对应导航项 */
  function activeSectionId() {
    var probe = (nav ? nav.offsetHeight : 0) + 40; // 探测线：导航栏下方 40px
    var found = '';

    for (var i = 0; i < targets.length; i++) {
      var rect = targets[i].el.getBoundingClientRect();
      if (rect.top <= probe && rect.bottom > probe) {
        found = targets[i].id;
        break;
      }
    }

    /* 已经滚到页面底部时，直接点亮最后一项（短区块可能一直碰不到探测线） */
    if (!found) {
      var scrollBottom = window.innerHeight + window.pageYOffset;
      var docHeight = document.documentElement.scrollHeight;
      if (scrollBottom >= docHeight - 4) found = targets[targets.length - 1].id;
    }
    return found;
  }

  function updateNavState() {
    if (!nav) return;

    /* 吸顶：滚动后加阴影与分隔线 */
    nav.classList.toggle('is-scrolled', window.pageYOffset > 8);

    /* 高亮：先清空，再给当前区块对应的链接加 .is-active */
    var current = activeSectionId();
    targets.forEach(function (item) {
      var active = item.id === current;
      item.link.classList.toggle('is-active', active);
      if (active) {
        item.link.setAttribute('aria-current', 'true');
      } else {
        item.link.removeAttribute('aria-current');
      }
    });
  }

  /* 用 requestAnimationFrame 节流，避免高频滚动时重复计算布局 */
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      updateNavState();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  /* ================= 3. 区块进入视口时淡入上移 ================= */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  /* 同一组内的元素按顺序错开一点延迟，动画看起来更自然 */
  function applyStagger(el) {
    var parent = el.parentNode;
    if (!parent) return;
    var index = 0;
    for (var i = 0; i < parent.children.length; i++) {
      var child = parent.children[i];
      if (child === el) break;
      if (child.classList && child.classList.contains('reveal')) index++;
    }
    if (index > 0) el.style.transitionDelay = Math.min(index, 5) * 0.07 + 's';
  }

  function showImmediately() {
    reveals.forEach(function (el) {
      el.classList.add('in');
    });
  }

  if (!('IntersectionObserver' in window)) {
    /* 老浏览器降级：不做动画，直接显示，保证内容可见 */
    showImmediately();
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          applyStagger(entry.target);
          entry.target.classList.add('in');
          observer.unobserve(entry.target); // 只播一次
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    reveals.forEach(function (el) {
      observer.observe(el);
    });

    /* 兜底：脚本执行异常时，1.2 秒后强制显示，避免内容一直透明 */
    setTimeout(function () {
      var hidden = reveals.filter(function (el) {
        return !el.classList.contains('in');
      });
      if (hidden.length && !document.querySelector('.reveal.in')) showImmediately();
    }, 1200);
  }

  /* ================= 4. 版权年份自动更新 ================= */
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ================= 初始化 ================= */
  setMenuOpen(false);
  updateNavState();
})();
