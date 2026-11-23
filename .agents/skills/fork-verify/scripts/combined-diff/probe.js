// rAF frame probe (from ui-perf-audit/codex-evidence/frame-probe.js, same counters).
// Installed fresh before every idle and every operation window; window.__audit.stop() returns raw data.
// Extra: counts() also reports the mounted CodeMirror editors.
(() => {
  window.__audit?.stop?.();
  const gaps = [],
    tasks = [],
    input = [],
    events = [],
    delays = [];
  const samples = [],
    frameTimes = [];
  let last = 0,
    raf = 0,
    pending = null,
    dirty = false;
  const scoped = window.__scope || "body";
  const start = performance.now();
  let visible = true;
  const root = () => document.querySelector(scoped);
  const counts = () => [
    document.getElementsByTagName("*").length,
    document.querySelectorAll("svg,svg *").length,
    document.querySelectorAll(".cm-editor").length,
  ];
  const before = counts();
  const mo = new MutationObserver((records) => {
    if (pending && records.some((r) => root()?.contains(r.target))) dirty = true;
  });
  mo.observe(document, { subtree: true, attributes: true, characterData: true, childList: true });
  function change(e) {
    if (pending && (e.type === "resize" || root()?.contains(e.target))) dirty = true;
  }
  const types = ["pointerdown", "keydown", "wheel", "pointermove"];
  function onInput(e) {
    if (!e.isTrusted) return;
    if (e.type === "pointermove" && !window.__moves) return;
    input.push([e.type, Math.round(e.timeStamp - start)]);
    if (!pending) {
      pending = { t: e.timeStamp };
      dirty = false;
    }
  }
  function frame(t) {
    if (last) gaps.push(+(t - last).toFixed(2));
    if (window.__keepFrameTimes) frameTimes.push(t);
    if (window.combinedFrame) samples.push([t, last ? t - last : 0, ...window.combinedFrame()]);
    last = t;
    if (pending && dirty) {
      delays.push(+(performance.now() - pending.t).toFixed(2));
      pending = null;
      dirty = false;
    }
    visible &&= document.visibilityState === "visible";
    raf = native.call(window, frame);
  }
  for (const t of types) window.addEventListener(t, onInput, true);
  for (const t of ["scroll", "resize", "input"]) window.addEventListener(t, change, true);
  const dispatchTimes = [],
    eventStarts = new WeakMap();
  function beginEvent(e) {
    if (e.isTrusted) eventStarts.set(e, performance.now());
  }
  function endEvent(e) {
    if (eventStarts.has(e)) {
      const d = performance.now() - eventStarts.get(e);
      if (d > 8) dispatchTimes.push([e.type, +d.toFixed(2)]);
    }
  }
  const measured = [
    "keydown",
    "keyup",
    "pointerdown",
    "pointerup",
    "click",
    "input",
    "wheel",
    "scroll",
    "mouseover",
    "pointermove",
  ];
  for (const k of measured) {
    window.addEventListener(k, beginEvent, true);
    window.addEventListener(k, endEvent, false);
  }
  let po;
  const support = PerformanceObserver.supportedEntryTypes || [];
  if (support.includes("longtask")) {
    po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) tasks.push(e.duration);
    });
    po.observe({ type: "longtask" });
  }
  const native = window.requestAnimationFrame;
  window.requestAnimationFrame = function (fn) {
    return native.call(window, function (t) {
      const s = performance.now();
      try {
        return fn(t);
      } finally {
        const d = performance.now() - s;
        if (d > 8) events.push(+d.toFixed(2));
      }
    });
  };
  raf = native.call(window, frame);
  window.__audit = {
    t0: start,
    stop() {
      cancelAnimationFrame(raf);
      window.requestAnimationFrame = native;
      mo.disconnect();
      po?.disconnect();
      for (const t of types) window.removeEventListener(t, onInput, true);
      for (const t of ["scroll", "resize", "input"]) window.removeEventListener(t, change, true);
      for (const k of measured) {
        window.removeEventListener(k, beginEvent, true);
        window.removeEventListener(k, endEvent, false);
      }
      delete window.__audit;
      return {
        ...(frameTimes.length ? { frameTimes } : {}),
        ...(samples.length ? { samples } : {}),
        dispatchTimes,
        gaps,
        before,
        after: counts(),
        input,
        delays,
        slowRAF: events,
        longtask: support.includes("longtask") ? tasks : null,
        visible,
        focus: document.hasFocus(),
        ms: Math.round(performance.now() - start),
        t0: start,
      };
    },
  };
  return true;
})();
