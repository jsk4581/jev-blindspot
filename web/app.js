// jev-blindspot panel: EventSource client, one card per turn, sessions on the rail.
(() => {
  const PROTO = 1;
  const $ = (s, r = document) => r.querySelector(s);
  const sessionsEl = $("#sessions");
  const turnsEl = $("#turns");
  const emptyEl = $("#empty");
  const connEl = $("#conn");
  const bannerEl = $("#banner");
  const showQuietEl = $("#showQuiet");
  const themeBtn = $("#theme");
  const settingsBtn = $("#settings");
  const settingsDlg = $("#settingsDlg");
  const settingsForm = $("#settingsForm");
  const settingsMsg = $("#settingsMsg");
  const tplTurn = $("#tpl-turn");
  const tplFinding = $("#tpl-finding");

  // ---- copy -----------------------------------------------------------
  // Strings live in i18n.js. Brain items are in the prompt's language already; this only
  // picks the language of the fixed labels: a pinned choice, else the browser's.
  const I18N = window.JEV_I18N;
  const uiLangSel = $("#uiLangSel");
  function resolveLang(tags) {
    for (const raw of tags) {
      const tag = String(raw);
      if (I18N[tag]) return tag;
      const low = tag.toLowerCase();
      if (low.startsWith("zh")) return /hant|tw|hk|mo/.test(low) ? "zh-Hant" : "zh-Hans";
      const base = low.split("-")[0];
      if (I18N[base]) return base;
    }
    return "en";
  }

  const state = { sessions: new Map(), turns: new Map(), selected: null, open: new Set(), uiLang: null, conn: "connecting" };
  try { state.selected = localStorage.getItem("jev.selected"); } catch {}

  function pinnedLang() {
    try { const v = localStorage.getItem("jev.lang"); return v && I18N[v] ? v : "auto"; } catch { return "auto"; }
  }
  function uiLang() {
    const pinned = pinnedLang();
    return pinned !== "auto" ? pinned : resolveLang(navigator.languages || [navigator.language || "en"]);
  }
  function applyChrome() {
    const lang = uiLang();
    const L = I18N[lang];
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = L[el.dataset.i18n]; });
    $(".conn-label", connEl).textContent = L.conn[state.conn];
    themeBtn.title = L.theme[currentTheme()];
    settingsBtn.title = L.settings_title;
    uiLangSel.innerHTML = "";
    const auto = document.createElement("option"); auto.value = "auto"; auto.textContent = L.s_lang_auto; uiLangSel.appendChild(auto);
    for (const [tag, t] of Object.entries(I18N)) { const o = document.createElement("option"); o.value = tag; o.textContent = t.name; uiLangSel.appendChild(o); }
    uiLangSel.value = pinnedLang();
  }
  uiLangSel.onchange = () => {
    try { if (uiLangSel.value === "auto") localStorage.removeItem("jev.lang"); else localStorage.setItem("jev.lang", uiLangSel.value); } catch {}
    renderAll();
  };

  // ---- settings -------------------------------------------------------
  function fillSettings(data) {
    const cfg = data.config || {};
    for (const [k, v] of Object.entries(cfg)) {
      const el = settingsForm.elements[k];
      if (el) el.value = v;
    }
    const dl = $("#codexModels");
    dl.innerHTML = "";
    for (const m of data.codex_models || []) { const o = document.createElement("option"); o.value = m; dl.appendChild(o); }
  }
  async function openSettings() {
    settingsMsg.textContent = ""; settingsMsg.className = "dlg-msg";
    try {
      const r = await fetch("/api/config");
      fillSettings(await r.json());
    } catch (e) { settingsMsg.textContent = String(e); settingsMsg.className = "dlg-msg err"; }
    settingsDlg.showModal();
  }
  settingsBtn.onclick = openSettings;
  $("#settingsCancel").onclick = () => settingsDlg.close();
  settingsForm.onsubmit = async (e) => {
    e.preventDefault();
    const L = I18N[uiLang()];
    const body = {};
    for (const el of settingsForm.elements) if (el.name) body[el.name] = el.value.trim();
    const btn = $("#settingsSave"); btn.disabled = true;
    try {
      const r = await fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) throw new Error(`${L.save_failed}: ${(data.rejected || []).join(", ") || data.error || r.status}`);
      fillSettings(data);
      settingsMsg.textContent = data.rejected && data.rejected.length ? `${L.saved} ${L.save_failed}: ${data.rejected.join(", ")}` : L.saved;
      settingsMsg.className = data.rejected && data.rejected.length ? "dlg-msg err" : "dlg-msg ok";
      if (!(data.rejected && data.rejected.length)) setTimeout(() => settingsDlg.close(), 600);
    } catch (err) {
      settingsMsg.textContent = err.message || String(err); settingsMsg.className = "dlg-msg err";
    } finally { btn.disabled = false; }
  };

  // ---- theme ----------------------------------------------------------
  function currentTheme() { try { return localStorage.getItem("jev.theme") || "auto"; } catch { return "auto"; } }
  function applyTheme() {
    const t = currentTheme();
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = t;
    themeBtn.textContent = t === "light" ? "☼" : t === "dark" ? "☾" : "◐";
  }
  themeBtn.onclick = () => {
    const next = { auto: "light", light: "dark", dark: "auto" }[currentTheme()];
    try { localStorage.setItem("jev.theme", next); } catch {}
    applyTheme(); applyChrome();
  };

  // ---- sessions -------------------------------------------------------
  function selectedTurns() {
    return [...state.turns.values()].filter((t) => t.session_id === state.selected).sort((a, b) => b.ts - a.ts);
  }
  function fmtTokens(n) { return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
  function usageText(u) {
    const L = I18N[uiLang()];
    const parts = [`${fmtTokens(u.input_tokens)} ${L.tok_in}`];
    if (u.cached_input_tokens) parts[0] += ` (${fmtTokens(u.cached_input_tokens)} ${L.tok_cached})`;
    parts.push(`${fmtTokens(u.output_tokens)} ${L.tok_out}`);
    if (u.turns != null) parts.push(`${u.turns} ${L.tok_turns}`);
    if (u.cost_usd != null) parts.push(`$${u.cost_usd.toFixed(u.cost_usd < 0.1 ? 3 : 2)}`);
    return parts.join(" · ");
  }
  function renderSessions() {
    const L = I18N[uiLang()];
    const list = [...state.sessions.values()].sort((a, b) => b.last_ts - a.last_ts);
    sessionsEl.innerHTML = "";
    if (!state.selected && list.length) state.selected = list[0].session_id;
    for (const s of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "session" + (s.session_id === state.selected ? " active" : "");
      b.innerHTML = `<i class="dot"></i><span class="name"></span><span class="t"></span><span class="sub"><span class="n"></span><span class="agent"></span></span>`;
      $(".dot", b).style.background = dotColor(s.last_state);
      $(".name", b).textContent = s.cwd_base;
      $(".t", b).textContent = timeAgo(s.last_ts);
      $(".n", b).textContent = `${L.turns(s.turn_count)} · ${s.session_id.slice(0, 6)}${s.brain_tokens ? ` · ${fmtTokens(s.brain_tokens)} ${L.tok}` : ""}`;
      $(".agent", b).textContent = s.agent || "";
      b.title = s.cwd;
      b.onclick = () => select(s.session_id);
      sessionsEl.appendChild(b);
    }
  }
  function select(id) {
    state.selected = id;
    try { localStorage.setItem("jev.selected", id); } catch {}
    renderAll();
  }
  function dotColor(st) {
    return { analyzing: "var(--accent)", pending: "var(--text-muted)", done: "var(--success)", gate_unavailable: "var(--warning)", error: "var(--danger)" }[st] || "var(--text-faint)";
  }

  // ---- turns ----------------------------------------------------------
  function renderTurns() {
    const all = selectedTurns();
    const visible = all.filter((t) => showQuietEl.checked || t.state !== "quiet");
    turnsEl.querySelectorAll(".turn").forEach((n) => n.remove());
    emptyEl.hidden = visible.length > 0;
    visible.slice(0, 30).forEach((t, i) => {
      const open = i === 0 ? !state.open.has("closed:" + t.turn_id) : state.open.has(t.turn_id);
      turnsEl.appendChild(renderTurn(t, open, i === 0));
    });
  }

  function renderTurn(t, open, latest) {
    const L = I18N[uiLang()];
    const node = tplTurn.content.firstElementChild.cloneNode(true);
    node.dataset.state = t.state;
    node.dataset.turn = t.turn_id;
    node.classList.toggle("open", open);

    $(".state-pill", node).textContent = L.state[t.state] || t.state;
    $(".head-prompt", node).textContent = t.prompt.replace(/\s+/g, " ").trim();
    $(".when", node).textContent = fmtTime(t.ts);
    $(".turn-head", node).onclick = () => {
      if (latest) { if (open) state.open.add("closed:" + t.turn_id); else state.open.delete("closed:" + t.turn_id); }
      else { if (open) state.open.delete(t.turn_id); else state.open.add(t.turn_id); }
      renderTurns();
    };

    const risk = $(".risk-pill", node);
    if (t.gate) {
      risk.hidden = false;
      risk.textContent = `${L.risk} ${t.gate.risk.toFixed(1)}`;
      risk.classList.toggle("high", t.gate.risk >= 3.5);
      risk.classList.toggle("mid", t.gate.risk >= 2.5 && t.gate.risk < 3.5);
    }

    const prompt = $(".prompt", node);
    prompt.textContent = t.prompt;
    if (t.prompt.length > 420 || t.prompt.split("\n").length > 6) {
      prompt.classList.add("long");
      prompt.onclick = () => prompt.classList.toggle("expanded");
    }

    const chips = $(".chips", node);
    if (t.result && t.result.domains && t.result.domains.length) {
      chips.hidden = false;
      chips.appendChild(label(L.lenses));
      for (const d of t.result.domains) chips.appendChild(chip(d, "domain"));
    } else if (t.gate_decision && t.gate_decision.flagged_gaps.length && t.state !== "quiet") {
      chips.hidden = false;
      chips.appendChild(label(L.flags));
      for (const g of t.gate_decision.flagged_gaps) chips.appendChild(chip(L.gap[g] || g, "gap"));
    }

    const quiet = $(".quiet-line", node);
    if (t.state === "quiet" && t.gate && t.gate_decision) {
      quiet.hidden = false;
      const top = t.gate_decision.top_gaps.map((g) => `${L.gap[g.key] || g.key} ${g.p.toFixed(2)}`).join(" · ");
      quiet.innerHTML = `<span class="r"></span> <span class="p"></span>`;
      $(".r", quiet).textContent = L.reason[t.gate_decision.reason] || t.gate_decision.reason || "";
      $(".p", quiet).textContent = `${L.worth} ${t.gate.worth_checking.toFixed(2)} · ${L.risk} ${t.gate.risk.toFixed(1)} · ${top}`;
    }
    const err = $(".err-line", node);
    if ((t.state === "error" || t.state === "gate_unavailable") && t.error) {
      err.hidden = false;
      err.textContent = `${t.error.stage}: ${t.error.message}`;
    }

    const findings = $(".findings", node);
    if (t.result && t.state === "done") {
      if (!t.result.items.length) {
        const p = document.createElement("p"); p.className = "findings-none"; p.textContent = L.none;
        findings.appendChild(p);
      }
      for (const it of t.result.items) findings.appendChild(renderFinding(it, L));
    }

    const meta = [];
    if (t.agent) meta.push(t.agent);
    if (t.gate_latency_ms != null) meta.push(`${L.gate} ${t.gate_latency_ms} ms`);
    if (t.brain_ms != null) meta.push(`${L.brain} ${(t.brain_ms / 1000).toFixed(1)} s`);
    if (t.brain_model) meta.push(t.brain_model);
    if (t.brain_usage) meta.push(usageText(t.brain_usage));
    if (t.gate && t.gate.model && t.gate.model !== "fake") meta.push(t.gate.model);
    $(".meta", node).textContent = meta.join(" · ");
    return node;
  }

  function chip(text, cls) {
    const c = document.createElement("span");
    c.className = "chip " + cls;
    c.textContent = text;
    return c;
  }
  function label(text) {
    const c = document.createElement("span");
    c.className = "chips-label";
    c.textContent = text;
    return c;
  }

  function renderFinding(it, L) {
    const node = tplFinding.content.firstElementChild.cloneNode(true);
    const sev = $(".sev", node);
    sev.classList.add(it.severity);
    sev.textContent = L.sev[it.severity] || it.severity;
    $(".f-title", node).textContent = it.title;
    $(".f-domain", node).textContent = it.domain;
    $(".f-why", node).textContent = it.why;
    if (it.suggestion) {
      const s = $(".f-suggest", node);
      s.hidden = false;
      $("pre", s).textContent = it.suggestion;
      const btn = $("button.copy", s);
      btn.textContent = L.copy;
      btn.onclick = async (e) => {
        e.preventDefault();
        const ok = await copyText(it.suggestion);
        btn.textContent = ok ? L.copied : L.failed;
        setTimeout(() => (btn.textContent = L.copy), 1500);
      };
    }
    return node;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch {}
    // A plain-http origin other than localhost is not a secure context: fall back to execCommand.
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const sameDay = new Date().toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
  }
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  function renderAll() { renderSessions(); renderTurns(); applyChrome(); }

  // ---- transport ------------------------------------------------------
  function setConn(c) { state.conn = c; connEl.dataset.conn = c; applyChrome(); }
  function applySnapshot(snap) {
    state.sessions.clear(); state.turns.clear();
    for (const s of snap.sessions) state.sessions.set(s.session_id, s);
    for (const t of snap.turns) state.turns.set(t.turn_id, t);
    if (snap.v !== PROTO) { bannerEl.textContent = `Panel protocol ${PROTO}, daemon ${snap.v}: reload the page.`; bannerEl.hidden = false; }
    if (state.selected && !state.sessions.has(state.selected)) state.selected = null;
    renderAll();
  }
  function upsertTurn(t) {
    state.turns.set(t.turn_id, t);
    if (!state.sessions.has(t.session_id)) {
      state.sessions.set(t.session_id, { session_id: t.session_id, cwd: t.cwd, cwd_base: t.cwd.split("/").pop() || t.cwd, last_ts: t.ts, turn_count: 1, last_state: t.state });
    }
    // A new prompt in another session pulls focus: that is where the user is typing.
    if (t.state === "pending" && t.session_id !== state.selected) {
      state.selected = t.session_id;
      try { localStorage.setItem("jev.selected", t.session_id); } catch {}
    }
    renderAll();
  }
  function connect() {
    const es = new EventSource("/events");
    es.onopen = () => setConn("live");
    es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    es.addEventListener("snapshot", (e) => applySnapshot(JSON.parse(e.data)));
    es.addEventListener("session", (e) => { const s = JSON.parse(e.data); state.sessions.set(s.session_id, s); renderSessions(); });
    es.addEventListener("turn", (e) => upsertTurn(JSON.parse(e.data)));
    es.addEventListener("config", (e) => { if (settingsDlg.open) fillSettings({ config: JSON.parse(e.data) }); });
  }

  showQuietEl.onchange = renderTurns;
  setInterval(renderSessions, 30000);
  applyTheme();
  applyChrome();
  connect();
})();
