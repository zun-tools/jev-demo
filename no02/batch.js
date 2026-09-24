(() => {
"use strict";
// 差し戻しデモ（/batch）非同期版。閾値の判定はしない（サーバーの decided_by / pending に従うだけ）。
// JEV と Claude に渡す観測は #ticket-pane の中の文字と、その中で見えている押せるボタンだけ。
// JEV は1本の流れで件を順に進める。手が Claude に回ったらその件を保留にしてすぐ次の件へ。
// Claude の返事（GET /api/escalate/claude）が来たら、その件に戻って押し、残りの手を JEV で続ける。
// 手の数と名前は cfg.steps から取る（v1 は2手、v2 は3手: 担当 → 優先度 → 返信の型）。
// 主メーター「Claude 呼び出し n／M 手」・手ごとのメーター・往復カウンターは、ブラウザーが自分の記録から数え、
// finish で meter として送る（サーバーは自分の集計と突き合わせて meter_consistent を書く）。
const qs = new URLSearchParams(location.search);
const TAKE = qs.get("take") || "";
const AUTO = qs.get("autostart") === "1";
const $ = s => document.querySelector(s);
const pane = $("#ticket-pane"), board = $("#board"), trace = $("#trace"), logEl = $("#log");
const startBtn = $("#start"), statusEl = $("#take-status"), notice = $("#notice");
const laneEl = $("#jev-lane"), seatsEl = $("#claude-seats"), queueEl = $("#claude-queue");
const PHASE_TEXT = { wait: "未処理", jev: "JEV 判定中…", queued: "順番待ち", thinking: "Claude 考え中", resume: "Claude 決定→JEV へ",
  "done-jev": "✓ JEV で完了", "done-claude": "✓ Claude 経由で完了", stop: "停止" };
let cfg = null, halted = false, finished = false, internal = false, pinned = null, current = null, lastFocus = null;
const T = new Map();              // 件ごとの状態（画面の外。観測には入らない）
const resumeQ = [];               // Claude が決めて、JEV が戻るのを待つ件
let wake = null, nextIndex = 0;
let seats = [], waiting = [], limit = 3, pollSince = 0, pollVersion = null;
// メーター（画面の外。観測には入らない）。jevAsked: 手 id → JEV を呼んだ手の数、claudeCalled: Claude を起動した「件/手」、
// roundTrips: Claude が決めた手の次の手を JEV が決めた件
const meter = { jevAsked: {}, claudeCalled: new Set(), roundTrips: new Set() };

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const secs = ms => `${(ms / 1000).toFixed(1)} 秒`;
const conf = c => (typeof c === "number" ? c.toFixed(2) : "—");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shortName = control => control.description.split(":")[0];
const labelOf = id => { for (const s of cfg.steps) for (const c of s.controls) if (c.id === id) return c.label; return id || "—"; };
const stepTitle = k => (cfg.steps[k] ? cfg.steps[k].title : "");
const titleOf = id => { const s = cfg.steps.find(x => x.id === id); return s ? s.title : id; };
const stepNo = id => cfg.steps.findIndex(s => s.id === id) + 1;

async function api(path, body) {
  const init = body === undefined ? { cache: "no-store" } : { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  let data = {};
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, ok: r.ok, data };
}

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = `state ${cls || ""}`; }
function showNotice(text) { notice.textContent = text; notice.hidden = false; }
function halt(text) {
  if (halted) return;
  halted = true; setStatus("停止", "halted"); showNotice(text); startBtn.disabled = true;
  setLane(text, "halted"); kick();
}
function kick() { if (wake) { const w = wake; wake = null; w(); } }
function setLane(text, cls) { laneEl.textContent = text; laneEl.className = `lane-text ${cls || ""}`; }

// ---- 札と数 ------------------------------------------------------------------
function buildBoard() {
  board.replaceChildren();
  cfg.tickets.forEach((t, i) => {
    const li = el("li"), b = el("button", "card ph-wait"); b.type = "button";
    const stateEl = el("span", "cstate", PHASE_TEXT.wait);
    // 手ごとの小さな印（v2 は「担当・優先・返信」）。誰が決めたかを点の色で並べる
    const head = el("span", "chead"), pips = el("span", "pips"), pipEls = cfg.steps.map(s => el("span", "pip", s.title.slice(0, 2)));
    pips.append(...pipEls); head.append(el("span", "cid", t.id), pips);
    b.append(head, stateEl, el("span", "csub", t.subject));
    b.addEventListener("click", () => { pinned = pinned === t.id ? null : t.id; T.forEach(st => paint(st)); renderTrace(); });
    li.append(b); board.append(li);
    T.set(t.id, { t, index: i + 1, btn: b, stateEl, pips: pipEls, phase: "wait", steps: [], chosen: {}, picks: [],
      t0: null, saved: null, stopped: null, hold: null });
  });
  updateCounters();
}
function buildMeters() {
  const planned = cfg.steps_planned || cfg.steps.length * cfg.tickets.length;
  $("#m-planned").textContent = planned;
  const ul = $("#m-by-step");
  ul.replaceChildren();
  cfg.steps.forEach(s => {
    meter.jevAsked[s.id] = 0;
    const li = el("li", "bs"); li.dataset.step = s.id;
    li.append(el("span", "bs-name", s.title), el("b", "bs-claude", "0"), el("span", "bs-sep", "／"), el("b", "bs-steps", "0"));
    ul.append(li);
  });
  updateMeters();
}
function claudeCalledFor(id) { let n = 0; meter.claudeCalled.forEach(k => { if (k.split("/")[1] === id) n += 1; }); return n; }
function meterValue() {
  const by_step = {};
  cfg.steps.forEach(s => { by_step[s.id] = { claude_called: claudeCalledFor(s.id), jev_asked: meter.jevAsked[s.id] || 0 }; });
  return { claude_called: meter.claudeCalled.size, jev_asked: Object.values(meter.jevAsked).reduce((a, b) => a + b, 0),
    by_step, round_trip_tickets: meter.roundTrips.size };
}
function updateMeters() {
  const m = meterValue();
  $("#m-claude").textContent = m.claude_called; $("#m-steps").textContent = m.jev_asked;
  $("#m-by-step").querySelectorAll("li[data-step]").forEach(li => {
    const x = m.by_step[li.dataset.step];
    li.querySelector(".bs-claude").textContent = x.claude_called; li.querySelector(".bs-steps").textContent = x.jev_asked;
  });
  $("#n-roundtrip").textContent = m.round_trip_tickets;
}
function noteClaudeCalled(ticketId, step) {
  const key = `${ticketId}/${step}`;
  if (meter.claudeCalled.has(key)) return;
  meter.claudeCalled.add(key); updateMeters();
}
function stateText(st) {
  if (st.phase === "thinking" && st.hold && st.hold.startLocal !== null) return `考え中 ${(Math.max(0, performance.now() - st.hold.startLocal) / 1000).toFixed(1)}秒`;
  if (st.phase === "queued" && st.hold) return `順番待ち ${st.hold.position || "…"}番目`;
  if (st.phase === "jev" && current === st.t.id) return "JEV 判定中…";
  return PHASE_TEXT[st.phase] || st.phase;
}
function paint(st) {
  st.btn.className = `card ph-${st.phase}${pinned === st.t.id ? " pinned" : ""}${st.settledFlash ? " settled" : ""}`;
  st.stateEl.textContent = stateText(st);
}
function setPhase(st, phase) {
  const done = phase === "done-jev" || phase === "done-claude" || phase === "stop";
  st.settledFlash = done && st.phase !== phase;
  st.phase = phase; paint(st); updateCounters();
  if (st.settledFlash) setTimeout(() => { st.settledFlash = false; paint(st); }, 900);
}
function setPip(st, index, by) { st.pips[index].className = `pip by-${by}`; }
function updateCounters() {
  const n = { "done-jev": 0, "done-claude": 0, stop: 0, queued: 0, thinking: 0, wait: 0 };
  T.forEach(st => { if (st.phase in n) n[st.phase] += 1; });
  $("#n-jev").textContent = n["done-jev"]; $("#n-claude").textContent = n["done-claude"]; $("#n-stop").textContent = n.stop;
  $("#n-think").textContent = n.thinking; $("#n-queue").textContent = n.queued;
  $("#n-left").textContent = n.wait;
}
function addLog(text, cls) {
  const li = el("li", cls || ""), tm = el("time", "", new Date().toLocaleTimeString("ja-JP", { hour12: false }));
  li.append(tm, document.createTextNode(text)); logEl.prepend(li);
  while (logEl.children.length > 300) logEl.lastChild.remove();
}

// ---- Claude の席と順番待ち（枠の外） -------------------------------------------------------
function renderSeats() {
  seatsEl.replaceChildren();
  for (let i = 0; i < limit; i++) {
    const x = seats[i];
    if (!x) { seatsEl.append(el("li", "seat empty", "空き")); continue; }
    const st = T.get(x.ticket_id);
    const start = st && st.hold && st.hold.startLocal !== null ? st.hold.startLocal : performance.now() - x.elapsed_ms;
    const li = el("li", "seat busy");
    li.append(el("b", "", x.ticket_id), el("span", "", `手${stepNo(x.step)} ${titleOf(x.step)}`),
      el("span", "seat-time", `考え中 ${secs(performance.now() - start)}`), el("i", "seat-bar"));
    seatsEl.append(li);
  }
  queueEl.replaceChildren();
  if (!waiting.length) { queueEl.append(el("li", "q-empty", "なし")); return; }
  const QSHOW = 3;
  waiting.slice(0, QSHOW).forEach(x => queueEl.append(el("li", "q-item", `${x.position}. ${x.ticket_id} 手${stepNo(x.step)}`)));
  if (waiting.length > QSHOW) queueEl.append(el("li", "q-more", `ほか ${waiting.length - QSHOW}件`));
}

// ---- 問い合わせ詳細（サイト側。ここだけが観測の範囲） ------------------------------------
function renderPane(t, stepIndex, chosen) {
  pane.replaceChildren();
  pane.append(el("p", "pane-meta", `問い合わせ ${t.id}`), el("p", "pane-label", "件名"), el("h2", "pane-subject", t.subject),
    el("p", "pane-label", "本文"), el("p", "pane-body", t.body));
  // 決まった手を順に出す（例: 「担当: 請求担当（選択済み）」「優先度: 通常（選択済み）」）
  cfg.steps.slice(0, stepIndex).forEach(s => { if (chosen[s.id]) pane.append(el("p", "pane-decided", `${s.title}: ${shortName(chosen[s.id])}（選択済み）`)); });
  if (stepIndex >= cfg.steps.length) { pane.append(el("p", "pane-saved", "保存しました")); return; }
  const sd = cfg.steps[stepIndex];
  pane.append(el("h3", "pane-step", `手${stepIndex + 1} ${sd.title}を選ぶ`));
  const ul = el("ul", "pane-choices");
  sd.controls.forEach(c => {
    const li = el("li"), b = el("button", "", c.label); b.type = "button"; b.dataset.actionId = c.id;
    // 人の操作は受け付けない（1テイクを守る）。コードの domClick だけが通る
    b.addEventListener("click", () => { if (!internal) return; b.classList.add("pressed"); chosen[sd.id] = c; });
    li.append(b, el("span", "desc", c.description)); ul.append(li);
  });
  pane.append(ul);
}
function visible(b) { return !b.disabled && b.getClientRects().length > 0; }
function observe() {
  return { text: pane.innerText.trim(),
    controls: [...pane.querySelectorAll("button[data-action-id]")].filter(visible).map(b => ({ id: b.dataset.actionId, label: b.textContent.trim() })) };
}
function domClick(id) {
  const b = [...pane.querySelectorAll("button[data-action-id]")].find(x => x.dataset.actionId === id && visible(x));
  if (!b) return false;
  internal = true; b.click(); internal = false; return true;
}

// ---- 手ごとの往復（枠の外） ------------------------------------------------------------
function focusId() { return pinned || current || lastFocus; }
function renderTrace() {
  const id = focusId();
  $("#trace-ticket").textContent = id ? `${id}${pinned ? "（固定中・札をもう一度押すと解除）" : ""}` : "";
  if (!id) return;
  const st = T.get(id);
  trace.replaceChildren();
  if (!st.steps.length && !st.stopped) { trace.append(el("p", "trace-empty", "まだ手がありません")); return; }
  st.steps.forEach((s, i) => {
    const box = el("section", `tstep${s.pending ? " holding" : ""}`), h = el("h3", "", `手${i + 1} ${titleOf(s.step)}`);
    const prev = st.steps[i - 1];
    if (prev && prev.d && prev.d.decided_by === "claude" && s.d && s.d.jev && s.d.jev.confidence !== null) h.append(el("span", "back", "JEV に戻る"));
    box.append(h);
    if (!s.d) {
      box.append(row("jev", "JEV", el("span", "wait live", s.rejected ? `受け付けられませんでした（${s.rejected}）` : `判定中… ${secs(performance.now() - s.t0)}`)));
      trace.append(box); return;
    }
    const d = s.d, j = d.jev || {};
    if (typeof j.confidence === "number") {
      const pass = j.confidence >= cfg.threshold;
      const m = el("div", `meter${pass ? " pass" : ""}`), fill = el("span", "fill"); fill.style.setProperty("--w", String(j.confidence));
      m.append(fill, el("span", "line"));
      const txt = el("div", "conf-text"); txt.append(el("span", "", `→ ${labelOf(j.choice)}`), el("b", "", `確信度 ${conf(j.confidence)}${typeof j.elapsed_ms === "number" ? `  (${Math.round(j.elapsed_ms)}ms)` : ""}`));
      const c = el("div", "conf"); c.append(m, txt);
      box.append(row("jev", "JEV", c));
      box.append(el("p", `verdict ${pass ? "pass" : "fail"}`, pass ? `${conf(j.confidence)} ≥ ${conf(cfg.threshold)} → JEV の選択を実行` : `${conf(j.confidence)} < ${conf(cfg.threshold)} → Claude へ回す`));
    } else {
      box.append(row("stop", "JEV", el("span", "verdict err", d.outcome === "budget" ? "呼び出し回数の上限" : "JEV の呼び出しエラー")));
    }
    if (s.heldAt !== null) box.append(el("p", "hold-note", "この件は保留。JEV は待たずに次の件へ進んだ"));
    if (s.pending) {
      const h2 = st.hold;
      const thinking = h2 && h2.startLocal !== null;
      const text = thinking ? `考え中… ${secs(performance.now() - h2.startLocal)}` : `順番待ち（${h2 && h2.position ? h2.position : "…"}番目）…`;
      box.append(row(thinking ? "claude think" : "claude queue", "Claude", el("span", `live ${thinking ? "thinking" : "queued"}`, text)));
    } else if (d.claude) {
      const ch = d.claude.choice;
      const who = d.outcome === "decided" ? "claude" : "stop";
      const text = d.outcome === "stop_claude" ? "STOP（決められない・人に回す）" : d.outcome === "error_claude" ? "Claude の呼び出しエラー" : d.outcome === null ? "テイク中断で打ち切り" : labelOf(ch);
      const body = el("div", "cl-body"); body.append(el("span", "", `→ ${text}  (${secs(d.claude.elapsed_ms || 0)})`));
      if (d.claude.reason) body.append(el("span", "reason", `理由: ${d.claude.reason}`));
      box.append(row(who, "Claude", body));
    } else if (d.outcome === "budget" && typeof j.confidence === "number") {
      box.append(row("stop", "Claude", el("span", "verdict err", "呼び出し回数の上限")));
    }
    if (s.resumedMs !== undefined) box.append(row("code", "再開", el("span", "", `この件に戻った（保留 ${secs(s.resumedMs)}）`)));
    if (s.click) box.append(row("code", "コード", el("span", "", s.click.ok ? `${labelOf(s.click.control_id)} を押した` : `${labelOf(s.click.control_id)} が見つからず押せなかった`)));
    trace.append(box);
  });
  if (st.saved) trace.append(el("p", "tsaved", `[コード] 保存（開いてから ${secs(st.saved.ticket_wall_ms)}）`));
  if (st.stopped) trace.append(el("p", "verdict err", `この件は停止（${st.stopped}）`));
}
function row(cls, who, body) { const r = el("div", "row"); r.append(el("span", `who ${cls}`, who), body); return r; }
function setCurrent(id) { current = id; if (id) lastFocus = id; renderTrace(); }

// ---- 記録 ----------------------------------------------------------------------
async function record(type, ticketId, step, data) {
  let r;
  try { r = await api("/api/escalate/record", { take: TAKE, type, ticket_id: ticketId, step, data }); } catch { halt("サーバーに記録できません（接続できない）。テイクを止めました。"); return false; }
  if (!r.ok) { halt(`記録を受け付けられませんでした（HTTP ${r.status}${r.data.take_status ? `・テイク ${r.data.take_status}` : ""}）。`); return false; }
  return true;
}
async function stopTicket(st, reason) {
  st.stopped = reason; st.hold = null;
  setPhase(st, "stop"); renderTrace();
  addLog(`${st.t.id} 停止（${reason}）`, "l-stop");
  return record("ticket_stopped", st.t.id, null, { reason });
}

// ---- JEV の流れ（1本。#ticket-pane を使うのはここだけ） -----------------------------------------
async function clickStep(st, k, d) {
  const sd = cfg.steps[k], s = st.steps[k];
  const ok = domClick(d.control_id);
  s.click = { control_id: d.control_id, ok };
  if (!await record("click", st.t.id, sd.id, { control_id: d.control_id, ok, label: labelOf(d.control_id) })) return false;
  setPip(st, k, ok ? d.decided_by : "stop"); renderTrace();
  if (!ok) { await stopTicket(st, "click_failed"); return false; }
  st.picks.push({ control_id: d.control_id, label: labelOf(d.control_id), by: d.decided_by });
  if (d.take_status === "aborted") { halt("テイクはサーバー側で中断されました。"); return false; }
  return true;
}

async function runSteps(st, k0) {
  const t = st.t;
  for (let k = k0; k < cfg.steps.length; k++) {
    const sd = cfg.steps[k];
    renderPane(t, k, st.chosen);            // 保留から戻ったときも、保留したときと同じ並びの画面になる
    const ob = observe();
    const s = { step: sd.id, t0: performance.now(), d: null, click: null, rejected: null, pending: false, heldAt: null };
    st.steps[k] = s;
    setPip(st, k, "jevnow"); setPhase(st, "jev"); setCurrent(t.id);
    setLane(`${t.id} 手${k + 1} ${sd.title}を判定中…`, "busy");
    let r;
    try { r = await api("/api/escalate/step", { take: TAKE, ticket_id: t.id, step: sd.id, observation: ob, history: st.picks.map(p => p.label) }); }
    catch { halt("サーバーに接続できません。テイクを止めました。"); return; }
    const d = r.data || {};
    if (r.status === 400) {
      s.rejected = d.reason || "rejected"; renderTrace(); setPip(st, k, "stop");
      if (!await stopTicket(st, "rejected")) return;
      if (d.take_status === "aborted") halt("テイクはサーバー側で中断されました。");
      return;
    }
    if (r.status !== 200) {
      if (d.take_status === "aborted") setPhase(st, "stop");
      halt(d.take_status === "aborted" ? "テイクはサーバー側で中断されました。" : `手を受け付けられませんでした（HTTP ${r.status}）。`);
      return;
    }
    s.d = d;
    const j = d.jev || {};
    // JEV を呼んだ手（エラーでも elapsed_ms が付く。予算で呼ばなかった手は付かない）
    if (typeof j.elapsed_ms === "number") { meter.jevAsked[sd.id] = (meter.jevAsked[sd.id] || 0) + 1; }
    // 往復: 前の手を Claude が決め、この手を JEV が決めた
    const prev = st.steps[k - 1];
    if (prev && prev.d && prev.d.decided_by === "claude" && d.decided_by === "jev") meter.roundTrips.add(t.id);
    updateMeters();
    const logHead = `${t.id} 手${k + 1} ${sd.title}  JEV ${conf(j.confidence)}${typeof j.elapsed_ms === "number" ? ` (${Math.round(j.elapsed_ms)}ms)` : ""}`;
    if (d.pending) {
      // Claude の待ち行列へ。この件は保留にして、JEV はすぐ次の件へ
      const q = d.queue || {};
      const startsNow = q.position === 1 && q.running < q.limit;
      s.pending = true; s.heldAt = performance.now();
      st.hold = { k, step: sd.id, heldAt: s.heldAt, startLocal: startsNow ? performance.now() : null, position: startsNow ? 0 : q.position };
      setPip(st, k, startsNow ? "think" : "queue"); setPhase(st, startsNow ? "thinking" : "queued"); renderTrace();
      addLog(`${logHead} < ${conf(cfg.threshold)} → Claude の${startsNow ? "席へ" : `順番待ち ${q.position}番目へ`}（保留。JEV は次の件へ）`, "l-hold");
      if (d.take_status === "aborted") halt("テイクはサーバー側で中断されました。");
      return;
    }
    if (!d.control_id) {
      setPip(st, k, "stop");
      addLog(`${logHead} → ${d.outcome}`, "l-stop");
      if (d.take_status === "aborted") { setPhase(st, "stop"); halt(`テイクはサーバー側で中断されました（${d.outcome}）。`); return; }
      await stopTicket(st, d.outcome);
      return;
    }
    addLog(`${logHead} ≥ ${conf(cfg.threshold)} → JEV: ${labelOf(d.control_id)}`, "l-jev");
    if (!await clickStep(st, k, d)) return;
  }
  await saveTicket(st);
}

async function saveTicket(st) {
  // [コード] 保存して次へ
  const t = st.t;
  renderPane(t, cfg.steps.length, st.chosen);
  const wall = Math.round(performance.now() - st.t0);
  const saved = {};
  cfg.steps.forEach((s, i) => { saved[s.id] = st.picks[i].control_id; });
  saved.ticket_wall_ms = wall;
  if (!await record("ticket_saved", t.id, null, saved)) return;
  st.saved = saved;
  const via = st.picks.some(p => p.by === "claude");
  setPhase(st, via ? "done-claude" : "done-jev"); renderTrace();
  addLog(`${t.id} 保存 ${cfg.steps.map(s => labelOf(saved[s.id])).join("・")}（${via ? "Claude 経由" : "JEV だけ"}・${secs(wall)}）`, via ? "l-claude" : "l-jev");
}

async function openTicket(st) {
  st.t0 = performance.now();
  setPhase(st, "jev"); setCurrent(st.t.id);
  if (!await record("ticket_open", st.t.id, null, { index: st.index })) return;
  await runSteps(st, 0);
}

async function resumeTicket({ st, k, d }) {
  // Claude が決めた手を押し、その件の残りの手を JEV で続ける
  const sd = cfg.steps[k], s = st.steps[k];
  const heldMs = Math.round(performance.now() - st.hold.heldAt);
  setPhase(st, "jev"); setCurrent(st.t.id);
  setLane(`${st.t.id} に戻る — Claude が${sd.title}を決めた（保留 ${secs(heldMs)}）`, "resume");
  if (!await record("ticket_resume", st.t.id, sd.id, { held_ms: heldMs })) return;
  s.resumedMs = heldMs;
  renderPane(st.t, k, st.chosen);          // 保留したときの画面に戻して押す
  if (!await clickStep(st, k, d)) return;
  st.hold = null;
  await runSteps(st, k + 1);
}

function outstanding() { let n = 0; T.forEach(st => { if (st.phase === "queued" || st.phase === "thinking" || st.phase === "resume") n += 1; }); return n; }

async function lane() {
  while (!halted) {
    if (resumeQ.length) { await resumeTicket(resumeQ.shift()); continue; }
    if (nextIndex < cfg.tickets.length) {
      const st = T.get(cfg.tickets[nextIndex].id); nextIndex += 1;
      await openTicket(st);
      continue;
    }
    const n = outstanding();
    if (!n) break;
    setCurrent(null);
    setLane(`${cfg.tickets.length}件を流し終えた。Claude の返事待ち ${n}件`, "idle");
    await new Promise(r => { wake = r; });
  }
  if (halted) return;
  await finishTake();
}

// ---- Claude の返事（長待ちで受け取る） ----------------------------------------------------
function onClaudeResult(res) {
  const st = T.get(res.ticket_id);
  if (!st || !st.hold || st.hold.step !== res.step) return;
  if (res.claude) noteClaudeCalled(res.ticket_id, res.step);   // 席に出る前に終わった呼び出しも数える
  const k = st.hold.k, s = st.steps[k];
  s.d = res; s.pending = false;
  const held = performance.now() - st.hold.heldAt;
  const cl = res.claude || {};
  const head = `${st.t.id} 手${k + 1} ${stepTitle(k)}`;
  if (res.control_id) {
    setPip(st, k, "claude"); setPhase(st, "resume");
    addLog(`${head}  Claude → ${labelOf(res.control_id)} (${secs(cl.elapsed_ms || 0)})・保留 ${secs(held)} → この件に戻る`, "l-claude");
    resumeQ.push({ st, k, d: res }); kick();
  } else {
    setPip(st, k, "stop");
    addLog(`${head}  Claude → ${res.outcome || "打ち切り"}${cl.error ? `（${cl.error}）` : ""}`, "l-stop");
    if (res.outcome && res.take_status !== "aborted") stopTicket(st, res.outcome).then(() => kick());
    else { st.hold = null; setPhase(st, "stop"); kick(); }
  }
  if (focusId() === st.t.id) renderTrace();
}

function applyState(d) {
  pollVersion = d.version; limit = d.limit || limit;
  seats = d.running || []; waiting = d.queued || [];
  for (const x of seats) {
    noteClaudeCalled(x.ticket_id, x.step);
    const st = T.get(x.ticket_id);
    if (!st || !st.hold || st.hold.step !== x.step) continue;
    if (st.hold.startLocal === null) st.hold.startLocal = performance.now() - x.elapsed_ms;
    st.hold.position = 0;
    if (st.phase === "queued") { setPhase(st, "thinking"); setPip(st, st.hold.k, "think"); }
  }
  for (const x of waiting) {
    const st = T.get(x.ticket_id);
    if (st && st.hold && st.hold.step === x.step) { st.hold.position = x.position; paint(st); }
  }
  for (const res of d.results || []) onClaudeResult(res);
  pollSince = d.next;
  renderSeats(); updateCounters();
}

async function poll() {
  let fails = 0;
  while (!halted && !finished) {
    const wait = pollVersion === null ? "" : `&version=${pollVersion}&wait=8`;
    let r = null;
    try { r = await api(`/api/escalate/claude?take=${encodeURIComponent(TAKE)}&since=${pollSince}${wait}`); } catch { r = null; }
    if (!r || !r.ok) {
      fails += 1;
      if (fails >= 5) { halt("Claude の状態を受け取れません（接続できない）。"); return; }
      await sleep(1000); continue;
    }
    fails = 0;
    applyState(r.data);
    if (r.data.take_status === "aborted") { halt(`テイクはサーバー側で中断されました（${r.data.abort_reason}）。`); return; }
    if (r.data.take_status !== "running") return;
  }
}

// ---- テイク -------------------------------------------------------------------
async function finishTake() {
  setCurrent(null);
  setLane("全件が確定。終了を記録しています…", "idle");
  const final_tickets = cfg.tickets.map(t => {
    const st = T.get(t.id), row = { id: t.id };
    cfg.steps.forEach(s => { row[s.id] = st.saved ? st.saved[s.id] : null; });
    row.saved = !!st.saved;
    return row;
  });
  let r;
  for (let attempt = 0; attempt < 20; attempt++) {
    // meter は画面が最後に表示していた値（サーバーが自分の集計と突き合わせる）
    try { r = await api("/api/escalate/finish", { take: TAKE, final_tickets, meter: meterValue() }); } catch { halt("終了を記録できません（接続できない）。"); return; }
    if (r.status === 409 && (r.data.reason === "claude_pending" || r.data.reason === "unsettled")) { await sleep(300); continue; }
    break;
  }
  if (!r.ok) { halt(`終了を記録できません（HTTP ${r.status}${r.data.reason ? `・${r.data.reason}` : ""}）。`); return; }
  finished = true;
  setLane(`完了 — ${cfg.tickets.length}件すべて確定`, "done");
  const consistent = r.data.client_server_consistent && r.data.meter_consistent !== false;
  setStatus(consistent ? "完了（記録と一致）" : "完了（記録と不一致あり）", consistent ? "done" : "halted");
}

async function run() {
  startBtn.disabled = true;
  let r;
  try { r = await api("/api/escalate/start", { take: TAKE }); } catch { halt("サーバーに接続できません。"); return; }
  if (!r.ok) { halt(r.status === 409 ? "このテイクは既に始まっているか、記録が残っています。やり直せません（1テイクを守るため）。" : `開始できません（HTTP ${r.status}）。`); return; }
  setStatus("実行中", "running");
  poll();
  setInterval(tick, 200);
  lane();
}

// 考え中の秒数を動かす（札・Claude の席・寄った表示）
function tick() {
  T.forEach(st => { if (st.phase === "thinking" || st.phase === "queued") paint(st); });
  if (seats.length) renderSeats();
  const id = focusId(), st = id && T.get(id);
  if (st && (st.phase === "thinking" || st.phase === "queued" || st.steps.some(s => !s.d))) renderTrace();
}

async function load() {
  $("#take-label").textContent = TAKE || "take 未指定";
  if (!/^take0[12]$/.test(TAKE)) { setStatus("未設定", "halted"); showNotice("URL に ?take=take02 を付けて開いてください。"); return; }
  let r;
  try { r = await api(`/api/escalate/config?take=${encodeURIComponent(TAKE)}`); } catch { setStatus("接続できません", "halted"); showNotice("サーバーに接続できません。"); return; }
  if (r.status === 503) { setStatus("無効", "halted"); showNotice("差し戻しは無効です（サーバーを --escalation-fixture 付きで起動していません）。"); return; }
  if (r.status === 409) { setStatus("実行済み", "halted"); showNotice(`${TAKE} は既に記録があります。同じテイクはやり直せません。`); return; }
  if (!r.ok) { setStatus("読み込めません", "halted"); showNotice(`設定を読み込めません（HTTP ${r.status}）。`); return; }
  cfg = r.data;
  limit = cfg.claude_concurrency || 3;
  $("#threshold").textContent = conf(cfg.threshold);
  buildBoard(); buildMeters(); renderSeats();
  setStatus("待機中", "");
  startBtn.addEventListener("click", run, { once: true });
  if (AUTO) run(); else startBtn.disabled = false;
}

load();
})();
