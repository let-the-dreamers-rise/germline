// Germline site motion. Physics: viscous resin. One easing family (power4),
// fast 0.35s / medium 0.8s / slow 1.6s. Only transform and opacity animate.
(function () {
  "use strict";
  var root = document.documentElement;
  var ready = function () { root.classList.add("ready"); };
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  // ---- works without GSAP: pause loops offscreen, sticky story steps ----
  if ("IntersectionObserver" in window) {
    var loopIO = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.target.classList.contains("marquee")) e.target.classList.toggle("is-off", !e.isIntersecting);
        else e.target.classList.toggle("is-on", e.isIntersecting);
      });
    }, { rootMargin: "80px" });
    $$("[data-loop], .foot, .closing, .marquee").forEach(function (el) { loopIO.observe(el); });

    var panels = $$(".story-stage .panel");
    var steps = $$(".step");
    var stepIO = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var n = +e.target.getAttribute("data-step");
        steps.forEach(function (s, i) { s.classList.toggle("active", i === n); });
        panels.forEach(function (p, i) { p.classList.toggle("active", i === n); });
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach(function (s) { stepIO.observe(s); });
    if (panels[0]) { panels[0].classList.add("active"); steps[0].classList.add("active"); }
  } else {
    $$(".panel, .step").forEach(function (el) { el.classList.add("active"); });
  }

  // FAQ: the answer settles in as it opens.
  $$(".faq details").forEach(function (d) {
    d.addEventListener("toggle", function () {
      if (d.open && window.gsap && !reduce) gsap.from($(".a", d), { y: -10, opacity: 0, duration: 0.35, ease: "power4.out" });
    });
  });

  if (reduce || !window.gsap || !window.ScrollTrigger || !window.SplitText) { ready(); return; }
  gsap.registerPlugin(ScrollTrigger, SplitText);
  gsap.defaults({ ease: "power4.out", duration: 0.8 });

  // ---- hero: a silent edit, caught and set in amber ----
  var spec = $(".specimen");
  var ghost = $(".ghost-val");
  spec.classList.add("unsealed");
  gsap.set(".resin", { scale: 0, opacity: 0, transformOrigin: "50% 0%" });
  gsap.set(".glow", { opacity: 0 });
  gsap.set(".guard-pill", { opacity: 0, y: 16 });
  gsap.set(".hero [data-rise]", { opacity: 0, y: 26 });
  gsap.set(spec, { opacity: 0, y: 40 });
  ready();

  var hero = gsap.timeline({ delay: 0.15 });
  SplitText.create(".hero h1", {
    type: "lines", mask: "lines", linesClass: "line", autoSplit: true,
    onSplit: function (self) { return gsap.from(self.lines, { yPercent: 110, duration: 1.4, stagger: 0.12 }); }
  });
  hero.to(".hero [data-rise]", { opacity: 1, y: 0, stagger: 0.09 }, 0.35)
    .to(spec, { opacity: 1, y: 0, duration: 1.6 }, 0.25);
  ["1000", "100000", "100", "100000"].forEach(function (v, i) {
    hero.to(ghost, { opacity: 0.25, duration: 0.12, ease: "power4.in" }, 1.1 + i * 0.42)
      .call(function () { ghost.textContent = v; })
      .to(ghost, { opacity: 1, duration: 0.2 });
  });
  hero.fromTo(".drop", { opacity: 0, y: 0 }, { opacity: 1, y: 150, duration: 0.7, ease: "power4.in" }, 2.85)
    .to(".drop", { opacity: 0, scaleY: 0.5, duration: 0.35 })
    .call(function () { spec.classList.remove("unsealed"); })
    .to(".resin", { scale: 1, opacity: 1, duration: 1.6 }, "<")
    .to(".glow", { opacity: 1, duration: 1.6 }, "<")
    .from(".cfg-hash", { opacity: 0, y: 8 }, "<0.4")
    .to(".guard-pill", { opacity: 1, y: 0 }, "<0.3");

  // Cursor depth: the block tilts and its inclusions drift at different depths.
  if (window.matchMedia("(pointer: fine)").matches) {
    var rx = gsap.quickTo(spec, "rotationX", { duration: 0.8 });
    var ry = gsap.quickTo(spec, "rotationY", { duration: 0.8 });
    var bx = gsap.quickTo(".resin i", "x", { duration: 1.6 });
    var by = gsap.quickTo(".resin i", "y", { duration: 1.6 });
    var stage = $(".hero");
    stage.addEventListener("pointermove", function (e) {
      var r = stage.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      ry(px * 16); rx(py * -12); bx(px * -18); by(py * -14);
    });
    stage.addEventListener("pointerleave", function () { rx(0); ry(0); bx(0); by(0); });
  }

  // ---- masked line reveals on every other headline ----
  $$(".split").forEach(function (el) {
    if (el.closest(".hero")) return;
    SplitText.create(el, {
      type: "lines", mask: "lines", linesClass: "line", autoSplit: true,
      onSplit: function (self) {
        return gsap.from(self.lines, { yPercent: 110, duration: 1.2, stagger: 0.1, scrollTrigger: { trigger: el, start: "top 88%", once: true } });
      }
    });
  });

  // ---- staggered entrances ----
  var rise = $$("[data-rise], .fields li, .tile, .faq details").filter(function (el) { return !el.closest(".hero"); });
  gsap.set(rise, { opacity: 0, y: 34 });
  ScrollTrigger.batch(rise, {
    start: "top 90%", once: true,
    onEnter: function (b) { gsap.to(b, { opacity: 1, y: 0, stagger: 0.08, duration: 0.8, overwrite: true }); }
  });

  // ---- scroll-scrubbed page progress ----
  gsap.to(".progress span", { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.4 } });

  // ---- pinned timelock: the change cures as you scroll ----
  var tl = $(".timelock");
  var status = $("[data-tl-status]");
  var mm = gsap.matchMedia();
  mm.add({ small: "(max-width: 860px)", large: "(min-width: 861px)" }, function (ctx) {
    tl.classList.add("pinned");
    var li = $$(".tl-steps li");
    var dim = ctx.conditions.small ? 0 : 0.28;
    gsap.set(li, { opacity: dim });
    gsap.set(li[0], { opacity: 1 });
    gsap.set(".tl-meter span", { scaleX: 0 });
    gsap.set(".cube.b", { opacity: 0, y: -60 });
    var t = gsap.timeline({
      defaults: { ease: "power4.inOut", duration: 1 },
      scrollTrigger: {
        trigger: ".tl-inner", start: "top top", end: "+=2400", pin: true, scrub: 1,
        onUpdate: function (s) {
          var p = s.progress;
          status.textContent = p < 0.22 ? "trading on A" : p < 0.9 ? "paused · B is curing, withdrawals open" : "trading on B, settled";
        }
      }
    });
    t.to(".tl-meter span", { scaleX: 0.08 }, 0)
      .to(".cube.b", { opacity: 0.45, y: 0 }, 0.8)
      .to(".cube.a", { opacity: 0.35, scale: 0.94 }, 0.8)
      .to(li[0], { opacity: dim }, 0.8).to(li[1], { opacity: 1 }, 0.8)
      .to(".tl-meter span", { scaleX: 0.55, ease: "none" }, 1.8)
      .to(li[1], { opacity: dim }, 1.8).to(li[2], { opacity: 1 }, 1.8)
      .to(".tl-meter span", { scaleX: 1, ease: "none" }, 2.8)
      .to(".cube.b", { opacity: 1, scale: 1.04 }, 2.8)
      .to(li[2], { opacity: dim }, 2.8).to(li[3], { opacity: 1 }, 2.8);
    return function () { tl.classList.remove("pinned"); };
  });

  // ---- count-ups ----
  $$("[data-count]").forEach(function (el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var dec = +(el.getAttribute("data-dec") || 0);
    var fmt = function (v) { return dec ? v.toFixed(dec) : Math.round(v).toLocaleString("en-US"); };
    var o = { v: 0 };
    el.textContent = fmt(0);
    gsap.to(o, {
      v: target, duration: 1.6, scrollTrigger: { trigger: el, start: "top 90%", once: true },
      onUpdate: function () { el.textContent = fmt(o.v); }
    });
  });

  // The closing glow follows the cursor a little, like light through resin.
  var closing = $(".closing");
  if (window.matchMedia("(pointer: fine)").matches) {
    var gx = gsap.quickTo(".closing-glow", "x", { duration: 1.6 });
    var gy = gsap.quickTo(".closing-glow", "y", { duration: 1.6 });
    closing.addEventListener("pointermove", function (e) {
      var r = closing.getBoundingClientRect();
      gx((e.clientX - r.left - r.width / 2) * 0.25); gy((e.clientY - r.top - r.height / 2) * 0.25);
    });
  }
})();
