// Germline site: the tamper toy (a real SHA-256 hash chain) and copy buttons.
(function () {
  "use strict";

  // ---- copy buttons ----
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var label = btn.querySelector(".copy-label");
      var done = function () {
        btn.classList.add("done");
        if (label) label.textContent = "Copied";
        setTimeout(function () { btn.classList.remove("done"); if (label) label.textContent = "Copy"; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { if (label) label.textContent = "Select and copy"; });
      } else if (label) {
        label.textContent = "Select and copy";
      }
    });
  });

  // ---- tamper toy ----
  var list = document.querySelector("[data-log]");
  if (!list || !window.crypto || !crypto.subtle || !window.TextEncoder) return;

  var ORIGINAL = [
    { key: "model", value: "model-a" },
    { key: "temperature", value: "0.2" },
    { key: "maxTradeUsd", value: "100" },
    { key: "maxTradeUsd", value: "100000" }
  ];
  var GENESIS = "0x" + "0".repeat(64);
  var entries = [];   // current values
  var stored = [];    // the hashes written in the file
  var anchored = "";  // the head pinned on 0G

  var anchoredEl = document.querySelector("[data-anchored]");
  var currentEl = document.querySelector("[data-current]");
  var verdictEl = document.querySelector("[data-verdict]");

  function hex(buf) {
    return "0x" + Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function sha(text) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(hex); }
  function short(h) { return h.slice(0, 10) + "…" + h.slice(-4); }

  // Each entry hashes its own content together with the previous entry's hash.
  function computeChain(values) {
    var hashes = [];
    var step = function (i, prev) {
      if (i === values.length) return Promise.resolve(hashes);
      return sha(prev + "|" + (i + 1) + "|" + values[i].key + "=" + values[i].value).then(function (h) {
        hashes.push(h);
        return step(i + 1, h);
      });
    };
    return step(0, GENESIS);
  }

  function render() {
    list.innerHTML = "";
    entries.forEach(function (e, i) {
      var li = document.createElement("li");
      li.className = "entry";
      var id = "toy-v" + i;
      li.innerHTML =
        '<span class="n">#' + (i + 1) + "</span>" +
        '<label for="' + id + '">' + e.key + ' <input id="' + id + '" autocomplete="off" spellcheck="false" /></label>' +
        '<span class="h" data-h></span><span class="crackline" aria-hidden="true"></span>';
      var input = li.querySelector("input");
      input.value = e.value;
      input.setAttribute("aria-label", "Entry " + (i + 1) + ", " + e.key);
      input.addEventListener("input", function () { entries[i].value = input.value; verify(); });
      list.appendChild(li);
    });
  }

  function verify() {
    return computeChain(entries).then(function (hashes) {
      var items = list.querySelectorAll(".entry");
      var firstBad = -1;
      hashes.forEach(function (h, i) {
        var bad = h !== stored[i];
        if (bad && firstBad < 0) firstBad = i;
        var li = items[i];
        li.querySelector("[data-h]").textContent = (bad ? "hash changed → " : "hash ") + short(h);
        li.querySelector(".crackline").style.transitionDelay = bad ? (i - Math.max(firstBad, 0)) * 0.14 + "s" : "0s";
        li.classList.toggle("cracked", bad);
      });
      var head = hashes[hashes.length - 1];
      currentEl.textContent = short(head);
      var ok = head === anchored;
      verdictEl.classList.toggle("bad", !ok);
      if (ok) {
        verdictEl.textContent = "✓ Verified. The head matches the anchor on 0G.";
      } else if (firstBad >= 0) {
        verdictEl.textContent = "✗ Entry #" + (firstBad + 1) + " was changed. Every hash from there on moved, and the head no longer matches the anchor.";
      } else {
        verdictEl.textContent = "✗ The chain is self-consistent now, but its head doesn’t match the anchor on 0G. The rewrite is still caught.";
      }
      return hashes;
    });
  }

  function reset() {
    entries = ORIGINAL.map(function (e) { return { key: e.key, value: e.value }; });
    return computeChain(entries).then(function (hashes) {
      stored = hashes.slice();
      anchored = hashes[hashes.length - 1];
      anchoredEl.textContent = short(anchored);
      render();
      return verify();
    });
  }

  // A forger rewrites every stored hash so the file agrees with itself.
  document.querySelector("[data-rechain]").addEventListener("click", function () {
    computeChain(entries).then(function (hashes) { stored = hashes.slice(); verify(); });
  });
  document.querySelector("[data-reset]").addEventListener("click", reset);

  reset();

  // The hero shows a real head too: the hash of its own sealed config.
  var heroHash = document.querySelector("[data-hero-hash]");
  if (heroHash) sha('model="model-a"|tools=mcp.json|maxTradeUsd=100000').then(function (h) { heroHash.textContent = short(h); });
})();
