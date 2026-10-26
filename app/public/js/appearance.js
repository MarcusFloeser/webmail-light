// Darstellung: eigene Hintergrundfarbe und Hintergrundbild.
// Gespeichert in user.settings.appearance = { color: '#rrggbb'|null, image: { v, lum }|null, veil: 0–90 }
// Die Schriftfarbe auf dem Hintergrund (Ordnerleiste, Terminspalte …) wird automatisch hell oder dunkel gewählt.

const DEFAULT_LIGHT = '#f6f7f9';
const DEFAULT_DARK = '#16181d';
export const DEFAULT_VEIL = 35;

const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let current = null;

export const PRESETS = [
  [null, 'Standard'],
  ['#ffffff', 'Weiss'],
  ['#e8edf5', 'Nebel'],
  ['#e1ecf7', 'Himmel'],
  ['#e3ece4', 'Salbei'],
  ['#efe9df', 'Sand'],
  ['#f6e4e6', 'Rosé'],
  ['#ebe6f4', 'Lavendel'],
  ['#2b5876', 'Petrol'],
  ['#3a4a3f', 'Wald'],
  ['#1e2433', 'Nacht'],
];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t); // t = Anteil von b

/** Relative Helligkeit (WCAG), 0 = schwarz, 1 = weiss */
export function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Hat weisse Schrift auf dieser Helligkeit mehr Kontrast als dunkle? (WCAG) */
function prefersWhite(L, bias) {
  const contrastWhite = 1.05 / (L + 0.05);
  const contrastDark = (L + 0.05) / (0.0144 + 0.05);
  return contrastWhite * (bias ? 1.15 : 1) >= contrastDark;
}

/** Umkehrung der sRGB-Gammakurve: relative Helligkeit → sRGB-Wert 0–1 */
function lumToSrgb(l) {
  return l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
}

export function isValidColor(hex) { return !!hexToRgb(hex); }

export function normalize(a) {
  a = a || {};
  const veil = Number.isFinite(Number(a.veil)) ? Math.max(0, Math.min(90, Number(a.veil))) : DEFAULT_VEIL;
  return {
    color: isValidColor(a.color) ? String(a.color).toLowerCase() : null,
    image: a.image && a.image.v ? { v: a.image.v, lum: Number.isFinite(Number(a.image.lum)) ? Number(a.image.lum) : 0.5 } : null,
    veil,
    listGlass: a.listGlass !== false,
    theme: ['light', 'dark'].includes(a.theme) ? a.theme : 'auto',
  };
}

/** Darstellung anwenden (auch für die Live-Vorschau in den Einstellungen). */
export function apply(appearance) {
  current = normalize(appearance);
  const root = document.documentElement;
  // Farbschema: automatisch (System) oder fest hell/dunkel
  root.classList.toggle('theme-light', current.theme === 'light');
  root.classList.toggle('theme-dark', current.theme === 'dark');
  const dark = current.theme === 'dark' || (current.theme === 'auto' && !!(darkQuery && darkQuery.matches));
  updateThemeColor(dark);
  const { color, image, veil } = current;
  const custom = !!(color || image);
  root.classList.toggle('bgx', custom);
  root.classList.toggle('bgx-image', !!image);
  if (!custom) {
    for (const p of ['--bg', '--bg-solid', '--bg-image', '--surface']) root.style.removeProperty(p);
    root.classList.remove('bgx-dark', 'bgx-light', 'bgx-sdark', 'bgx-slight', 'content-light');
    return;
  }
  // Grundfarbe; im dunklen Farbschema wird eine helle Wahl stark abgedunkelt
  let base = hexToRgb(color || (dark ? DEFAULT_DARK : DEFAULT_LIGHT));

  let solid = base;
  if (image) {
    const t = veil / 100; // Anteil der Farbe über dem Bild
    // Bild als Grauwert gleicher Helligkeit, Überlagerung wie im Browser (im sRGB-Raum gemischt)
    const gray = 255 * lumToSrgb(image.lum);
    solid = mix([gray, gray, gray], base, t);
    root.style.setProperty('--bg', `rgba(${base.map(Math.round).join(', ')}, ${t.toFixed(2)})`);
    root.style.setProperty('--bg-image', `url("/api/me/background?v=${encodeURIComponent(image.v)}")`);
  } else {
    root.style.setProperty('--bg', rgbToHex(base));
    root.style.removeProperty('--bg-image');
  }
  root.style.setProperty('--bg-solid', rgbToHex(solid));
  // Mail-Liste, Kontakte, Kalender: in der gewählten Farbe (leicht zur Flächenfarbe hin aufgehellt
  // bzw. abgedunkelt, damit sie sich von der Ordnerleiste abheben); mit Bild halbtransparent
  const panelRgb = luminance(base) > 0.3 ? [255, 255, 255] : [29, 32, 38];
  const surface = mix(base, panelRgb, color ? 0.1 : 0.5);
  let surfaceSeen = surface;
  if (image) {
    surfaceSeen = mix(solid, surface, 0.8);
    root.style.setProperty('--surface', `rgba(${surface.map(Math.round).join(', ')}, 0.8)`);
  } else {
    root.style.setProperty('--surface', rgbToHex(surface));
  }
  const sDark = prefersWhite(luminance(surfaceSeen), false);
  root.classList.toggle('bgx-sdark', current.listGlass && sDark);
  root.classList.toggle('bgx-slight', current.listGlass && !sDark);
  // Weisse oder dunkle Schrift – je nachdem, was mehr Kontrast hat (WCAG); leichte Bevorzugung
  // von Weiss, weil Schrift auf Bildern zusätzlich einen Schatten bekommt
  const darkBg = prefersWhite(luminance(solid), !!image);
  // Dunkles Farbschema + helle eigene Farbe: Inhalte hell, nur die Kopfleiste dunkel
  root.classList.toggle('content-light', dark && !!color && !prefersWhite(luminance(base), false));
  root.classList.toggle('bgx-dark', darkBg);
  root.classList.toggle('bgx-light', !darkBg);
}

function updateThemeColor(dark) {
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    if (current.theme === 'auto') m.setAttribute('content', /dark/.test(m.getAttribute('media') || '') ? DEFAULT_DARK : DEFAULT_LIGHT);
    else m.setAttribute('content', dark ? DEFAULT_DARK : DEFAULT_LIGHT);
  }
}

export function applyFromUser(user) {
  apply(user && user.settings ? user.settings.appearance : null);
}

export function reset() { apply(null); }

if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => { if (current) apply(current); });

/**
 * Bilddatei für den Hintergrund aufbereiten: verkleinern (max. 2560 px), als JPEG kodieren,
 * mittlere Helligkeit bestimmen. → { dataUrl, luminance }
 */
export function prepareImage(file, maxSide = 2560) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('Bitte eine Bilddatei wählen')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = hgt;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, hgt);
        ctx.drawImage(img, 0, 0, w, hgt);
        // Helligkeit an einer 24×24-Miniatur messen
        const s = document.createElement('canvas');
        s.width = 24; s.height = 24;
        const sctx = s.getContext('2d');
        sctx.drawImage(c, 0, 0, 24, 24);
        const px = sctx.getImageData(0, 0, 24, 24).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += luminance([px[i], px[i + 1], px[i + 2]]);
        let q = 0.85;
        let dataUrl = c.toDataURL('image/jpeg', q);
        while (dataUrl.length > 4.5 * 1048576 && q > 0.5) { q -= 0.1; dataUrl = c.toDataURL('image/jpeg', q); }
        resolve({ dataUrl, luminance: sum / (px.length / 4), width: w, height: hgt });
      } catch (err) { reject(err); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Das Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}
