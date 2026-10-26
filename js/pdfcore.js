// PDF Araçları — çekirdek: defter (ek sayfa) + kitapçık (imposition)
// Masaüstü sürümündeki (pdf_araclari.py) algoritmaların birebir karşılığı.
// pdf-lib ve fontkit global olarak (vendor/*.js) yüklenir.

const { PDFDocument, rgb, degrees } = window.PDFLib;

export const MM = 2.8346456;   // 1 mm = 2.8346 pt

// ── Ortak yardımcılar ────────────────────────────────────────

const tick = () => new Promise((r) => setTimeout(r, 0));

let fontBytesCache = null;
async function loadFontBytes() {
  if (!fontBytesCache) {
    const res = await fetch(new URL("../fonts/DejaVuSans-Bold.ttf", import.meta.url));
    fontBytesCache = await res.arrayBuffer();
  }
  return fontBytesCache;
}

// ── Şifreli / bozuk PDF hazırlığı (qpdf, WebAssembly) ────────
// pdf-lib şifre çözemez: AES şifreli PDF'leri hiç açamaz, RC4 şifrelileri
// açar ama içerik şifreli kalır. Bu durumlarda (ve bozuk dosyalarda) qpdf
// ile şifresiz, onarılmış bir kopya çıkarılır. Normal PDF'lere dokunulmaz.

let qpdfFactory = null;

async function loadQpdf() {
  if (window.qpdfModule) return window.qpdfModule;   // önceden yüklenmiş (ör. testler)
  if (!qpdfFactory) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL("../vendor/qpdf.js", import.meta.url).href;
      s.onload = resolve;
      s.onerror = () => reject(new Error("qpdf yüklenemedi"));
      document.head.append(s);
    });
    qpdfFactory = window.Module;                     // Emscripten fabrikası
  }
  return qpdfFactory;
}

/**
 * PDF'i pdf-lib'in güvenle işleyebileceği hale getirir.
 * Dönüş: { bytes, fixed }  —  fixed: null | "şifre" | "onarım"
 */
export async function preparePdf(bytes) {
  let encrypted = false;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    doc.getPages();                                  // sayfa ağacı okunabiliyor mu?
    if (!doc.isEncrypted) return { bytes, fixed: null };
    encrypted = true;
  } catch {
    // aşağıda qpdf ile onarılır
  }

  const factory = await loadQpdf();
  const q = await factory({
    locateFile: () => window.qpdfWasmUrl || new URL("../vendor/qpdf.wasm", import.meta.url).href,
    print: () => {},
    printErr: () => {},
  });
  q.FS.writeFile("/in.pdf", new Uint8Array(bytes));
  // Çıkış kodu 3 = uyarılarla başarılı (bozuk dosya onarıldı)
  const code = q.callMain(["--decrypt", "/in.pdf", "/out.pdf"]);
  if (code !== 0 && code !== 3) {
    throw new Error(encrypted ? "Şifreli PDF açılamadı (açılış parolası gerekiyor olabilir)" : "PDF onarılamadı");
  }
  const out = q.FS.readFile("/out.pdf");
  const doc = await PDFDocument.load(out);
  if (doc.isEncrypted) throw new Error("Şifreli PDF açılamadı (açılış parolası gerekiyor olabilir)");
  doc.getPages();
  // pdf-lib açamadıysa şifreli olup olmadığını /Encrypt sözlüğünden anla
  if (!encrypted) encrypted = new TextDecoder("latin1").decode(new Uint8Array(bytes)).includes("/Encrypt");
  return {
    bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    fixed: encrypted ? "şifre" : "onarım",
  };
}

// Sayfanın görünen kutusu (CropBox) ve döndürme bilgisi
function pageBox(page) {
  const cb = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  return {
    bbox: { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height },
    rot,
    w: swap ? cb.height : cb.width,      // görünen genişlik
    h: swap ? cb.width : cb.height,      // görünen yükseklik
  };
}

// Gömülü sayfayı (döndürmesini uygulayarak) hedef dikdörtgene çizer
function drawRotated(target, emb, rot, x, y, w, h) {
  if (rot === 90) {
    target.drawPage(emb, { x, y: y + h, width: h, height: w, rotate: degrees(-90) });
  } else if (rot === 180) {
    target.drawPage(emb, { x: x + w, y: y + h, width: w, height: h, rotate: degrees(180) });
  } else if (rot === 270) {
    target.drawPage(emb, { x: x + w, y, width: h, height: w, rotate: degrees(90) });
  } else {
    target.drawPage(emb, { x, y, width: w, height: h });
  }
}

const toRgb = (c) => rgb(c[0], c[1], c[2]);

// ── Defter: ek sayfa üretimi ─────────────────────────────────

export const HELPER_KINDS = [
  ["kareli", "Kareli"],
  ["cizgili", "Çizgili"],
  ["noktali", "Noktalı"],
  ["bos", "Boş"],
  ["dosya", "Özel PDF"],
];
export const SPACED_KINDS = ["kareli", "cizgili", "noktali"];
export const DEFAULT_SPACING = { kareli: "5", cizgili: "8", noktali: "5" };
export const KIND_FILE_SUFFIX = {
  kareli: "kareli", cizgili: "cizgili", noktali: "noktali", bos: "bos", dosya: "ozel",
};

export const HELPER_COLORS = {
  "Açık gri": [0.78, 0.78, 0.78],
  "Gri": [0.60, 0.60, 0.60],
  "Koyu gri": [0.35, 0.35, 0.35],
  "Mavi": [0.45, 0.65, 0.90],
  "Yeşil": [0.45, 0.75, 0.50],
  "Kırmızı": [0.90, 0.45, 0.45],
  "Siyah": [0.00, 0.00, 0.00],
};

// Tek sayfalık desen şablonu üretir (PDF bayt dizisi)
async function makeHelperTemplate(w, h, opt) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([w, h]);
  const m = opt.margin * MM;
  const sp = Math.max(opt.spacing, 1) * MM;
  const text = (opt.text || "").trim();
  const fs = opt.textSize;
  const band = text ? fs * 2.4 : 0;

  // pdf-lib koordinatları sol-alttan başlar
  const top = h - m - (opt.textPos === "ust" ? band : 0);
  const bottom = m + (opt.textPos === "alt" ? band : 0);
  const area = { x0: m, x1: w - m, y0: bottom, y1: top };
  const aw = area.x1 - area.x0;
  const ah = area.y1 - area.y0;
  const color = toRgb(opt.color);

  if (SPACED_KINDS.includes(opt.kind) && aw > sp && ah > sp) {
    // Tam sayıda hücre sığdır, deseni alan içinde ortala
    const cols = Math.floor(aw / sp);
    const rows = Math.floor(ah / sp);
    const gw = cols * sp, gh = rows * sp;
    const x0 = area.x0 + (aw - gw) / 2;
    const yTop = area.y1 - (ah - gh) / 2;
    const lw = opt.lineWidth;

    if (opt.kind === "kareli") {
      for (let i = 0; i <= cols; i++) {
        const x = x0 + i * sp;
        page.drawLine({ start: { x, y: yTop }, end: { x, y: yTop - gh }, thickness: lw, color });
      }
      for (let j = 0; j <= rows; j++) {
        const y = yTop - j * sp;
        page.drawLine({ start: { x: x0, y }, end: { x: x0 + gw, y }, thickness: lw, color });
      }
    } else if (opt.kind === "cizgili") {
      for (let j = 0; j <= rows; j++) {
        const y = yTop - j * sp;
        page.drawLine({ start: { x: area.x0, y }, end: { x: area.x1, y }, thickness: lw, color });
      }
    } else {  // noktali
      const rad = Math.max(lw, 0.3) * 1.2;
      for (let i = 0; i <= cols; i++) {
        for (let j = 0; j <= rows; j++) {
          page.drawCircle({ x: x0 + i * sp, y: yTop - j * sp, size: rad, color });
        }
      }
    }
  }

  if (text) {
    doc.registerFontkit(window.fontkit);
    const font = await doc.embedFont(await loadFontBytes(), { subset: true });
    const tw = font.widthOfTextAtSize(text, fs);
    const bandBottom = opt.textPos === "ust" ? h - m - band : m;
    page.drawText(text, {
      x: (w - tw) / 2,
      y: bandBottom + band / 2 - fs * 0.35,
      size: fs, font, color: rgb(0, 0, 0),
    });
  }
  return doc.save();
}

/**
 * Kaynak PDF'in sayfaları arasına ek (kareli/çizgili/…) sayfalar yerleştirir.
 * Ek sayfa her zaman yanındaki ana sayfanın boyutuna uydurulur.
 * Dönüş: { bytes, stats }
 */
export async function buildNotebook(srcBytes, helper, {
  insertFirst = true, everyN = 1, perInsert = 1, progress = null,
} = {}) {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const n = src.getPageCount();
  const kinds = [];
  const templates = new Map();   // "w×h" → gömülü şablon sayfa

  let custom = null;
  if (helper.kind === "dosya") {
    if (!helper.fileBytes) throw new Error("Özel ek sayfa PDF'i seçilmedi.");
    const cdoc = await PDFDocument.load(helper.fileBytes, { ignoreEncryption: true });
    if (cdoc.getPageCount() < 1) throw new Error("Özel ek sayfa PDF'i boş.");
    const cp = cdoc.getPage(0);
    const box = pageBox(cp);
    custom = { emb: await out.embedPage(cp, box.bbox), box };
  }

  async function templateFor(w, h) {
    const key = `${w.toFixed(1)}x${h.toFixed(1)}`;
    if (!templates.has(key)) {
      const bytes = await makeHelperTemplate(w, h, helper);
      const [emb] = await out.embedPdf(bytes, [0]);
      templates.set(key, emb);
    }
    return templates.get(key);
  }

  async function addHelpers(ref) {
    const { w, h } = pageBox(ref);
    for (let k = 0; k < perInsert; k++) {
      const pg = out.addPage([w, h]);
      if (custom) {
        // Özel sayfayı oranını koruyarak ortala
        const s = Math.min(w / custom.box.w, h / custom.box.h);
        const dw = custom.box.w * s, dh = custom.box.h * s;
        drawRotated(pg, custom.emb, custom.box.rot, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else {
        pg.drawPage(await templateFor(w, h), { x: 0, y: 0, width: w, height: h });
      }
      kinds.push("ek");
    }
  }

  if (insertFirst && n) await addHelpers(src.getPage(0));

  const copied = await out.copyPages(src, [...Array(n).keys()]);
  for (let i = 0; i < n; i++) {
    if (progress) { progress(i, n); if (i % 10 === 0) await tick(); }
    out.addPage(copied[i]);
    kinds.push("ana");
    if (everyN > 0 && (i + 1) % everyN === 0) await addHelpers(src.getPage(i));
  }

  const bytes = await out.save();
  return {
    bytes,
    stats: { srcPages: n, outPages: kinds.length, added: kinds.filter((k) => k === "ek").length, kinds },
  };
}

// ── Kitapçık: imposition algoritması ─────────────────────────

/** 0-bazlı sayfa indeks çiftleri: [sol, sağ] × yüz sayısı. */
export function computePairs(n) {
  const pairs = [];
  for (let i = 0; i < Math.floor(n / 4); i++) {
    pairs.push([n - 2 * i - 1, 2 * i]);        // ön yüz
    pairs.push([2 * i + 1, n - 2 * i - 2]);    // arka yüz
  }
  return pairs;
}

/**
 * "1-12, 15, 20-24" gibi bir metni 0-bazlı sayfa indeks listesine çevirir.
 *   ""/"tümü"/"all" → bütün sayfalar, "5" → tek sayfa, "3-9" → aralık,
 *   "10-"/"10-son" → sona kadar, "-5" → baştan 5'e, "9-3" → ters sıra.
 * Tekrar eden sayfalar bir kez alınır, verilen sıra korunur.
 */
export function parsePageRange(spec, pageCount) {
  spec = (spec || "").trim();
  if (!spec || ["all", "tümü", "tumu", "hepsi", "*"].includes(spec.toLowerCase())) {
    return [...Array(pageCount).keys()];
  }
  spec = spec.replace(/[–—]/g, "-").replace(/;/g, ",").replace(/ to /g, "-");

  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!(p >= 1 && p <= pageCount)) throw new Error(`${p}. sayfa yok (belge ${pageCount} sayfa)`);
    if (!seen.has(p - 1)) { seen.add(p - 1); out.push(p - 1); }
  };
  const toInt = (s, chunk) => {
    if (!/^\d+$/.test(s)) throw new Error(`Anlaşılmayan aralık: '${chunk}'`);
    return parseInt(s, 10);
  };

  for (let chunk of spec.split(",")) {
    chunk = chunk.trim();
    if (!chunk) continue;
    if (chunk.includes("-")) {
      const i = chunk.indexOf("-");
      const a = chunk.slice(0, i).trim();
      const b = chunk.slice(i + 1).trim().toLowerCase();
      const start = a === "" ? 1 : toInt(a, chunk);
      const end = ["", "son", "end", "sonuncu"].includes(b) ? pageCount : toInt(b, chunk);
      const step = end >= start ? 1 : -1;
      for (let p = start; step > 0 ? p <= end : p >= end; p += step) add(p);
    } else {
      if (!/^\d+$/.test(chunk)) throw new Error(`Anlaşılmayan değer: '${chunk}'`);
      add(parseInt(chunk, 10));
    }
  }
  if (!out.length) throw new Error("Hiç sayfa seçilmedi");
  return out;
}

export const FOLD_COLORS = {
  "Sarı": [0.97, 0.79, 0.28],
  "Kırmızı": [0.95, 0.25, 0.25],
  "Mavi": [0.20, 0.55, 0.95],
  "Gri": [0.55, 0.55, 0.55],
  "Siyah": [0.00, 0.00, 0.00],
};

/**
 * Kaynak PDF'in medyan sayfa boyutunu ve yönünü tespit eder.
 * rotateLandscape açıksa yatay sayfalar döndürülecek sayılır ve
 * yuva boyutu (w, h) dikey olarak hesaplanır.
 */
export function detectSourceInfo(doc, pages = null, rotateLandscape = false) {
  const idxs = pages && pages.length ? pages : [...Array(doc.getPageCount()).keys()];
  const ws = [], hs = [];
  for (const i of idxs.slice(0, 10)) {
    const b = pageBox(doc.getPage(i));
    ws.push(b.w); hs.push(b.h);
  }
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const rw = med(ws), rh = med(hs);                 // kaynağın gerçek yönü
  const w = rotateLandscape ? med(ws.map((a, k) => Math.min(a, hs[k]))) : rw;
  const h = rotateLandscape ? med(ws.map((a, k) => Math.max(a, hs[k]))) : rh;
  const isPortrait = rh >= rw;
  let landscape = 0;
  for (const i of idxs) { const b = pageBox(doc.getPage(i)); if (b.w > b.h) landscape++; }
  return {
    w, h, isPortrait, landscape,
    label: `${isPortrait ? "Dikey" : "Yatay"} (${(rw / MM).toFixed(0)}×${(rh / MM).toFixed(0)} mm)`,
  };
}

export async function pdfInfo(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const slot = detectSourceInfo(doc, null, true);
  return { pageCount: doc.getPageCount(), ...detectSourceInfo(doc), slotW: slot.w, slotH: slot.h };
}

export async function makeBooklet(srcBytes, {
  drawFold = true,
  foldColor = [0.97, 0.79, 0.28],
  foldWidth = 0.6,
  foldDashed = true,
  marginInner = 5.0,
  marginOuter = 5.0,
  marginTop = 5.0,
  marginBottom = 5.0,
  gutterMm = 4.0,                       // kat çizgisi her yanında boş alan (mm)
  frontFoldRatio = 14.80 / 29.60,       // ön yüz kat çizgisi oranı
  backFoldRatio = 15.10 / 29.60,        // arka yüz kat çizgisi oranı (0.30cm telafi)
  applyCreep = false,
  paperThick = 0.10,
  pageRange = "",                       // "" = tüm sayfalar, örn. "1-12, 15, 20-24"
  rotateLandscape = true,               // yatay sayfaları dikey yuvaya döndürerek yerleştir
  rotateLeft = true,                    // true: saat yönünün tersine (sola), false: sağa
  maxFaces = null,                      // önizleme için yalnızca ilk N yüz
  progress = null,
} = {}) {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const srcPages = src.getPageCount();

  // Kullanıcının seçtiği sayfalar (0-bazlı gerçek indeksler)
  const sel = parsePageRange(pageRange, srcPages);
  const orig = sel.length;                 // kitapçığa girecek sayfa sayısı
  const pad = (4 - (orig % 4)) % 4;
  const total = orig + pad;
  let pairs = computePairs(total);
  const sheets = pairs.length / 2;
  if (maxFaces != null) pairs = pairs.slice(0, maxFaces);

  const info = detectSourceInfo(src, sel, rotateLandscape);
  const SW = info.w, SH = info.h;
  let rotated = 0;

  const mi = marginInner * MM, mo = marginOuter * MM;
  const mt = marginTop * MM, mb = marginBottom * MM;
  const gt = gutterMm * MM;                // kat çizgisi her yanında boşluk

  // Çıktı sayfa boyutu: iki sayfa yan yana + marjlar + gutter×2
  const PW = SW * 2 + mo * 2 + mi * 2 + gt * 2;
  const PH = SH + mt + mb;
  // Oran bazlı kat çizgisi konumları
  const halfFront = PW * frontFoldRatio;
  const halfBack = PW * backFoldRatio;

  const out = await PDFDocument.create();

  // Yalnızca gerçekten kullanılacak kaynak sayfaları göm
  const needed = [...new Set(pairs.flat().filter((si) => si < orig).map((si) => sel[si]))];
  const embedded = new Map();
  for (const real of needed) {
    const page = src.getPage(real);
    const box = pageBox(page);
    embedded.set(real, { emb: await out.embedPage(page, box.bbox), box });
  }

  const color = toRgb(foldColor);

  for (let idx = 0; idx < pairs.length; idx++) {
    if (progress) { progress(idx, pairs.length); await tick(); }
    const [li, ri] = pairs[idx];
    const pg = out.addPage([PW, PH]);

    let creep = 0;
    if (applyCreep) {
      const sheetNo = Math.floor(idx / 2);
      const innerSheets = Math.floor(total / 4) - 1 - sheetNo;
      creep = Math.max(0, innerSheets) * paperThick * MM;
    }

    // Ön/arka yüz tespiti: 0=ön, 1=arka, 2=ön, 3=arka ...
    const isFront = idx % 2 === 0;
    const half = isFront ? halfFront : halfBack;

    for (const [side, si] of [["L", li], ["R", ri]]) {
      // si → seçim listesindeki sıra; orig'i aşanlar eklenen boş sayfalar
      if (si == null || si >= orig) continue;
      const { emb, box } = embedded.get(sel[si]);
      // Yatay sayfa dikey yuvaya 90° döndürülerek girer → yuvayı doldurur.
      // drawRotated saat yönünde döndürme bekler: sola 90° = sağa 270°.
      const turn = rotateLandscape && box.w > box.h;
      const vw = turn ? box.h : box.w, vh = turn ? box.w : box.h;
      const rot = turn ? (box.rot + (rotateLeft ? 270 : 90)) % 360 : box.rot;
      if (turn) rotated++;

      // Slot sınırları — gutter kat çizgisi yanında boşluk bırakır
      let x0, x1;
      if (side === "L") { x0 = mo + creep; x1 = half - mi - gt; }
      else { x0 = half + mi + gt; x1 = PW - mo - creep; }
      const y0 = mb, y1 = PH - mt;       // pdf-lib: alttan yukarı

      // Best-fit ölçekleme (kırpma yok), slot içinde merkeze al
      const scale = Math.min((x1 - x0) / vw, (y1 - y0) / vh);
      const sw = vw * scale, sh = vh * scale;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      drawRotated(pg, emb, rot, cx - sw / 2, cy - sh / 2, sw, sh);
    }

    // ── Kat / kılavuz çizgisi ──
    if (drawFold) {
      const mx = half;
      if (foldDashed) {
        // Masaüstüyle aynı desen: yukarıdan aşağı 8 pt çizgi / 5 pt boşluk
        let y = 0, on = true;
        while (y < PH) {
          const ny = Math.min(y + (on ? 8 : 5), PH);
          if (on) {
            pg.drawLine({ start: { x: mx, y: PH - y }, end: { x: mx, y: PH - ny }, thickness: foldWidth, color });
          }
          y = ny; on = !on;
        }
      } else {
        pg.drawLine({ start: { x: mx, y: 0 }, end: { x: mx, y: PH }, thickness: foldWidth, color });
      }
    }
  }

  const bytes = await out.save();
  return {
    bytes,
    info: {
      sheets, total, blank: pad, picked: orig, srcPages,
      firstLast: sel.length ? [sel[0] + 1, sel[sel.length - 1] + 1] : [0, 0],
      srcW: SW, srcH: SH, outW: PW, outH: PH,
      orient: info.isPortrait ? "Dikey" : "Yatay",
      srcLabel: info.label,             // kaynağın gerçek yönü ve boyutu
      rotated,
      faces: pairs.length,
    },
  };
}
