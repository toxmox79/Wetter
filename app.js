'use strict';

const DEFAULT_LOCATION = { name: 'Bad Windsheim', latitude: 49.5027, longitude: 10.4154, timezone: 'Europe/Berlin' };
const state = {
  location: JSON.parse(localStorage.getItem('wg-location') || 'null') || DEFAULT_LOCATION,
  weather: null,
  ensemble: null,
  pollen: null,
  iconD2: null,
  map: null,
  radarBaseLayer: null,
  locationMarker: null,
  radarFrames: [],
  radarLayers: [],
  radarLayerMode: null,
  radarIndex: 0,
  radarTimer: null,
  radarPlaying: true,
  deferredInstallPrompt: null,
  forecastFallback: false,
  favorites: (() => {
    try { return JSON.parse(localStorage.getItem('wg-favorites') || '[]'); }
    catch { return []; }
  })()
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const round = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : '–';
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const localeDate = (iso, options = {}) => new Intl.DateTimeFormat('de-DE', options).format(new Date(`${iso}T12:00:00`));
const weekday = iso => localeDate(iso, { weekday: 'short' }).replace('.', '');
const monthDay = iso => localeDate(iso, { day: '2-digit', month: '2-digit' });
const hourLabel = iso => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const locationKey = location => `${Number(location.latitude).toFixed(4)},${Number(location.longitude).toFixed(4)}`;
const isCurrentFavorite = () => state.favorites.some(item => locationKey(item) === locationKey(state.location));

function saveFavorites() {
  localStorage.setItem('wg-favorites', JSON.stringify(state.favorites));
  renderFavorites();
  updateFavoriteButton();
}

function updateFavoriteButton() {
  const button = $('#favorite-toggle');
  if (!button) return;
  const active = isCurrentFavorite();
  button.innerHTML = active
    ? '<span>★</span><strong>Gespeichert</strong><small>entfernen</small>'
    : '<span>☆</span><strong>Favorit</strong><small>speichern</small>';
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? 'Ort aus Favoriten entfernen' : 'Ort zu Favoriten hinzufügen');
  button.title = active ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen';
}

function updateLocationPanelTitle() {
  const title = $('#location-panel-title');
  if (title) title.textContent = currentLocationText();
}

function renderFavorites() {
  const bar = $('#favorites-bar');
  const list = $('#favorites-list');
  if (!bar || !list) return;
  bar.hidden = false;
  if (!state.favorites.length) {
    list.innerHTML = '<div class="favorites-empty">Noch keine Favoriten gespeichert.</div>';
    return;
  }
  const currentKey = locationKey(state.location);
  list.innerHTML = state.favorites.map(item => {
    const key = locationKey(item);
    const label = [item.name, item.admin1].filter(Boolean).join(', ');
    return `<div class="favorite-chip ${key === currentKey ? 'current' : ''}" data-key="${key}">
      <button type="button" class="favorite-select" data-favorite-key="${key}" aria-label="${escapeHtml(label)} öffnen"><strong>${escapeHtml(item.name)}</strong>${item.admin1 ? `<small>${escapeHtml(item.admin1)}</small>` : ''}</button>
      <button type="button" class="favorite-remove" data-remove-key="${key}" aria-label="${escapeHtml(label)} aus Favoriten entfernen">×</button>
    </div>`;
  }).join('');
}

function toggleCurrentFavorite() {
  const key = locationKey(state.location);
  const index = state.favorites.findIndex(item => locationKey(item) === key);
  if (index >= 0) {
    const [removed] = state.favorites.splice(index, 1);
    toast(`${removed.name} aus Favoriten entfernt`);
  } else {
    if (state.favorites.length >= 12) return toast('Es können höchstens 12 Orte gespeichert werden');
    state.favorites.push({ ...state.location });
    toast(`${state.location.name} als Favorit gespeichert`);
  }
  saveFavorites();
}

const WEATHER_CODES = {
  0: ['Klar', '☀️'], 1: ['Überwiegend klar', '🌤️'], 2: ['Teilweise bewölkt', '⛅'], 3: ['Bewölkt', '☁️'],
  45: ['Nebel', '🌫️'], 48: ['Reifnebel', '🌫️'], 51: ['Leichter Nieselregen', '🌦️'], 53: ['Nieselregen', '🌦️'],
  55: ['Starker Nieselregen', '🌧️'], 56: ['Gefrierender Nieselregen', '🌧️'], 57: ['Starker gefrierender Nieselregen', '🌧️'],
  61: ['Leichter Regen', '🌦️'], 63: ['Regen', '🌧️'], 65: ['Starker Regen', '🌧️'], 66: ['Gefrierender Regen', '🌧️'],
  67: ['Starker gefrierender Regen', '🌧️'], 71: ['Leichter Schneefall', '🌨️'], 73: ['Schneefall', '🌨️'],
  75: ['Starker Schneefall', '❄️'], 77: ['Schneegriesel', '❄️'], 80: ['Leichte Regenschauer', '🌦️'],
  81: ['Regenschauer', '🌧️'], 82: ['Starke Regenschauer', '⛈️'], 85: ['Schneeschauer', '🌨️'],
  86: ['Starke Schneeschauer', '❄️'], 95: ['Gewitter', '⛈️'], 96: ['Gewitter mit Hagel', '⛈️'], 99: ['Starkes Gewitter mit Hagel', '⛈️']
};

const weatherInfo = code => WEATHER_CODES[Math.round(Number(code))] || ['Unbeständig', '🌥️'];

const isFogIcon = icon => String(icon).replace(/\uFE0F/g, '') === '\u{1F32B}';
const weatherIconHtml = (icon, label = 'Wetter') => isFogIcon(icon)
  ? `<span class="weather-symbol weather-symbol-fog" role="img" aria-label="${escapeHtml(label)}"><i></i><i></i><i></i></span>`
  : `<span class="weather-symbol" role="img" aria-label="${escapeHtml(label)}">${escapeHtml(icon)}</span>`;

const pad2 = value => String(value).padStart(2, '0');
const formatShortHour = hour => `${pad2(hour)}:00`;
const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const formatHours = seconds => {
  const h = safeNumber(seconds) / 3600;
  if (h <= 0) return '0 h';
  return `${(Math.round(h * 10) / 10).toString().replace('.', ',')} h`;
};
const formatMinutes = seconds => `${Math.round(safeNumber(seconds) / 60)} min`;

function currentLocationDateHour() {
  const currentTime = state.weather?.current?.time;
  const fallback = currentTime?.length >= 13
    ? { date: currentTime.slice(0, 10), hour: Number(currentTime.slice(11, 13)) }
    : { date: new Date().toISOString().slice(0, 10), hour: new Date().getHours() };
  const timezone = state.weather?.timezone || state.location.timezone;
  if (!timezone) return fallback;

  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date()).map(part => [part.type, part.value]));
    const hour = Number(parts.hour);
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number.isFinite(hour) ? hour : fallback.hour
    };
  } catch {
    return fallback;
  }
}

function indicesForDate(date) {
  return (state.weather?.hourly?.time || []).map((time, i) => time.slice(0, 10) === date ? i : -1).filter(i => i >= 0);
}
function representativeCode(indices) {
  const hourlyCodes = state.weather?.hourly?.weather_code || [];
  const counts = new Map();
  indices.forEach(i => {
    const code = Math.round(Number(hourlyCodes[i] ?? 0));
    counts.set(code, (counts.get(code) || 0) + 1);
  });
  if (!counts.size) return 0;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
function pickHourIndex(date, hour) {
  const hourlyTimes = state.weather?.hourly?.time || [];
  const key = `${date}T${pad2(hour)}:00`;
  let index = hourlyTimes.findIndex(time => time.startsWith(key));
  if (index >= 0) return index;
  const dateIndices = indicesForDate(date);
  if (!dateIndices.length) return 0;
  return dateIndices.reduce((best, idx) => {
    const currentHour = Number(hourlyTimes[idx].slice(11, 13));
    const bestHour = Number(hourlyTimes[best].slice(11, 13));
    return Math.abs(currentHour - hour) < Math.abs(bestHour - hour) ? idx : best;
  }, dateIndices[0]);
}

function scrollDayDialogToStartHour(date, index) {
  const dialog = $('#day-dialog');
  const table = $('#day-hourly-table');
  if (!dialog || !table) return;

  const now = currentLocationDateHour();
  const targetHour = date === now.date || index === 0 ? now.hour : 7;
  const rows = [...table.querySelectorAll('.day-hour-row')];
  const target = rows.find(row => Number(row.dataset.hour) === targetHour) ||
    rows.find(row => Number(row.dataset.hour) > targetHour) ||
    rows.at(-1);
  if (!target) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const inset = window.matchMedia('(max-width: 900px)').matches ? 70 : 18;
      const dialogTop = dialog.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      dialog.scrollBy({ top: targetTop - dialogTop - inset, behavior: 'auto' });
    });
  });
}

function segmentIndices(date, startHour, endHour) {
  return indicesForDate(date).filter(i => {
    const hour = Number(state.weather.hourly.time[i].slice(11, 13));
    return hour >= startHour && hour < endHour;
  });
}
function describeSegment(date, label, startHour, endHour, fallbackTemp) {
  const indices = segmentIndices(date, startHour, endHour);
  const hourly = state.weather.hourly;
  const temps = indices.map(i => safeNumber(hourly.temperature_2m[i]));
  const probs = indices.map(i => safeNumber(hourly.precipitation_probability[i]));
  const precipitation = indices.reduce((sum, i) => sum + safeNumber(hourly.precipitation[i]), 0);
  const wind = indices.map(i => safeNumber(hourly.wind_speed_10m[i]));
  const [condition, icon] = weatherInfo(representativeCode(indices));
  const maxTemp = temps.length ? Math.max(...temps) : safeNumber(fallbackTemp);
  const minTemp = temps.length ? Math.min(...temps) : safeNumber(fallbackTemp);
  return {
    label,
    icon,
    condition,
    temp: startHour < 6 || startHour >= 18 ? minTemp : maxTemp,
    tempAlt: startHour < 6 || startHour >= 18 ? maxTemp : minTemp,
    precipProbability: probs.length ? Math.max(...probs) : 0,
    precipitation,
    wind: wind.length ? Math.round(wind.reduce((a, b) => a + b, 0) / wind.length) : 0
  };
}

const POLLEN = [
  { key: 'alder_pollen', name: 'Erle', icon: '🌳', thresholds: [1, 10, 50] },
  { key: 'birch_pollen', name: 'Birke', icon: '🌳', thresholds: [1, 10, 50] },
  { key: 'grass_pollen', name: 'Gräser', icon: '🌾', thresholds: [1, 5, 20] },
  { key: 'mugwort_pollen', name: 'Beifuß', icon: '🌿', thresholds: [1, 5, 15] },
  { key: 'ragweed_pollen', name: 'Ambrosia', icon: '🍃', thresholds: [1, 5, 15] },
  { key: 'olive_pollen', name: 'Olive', icon: '🫒', thresholds: [1, 10, 50] }
];

const LEGACY_PLANTS = [
  { name:'Tomate', icon:'🍅', indoor:[2,3,4], sow:[5,6], harvest:[7,8,9,10], notes:'Warm vorziehen; erst nach den Eisheiligen ins Freie.' },
  { name:'Paprika', icon:'🫑', indoor:[1,2,3], sow:[5,6], harvest:[7,8,9,10], notes:'Lange Kulturzeit, warmer und geschützter Standort.' },
  { name:'Chili', icon:'🌶️', indoor:[1,2,3], sow:[5,6], harvest:[7,8,9,10], notes:'Sehr früh vorziehen; gleichmäßige Wärme bevorzugt.' },
  { name:'Gurke', icon:'🥒', indoor:[4,5], sow:[5,6,7], harvest:[7,8,9], notes:'Frostempfindlich und nährstoffhungrig.' },
  { name:'Zucchini', icon:'🥒', indoor:[4,5], sow:[5,6], harvest:[6,7,8,9,10], notes:'Regelmäßig jung ernten fördert neue Früchte.' },
  { name:'Kürbis', icon:'🎃', indoor:[4,5], sow:[5,6], harvest:[9,10], notes:'Viel Platz und nährstoffreicher Boden.' },
  { name:'Kopfsalat', icon:'🥬', indoor:[2,3,4], sow:[3,4,5,6,7,8], harvest:[5,6,7,8,9,10], notes:'Für laufende Ernte alle zwei bis drei Wochen nachsäen.' },
  { name:'Feldsalat', icon:'🥬', indoor:[], sow:[7,8,9,10], harvest:[9,10,11,12,1,2,3], notes:'Ideal als Herbst- und Winterkultur.' },
  { name:'Radieschen', icon:'🔴', indoor:[], sow:[3,4,5,6,7,8,9], harvest:[4,5,6,7,8,9,10], notes:'Schnelle Kultur; bei Hitze schossgefährdet.' },
  { name:'Möhre', icon:'🥕', indoor:[], sow:[3,4,5,6,7], harvest:[6,7,8,9,10,11], notes:'Boden tief lockern; Saat gleichmäßig feucht halten.' },
  { name:'Rote Bete', icon:'🟣', indoor:[], sow:[4,5,6,7], harvest:[7,8,9,10,11], notes:'Junge Blätter sind ebenfalls essbar.' },
  { name:'Kohlrabi', icon:'🟢', indoor:[2,3,4], sow:[4,5,6,7,8], harvest:[5,6,7,8,9,10], notes:'Regelmäßig gießen, damit die Knollen nicht holzig werden.' },
  { name:'Brokkoli', icon:'🥦', indoor:[2,3,4,5], sow:[4,5,6,7], harvest:[6,7,8,9,10], notes:'Nach der Haupternte treiben oft kleinere Seitentriebe nach.' },
  { name:'Blumenkohl', icon:'🥦', indoor:[2,3,4,5], sow:[4,5,6], harvest:[6,7,8,9,10], notes:'Benötigt gleichmäßige Wasser- und Nährstoffversorgung.' },
  { name:'Weißkohl', icon:'🥬', indoor:[2,3,4], sow:[4,5,6], harvest:[7,8,9,10,11], notes:'Kulturschutznetz hilft gegen Kohlweißling.' },
  { name:'Lauch', icon:'🌱', indoor:[1,2,3], sow:[3,4,5], harvest:[7,8,9,10,11,12,1,2], notes:'Tief pflanzen oder später anhäufeln für lange weiße Schäfte.' },
  { name:'Zwiebel', icon:'🧅', indoor:[], sow:[3,4], harvest:[7,8,9], notes:'Ernten, wenn das Laub deutlich umknickt und eintrocknet.' },
  { name:'Knoblauch', icon:'🧄', indoor:[], sow:[10,11,2,3], harvest:[6,7,8], notes:'Herbstpflanzung liefert meist größere Knollen.' },
  { name:'Erbse', icon:'🫛', indoor:[], sow:[2,3,4,5,6], harvest:[5,6,7,8], notes:'Verträgt kühle Temperaturen und braucht eine Rankhilfe.' },
  { name:'Buschbohne', icon:'🫘', indoor:[], sow:[5,6,7], harvest:[7,8,9,10], notes:'Erst in ausreichend warmen Boden säen.' },
  { name:'Spinat', icon:'🍃', indoor:[], sow:[2,3,4,8,9,10], harvest:[4,5,6,9,10,11,12], notes:'Frühjahr und Herbst sind besser als Hochsommer.' },
  { name:'Mangold', icon:'🌿', indoor:[3,4], sow:[4,5,6,7], harvest:[6,7,8,9,10,11], notes:'Äußere Blätter fortlaufend ernten.' },
  { name:'Kartoffel', icon:'🥔', indoor:[], sow:[3,4,5], harvest:[6,7,8,9,10], notes:'Vorkeimen beschleunigt den Start; regelmäßig anhäufeln.' },
  { name:'Petersilie', icon:'🌿', indoor:[2,3], sow:[3,4,5,6,7,8], harvest:[5,6,7,8,9,10,11], notes:'Keimt langsam; Saatbett mehrere Wochen feucht halten.' },
  { name:'Basilikum', icon:'🌿', indoor:[3,4,5], sow:[5,6,7], harvest:[6,7,8,9], notes:'Wärmeliebend, Spitzen regelmäßig schneiden.' },
  { name:'Dill', icon:'🌿', indoor:[], sow:[4,5,6,7,8], harvest:[6,7,8,9,10], notes:'Direktsaat bevorzugt, da Dill ungern verpflanzt wird.' }
];

const gardenTask = (type, months, label, note = '') => ({ type, months, label, note });
const gt = gardenTask;

const GARDEN_CATEGORIES = [
  { id:'all', label:'Alles', icon:'☘️' },
  { id:'vegetable', label:'Gemüse', icon:'🥕' },
  { id:'fruit', label:'Obst', icon:'🍎' },
  { id:'herb', label:'Kräuter', icon:'🌿' },
  { id:'mushroom', label:'Pilze & Kostbares', icon:'🍄' },
  { id:'flower', label:'Blumen', icon:'🌸' },
  { id:'trees', label:'Gehölze', icon:'🌳' },
  { id:'lawn', label:'Rasen', icon:'🌱' },
  { id:'soil', label:'Boden', icon:'🪱' },
  { id:'greenhouse', label:'Gewächshaus', icon:'🏡' },
  { id:'balcony', label:'Balkon', icon:'🪴' }
];

const GARDEN_TASK_TYPES = {
  indoor:{ label:'Vorkultur', cls:'indoor' },
  sow:{ label:'Aussaat', cls:'sow' },
  plant:{ label:'Pflanzen', cls:'plant' },
  care:{ label:'Pflege', cls:'care' },
  prune:{ label:'Schnitt', cls:'prune' },
  fertilize:{ label:'Düngen', cls:'fertilize' },
  protect:{ label:'Schützen', cls:'protect' },
  harvest:{ label:'Ernte', cls:'harvest' },
  find:{ label:'Fundzeit', cls:'find' },
  prepare:{ label:'Vorbereiten', cls:'prepare' }
};

const TASK_SORT = ['protect', 'prune', 'care', 'sow', 'plant', 'indoor', 'fertilize', 'harvest', 'find', 'prepare'];
const HERB_NAMES = new Set(['Petersilie', 'Basilikum', 'Dill']);

function legacyPlantToGardenItem(plant) {
  const tasks = [
    ...(plant.indoor || []).length ? [gt('indoor', plant.indoor, 'Vorziehen')] : [],
    ...(plant.sow || []).length ? [gt('sow', plant.sow, 'Aussäen oder pflanzen')] : [],
    ...(plant.harvest || []).length ? [gt('harvest', plant.harvest, 'Ernten')] : []
  ];
  return {
    name:plant.name,
    icon:plant.icon,
    category:HERB_NAMES.has(plant.name) ? 'herb' : 'vegetable',
    tasks,
    notes:plant.notes
  };
}

const EXTRA_GARDEN_ITEMS = [
  { name:'Pastinake', icon:'🥕', category:'vegetable', tasks:[gt('sow',[3,4,5],'Direktsaat'), gt('care',[5,6,7,8],'Vereinzeln'), gt('harvest',[10,11,12,1,2],'Nach Frost ernten')], notes:'Lange Kulturzeit, dafür sehr winterhart.' },
  { name:'Rotkohl', icon:'🥬', category:'vegetable', tasks:[gt('indoor',[2,3,4],'Vorziehen'), gt('plant',[4,5,6],'Pflanzen'), gt('care',[6,7,8,9],'Kohlweißling prüfen'), gt('harvest',[9,10,11],'Köpfe ernten')], notes:'Braucht lange Standzeit und gleichmäßige Nährstoffe.' },
  { name:'Grünkohl', icon:'🥬', category:'vegetable', tasks:[gt('indoor',[4,5],'Vorziehen'), gt('plant',[5,6,7],'Pflanzen'), gt('care',[7,8,9],'Raupen kontrollieren'), gt('harvest',[10,11,12,1,2],'Blätter ernten')], notes:'Robuste Winterkultur; Frost verbessert oft den Geschmack.' },
  { name:'Stangenbohne', icon:'🫘', category:'vegetable', tasks:[gt('sow',[5,6,7],'An Rankhilfe säen'), gt('care',[6,7,8],'Leiten & gießen'), gt('harvest',[7,8,9,10],'Hülsen ernten')], notes:'Braucht stabile Stangen und regelmäßige Ernte.' },
  { name:'Mais', icon:'🌽', category:'vegetable', tasks:[gt('indoor',[4],'Vorziehen'), gt('sow',[5,6],'Direktsaat'), gt('care',[6,7,8],'Blockpflanzung prüfen'), gt('harvest',[8,9,10],'Kolben ernten')], notes:'In Gruppen pflanzen, damit die Bestäubung klappt.' },
  { name:'Sellerie', icon:'🌱', category:'vegetable', tasks:[gt('indoor',[2,3],'Vorziehen'), gt('plant',[5,6],'Pflanzen'), gt('care',[6,7,8,9],'Viel Wasser & Nahrung'), gt('harvest',[9,10,11],'Knollen ernten')], notes:'Nie austrocknen lassen, sonst bleiben Knollen klein.' },
  { name:'Fenchel', icon:'🌱', category:'vegetable', tasks:[gt('sow',[4,5,6,7,8],'Satzweise säen'), gt('care',[6,7,8,9],'Anhäufeln'), gt('harvest',[7,8,9,10],'Knollen schneiden')], notes:'Bei Hitze schnell schossgefährdet.' },
  { name:'Pak Choi', icon:'🥬', category:'vegetable', tasks:[gt('sow',[4,5,6,7,8,9],'Aussaat'), gt('care',[5,6,7,8,9],'Erdflöhe kontrollieren'), gt('harvest',[6,7,8,9,10],'Rosetten ernten')], notes:'Schnellwüchsig; für Herbst oft besonders gut.' },
  { name:'Rucola', icon:'🌿', category:'vegetable', tasks:[gt('sow',[3,4,5,6,7,8,9],'Nachsäen'), gt('care',[5,6,7,8],'Schattieren bei Hitze'), gt('harvest',[4,5,6,7,8,9,10],'Blätter schneiden')], notes:'Nach Schnitt treibt Rucola oft wieder aus.' },
  { name:'Schnittlauch', icon:'🌿', category:'herb', tasks:[gt('sow',[3,4,5],'Säen oder teilen'), gt('care',[5,6,7,8],'Blüten entfernen'), gt('harvest',[4,5,6,7,8,9,10],'Halme schneiden')], notes:'Nach der Blüte kräftig zurückschneiden.' },
  { name:'Koriander', icon:'🌿', category:'herb', tasks:[gt('sow',[4,5,6,7,8,9],'Satzweise säen'), gt('harvest',[5,6,7,8,9,10],'Blätter/Samen ernten')], notes:'Schießt bei Hitze schnell; halbschattig säen.' },
  { name:'Thymian', icon:'🌿', category:'herb', tasks:[gt('plant',[4,5,6],'Pflanzen'), gt('prune',[4,5,8,9],'Leicht zurückschneiden'), gt('harvest',[5,6,7,8,9],'Triebe ernten')], notes:'Mager, sonnig und eher trocken halten.' },
  { name:'Rosmarin', icon:'🌿', category:'herb', tasks:[gt('plant',[4,5,6],'Pflanzen'), gt('prune',[4,5,8],'Formschnitt'), gt('protect',[11,12,1,2],'Winterschutz'), gt('harvest',[5,6,7,8,9,10],'Triebe schneiden')], notes:'Im Topf vor starkem Frost schützen.' },
  { name:'Salbei', icon:'🌿', category:'herb', tasks:[gt('plant',[4,5,6],'Pflanzen'), gt('prune',[4,5,8],'Nach Blüte schneiden'), gt('harvest',[5,6,7,8,9],'Blätter ernten')], notes:'Nicht ins alte Holz schneiden.' },
  { name:'Minze', icon:'🌿', category:'herb', tasks:[gt('plant',[3,4,5,9],'Teilen/Pflanzen'), gt('care',[5,6,7,8],'Ausläufer begrenzen'), gt('harvest',[5,6,7,8,9,10],'Triebe ernten')], notes:'Am besten mit Wurzelsperre oder im Topf kultivieren.' },
  { name:'Oregano', icon:'🌿', category:'herb', tasks:[gt('plant',[4,5,6],'Pflanzen'), gt('prune',[7,8,9],'Nach Blüte schneiden'), gt('harvest',[6,7,8,9],'Triebe trocknen')], notes:'Kurz vor der Blüte ist das Aroma besonders stark.' },
  { name:'Erdbeere', icon:'🍓', category:'fruit', tasks:[gt('plant',[3,4,8,9],'Pflanzen'), gt('care',[5,6,7],'Stroh unterlegen'), gt('prune',[7,8],'Alte Blätter schneiden'), gt('harvest',[5,6,7],'Beeren ernten')], notes:'Ausläufer nur behalten, wenn neue Pflanzen gewünscht sind.' },
  { name:'Himbeere', icon:'🍓', category:'fruit', tasks:[gt('plant',[3,4,10,11],'Pflanzen'), gt('prune',[2,3,8,9,10],'Ruten schneiden'), gt('care',[5,6,7],'Mulchen'), gt('harvest',[6,7,8,9,10],'Beeren pflücken')], notes:'Sommer- und Herbsthimbeeren unterschiedlich schneiden.' },
  { name:'Brombeere', icon:'🫐', category:'fruit', tasks:[gt('plant',[3,4,10,11],'Pflanzen'), gt('prune',[2,3,8,9],'Abgetragene Ruten schneiden'), gt('care',[5,6,7],'Ruten anbinden'), gt('harvest',[7,8,9,10],'Beeren pflücken')], notes:'Neue und tragende Ruten getrennt leiten.' },
  { name:'Johannisbeere', icon:'🍇', category:'fruit', tasks:[gt('plant',[3,4,10,11],'Pflanzen'), gt('prune',[2,3,7,8],'Auslichten'), gt('harvest',[6,7,8],'Trauben pflücken')], notes:'Alte Triebe bodennah entfernen, damit junges Holz nachkommt.' },
  { name:'Stachelbeere', icon:'🫐', category:'fruit', tasks:[gt('plant',[3,4,10,11],'Pflanzen'), gt('prune',[2,3,7,8],'Auslichten'), gt('harvest',[6,7,8],'Beeren ernten')], notes:'Luftiger Aufbau hilft gegen Mehltau.' },
  { name:'Heidelbeere', icon:'🫐', category:'fruit', tasks:[gt('plant',[3,4,9,10],'In saure Erde pflanzen'), gt('care',[5,6,7,8],'Mit Regenwasser gießen'), gt('harvest',[7,8,9],'Beeren pflücken')], notes:'Braucht sauren Boden und gleichmäßige Feuchte.' },
  { name:'Apfelbaum', icon:'🍎', category:'fruit', tasks:[gt('plant',[10,11,3],'Pflanzen'), gt('prune',[1,2,3,7,8],'Schnitt'), gt('care',[6,7],'Fruchtbehang ausdünnen'), gt('harvest',[8,9,10,11],'Sortenreif ernten')], notes:'Sommerschnitt bremst starkes Wachstum; Winterschnitt formt.' },
  { name:'Birnbaum', icon:'🍐', category:'fruit', tasks:[gt('plant',[10,11,3],'Pflanzen'), gt('prune',[1,2,3,7,8],'Schnitt'), gt('harvest',[8,9,10],'Birnen pflücken')], notes:'Früchte oft kurz vor Vollreife pflücken und nachreifen lassen.' },
  { name:'Kirschbaum', icon:'🍒', category:'fruit', tasks:[gt('plant',[10,11,3],'Pflanzen'), gt('prune',[7,8],'Nach Ernte schneiden'), gt('harvest',[6,7],'Kirschen ernten')], notes:'Kirschen besser im Sommer schneiden, wenn Wunden schneller verheilen.' },
  { name:'Weinrebe', icon:'🍇', category:'fruit', tasks:[gt('plant',[4,5,10],'Pflanzen'), gt('prune',[1,2,6,7,8],'Schnitt & Ausgeizen'), gt('care',[6,7,8],'Traubenzone auslichten'), gt('harvest',[8,9,10],'Trauben ernten')], notes:'Sonnige, warme Wandlagen sind ideal.' },
  { name:'Rhabarber', icon:'🌱', category:'fruit', tasks:[gt('plant',[3,4,9,10],'Pflanzen/Teilen'), gt('fertilize',[3,4,7],'Kompost geben'), gt('harvest',[4,5,6],'Stangen drehen')], notes:'Nach Ende Juni ruhen lassen, damit die Pflanze Kraft sammelt.' },
  { name:'Pfifferling', icon:'🍄', category:'mushroom', tasks:[gt('find',[6,7,8,9,10],'Typische Fundzeit')], habitat:'Moosige Laub- und Nadelwälder, oft nach warm-feuchten Phasen.', warning:'Nicht allein nach Farbe bestimmen; falsche Pfifferlinge und andere Arten können verwirren.', notes:'Fundzeit-Hinweis, keine Essensfreigabe.' },
  { name:'Steinpilz', icon:'🍄', category:'mushroom', tasks:[gt('find',[7,8,9,10],'Typische Fundzeit')], habitat:'Fichten-, Buchen- und Mischwälder, gerne an Wegrändern.', warning:'Mit Bitterröhrling verwechselbar; Fund immer vollständig prüfen lassen.', notes:'Nach Regen und warmen Tagen besonders aussichtsreich.' },
  { name:'Maronen-Röhrling', icon:'🍄', category:'mushroom', tasks:[gt('find',[8,9,10,11],'Typische Fundzeit')], habitat:'Saure Nadel- und Mischwälder, oft bei Fichten und Kiefern.', warning:'Röhrlinge dennoch immer vollständig prüfen.', notes:'Häufiger Herbstpilz; feuchte Waldstandorte bevorzugt.' },
  { name:'Birkenpilz', icon:'🍄', category:'mushroom', tasks:[gt('find',[6,7,8,9,10],'Typische Fundzeit')], habitat:'In der Nähe von Birken, auch an Waldwegen.', warning:'Nur junge, feste Exemplare beachten; alte Pilze verderben schnell.', notes:'Die Baumpartnerschaft ist ein wichtiger Hinweis.' },
  { name:'Rotkappe', icon:'🍄', category:'mushroom', tasks:[gt('find',[6,7,8,9,10],'Typische Fundzeit')], habitat:'Bei Espen, Birken oder Eichen, je nach Art.', warning:'Artengruppe sicher bestimmen lassen.', notes:'Auffällige Kappenfarbe ersetzt keine Bestimmung.' },
  { name:'Flockenstieliger Hexenröhrling', icon:'🍄', category:'mushroom', tasks:[gt('find',[5,6,7,8,9,10],'Typische Fundzeit')], habitat:'Laub- und Nadelwälder, Parks, saure Böden.', warning:'Roh giftig; Verwechslungsrisiko mit anderen Röhrlingen.', notes:'Nur mit sicherer Fachkenntnis verwerten.' },
  { name:'Parasol', icon:'🍄', category:'mushroom', tasks:[gt('find',[7,8,9,10],'Typische Fundzeit')], habitat:'Wiesen, lichte Wälder, Waldränder.', warning:'Kleine Schirmlinge können gefährlich sein; Ring, Stiel und Basis prüfen lassen.', notes:'Nur große, sicher bestimmte Schirmlinge in Betracht ziehen.' },
  { name:'Krause Glucke', icon:'🍄', category:'mushroom', tasks:[gt('find',[8,9,10,11],'Typische Fundzeit')], habitat:'Am Fuß alter Kiefern oder Fichten.', warning:'Gründlich reinigen; keine alten zerfallenden Fruchtkörper nutzen.', notes:'Oft standorttreu an denselben Bäumen.' },
  { name:'Totentrompete', icon:'🍄', category:'mushroom', tasks:[gt('find',[8,9,10,11],'Typische Fundzeit')], habitat:'Laubwälder, besonders bei Buche, gerne in Gruppen.', warning:'Dunkle Pilze sind im Laub schwer zu erkennen; nur sicher bestimmte Funde nutzen.', notes:'Trocknet gut, aber Bestimmung bleibt Pflicht.' },
  { name:'Trompetenpfifferling', icon:'🍄', category:'mushroom', tasks:[gt('find',[8,9,10,11],'Typische Fundzeit')], habitat:'Feuchte moosige Nadel- und Mischwälder.', warning:'Kleine Pilze sorgfältig prüfen lassen.', notes:'Oft später im Jahr als echte Pfifferlinge.' },
  { name:'Austernseitling', icon:'🍄', category:'mushroom', tasks:[gt('find',[10,11,12,1,2,3],'Typische Fundzeit')], habitat:'An Laubholz, besonders Buche, oft nach Kälteperioden.', warning:'Baumpilze immer frisch prüfen; alte Exemplare sind ungeeignet.', notes:'Winterpilz, wenn andere Arten kaum noch erscheinen.' },
  { name:'Samtfußrübling', icon:'🍄', category:'mushroom', tasks:[gt('find',[11,12,1,2,3],'Typische Fundzeit')], habitat:'An Laubholzstümpfen und totem Holz.', warning:'Gefährliche Verwechslung mit Gifthäubling möglich.', notes:'Nur mit sehr sicherer Kenntnis sammeln.' },
  { name:'Speisemorchel', icon:'🍄', category:'mushroom', tasks:[gt('find',[4,5],'Typische Fundzeit')], habitat:'Auwälder, Gärten, Eschenbereiche, Rindenmulchstellen.', warning:'Mit Lorcheln verwechselbar; roh unverträglich.', notes:'Kurze Frühjahrssaison.' },
  { name:'Schopftintling', icon:'🍄', category:'mushroom', tasks:[gt('find',[5,6,7,8,9,10,11],'Typische Fundzeit')], habitat:'Wiesen, Wegränder, nährstoffreiche Standorte.', warning:'Nur ganz junge weiße Exemplare; zerfließende Pilze nicht nutzen.', notes:'Sehr kurze Haltbarkeit.' },
  { name:'Wiesenchampignon', icon:'🍄', category:'mushroom', tasks:[gt('find',[6,7,8,9,10],'Typische Fundzeit')], habitat:'Ungedüngte Wiesen und Weiden.', warning:'Lebensgefährliche Verwechslung mit Knollenblätterpilzen möglich.', notes:'Apps/Fotos reichen hier nicht zur Bestimmung.' },
  { name:'Hallimasch', icon:'🍄', category:'mushroom', tasks:[gt('find',[9,10,11],'Typische Fundzeit')], habitat:'An Holz, Stümpfen und geschwächten Bäumen.', warning:'Roh giftig und nicht für alle verträglich; sichere Artkenntnis nötig.', notes:'Große Büschel im Herbst.' },
  { name:'Edel-Reizker', icon:'🍄', category:'mushroom', tasks:[gt('find',[8,9,10,11],'Typische Fundzeit')], habitat:'Kiefern- und Fichtenbereiche, je nach Art.', warning:'Milch, Verfärbung und Begleitbaum prüfen lassen.', notes:'Typisch orange Milch, aber Details sind entscheidend.' },
  { name:'Stockschwämmchen', icon:'🍄', category:'mushroom', tasks:[gt('find',[4,5,6,7,8,9,10,11],'Typische Fundzeit')], habitat:'An Laubholzstümpfen in Büscheln.', warning:'Lebensgefährlich mit Gifthäubling verwechselbar; nur für Experten.', notes:'Nicht für Einsteiger geeignet.' },
  { name:'Violetter Rötelritterling', icon:'🍄', category:'mushroom', tasks:[gt('find',[9,10,11,12],'Typische Fundzeit')], habitat:'Laubstreu, Kompostnähe, lichte Wälder.', warning:'Violette Farbe allein ist kein Bestimmungsmerkmal.', notes:'Spätherbstlicher Fundhinweis.' },
  { name:'Judasohr', icon:'🍄', category:'mushroom', tasks:[gt('find',[1,2,3,4,10,11,12],'Typische Fundzeit')], habitat:'Vor allem an Holunder und anderem Laubholz.', warning:'Nur frische, sicher bestimmte Fruchtkörper beachten.', notes:'Kann nach Regen auch im Winter erscheinen.' },
  { name:'Bärlauch', icon:'🌿', category:'wild', tasks:[gt('find',[3,4,5],'Typische Sammelzeit')], habitat:'Feuchte Laub- und Auwälder, schattige humose Standorte.', warning:'Sehr kritische Verwechslung mit Maiglöckchen, Herbstzeitlose und Aronstab möglich.', notes:'Blätter meist vor der Blüte sammeln; Geruch allein reicht nicht zur sicheren Bestimmung.' },
  { name:'Waldmeister', icon:'🌿', category:'wild', tasks:[gt('find',[4,5],'Typische Sammelzeit')], habitat:'Schattige Laubwälder, besonders Buchenwälder mit humosem Boden.', warning:'Nur sicher bestimmen und sparsam verwenden; der Duft entwickelt sich besonders beim Welken.', notes:'Kurze Frühjahrssaison vor und um die Blüte.' },
  { name:'Brennnessel', icon:'🌿', category:'wild', tasks:[gt('find',[3,4,5,6,7,8,9,10],'Junge Triebe sammeln')], habitat:'Nährstoffreiche Böden, Gartenränder, Hecken, lichte Waldstellen.', warning:'Nicht an belasteten Straßenrändern oder Hundestrecken sammeln; Handschuhe nutzen.', notes:'Junge Triebspitzen sind meist am zartesten.' },
  { name:'Giersch', icon:'🌿', category:'wild', tasks:[gt('find',[3,4,5,6,7,8,9,10],'Junge Blätter suchen')], habitat:'Halbschatten, Gartenränder, Hecken, feuchte nährstoffreiche Stellen.', warning:'Doldenblütler können kritisch sein; Stiel- und Blattmerkmale sicher prüfen.', notes:'Junge, glänzende Blätter sind milder als ältere.' },
  { name:'Löwenzahn', icon:'🌼', category:'wild', tasks:[gt('find',[3,4,5,6,7,8,9,10],'Blätter und Blüten finden')], habitat:'Wiesen, Wegränder, Rasenflächen und offene Böden.', warning:'Nur von unbelasteten, nicht behandelten Flächen sammeln.', notes:'Blätter sind im Frühjahr meist weniger bitter.' },
  { name:'Sauerampfer', icon:'🌿', category:'wild', tasks:[gt('find',[4,5,6,7,8,9],'Blätter suchen')], habitat:'Frische Wiesen, Wegränder und eher nährstoffreiche Böden.', warning:'Enthält Oxalsäure; nur maßvoll und nur bei sicherer Bestimmung nutzen.', notes:'Junge Blätter sind zarter und weniger faserig.' },
  { name:'Holunderblüte', icon:'🌼', category:'wild', tasks:[gt('find',[5,6],'Blütendolden finden')], habitat:'Hecken, Waldränder, Dorfränder und nährstoffreiche Standorte.', warning:'Schwarzen Holunder sicher von anderen Holunderarten unterscheiden.', notes:'Trockene, duftende Blütendolden bevorzugen.' },
  { name:'Holunderbeere', icon:'🫐', category:'wild', tasks:[gt('find',[8,9],'Reife Beeren finden')], habitat:'Hecken, Waldränder, Gärten und nährstoffreiche Standorte.', warning:'Rohe Beeren und Pflanzenteile sind ungeeignet; sicher bestimmen.', notes:'Reife, dunkle Dolden hängen meist im Spätsommer.' },
  { name:'Heidelbeere', icon:'🫐', category:'wild', tasks:[gt('find',[7,8,9],'Beeren pflücken')], habitat:'Saure Nadel- und Mischwälder, Heideflächen und Moore.', warning:'Hygienisch sammeln und waschen; belastete Standorte meiden.', notes:'Typische Sommerbeere an niedrigen Zwergsträuchern.' },
  { name:'Walderdbeere', icon:'🍓', category:'wild', tasks:[gt('find',[6,7,8],'Beeren finden')], habitat:'Lichte Wälder, Waldwege, Heckenränder und sonnige Säume.', warning:'Mit Scheinerdbeere verwechselbar; Standort und Fruchtmerkmale prüfen.', notes:'Kleine aromatische Früchte, oft nur in kleinen Mengen.' },
  { name:'Wilde Himbeere', icon:'🍓', category:'wild', tasks:[gt('find',[6,7,8,9],'Beeren pflücken')], habitat:'Waldlichtungen, Wegränder, Kahlschläge und sonnige Säume.', warning:'Dornen, Zecken und belastete Standorte beachten; nur reife Früchte sammeln.', notes:'Die Frucht löst sich hohl vom hellen Zapfen.' },
  { name:'Wilde Brombeere', icon:'🫐', category:'wild', tasks:[gt('find',[8,9,10],'Beeren pflücken')], habitat:'Hecken, Waldränder, Böschungen und sonnige Brachflächen.', warning:'Dornen, belastete Standorte und Schimmel an überreifen Früchten beachten.', notes:'Reift nach und nach, oft über mehrere Wochen.' },
  { name:'Kornelkirsche', icon:'🍒', category:'wild', tasks:[gt('find',[8,9],'Reife Früchte finden')], habitat:'Hecken, Parks, warme Waldränder und sonnige Gebüsche.', warning:'Nur vollständig rote bis dunkelrote Früchte eindeutig bestimmen.', notes:'Reife Früchte fallen leicht ab und schmecken deutlich milder.' },
  { name:'Sanddorn', icon:'🍊', category:'wild', tasks:[gt('find',[8,9,10],'Beeren finden')], habitat:'Sonnige, sandige Standorte, Küstenbereiche, Kiesflächen und Hecken.', warning:'Dornige Sträucher; nur eindeutig bestimmen und Schutzgebiete beachten.', notes:'Orange Beeren sitzen sehr dicht an den Zweigen.' },
  { name:'Hagebutte', icon:'🌹', category:'wild', tasks:[gt('find',[9,10,11],'Früchte sammeln')], habitat:'Wildrosen an Hecken, Waldrändern, Böschungen und sonnigen Säumen.', warning:'Kerne und Härchen reizen; nur sichere Rosenfrüchte sammeln.', notes:'Nach kühlen Nächten werden viele Früchte weicher.' },
  { name:'Schlehe', icon:'🫐', category:'wild', tasks:[gt('find',[10,11,12],'Früchte finden')], habitat:'Dornige Hecken, Waldränder, trockene Hänge und sonnige Gebüsche.', warning:'Dornig; andere Prunus-Arten sicher ausschließen.', notes:'Nach Frost oder Gefrieren werden die Früchte milder.' },
  { name:'Haselnuss', icon:'🌰', category:'wild', tasks:[gt('find',[9,10],'Nüsse sammeln')], habitat:'Hecken, Waldränder, Feldgehölze und lichte Wälder.', warning:'Nur frische, unverpilzte Nüsse nutzen; Allergien beachten.', notes:'Reife Nüsse lösen sich leicht aus der grünen Hülle.' },
  { name:'Walnuss', icon:'🌰', category:'wild', tasks:[gt('find',[9,10],'Nüsse aufsammeln')], habitat:'Walnussbäume in Gärten, Parks, Obstwiesen und warmen Lagen.', warning:'Schimmel bei Lagerung vermeiden; nur trockene, gesunde Nüsse behalten.', notes:'Fallnüsse zügig trocknen und luftig lagern.' },
  { name:'Esskastanie', icon:'🌰', category:'wild', tasks:[gt('find',[10,11],'Maronen sammeln')], habitat:'Warme Lagen, Parks, alte Haine und lichte Wälder.', warning:'Nicht mit Rosskastanie verwechseln; stachelige Fruchtbecher prüfen.', notes:'Reife Maronen fallen aus den stark stacheligen Hüllen.' },
  { name:'Ringelblume', icon:'🌼', category:'flower', tasks:[gt('sow',[3,4,5,6,7,8],'Direktsaat'), gt('care',[6,7,8,9],'Verblühtes entfernen'), gt('harvest',[6,7,8,9,10],'Blüten sammeln')], notes:'Versamt sich leicht und lockt Nützlinge an.' },
  { name:'Sonnenblume', icon:'🌻', category:'flower', tasks:[gt('indoor',[3,4],'Vorziehen'), gt('sow',[4,5,6],'Direktsaat'), gt('care',[6,7,8],'Stützen'), gt('harvest',[9,10],'Samenstände ernten')], notes:'Hohe Sorten früh stützen.' },
  { name:'Dahlie', icon:'🌸', category:'flower', tasks:[gt('plant',[5,6],'Knollen legen'), gt('care',[6,7,8,9],'Ausputzen & stützen'), gt('protect',[10,11],'Knollen ausgraben')], notes:'Frostempfindlich; erst nach den Eisheiligen raus.' },
  { name:'Lavendel', icon:'💜', category:'flower', tasks:[gt('plant',[4,5,6,9],'Pflanzen'), gt('prune',[3,4,7,8],'Nach Blüte schneiden'), gt('harvest',[6,7,8],'Blüten schneiden')], notes:'Sonnig und durchlässig; nicht ins alte Holz schneiden.' },
  { name:'Tulpe', icon:'🌷', category:'flower', tasks:[gt('plant',[9,10,11],'Zwiebeln setzen'), gt('care',[4,5],'Laub einziehen lassen')], notes:'Nach der Blüte Laub erst entfernen, wenn es vergilbt ist.' },
  { name:'Hecke', icon:'🌳', category:'trees', tasks:[gt('prune',[10,11,12,1,2],'Starker Rückschnitt möglich'), gt('care',[3,4,5,6,7,8,9],'Nur schonender Formschnitt'), gt('protect',[3,4,5,6,7,8,9],'Vor Vogelnestern prüfen')], notes:'Vom 1. März bis 30. September keine Hecken roden oder stark zurückschneiden; schonende Pflege bleibt möglich.' },
  { name:'Rosen', icon:'🌹', category:'trees', tasks:[gt('prune',[3,4],'Frühjahrsschnitt'), gt('care',[6,7,8,9],'Verblühtes entfernen'), gt('fertilize',[3,4,6],'Düngen'), gt('protect',[11,12],'Anhäufeln')], notes:'Schnittzeit meist zur Forsythienblüte; kranke Blätter entfernen.' },
  { name:'Rasen', icon:'🌱', category:'lawn', tasks:[gt('prepare',[3,4],'Vertikutieren bei Wachstum'), gt('sow',[4,5,9],'Nachsäen'), gt('care',[4,5,6,7,8,9,10],'Mähen'), gt('fertilize',[3,4,6,9],'Düngen')], notes:'Bei Hitze höher mähen und selten, aber durchdringend wässern.' },
  { name:'Wildblumenwiese', icon:'🌼', category:'lawn', tasks:[gt('sow',[3,4,5,9,10],'Aussaat'), gt('care',[6,7,8,9],'Abschnittsweise mähen'), gt('harvest',[7,8,9],'Saatgut gewinnen')], notes:'Magerer Boden und später Schnitt fördern Blütenvielfalt.' },
  { name:'Kompost', icon:'🪱', category:'soil', tasks:[gt('care',[1,2,3,4,5,6,7,8,9,10,11,12],'Feuchte prüfen'), gt('prepare',[3,4,9,10],'Umsetzen/Sieben'), gt('fertilize',[3,4,5,9,10],'Reifen Kompost ausbringen')], notes:'Feucht wie ein ausgedrückter Schwamm; grobes Material lockert.' },
  { name:'Mulch', icon:'🍂', category:'soil', tasks:[gt('care',[4,5,6,7,8,9,10],'Mulchdecke pflegen'), gt('protect',[6,7,8],'Boden vor Hitze schützen')], notes:'Nicht direkt an Stängel häufen; Schnecken im Blick behalten.' },
  { name:'Jungpflanzen im Gewächshaus', icon:'🏡', category:'greenhouse', tasks:[gt('indoor',[1,2,3,4,5],'Vorziehen'), gt('care',[3,4,5,6,7,8],'Lüften & schattieren'), gt('protect',[3,4,5],'Frostwächter/Vlies')], notes:'An sonnigen Tagen früh lüften, sonst Hitzestau.' },
  { name:'Gewächshaus-Tomaten', icon:'🏡', category:'greenhouse', tasks:[gt('plant',[4,5],'Pflanzen'), gt('care',[5,6,7,8,9],'Ausgeizen, rütteln, lüften'), gt('harvest',[7,8,9,10],'Ernten')], notes:'Luftfeuchte senken, um Pilzkrankheiten zu vermeiden.' },
  { name:'Balkonkräuter', icon:'🪴', category:'balcony', tasks:[gt('plant',[4,5,6,7],'Pflanzen'), gt('care',[5,6,7,8,9],'Gießen & Spitzen schneiden'), gt('harvest',[5,6,7,8,9,10],'Ernten')], notes:'Kleine Töpfe trocknen schnell aus; lieber morgens gießen.' },
  { name:'Kübelpflanzen', icon:'🪴', category:'balcony', tasks:[gt('plant',[4,5],'Umtopfen'), gt('fertilize',[5,6,7,8],'Düngen'), gt('care',[6,7,8,9],'Ausputzen'), gt('protect',[10,11],'Einräumen')], notes:'Untersetzer nach Starkregen leeren, damit keine Staunässe entsteht.' }
];

const MUSHROOM_DETAILS = {
  'Pfifferling': {
    wiki:'Echter Pfifferling',
    features:['Dottergelbe bis goldgelbe Fruchtkörper', 'Leisten laufen am Stiel herab, keine dünnen Lamellen', 'Festes Fleisch mit fruchtigem Geruch', 'Wächst oft moosig bei Buchen, Fichten oder Kiefern'],
    lookalikes:'Falscher Pfifferling, Ölbaumpilz in wärmeren Regionen'
  },
  'Steinpilz': {
    wiki:'Gemeiner Steinpilz',
    features:['Brauner Hut, jung oft halbkugelig', 'Weiße bis olivgelbe Röhren statt Lamellen', 'Heller, bauchiger Stiel mit feinem Netz', 'Fleisch bleibt beim Anschneiden meist weiß'],
    lookalikes:'Bitterröhrling und andere Röhrlinge'
  },
  'Maronen-Röhrling': {
    wiki:'Maronen-Röhrling',
    features:['Kastanienbrauner, bei Feuchte schmieriger Hut', 'Gelbliche Röhren blauen auf Druck oft an', 'Bräunlicher Stiel ohne deutliches Netz', 'Häufig bei Fichten und Kiefern'],
    lookalikes:'Andere braune Röhrlinge; genaue Röhren- und Stielmerkmale prüfen'
  },
  'Birkenpilz': {
    wiki:'Gemeiner Birkenpilz',
    features:['Wächst in Nähe von Birken', 'Graubrauner Hut', 'Weißlicher Stiel mit dunklen Schüppchen', 'Röhren weißlich bis grau'],
    lookalikes:'Rotkappen und andere Raufußröhrlinge'
  },
  'Rotkappe': {
    wiki:'Rotkappe',
    features:['Orange bis rötlicher Hut', 'Stiel mit dunklen Schüppchen', 'Raufußröhrling mit Baumpartner', 'Fleisch kann beim Anschneiden verfärben'],
    lookalikes:'Mehrere Rotkappen-Arten; Baumpartner und Verfärbung prüfen'
  },
  'Flockenstieliger Hexenröhrling': {
    wiki:'Flockenstieliger Hexen-Röhrling',
    features:['Dunkelbrauner Hut', 'Rote Röhrenmündungen', 'Gelblicher Stiel mit roten Flocken, kein Netz', 'Stark blauendes Fleisch bei Druck oder Schnitt'],
    lookalikes:'Netzstieliger Hexenröhrling, Satansröhrling und andere Röhrlinge'
  },
  'Parasol': {
    wiki:'Gemeiner Riesenschirmling',
    features:['Großer schuppiger Hut mit dunklem Buckel', 'Langer genatterter Stiel', 'Verschiebbarer Ring', 'Freie helle Lamellen'],
    lookalikes:'Giftige kleine Schirmlinge; junge oder kleine Exemplare meiden'
  },
  'Krause Glucke': {
    wiki:'Krause Glucke',
    features:['Korallenartig gekräuselter Fruchtkörper', 'Cremefarben bis gelblich', 'Oft am Fuß von Kiefern', 'Keine klassische Hut-Stiel-Form'],
    lookalikes:'Andere Glucken und korallenartige Pilze'
  },
  'Totentrompete': {
    wiki:'Herbsttrompete',
    features:['Dunkle trichter- bis trompetenförmige Fruchtkörper', 'Dünnes, hohles Fleisch', 'Unterseite glatt bis leicht runzelig', 'Oft in Gruppen in Laubwäldern'],
    lookalikes:'Andere dunkle Leistlingsverwandte'
  },
  'Trompetenpfifferling': {
    wiki:'Trompetenpfifferling',
    features:['Brauner bis graubrauner Hut mit Vertiefung', 'Gelblicher hohler Stiel', 'Leisten an der Unterseite, keine Lamellen', 'Feuchte moosige Nadelwälder'],
    lookalikes:'Andere kleine Leistlinge und Trichterlinge'
  },
  'Austernseitling': {
    wiki:'Austern-Seitling',
    features:['Seitlich angewachsener, muschelartiger Hut', 'Helle herablaufende Lamellen', 'Wächst büschelig an Holz', 'Oft in kühler Jahreszeit'],
    lookalikes:'Andere Seitlinge; alte Baumpilze sorgfältig prüfen'
  },
  'Samtfußrübling': {
    wiki:'Gemeiner Samtfußrübling',
    features:['Honiggelber bis orangebrauner Hut', 'Dunkel samtiger Stielgrund', 'Wächst büschelig an Holz', 'Typisch in kalter Jahreszeit'],
    lookalikes:'Gifthäubling; für Anfänger besonders kritisch'
  },
  'Speisemorchel': {
    wiki:'Speisemorchel',
    features:['Wabenartig gekammerter Hut', 'Hut und Stiel innen hohl', 'Hutrand mit dem Stiel verwachsen', 'Frühjahrspilz an passenden Standorten'],
    lookalikes:'Lorcheln und andere Morcheln; roh unverträglich'
  },
  'Schopftintling': {
    wiki:'Schopf-Tintling',
    features:['Jung walzenförmig weiß mit schuppigem Hut', 'Lamellen verfärben sich rosa bis schwarz', 'Zerfließt später tintenartig', 'Wächst auf Wiesen und Wegrändern'],
    lookalikes:'Andere Tintlinge; nur ganz junge Fruchtkörper beurteilen'
  },
  'Wiesenchampignon': {
    wiki:'Wiesen-Champignon',
    features:['Wächst auf Wiesen, nicht im Wald', 'Lamellen jung rosa, später schokoladenbraun', 'Ring am Stiel', 'Stielbasis ohne Scheide'],
    lookalikes:'Knollenblätterpilze und Karbol-Champignon; sehr kritisch'
  },
  'Hallimasch': {
    wiki:'Hallimasche',
    features:['Büschelig an Holz oder Wurzeln', 'Honigbraune Hüte mit Schüppchen', 'Oft Ring am Stiel', 'Weiße Sporenpulverfarbe bei der Gattung'],
    lookalikes:'Andere holzbewohnende Lamellenpilze; roh giftig'
  },
  'Edel-Reizker': {
    wiki:'Edel-Reizker',
    features:['Orangefarbene Milch beim Anschneiden', 'Orange zonierter Hut', 'Sprödes Fleisch wie bei Milchlingen', 'Meist bei Kiefern'],
    lookalikes:'Andere Reizker und Milchlinge'
  },
  'Stockschwämmchen': {
    wiki:'Stockschwämmchen',
    features:['Büschelig an Holz', 'Hygrophaner brauner Hut mit hellerem Rand', 'Stiel unterhalb des Rings schuppig', 'Braunes Sporenpulver'],
    lookalikes:'Gifthäubling, lebensgefährlich verwechselbar'
  },
  'Violetter Rötelritterling': {
    wiki:'Violetter Rötelritterling',
    features:['Violette bis lila Farbtöne an Hut, Lamellen und Stiel', 'Lamellen dicht stehend', 'Angenehm aromatischer Geruch möglich', 'Spätherbstlich in Laubstreu'],
    lookalikes:'Violette Schleierlinge und andere Lamellenpilze'
  },
  'Judasohr': {
    wiki:'Judasohr',
    features:['Ohrförmiger, gallertiger Fruchtkörper', 'Braun bis rotbraun', 'Wächst häufig an Holunder', 'Quillt nach Regen stark auf'],
    lookalikes:'Andere gallertige Baumpilze'
  }
};

const FORAGE_DETAILS = {
  'Bärlauch': {
    wiki:'Bärlauch',
    features:['Einzelne lanzettliche Blätter aus eigenem Stiel', 'Knoblauchartiger Geruch kann helfen, ist allein unsicher', 'Weiße sternförmige Blüten später im Frühjahr', 'Feuchte, schattige Laubwald-Standorte'],
    lookalikes:'Maiglöckchen, Herbstzeitlose, Aronstab'
  },
  'Waldmeister': {
    wiki:'Waldmeister',
    features:['Quirlständige lanzettliche Blätter', 'Kleine weiße Blüten', 'Duftet nach dem Welken stärker', 'Typisch in Buchenwald und schattigen Laubwäldern'],
    lookalikes:'Andere Labkräuter; nur sicher bestimmte Pflanzen sammeln'
  },
  'Brennnessel': {
    wiki:'Große Brennnessel',
    features:['Gegenständige gesägte Blätter', 'Brennhaare an Stängel und Blättern', 'Vierkantiger Stängel', 'Nährstoffreiche Standorte'],
    lookalikes:'Taubnesseln ohne Brennhaare und andere Lippenblütler'
  },
  'Giersch': {
    wiki:'Giersch',
    features:['Dreikantiger Blattstiel', 'Blatt oft in 3 mal 3 Teilblättchen gegliedert', 'Weiße Doldenblüten später im Jahr', 'Ausbreitend an schattigen, nährstoffreichen Stellen'],
    lookalikes:'Giftige Doldenblütler; nur mit sicherer Artenkenntnis sammeln'
  },
  'Löwenzahn': {
    wiki:'Gewöhnlicher Löwenzahn',
    features:['Blattrosette mit gezähnten Blättern', 'Gelbe Einzelblüte auf hohlem Stängel', 'Milchsaft in Stängel und Blättern', 'Pusteblume nach der Blüte'],
    lookalikes:'Andere Korbblütler und löwenzahnähnliche Arten'
  },
  'Sauerampfer': {
    wiki:'Wiesen-Sauerampfer',
    features:['Pfeilförmige Blätter mit saurem Geschmack', 'Wächst häufig auf frischen Wiesen', 'Rötliche Blütenstände', 'Glatter aufrechter Stängel'],
    lookalikes:'Andere Ampferarten; Oxalsäure beachten'
  },
  'Holunderblüte': {
    wiki:'Schwarzer Holunder',
    features:['Flache duftende weiße Blütendolden', 'Gefiederte Blätter', 'Markige Zweige', 'Strauch oder kleiner Baum an nährstoffreichen Standorten'],
    lookalikes:'Zwergholunder und andere Holunderarten'
  },
  'Holunderbeere': {
    wiki:'Schwarzer Holunder',
    features:['Schwarz-violette Beeren in hängenden Dolden', 'Gefiederte Blätter', 'Markige Zweige', 'Reife meist im Spätsommer'],
    lookalikes:'Zwergholunder, Roter Holunder'
  },
  'Heidelbeere': {
    wiki:'Heidelbeere',
    image:'https://commons.wikimedia.org/wiki/Special:FilePath/Bieszczady%20Flora.jpg?width=900',
    features:['Niedriger Zwergstrauch', 'Kleine eiförmige Blätter', 'Dunkelblaue bereifte Beeren', 'Fruchtfleisch färbt oft blau-violett'],
    lookalikes:'Rauschbeere und andere Vaccinium-Arten'
  },
  'Walderdbeere': {
    wiki:'Wald-Erdbeere',
    features:['Dreiteilige gezähnte Blätter', 'Weiße Blüten', 'Kleine rote aromatische Sammelfrüchte', 'Häufig an lichten Wald- und Wegrändern'],
    lookalikes:'Scheinerdbeere und andere Erdbeer-Arten'
  },
  'Wilde Himbeere': {
    wiki:'Himbeere',
    features:['Beeren lösen sich hohl vom hellen Zapfen', 'Ruten mit feinen Stacheln', 'Blattunterseiten oft hell-filzig', 'Wächst an Lichtungen, Wegrändern und Waldsäumen'],
    lookalikes:'Andere Rubus-Arten'
  },
  'Wilde Brombeere': {
    wiki:'Brombeeren',
    features:['Stachelige Ranken', 'Dreiteilige bis fünfteilige Blätter', 'Schwarze Sammelfrüchte', 'Reift nach und nach an sonnigen Rändern'],
    lookalikes:'Andere Rubus-Arten'
  },
  'Kornelkirsche': {
    wiki:'Kornelkirsche',
    features:['Gelbe Frühblüte vor dem Laub', 'Rote längliche Steinfrüchte', 'Gegenständige Blätter', 'Strauch oder kleiner Baum'],
    lookalikes:'Andere Hartriegel-Arten'
  },
  'Sanddorn': {
    wiki:'Sanddorn',
    features:['Schmale silbrige Blätter', 'Orange Beeren dicht an den Zweigen', 'Dornige Sträucher', 'Sonnige sandige Standorte'],
    lookalikes:'Andere dornige Sträucher'
  },
  'Hagebutte': {
    wiki:'Hagebutte',
    features:['Rote bis orange Scheinfrüchte an Rosen', 'Oft mit Kelchresten', 'Sträucher mit Stacheln', 'Reife meist ab Spätsommer'],
    lookalikes:'Andere Rosenarten; Kerne und Härchen können reizen'
  },
  'Schlehe': {
    wiki:'Schlehdorn',
    features:['Dorniger Strauch', 'Kleine blau bereifte Steinfrüchte', 'Weiße Blüten vor dem Laub', 'Hecken, Waldränder und sonnige Säume'],
    lookalikes:'Andere Prunus-Arten'
  },
  'Haselnuss': {
    wiki:'Gemeine Hasel',
    features:['Runde bis herzförmige gezähnte Blätter', 'Kätzchen im Frühjahr', 'Nüsse in grünen Hüllen', 'Strauch an Hecken und Waldrändern'],
    lookalikes:'Andere Nüsse; Allergien beachten'
  },
  'Walnuss': {
    wiki:'Echte Walnuss',
    features:['Großer Baum mit gefiederten Blättern', 'Grüne Fruchtschale um harte Nuss', 'Aromatischer Blattgeruch', 'Reife Nüsse fallen im Herbst'],
    lookalikes:'Andere Juglans-Arten; Schimmel bei Lagerung vermeiden'
  },
  'Esskastanie': {
    wiki:'Edelkastanie',
    features:['Stark stachelige Fruchtbecher', 'Längliche gezähnte Blätter', 'Glänzende braune Maronen', 'Wärmeliebende Bäume in Parks und Wäldern'],
    lookalikes:'Rosskastanie ist nicht essbar'
  }
};

const FIND_DETAILS = { ...MUSHROOM_DETAILS, ...FORAGE_DETAILS };
const mushroomImageCache = new Map();
const PLANTS = [...LEGACY_PLANTS.map(legacyPlantToGardenItem), ...EXTRA_GARDEN_ITEMS].map(item =>
  (item.category === 'mushroom' || item.category === 'wild') && FIND_DETAILS[item.name] ? { ...item, ...FIND_DETAILS[item.name] } : item
);

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2700);
}


async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function setLocation(location) {
  state.location = {
    name: location.name || location.city || 'Ausgewählter Ort',
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    timezone: location.timezone || 'auto',
    admin1: location.admin1 || ''
  };
  localStorage.setItem('wg-location', JSON.stringify(state.location));
  $('#location-label').textContent = currentLocationText();
  updateLocationPanelTitle();
  updateRadarLocationLabel();
  renderFavorites();
  updateFavoriteButton();
  loadAllData();
}

async function loadAllData() {
  $('#weather-loading').hidden = true;
  $('#weather-content').hidden = false;
  stopRadar();
  const tasks = [loadWeather(), loadPollen(), loadIconD2RadarForecast()];
  await Promise.allSettled(tasks);
  if (state.weather) {
    renderWeather();
    renderGarden();
  }
  updateRadarModeAvailability();
  updateMapLocation();
  if ($('#view-radar').classList.contains('active')) {
    const radarMode = $('.radar-mode-btn.active')?.dataset.radarMode || 'radar';
    setRadarMode(radarMode);
  }
}

async function loadWeather() {
  const { latitude, longitude } = state.location;
  const params = new URLSearchParams({
    latitude, longitude,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,sunshine_duration',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max,sunshine_duration',
    timezone: 'auto', forecast_days: '16'
  });
  try {
    state.weather = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
    state.ensemble = await loadEnsembleTrend();
    localStorage.setItem('wg-weather-cache', JSON.stringify({ at: Date.now(), location: state.location, weather: state.weather, ensemble: state.ensemble }));
  } catch (error) {
    console.error(error);
    const cache = JSON.parse(localStorage.getItem('wg-weather-cache') || 'null');
    if (cache?.weather) {
      state.weather = cache.weather;
      state.ensemble = cache.ensemble;
      toast('Offline: letzte gespeicherte Wetterdaten');
    } else {
      $('#weather-loading').innerHTML = '<p>Wetterdaten konnten nicht geladen werden. Bitte Internetverbindung prüfen.</p>';
    }
  }
}

async function loadIconD2RadarForecast() {
  state.iconD2 = null;
  const { latitude, longitude } = state.location;
  const params = new URLSearchParams({
    latitude, longitude,
    minutely_15: 'precipitation',
    daily: 'precipitation_sum',
    timezone: 'auto',
    forecast_days: '2'
  });
  try {
    const data = await fetchJson(`https://api.open-meteo.com/v1/dwd-icon?${params}`, { timeout: 12000 });
    const times = data?.minutely_15?.time;
    const precipitation = data?.minutely_15?.precipitation;
    const hasValues = Array.isArray(times) && Array.isArray(precipitation) &&
      times.some((time, index) => time && Number.isFinite(Number(precipitation[index])));
    if (!hasValues) throw new Error('Keine ICON-D2-Niederschlagsdaten');
    state.iconD2 = data;
  } catch (error) {
    console.warn('ICON-D2 radar forecast unavailable', error);
    state.iconD2 = null;
  }
}

async function loadEnsembleTrend() {
  const { latitude, longitude } = state.location;
  const models = ['ncep_gefs_ensemble_mean_seamless', 'ncep_gefs025_ensemble_mean', 'ncep_gefs05_ensemble_mean'];
  for (const model of models) {
    try {
      const params = new URLSearchParams({
        latitude, longitude,
        hourly: 'temperature_2m,temperature_2m_spread,precipitation,precipitation_spread,cloud_cover,weather_code',
        models: model, forecast_days: '21', timezone: 'auto'
      });
      const data = await fetchJson(`https://ensemble-api.open-meteo.com/v1/ensemble?${params}`, { timeout: 18000 });
      if (data?.hourly?.time?.length > 16 * 24) {
        state.forecastFallback = false;
        return aggregateEnsemble(data);
      }
    } catch (error) {
      console.warn(`Ensemble-Modell ${model} nicht verfügbar`, error);
    }
  }
  state.forecastFallback = true;
  return buildFallbackTrend();
}

function aggregateEnsemble(data) {
  const h = data.hourly;
  const byDate = new Map();
  h.time.forEach((time, i) => {
    const date = time.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { date, temps: [], spreads: [], precipitation: 0, pSpreads: [], clouds: [], codes: [] });
    const d = byDate.get(date);
    if (Number.isFinite(h.temperature_2m?.[i])) d.temps.push(h.temperature_2m[i]);
    if (Number.isFinite(h.temperature_2m_spread?.[i])) d.spreads.push(h.temperature_2m_spread[i]);
    if (Number.isFinite(h.precipitation?.[i])) d.precipitation += h.precipitation[i];
    if (Number.isFinite(h.precipitation_spread?.[i])) d.pSpreads.push(h.precipitation_spread[i]);
    if (Number.isFinite(h.cloud_cover?.[i])) d.clouds.push(h.cloud_cover[i]);
    if (Number.isFinite(h.weather_code?.[i])) d.codes.push(h.weather_code[i]);
  });
  return [...byDate.values()].map(d => ({
    date: d.date,
    min: d.temps.length ? Math.min(...d.temps) : null,
    max: d.temps.length ? Math.max(...d.temps) : null,
    spread: d.spreads.length ? Math.max(...d.spreads) : null,
    precipitation: d.precipitation,
    precipitationSpread: d.pSpreads.length ? Math.max(...d.pSpreads) : null,
    cloud: d.clouds.length ? d.clouds.reduce((a,b)=>a+b,0)/d.clouds.length : 50,
    code: d.codes.length ? Math.round(d.codes.reduce((a,b)=>a+b,0)/d.codes.length) : null,
    fallback: false
  }));
}

function buildFallbackTrend() {
  if (!state.weather?.daily) return [];
  const d = state.weather.daily;
  const last = d.time.length - 1;
  const meanMax = average(d.temperature_2m_max.slice(-5));
  const meanMin = average(d.temperature_2m_min.slice(-5));
  const meanRain = average(d.precipitation_sum.slice(-5));
  const start = new Date(`${d.time[last]}T12:00:00`);
  return Array.from({ length: 5 }, (_, i) => {
    const date = new Date(start);
    date.setDate(date.getDate() + i + 1);
    return {
      date: date.toISOString().slice(0,10),
      min: meanMin - (2 + i * .5), max: meanMax + (2 + i * .5), spread: 3.5 + i * .4,
      precipitation: meanRain, cloud: 50, code: meanRain > 2 ? 61 : 2, fallback: true
    };
  });
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : 0;
}

function renderWeather() {
  const w = state.weather;
  $('#weather-loading').hidden = true;
  $('#weather-content').hidden = false;
  const [condition, icon] = weatherInfo(w.current.weather_code);
  $('#current-icon').innerHTML = weatherIconHtml(icon, condition);
  $('#current-temp').textContent = round(w.current.temperature_2m);
  $('#current-condition').textContent = condition;
  if ($('#current-stamp')) {
    const currentDate = w.current.time ? new Date(w.current.time) : new Date();
    $('#current-stamp').textContent = new Intl.DateTimeFormat('de-DE', {
      day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit'
    }).format(currentDate).replace(',', '');
  }
  $('#current-feels').textContent = `${round(w.current.apparent_temperature)}°`;
  $('#current-humidity').textContent = `${round(w.current.relative_humidity_2m)}%`;
  $('#current-wind').textContent = `${round(w.current.wind_speed_10m)} km/h`;
  $('#current-rain').textContent = `${Number(w.current.precipitation || 0).toFixed(1)} mm`;
  renderHourly();
  renderDailyOverview();
  renderForecast();
}

function renderHourly() {
  const daily = state.weather.daily;
  const today = daily.time[0];
  const keyHours = [2, 8, 14, 20];
  const items = keyHours.map(hour => {
    const i = pickHourIndex(today, hour);
    const hourly = state.weather.hourly;
    const [condition, icon] = weatherInfo(hourly.weather_code[i]);
    return `<article class="hour-card">
      <time>${formatShortHour(hour)}</time>
      <div class="hour-icon">${weatherIconHtml(icon, condition)}</div>
      <strong>${round(hourly.temperature_2m[i])}°</strong>
      <small>${escapeHtml(condition)}</small>
      <div class="rain">💧 ${round(hourly.precipitation_probability[i])}% · ${Number(hourly.precipitation[i] || 0).toFixed(1)} mm</div>
    </article>`;
  }).join('');
  $('#hourly-list').innerHTML = items;
}

function renderDailyOverview() {
  const daily = state.weather.daily;
  const rows = daily.time.slice(0, 7).map((date, index) => {
    const [condition, icon] = weatherInfo(daily.weather_code[index]);
    const dayLabel = index === 0 ? 'Heute' : localeDate(date, { weekday:'short' }).replace('.', '');
    const sunshine = formatHours(daily.sunshine_duration?.[index]);
    return `<button type="button" class="daily-overview-row" data-overview-index="${index}" aria-label="${escapeHtml(dayLabel)} ${monthDay(date)} öffnen">
      <div>
        <div class="day-name">${escapeHtml(dayLabel)}</div>
        <span class="day-date">${monthDay(date)}</span>
      </div>
      <div class="day-icon">${weatherIconHtml(icon, condition)}</div>
      <div class="day-temp"><span>${round(daily.temperature_2m_min[index])}°</span><strong>${round(daily.temperature_2m_max[index])}°</strong></div>
      <div class="day-meta">
        <div class="topline"><span>☀ ${sunshine}</span><span>💧 ${round(daily.precipitation_probability_max[index])}%</span></div>
        <div class="subline">${Number(daily.precipitation_sum[index] || 0).toFixed(1)} mm · ${escapeHtml(condition)}</div>
      </div>
      <div class="day-wind"><strong>${round(daily.wind_speed_10m_max[index])}</strong><span>km/h Wind</span></div>
      <span class="row-open">Tagesübersicht öffnen ›</span>
    </button>`;
  }).join('');
  $('#daily-overview').innerHTML = rows;
}


function renderForecast() {
  const d = state.weather.daily;
  const deterministic = d.time.map((date, i) => ({
    date, code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i],
    precipitation: d.precipitation_sum[i], probability: d.precipitation_probability_max[i], index: i, trend: false
  }));
  let trends = (state.ensemble || []).filter(item => item.date > d.time[d.time.length - 1]).slice(0,5);
  if (trends.length < 5 && state.forecastFallback) trends = state.ensemble.slice(-5);
  const all = [...deterministic, ...trends.map((item, i) => ({ ...item, index: 16 + i, trend: true }))].slice(0,21);
  $('#forecast-grid').innerHTML = all.map(item => {
    const [condition, iconFromCode] = weatherInfo(item.code);
    const icon = item.trend ? trendIcon(item) : iconFromCode;
    const rangeClass = item.trend ? 'trend-card' : item.index >= 7 ? 'medium-range' : '';
    const confidence = item.trend ? confidenceText(item.spread, item.fallback) : item.index >= 7 ? 'Prognose zunehmend unsicher' : condition;
    const action = item.trend ? 'Nur Trenddaten' : 'Stunden ansehen ›';
    const label = `${item.index === 0 ? 'Heute' : weekday(item.date)}, ${monthDay(item.date)}: ${condition}. ${action}`;
    return `<button type="button" class="forecast-card ${rangeClass}" data-forecast-index="${item.index}" aria-label="${escapeHtml(label)}">
      <i class="reliability"></i>
      <div class="forecast-day">${item.index === 0 ? 'Heute' : weekday(item.date)}</div>
      <div class="forecast-date">${monthDay(item.date)}</div>
      <div class="forecast-icon" title="${escapeHtml(condition)}">${weatherIconHtml(icon, condition)}</div>
      <div class="forecast-temp"><strong>${round(item.max)}°</strong><span>${round(item.min)}°</span></div>
      <div class="forecast-rain"><span>💧 ${item.trend ? Number(item.precipitation || 0).toFixed(1)+' mm' : round(item.probability)+'%'}</span><span>${item.trend ? 'Trend' : Number(item.precipitation || 0).toFixed(1)+' mm'}</span></div>
      <div class="confidence">${escapeHtml(confidence)}</div>
      <span class="forecast-open">${action}</span>
    </button>`;
  }).join('');
}


function openDayDetails(index) {
  const daily = state.weather?.daily;
  const hourly = state.weather?.hourly;
  if (!daily || !hourly) return;
  if (index >= daily.time.length) {
    return toast('Für Tag 17–21 gibt es nur einen groben Trend, keine seriöse Stundenprognose');
  }

  const date = daily.time[index];
  const indices = indicesForDate(date);
  if (!indices.length) return toast('Für diesen Tag sind keine Stundendaten verfügbar');

  const [condition, icon] = weatherInfo(daily.weather_code[index]);
  const fullDate = localeDate(date, { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  $('#day-dialog-location').textContent = currentLocationText();
  $('#day-dialog-title').innerHTML = `${weatherIconHtml(icon, condition)} ${escapeHtml(index === 0 ? 'Heute' : fullDate)}`;
  $('#day-dialog-subtitle').textContent = `${condition} · ${round(daily.temperature_2m_min[index])}° bis ${round(daily.temperature_2m_max[index])}°`;

  const segments = [
    describeSegment(date, 'Nacht', 0, 6, daily.temperature_2m_min[index]),
    describeSegment(date, 'Tag', 6, 18, daily.temperature_2m_max[index]),
    describeSegment(date, 'Abend', 18, 24, daily.temperature_2m_min[index])
  ];
  $('#day-periods').innerHTML = segments.map(segment => `<article class="day-period-card">
    <div>
      <div class="label">${segment.label}</div>
      <div class="icon">${weatherIconHtml(segment.icon, segment.condition)}</div>
      <div class="temp">${round(segment.temp)}°<span>${round(segment.tempAlt)}°</span></div>
    </div>
    <div class="meta">
      <span>${escapeHtml(segment.condition)}</span>
      <span>💧 ${round(segment.precipProbability)}% · ${segment.precipitation.toFixed(1)} mm</span>
      <span>🜃 ${round(segment.wind)} km/h</span>
    </div>
  </article>`).join('');

  $('#day-dialog-metrics').innerHTML = [
    ['UV-Index', `${Number(daily.uv_index_max[index] || 0).toFixed(1)}`, ''],
    ['Sonnenschein', formatHours(daily.sunshine_duration?.[index]), 'am Tag'],
    ['Wind / Böen', `${round(daily.wind_speed_10m_max[index])} km/h`, `Böen ${round(daily.wind_gusts_10m_max[index])} km/h`],
    ['Sonne', hourLabel(daily.sunrise[index]), `Untergang ${hourLabel(daily.sunset[index])}`]
  ].map(([label, value, sub]) => `<div class="day-metric"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`).join('');

  $('#day-hourly-table').innerHTML = indices.map(i => {
    const [, hourIcon] = weatherInfo(hourly.weather_code[i]);
    const fromHour = Number(hourly.time[i].slice(11, 13));
    const desc = weatherInfo(hourly.weather_code[i])[0];
    return `<article class="day-hour-row" data-hour="${fromHour}">
      <div class="time">${formatShortHour(fromHour)}<small>bis ${formatShortHour((fromHour + 1) % 24)}</small></div>
      <div class="weather">
        <div class="icon">${weatherIconHtml(hourIcon, desc)}</div>
        <div>
          <div class="temp">${round(hourly.temperature_2m[i])}°</div>
          <div class="desc">${escapeHtml(desc)}</div>
        </div>
      </div>
      <div class="precip">
        <strong>☀ ${formatMinutes(hourly.sunshine_duration?.[i])}</strong>
        <span>💧 ${round(hourly.precipitation_probability[i])}%</span>
        <span>${Number(hourly.precipitation[i] || 0).toFixed(1)} mm</span>
      </div>
      <div class="wind"><strong>${round(hourly.wind_speed_10m[i])}</strong><span>km/h · Böen ${round(hourly.wind_gusts_10m?.[i])}</span></div>
    </article>`;
  }).join('');
  $('#day-dialog').showModal();
  scrollDayDialogToStartHour(date, index);
}

function trendIcon(item) {
  if ((item.precipitation || 0) >= 7) return '🌧️';
  if ((item.precipitation || 0) >= 2) return '🌦️';
  if ((item.cloud || 50) >= 75) return '☁️';
  if ((item.cloud || 50) >= 40) return '⛅';
  return '🌤️';
}

function confidenceText(spread, fallback) {
  if (fallback) return 'Grober Langfristtrend – Ensemble derzeit nicht erreichbar';
  if (!Number.isFinite(spread)) return 'Ensemble-Trend';
  if (spread <= 2) return `Relativ stabil · Streuung ±${spread.toFixed(1)}°`;
  if (spread <= 3.5) return `Unsicher · Streuung ±${spread.toFixed(1)}°`;
  return `Sehr unsicher · Streuung ±${spread.toFixed(1)}°`;
}

async function loadPollen() {
  const { latitude, longitude } = state.location;
  const keys = POLLEN.map(p => p.key).join(',');
  const params = new URLSearchParams({ latitude, longitude, hourly: keys, current: keys, timezone: 'auto', forecast_days: '5' });
  try {
    state.pollen = await fetchJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`);
    localStorage.setItem('wg-pollen-cache', JSON.stringify(state.pollen));
    renderPollen();
  } catch (error) {
    console.error(error);
    state.pollen = JSON.parse(localStorage.getItem('wg-pollen-cache') || 'null');
    renderPollen();
  }
}

function pollenLevel(value, thresholds) {
  const v = Number(value) || 0;
  if (v < thresholds[0]) return { rank:0, label:'Keine', cls:'none' };
  if (v < thresholds[1]) return { rank:1, label:'Gering', cls:'low' };
  if (v < thresholds[2]) return { rank:2, label:'Mittel', cls:'medium' };
  return { rank:3, label:'Hoch', cls:'high' };
}

function renderPollen() {
  if (!state.pollen?.hourly) {
    $('#pollen-level').textContent = 'Keine Daten verfügbar';
    $('#pollen-advice').textContent = 'Pollendaten werden nur für Europa und während der jeweiligen Saison bereitgestellt.';
    $('#pollen-species').innerHTML = '<div class="empty-state">Für diesen Ort oder Zeitraum liegen keine Pollendaten vor.</div>';
    $('#pollen-days').innerHTML = '';
    return;
  }
  const h = state.pollen.hourly;
  const startDate = h.time[0]?.slice(0,10);
  const todayIndices = h.time.map((t,i)=>t.startsWith(startDate)?i:-1).filter(i=>i>=0);
  const cards = POLLEN.map(species => {
    const values = todayIndices.map(i => h[species.key]?.[i]).filter(Number.isFinite);
    const max = values.length ? Math.max(...values) : 0;
    const level = pollenLevel(max, species.thresholds);
    return { ...species, max, level };
  });
  const overall = cards.reduce((best, item) => item.level.rank > best.level.rank ? item : best, cards[0]);
  const overallRank = Math.max(...cards.map(x => x.level.rank));
  const overallLabels = ['Keine Belastung','Geringe Belastung','Mittlere Belastung','Hohe Belastung'];
  $('#pollen-level').textContent = overallLabels[overallRank];
  $('#pollen-orb').textContent = overallRank >= 3 ? '🤧' : overallRank === 2 ? '🌾' : '🌿';
  $('#pollen-advice').textContent = overallRank === 0 ? 'Aktuell sind keine nennenswerten Konzentrationen modelliert.' :
    overallRank === 1 ? `${overall.name} ist heute voraussichtlich am stärksten vertreten.` :
    overallRank === 2 ? `Empfindliche Personen sollten besonders auf ${overall.name} achten.` :
    `Bei ${overall.name} wird eine hohe Konzentration erwartet; individuelle Schutzmaßnahmen einplanen.`;

  $('#pollen-species').innerHTML = cards.map(item => {
    const percentage = clamp((item.max / Math.max(item.thresholds[2] * 1.5, 1)) * 100, 0, 100);
    return `<article class="pollen-card">
      <header><h3>${item.icon} ${item.name}</h3><span class="level-badge level-${item.level.cls}">${item.level.label}</span></header>
      <div class="pollen-value">${item.max.toFixed(item.max < 10 ? 1 : 0)} <small>Körner/m³</small></div>
      <div class="load-bar"><i style="width:${percentage}%"></i></div>
    </article>`;
  }).join('');

  const dates = [...new Set(h.time.map(t => t.slice(0,10)))].slice(0,5);
  $('#pollen-days').innerHTML = dates.map(date => {
    const indices = h.time.map((t,i)=>t.startsWith(date)?i:-1).filter(i=>i>=0);
    let peak = { name:'Keine', value:0, rank:0 };
    POLLEN.forEach(species => {
      const vals = indices.map(i=>h[species.key]?.[i]).filter(Number.isFinite);
      const max = vals.length ? Math.max(...vals) : 0;
      const lvl = pollenLevel(max, species.thresholds);
      if (lvl.rank > peak.rank || (lvl.rank === peak.rank && max > peak.value)) peak = { name:species.name, value:max, rank:lvl.rank };
    });
    return `<article class="pollen-day"><strong>${date === dates[0] ? 'Heute' : weekday(date)}, ${monthDay(date)}</strong><span>${peak.rank ? `${peak.name}: ${peak.value.toFixed(1)} Körner/m³` : 'Keine nennenswerte Belastung'}</span></article>`;
  }).join('');
}

function gardenSignals() {
  if (!state.weather?.daily) return [];
  const d = state.weather.daily;
  const rain3 = d.precipitation_sum.slice(0,3).reduce((a,b)=>a+(b||0),0);
  const rain7 = d.precipitation_sum.slice(0,7).reduce((a,b)=>a+(b||0),0);
  const min3 = Math.min(...d.temperature_2m_min.slice(0,3));
  const max3 = Math.max(...d.temperature_2m_max.slice(0,3));
  const gust3 = Math.max(...d.wind_gusts_10m_max.slice(0,3));
  const signals = [];
  if (min3 <= 2) signals.push({ text:'Frostgefahr: Jungpflanzen schützen', warn:true });
  else signals.push({ text:'Kein Bodenfrost in den nächsten 3 Tagen', warn:false });
  if (rain3 >= 18) signals.push({ text:'Sehr nass: Aussaat eventuell verschieben', warn:true });
  else if (rain7 < 5) signals.push({ text:'Trocken: Saatbeete konsequent feucht halten', warn:true });
  else signals.push({ text:'Günstige Bodenfeuchte erwartet', warn:false });
  if (max3 >= 29) signals.push({ text:'Hitze: morgens gießen und mulchen', warn:true });
  if (gust3 >= 50) signals.push({ text:'Sturmböen: Rankhilfen kontrollieren', warn:true });
  return signals;
}

function renderGarden() {
  const month = new Date().getMonth() + 1;
  $('#garden-month').textContent = new Intl.DateTimeFormat('de-DE', { month:'long' }).format(new Date());
  const signals = gardenSignals();
  const nowPlants = PLANTS.filter(p => p.indoor.includes(month) || p.sow.includes(month) || p.harvest.includes(month));
  $('#garden-advice').innerHTML = `<h3>${nowPlants.length} Kulturen passen aktuell in den Kalender</h3>
    <p>Die Monatsangaben gelten als Orientierung für das mitteleuropäische Klima. Das aktuelle Wetter an deinem Ort wird zusätzlich bewertet.</p>
    <div class="garden-signals">${signals.map(s=>`<span class="signal ${s.warn?'warn':''}">${escapeHtml(s.text)}</span>`).join('')}</div>`;
  renderPlants();
}

function renderPlants() {
  const month = new Date().getMonth() + 1;
  const filter = $('#garden-filter').value;
  const query = $('#plant-search').value.trim().toLowerCase();
  const plants = PLANTS.filter(p => {
    const matchesQuery = !query || p.name.toLowerCase().includes(query) || p.notes.toLowerCase().includes(query);
    if (!matchesQuery) return false;
    if (filter === 'all') return true;
    if (filter === 'sow') return p.indoor.includes(month) || p.sow.includes(month);
    if (filter === 'harvest') return p.harvest.includes(month);
    return p.indoor.includes(month) || p.sow.includes(month) || p.harvest.includes(month);
  });
  $('#plant-list').innerHTML = plants.length ? plants.map(p => plantCard(p, month)).join('') : '<div class="empty-state">Keine passende Pflanze gefunden.</div>';
}

function plantCard(plant, currentMonth) {
  const status = [];
  if (plant.indoor.includes(currentMonth)) status.push('Vorkultur');
  if (plant.sow.includes(currentMonth)) status.push('Aussaat');
  if (plant.harvest.includes(currentMonth)) status.push('Ernte');
  const cells = Array.from({length:12}, (_,i) => {
    const month = i + 1;
    let cls = '';
    if (plant.harvest.includes(month)) cls = 'harvest';
    if (plant.sow.includes(month)) cls = 'sow';
    if (plant.indoor.includes(month)) cls = 'indoor';
    return `<div class="month-cell ${cls} ${month===currentMonth?'current':''}" title="${monthName(month)}">${month}</div>`;
  }).join('');
  return `<article class="plant-card">
    <div class="plant-head"><div class="plant-title"><span class="plant-emoji">${plant.icon}</span><div><h3>${plant.name}</h3><small>${status.length ? `Jetzt: ${status.join(' · ')}` : 'Saisonübersicht'}</small></div></div></div>
    <div class="month-row">${cells}</div>
    <p class="plant-notes">${escapeHtml(plant.notes)}</p>
  </article>`;
}

function monthName(month) {
  return new Intl.DateTimeFormat('de-DE',{month:'long'}).format(new Date(2026, month-1, 1));
}

function currentGardenMonth() {
  const date = currentLocationDateHour().date;
  const month = Number(date?.slice(5, 7));
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : new Date().getMonth() + 1;
}

function categoryInfo(id) {
  if (id === 'weather') return { id:'weather', label:'Wetter', icon:'☁️' };
  if (id === 'wild') return { id:'wild', label:'Kostbarkeiten', icon:'🫐' };
  return GARDEN_CATEGORIES.find(category => category.id === id) || GARDEN_CATEGORIES[0];
}

function taskInfo(type) {
  return GARDEN_TASK_TYPES[type] || { label:type, cls:'care' };
}

function tasksForMonth(item, month) {
  return (item.tasks || []).filter(task => task.months?.includes(month));
}

function taskRank(type) {
  const rank = TASK_SORT.indexOf(type);
  return rank >= 0 ? rank : TASK_SORT.length;
}

function activeGardenCategory() {
  return $('#garden-category-tabs .garden-category-btn.active')?.dataset.gardenCategory || 'all';
}

function isForageItem(item) {
  return item.category === 'mushroom' || item.category === 'wild';
}

function itemInGardenCategory(item, category) {
  if (category === 'all') return true;
  if (category === 'mushroom') return isForageItem(item);
  return item.category === category;
}

function gardenSignals() {
  if (!state.weather?.daily) return [{ text:'Wetterdaten werden für die Gartenhinweise noch geladen', warn:false }];
  const d = state.weather.daily;
  const rain3 = d.precipitation_sum.slice(0,3).reduce((a,b)=>a+(b||0),0);
  const rain7 = d.precipitation_sum.slice(0,7).reduce((a,b)=>a+(b||0),0);
  const min3 = Math.min(...d.temperature_2m_min.slice(0,3));
  const max3 = Math.max(...d.temperature_2m_max.slice(0,3));
  const gust3 = Math.max(...d.wind_gusts_10m_max.slice(0,3));
  const month = currentGardenMonth();
  const signals = [];
  if (min3 <= 2) signals.push({ text:'Frostgefahr: Jungpflanzen schützen', warn:true });
  else signals.push({ text:'Kein Bodenfrost in den nächsten 3 Tagen', warn:false });
  if (rain3 >= 18) signals.push({ text:'Sehr nass: Aussaat verschieben, Schnecken prüfen', warn:true });
  else if (rain7 < 5) signals.push({ text:'Trocken: Saatbeete und Kübel feucht halten', warn:true });
  else signals.push({ text:'Bodenfeuchte voraussichtlich brauchbar', warn:false });
  if (max3 >= 29) signals.push({ text:'Hitze: morgens gießen, mulchen und schattieren', warn:true });
  if (gust3 >= 50) signals.push({ text:'Sturmböen: Rankhilfen und Kübel sichern', warn:true });
  if (month >= 3 && month <= 9) signals.push({ text:'Hecken: nur schonender Form- und Pflegeschnitt', warn:true });
  return signals;
}

function weatherGardenTasks(month) {
  const d = state.weather?.daily;
  if (!d) return [];
  const rain3 = d.precipitation_sum.slice(0,3).reduce((a,b)=>a+(b||0),0);
  const rain7 = d.precipitation_sum.slice(0,7).reduce((a,b)=>a+(b||0),0);
  const min3 = Math.min(...d.temperature_2m_min.slice(0,3));
  const max3 = Math.max(...d.temperature_2m_max.slice(0,3));
  const gust3 = Math.max(...d.wind_gusts_10m_max.slice(0,3));
  const tasks = [];
  const add = (type, label, note) => tasks.push({ name:'Wetter', icon:'☁️', category:'weather', task:gt(type, [month], label, note) });
  if (min3 <= 2) add('protect', 'Jungpflanzen abdecken', 'Vlies, Hauben oder Topfpflanzen nutzen.');
  if (max3 >= 29) add('protect', 'Jungpflanzen schattieren', 'Morgens gießen, Boden bedecken und Kübel aus der Mittagssonne nehmen.');
  if (rain7 < 5) add('care', 'Gießen einplanen', 'Besonders Saat, Hochbeete, Kübel und Neupflanzungen prüfen.');
  if (rain3 >= 18) add('care', 'Schnecken kontrollieren', 'Feuchte Phasen sind kritisch für Salat, Jungpflanzen und Dahlien.');
  if (gust3 >= 50) add('protect', 'Rankhilfen sichern', 'Tomaten, Bohnen, Sonnenblumen und Kübel kontrollieren.');
  return tasks;
}

function currentGardenTasks(month) {
  const catalogTasks = PLANTS.flatMap(item => tasksForMonth(item, month).map(task => ({ item, task })));
  const weatherTasks = weatherGardenTasks(month).map(item => ({ item, task:item.task }));
  const seen = new Set();
  return [...weatherTasks, ...catalogTasks]
    .filter(({ item, task }) => {
      const key = `${item.name}-${task.type}-${task.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => taskRank(a.task.type) - taskRank(b.task.type) || a.item.name.localeCompare(b.item.name, 'de'));
}

function renderGardenCategories(month) {
  const active = activeGardenCategory();
  const html = GARDEN_CATEGORIES.map(category => {
    const count = category.id === 'all'
      ? PLANTS.filter(item => tasksForMonth(item, month).length).length
      : PLANTS.filter(item => itemInGardenCategory(item, category.id) && tasksForMonth(item, month).length).length;
    return `<button type="button" class="garden-category-btn ${category.id === active ? 'active' : ''}" data-garden-category="${category.id}" aria-pressed="${category.id === active}">
      <span>${category.icon}</span><strong>${escapeHtml(category.label)}</strong><small>${count}</small>
    </button>`;
  }).join('');
  $('#garden-category-tabs').innerHTML = html;
}

function mushroomSummary(month) {
  const finds = PLANTS.filter(item => isForageItem(item) && tasksForMonth(item, month).some(task => task.type === 'find'));
  if (!finds.length) return '';
  const names = finds.slice(0, 8).map(item => item.name).join(', ');
  const more = finds.length > 8 ? ` und ${finds.length - 8} weitere` : '';
  return `<article class="mushroom-now neo-inset">
    <strong>🍄🫐 Aktuell draußen zu finden</strong>
    <span>${escapeHtml(names)}${more}</span>
    <small>${finds.length} saisonale Fundhinweise im ${monthName(month)}</small>
  </article>`;
}

function renderGardenNow(month) {
  const tasks = currentGardenTasks(month).slice(0, 12);
  $('#garden-now').innerHTML = tasks.length ? tasks.map(({ item, task }) => {
    const info = taskInfo(task.type);
    return `<article class="garden-task-card ${info.cls}">
      <span class="task-icon">${item.icon}</span>
      <div>
        <strong>${escapeHtml(task.label)}</strong>
        <small>${escapeHtml(item.name)} · ${escapeHtml(categoryInfo(item.category).label)}</small>
        ${task.note ? `<p>${escapeHtml(task.note)}</p>` : ''}
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">Für diesen Monat sind keine Aufgaben hinterlegt.</div>';
}

function renderGarden() {
  const month = currentGardenMonth();
  $('#garden-month').textContent = monthName(month);
  const signals = gardenSignals();
  const currentItems = PLANTS.filter(item => tasksForMonth(item, month).length);
  $('#garden-advice').innerHTML = `<div class="garden-advice-head">
      <div><p class="eyebrow">Jetzt zu tun</p><h3>${currentItems.length} Einträge im ${monthName(month)}</h3></div>
      <span>${PLANTS.length} Datenbank-Einträge</span>
    </div>
    <p>Der Gartenplaner zeigt Aussaat, Pflege, Schnitt, Ernte und Pilzfundzeiten. Wetterdaten deines Ortes fließen in die Aufgabenhinweise ein.</p>
    <div class="garden-signals">${signals.map(signal => `<span class="signal ${signal.warn ? 'warn' : ''}">${escapeHtml(signal.text)}</span>`).join('')}</div>
    ${mushroomSummary(month)}`;
  renderGardenCategories(month);
  renderGardenNow(month);
  renderPlants();
}

function itemSearchText(item) {
  return [
    item.name,
    categoryInfo(item.category).label,
    item.notes,
    item.habitat,
    item.warning,
    item.lookalikes,
    ...(item.features || []),
    ...(item.tasks || []).flatMap(task => [task.label, task.note, taskInfo(task.type).label])
  ].filter(Boolean).join(' ').toLowerCase();
}

function itemMatchesGardenFilter(item, filter, month) {
  if (filter === 'all') return true;
  const currentTasks = tasksForMonth(item, month);
  if (filter === 'current') return currentTasks.length > 0;
  return currentTasks.some(task => task.type === filter);
}

function mushroomSafetyCard() {
  return `<article class="mushroom-safety-card neo-inset">
    <strong>🍄🫐 Sammel-Sicherheit</strong>
    <p>Fundzeiten sind nur Orientierung. Die App bestimmt keine Pilze, Wildpflanzen oder Beeren und gibt keine Verzehrfreigabe. Sammle und iss nur, was sicher bestimmt ist; bei Pilzen eine Pilzberatung nutzen.</p>
  </article>`;
}

async function fetchMushroomWikiData(item) {
  if (!item?.wiki) return null;
  if (mushroomImageCache.has(item.name)) return mushroomImageCache.get(item.name);

  const request = (async () => {
    if (item.image) {
      return {
        image:item.image,
        page:`https://de.wikipedia.org/wiki/${encodeURIComponent(item.wiki.replaceAll(' ', '_'))}`,
        title:item.wiki || item.name
      };
    }

    const summaryUrl = title => `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
    let data = await fetchJson(summaryUrl(item.wiki), { timeout: 9000 }).catch(() => null);

    if (!data?.thumbnail?.source && !data?.originalimage?.source) {
      const searchHint = item.category === 'mushroom' ? 'Pilz' : 'Wildpflanze';
      const search = await fetchJson(`https://de.wikipedia.org/w/api.php?action=query&origin=*&format=json&list=search&srlimit=1&srsearch=${encodeURIComponent(`${item.name} ${searchHint}`)}`, { timeout: 9000 }).catch(() => null);
      const title = search?.query?.search?.[0]?.title;
      if (title) data = await fetchJson(summaryUrl(title), { timeout: 9000 }).catch(() => null);
    }

    let image = data?.thumbnail?.source || data?.originalimage?.source;
    if (!image && data?.title) {
      const imageQuery = await fetchJson(`https://de.wikipedia.org/w/api.php?action=query&origin=*&format=json&prop=pageimages&piprop=thumbnail&pithumbsize=900&titles=${encodeURIComponent(data.title)}`, { timeout: 9000 }).catch(() => null);
      const page = Object.values(imageQuery?.query?.pages || {})[0];
      image = page?.thumbnail?.source;
    }
    if (!image && item.image) image = item.image;
    if (!image) return null;
    return {
      image,
      page:data?.content_urls?.desktop?.page || `https://de.wikipedia.org/wiki/${encodeURIComponent(item.wiki.replaceAll(' ', '_'))}`,
      title:data?.title || item.wiki
    };
  })();

  mushroomImageCache.set(item.name, request);
  return request;
}

function hydrateMushroomImages() {
  $$('[data-mushroom-name]').forEach(async slot => {
    const item = PLANTS.find(entry => entry.name === slot.dataset.mushroomName && isForageItem(entry));
    if (!item || slot.dataset.loaded === '1') return;
    slot.dataset.loaded = '1';
    const data = await fetchMushroomWikiData(item);
    const image = slot.querySelector('img');
    const link = slot.querySelector('a');
    const placeholder = slot.querySelector('.mushroom-photo-placeholder span');
    if (!data || !image || !link) {
      slot.classList.add('failed');
      if (placeholder) placeholder.textContent = 'Bild nicht verfügbar';
      return;
    }
    image.src = data.image;
    image.alt = `${item.name}: Foto aus Wikipedia/Wikimedia`;
    image.hidden = false;
    link.href = data.page;
    link.textContent = `Bild/Artikel: ${data.title}`;
    link.hidden = false;
    slot.classList.add('loaded');
  });
}

function mushroomImageSlot(plant) {
  return `<figure class="mushroom-photo" data-mushroom-name="${escapeHtml(plant.name)}">
    <div class="mushroom-photo-placeholder">${plant.icon}<span>Bild lädt …</span></div>
    <img hidden loading="lazy" referrerpolicy="no-referrer" alt="" />
    <figcaption><a hidden target="_blank" rel="noopener noreferrer">Bild/Artikel: Wikipedia</a></figcaption>
  </figure>`;
}

function renderPlants() {
  const month = currentGardenMonth();
  const filter = $('#garden-filter').value;
  const category = activeGardenCategory();
  const query = $('#plant-search').value.trim().toLowerCase();
  const plants = PLANTS.filter(item => {
    if (!itemInGardenCategory(item, category)) return false;
    if (query && !itemSearchText(item).includes(query)) return false;
    return itemMatchesGardenFilter(item, query && filter === 'current' ? 'all' : filter, month);
  }).sort((a, b) => {
    const activeA = tasksForMonth(a, month).length ? 0 : 1;
    const activeB = tasksForMonth(b, month).length ? 0 : 1;
    return activeA - activeB || categoryInfo(a.category).label.localeCompare(categoryInfo(b.category).label, 'de') || a.name.localeCompare(b.name, 'de');
  });
  const showMushroomSafety = plants.length && (category === 'mushroom' || filter === 'find') && plants.some(isForageItem);
  $('#plant-list').innerHTML = plants.length
    ? `${showMushroomSafety ? mushroomSafetyCard() : ''}${plants.map(item => plantCard(item, month)).join('')}`
    : '<div class="empty-state">Keine passenden Einträge gefunden.</div>';
  hydrateMushroomImages();
}

function monthCellType(item, month) {
  const task = (item.tasks || [])
    .filter(entry => entry.months?.includes(month))
    .sort((a, b) => taskRank(a.type) - taskRank(b.type))[0];
  return task ? taskInfo(task.type).cls : '';
}

function taskChips(item, month) {
  const current = tasksForMonth(item, month);
  const tasks = current.length ? current : (item.tasks || []).slice(0, 3);
  return tasks.map(task => {
    const info = taskInfo(task.type);
    return `<span class="task-chip ${info.cls}">${escapeHtml(info.label)} · ${escapeHtml(task.label)}</span>`;
  }).join('');
}

function plantCard(plant, currentMonth) {
  const category = categoryInfo(plant.category);
  const current = tasksForMonth(plant, currentMonth);
  const cells = Array.from({length:12}, (_, i) => {
    const month = i + 1;
    const cls = monthCellType(plant, month);
    const title = (plant.tasks || []).filter(task => task.months?.includes(month)).map(task => task.label).join(', ') || monthName(month);
    return `<div class="month-cell ${cls} ${month === currentMonth ? 'current' : ''}" title="${escapeHtml(title)}">${month}</div>`;
  }).join('');
  return `<article class="plant-card ${isForageItem(plant) ? 'mushroom-card' : ''}">
    ${isForageItem(plant) ? mushroomImageSlot(plant) : ''}
    <div class="plant-head">
      <div class="plant-title">
        <span class="plant-emoji">${plant.icon}</span>
        <div><h3>${escapeHtml(plant.name)}</h3><small>${category.icon} ${escapeHtml(category.label)}${current.length ? ` · Jetzt: ${current.map(task => escapeHtml(task.label)).join(' · ')}` : ' · Saisonübersicht'}</small></div>
      </div>
    </div>
    <div class="task-chips">${taskChips(plant, currentMonth)}</div>
    <div class="month-row">${cells}</div>
    ${plant.features?.length ? `<div class="mushroom-features"><strong>Merkmale prüfen</strong><ul>${plant.features.map(feature => `<li>${escapeHtml(feature)}</li>`).join('')}</ul></div>` : ''}
    ${plant.habitat ? `<p class="plant-habitat"><strong>Standort:</strong> ${escapeHtml(plant.habitat)}</p>` : ''}
    ${plant.lookalikes ? `<p class="plant-warning"><strong>Verwechslungen:</strong> ${escapeHtml(plant.lookalikes)}</p>` : ''}
    ${plant.warning ? `<p class="plant-warning"><strong>Achtung:</strong> ${escapeHtml(plant.warning)}</p>` : ''}
    <p class="plant-notes">${escapeHtml(plant.notes)}</p>
  </article>`;
}

function currentLocationText() {
  return [state.location.name, state.location.admin1].filter(Boolean).join(', ');
}

function updateRadarLocationLabel() {
  const el = $('#radar-location-text');
  if (el) el.textContent = currentLocationText();
}

function focusRadarOnLocation(force = false) {
  if (!state.map) return;
  const latlng = [state.location.latitude, state.location.longitude];
  const zoom = force ? 10 : Math.max(state.map.getZoom() || 0, 10);
  state.map.setView(latlng, zoom, { animate: !!state.radarFrames.length });
}

function createLocationPinIcon() {
  return L.divIcon({
    className: 'location-pin-marker',
    html: '<div class="location-pin"><span class="pin-pulse"></span><i></i></div>',
    iconSize: [22, 30],
    iconAnchor: [11, 29],
    popupAnchor: [0, -24]
  });
}

function initMap() {
  if (state.map || !window.L) return;
  state.map = L.map('radar-map', { zoomControl:false, minZoom:3, maxZoom:12, attributionControl:false }).setView([state.location.latitude, state.location.longitude], 10);
  state.map.createPane('radarPane');
  state.map.getPane('radarPane').style.zIndex = 450;
  state.radarBaseLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains:'abcd', maxZoom:19, attribution:'&copy; OpenStreetMap &copy; CARTO'
  }).addTo(state.map);
  state.locationMarker = L.marker([state.location.latitude, state.location.longitude], {
    icon: createLocationPinIcon(),
    keyboard: false
  }).addTo(state.map).bindTooltip(state.location.name, { direction:'top', offset:[0, -24] });
  updateRadarLocationLabel();
  setTimeout(() => { state.map.invalidateSize(); focusRadarOnLocation(true); }, 120);
}

function updateMapLocation() {
  if (!state.map) { updateRadarLocationLabel(); return; }
  const latlng = [state.location.latitude, state.location.longitude];
  state.locationMarker?.setLatLng(latlng).bindTooltip(state.location.name, { direction:'top', offset:[0, -24] });
  updateRadarLocationLabel();
  focusRadarOnLocation(true);
}

async function loadRadar() {
  initMap();
  updateMapLocation();
  if (!state.map) {
    $('#radar-message').hidden = false;
    $('#radar-message').textContent = 'Die Kartenbibliothek konnte nicht geladen werden. Bitte Internetverbindung prüfen.';
    return;
  }
  clearRadarLayers();
  $('#radar-status').textContent = 'Lädt …';
  try {
    const meta = await fetchJson('https://api.rainviewer.com/public/weather-maps.json');
    const frames = meta?.radar?.past || [];
    if (!frames.length) throw new Error('Keine Radarframes');
    state.radarFrames = frames;
    state.radarLayers = frames.map(frame => L.tileLayer(`${meta.host}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`, {
      pane:'radarPane',
      tileSize:512, zoomOffset:-1, opacity:0, maxNativeZoom:7, maxZoom:12, attribution:'Radar © RainViewer'
    }).addTo(state.map));
    state.radarLayerMode = 'radar';
    state.radarIndex = frames.length - 1;
    $('#radar-slider').max = String(frames.length - 1);
    $('#radar-slider').value = String(state.radarIndex);
    showRadarFrame(state.radarIndex);
    focusRadarOnLocation(true);
    $('#radar-status').textContent = 'Messbilder';
    $('#radar-message').hidden = true;
    $('#radar-source-note').textContent = liveRadarSourceNote();
    startRadar();
  } catch (error) {
    console.error(error);
    $('#radar-status').textContent = 'Nicht verfügbar';
    $('#radar-message').hidden = false;
    $('#radar-message').textContent = 'Das Regenradar konnte aktuell nicht geladen werden. Wettervorhersage und Pollenanalyse funktionieren weiterhin.';
  }
}

function clearRadarLayers() {
  state.radarLayers.forEach(layer => state.map?.removeLayer(layer));
  state.radarLayers = [];
  state.radarFrames = [];
  state.radarLayerMode = null;
}

function showRadarFrame(index) {
  if (!state.radarLayers.length) return;
  state.radarIndex = clamp(Number(index), 0, state.radarLayers.length - 1);
  state.radarLayers.forEach((layer, i) => {
    const visible = i === state.radarIndex;
    if (layer.setOpacity) {
      layer.setOpacity(visible ? .62 : 0);
    } else if (state.map) {
      if (visible && !state.map.hasLayer(layer)) layer.addTo(state.map);
      if (!visible && state.map.hasLayer(layer)) state.map.removeLayer(layer);
    }
  });
  $('#radar-slider').value = String(state.radarIndex);
  const frame = state.radarFrames[state.radarIndex];
  $('#radar-time').textContent = frame.label || new Intl.DateTimeFormat('de-DE', { hour:'2-digit', minute:'2-digit' }).format(new Date(frame.time * 1000));
}

function iconD2ForecastDates() {
  const times = state.iconD2?.minutely_15?.time || [];
  return [...new Set(times.map(time => String(time).slice(0, 10)).filter(Boolean))];
}

function forecastRadarDate(mode) {
  const offset = mode === 'tomorrow' ? 1 : 0;
  return iconD2ForecastDates()[offset] || null;
}

function iconD2PointsForDate(date) {
  const minutely = state.iconD2?.minutely_15;
  if (!date || !Array.isArray(minutely?.time) || !Array.isArray(minutely?.precipitation)) return [];
  return minutely.time.map((time, index) => ({
    time,
    precipitation:Number(minutely.precipitation[index])
  })).filter(point => point.time?.startsWith(date) && Number.isFinite(point.precipitation));
}

function hasForecastRadarData(mode) {
  if (mode === 'radar') return true;
  return iconD2PointsForDate(forecastRadarDate(mode)).length > 0;
}

function forecastRadarLabels() {
  return [
    hasForecastRadarData('today') ? 'Heute' : null,
    hasForecastRadarData('tomorrow') ? 'Morgen' : null
  ].filter(Boolean);
}

function liveRadarSourceNote() {
  const labels = forecastRadarLabels();
  if (!labels.length) {
    return 'Jetzt zeigt zurückliegende Messbilder. ICON-D2 liefert aktuell keine Prognosedaten für Heute/Morgen.';
  }
  const labelText = labels.join(' und ');
  const suffix = labels.length === 1 ? 'nutzt ICON-D2 als errechnete Niederschlagskarte.' : 'nutzen ICON-D2 als errechnete Niederschlagskarten.';
  return `Jetzt zeigt zurückliegende Messbilder. ${labelText} ${suffix}`;
}

function updateRadarModeAvailability() {
  const buttons = $$('.radar-mode-btn');
  buttons.forEach(button => {
    const available = hasForecastRadarData(button.dataset.radarMode);
    button.hidden = !available;
    button.disabled = !available;
    button.setAttribute('aria-disabled', String(!available));
  });
  const visibleCount = buttons.filter(button => !button.hidden).length || 1;
  $('#radar-modes')?.setAttribute('data-count', String(visibleCount));
  $('#radar-source-note').textContent = liveRadarSourceNote();
}

function radarOffsetLatLng(lat, lon, distanceMeters, angleDeg) {
  const angle = angleDeg * Math.PI / 180;
  const latOffset = Math.cos(angle) * distanceMeters / 111320;
  const lonScale = Math.max(.2, Math.cos(lat * Math.PI / 180));
  const lonOffset = Math.sin(angle) * distanceMeters / (111320 * lonScale);
  return [lat + latOffset, lon + lonOffset];
}

function radarForecastColor(precipitation, probability) {
  const intensity = Math.max(precipitation, probability / 38);
  if (intensity >= 12) return '#b53672';
  if (intensity >= 7) return '#ee7f3b';
  if (intensity >= 4) return '#e2d747';
  if (intensity >= 2) return '#56bb78';
  if (intensity >= .7) return '#2f9ce3';
  return '#64c9f6';
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
  const number = Number.parseInt(full, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ next >>> 15, next | 1);
    next ^= next + Math.imul(next ^ next >>> 7, next | 61);
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

function radarFrameSeed(frame, frameIndex) {
  const key = `${frame.time}-${frameIndex}-${state.location.latitude.toFixed(3)}-${state.location.longitude.toFixed(3)}`;
  let seed = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    seed ^= key.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function forecastRadarBounds(precipitation, probability) {
  const { latitude, longitude } = state.location;
  const radius = clamp(34000 + precipitation * 5200 + probability * 170, 36000, 72000);
  return L.latLngBounds(
    radarOffsetLatLng(latitude, longitude, radius, 315),
    radarOffsetLatLng(latitude, longitude, radius, 135)
  );
}

function drawRadarTextureCell(ctx, x, y, length, width, angle, rgb, alpha) {
  const radius = Math.max(length, width);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  gradient.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`);
  gradient.addColorStop(.58, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * .58})`);
  gradient.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(0, 0, length, width, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function createForecastRadarTexture(frame, frameIndex, color, intensity) {
  const precipitation = safeNumber(frame.precipitation);
  const probability = safeNumber(frame.probability);
  const dry = precipitation < .05 && probability < 18;
  const size = 560;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rgb = hexToRgb(color);
  const rand = seededRandom(radarFrameSeed(frame, frameIndex));
  const bandAngle = ((frameIndex * 17 + probability * 1.8) % 360) * Math.PI / 180;
  const centerX = size * (.5 + Math.sin(frameIndex * .63) * .055);
  const centerY = size * (.5 + Math.cos(frameIndex * .51) * .055);
  const cells = dry ? 18 : clamp(Math.round(36 + intensity * 10 + probability * .45), 40, 118);
  const spread = dry ? .36 : clamp(.28 + intensity * .018 + probability / 760, .3, .48);

  ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  for (let i = 0; i < cells; i += 1) {
    const along = (rand() - .5) * size * 1.18;
    const across = (rand() - .5) * size * spread;
    const x = centerX + Math.cos(bandAngle) * along - Math.sin(bandAngle) * across + (rand() - .5) * 38;
    const y = centerY + Math.sin(bandAngle) * along + Math.cos(bandAngle) * across + (rand() - .5) * 38;
    if (x < -55 || x > size + 55 || y < -55 || y > size + 55) continue;

    const length = dry ? 12 + rand() * 22 : 18 + rand() * 54 + intensity * 2.8;
    const width = dry ? 3 + rand() * 5 : 4 + rand() * 11 + intensity * .75;
    const alpha = dry
      ? .018 + rand() * .018
      : clamp(.036 + intensity * .012 + probability / 2600 + rand() * .052, .028, .17);
    const angle = bandAngle + (rand() - .5) * .95;

    drawRadarTextureCell(ctx, x, y, length, width, angle, rgb, alpha);

    if (!dry && intensity >= 1.3 && i % 7 === 0) {
      drawRadarTextureCell(ctx, x + (rand() - .5) * 18, y + (rand() - .5) * 18, length * .36, width * .5, angle, hexToRgb(radarForecastColor(precipitation * 1.7, probability + 18)), alpha * 1.35);
    }

    if (!dry && i % 5 === 0) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * .72})`;
      ctx.lineWidth = clamp(width * .18, .6, 1.8);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-length * .55, (rand() - .5) * width);
      ctx.quadraticCurveTo(0, (rand() - .5) * width * 1.8, length * .52, (rand() - .5) * width);
      ctx.stroke();
      ctx.restore();
    }
  }

  return canvas.toDataURL('image/png');
}

function createForecastRadarLayer(frame, frameIndex) {
  const precipitation = safeNumber(frame.precipitation);
  const probability = safeNumber(frame.probability);
  const intensity = Math.max(precipitation, probability / 45);
  const color = radarForecastColor(precipitation, probability);
  const texture = createForecastRadarTexture(frame, frameIndex, color, intensity);
  const overlay = L.imageOverlay(texture, forecastRadarBounds(precipitation, probability), {
    pane:'radarPane',
    opacity:.74,
    interactive:false,
    className:'forecast-radar-image',
    alt:'ICON-D2 Niederschlagsprognose'
  });
  return L.layerGroup([overlay]);
}

function iconD2DailySum(date, frames) {
  const daily = state.iconD2?.daily;
  const index = daily?.time?.findIndex(day => day === date) ?? -1;
  const dailyValue = index >= 0 ? Number(daily.precipitation_sum?.[index]) : NaN;
  if (Number.isFinite(dailyValue)) return dailyValue;
  return frames.reduce((sum, frame) => sum + safeNumber(frame.amount), 0);
}

function buildIconD2RadarFrames(date) {
  const groups = new Map();
  iconD2PointsForDate(date).forEach(point => {
    const minute = Number(point.time.slice(14, 16));
    const roundedMinute = minute < 30 ? '00' : '30';
    const key = `${point.time.slice(0, 14)}${roundedMinute}`;
    if (!groups.has(key)) groups.set(key, { time:key, amount:0, count:0 });
    const group = groups.get(key);
    group.amount += point.precipitation;
    group.count += 1;
  });

  return [...groups.values()].map(group => {
    const rate = group.amount * 2;
    return {
      kind:'icon-d2',
      time:group.time,
      label:group.time.slice(11, 16),
      amount:group.amount,
      precipitation:rate,
      probability:group.amount > .02 ? clamp(42 + rate * 22, 45, 96) : 0
    };
  });
}

function renderForecastRadar(mode = 'today') {
  if (!state.map) return;
  if (!hasForecastRadarData(mode)) {
    updateRadarModeAvailability();
    setRadarMode('radar');
    return;
  }

  const date = forecastRadarDate(mode);
  if (!date) {
    clearRadarLayers();
    $('#radar-status').textContent = 'Keine Daten';
    $('#radar-message').hidden = false;
    $('#radar-message').textContent = 'Für diesen Tag liegt keine Radar-Prognose vor.';
    return;
  }

  const label = mode === 'tomorrow' ? 'Morgen' : 'Heute';
  const frames = buildIconD2RadarFrames(date);
  const rainSum = iconD2DailySum(date, frames);
  if (!frames.length) {
    clearRadarLayers();
    $('#radar-status').textContent = 'Keine Daten';
    $('#radar-time').textContent = '–';
    $('#radar-message').hidden = false;
    $('#radar-message').textContent = 'Für diesen Tag liegen keine stündlichen Niederschlagsdaten vor.';
    return;
  }

  clearRadarLayers();
  state.radarFrames = frames;
  state.radarLayers = state.radarFrames.map(createForecastRadarLayer);
  state.radarLayerMode = mode;
  state.radarIndex = state.radarFrames.reduce((best, frame, index, frames) => {
    const score = frame.amount * 8 + frame.precipitation * 2 + frame.probability / 100;
    const bestScore = frames[best].amount * 8 + frames[best].precipitation * 2 + frames[best].probability / 100;
    return score > bestScore ? index : best;
  }, 0);
  $('#radar-slider').max = String(Math.max(0, state.radarFrames.length - 1));
  $('#radar-slider').value = String(state.radarIndex);
  $('#radar-status').textContent = `${label} ${rainSum.toFixed(1).replace('.', ',')} mm`;
  $('#radar-message').hidden = !(rainSum < .05);
  $('#radar-message').textContent = `${label}: ICON-D2 erwartet kaum Niederschlag.`;
  $('#radar-source-note').textContent = `${label} nutzt ICON-D2-15-Minuten-Daten als errechnete Niederschlagskarte.`;
  showRadarFrame(state.radarIndex);
  focusRadarOnLocation(true);
  startRadar();
}

function setRadarMode(mode = 'radar') {
  updateRadarModeAvailability();
  if (mode !== 'radar' && !hasForecastRadarData(mode)) mode = 'radar';
  const isRadar = mode === 'radar';
  $$('.radar-mode-btn').forEach(button => {
    const active = button.dataset.radarMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  $('.radar-card')?.classList.toggle('forecast-mode', !isRadar);

  if (isRadar) {
    $('#radar-status').textContent = state.radarLayerMode === 'radar' && state.radarFrames.length ? 'Messbilder' : 'Live';
    if ($('#view-radar').classList.contains('active')) {
      initMap();
      state.map?.invalidateSize();
      updateMapLocation();
      if (state.radarLayerMode !== 'radar' || !state.radarFrames.length) loadRadar(); else startRadar();
    }
  } else {
    stopRadar();
    initMap();
    state.map?.invalidateSize();
    updateMapLocation();
    renderForecastRadar(mode);
  }
}

function startRadar() {
  if (!state.radarLayers.length) return;
  stopRadar();
  state.radarPlaying = true;
  $('#radar-play').textContent = '❚❚';
  const interval = state.radarLayerMode === 'radar' ? 750 : 1250;
  state.radarTimer = setInterval(() => showRadarFrame((state.radarIndex + 1) % state.radarFrames.length), interval);
}

function stopRadar() {
  if (state.radarTimer) clearInterval(state.radarTimer);
  state.radarTimer = null;
  state.radarPlaying = false;
  if ($('#radar-play')) $('#radar-play').textContent = '▶';
}

function scrollAppToTop(behavior = 'smooth') {
  const shell = $('.app-shell');
  if (shell) shell.scrollTo({ top: 0, behavior });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setupNavigation() {
  const navButtons = $$('.nav-item');
  navButtons.forEach((button, index) => button.addEventListener('click', () => {
    if (button.classList.contains('active')) {
      scrollAppToTop();
      return;
    }

    const activeIndex = navButtons.findIndex(item => item.classList.contains('active'));
    document.documentElement.dataset.navDirection = activeIndex >= 0 && index < activeIndex ? 'back' : 'forward';
    const view = button.dataset.view;
    navButtons.forEach(b => b.classList.toggle('active', b === button));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    scrollAppToTop();
    if (view === 'radar') {
      setTimeout(() => {
        const radarMode = $('.radar-mode-btn.active')?.dataset.radarMode || 'radar';
        setRadarMode(radarMode);
      }, 80);
    } else stopRadar();
  }));
}

function openLocationPanel({ focusSearch = false } = {}) {
  const panel = $('#location-panel');
  if (!panel) return;
  updateLocationPanelTitle();
  renderFavorites();
  updateFavoriteButton();
  panel.hidden = false;
  $('#location-open')?.setAttribute('aria-expanded', 'true');
  if (focusSearch) setTimeout(() => $('#location-search')?.focus(), 80);
}

function closeLocationPanel() {
  const panel = $('#location-panel');
  if (!panel) return;
  panel.hidden = true;
  $('#location-open')?.setAttribute('aria-expanded', 'false');
  $('#location-search').value = '';
  $('#search-results').hidden = true;
}

function setupSearch() {
  const input = $('#location-search');
  const resultsBox = $('#search-results');
  const locationTrigger = $('#location-open');
  let timer;

  locationTrigger?.setAttribute('aria-expanded', 'false');
  locationTrigger?.addEventListener('click', () => {
    const panel = $('#location-panel');
    if (panel?.hidden) openLocationPanel();
    else closeLocationPanel();
  });
  locationTrigger?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openLocationPanel();
    }
  });

  input.addEventListener('focus', () => openLocationPanel());
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) { resultsBox.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const data = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=7&language=de&format=json`);
        const results = data.results || [];
        resultsBox.innerHTML = results.length ? results.map((r,i) => `<button class="search-result" data-index="${i}"><span><strong>${escapeHtml(r.name)}</strong><br><small>${escapeHtml([r.admin1,r.country].filter(Boolean).join(', '))}</small></span><small>${round(r.elevation)} m</small></button>`).join('') : '<div class="empty-state">Kein Ort gefunden.</div>';
        resultsBox.hidden = false;
        $$('.search-result').forEach(btn => btn.addEventListener('click', () => {
          const r = results[Number(btn.dataset.index)];
          closeLocationPanel();
          setLocation(r);
        }));
      } catch { toast('Ortssuche derzeit nicht verfügbar'); }
    }, 350);
  });

  $('#search-clear').addEventListener('click', () => {
    if (input.value.trim()) {
      input.value = '';
      resultsBox.hidden = true;
      input.focus();
    } else {
      closeLocationPanel();
    }
  });
  $('#location-panel-close')?.addEventListener('click', closeLocationPanel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeLocationPanel();
  });
  document.addEventListener('click', event => {
    if (event.target.closest('#location-panel') || event.target.closest('#location-open')) return;
    closeLocationPanel();
  });
}

function setupGeolocation() {
  $('#locate-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Standortbestimmung wird nicht unterstützt');
    toast('Standort wird ermittelt …');
    navigator.geolocation.getCurrentPosition(async position => {
      const loc = { name:'Mein Standort', latitude:position.coords.latitude, longitude:position.coords.longitude };
      try {
        const reverse = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${position.coords.latitude.toFixed(3)},${position.coords.longitude.toFixed(3)}&count=1&language=de&format=json`);
        if (reverse.results?.[0]) loc.name = reverse.results[0].name;
      } catch {}
      setLocation(loc);
      closeLocationPanel();
    }, error => toast(error.code === 1 ? 'Standortfreigabe wurde abgelehnt' : 'Standort konnte nicht ermittelt werden'), { enableHighAccuracy:false, timeout:12000, maximumAge:600000 });
  });
}

function setupFavorites() {
  $('#favorite-toggle').addEventListener('click', () => {
    toggleCurrentFavorite();
    renderFavorites();
  });
  $('#favorites-list').addEventListener('click', event => {
    const select = event.target.closest('[data-favorite-key]');
    if (select) {
      const item = state.favorites.find(favorite => locationKey(favorite) === select.dataset.favoriteKey);
      if (item) {
        setLocation(item);
        closeLocationPanel();
      }
      return;
    }
    const remove = event.target.closest('[data-remove-key]');
    if (remove) {
      const index = state.favorites.findIndex(favorite => locationKey(favorite) === remove.dataset.removeKey);
      if (index >= 0) {
        const [item] = state.favorites.splice(index, 1);
        saveFavorites();
        toast(`${item.name} aus Favoriten entfernt`);
      }
    }
  });
}

function setupTheme() {
  const themes = ['blue', 'light', 'dark'];
  const themeColors = { blue:'#0a6fae', light:'#e8edf2', dark:'#202a33' };
  const themeLabels = { blue:'Blau', light:'Hell', dark:'Dunkel' };
  const button = $('#theme-toggle');
  const dialog = $('#settings-dialog');
  const close = $('#settings-dialog-close');
  const options = $$('.theme-option');
  const applyTheme = theme => {
    const next = themes.includes(theme) ? theme : 'blue';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('wg-theme', next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[next]);
    options.forEach(option => {
      const active = option.dataset.themeOption === next;
      option.classList.toggle('active', active);
      option.setAttribute('aria-checked', String(active));
    });
    if (button) button.title = `Darstellung: ${themeLabels[next]}`;
  };

  applyTheme(localStorage.getItem('wg-theme') || 'blue');
  button?.addEventListener('click', () => dialog?.showModal());
  close?.addEventListener('click', () => dialog?.close());
  $('#theme-options')?.addEventListener('click', event => {
    const option = event.target.closest('[data-theme-option]');
    if (option) applyTheme(option.dataset.themeOption);
  });
}

function setupEvents() {
  $('#forecast-info').addEventListener('click', () => $('#info-dialog').showModal());
  $('#info-dialog .dialog-close').addEventListener('click', () => $('#info-dialog').close());
  $('#day-dialog-close').addEventListener('click', () => $('#day-dialog').close());
  $('#forecast-grid').addEventListener('click', event => {
    const card = event.target.closest('[data-forecast-index]');
    if (card) openDayDetails(Number(card.dataset.forecastIndex));
  });
  $('#daily-overview').addEventListener('click', event => {
    const row = event.target.closest('[data-overview-index]');
    if (row) openDayDetails(Number(row.dataset.overviewIndex));
  });
  $('#radar-play').addEventListener('click', () => state.radarPlaying ? stopRadar() : startRadar());
  $('#radar-slider').addEventListener('input', event => { stopRadar(); showRadarFrame(event.target.value); });
  $('#radar-modes').addEventListener('click', event => {
    const button = event.target.closest('[data-radar-mode]');
    if (button) setRadarMode(button.dataset.radarMode);
  });
  $('#plant-search').addEventListener('input', renderPlants);
  $('#garden-filter').addEventListener('change', renderPlants);
  $('#garden-category-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-garden-category]');
    if (!button) return;
    $$('#garden-category-tabs .garden-category-btn').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderPlants();
  });
}

function registerPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}

function isInstalledPwa() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;
}

function showInstallPanel(mode = 'prompt') {
  const panel = $('#install-panel');
  const button = $('#install-app-btn');
  if (!panel || isInstalledPwa() || sessionStorage.getItem('wg-install-dismissed') === '1') return;
  const manual = mode === 'manual';
  $('#install-title').textContent = manual ? 'Wetter App zum Startbildschirm hinzufügen' : 'Wetter App installieren';
  $('#install-copy').textContent = manual
    ? 'Öffne das Browser-Menü und wähle “Installieren” oder “Zum Home-Bildschirm”. Danach startet die App ohne Browserleiste.'
    : 'Installiere die App für Startbildschirm, Offline-Start und Vollbildmodus.';
  if (button) button.hidden = manual;
  panel.hidden = false;
}

function hideInstallPanel({ remember = false } = {}) {
  const panel = $('#install-panel');
  if (panel) panel.hidden = true;
  if (remember) sessionStorage.setItem('wg-install-dismissed', '1');
}

function setupInstallPrompt() {
  if (isInstalledPwa()) {
    hideInstallPanel();
    return;
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    showInstallPanel('prompt');
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    hideInstallPanel({ remember: true });
    toast('App wurde installiert');
  });

  $('#install-app-btn')?.addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) {
      showInstallPanel('manual');
      return;
    }
    const promptEvent = state.deferredInstallPrompt;
    state.deferredInstallPrompt = null;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') hideInstallPanel({ remember: true });
  });

  $('#install-dismiss')?.addEventListener('click', () => hideInstallPanel({ remember: true }));

  setTimeout(() => {
    const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const likelyMobile = window.matchMedia('(max-width: 900px)').matches || navigator.maxTouchPoints > 0;
    if (!state.deferredInstallPrompt && (isAppleMobile || likelyMobile) && !isInstalledPwa()) showInstallPanel('manual');
  }, 2500);
}

function init() {
  $('#location-label').textContent = currentLocationText();
  updateLocationPanelTitle();
  updateRadarLocationLabel();
  updateRadarModeAvailability();
  setupNavigation();
  setupSearch();
  setupGeolocation();
  setupFavorites();
  renderFavorites();
  updateFavoriteButton();
  setupTheme();
  setupEvents();
  setupInstallPrompt();
  registerPwa();
  loadAllData();
}

document.addEventListener('DOMContentLoaded', init);
