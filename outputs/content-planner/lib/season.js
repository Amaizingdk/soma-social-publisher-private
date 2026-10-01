'use strict';

const SEASONS = new Set(['spring', 'summer', 'autumn', 'winter']);

const THEMES = {
  spring: {
    eyebrow: 'NY ENERGI I VARMEN',
    accent: '#d8c991',
    shade: 'linear-gradient(180deg,rgba(13,24,19,.10) 0%,rgba(12,24,18,.04) 42%,rgba(12,19,15,.86) 100%)',
  },
  summer: {
    eyebrow: 'ET PUSTERUM I VARMEN',
    accent: '#f3d28f',
    shade: 'linear-gradient(180deg,rgba(20,15,8,.08) 0%,rgba(20,15,8,.02) 42%,rgba(18,12,7,.82) 100%)',
  },
  autumn: {
    eyebrow: 'ET PUSTERUM I VARMEN',
    accent: '#f2c881',
    shade: 'linear-gradient(180deg,rgba(11,7,5,.18) 0%,rgba(11,7,5,.08) 42%,rgba(11,7,5,.90) 100%)',
  },
  winter: {
    eyebrow: 'KOM IND I VARMEN',
    accent: '#e4b66d',
    shade: 'linear-gradient(180deg,rgba(8,15,23,.30) 0%,rgba(8,14,22,.12) 42%,rgba(6,10,16,.94) 100%)',
  },
};

function resolveSeason(date, config = { mode: 'auto', winterStarts: '11-01' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Ugyldig dato til sæson: ${date}`);
  const mode = config.mode || 'auto';
  if (mode !== 'auto') {
    if (!SEASONS.has(mode)) throw new Error(`Ukendt sæson: ${mode}`);
    return mode;
  }
  const monthDay = date.slice(5);
  const month = Number(date.slice(5, 7));
  const winterStarts = config.winterStarts || '11-01';
  if (monthDay >= winterStarts || month <= 2) return 'winter';
  if (month <= 5) return 'spring';
  if (month <= 8) return 'summer';
  return 'autumn';
}

function themeForSeason(season) {
  if (!SEASONS.has(season)) throw new Error(`Ukendt sæson: ${season}`);
  return THEMES[season];
}

module.exports = { resolveSeason, themeForSeason };
