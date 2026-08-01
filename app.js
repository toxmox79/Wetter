'use strict';

const DEFAULT_LOCATION = { name: 'Bad Windsheim', latitude: 49.5027, longitude: 10.4154, timezone: 'Europe/Berlin' };
const state = {
  location: JSON.parse(localStorage.getItem('wg-location') || 'null') || DEFAULT_LOCATION,
  weather: null,
  ensemble: null,
  pollen: null,
  map: null,
  locationMarker: null,
  radarFrames: [],
  radarLayers: [],
  radarIndex: 0,
  radarTimer: null,
  radarPlaying: true,
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
  button.textContent = active ? '★' : '☆';
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? 'Ort aus Favoriten entfernen' : 'Ort zu Favoriten hinzufügen');
  button.title = active ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen';
}

function renderFavorites() {
  const bar = $('#favorites-bar');
  const list = $('#favorites-list');
  if (!bar || !list) return;
  bar.hidden = state.favorites.length === 0;
  const currentKey = locationKey(state.location);
  list.innerHTML = state.favorites.map(item => {
    const key = locationKey(item);
    const label = [item.name, item.admin1].filter(Boolean).join(', ');
    return `<div class="favorite-chip ${key === currentKey ? 'current' : ''}" data-key="${key}">
      <button type="button" class="favorite-select" data-favorite-key="${key}" aria-label="${escapeHtml(label)} öffnen">${escapeHtml(item.name)}</button>
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

const pad2 = value => String(value).padStart(2, '0');
const formatShortHour = hour => `${pad2(hour)}:00`;
const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const formatHours = seconds => {
  const h = safeNumber(seconds) / 3600;
  if (h <= 0) return '0 h';
  return `${(Math.round(h * 10) / 10).toString().replace('.', ',')} h`;
};
const formatMinutes = seconds => `${Math.round(safeNumber(seconds) / 60)} min`;
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

const PLANTS = [
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

const MONTH_RULES = {
  1: ['Ist der Januar hell und weiß, wird der Sommer gerne heiß.', 'Januar muss vor Kälte knacken, wenn die Ernte soll gut sacken.'],
  2: ['Nordwind im Februar bringt beständiges Wetter im Jahr.', 'Wenn es an Lichtmess stürmt und schneit, ist der Frühling nicht mehr weit.'],
  3: ['Märzenstaub bringt Gras und Laub.', 'Wie das Wetter zu Frühlingsanfang, so hält es sich noch lange an.'],
  4: ['April, April, der weiß nicht, was er will.', 'Nasser April verspricht der Früchte viel.'],
  5: ['Mairegen bringt Segen.', 'Ein kühler Mai wird hoch geacht’, hat stets ein gutes Jahr gebracht.'],
  6: ['Soll gedeihen Korn und Wein, muss im Juni Regen sein.', 'Ist der Juni warm und nass, gibt’s viel Korn und noch mehr Gras.'],
  7: ['Was Juli und August nicht kochen, lässt der September ungebraten.', 'Im Juli warmer Sonnenschein macht alle Früchte reif und fein.'],
  8: ['Im August viel Tau, bleibt der Himmel meist blau.', 'Augustregen wirkt wie Gift, wenn er die reifenden Trauben trifft.'],
  9: ['September warm und klar, verheißt ein gutes nächstes Jahr.', 'Viel Nebel im September über Tal und Höh’, bringt im Winter tiefen Schnee.'],
  10: ['Oktoberhimmel voller Sterne hat warme Öfen gerne.', 'Ist der Oktober warm und fein, kommt ein scharfer Winter hinterdrein.'],
  11: ['Wenn im November die Wasser steigen, wird sich ein nasser Winter zeigen.', 'November hell und klar ist übel fürs nächste Jahr.'],
  12: ['Dezember kalt mit Schnee gibt Korn auf jeder Höh’.', 'Ist der Dezember wild mit Regen, hat das nächste Jahr wenig Segen.']
};

const DATE_RULES = {
  '02-02': 'Wenn’s an Lichtmess stürmt und schneit, ist der Frühling nicht mehr weit.',
  '24-02': 'Matheis bricht das Eis; hat er keins, so macht er eins.',
  '12-03': 'An Gregor zeigt sich: Tag und Nacht sind gleich.',
  '23-04': 'Georg und Markus ganz ohne Trost, erschrecken uns sehr oft mit Frost.',
  '11-05': 'Vor Nachtfrost du nie sicher bist, bis Sophie vorüber ist.',
  '15-05': 'Die kalte Sophie macht alles hie.',
  '24-06': 'Vor dem Johannistag man Gerst und Hafer nicht loben mag.',
  '27-06': 'Das Wetter am Siebenschläfertag sieben Wochen bleiben mag.',
  '20-07': 'Margaretenregen wird erst nach Monatsfrist sich legen.',
  '24-08': 'Wie sich das Wetter an Bartholomäus stellt, so ist der ganze Herbst bestellt.',
  '29-09': 'Regnet’s am Michaelistag, folgt ein milder Winter nach.',
  '11-11': 'Hat Martini einen weißen Bart, wird der Winter lang und hart.',
  '30-11': 'Andreas-Schnee tut den Saaten weh.',
  '04-12': 'Knospen an Sankt Barbara, sind zum Christfest Blüten da.'
};

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
  $('#location-label').textContent = [state.location.name, state.location.admin1].filter(Boolean).join(', ');
  renderFavorites();
  updateFavoriteButton();
  loadAllData();
}

async function loadAllData() {
  $('#weather-loading').hidden = true;
  $('#weather-content').hidden = false;
  stopRadar();
  const tasks = [loadWeather(), loadPollen()];
  await Promise.allSettled(tasks);
  if (state.weather) {
    renderWeather();
    renderGarden();
  }
  updateMapLocation();
  if ($('#view-radar').classList.contains('active')) loadRadar();
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
  $('#current-icon').textContent = icon;
  $('#current-temp').textContent = round(w.current.temperature_2m);
  $('#current-condition').textContent = condition;
  $('#current-feels').textContent = `${round(w.current.apparent_temperature)}°`;
  $('#current-humidity').textContent = `${round(w.current.relative_humidity_2m)}%`;
  $('#current-wind').textContent = `${round(w.current.wind_speed_10m)} km/h`;
  $('#current-rain').textContent = `${Number(w.current.precipitation || 0).toFixed(1)} mm`;
  renderFarmerRule();
  renderHourly();
  renderDailyOverview();
  renderForecast();
}

function renderFarmerRule() {
  const now = new Date();
  const key = `${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  let quote = DATE_RULES[key];
  if (!quote && state.weather) {
    const current = state.weather.current;
    const next3Rain = state.weather.daily.precipitation_sum.slice(0,3).reduce((a,b)=>a+(b||0),0);
    const min3 = Math.min(...state.weather.daily.temperature_2m_min.slice(0,3));
    const max3 = Math.max(...state.weather.daily.temperature_2m_max.slice(0,3));
    const wind = current.wind_speed_10m || 0;
    if (min3 <= 1) quote = 'Frost im Frühling schadet Wein und jungen Dingen.';
    else if (next3Rain >= 18) quote = 'Regnet’s sanft auf die Saaten, darf der Gärtner Gutes erwarten.';
    else if (max3 >= 29) quote = 'Viel Sonne und wenig Regen, heißt den Gärtner fleißig wässern.';
    else if (wind >= 35) quote = 'Starker Wind und heller Schein bringen oft beständiges Wetter herein.';
  }
  if (!quote) {
    const rules = MONTH_RULES[now.getMonth()+1];
    quote = rules[(now.getDate() + now.getMonth()) % rules.length];
  }
  $('#farmer-quote').textContent = `„${quote}“`;
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
      <div class="hour-icon">${icon}</div>
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
      <div class="day-icon">${icon}</div>
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
      <div class="forecast-icon" title="${escapeHtml(condition)}">${icon}</div>
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
  $('#day-dialog-title').textContent = `${icon} ${index === 0 ? 'Heute' : fullDate}`;
  $('#day-dialog-subtitle').textContent = `${condition} · ${round(daily.temperature_2m_min[index])}° bis ${round(daily.temperature_2m_max[index])}°`;

  const segments = [
    describeSegment(date, 'Nacht', 0, 6, daily.temperature_2m_min[index]),
    describeSegment(date, 'Tag', 6, 18, daily.temperature_2m_max[index]),
    describeSegment(date, 'Abend', 18, 24, daily.temperature_2m_min[index])
  ];
  $('#day-periods').innerHTML = segments.map(segment => `<article class="day-period-card">
    <div>
      <div class="label">${segment.label}</div>
      <div class="icon">${segment.icon}</div>
      <div class="temp">${round(segment.temp)}°<span>${round(segment.tempAlt)}°</span></div>
    </div>
    <div class="meta">
      <span>${escapeHtml(segment.condition)}</span>
      <span>💧 ${round(segment.precipProbability)}% · ${segment.precipitation.toFixed(1)} mm</span>
      <span>🜃 ${round(segment.wind)} km/h</span>
    </div>
  </article>`).join('');

  $('#day-dialog-metrics').innerHTML = [
    ['UV-Index', `${Number(daily.uv_index_max[index] || 0).toFixed(1)}`, 'Tagesmaximum'],
    ['Sonnenschein', formatHours(daily.sunshine_duration?.[index]), 'am Tag'],
    ['Wind / Böen', `${round(daily.wind_speed_10m_max[index])} km/h`, `Böen ${round(daily.wind_gusts_10m_max[index])} km/h`],
    ['Sonne', hourLabel(daily.sunrise[index]), `Untergang ${hourLabel(daily.sunset[index])}`]
  ].map(([label, value, sub]) => `<div class="day-metric"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`).join('');

  $('#day-hourly-table').innerHTML = indices.map(i => {
    const [, hourIcon] = weatherInfo(hourly.weather_code[i]);
    const fromHour = Number(hourly.time[i].slice(11, 13));
    const desc = weatherInfo(hourly.weather_code[i])[0];
    return `<article class="day-hour-row">
      <div class="time">${formatShortHour(fromHour)}<small>bis ${formatShortHour((fromHour + 1) % 24)}</small></div>
      <div class="weather">
        <div class="icon">${hourIcon}</div>
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
  state.map = L.map('radar-map', { zoomControl:true, minZoom:3, maxZoom:12 }).setView([state.location.latitude, state.location.longitude], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:19, attribution:'&copy; OpenStreetMap-Mitwirkende'
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
  $('#radar-status').textContent = 'Lädt …';
  try {
    const meta = await fetchJson('https://api.rainviewer.com/public/weather-maps.json');
    const frames = meta?.radar?.past || [];
    if (!frames.length) throw new Error('Keine Radarframes');
    clearRadarLayers();
    state.radarFrames = frames;
    state.radarLayers = frames.map(frame => L.tileLayer(`${meta.host}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`, {
      tileSize:512, zoomOffset:-1, opacity:0, maxNativeZoom:7, maxZoom:12, attribution:'Radar © RainViewer'
    }).addTo(state.map));
    state.radarIndex = frames.length - 1;
    $('#radar-slider').max = String(frames.length - 1);
    $('#radar-slider').value = String(state.radarIndex);
    showRadarFrame(state.radarIndex);
    focusRadarOnLocation(true);
    $('#radar-status').textContent = 'Messbilder';
    $('#radar-message').hidden = true;
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
}

function showRadarFrame(index) {
  if (!state.radarLayers.length) return;
  state.radarIndex = clamp(Number(index), 0, state.radarLayers.length - 1);
  state.radarLayers.forEach((layer, i) => layer.setOpacity(i === state.radarIndex ? .72 : 0));
  $('#radar-slider').value = String(state.radarIndex);
  const frame = state.radarFrames[state.radarIndex];
  $('#radar-time').textContent = new Intl.DateTimeFormat('de-DE', { hour:'2-digit', minute:'2-digit' }).format(new Date(frame.time * 1000));
}

function startRadar() {
  stopRadar();
  state.radarPlaying = true;
  $('#radar-play').textContent = '❚❚';
  state.radarTimer = setInterval(() => showRadarFrame((state.radarIndex + 1) % state.radarFrames.length), 750);
}

function stopRadar() {
  if (state.radarTimer) clearInterval(state.radarTimer);
  state.radarTimer = null;
  state.radarPlaying = false;
  if ($('#radar-play')) $('#radar-play').textContent = '▶';
}

function setupNavigation() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => {
    const view = button.dataset.view;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b === button));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    window.scrollTo({top:0, behavior:'smooth'});
    if (view === 'radar') {
      setTimeout(() => {
        initMap();
        state.map?.invalidateSize();
        focusRadarOnLocation(true);
        if (!state.radarFrames.length) loadRadar(); else { updateMapLocation(); startRadar(); }
      }, 80);
    } else stopRadar();
  }));
}

function setupSearch() {
  const input = $('#location-search');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) { $('#search-results').hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const data = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=7&language=de&format=json`);
        const results = data.results || [];
        $('#search-results').innerHTML = results.length ? results.map((r,i) => `<button class="search-result" data-index="${i}"><span><strong>${escapeHtml(r.name)}</strong><br><small>${escapeHtml([r.admin1,r.country].filter(Boolean).join(', '))}</small></span><small>${round(r.elevation)} m</small></button>`).join('') : '<div class="empty-state">Kein Ort gefunden.</div>';
        $('#search-results').hidden = false;
        $$('.search-result').forEach(btn => btn.addEventListener('click', () => {
          const r = results[Number(btn.dataset.index)];
          input.value = '';
          $('#search-results').hidden = true;
          setLocation(r);
        }));
      } catch { toast('Ortssuche derzeit nicht verfügbar'); }
    }, 350);
  });
  $('#search-clear').addEventListener('click', () => { input.value=''; $('#search-results').hidden=true; input.focus(); });
  document.addEventListener('click', event => { if (!event.target.closest('.search-panel')) $('#search-results').hidden = true; });
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
    }, error => toast(error.code === 1 ? 'Standortfreigabe wurde abgelehnt' : 'Standort konnte nicht ermittelt werden'), { enableHighAccuracy:false, timeout:12000, maximumAge:600000 });
  });
}

function setupFavorites() {
  $('#favorite-toggle').addEventListener('click', toggleCurrentFavorite);
  $('#favorites-list').addEventListener('click', event => {
    const select = event.target.closest('[data-favorite-key]');
    if (select) {
      const item = state.favorites.find(favorite => locationKey(favorite) === select.dataset.favoriteKey);
      if (item) setLocation(item);
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
  const saved = localStorage.getItem('wg-theme');
  if (saved === 'dark') document.documentElement.dataset.theme = 'dark';
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('wg-theme', dark ? 'dark' : 'light');
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
  $('#plant-search').addEventListener('input', renderPlants);
  $('#garden-filter').addEventListener('change', renderPlants);
}

function registerPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}

function init() {
  $('#location-label').textContent = currentLocationText();
  updateRadarLocationLabel();
  setupNavigation();
  setupSearch();
  setupGeolocation();
  setupFavorites();
  renderFavorites();
  updateFavoriteButton();
  setupTheme();
  setupEvents();
  registerPwa();
  loadAllData();
}

document.addEventListener('DOMContentLoaded', init);
