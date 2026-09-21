// Llamaditas Theme & Customization Controller
const PRESET_COLORS = [
  { name: 'Cyber Violet', hex: '#8b5cf6', rgb: '139, 92, 246' },
  { name: 'Electric Emerald', hex: '#10b981', rgb: '16, 185, 129' },
  { name: 'Neon Cyan', hex: '#06b6d4', rgb: '6, 182, 212' },
  { name: 'Cyber Amber', hex: '#f59e0b', rgb: '245, 158, 11' },
  { name: 'Rose Quartz', hex: '#f43f5e', rgb: '244, 63, 94' }
];

const DARK_SHADES = [
  { name: '🌑 Obsidiana', bg: '#0a0b10', card: 'rgba(18, 20, 29, 0.85)' },
  { name: '⚫ Oscuro', bg: '#000000', card: 'rgba(16, 16, 16, 0.92)' },
  { name: '🌌 Medianoche', bg: '#0b0f19', card: 'rgba(15, 23, 42, 0.85)' }
];

class ThemeManager {
  constructor() {
    this.currentAccent = localStorage.getItem('llamaditas_accent') || '#8b5cf6';
    this.currentRgb = localStorage.getItem('llamaditas_rgb') || '139, 92, 246';
    this.currentShadeIdx = parseInt(localStorage.getItem('llamaditas_shade_idx') || '0', 10);
    this.applyTheme();
  }

  applyTheme() {
    document.documentElement.style.setProperty('--accent', this.currentAccent);
    document.documentElement.style.setProperty('--accent-rgb', this.currentRgb);

    const shade = DARK_SHADES[this.currentShadeIdx] || DARK_SHADES[0];
    document.documentElement.style.setProperty('--bg-base', shade.bg);
    document.documentElement.style.setProperty('--card-bg', shade.card);

    const shadeBtn = document.getElementById('btn-shade');
    if (shadeBtn) shadeBtn.innerText = shade.name;

    const picker = document.getElementById('customColorPicker');
    if (picker) picker.value = this.currentAccent;
  }

  setAccent(hex, rgb) {
    this.currentAccent = hex;
    this.currentRgb = rgb;
    localStorage.setItem('llamaditas_accent', hex);
    localStorage.setItem('llamaditas_rgb', rgb);
    this.applyTheme();
  }

  setCustomColor(hex) {
    const cleanHex = hex.replace('#', '');
    const r = parseInt(cleanHex.substring(0, 2), 16) || 139;
    const g = parseInt(cleanHex.substring(2, 4), 16) || 92;
    const b = parseInt(cleanHex.substring(4, 6), 16) || 246;
    this.setAccent(hex, `${r}, ${g}, ${b}`);
  }

  cycleDarkShade() {
    this.currentShadeIdx = (this.currentShadeIdx + 1) % DARK_SHADES.length;
    localStorage.setItem('llamaditas_shade_idx', this.currentShadeIdx.toString());
    this.applyTheme();
  }
}

window.themeManager = new ThemeManager();