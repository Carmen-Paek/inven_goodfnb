/* =========================================================
 * 소비기한 재고관리 — 부모코드(상품) / 자식코드(상품코드-소비기한)
 * 로컬 데모 모드(localStorage) 와 Supabase 모드를 같은 화면으로 지원
 * ========================================================= */
(() => {
"use strict";

const CFG = Object.assign({ ALERT_DAYS: 30, WARN_DAYS: 90, WAREHOUSE_NAME: "" }, window.APP_CONFIG || {});
const MODE = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY ? "supabase" : "local";
const KIND_LABEL = { out: "출고", in: "입고", count: "실사", adjust: "조정", revert: "취소" };

/* ---------------- 유틸 ---------------- */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("ko-KR"));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lotCode = (code, exp) => `${code}-${exp.replaceAll("-", "")}`;
const todayStr = () => { const d = new Date(); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
const daysLeft = (exp) => Math.round((Date.parse(exp + "T00:00:00Z") - Date.parse(todayStr() + "T00:00:00Z")) / 86400000);
const fmtDT = (s) => { const d = new Date(s); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function status(exp) {
  const d = daysLeft(exp);
  if (d < 0) return { key: "expired", label: "경과", d };
  if (d <= CFG.ALERT_DAYS) return { key: "alert", label: "임박", d };
  if (d <= CFG.WARN_DAYS) return { key: "warn", label: "주의", d };
  return { key: "ok", label: "정상", d };
}
const dday = (d) => (d < 0 ? `D+${-d}` : d === 0 ? "D-day" : `D-${d}`);

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), isError ? 6000 : 3000);
}

/** 엑셀/문자열 날짜 → 'YYYY-MM-DD' */
function parseDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === "number") {
    if (v >= 19000101 && v <= 21001231) return checkYmd(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
    if (v > 20000 && v < 80000) { // 엑셀 날짜 일련번호
      const d = new Date(Math.round((v - 25569) * 86400000));
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/) || s.match(/^(\d{2,4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/);
  if (!m && /^\d{6}$/.test(s)) m = [s, s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
  if (!m) return null;
  let y = +m[1]; if (y < 100) y += 2000;
  return checkYmd(y, +m[2], +m[3]);
}
function checkYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? ymd(y, m, d) : null;
}
function parseQty(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}
async function sha256(buf) {
  if (!crypto?.subtle) return null;
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* =========================================================
 * 데이터 계층 1 — 로컬 데모 (localStorage)
 * ========================================================= */
class LocalApi {
  constructor() { this.key = "inv-demo-v1"; this.db = this._read() || this._seed(); this._write(); }
  _read() { try { return JSON.parse(localStorage.getItem(this.key)); } catch { return null; } }
  _write() { try { localStorage.setItem(this.key, JSON.stringify(this.db)); } catch { /* 저장 불가 환경 */ } }
  _seed() {
    const S = window.SEED || { products: [], lots: [] };
    const db = { seq: { lot: 0, mv: 0, up: 0 }, products: S.products.map((p) => ({ ...p, active: true })), lots: [], movements: [], uploads: [] };
    const up = (kind, file_name, at, rows) => {
      const u = { id: ++db.seq.up, kind, file_name, file_hash: null, row_count: rows.length, total_qty: rows.reduce((a, r) => a + r[1], 0), status: "applied", created_at: at };
      db.uploads.push(u); return u;
    };
    S.lots.forEach((l) => db.lots.push({ id: ++db.seq.lot, product_code: l.product_code, expiry_date: l.expiry_date, lot_code: lotCode(l.product_code, l.expiry_date), qty: l.opening + l.incoming, memo: null }));
    const lotOf = (l) => db.lots.find((x) => x.product_code === l.product_code && x.expiry_date === l.expiry_date);
    const open = S.lots.filter((l) => l.opening), inc = S.lots.filter((l) => l.incoming);
    const u1 = up("count", "초기재고 (9/7 실사)", S.opening_at, open.map((l) => [l, l.opening]));
    open.forEach((l) => db.movements.push({ id: ++db.seq.mv, lot_id: lotOf(l).id, kind: "adjust", qty: l.opening, upload_id: u1.id, ref: null, memo: "9/7 실사재고", created_at: S.opening_at }));
    const u2 = up("in", "입고예정 (9/10)", S.incoming_at, inc.map((l) => [l, l.incoming]));
    inc.forEach((l) => db.movements.push({ id: ++db.seq.mv, lot_id: lotOf(l).id, kind: "in", qty: l.incoming, upload_id: u2.id, ref: null, memo: "입고예정 9/10", created_at: S.incoming_at }));
    return db;
  }
  async reset() { localStorage.removeItem(this.key); this.db = this._seed(); this._write(); }
  async load() { return { products: structuredClone(this.db.products), lots: structuredClone(this.db.lots) }; }

  /** supabase/schema.sql 의 apply_upload 와 동일한 규칙 */
  async applyUpload(kind, fileName, hash, rows) {
    const db = structuredClone(this.db), now = new Date().toISOString();
    if (hash && db.uploads.some((u) => u.file_hash === hash && u.status === "applied")) throw new Error(`이미 반영된 파일입니다: ${fileName}`);
    const u = { id: ++db.seq.up, kind, file_name: fileName, file_hash: hash, row_count: 0, total_qty: 0, status: "applied", created_at: now };
    db.uploads.push(u);
    const mv = (lot, k, qty, ref, memo = null) => db.movements.push({ id: ++db.seq.mv, lot_id: lot.id, kind: k, qty, upload_id: u.id, ref: ref || null, memo, created_at: now });
    const findLot = (c, e) => db.lots.find((l) => l.product_code === c && l.expiry_date === e);
    let i = 0;
    for (const r of rows) {
      i++; const row = r.row ?? i;
      if (!db.products.some((p) => p.product_code === r.product_code)) throw new Error(`${row}행: 등록되지 않은 상품코드 ${r.product_code}`);
      if (!Number.isInteger(r.qty) || r.qty < 0 || (r.qty === 0 && kind !== "count")) throw new Error(`${row}행: 수량 오류 (${r.qty})`);
      if (kind === "in" || kind === "count") {
        if (!r.expiry_date) throw new Error(`${row}행: 소비기한이 필요합니다`);
        let lot = findLot(r.product_code, r.expiry_date);
        if (!lot) { lot = { id: ++db.seq.lot, product_code: r.product_code, expiry_date: r.expiry_date, lot_code: lotCode(r.product_code, r.expiry_date), qty: 0, memo: null }; db.lots.push(lot); }
        const delta = kind === "in" ? r.qty : r.qty - lot.qty;
        if (delta) { lot.qty += delta; mv(lot, kind === "in" ? "in" : "adjust", delta, r.ref); }
      } else if (r.expiry_date) {
        const lot = findLot(r.product_code, r.expiry_date);
        if (!lot) throw new Error(`${row}행: 재고에 없는 자식코드 ${lotCode(r.product_code, r.expiry_date)}`);
        if (lot.qty < r.qty) throw new Error(`${row}행: 재고 부족 ${lot.lot_code} (현재 ${lot.qty}, 요청 ${r.qty})`);
        lot.qty -= r.qty; mv(lot, "out", -r.qty, r.ref);
      } else {
        let remain = r.qty; const today = todayStr();
        for (const lot of db.lots.filter((l) => l.product_code === r.product_code && l.qty > 0 && l.expiry_date >= today).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))) {
          const take = Math.min(lot.qty, remain); lot.qty -= take; mv(lot, "out", -take, r.ref, "FEFO 자동배분"); remain -= take;
          if (!remain) break;
        }
        if (remain) throw new Error(`${row}행: ${r.product_code} 재고 부족 (부족 ${remain})`);
      }
      u.total_qty += r.qty;
    }
    u.row_count = i;
    this.db = db; this._write();
    return { upload_id: u.id, rows: i, total_qty: u.total_qty };
  }
  async revertUpload(id) {
    const db = structuredClone(this.db), u = db.uploads.find((x) => x.id === id && x.status === "applied");
    if (!u) throw new Error(`되돌릴 수 없는 업로드입니다 (#${id})`);
    const now = new Date().toISOString();
    for (const m of db.movements.filter((x) => x.upload_id === id && x.kind !== "revert")) {
      const lot = db.lots.find((l) => l.id === m.lot_id); lot.qty -= m.qty;
      if (lot.qty < 0) throw new Error(`되돌리면 재고가 마이너스가 되는 로트가 있습니다 (${lot.lot_code})`);
      db.movements.push({ id: ++db.seq.mv, lot_id: lot.id, kind: "revert", qty: -m.qty, upload_id: id, ref: null, memo: `업로드 #${id} 취소`, created_at: now });
    }
    u.status = "reverted"; this.db = db; this._write();
  }
  async adjustLot(lotId, newQty, memo) {
    const lot = this.db.lots.find((l) => l.id === lotId); if (!lot) throw new Error("로트 없음");
    if (lot.qty === newQty) return;
    this.db.movements.push({ id: ++this.db.seq.mv, lot_id: lotId, kind: "adjust", qty: newQty - lot.qty, upload_id: null, ref: null, memo, created_at: new Date().toISOString() });
    lot.qty = newQty; this._write();
  }
  async addProduct(p) {
    if (this.db.products.some((x) => x.product_code === p.product_code)) throw new Error("이미 있는 부모코드입니다");
    this.db.products.push({ ...p, active: true }); this._write();
  }
  async listUploads() { return [...this.db.uploads].sort((a, b) => b.id - a.id).slice(0, 200); }
  async listMovements(uploadId) {
    const lots = new Map(this.db.lots.map((l) => [l.id, l]));
    return this.db.movements.filter((m) => !uploadId || m.upload_id === uploadId).sort((a, b) => b.id - a.id).slice(0, 500)
      .map((m) => ({ ...m, lot_code: lots.get(m.lot_id)?.lot_code, product_code: lots.get(m.lot_id)?.product_code }));
  }
}

/* =========================================================
 * 데이터 계층 2 — Supabase
 * ========================================================= */
class SupaApi {
  constructor() { this.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY); }
  _ok({ data, error }) { if (error) throw new Error(error.message); return data; }
  async session() { return (await this.sb.auth.getSession()).data.session; }
  async signIn(email, password) { this._ok(await this.sb.auth.signInWithPassword({ email, password })); }
  async signOut() { await this.sb.auth.signOut(); }
  async load() {
    const [products, lots] = await Promise.all([
      this.sb.from("products").select("*").order("product_code"),
      this.sb.from("lots").select("*").order("product_code").order("expiry_date").limit(10000),
    ]);
    return { products: this._ok(products), lots: this._ok(lots) };
  }
  async applyUpload(kind, fileName, hash, rows) {
    return this._ok(await this.sb.rpc("apply_upload", { p_kind: kind, p_file_name: fileName, p_file_hash: hash, p_rows: rows }));
  }
  async revertUpload(id) { this._ok(await this.sb.rpc("revert_upload", { p_upload_id: id })); }
  async adjustLot(lotId, newQty, memo) { this._ok(await this.sb.rpc("adjust_lot", { p_lot_id: lotId, p_new_qty: newQty, p_memo: memo })); }
  async addProduct(p) { this._ok(await this.sb.from("products").insert(p)); }
  async listUploads() { return this._ok(await this.sb.from("uploads").select("*").order("id", { ascending: false }).limit(200)); }
  async listMovements(uploadId) {
    let q = this.sb.from("movements").select("*, lots(lot_code, product_code)").order("id", { ascending: false }).limit(500);
    if (uploadId) q = q.eq("upload_id", uploadId);
    return this._ok(await q).map((m) => ({ ...m, lot_code: m.lots?.lot_code, product_code: m.lots?.product_code }));
  }
}

/* =========================================================
 * 엑셀 해석 + 검증(미리보기) — DB 반영 전에 화면에서 먼저 계산
 * ========================================================= */
// 열 이름 자동 인식 — 필드별로 우선순위가 높은 패턴부터 검사
const FIELDS = [
  { key: "lot", label: "자식코드 (선택)", res: [/(자식코드|로트코드|재고코드)/, /(^lot|^로트$)/] },
  { key: "code", label: "부모코드 / 상품코드", res: [/(부모코드|상품코드|품목코드)/, /(erp|sku|^코드$)/] },
  { key: "exp", label: "소비기한", res: [/(소비기한|유통기한|유효기한)/, /^exp/] },
  { key: "qty", label: "수량", res: [/(출고수량|입고수량|실사수량)/, /^수량$/, /수량|qty/, /재고\(박스\)|^박스$/] },
  { key: "ref", label: "참조 (주문번호·출고처)", res: [/(주문번호|출고처|거래처|채널)/, /(비고|메모|ref)/] },
];
const norm = (h) => String(h ?? "").replace(/\s/g, "").toLowerCase();

function detectHeader(aoa) {
  let best = { idx: 0, score: -1 };
  aoa.slice(0, 15).forEach((row, idx) => {
    const cells = row.map(norm);
    const score = FIELDS.reduce((s, f) => s + (cells.some((c) => c && f.res.some((re) => re.test(c))) ? 1 : 0), 0);
    if (score > best.score) best = { idx, score };
  });
  const headers = (aoa[best.idx] || []).map((h, i) => String(h ?? "").trim() || `열${i + 1}`);
  const map = {}; const used = new Set();
  for (const f of FIELDS) {
    map[f.key] = -1;
    for (const re of f.res) {
      const i = headers.findIndex((h, j) => !used.has(j) && re.test(norm(h)));
      if (i >= 0) { map[f.key] = i; used.add(i); break; }
    }
  }
  return { headerRow: best.idx, headers, map };
}

function extractRows(aoa, headerRow, map) {
  const out = [];
  const get = (row, k) => (map[k] >= 0 ? row[map[k]] : "");
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    let code = String(get(row, "code") ?? "").trim().toUpperCase();
    let exp = parseDate(get(row, "exp"));
    const lotRaw = String(get(row, "lot") ?? "").trim().toUpperCase();
    const m = lotRaw.match(/^([A-Z0-9]+)[-_ ]?(\d{8})$/);
    if (m) { code = code || m[1]; exp = exp || parseDate(m[2]); }
    const qtyRaw = get(row, "qty");
    if (!code && !lotRaw) continue;                 // 빈 행, 소계 행
    if (qtyRaw === "" || qtyRaw == null) continue;  // 수량 없는 행
    const expRaw = get(row, "exp");
    out.push({
      row: r + 1, code, exp, qty: parseQty(qtyRaw), ref: String(get(row, "ref") ?? "").trim(),
      expInvalid: !exp && expRaw !== "" && expRaw != null, expRaw,
    });
  }
  return out;
}

/** 현재 재고 기준으로 행별 결과 계산 (같은 파일 안의 누적 차감 포함) */
function planUpload(kind, rows, products, lots) {
  const prod = new Map(products.map((p) => [p.product_code, p]));
  const work = new Map(lots.map((l) => [`${l.product_code}|${l.expiry_date}`, { ...l }]));
  const today = todayStr();
  return rows.map((r) => {
    const line = { ...r, name: prod.get(r.code)?.name || "", lot_code: r.exp ? lotCode(r.code, r.exp) : "", allocs: [], level: "ok", msgs: [] };
    const err = (m) => { line.level = "error"; line.msgs.push(m); };
    const warn = (m) => { if (line.level !== "error") line.level = "warn"; line.msgs.push(m); };
    const info = (m) => line.msgs.push(m);

    if (!prod.has(r.code)) err(`미등록 상품코드`);
    if (!Number.isInteger(r.qty) || r.qty < 0 || (r.qty === 0 && kind !== "count")) err(`수량 오류 (${r.qty})`);
    if (r.expInvalid) err(`소비기한 형식 오류 (${r.expRaw})`);
    if (line.level === "error") return line;

    const key = `${r.code}|${r.exp}`;
    if (kind === "in" || kind === "count") {
      if (!r.exp) { err("소비기한 필요"); return line; }
      let lot = work.get(key);
      if (!lot) { lot = { product_code: r.code, expiry_date: r.exp, qty: 0 }; work.set(key, lot); info("신규 자식코드 생성"); }
      const before = lot.qty; lot.qty = kind === "in" ? lot.qty + r.qty : r.qty;
      line.allocs.push({ exp: r.exp, before, after: lot.qty, delta: lot.qty - before });
      if (kind === "count" && before === lot.qty) info("변동 없음");
      if (r.exp < today) warn("소비기한 경과 로트");
    } else if (r.exp) {
      const lot = work.get(key);
      if (!lot) { err("재고에 없는 자식코드"); return line; }
      if (lot.qty < r.qty) { err(`재고 부족 (현재 ${fmt(lot.qty)})`); return line; }
      line.allocs.push({ exp: r.exp, before: lot.qty, after: lot.qty - r.qty, delta: -r.qty });
      lot.qty -= r.qty;
      const st = status(r.exp);
      if (st.key === "expired") warn("소비기한 경과 로트 출고");
      else if (st.key === "alert") info(`임박 ${dday(st.d)}`);
    } else {
      const cands = [...work.values()].filter((l) => l.product_code === r.code && l.qty > 0 && l.expiry_date >= today).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
      const avail = cands.reduce((a, l) => a + l.qty, 0);
      if (avail < r.qty) { err(`재고 부족 (가용 ${fmt(avail)})`); return line; }
      let remain = r.qty;
      for (const lot of cands) {
        const take = Math.min(lot.qty, remain);
        line.allocs.push({ exp: lot.expiry_date, before: lot.qty, after: lot.qty - take, delta: -take });
        lot.qty -= take; remain -= take; if (!remain) break;
      }
      warn(`소비기한 미기재 → FEFO 자동배분 ${line.allocs.length}개 로트`);
    }
    return line;
  });
}

/* =========================================================
 * 화면
 * ========================================================= */
const state = { products: [], lots: [], view: "stock", kind: "out", file: null, selectedUpload: null, collapsed: new Set() };
let api;

async function refresh() {
  const d = await api.load();
  state.products = d.products; state.lots = d.lots;
  renderStock(); renderProducts();
  if (state.view === "history") renderHistory();
}

function show(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${view}`).classList.remove("hidden");
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "history") renderHistory();
}

/* ---------- 재고현황 ---------- */
function renderStock() {
  const q = norm($("#stockSearch").value), filter = $("#stockFilter").value, hideZero = $("#hideZero").checked;
  const prodMap = new Map(state.products.map((p) => [p.product_code, p]));
  const live = state.lots.filter((l) => l.qty !== 0);

  // KPI
  const sum = (arr) => arr.reduce((a, l) => a + l.qty, 0);
  const by = (k) => live.filter((l) => status(l.expiry_date).key === k);
  const prodCnt = new Set(live.map((l) => l.product_code)).size;
  $("#kpis").innerHTML = [
    ["총 재고", fmt(sum(live)), "박스", `${prodCnt}개 상품 · 자식코드 ${live.length}개`, "main", ""],
    ["임박", fmt(sum(by("alert"))), "박스", `D-${CFG.ALERT_DAYS} 이내 · ${by("alert").length}개 로트`, "red", "alert"],
    ["주의", fmt(sum(by("warn"))), "박스", `D-${CFG.WARN_DAYS} 이내 · ${by("warn").length}개 로트`, "amber", "warn"],
    ["경과", fmt(sum(by("expired"))), "박스", `소비기한 지남 · ${by("expired").length}개 로트`, "gray", "expired"],
    ["정상", fmt(sum(by("ok"))), "박스", `${by("ok").length}개 로트`, "", "ok"],
  ].map(([l, v, u, foot, cls, f]) => `<div class="kpi ${cls} ${f && f === filter ? "on" : ""}" ${f ? `data-filter="${f}" title="클릭하면 필터"` : ""}>
      <div class="label">${l}</div><div class="value">${v}<small>${u}</small></div><div class="foot">${foot}</div></div>`).join("");

  const groups = new Map();
  for (const l of state.lots) {
    if (hideZero && l.qty === 0) continue;
    const st = status(l.expiry_date);
    if (filter !== "all" && st.key !== filter) continue;
    const p = prodMap.get(l.product_code) || {};
    const hay = norm(`${l.product_code} ${l.lot_code} ${p.name} ${p.full_name}`);
    if (q && !hay.includes(q)) continue;
    if (!groups.has(l.product_code)) groups.set(l.product_code, []);
    groups.get(l.product_code).push({ ...l, st });
  }
  if (!groups.size) { $("#stockGroups").innerHTML = `<div class="card empty">조건에 맞는 재고가 없습니다</div>`; return; }

  // 상품명 순(달콤사과 → 배도라지 → 보리보리, 각 20/40/80)으로 정렬
  const order = [...groups.keys()].sort((a, b) => {
    const pa = prodMap.get(a)?.name || a, pb = prodMap.get(b)?.name || b;
    return pa.localeCompare(pb, "ko", { numeric: true });
  });
  let html = "";
  for (const code of order) {
    const rows = groups.get(code).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
    const p = prodMap.get(code) || {};
    const total = rows.reduce((a, l) => a + l.qty, 0);
    const max = Math.max(1, ...rows.map((l) => l.qty));
    const flags = ["alert", "warn", "expired"].map((k) => {
      const n = rows.filter((l) => l.st.key === k && l.qty > 0).length;
      return n ? `<span class="chip ${k}">${{ alert: "임박", warn: "주의", expired: "경과" }[k]} ${n}</span>` : "";
    }).join("");
    const collapsed = state.collapsed.has(code);
    html += `<section class="group ${collapsed ? "collapsed" : ""}" data-group="${esc(code)}">
      <div class="g-head">
        <span class="g-caret">▼</span>
        <div class="g-title">
          <div class="g-name">${esc(p.name || code)} <span class="g-code">${esc(code)}</span></div>
          <div class="g-full">${esc(p.full_name || "")}${p.box_qty ? ` · 박스당 ${p.box_qty}EA` : ""}</div>
        </div>
        <div class="g-flags">${flags}</div>
        <div class="g-total"><b>${fmt(total)}<small>박스</small></b><div>${p.box_qty ? fmt(total * p.box_qty) + " EA · " : ""}로트 ${rows.length}개</div></div>
      </div>
      ${collapsed ? "" : `<table class="lots">
        <thead><tr><th>소비기한</th><th>상태</th><th class="col-code">자식코드</th><th class="col-share" style="width:22%">상품 내 비중</th>
          <th class="num">재고</th><th class="num">EA</th><th></th></tr></thead><tbody>
        ${rows.map((l) => `<tr class="st-${l.st.key} ${l.qty === 0 ? "zero" : ""}">
          <td class="exp">${l.expiry_date.replaceAll("-", ".")}</td>
          <td>${statusChip(l.st)}</td>
          <td class="col-code">${lotHtml(l.lot_code)}</td>
          <td class="col-share"><div class="share"><i style="width:${Math.round((l.qty / max) * 100)}%"></i></div></td>
          <td class="qty">${fmt(l.qty)}<small>박스</small></td>
          <td class="ea">${p.box_qty ? fmt(l.qty * p.box_qty) : ""}</td>
          <td class="num"><button class="btn sm ghost edit-btn" data-adjust="${l.id}">수정</button></td></tr>`).join("")}
        </tbody></table>`}
    </section>`;
  }
  $("#stockGroups").innerHTML = html;
  $("#btnToggleAll").textContent = state.collapsed.size >= order.length ? "모두 펼치기" : "모두 접기";
}

const statusChip = (st) => `<span class="chip ${st.key}">${st.label}<span class="d">${dday(st.d)}</span></span>`;
/** 자식코드 표시: 부모코드 부분은 흐리게, 소비기한 부분은 진하게 */
function lotHtml(code) {
  const m = String(code || "").match(/^(.*-)(\d{8})$/);
  return m ? `<span class="lc"><span class="p">${esc(m[1])}</span><span class="e">${m[2]}</span></span>` : `<span class="lc">${esc(code)}</span>`;
}

async function onAdjust(id) {
  const lot = state.lots.find((l) => String(l.id) === String(id));
  const v = prompt(`${lot.lot_code}\n현재 ${lot.qty}박스 → 변경할 수량`, lot.qty);
  if (v == null) return;
  const n = parseQty(v);
  if (!Number.isInteger(n) || n < 0) return toast("0 이상의 정수를 입력하세요", true);
  const memo = prompt("조정 사유 (예: 파손, 실사차이)", "수동 조정") ?? "수동 조정";
  try { await api.adjustLot(lot.id, n, memo); toast(`${lot.lot_code} → ${n}박스`); await refresh(); }
  catch (e) { toast(e.message, true); }
}

function exportStock() {
  const prodMap = new Map(state.products.map((p) => [p.product_code, p]));
  const rows = state.lots.filter((l) => l.qty !== 0).sort((a, b) => a.lot_code.localeCompare(b.lot_code)).map((l) => {
    const p = prodMap.get(l.product_code) || {}, st = status(l.expiry_date);
    return { 자식코드: l.lot_code, 부모코드: l.product_code, 상품명: p.name, 품목명: p.full_name, 소비기한: l.expiry_date, 잔여일: st.d, 상태: st.label, "재고(박스)": l.qty, 박스입수: p.box_qty, "재고(EA)": p.box_qty ? l.qty * p.box_qty : "" };
  });
  downloadXlsx([["재고현황", rows]], `재고현황_${todayStr()}.xlsx`);
}
function downloadXlsx(sheets, name) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(([n, rows]) => XLSX.utils.book_append_sheet(wb, Array.isArray(rows[0]) ? XLSX.utils.aoa_to_sheet(rows) : XLSX.utils.json_to_sheet(rows), n));
  XLSX.writeFile(wb, name);
}

/* ---------- 업로드 ---------- */
const KIND_HELP = {
  out: "출고 수량만큼 해당 자식코드에서 차감합니다. 소비기한이 비어 있으면 소비기한 빠른 순(FEFO)으로 자동 배분합니다 (경과 로트 제외).",
  in: "해당 자식코드에 수량을 더합니다. 없는 자식코드는 자동으로 새로 만듭니다.",
  count: "실사 수량으로 재고를 덮어씁니다. 차이만큼 '조정' 기록이 남습니다. (파일에 없는 로트는 그대로)",
};
const upload = { wb: null, aoa: null, headerRow: 0, headers: [], map: {}, lines: [], hash: null, name: "" };

function setKind(kind) {
  state.kind = kind;
  document.querySelectorAll("#kindSeg button").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  $("#kindHelp").textContent = KIND_HELP[kind];
  if (upload.aoa) runPreview();
}

async function onFile(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    upload.hash = await sha256(buf); upload.name = file.name;
    upload.wb = XLSX.read(buf, { type: "array" });
    $("#sheetSelect").innerHTML = upload.wb.SheetNames.map((n) => `<option>${esc(n)}</option>`).join("");
    $("#fileInfo").textContent = `${file.name} · ${(file.size / 1024).toFixed(1)}KB`;
    loadSheet(upload.wb.SheetNames[0]);
  } catch (e) { toast("파일을 읽을 수 없습니다: " + e.message, true); }
}
function loadSheet(name) {
  upload.aoa = XLSX.utils.sheet_to_json(upload.wb.Sheets[name], { header: 1, raw: true, defval: "" });
  const d = detectHeader(upload.aoa);
  Object.assign(upload, d);
  $("#mapping").innerHTML = FIELDS.map((f) => `<label>${f.label}<select data-field="${f.key}">
      <option value="-1">— 없음 —</option>${upload.headers.map((h, i) => `<option value="${i}" ${upload.map[f.key] === i ? "selected" : ""}>${esc(h)}</option>`).join("")}
    </select></label>`).join("");
  $("#mappingCard").classList.remove("hidden");
  runPreview();
}

function runPreview() {
  const rows = extractRows(upload.aoa, upload.headerRow, upload.map);
  upload.lines = planUpload(state.kind, rows, state.products, state.lots);
  const L = upload.lines, n = (lv) => L.filter((l) => l.level === lv).length;
  const okLines = L.filter((l) => l.level !== "error");
  const missing = upload.map.qty < 0 || (upload.map.code < 0 && upload.map.lot < 0);
  $("#previewSummary").innerHTML = missing ? `<span class="badge err">수량 · 상품코드(또는 자식코드) 열을 지정하세요</span>` :
    `<span class="badge info">${L.length}행</span><span class="badge ok">정상 ${n("ok")}</span><span class="badge warn">경고 ${n("warn")}</span>
     <span class="badge ${n("error") ? "err" : "ok"}">오류 ${n("error")}</span><span class="badge info">${KIND_LABEL[state.kind]} 합계 ${fmt(okLines.reduce((a, l) => a + (l.qty || 0), 0))}박스</span>`;

  const head = `<thead><tr><th>행</th><th>결과</th><th>자식코드</th><th>상품명</th><th class="num">수량</th><th>반영 내용 (전 → 후)</th><th>참조</th><th>메시지</th></tr></thead>`;
  const body = L.map((l) => {
    const badge = { ok: '<span class="badge ok">정상</span>', warn: '<span class="badge warn">경고</span>', error: '<span class="badge err">오류</span>' }[l.level];
    const alloc = l.allocs.map((a) => `<div class="alloc">${lotHtml(lotCode(l.code, a.exp))} &nbsp;${fmt(a.before)}<span class="arrow">→</span><b>${fmt(a.after)}</b></div>`).join("");
    return `<tr class="${l.level === "error" ? "row-error" : l.level === "warn" ? "row-warn" : ""}"><td>${l.row}</td><td>${badge}</td>
      <td>${l.lot_code ? lotHtml(l.lot_code) : `<span class="lc"><span class="e">${esc(l.code)}</span> <span class="p">소비기한 미기재</span></span>`}</td>
      <td class="strong">${esc(l.name)}</td><td class="num big">${fmt(l.qty)}</td>
      <td>${alloc}</td><td class="small">${esc(l.ref)}</td><td class="msg">${esc(l.msgs.join(" · "))}</td></tr>`;
  }).join("");
  $("#previewTable").innerHTML = head + `<tbody>${body || `<tr><td colspan="8" class="empty">읽은 행이 없습니다. 열 매칭을 확인하세요.</td></tr>`}</tbody>`;
  $("#previewCard").classList.remove("hidden");
  updateApplyBtn();
}
function updateApplyBtn() {
  const L = upload.lines, errs = L.filter((l) => l.level === "error").length, ok = L.length - errs;
  $("#btnApply").disabled = !ok || (errs > 0 && !$("#skipErrors").checked);
  $("#btnApply").textContent = errs && $("#skipErrors").checked ? `${ok}행 반영 (오류 ${errs}행 제외)` : "재고에 반영";
}

async function applyUpload() {
  const lines = upload.lines.filter((l) => l.level !== "error");
  if (!lines.length) return;
  // FEFO 행은 미리보기에서 계산한 배분대로 자식코드를 지정해 전송 → 화면과 DB 결과 일치
  const rows = lines.flatMap((l) => state.kind === "out" && !l.exp
    ? l.allocs.map((a) => ({ row: l.row, product_code: l.code, expiry_date: a.exp, qty: -a.delta, ref: l.ref }))
    : [{ row: l.row, product_code: l.code, expiry_date: l.exp, qty: l.qty, ref: l.ref }]);
  const skipped = upload.lines.length - lines.length;
  if (!confirm(`${KIND_LABEL[state.kind]} ${lines.length}행을 재고에 반영합니다.${skipped ? `\n(오류 ${skipped}행 제외)` : ""}`)) return;
  $("#btnApply").disabled = true;
  try {
    const res = await api.applyUpload(state.kind, upload.name, skipped ? null : upload.hash, rows);
    toast(`반영 완료 · 업로드 #${res.upload_id} · ${lines.length}행 · ${fmt(res.total_qty)}박스`);
    resetUpload(); await refresh(); show("stock");
  } catch (e) { toast(e.message, true); $("#btnApply").disabled = false; }
}
function resetUpload() {
  Object.assign(upload, { wb: null, aoa: null, lines: [], hash: null, name: "" });
  $("#fileInput").value = ""; $("#fileInfo").textContent = ""; $("#skipErrors").checked = false;
  $("#mappingCard").classList.add("hidden"); $("#previewCard").classList.add("hidden");
}
function downloadTemplate() {
  const sample = state.lots.filter((l) => l.qty > 0).slice(0, 2);
  const head = { out: ["상품코드", "소비기한", "수량", "주문번호/출고처"], in: ["상품코드", "소비기한", "수량", "비고"], count: ["상품코드", "소비기한", "수량", "비고"] }[state.kind];
  const rows = [head, ...sample.map((l) => [l.product_code, l.expiry_date, 1, state.kind === "out" ? "쿠팡 10/30" : ""])];
  if (state.kind === "out" && sample[0]) rows.push([sample[0].product_code, "", 1, "소비기한 비우면 FEFO 자동배분"]);
  downloadXlsx([[`${KIND_LABEL[state.kind]}양식`, rows]], `${KIND_LABEL[state.kind]}_업로드양식.xlsx`);
}

/* ---------- 이력 ---------- */
async function renderHistory() {
  try {
    const ups = await api.listUploads();
    $("#uploadTable").innerHTML = `<thead><tr><th>#</th><th>일시</th><th>구분</th><th>파일</th><th class="num">행</th><th class="num">수량</th><th>상태</th><th></th></tr></thead><tbody>` +
      (ups.map((u) => `<tr class="clickable ${state.selectedUpload === u.id ? "selected" : ""}" data-upload="${u.id}"><td>${u.id}</td><td>${fmtDT(u.created_at)}</td>
        <td><span class="badge ${u.kind === "out" ? "alert" : u.kind === "in" ? "ok" : "info"}">${KIND_LABEL[u.kind]}</span></td><td>${esc(u.file_name)}</td>
        <td class="num">${fmt(u.row_count)}</td><td class="num">${fmt(u.total_qty)}</td>
        <td>${u.status === "reverted" ? '<span class="badge expired">취소됨</span>' : '<span class="badge ok">반영</span>'}</td>
        <td class="num">${u.status === "applied" ? `<button class="btn sm danger" data-revert="${u.id}">되돌리기</button>` : ""}</td></tr>`).join("") ||
        `<tr><td colspan="8" class="empty">업로드 내역이 없습니다</td></tr>`) + "</tbody>";
    const mv = await api.listMovements(state.selectedUpload);
    state.movements = mv;
    const prodMap = new Map(state.products.map((p) => [p.product_code, p]));
    $("#movementTitle").textContent = state.selectedUpload ? `업로드 #${state.selectedUpload} 상세` : "입출고 원장 (최근 500건)";
    $("#btnClearMv").classList.toggle("hidden", !state.selectedUpload);
    $("#movementTable").innerHTML = `<thead><tr><th>일시</th><th>구분</th><th>자식코드</th><th>상품명</th><th class="num">수량</th><th>업로드</th><th>참조</th><th>메모</th></tr></thead><tbody>` +
      (mv.map((m) => `<tr><td>${fmtDT(m.created_at)}</td><td><span class="badge ${{ out: "alert", in: "ok", adjust: "info", revert: "expired" }[m.kind] || "info"}">${KIND_LABEL[m.kind] || m.kind}</span></td><td>${lotHtml(m.lot_code)}</td>
        <td class="strong">${esc(prodMap.get(m.product_code)?.name || "")}</td><td class="num big ${m.qty > 0 ? "plus" : "minus"}">${m.qty > 0 ? "+" : ""}${fmt(m.qty)}</td>
        <td>${m.upload_id ? "#" + m.upload_id : ""}</td><td class="small">${esc(m.ref)}</td><td class="small muted">${esc(m.memo)}</td></tr>`).join("") ||
        `<tr><td colspan="8" class="empty">기록이 없습니다</td></tr>`) + "</tbody>";
  } catch (e) { toast(e.message, true); }
}
async function onRevert(id) {
  if (!confirm(`업로드 #${id} 를 되돌립니다. 해당 업로드로 바뀐 재고가 원래대로 돌아갑니다.`)) return;
  try { await api.revertUpload(Number(id)); toast(`업로드 #${id} 되돌림 완료`); await refresh(); renderHistory(); }
  catch (e) { toast(e.message, true); }
}
function exportMovements() {
  const prodMap = new Map(state.products.map((p) => [p.product_code, p]));
  downloadXlsx([["입출고원장", (state.movements || []).map((m) => ({ 일시: fmtDT(m.created_at), 구분: KIND_LABEL[m.kind], 자식코드: m.lot_code, 부모코드: m.product_code, 상품명: prodMap.get(m.product_code)?.name, 수량: m.qty, 업로드: m.upload_id, 참조: m.ref, 메모: m.memo }))]], `입출고원장_${todayStr()}.xlsx`);
}

/* ---------- 상품 ---------- */
function renderProducts() {
  const cnt = new Map(); state.lots.forEach((l) => { const c = cnt.get(l.product_code) || { n: 0, q: 0 }; if (l.qty) { c.n++; c.q += l.qty; } cnt.set(l.product_code, c); });
  $("#productTable").innerHTML = `<thead><tr><th>부모코드</th><th>관리명</th><th>정식 품목명</th><th class="num">박스입수</th><th class="num">보유 자식코드</th><th class="num">재고(박스)</th></tr></thead><tbody>` +
    state.products.map((p) => `<tr><td><span class="g-code">${esc(p.product_code)}</span></td><td class="strong">${esc(p.name)}</td><td class="small">${esc(p.full_name)}</td><td class="num">${fmt(p.box_qty)}</td>
      <td class="num">${fmt(cnt.get(p.product_code)?.n || 0)}</td><td class="num">${fmt(cnt.get(p.product_code)?.q || 0)}</td></tr>`).join("") + "</tbody>";
}
async function onAddProduct(e) {
  e.preventDefault();
  const p = { product_code: $("#pCode").value.trim().toUpperCase(), name: $("#pName").value.trim(), full_name: $("#pFull").value.trim() || null, box_qty: parseInt($("#pBox").value) || null };
  if (!/^[A-Z0-9]+$/.test(p.product_code)) return toast("부모코드는 영문 대문자/숫자만 사용하세요", true);
  try { await api.addProduct(p); e.target.reset(); toast(`${p.product_code} 추가됨`); await refresh(); }
  catch (err) { toast(err.message, true); }
}

/* ---------- 부팅 ---------- */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("스크립트 로드 실패: " + src)); document.head.appendChild(s); });
}

function bindEvents() {
  $("#tabs").addEventListener("click", (e) => { const v = e.target.closest("button")?.dataset.view; if (v) show(v); });
  ["#stockSearch", "#stockFilter", "#hideZero"].forEach((s) => $(s).addEventListener("input", renderStock));
  $("#kpis").addEventListener("click", (e) => { const f = e.target.closest("[data-filter]")?.dataset.filter; if (f) { $("#stockFilter").value = $("#stockFilter").value === f ? "all" : f; renderStock(); } });
  $("#stockGroups").addEventListener("click", (e) => {
    const id = e.target.closest("[data-adjust]")?.dataset.adjust; if (id) return onAdjust(id);
    if (e.target.closest(".g-head")) {
      const g = e.target.closest("[data-group]").dataset.group;
      state.collapsed.has(g) ? state.collapsed.delete(g) : state.collapsed.add(g); renderStock();
    }
  });
  $("#btnToggleAll").addEventListener("click", () => {
    const codes = [...document.querySelectorAll("[data-group]")].map((el) => el.dataset.group);
    const allClosed = codes.every((c) => state.collapsed.has(c));
    codes.forEach((c) => (allClosed ? state.collapsed.delete(c) : state.collapsed.add(c))); renderStock();
  });
  $("#btnExportStock").addEventListener("click", exportStock);

  // 사용 방법 안내: 닫으면 이 브라우저에서 기억, 상단 버튼으로 다시 열기
  const GUIDE_KEY = "inv-guide-hidden";
  const setGuide = (open) => {
    $("#guide").classList.toggle("hidden", !open);
    $("#btnGuide").classList.toggle("on", open);
    try { open ? localStorage.removeItem(GUIDE_KEY) : localStorage.setItem(GUIDE_KEY, "1"); } catch { /* 저장 불가 */ }
  };
  let hidden = false; try { hidden = localStorage.getItem(GUIDE_KEY) === "1"; } catch { /* 저장 불가 */ }
  setGuide(!hidden);
  $("#btnGuideClose").addEventListener("click", () => setGuide(false));
  $("#btnGuide").addEventListener("click", () => {
    const open = $("#guide").classList.contains("hidden");
    setGuide(open); if (open) { show("stock"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  $("#guide").addEventListener("click", (e) => { const k = e.target.closest("[data-goto]")?.dataset.goto; if (k) { setKind(k); show("upload"); } });

  $("#kindSeg").addEventListener("click", (e) => { const k = e.target.closest("button")?.dataset.kind; if (k) setKind(k); });
  $("#fileInput").addEventListener("change", (e) => onFile(e.target.files[0]));
  const dz = $("#dropZone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); onFile(e.dataTransfer.files[0]); });
  $("#sheetSelect").addEventListener("change", (e) => loadSheet(e.target.value));
  $("#mapping").addEventListener("change", (e) => { const f = e.target.dataset.field; if (f) { upload.map[f] = Number(e.target.value); runPreview(); } });
  $("#skipErrors").addEventListener("change", updateApplyBtn);
  $("#btnApply").addEventListener("click", applyUpload);
  $("#btnCancel").addEventListener("click", resetUpload);
  $("#btnTemplate").addEventListener("click", downloadTemplate);

  $("#uploadTable").addEventListener("click", (e) => {
    const rv = e.target.closest("[data-revert]")?.dataset.revert; if (rv) return onRevert(rv);
    const id = e.target.closest("[data-upload]")?.dataset.upload; if (id) { state.selectedUpload = state.selectedUpload === +id ? null : +id; renderHistory(); }
  });
  $("#btnClearMv").addEventListener("click", () => { state.selectedUpload = null; renderHistory(); });
  $("#btnExportMv").addEventListener("click", exportMovements);
  $("#productForm").addEventListener("submit", onAddProduct);
}

async function boot() {
  $("#warehouseName").textContent = CFG.WAREHOUSE_NAME;
  bindEvents(); setKind("out");
  if (MODE === "local") {
    api = new LocalApi();
    $("#modeBanner").innerHTML = `로컬 데모 모드 — 데이터가 이 브라우저에만 저장됩니다. 실제 운영은 config.js 에 Supabase 정보를 입력하세요. <button class="btn sm" id="btnReset">데모 데이터 초기화</button>`;
    $("#modeBanner").classList.remove("hidden");
    $("#btnReset").addEventListener("click", async () => { if (confirm("데모 데이터를 처음 상태(9/7 실사)로 되돌립니다.")) { await api.reset(); await refresh(); toast("초기화 완료"); } });
    $("#session").innerHTML = `<span class="badge warn">데모</span>`;
    await refresh(); show("stock");
    return;
  }
  await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
  api = new SupaApi();
  const enter = async () => {
    const s = await api.session();
    if (!s) { $("#tabs").classList.add("hidden"); $("#btnGuide").classList.add("hidden"); $("#session").innerHTML = ""; show("login"); return; }
    $("#tabs").classList.remove("hidden"); $("#btnGuide").classList.remove("hidden");
    $("#session").innerHTML = `<span>${esc(s.user.email)}</span><button class="btn sm ghost" id="btnLogout">로그아웃</button>`;
    $("#btnLogout").addEventListener("click", async () => { await api.signOut(); enter(); });
    await refresh(); show("stock");
  };
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api.signIn($("#loginEmail").value, $("#loginPw").value); await enter(); }
    catch (err) { toast("로그인 실패: " + err.message, true); }
  });
  await enter();
}

window.__inv = { parseDate, planUpload, detectHeader, extractRows }; // 테스트용
boot().catch((e) => toast(e.message, true));
})();
