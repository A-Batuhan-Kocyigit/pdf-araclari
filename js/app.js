// PDF Araçları — arayüz (web / PWA / Android APK ortak)
import { THEMES } from "./themes.js";
import * as core from "./pdfcore.js";

// pdf.js 4.x eski WebView'larda Promise.withResolvers ister
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  };
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const NP = native ? native.Plugins : {};

// ── Ayarlar (masaüstü ayarlar.json ile aynı anahtarlar) ────────

const LS_VARS = "pdfAraclari.vars";
const LS_PROF = "pdfAraclari.profiles";
const DEFAULTS = {
  h_kind: "kareli", h_sp_kareli: "5", h_sp_cizgili: "8", h_sp_noktali: "5",
  h_margin: "5", h_lw: "0.4", h_color: "Gri",
  h_text: "Ayhan Batuhan Koçyiğit", h_text_pos: "Üst", h_text_size: "11",
  d_first: true, d_every: "1", d_per: "1", d_chain: false, d_keep: true,
  bk_all_pages: true, bk_fold_on: true, bk_fold_dashed: true, bk_fold_color: "Siyah",
  bk_fold_w: "0.6", bk_gutter: "4",
  bk_m_inner: "2", bk_m_outer: "2", bk_m_top: "0", bk_m_bottom: "0",
  bk_creep: false, bk_thick: "0.10",
  bk_rotate_land: true, bk_rot_dir: "Sola",
  bk_cal_total: "29.60", bk_cal_front: "14.80", bk_cal_back: "15.10",
  active_tab: "0", theme: "darkly",
};
const PROFILE_KEYS = Object.keys(DEFAULTS).filter((k) => k.startsWith("bk_") && k !== "bk_all_pages");

function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* özel mod */ } }

// Dışarıdan gelen değerleri varsayılanın türüne çevirir
function coerceVars(obj) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!(k in obj)) continue;
    out[k] = typeof def === "boolean" ? !!obj[k] : String(obj[k]);
  }
  return out;
}

const S = { ...DEFAULTS, ...coerceVars(lsGet(LS_VARS, {})) };
const save = () => lsSet(LS_VARS, S);
let profiles = lsGet(LS_PROF, {});

const num = (v, d) => { const x = parseFloat(String(v).replace(",", ".")); return Number.isFinite(x) ? x : d; };
const int = (v, d, min = 0) => { const x = Math.floor(num(v, NaN)); return Number.isFinite(x) ? Math.max(min, x) : d; };

// ── Küçük arayüz yardımcıları ─────────────────────────────────

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 3500);
}

function log(msg, clear = false) {
  const el = $("#log");
  if (clear) el.textContent = "";
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

const setStatus = (t) => { $("#status").textContent = t; };
const setProgress = (f) => { $("#pbar").style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`; };
const activeTab = () => (S.active_tab === "1" ? "kitapcik" : "defter");

// ── Tema ─────────────────────────────────────────────────────

function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES.find((x) => x.id === "darkly");
  const st = document.documentElement.style;
  for (const [k, v] of Object.entries(t.c)) st.setProperty(`--${k}`, v);
  document.documentElement.dataset.dark = t.dark ? "1" : "0";
  $('meta[name="theme-color"]').content = t.c.dark;
  S.theme = t.id; save();
  $("#theme").value = t.id;
  drawPreview();
}

// ── Ayar alanlarını bağla ────────────────────────────────────

function bindInputs() {
  $$("[data-key]").forEach((el) => {
    const key = el.dataset.key;
    if (el.classList.contains("seg")) {
      const refresh = () => $$("button", el).forEach((b) => b.classList.toggle("active", b.dataset.v === S[key]));
      $$("button", el).forEach((b) => b.addEventListener("click", () => {
        S[key] = b.dataset.v; save(); refresh();
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }));
      el._refresh = refresh;
    } else if (el.type === "checkbox") {
      el._refresh = () => { el.checked = !!S[key]; };
      el.addEventListener("change", () => { S[key] = el.checked; save(); });
    } else {
      el._refresh = () => { el.value = S[key]; };
      el.addEventListener("input", () => { S[key] = el.value; save(); });
    }
    el._refresh();
  });
}

function refreshInputs() {
  $$("[data-key]").forEach((el) => el._refresh?.());
  onKindChange();
  updateRange();
}

function onKindChange() {
  const k = S.h_kind;
  $("#customRow").hidden = k !== "dosya";
  $("#patternCard").classList.toggle("disabled", k === "dosya");
  const sp = $("#h_spacing");
  const spaced = core.SPACED_KINDS.includes(k);
  sp.disabled = !spaced;
  sp.value = spaced ? S[`h_sp_${k}`] : "";
}

// ── Dosyalar ─────────────────────────────────────────────────

const lists = { defter: [], kitapcik: [] };
const selIdx = { defter: 0, kitapcik: 0 };
let customHelper = null;   // { name, bytes }

const isPdf = (f) => /\.pdf$/i.test(f.name || "") || f.type === "application/pdf";
const readFile = async (file) => ({ name: file.name, type: file.type, bytes: await file.arrayBuffer() });

async function addFiles(tab, items) {
  let added = 0;
  for (const f of items) {
    if (!isPdf(f)) { toast(`${f.name}: PDF değil`, "warning"); continue; }
    const name = f.name || `belge_${lists[tab].length + 1}.pdf`;
    if (lists[tab].some((x) => x.name === name && x.bytes.byteLength === f.bytes.byteLength)) continue;
    try {
      const { bytes, fixed } = await core.preparePdf(f.bytes);
      const info = await core.pdfInfo(bytes);
      lists[tab].push({ name, bytes, info });
      added++;
      if (fixed === "şifre") toast(`🔓 ${name}: düzenleme kısıtlaması kaldırıldı`, "success");
      else if (fixed) toast(`🛠 ${name}: bozuk yapı onarıldı`, "success");
    } catch (e) {
      toast(/^(Şifreli|PDF onarılamadı)/.test(e.message) ? `${name}: ${e.message}` : `${name}: okunamadı (${e.message})`, "danger");
    }
  }
  if (added) { renderList(tab); onFilesChanged(tab); }
}

function renderList(tab) {
  const ul = $(`[data-list="${tab}"]`);
  const list = lists[tab];
  if (selIdx[tab] >= list.length) selIdx[tab] = 0;
  ul.innerHTML = list.map((f, i) => `
    <li data-i="${i}" class="${i === selIdx[tab] ? "sel" : ""}" title="Önizlemek için dokunun">
      <span class="grow">${esc(f.name)}</span>
      <span class="muted">${f.info.pageCount} s.</span>
      <button class="btn x" data-rm="${i}" aria-label="Kaldır">✕</button>
    </li>`).join("");
}

function onFilesChanged(tab) {
  if (tab === "kitapcik") {
    const l = lists.kitapcik;
    if (l.length === 1) {
      const f = l[0], n = f.info.pageCount;
      $("#page_range").value = `1-${n}`;
      const pad = (4 - (n % 4)) % 4, total = n + pad, sheets = total / 4;
      const rot = S.bk_rotate_land;
      const sw = rot ? f.info.slotW : f.info.w, sh = rot ? f.info.slotH : f.info.h;
      log(`Yüklendi: ${f.name}\n  ${f.info.label}\n  Sayfa     : ${n}\n  Boş ek    : ${pad}\n` +
          `  Toplam    : ${total}\n  Yaprak    : ${sheets}\n  Çıktı yüz : ${sheets * 2}\n` +
          `  Yatay     : ${f.info.landscape} sayfa${f.info.landscape && rot ? " (döndürülecek)" : ""}\n\n` +
          `Çıktı kağıt tahmini:\n  ~${(sw * 2 / core.MM).toFixed(0)} x ${(sh / core.MM).toFixed(0)} mm`, true);
      setStatus(`${n} sayfa | ${f.info.isPortrait ? "Dikey" : "Yatay"}`);
    } else if (l.length > 1) {
      log(`${l.length} dosya seçildi.\nHer biri ayrı kitapçığa dönüştürülecek (tüm sayfalar).`, true);
    }
    updateRange();
  }
  if (tab === activeTab()) preview();
}

// ── Sayfa aralığı ────────────────────────────────────────────

const rangeUsable = () => lists.kitapcik.length === 1;
const rangeSpec = () => (!rangeUsable() || S.bk_all_pages ? "" : $("#page_range").value.trim());

function updateRange() {
  const usable = rangeUsable();
  const info = $("#range_info");
  $("#bk_all").disabled = !usable;
  const editable = usable && !S.bk_all_pages;
  $("#page_range").disabled = !editable;
  $("#range_all").disabled = !editable;
  info.classList.remove("err");
  if (lists.kitapcik.length > 1) { info.textContent = `${lists.kitapcik.length} dosya → her biri tüm sayfalar`; return; }
  if (!usable) { info.textContent = "—"; return; }
  try {
    const n = core.parsePageRange(rangeSpec(), lists.kitapcik[0].info.pageCount).length;
    const pad = (4 - (n % 4)) % 4;
    info.textContent = `${n} sayfa → ${(n + pad) / 4} yaprak (+${pad} boş)`;
  } catch (e) {
    info.textContent = `✘ ${e.message}`;
    info.classList.add("err");
  }
}

// ── İşlem seçenekleri ────────────────────────────────────────

function helperOpts() {
  const k = S.h_kind;
  if (k === "dosya" && !customHelper) throw new Error("Özel ek sayfa PDF'i seçilmedi.");
  return {
    kind: k,
    spacing: core.SPACED_KINDS.includes(k) ? num(S[`h_sp_${k}`], 5) : 5,
    margin: num(S.h_margin, 5),
    lineWidth: num(S.h_lw, 0.4),
    color: core.HELPER_COLORS[S.h_color] ?? [0.6, 0.6, 0.6],
    text: S.h_text,
    textSize: num(S.h_text_size, 11),
    textPos: S.h_text_pos === "Üst" ? "ust" : "alt",
    fileBytes: customHelper?.bytes,
  };
}

const layoutOpts = () => ({ insertFirst: S.d_first, everyN: int(S.d_every, 1), perInsert: int(S.d_per, 1, 1) });

function bookletOpts() {
  const total = Math.max(num(S.bk_cal_total, 29.6), 0.01);
  return {
    drawFold: S.bk_fold_on,
    foldColor: core.FOLD_COLORS[S.bk_fold_color] ?? [0, 0, 0],
    foldWidth: num(S.bk_fold_w, 0.6),
    foldDashed: S.bk_fold_dashed,
    marginInner: num(S.bk_m_inner, 5),
    marginOuter: num(S.bk_m_outer, 5),
    marginTop: num(S.bk_m_top, 5),
    marginBottom: num(S.bk_m_bottom, 5),
    gutterMm: num(S.bk_gutter, 4),
    frontFoldRatio: num(S.bk_cal_front, 14.8) / total,
    backFoldRatio: num(S.bk_cal_back, 15.1) / total,
    applyCreep: S.bk_creep,
    paperThick: num(S.bk_thick, 0.1),
    rotateLandscape: S.bk_rotate_land,
    rotateLeft: S.bk_rot_dir !== "Sağa",
  };
}

// ── Önizleme ─────────────────────────────────────────────────

let pdfjs = null;
async function getPdfjs() {
  if (!pdfjs) {
    pdfjs = await import("../vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
  }
  return pdfjs;
}

const pv = { imgs: [], caps: [], idx: 0 };
let pvToken = 0, pvTimer = null;
const faceCap = (i, sheets, prefix = "") => `${prefix}Yaprak ${Math.floor(i / 2) + 1} / ${sheets} — ${i % 2 === 0 ? "Ön" : "Arka"} yüz`;

function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(preview, 600);
}

async function preview() {
  const tab = activeTab();
  const f = lists[tab][selIdx[tab]] || lists[tab][0];
  if (!f) { showPreview([], []); return; }
  const token = ++pvToken;
  $("#pv_label").textContent = "Önizleme hazırlanıyor…";
  try {
    let bytes, caps;
    if (tab === "defter") {
      const nb = await core.buildNotebook(f.bytes, helperOpts(), layoutOpts());
      if (S.d_chain) {
        const r = await core.makeBooklet(nb.bytes, { ...bookletOpts(), maxFaces: 6 });
        bytes = r.bytes;
        caps = [...Array(r.info.faces).keys()].map((i) => faceCap(i, r.info.sheets, "Kitapçık • "));
      } else {
        bytes = nb.bytes;
        caps = nb.stats.kinds.slice(0, 6).map((k, i) => `Defter • Sayfa ${i + 1} / ${nb.stats.outPages}${k === "ek" ? " (ek)" : ""}`);
      }
    } else {
      const r = await core.makeBooklet(f.bytes, { ...bookletOpts(), pageRange: rangeSpec(), maxFaces: 6 });
      bytes = r.bytes;
      caps = [...Array(r.info.faces).keys()].map((i) => faceCap(i, r.info.sheets));
    }
    if (token !== pvToken) return;

    const lib = await getPdfjs();
    const doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const canvas = $("#pv");
    const dpr = window.devicePixelRatio || 1;
    const bw = canvas.clientWidth * dpr, bh = canvas.clientHeight * dpr;
    const imgs = [];
    for (let i = 1; i <= Math.min(doc.numPages, 6); i++) {
      const page = await doc.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      const scale = Math.min(bw / vp0.width, bh / vp0.height) * 0.96;
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      imgs.push(c);
      if (token !== pvToken) return;
    }
    doc.destroy();
    showPreview(imgs, caps.slice(0, imgs.length));
  } catch (e) {
    if (token === pvToken) { $("#pv_label").textContent = `✘ ${e.message}`; showPreview([], [], true); }
  }
}

function showPreview(imgs, caps, keepLabel = false) {
  pv.imgs = imgs; pv.caps = caps; pv.idx = 0;
  drawPreview(keepLabel);
}

function drawPreview(keepLabel = false) {
  const canvas = $("#pv");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!pv.imgs.length) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg");
    ctx.globalAlpha = 0.4;
    ctx.font = `${14 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Önizleme yok", canvas.width / 2, canvas.height / 2);
    ctx.globalAlpha = 1;
    if (!keepLabel) $("#pv_label").textContent = "Dosya ekleyin";
    return;
  }
  const img = pv.imgs[pv.idx];
  const s = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
  const w = img.width * s, h = img.height * s;
  const x = (canvas.width - w) / 2, y = (canvas.height - h) / 2;
  ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 8 * dpr;
  ctx.fillStyle = "#fff"; ctx.fillRect(x, y, w, h);
  ctx.shadowBlur = 0;
  ctx.drawImage(img, x, y, w, h);
  $("#pv_label").textContent = `${pv.idx + 1}/${pv.imgs.length}  ${pv.caps[pv.idx] || ""}`;
}

function stepPreview(d) {
  if (!pv.imgs.length) return;
  pv.idx = (pv.idx + d + pv.imgs.length) % pv.imgs.length;
  drawPreview();
}

// ── Çıktılar: indir / kaydet / paylaş ────────────────────────

const results = [];

function toBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function uniqueName(name) {
  const stem = name.replace(/\.(pdf|json)$/i, ""), ext = name.slice(stem.length);
  let n = name, i = 1;
  while (results.some((r) => r.name === n)) n = `${stem}_${i++}${ext}`;
  return n;
}

function addResult(name, bytes) {
  results.push({ name: uniqueName(name), bytes });
  renderResults();
}

function renderResults() {
  const card = $("#results");
  card.hidden = !results.length;
  const canShare = native || (navigator.canShare && navigator.canShare({ files: [new File([""], "a.pdf", { type: "application/pdf" })] }));
  $(".results", card).innerHTML = results.map((r, i) => `
    <li>
      <span class="name">${esc(r.name)} <span class="muted">(${(r.bytes.length / 1024).toFixed(0)} KB)</span></span>
      <button class="btn" data-act="save" data-i="${i}">${native ? "💾 Kaydet" : "⤓ İndir"}</button>
      ${canShare ? `<button class="btn" data-act="share" data-i="${i}">📤 Paylaş</button>` : ""}
      ${native ? "" : `<button class="btn" data-act="open" data-i="${i}">↗ Aç</button>`}
    </li>`).join("");
}

async function saveFile(name, bytes, mime = "application/pdf") {
  if (native) {
    try {
      await NP.Filesystem.writeFile({ path: `PDF_Araclari/${name}`, data: toBase64(bytes), directory: "DOCUMENTS", recursive: true });
      toast(`Belgeler/PDF_Araclari/${name} kaydedildi`, "success");
    } catch (e) {
      toast(`Kaydedilemedi (${e.message}). "Paylaş" ile kaydetmeyi deneyin.`, "danger");
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function shareFile(name, bytes, mime = "application/pdf") {
  try {
    if (native) {
      const w = await NP.Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: "CACHE" });
      await NP.Share.share({ title: name, files: [w.uri] });
      return;
    }
    const file = new File([bytes], name, { type: mime });
    await navigator.share({ files: [file], title: name });
  } catch (e) {
    if (e?.name !== "AbortError" && !/cancel/i.test(e?.message || "")) toast(`Paylaşılamadı: ${e.message}`, "danger");
  }
}

function openResult(r) {
  const url = URL.createObjectURL(new Blob([r.bytes], { type: "application/pdf" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

// ── Çalıştır ─────────────────────────────────────────────────

let busy = false;

async function run() {
  if (busy) return;
  const tab = activeTab();
  const files = [...lists[tab]];
  if (!files.length) { toast("Önce en az bir PDF ekleyin.", "warning"); return; }

  let helper, layout, bk, rng = "";
  try {
    if (tab === "defter") { helper = helperOpts(); layout = layoutOpts(); }
    bk = bookletOpts();
    if (tab === "kitapcik") {
      rng = rangeSpec();
      if (rng) core.parsePageRange(rng, files[0].info.pageCount);
    }
  } catch (e) { toast(e.message, "warning"); return; }

  busy = true;
  $("#run").disabled = true;
  setProgress(0);
  setStatus("İşleniyor…");
  const chain = tab === "defter" && S.d_chain;
  log(tab === "defter"
    ? `Defter oluşturuluyor…\n  Dosya   : ${files.length}\n  Tür     : ${Object.fromEntries(core.HELPER_KINDS)[helper.kind]}\n  Kitapçık: ${chain ? "Evet" : "Hayır"}\n`
    : `Kitapçık oluşturuluyor…\n  Dosya  : ${files.length}\n  Aralık : ${rng || "Tüm sayfalar"}\n`, true);

  const n = files.length;
  let ok = 0, made = 0;
  const errs = [];
  const before = results.length;
  for (const [fi, f] of files.entries()) {
    const stem0 = f.name.replace(/\.pdf$/i, "");
    try {
      if (tab === "defter") {
        const keep = S.d_keep || !chain;
        const nb = await core.buildNotebook(f.bytes, helper, {
          ...layout, progress: (c, t) => setProgress((fi + (c / Math.max(t, 1)) * (chain ? 0.5 : 1)) / n),
        });
        const stem = `defter_${stem0}_${core.KIND_FILE_SUFFIX[helper.kind]}`;
        const lines = [`✔ ${f.name}: ${nb.stats.srcPages} → ${nb.stats.outPages} sayfa`];
        if (keep) { addResult(`${stem}.pdf`, nb.bytes); made++; }
        if (chain) {
          const r = await core.makeBooklet(nb.bytes, {
            ...bk, progress: (c, t) => setProgress((fi + 0.5 + (c / Math.max(t, 1)) * 0.5) / n),
          });
          addResult(`${stem}_kitapçık.pdf`, r.bytes); made++;
          lines.push(`   kitapçık: ${r.info.sheets} yaprak, +${r.info.blank} boş`);
        }
        log(lines.join("\n"));
      } else {
        const r = await core.makeBooklet(f.bytes, {
          ...bk, pageRange: rng, progress: (c, t) => setProgress((fi + c / Math.max(t, 1)) / n),
        });
        addResult(`${stem0}_kitapçık.pdf`, r.bytes); made++;
        const I = r.info;
        log(`✔ ${f.name}\n  ${I.srcLabel} → ` +
            `${(I.outW / core.MM).toFixed(0)}×${(I.outH / core.MM).toFixed(0)} mm\n` +
            `  Seçilen ${I.picked}/${I.srcPages} • ${I.sheets} yaprak • +${I.blank} boş` +
            (I.rotated ? `\n  ↻ ${I.rotated} yatay sayfa döndürüldü` : ""));
      }
      ok++;
    } catch (e) {
      errs.push(`${f.name}: ${e.message}`);
      log(`✘ ${f.name}: ${e.message}`);
    }
  }

  busy = false;
  $("#run").disabled = false;
  setProgress(ok ? 1 : 0);
  setStatus(errs.length ? `⚠ ${ok} başarılı, ${errs.length} hata` : "✔ Tamamlandı!");
  log(`\nToplam: ${ok} başarılı, ${errs.length} hata, ${made} PDF oluşturuldu.` +
      (tab === "kitapcik" || chain ? "\n\nYazdırma:\n  • Çift taraflı\n  • Kısa kenara çevir\n  • Orta çizgiden kat" : ""));
  if (made) {
    toast(`${made} PDF hazır — Çıktılar bölümünden ${native ? "kaydedin veya paylaşın" : "indirin"}.`, "success");
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    if (results.length > before) $(`#results li:nth-child(${before + 1})`)?.focus?.();
  } else {
    toast(errs[0] || "Hiç çıktı oluşturulamadı.", "danger");
  }
}

// ── Profiller ve ayar dosyası ────────────────────────────────

function renderProfiles(selected = "") {
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b, "tr"));
  $("#profile").innerHTML = `<option value="">— Profil seçin (${names.length}) —</option>` +
    names.map((n) => `<option ${n === selected ? "selected" : ""}>${esc(n)}</option>`).join("");
}

function applyProfile(name) {
  if (!profiles[name]) return;
  Object.assign(S, coerceVars(profiles[name]));
  save(); refreshInputs(); schedulePreview();
  toast(`"${name}" profili uygulandı`, "success");
}

async function importSettings(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch { toast("Geçersiz JSON dosyası", "danger"); return; }
  const parts = [];
  if (obj.vars && typeof obj.vars === "object") {
    const { active_tab, theme, ...vars } = coerceVars(obj.vars);   // açık sekme bu cihazda kalsın
    Object.assign(S, vars);
    parts.push("ayarlar");
    if (!obj.profiles) {
      // Masaüstü ayar dosyası: kitapçık ayarlarını "Masaüstü" profiline de koy
      const p = {};
      for (const k of PROFILE_KEYS) if (k in obj.vars) p[k] = obj.vars[k];
      if (Object.keys(p).length) { profiles["Masaüstü"] = coerceVars(p); parts.push('"Masaüstü" profili'); }
    }
  }
  if (obj.profiles && typeof obj.profiles === "object") {
    for (const [n, p] of Object.entries(obj.profiles)) profiles[n] = coerceVars(p);
    parts.push(`${Object.keys(obj.profiles).length} profil`);
  }
  if (!parts.length) { toast("Dosyada tanınan ayar bulunamadı", "warning"); return; }
  if (obj.theme && THEMES.some((t) => t.id === obj.theme)) S.theme = obj.theme;
  save(); lsSet(LS_PROF, profiles);
  refreshInputs(); renderProfiles(); applyTheme(S.theme); schedulePreview();
  toast(`İçe aktarıldı: ${parts.join(", ")}`, "success");
}

function exportSettings() {
  const data = { app: "pdf-araclari", version: 1, theme: S.theme, vars: S, profiles };
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
  saveFile("pdf_araclari_ayarlar.json", bytes, "application/json");
}

// ── Özel ek sayfa dosyası (cihazda hatırlanır) ───────────────

const USER_CACHE = "pdf-araclari-user";

async function storeHelper() {
  try {
    const c = await caches.open(USER_CACHE);
    if (customHelper) {
      await c.put("helper.pdf", new Response(customHelper.bytes, { headers: { "x-name": encodeURIComponent(customHelper.name) } }));
    } else {
      await c.delete("helper.pdf");
    }
  } catch { /* önbellek yoksa yalnızca bu oturumda tutulur */ }
}

async function loadHelper() {
  try {
    const c = await caches.open(USER_CACHE);
    const r = await c.match("helper.pdf");
    if (r) customHelper = { name: decodeURIComponent(r.headers.get("x-name") || "ozel.pdf"), bytes: await r.arrayBuffer() };
  } catch { /* yok */ }
  $("#h_file_name").textContent = customHelper ? customHelper.name : "Seçilmedi (ilk sayfası kullanılır)";
}

// ── Paylaşılan dosyalar (PWA paylaşım hedefi / Android) ──────

async function receiveWebShared() {
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const c = await caches.open("pdf-araclari-shared");
    const items = [];
    for (const req of await c.keys()) {
      const res = await c.match(req);
      items.push({ name: decodeURIComponent(res.headers.get("x-name") || "paylasilan.pdf"), type: "application/pdf", bytes: await res.arrayBuffer() });
      await c.delete(req);
    }
    if (items.length) { await addFiles(activeTab(), items); toast(`${items.length} paylaşılan PDF eklendi`, "success"); }
  } catch (e) { toast(`Paylaşılan dosya alınamadı: ${e.message}`, "danger"); }
}

async function receiveNativeShared() {
  const plugin = NP.SharedFiles;
  if (!plugin) return;
  try {
    const { files = [] } = await plugin.getPending();
    const items = [];
    for (const f of files) {
      const res = await fetch(native.convertFileSrc(f.path));
      items.push({ name: f.name || "paylasilan.pdf", type: "application/pdf", bytes: await res.arrayBuffer() });
    }
    if (items.length) { await addFiles(activeTab(), items); toast(`${items.length} paylaşılan PDF eklendi`, "success"); }
  } catch (e) { toast(`Paylaşılan dosya alınamadı: ${e.message}`, "danger"); }
}

// ── Sekmeler ─────────────────────────────────────────────────

function selectTab(tab) {
  S.active_tab = tab === "kitapcik" ? "1" : "0"; save();
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${tab}`));
  $("#run").textContent = tab === "defter" ? "▶ Defter Oluştur" : "▶ Kitapçık Oluştur";
  preview();
}

// ── Başlat ───────────────────────────────────────────────────

function init() {
  // Dinamik içerik
  $("#theme").innerHTML = THEMES.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
  $("#kindSeg").innerHTML = core.HELPER_KINDS.map(([k, l]) => `<button data-v="${k}">${l}</button>`).join("");
  $("#foldSeg").innerHTML = Object.keys(core.FOLD_COLORS).map((c) => `<button data-v="${c}">${c}</button>`).join("");
  $("#h_color").innerHTML = Object.keys(core.HELPER_COLORS).map((c) => `<option>${c}</option>`).join("");

  bindInputs();
  onKindChange();
  applyTheme(S.theme);
  renderProfiles();

  $("#theme").addEventListener("change", (e) => applyTheme(e.target.value));
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  $("#kindSeg").addEventListener("change", onKindChange);
  $("#h_spacing").addEventListener("input", (e) => {
    if (core.SPACED_KINDS.includes(S.h_kind)) { S[`h_sp_${S.h_kind}`] = e.target.value; save(); }
  });

  // Dosya seçimi
  $$("[data-pick]").forEach((inp) => inp.addEventListener("change", async () => {
    const items = await Promise.all([...inp.files].map(readFile));
    inp.value = "";
    await addFiles(inp.dataset.pick, items);
  }));
  $$(".filelist").forEach((ul) => ul.addEventListener("click", (e) => {
    const tab = ul.dataset.list;
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      lists[tab].splice(+rm.dataset.rm, 1);
      renderList(tab);
      if (tab === "kitapcik") onFilesChanged(tab); else preview();
      return;
    }
    const li = e.target.closest("li");
    if (li) { selIdx[tab] = +li.dataset.i; renderList(tab); preview(); }
  }));

  $("#h_file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const f = await readFile(file);
    let bytes;
    try { ({ bytes } = await core.preparePdf(f.bytes)); } catch (err) { toast(`Okunamadı: ${err.message}`, "danger"); return; }
    customHelper = { name: f.name, bytes };
    $("#h_file_name").textContent = f.name;
    storeHelper();
    schedulePreview();
  });

  // Sayfa aralığı
  $("#bk_all").addEventListener("change", () => {
    if (!S.bk_all_pages && !$("#page_range").value && rangeUsable()) $("#page_range").value = `1-${lists.kitapcik[0].info.pageCount}`;
    updateRange();
  });
  $("#page_range").addEventListener("input", updateRange);
  $("#range_all").addEventListener("click", () => {
    if (rangeUsable()) { $("#page_range").value = `1-${lists.kitapcik[0].info.pageCount}`; updateRange(); schedulePreview(); }
  });

  // Her ayar değişikliğinde önizlemeyi tazele
  $(".col-main").addEventListener("input", (e) => { if (!e.target.matches("[type=file]")) schedulePreview(); });
  $(".col-main").addEventListener("change", (e) => { if (!e.target.matches("[type=file]")) schedulePreview(); });

  // Önizleme
  $("#pv_prev").addEventListener("click", () => stepPreview(-1));
  $("#pv_next").addEventListener("click", () => stepPreview(1));
  $("#pv_refresh").addEventListener("click", preview);
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(drawPreview, 150); });

  // Çıktılar
  $("#results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const r = results[+b.dataset.i];
    if (b.dataset.act === "save") saveFile(r.name, r.bytes);
    else if (b.dataset.act === "share") shareFile(r.name, r.bytes);
    else openResult(r);
  });
  $("#res_clear").addEventListener("click", () => { results.length = 0; renderResults(); });

  // Profiller
  $("#prof_apply").addEventListener("click", () => {
    const n = $("#profile").value;
    if (n) applyProfile(n); else toast("Önce bir profil seçin", "warning");
  });
  $("#prof_save").addEventListener("click", () => {
    const n = prompt("Profil adı (ör. Ev yazıcısı):", $("#profile").value || "")?.trim();
    if (!n) return;
    profiles[n] = Object.fromEntries(PROFILE_KEYS.map((k) => [k, S[k]]));
    lsSet(LS_PROF, profiles);
    renderProfiles(n);
    toast(`"${n}" profili kaydedildi`, "success");
  });
  $("#prof_del").addEventListener("click", () => {
    const n = $("#profile").value;
    if (!n) { toast("Silinecek profili seçin", "warning"); return; }
    if (!confirm(`"${n}" profili silinsin mi?`)) return;
    delete profiles[n];
    lsSet(LS_PROF, profiles);
    renderProfiles();
  });
  $("#prof_export").addEventListener("click", exportSettings);
  $("#prof_import").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) importSettings(f);
  });

  // Sürükle-bırak (tüm sayfa)
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0; document.body.classList.remove("dragging");
    const items = await Promise.all([...(e.dataTransfer?.files || [])].map(readFile));
    if (items.length) addFiles(activeTab(), items);
  });

  $("#run").addEventListener("click", run);

  log("PDF dosyalarını ekleyin.\n\n" +
      "Defter  : sayfaların arasına kareli, çizgili,\n          noktalı veya özel sayfa ekler.\n" +
      "Kitapçık: sayfaları kat edilip zımbalanacak\n          şekilde dizer.\n\n" +
      "Dosyalarınız cihazınızdan çıkmaz; tüm işlem\nburada, internetsiz yapılır.\n" +
      "Ayarlar otomatik hatırlanır.");

  selectTab(activeTab());
  loadHelper();
  receiveWebShared();

  if (native) {
    receiveNativeShared();
    NP.SharedFiles?.addListener?.("filesReceived", receiveNativeShared);
  } else if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
