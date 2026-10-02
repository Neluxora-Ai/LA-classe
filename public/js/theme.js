// Apparence : thème clair/sombre, couleur du site, fond du chat, taille du texte.
// Script classique, chargé dans <head> AVANT l'affichage pour éviter un flash de mauvaise couleur.
// Les réglages sont gardés dans ce navigateur (instantané) et synchronisés sur le compte (voir app.js).
(function () {
  var KEY = 'classe-appearance';
  var DEFAULT = { accent: '#7c5cff', accent2: '#ff5fa2' };
  var THEMES = [
    { id: 'violet', name: 'Violet', a: '#7c5cff', b: '#ff5fa2' },
    { id: 'ocean', name: 'Océan', a: '#2f80ed', b: '#2fc4c4' },
    { id: 'foret', name: 'Forêt', a: '#27ae60', b: '#a8e063' },
    { id: 'sunset', name: 'Coucher de soleil', a: '#ff8a3d', b: '#ff5fa2' },
    { id: 'cerise', name: 'Cerise', a: '#e91e63', b: '#ff8a3d' },
    { id: 'lavande', name: 'Lavande', a: '#b05cff', b: '#3d9bff' },
    { id: 'menthe', name: 'Menthe', a: '#14b8a6', b: '#3d9bff' },
    { id: 'or', name: 'Or', a: '#f5c542', b: '#ff8a3d' },
    { id: 'graphite', name: 'Graphite', a: '#64748b', b: '#94a3b8' },
  ];
  var BGS = [
    { id: 'none', name: 'Aucun' },
    { id: 'aurora', name: 'Aurore' },
    { id: 'dots', name: 'Points' },
    { id: 'grid', name: 'Grille' },
    { id: 'dusk', name: 'Crépuscule' },
    { id: 'mint', name: 'Menthe' },
  ];
  var HEX = /^#[0-9a-fA-F]{6}$/;

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function toHex(r, g, b) {
    return '#' + [r, g, b].map(function (x) { return Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'); }).join('');
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  // 2e couleur du dégradé pour une couleur choisie librement : même teinte décalée de 40°
  function shift(hex, deg) {
    var c = hexToRgb(hex), hsl = rgbToHsl(c[0], c[1], c[2]);
    var o = hslToRgb(hsl[0] + (deg || 40), hsl[1], hsl[2]);
    return toHex(o[0], o[1], o[2]);
  }
  function luminance(hex) {
    var c = hexToRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // Ne garde que des valeurs valides (le serveur refuse le reste)
  function normalize(s) {
    var o = {};
    s = s || {};
    if (['dark', 'light', 'auto'].indexOf(s.theme) >= 0) o.theme = s.theme;
    if (HEX.test(s.accent || '')) o.accent = s.accent.toLowerCase();
    if (HEX.test(s.accent2 || '')) o.accent2 = s.accent2.toLowerCase();
    if (BGS.some(function (b) { return b.id === s.bg; })) o.bg = s.bg;
    if (['s', 'm', 'l'].indexOf(s.font) >= 0) o.font = s.font;
    return o;
  }

  function apply(settings) {
    var s = normalize(settings);
    var root = document.documentElement;
    var theme = s.theme || 'dark';
    var light = theme === 'light' || (theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    root.dataset.theme = light ? 'light' : 'dark';
    var a = s.accent || DEFAULT.accent;
    var b = s.accent2 || (s.accent ? shift(s.accent, 40) : DEFAULT.accent2);
    root.style.setProperty('--accent-2', a);
    root.style.setProperty('--accent', b);
    var lum = (luminance(a) + luminance(b)) / 2;
    root.style.setProperty('--on-accent', lum > 0.42 ? '#1c1a2b' : '#ffffff');
    root.dataset.chatbg = s.bg || 'none';
    root.dataset.font = s.font || 'm';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#f4f2fb' : '#15131f');
    current = s;
  }

  var current = {};
  function load() {
    try {
      return normalize(JSON.parse(localStorage.getItem(KEY)));
    } catch (e) {
      return {};
    }
  }
  function save(settings) {
    try {
      localStorage.setItem(KEY, JSON.stringify(normalize(settings)));
    } catch (e) {}
  }

  window.ClasseTheme = { THEMES: THEMES, BGS: BGS, apply: apply, load: load, save: save, normalize: normalize, shift: shift };
  apply(load());
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: light)');
    var onChange = function () { if (current.theme === 'auto') apply(current); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
})();
