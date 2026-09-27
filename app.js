(function () {
  "use strict";

  var app = document.getElementById("app");
  var SPEAKER_COLORS = ["#6f88a8", "#b07a7e", "#8e82a6", "#a88c67", "#6f9990", "#978d62"];
  var DIALOGUE_ACCENTS = ["#a5b894", "#9db5c6", "#d2b69a", "#b5aac6", "#9ebdb4", "#c9a8b2"];
  var ALLOWED = { B: 1, I: 1, U: 1, S: 1, MARK: 1, P: 1, H4: 1, UL: 1, LI: 1, BR: 1, EM: 1, STRONG: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1 };

  // ---------- helpers ----------
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.appendChild(safeHtml(attrs[k]));
      else if (k === "text") e.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }

  function num(n) { return String(n == null ? "" : n).replace(/[\s.)]+$/, ""); }

  function safeHtml(html) {
    var doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
    var frag = document.createDocumentFragment();
    (function copy(src, dst) {
      src.childNodes.forEach(function (n) {
        if (n.nodeType === 3) dst.appendChild(document.createTextNode(n.textContent));
        else if (n.nodeType === 1) {
          if (ALLOWED[n.tagName]) { var c = document.createElement(n.tagName); dst.appendChild(c); copy(n, c); }
          else copy(n, dst);
        }
      });
    })(doc.body.firstChild, frag);
    return frag;
  }

  function norm(s) {
    return (s || "").normalize("NFC").toLowerCase().replace(/[*’]/g, function (c) { return c === "’" ? "'" : ""; })
      .replace(/\s+/g, " ").replace(/^[\s.,;:!?]+|[\s.,;:!?]+$/g, "").trim();
  }
  function matches(given, expected) {
    return expected.split("|").some(function (alt) { return norm(alt) === norm(given); });
  }
  function fmt(t) {
    if (!isFinite(t)) return "0:00";
    var s = Math.floor(t);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }

  var NS = "ebook:" + location.pathname + ":";
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(NS + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- progress (answers, scores, last seen), synced across devices ----------
  // Each entry is {v, t}: merging two devices keeps, per key, the most recent write.
  var P = {
    data: store.get("progress", null),
    get: function (k, d) { var e = P.data[k]; return e && e.v != null ? e.v : d; },
    set: function (k, v) { P.data[k] = { v: v, t: Date.now() }; P.save(); sync.schedule(); },
    save: function () { store.set("progress", P.data); },
    merge: function (other) {
      var changed = false, newer = false;
      Object.keys(other).forEach(function (k) {
        var a = P.data[k], b = other[k];
        if (!a || b.t > a.t) { P.data[k] = b; changed = true; }
      });
      Object.keys(P.data).forEach(function (k) { if (!other[k] || P.data[k].t > other[k].t) newer = true; });
      if (changed) P.save();
      return { changed: changed, newer: newer };
    }
  };
  if (!P.data) {  // first run of this version: move answers saved by the previous one
    P.data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k.indexOf(NS + "u") === 0 || k === NS + "last") {
        try { P.data[k.slice(NS.length)] = { v: JSON.parse(localStorage.getItem(k)), t: 1 }; } catch (e) {}
      }
    }
    P.save();
  }

  function utf8b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64utf8(s) { return decodeURIComponent(escape(atob(s.replace(/\s/g, "")))); }

  var sync = {
    sha: null, timer: null, running: null,
    cfg: function () { return EBOOK.sync && EBOOK.sync.token ? EBOOK.sync : null; },
    url: function () { return "https://api.github.com/repos/" + sync.cfg().repo + "/contents/" + EBOOK.id + ".json"; },
    headers: function () { return { Authorization: "Bearer " + sync.cfg().token, Accept: "application/vnd.github+json" }; },
    pull: function () {
      if (!sync.cfg()) return Promise.resolve({ changed: false, newer: false });
      return fetch(sync.url(), { headers: sync.headers(), cache: "no-store" }).then(function (r) {
        if (r.status === 404) { sync.sha = null; return { changed: false, newer: true }; }
        if (!r.ok) throw new Error("sync " + r.status);
        return r.json().then(function (j) { sync.sha = j.sha; return P.merge(JSON.parse(b64utf8(j.content))); });
      });
    },
    push: function (retry) {
      var body = { message: "progress", content: utf8b64(JSON.stringify(P.data)) };
      if (sync.sha) body.sha = sync.sha;
      return fetch(sync.url(), { method: "PUT", headers: sync.headers(), body: JSON.stringify(body) }).then(function (r) {
        if ((r.status === 409 || r.status === 422) && !retry) {  // another device wrote first
          return sync.pull().then(function () { return sync.push(true); });
        }
        if (!r.ok) throw new Error("sync " + r.status);
        return r.json().then(function (j) { sync.sha = j.content.sha; });
      });
    },
    // pull, merge, and push back whatever this device has that the server doesn't
    now: function () {
      if (!sync.cfg()) return Promise.resolve(false);
      if (sync.running) return sync.running;
      clearTimeout(sync.timer);
      sync.running = sync.pull().then(function (m) {
        return (m.newer ? sync.push() : Promise.resolve()).then(function () { return m.changed; });
      }).catch(function (e) { console.warn(e); return false; })
        .then(function (changed) { sync.running = null; return changed; });
      return sync.running;
    },
    schedule: function () {
      if (!sync.cfg()) return;
      clearTimeout(sync.timer);
      sync.timer = setTimeout(sync.now, 2000);
    }
  };
  document.addEventListener("visibilitychange", function () {
    if (!sync.cfg()) return;
    if (document.visibilityState === "hidden") { if (sync.timer) sync.now(); return; }
    var typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    sync.now().then(function (changed) { if (changed && !typing) route(); });
  });

  // ---------- encrypted deployment ----------
  var aesKey = null;
  var assetCache = {};
  var MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", mp3: "audio/mpeg" };

  function b64bytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function bytesb64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }
  function decrypt(buf, key) {
    var u = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, key || aesKey, u.slice(12));
  }
  function fetchBytes(path, opts) {
    return fetch(path, opts).then(function (r) { if (!r.ok) throw new Error(path); return r.arrayBuffer(); });
  }
  function fetchJson(path) {
    // revalidate: GitHub Pages lets browsers reuse files for 10 min, which would pair a new app with old data
    return fetchBytes(path, { cache: "no-cache" }).then(decrypt).then(function (b) { return JSON.parse(new TextDecoder().decode(b)); });
  }
  function asset(src) {
    if (!EBOOK.encrypted) return Promise.resolve(src);
    if (!assetCache[src]) {
      var type = MIME[src.split(".").pop().toLowerCase()] || "application/octet-stream";
      assetCache[src] = fetchBytes(src + ".enc").then(decrypt)
        .then(function (b) { return URL.createObjectURL(new Blob([b], { type: type })); });
    }
    return assetCache[src];
  }

  function verify(key) {
    return decrypt(b64bytes(EBOOK.crypto.check), key).then(function () { return key; });
  }
  function deriveKey(pw) {
    var c = EBOOK.crypto;
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64bytes(c.salt), iterations: c.iterations, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
      });
  }
  function importKey(raw) {
    return crypto.subtle.importKey("raw", b64bytes(raw), { name: "AES-GCM" }, true, ["decrypt"]);
  }

  function unlock() {
    var saved = store.get("key:" + EBOOK.crypto.salt, null);
    var tried = saved ? importKey(saved).then(verify) : Promise.reject();
    return tried.catch(function () {
      return new Promise(function (resolve) {
        var input = el("input", { type: "password", class: "pw", placeholder: "Mot de passe", autocomplete: "current-password" });
        var msg = el("p", { class: "pw-msg" });
        var form = el("form", { class: "card unlock" }, [
          el("h2", { text: "🔒 Accès privé" }), input, el("button", { type: "submit", text: "Ouvrir" }), msg
        ]);
        form.onsubmit = function (e) {
          e.preventDefault();
          msg.textContent = "…";
          deriveKey(input.value).then(verify).then(function (key) {
            return crypto.subtle.exportKey("raw", key).then(function (raw) {
              store.set("key:" + EBOOK.crypto.salt, bytesb64(raw));
              resolve(key);
            });
          }).catch(function () { msg.textContent = "Mot de passe incorrect."; input.select(); });
        };
        app.innerHTML = "";
        app.appendChild(form);
        input.focus();
      });
    }).then(function (key) { aesKey = key; });
  }

  // ---------- font size ----------
  var fs = store.get("fs", 17);
  function applyFs() { document.documentElement.style.setProperty("--fs", fs + "px"); store.set("fs", fs); }
  applyFs();
  document.getElementById("font-inc").onclick = function () { fs = Math.min(fs + 1, 24); applyFs(); };
  document.getElementById("font-dec").onclick = function () { fs = Math.max(fs - 1, 13); applyFs(); };

  // ---------- theme ----------
  var theme = store.get("theme", "light");
  var themeBtn = document.getElementById("theme");
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", theme);
    themeBtn.textContent = theme === "dark" ? "☀︎" : "☾";
    themeBtn.title = theme === "dark" ? "Thème clair" : "Thème sombre";
    store.set("theme", theme);
  }
  applyTheme();
  themeBtn.onclick = function () { theme = theme === "dark" ? "light" : "dark"; applyTheme(); };

  // ---------- audio player ----------
  var current = null;
  var SPEEDS = [1, 0.9, 0.75, 1.25];

  function skipIcon(forward) {
    var arc = forward ? "M18.06 9.5A7 7 0 1 1 12 6" : "M5.94 9.5A7 7 0 1 0 12 6";
    var head = forward ? "M9.6 3.6L12 6 9.6 8.4" : "M14.4 3.6L12 6l2.4 2.4";
    return '<svg viewBox="2 1 20 20" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + arc + '"/><path d="' + head + '"/>' +
      '<text x="12" y="16.2" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">5</text></svg>';
  }

  function player(src, title) {
    var a = new Audio();
    a.preload = "metadata";
    asset(src).then(function (u) { a.src = u; });
    var play = el("button", { class: "play", title: "Lecture / pause", text: "▶" });
    var back = el("button", { class: "skip", title: "Reculer de 5 s", "aria-label": "Reculer de 5 s" });
    var fwd = el("button", { class: "skip", title: "Avancer de 5 s", "aria-label": "Avancer de 5 s" });
    back.innerHTML = skipIcon(false);
    fwd.innerHTML = skipIcon(true);
    var bar = el("input", { class: "bar", type: "range", min: 0, max: 1000, value: 0, "aria-label": "Position" });
    var time = el("span", { class: "time", text: "0:00 / 0:00" });
    var sp = 0;
    var speed = el("button", { class: "speed", title: "Vitesse", text: "1×" });
    var loop = el("button", { class: "loop", title: "Répéter", "aria-label": "Répéter" });
    loop.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>';

    function seek(d) { a.currentTime = Math.max(0, Math.min((a.duration || 0), a.currentTime + d)); }
    play.onclick = function () { a.paused ? a.play() : a.pause(); };
    back.onclick = function () { seek(-5); };
    fwd.onclick = function () { seek(5); };
    speed.onclick = function () { sp = (sp + 1) % SPEEDS.length; a.playbackRate = SPEEDS[sp]; speed.textContent = SPEEDS[sp] + "×"; };
    loop.onclick = function () { a.loop = !a.loop; loop.classList.toggle("on", a.loop); };
    bar.oninput = function () { if (a.duration) a.currentTime = bar.value / 1000 * a.duration; };
    function tick() {
      time.textContent = fmt(a.currentTime) + " / " + fmt(a.duration);
      if (a.duration && document.activeElement !== bar) bar.value = a.currentTime / a.duration * 1000;
    }
    a.addEventListener("timeupdate", tick);
    a.addEventListener("loadedmetadata", tick);
    a.addEventListener("play", function () {
      if (current && current !== a) current.pause();
      current = a;
      play.textContent = "❚❚";
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: title, artist: EBOOK.title });
        navigator.mediaSession.setActionHandler("seekbackward", function () { seek(-5); });
        navigator.mediaSession.setActionHandler("seekforward", function () { seek(5); });
        navigator.mediaSession.setActionHandler("play", function () { a.play(); });
        navigator.mediaSession.setActionHandler("pause", function () { a.pause(); });
      }
    });
    a.addEventListener("pause", function () { play.textContent = "▶"; });
    a.addEventListener("ended", function () { play.textContent = "▶"; });
    return el("div", { class: "player" }, [back, play, fwd, bar, time, speed, loop]);
  }

  document.addEventListener("keydown", function (e) {
    if (!current || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); current.paused ? current.play() : current.pause(); }
    else if (e.code === "ArrowLeft") current.currentTime = Math.max(0, current.currentTime - 5);
    else if (e.code === "ArrowRight") current.currentTime += 5;
  });

  // ---------- lesson blocks ----------
  function photos(list) {
    return (list || []).map(function (p) {
      var img = el("img", { class: "photo", alt: p.alt || "" });
      asset(p.src).then(function (u) { img.src = u; });
      return img;
    });
  }

  function renderDialogue(b, idx) {
    var accent = DIALOGUE_ACCENTS[idx % DIALOGUE_ACCENTS.length];
    var speakers = {};
    var lines = (b.lines || []).map(function (l) {
      if (!(l.speaker in speakers)) speakers[l.speaker] = SPEAKER_COLORS[Object.keys(speakers).length % SPEAKER_COLORS.length];
      var line = el("p", { class: "line" }, [
        el("span", { class: "speaker", text: l.speaker }),
        el("span", { class: "txt", html: l.text })
      ]);
      line.style.setProperty("--c", speakers[l.speaker]);
      return line;
    });
    var card = el("section", { class: "card dialogue" }, [
      el("h2", {}, [el("span", { class: "badge", text: b.number || "" }), el("span", { html: b.title })]),
      b.audio ? player(b.audio, (b.number ? num(b.number) + ". " : "") + b.title) : null
    ].concat(photos(b.photos), [el("div", { class: "lines" }, lines)]));
    card.style.setProperty("--accent", accent);
    return card;
  }

  function renderBlock(b, idx) {
    if (b.kind === "dialogue") return renderDialogue(b, idx);
    if (b.kind === "text" || b.kind === "other") {
      return el("section", { class: "card text-block" }, [
        el("h2", {}, [b.number ? el("span", { class: "badge", text: b.number }) : null, el("span", { html: b.title })])
      ].concat(photos(b.photos), [el("div", { html: b.html })]));
    }
    return el("section", { class: "box " + b.kind }, [el("h3", { html: b.title })]
      .concat(photos(b.photos), [el("div", { html: b.html })]));
  }

  // ---------- exercises ----------
  function renderPrompt(it, ex, state, controls) {
    var wrap = el("span", { class: "prompt" });
    var parts = it.prompt.split(/(\{\{[^}]+\}\}|_{3,})/);
    var slot = 0;
    parts.forEach(function (part) {
      var m = part.match(/^\{\{([^}]+)\}\}$/);
      if (m && ex.type === "choice") {
        var i = slot++;
        var multi = m[1].charAt(0) === "+";  // {{+a|b|c}}: several options may be right
        var group = el("span", { class: "tf" });
        m[1].replace(/<[^>]+>/g, "").replace(/^\+/, "").split("|").forEach(function (opt) {
          var on = multi ? (state.v[i] || []).indexOf(opt) >= 0 : state.v[i] === opt;
          var c = el("button", { class: "chip" + (on ? " sel" : ""), text: opt, type: "button" });
          c.onclick = function () {
            if (multi) {
              var sel = (state.v[i] || []).filter(function (x) { return x !== opt; });
              if (!c.classList.contains("sel")) sel.push(opt);
              state.v[i] = sel; state.save();
              c.className = "chip" + (sel.indexOf(opt) >= 0 ? " sel" : "");
              return;
            }
            state.v[i] = opt; state.save();
            group.querySelectorAll(".chip").forEach(function (x) { x.className = "chip" + (x === c ? " sel" : ""); });
          };
          group.appendChild(c);
        });
        controls.push({ kind: multi ? "multi" : "choice", i: i, node: group });
        wrap.appendChild(group);
      } else if (/^_{3,}$/.test(part) && (ex.type === "fill_blank" || ex.type === "choice")) {
        var j = slot++;
        var inp = el("input", { class: "blank", type: "text", autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
        inp.value = state.v[j] || "";
        var grow = function () { inp.style.width = inp.value.length > 6 ? "calc(" + inp.value.length + "ch + 1.5rem)" : ""; };
        grow();
        inp.oninput = function () { grow(); state.v[j] = inp.value; state.save(); inp.className = "blank"; };
        controls.push({ kind: "blank", i: j, node: inp });
        wrap.appendChild(inp);
      } else if (part) {
        wrap.appendChild(safeHtml(part));
      }
    });
    return wrap;
  }

  function renderItem(it, ex, unitKey) {
    var skey = unitKey + ":" + it.n;
    var state = { v: P.get(skey, null) || {}, save: function () { P.set(skey, state.v); } };
    var controls = [];
    var li = el("li", { class: "item" }, [el("span", { class: "n", text: num(it.n) + "." })]);
    if (ex.type !== "photo_comment") li.appendChild(renderPrompt(it, ex, state, controls));

    if (ex.type === "true_false") {
      var group = el("span", { class: "tf" });
      ["oui", "non"].forEach(function (opt) {
        var c = el("button", { class: "chip" + (state.v.tf === opt ? " sel" : ""), text: opt === "oui" ? "Oui" : "Non", type: "button" });
        c.dataset.v = opt;
        c.onclick = function () {
          state.v.tf = opt; state.save();
          group.querySelectorAll(".chip").forEach(function (x) { x.className = "chip" + (x === c ? " sel" : ""); });
        };
        group.appendChild(c);
      });
      controls.push({ kind: "tf", node: group });
      li.appendChild(group);
    }
    photos(it.photos).forEach(function (p) { li.appendChild(p); });
    if (/rewrite|open|photo_comment/.test(ex.type) || (ex.type === "choice" && !controls.length)) {
      var ta = el("textarea", { rows: ex.type === "rewrite" ? 1 : 3, placeholder: "Votre réponse…" });
      ta.value = state.v.text || "";
      ta.oninput = function () { state.v.text = ta.value; state.save(); };
      li.appendChild(ta);
    }
    if (it.key) {
      var key = el("div", { class: "key" }, [el("div", { html: it.key.model_answer })]);
      if (it.key.explanation) key.appendChild(el("div", { class: "expl", html: it.key.explanation }));
      li.appendChild(key);
    }

    li.check = function () {
      var ans = (it.key && it.key.answers) || [];
      if (!ans.length || !controls.length) return null;
      var ok = true;
      controls.forEach(function (c) {
        if (c.kind === "tf") {
          c.node.querySelectorAll(".chip").forEach(function (x) {
            x.classList.remove("right", "wrong");
            if (x.dataset.v === norm(ans[0])) x.classList.add("right");
            else if (x.classList.contains("sel")) x.classList.add("wrong");
          });
          ok = ok && state.v.tf === norm(ans[0]);
        } else if (c.kind === "choice") {
          var exp = ans[c.i] || "";
          c.node.querySelectorAll(".chip").forEach(function (x) {
            x.classList.remove("right", "wrong");
            if (matches(x.textContent, exp)) x.classList.add("right");
            else if (x.classList.contains("sel")) x.classList.add("wrong");
          });
          ok = ok && matches(state.v[c.i] || "", exp);
        } else if (c.kind === "multi") {
          var a = ans[c.i] || "";
          var want = a.split(a.indexOf("|") >= 0 ? "|" : /[\s,;+]+/).filter(Boolean).map(norm);
          var got = (state.v[c.i] || []).map(norm);
          c.node.querySelectorAll(".chip").forEach(function (x) {
            x.classList.remove("right", "wrong");
            if (want.indexOf(norm(x.textContent)) >= 0) x.classList.add("right");
            else if (x.classList.contains("sel")) x.classList.add("wrong");
          });
          ok = ok && got.length === want.length && got.every(function (g) { return want.indexOf(g) >= 0; });
        } else if (c.kind === "blank") {
          var good = matches(c.node.value, ans[c.i] || "");
          c.node.className = "blank " + (good ? "right" : "wrong");
          ok = ok && good;
        }
      });
      li.classList.remove("ok", "ko");
      li.classList.add(ok ? "ok" : "ko");
      return ok;
    };
    return li;
  }

  function renderExercise(ex, page, unit) {
    var unitKey = "u" + unit + ":p" + page + ":e" + ex.number;
    var items = ex.items.map(function (it) { return renderItem(it, ex, unitKey); });
    var hasKey = ex.items.some(function (it) { return it.key; });
    var checkable = /true_false|choice|fill_blank/.test(ex.type);
    var score = el("span", { class: "score" });
    var cat = (ex.category || "").trim();
    var soloPrompt = ex.items.length === 1 && norm(ex.items[0].prompt) === norm(ex.instruction);
    var card = el("section", { class: "card exercise" }, [
      el("h2", {}, [
        el("span", { class: "num", text: ex.number }),
        cat ? el("span", { class: "cat", text: cat + (/[.!?:]$/.test(cat) ? " " : ". ") }) : null,
        soloPrompt ? null : el("span", { html: ex.instruction })
      ]),
      ex.audio ? player(ex.audio, document.title + " — " + ex.number) : null,
      ex.transcript ? el("details", { class: "transcript" }, [
        el("summary", { text: "Transcription" }), el("div", { html: ex.transcript })]) : null
    ].concat(photos(ex.photos), [el("ol", { class: "items" }, items)]));

    var actions = el("div", { class: "ex-actions" });
    var hasChecks = ex.items.some(function (it) { return it.key && it.key.answers && it.key.answers.length; });
    var check = function () {
      var n = 0, t = 0;
      items.forEach(function (li) { var r = li.check(); if (r !== null) { t++; if (r) n++; } });
      return [n, t];
    };
    if (checkable && hasChecks) {
      actions.appendChild(el("button", {
        text: "Vérifier", type: "button", onclick: function () {
          var r = check();
          score.textContent = r[0] + " / " + r[1];
          P.set(unitKey + ":score", r);
          updateDone(unit);
        }
      }));
    }
    if (hasKey) {
      unitExercises.push(unitKey);
      var btn = el("button", {
        class: "secondary", type: "button", text: "Afficher le corrigé", onclick: function () {
          var on = card.classList.toggle("show-key");
          btn.textContent = on ? "Masquer le corrigé" : "Afficher le corrigé";
          if (on) { P.set(unitKey + ":shown", true); updateDone(unit); }
        }
      });
      actions.appendChild(btn);
      actions.appendChild(el("span", { class: "ai-note", text: ex.official_key ? "corrigé officiel" : "corrigé proposé (IA)" }));
    }
    actions.appendChild(score);
    var saved = P.get(unitKey + ":score", null);
    if (saved) score.textContent = "dernier score : " + saved[0] + " / " + saved[1];
    actions.appendChild(el("button", {
      class: "reset", type: "button", text: "Réinitialiser", title: "Effacer mes réponses de cet exercice",
      onclick: function () {
        if (!confirm("Effacer vos réponses pour cet exercice ?")) return;
        ex.items.forEach(function (it) { P.set(unitKey + ":" + it.n, null); });
        P.set(unitKey + ":score", null);
        P.set(unitKey + ":shown", null);
        card.replaceWith(renderExercise(ex, page, unit));
        updateDone(unit);
      }
    }));
    card.appendChild(actions);
    if (saved && checkable && hasChecks) check();  // show last session's right/wrong marks again
    return card;
  }

  // a unit is done when every exercise with a corrigé was checked or had its corrigé opened
  var unitExercises = [];
  function updateDone(unit) {
    var done = unitExercises.length > 0 && unitExercises.every(function (k) {
      return P.get(k + ":score", null) || P.get(k + ":shown", null);
    });
    if (done !== P.get("done:" + unit, false)) P.set("done:" + unit, done);
  }

  // ---------- views ----------
  function home() {
    document.title = EBOOK.title;
    app.innerHTML = "";
    var list = null, section;
    EBOOK.index.forEach(function (u) {
      if (!list || u.section !== section) {
        section = u.section;
        if (section) app.appendChild(el("h2", { class: "section-title", text: section }));
        list = el("ul", { class: "unit-list" });
        app.appendChild(list);
      }
      list.appendChild(el("li", {}, [el("a", { href: "#/u/" + u.unit }, [
        el("span", { class: "num", text: u.label || u.unit }),
        el("span", { text: u.title }),
        seenTag(u.unit),
        el("span", { class: "pages", text: "p. " + u.from + "–" + u.to })
      ])]));
    });
  }

  // ---------- original pages ----------
  function pageRange(scans) {
    var a = scans[0].page, b = scans[scans.length - 1].page;
    return a === b ? "p. " + a : "p. " + a + "–" + b;
  }

  function showScans(scans) {
    var pages = scans.map(function (s) {
      var img = el("img", { alt: "page " + s.page, title: "Toucher pour agrandir" });
      img.onclick = function () { img.classList.toggle("zoom"); };
      asset(s.src).then(function (u) { img.src = u; });
      return el("figure", {}, [img, el("figcaption", { text: "page " + s.page })]);
    });
    var viewer = el("div", { class: "scan-viewer", role: "dialog", "aria-label": "Pages du livre" }, [
      el("div", { class: "scan-bar" }, [
        el("span", { text: "Pages du livre · " + pageRange(scans) }),
        el("button", { type: "button", title: "Fermer (Échap)", text: "✕", onclick: close })
      ]),
      el("div", { class: "scan-pages" }, pages)
    ]);
    function close() {
      viewer.remove();
      document.body.classList.remove("no-scroll");
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", close);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", close);
    document.body.classList.add("no-scroll");
    document.body.appendChild(viewer);
  }

  var MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  function seenTag(unit) {
    var t = P.get("seen:" + unit, null);
    if (!t) return null;
    var d = new Date(t), now = new Date();
    var date = d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
    return el("span", { class: "seen", title: "Vu pour la dernière fois le " + d.toLocaleString("fr-FR") }, [
      "vu le " + date, P.get("done:" + unit, false) ? el("span", { class: "tick", text: " ✓", title: "Terminé" }) : null
    ]);
  }

  function loadUnit(n, cb) {
    if (EBOOK.units[n]) return cb(EBOOK.units[n]);
    if (EBOOK.encrypted) {
      return fetchJson("data/unit" + ("0" + n).slice(-2) + ".enc")
        .then(function (d) { EBOOK.units[n] = d; cb(d); })
        .catch(function () { app.textContent = "Unité introuvable."; });
    }
    var s = document.createElement("script");
    s.src = "data/unit" + ("0" + n).slice(-2) + ".js";
    s.onload = function () { cb(EBOOK.units[n]); };
    s.onerror = function () { app.textContent = "Unité introuvable."; };
    document.body.appendChild(s);
  }

  function unitView(n) {
    loadUnit(n, function (u) {
      if (current) current.pause();
      unitExercises = [];
      P.set("seen:" + u.unit, Date.now());
      document.title = (u.label || u.unit) + ". " + u.title;
      app.innerHTML = "";
      var pos = EBOOK.index.findIndex(function (x) { return x.unit === u.unit; });
      var prev = EBOOK.index[pos - 1], next = EBOOK.index[pos + 1];
      app.appendChild(el("nav", { class: "nav" }, [
        prev ? el("a", { href: "#/u/" + prev.unit, text: "← " + (prev.label || prev.unit) + ". " + prev.title }) : el("span"),
        el("a", { href: "#", class: "toc-link", text: "Sommaire" }),
        next ? el("a", { href: "#/u/" + next.unit, text: (next.label || next.unit) + ". " + next.title + " →" }) : el("span")
      ]));
      var scans = u.scans || [];
      app.appendChild(el("div", { class: "unit-head" }, [
        el("span", { class: "num", text: u.label || u.unit }), el("h1", { text: u.title }),
        scans.length ? el("button", {
          class: "scans-btn", type: "button", title: "Voir les pages originales du livre",
          text: "📖 " + pageRange(scans), onclick: function () { showScans(scans); }
        }) : null
      ]));
      var d = 0;
      u.pages.forEach(function (p) {
        if (p.kind === "activities") app.appendChild(el("div", { class: "activities-banner", text: "ACTIVITÉS" }));
        app.appendChild(el("div", { class: "page-tag", text: "page " + p.page }));
        var row = null;
        p.blocks.forEach(function (b, i) {
          var node = renderBlock(b, b.kind === "dialogue" ? d++ : 0);
          var next = p.blocks[i + 1];
          var pairable = function (x) { return x && (x.kind === "grammaire" || x.kind === "vocabulaire") && !(x.photos || []).length; };
          if (row) { row.appendChild(node); app.appendChild(row); row = null; return; }
          if (pairable(b) && pairable(next)) { row = el("div", { class: "box-row" }, [node]); return; }
          if (/^(vocabulaire|manieres_de_dire)$/.test(b.kind)) node.classList.add("two-col");
          app.appendChild(node);
        });
        p.exercises.forEach(function (ex) { app.appendChild(renderExercise(ex, p.page, u.unit)); });
      });
      window.scrollTo(0, 0);
      P.set("last", u.unit);
    });
  }

  function route() {
    var m = location.hash.match(/^#\/u\/(\d+)/);
    if (m) unitView(parseInt(m[1], 10)); else home();
  }
  function start() {
    window.addEventListener("hashchange", route);
    // show the page right away from this device's copy, then refresh if another device had newer progress
    route();
    sync.now().then(function (changed) { if (changed) route(); });
  }
  if (!EBOOK.encrypted) start();
  else unlock().then(function () { return fetchJson("data/index.enc"); }).then(function (idx) {
    EBOOK.title = idx.title;
    EBOOK.index = idx.index;
    EBOOK.id = idx.id;
    EBOOK.sync = idx.sync;
    start();
  });
})();
