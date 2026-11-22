// framesheet in-page runtime. Evaluated once after load; exposes window.__framesheet.
// Everything returns plain JSON so the Python side stays simple.
(() => {
  if (window.__framesheet) return;

  const SMIL_SELECTOR = "animate, animateTransform, animateMotion, set, animateColor";
  const NON_RENDERED = new Set([
    "defs", "clippath", "mask", "symbol", "marker", "pattern", "lineargradient",
    "radialgradient", "filter", "style", "script", "title", "desc", "metadata",
    "head", "meta", "link", "template", "noscript", "animate", "animatetransform",
    "animatemotion", "set", "animatecolor", "mpath", "stop",
    "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "femerge", "femergenode",
    "feflood", "fecomposite", "fedropshadow",
  ]);
  const MAX_ELEMENTS = 4000;
  const births = new WeakMap();
  const labels = new WeakMap();

  let nth = null;
  function countTags() {
    nth = new WeakMap();
    const counts = new Map();
    for (const el of document.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      const n = (counts.get(tag) || 0) + 1;
      counts.set(tag, n);
      nth.set(el, n);
    }
  }

  const isSvgDoc = document.documentElement instanceof SVGSVGElement;

  function outerSvgRoots() {
    return [...document.querySelectorAll("svg")].filter((s) => !s.ownerSVGElement);
  }

  function label(el) {
    if (!el || !el.tagName) return null;
    if (labels.has(el)) return labels.get(el);
    const tag = el.tagName.toLowerCase();
    let text;
    if (el.id) {
      text = `${tag}#${el.id}`;
    } else {
      if (!nth) countTags();
      const idx = nth.get(el) || 1;
      const cls = el.classList && el.classList.length ? `.${el.classList[0]}` : "";
      text = `${tag}${cls}[${idx}]`;
    }
    if (tag === "text" || (!(el instanceof SVGElement) && el.children.length === 0)) {
      const content = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (content) text += ` "${content.length > 24 ? content.slice(0, 23) + "…" : content}"`;
    }
    labels.set(el, text);
    return text;
  }

  function clockSeconds(value) {
    // SMIL clock values: "2s", "500ms", "1.5", "0:01.5", "1min", "1h".
    if (value == null) return null;
    const v = String(value).trim();
    let m;
    if ((m = v.match(/^(-?[\d.]+)(ms|s|min|h)?$/))) {
      const n = parseFloat(m[1]);
      return { ms: n / 1000, s: n, min: n * 60, h: n * 3600, undefined: n }[m[2]];
    }
    if ((m = v.match(/^(?:(\d+):)?(\d+):([\d.]+)$/))) {
      return (parseInt(m[1] || "0", 10) * 3600) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    }
    return null;
  }

  function smilTiming(el) {
    let start = 0;
    try { start = el.getStartTime(); } catch (e) {
      const first = (el.getAttribute("begin") || "0").split(";")[0];
      const parsed = clockSeconds(first);
      if (parsed == null) return null; // event-based begin: not time-driven
      start = parsed;
    }
    let duration;
    try { duration = el.getSimpleDuration(); } catch (e) { duration = clockSeconds(el.getAttribute("dur")); }
    if (duration == null || !isFinite(duration) || duration <= 0) return null;
    const rc = el.getAttribute("repeatCount");
    const rd = el.getAttribute("repeatDur");
    let iterations = 1;
    if (rc === "indefinite" || rd === "indefinite") iterations = null;
    else if (rc != null && !isNaN(parseFloat(rc))) iterations = parseFloat(rc);
    else if (rd != null && clockSeconds(rd) != null) iterations = clockSeconds(rd) / duration;
    const target = el.targetElement || el.parentElement;
    return {
      kind: "smil",
      target: label(target),
      name: el.tagName + (el.getAttribute("attributeName") ? `:${el.getAttribute("attributeName")}` : ""),
      start, duration, iterations, direction: "normal", period: duration,
      end: iterations == null ? null : start + duration * iterations,
    };
  }

  function animationKind(a) {
    if (typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation) return "css-animation";
    if (typeof CSSTransition !== "undefined" && a instanceof CSSTransition) return "css-transition";
    return "web-animation";
  }

  const TRANSFORM_PROPS = ["transform", "rotate", "scale", "translate"];

  function waapiTiming(a) {
    const effect = a.effect;
    if (!effect || !effect.getComputedTiming) return null;
    const t = effect.getComputedTiming();
    const duration = (typeof t.duration === "number" ? t.duration : 0) / 1000;
    if (!(duration > 0)) return null;
    const iterations = t.iterations === Infinity ? null : t.iterations;
    const alternate = String(t.direction || "normal").startsWith("alternate");
    const start = (t.delay || 0) / 1000;
    const target = effect.target || null;
    let transformBox = null;
    if (target instanceof SVGElement && !(target instanceof SVGSVGElement)) {
      let frames = [];
      try { frames = effect.getKeyframes(); } catch (e) { frames = []; }
      const animatesTransform = frames.some((f) => TRANSFORM_PROPS.some((p) => p in f));
      if (animatesTransform) transformBox = getComputedStyle(target).transformBox || "view-box";
    }
    return {
      kind: animationKind(a),
      target: label(target),
      name: a.animationName || a.transitionProperty || a.id || null,
      start, duration, iterations,
      direction: t.direction || "normal",
      period: alternate ? duration * 2 : duration,
      end: iterations == null ? null : start + duration * iterations + (t.endDelay || 0) / 1000,
      transform_box: transformBox,
    };
  }

  function timings() {
    const out = [];
    for (const el of document.querySelectorAll(SMIL_SELECTOR)) {
      if (!(el instanceof SVGElement)) continue;
      const t = smilTiming(el);
      if (t) out.push(t);
    }
    for (const a of document.getAnimations()) {
      const t = waapiTiming(a);
      if (t) out.push(t);
    }
    return out;
  }

  function seek(t) {
    for (const svg of outerSvgRoots()) {
      if (svg.pauseAnimations) {
        svg.pauseAnimations();
        svg.setCurrentTime(t);
      }
    }
    for (const a of document.getAnimations()) {
      // Animations created later by script (class toggles, el.animate()) start at the
      // virtual time they were first seen, so their local time stays consistent.
      if (!births.has(a)) births.set(a, t);
      a.pause();
      a.currentTime = Math.max(0, t - births.get(a)) * 1000;
    }
    // Force style + layout so geometry queries and the next paint see the new state.
    void document.documentElement.getBoundingClientRect();
    return true;
  }

  function canvasRect() {
    if (isSvgDoc) {
      const root = document.documentElement;
      const vb = root.viewBox && root.viewBox.baseVal;
      const ctm = root.getScreenCTM();
      if (vb && vb.width > 0 && vb.height > 0 && ctm) {
        const p0 = new DOMPoint(vb.x, vb.y).matrixTransform(ctm);
        const p1 = new DOMPoint(vb.x + vb.width, vb.y + vb.height).matrixTransform(ctm);
        return [p0.x, p0.y, p1.x - p0.x, p1.y - p0.y];
      }
      const r = root.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    }
    return [0, 0, window.innerWidth, window.innerHeight];
  }

  function viewBox() {
    if (!isSvgDoc) return null;
    const vb = document.documentElement.viewBox && document.documentElement.viewBox.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) return [vb.x, vb.y, vb.width, vb.height];
    const r = document.documentElement.getBoundingClientRect();
    return [0, 0, r.width, r.height];
  }

  function nonRendered(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (NON_RENDERED.has(n.tagName.toLowerCase())) return true;
    }
    return false;
  }

  function effectiveOpacity(el, cache) {
    if (!el || el === document) return 1;
    if (cache.has(el)) return cache.get(el);
    const cs = getComputedStyle(el);
    let op = parseFloat(cs.opacity);
    if (isNaN(op)) op = 1;
    const val = op * (el.parentElement ? effectiveOpacity(el.parentElement, cache) : 1);
    cache.set(el, val);
    return val;
  }

  function toUser(el, r) {
    let root = el.ownerSVGElement;
    if (!root) return null;
    while (root.ownerSVGElement) root = root.ownerSVGElement;
    const ctm = root.getScreenCTM();
    if (!ctm) return null;
    const inv = ctm.inverse();
    const a = new DOMPoint(r.x, r.y).matrixTransform(inv);
    const b = new DOMPoint(r.x + r.width, r.y + r.height).matrixTransform(inv);
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)];
  }

  function round(v) { return Math.round(v * 100) / 100; }

  let elementList = null;
  let indexOf = null;

  function elements() {
    if (!elementList) {
      elementList = [];
      for (const el of document.querySelectorAll("*")) {
        if (elementList.length >= MAX_ELEMENTS) break;
        const tag = el.tagName.toLowerCase();
        if (tag === "html" || tag === "body" || el === document.documentElement) continue;
        if (nonRendered(el)) continue;
        elementList.push(el);
      }
      indexOf = new Map(elementList.map((el, i) => [el, i]));
    }
    return elementList;
  }

  function animatedTargets() {
    const out = {};
    const add = (el, kind) => {
      const i = el && indexOf.get(el);
      if (i == null) return;
      (out[i] = out[i] || []).includes(kind) || out[i].push(kind);
    };
    elements();
    for (const el of document.querySelectorAll(SMIL_SELECTOR)) add(el.targetElement || el.parentElement, "smil");
    for (const a of document.getAnimations()) if (a.effect && a.effect.target) add(a.effect.target, animationKind(a));
    return out;
  }

  // One geometry snapshot: [index, clientRect, userRect, visible] for every rendered element.
  function measure() {
    const cache = new WeakMap();
    const out = [];
    for (const [i, el] of elements().entries()) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 || r.height > 0)) continue;
      const cs = getComputedStyle(el);
      const visible = cs.visibility !== "hidden" && cs.display !== "none" && effectiveOpacity(el, cache) > 0.01;
      const user = el instanceof SVGElement ? toUser(el, r) : null;
      out.push([i, [r.x, r.y, r.width, r.height].map(round), user && user.map(round), visible]);
    }
    return out;
  }

  function describe() {
    const els = elements();
    return els.map((el, i) => {
      const tag = el.tagName.toLowerCase();
      let parent = -1;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const j = indexOf.get(p);
        if (j != null) { parent = j; break; }
      }
      return { i, tag, label: label(el), svg: el instanceof SVGElement, parent };
    });
  }

  // HTML text overflow: elements with their own text whose content is larger than the box.
  function htmlOverflow() {
    const out = [];
    for (const [i, el] of elements().entries()) {
      if (el instanceof SVGElement) continue;
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!ownText || el.clientWidth === 0) continue;
      const dx = el.scrollWidth - el.clientWidth;
      const dy = el.scrollHeight - el.clientHeight;
      if (dx > 1 || dy > 1) out.push([i, dx, dy]);
    }
    return out;
  }

  // Wait for real (compositor) frames. requestAnimationFrame and timers are faked by the
  // Playwright clock, but Web Animations still tick on the real document timeline.
  async function settle(count = 2) {
    for (let i = 0; i < count; i++) {
      const a = document.documentElement.animate([{}, {}], { duration: 1 });
      try { await a.finished; } catch (e) { /* cancelled */ }
      a.cancel();
    }
    return true;
  }

  async function ready() {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const imgs = [...document.images].filter((img) => !img.complete);
    await Promise.all(imgs.map((img) => new Promise((res) => { img.onload = img.onerror = res; })));
    return true;
  }

  window.__framesheet = {
    isSvgDoc, timings, seek, settle, measure, describe, animatedTargets, canvasRect, viewBox, htmlOverflow, ready,
    hasScript: () => document.querySelectorAll("script").length > 0,
    canvasCount: () => document.querySelectorAll("canvas").length,
  };
})();
