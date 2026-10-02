// Juego de Municipios de Puerto Rico 🇵🇷
// Modos:
//  - "pistas": verde=correcto, rojo=cerca (<40km), azul=lejos. + distancia y dirección.
//  - "ciego": sin colores ni distancia. Gris = fallado, verde = correcto.

const GEOJSON_URL =
  "https://services.arcgis.com/XG15cJAlne2vxtgt/ArcGIS/rest/services/Puerto_Rico_Municipalities/FeatureServer/0/query?where=1%3D1&outFields=NAME&f=geojson";
const FALLBACK_URL =
  "https://raw.githubusercontent.com/wreillo/geojson-pr/main/puerto-rico.geojson";

const CERCA_KM = 40;
const MAX_AZUL_KM = 120;
const GRIS_FALLO = "#94a3b8";
const VERDE = "#16a34a";

const MUNICIPIOS = ["Adjuntas","Aguada","Aguadilla","Aguas Buenas","Aibonito","Añasco","Arecibo","Arroyo","Barceloneta","Barranquitas","Bayamón","Cabo Rojo","Caguas","Camuy","Canóvanas","Carolina","Cataño","Cayey","Ceiba","Ciales","Cidra","Coamo","Comerío","Corozal","Culebra","Dorado","Fajardo","Florida","Guánica","Guayama","Guayanilla","Guaynabo","Gurabo","Hatillo","Hormigueros","Humacao","Isabela","Jayuya","Juana Díaz","Juncos","Lajas","Lares","Las Marías","Las Piedras","Loíza","Luquillo","Manatí","Maricao","Maunabo","Mayagüez","Moca","Morovis","Naguabo","Naranjito","Orocovis","Patillas","Peñuelas","Ponce","Quebradillas","Rincón","Río Grande","Sabana Grande","Salinas","San Germán","San Juan","San Lorenzo","San Sebastián","Santa Isabel","Toa Alta","Toa Baja","Trujillo Alto","Utuado","Vega Alta","Vega Baja","Vieques","Villalba","Yabucoa","Yauco"];

const norm = (s) => (s || "").trim().toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

let map, geoLayer;
let featuresByNorm = {};
let targetNorm = null, targetName = null;
let attempts = 0, guessed = new Set(), gameOver = false;

const $ = (id) => document.getElementById(id);
const modo = () => $("mode-select").value; // "pistas" | "ciego"
const maxIntentos = () => parseInt($("max-select").value, 10) || 0; // 0 = ilimitado

// ---------- estadísticas ----------
const STATS_KEY = "pr-muni-stats-v1";
let stats = { wins: 0, games: 0, streak: 0, best: 0 };
try {
  const s = JSON.parse(localStorage.getItem(STATS_KEY));
  if (s) stats = { ...stats, ...s };
} catch {}
function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch {}
  $("stat-wins").textContent = stats.wins;
  $("stat-games").textContent = stats.games;
  $("stat-streak").textContent = stats.streak;
  $("stat-best").textContent = stats.best;
}
function registrarVictoria() {
  stats.wins++; stats.games++; stats.streak++;
  stats.best = Math.max(stats.best, stats.streak);
  saveStats();
}
function registrarDerrota() {
  stats.games++; stats.streak = 0;
  saveStats();
}

// ---------- mapa base: calles / satélite / mar (sin API key) ----------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([18.22, -66.45], 9);

  const calles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap", maxZoom: 13, minZoom: 8
  });
  const satelite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Esri World Imagery", maxZoom: 13, minZoom: 8
  });
  const mar = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Esri Ocean", maxZoom: 12, minZoom: 8
  });
  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap &copy; OpenTopoMap", maxZoom: 13, minZoom: 8
  });

  topo.addTo(map);
  L.control.layers(
    { "🛣️ Calles": calles, "🛰️ Satélite": satelite, "🌊 Mar": mar, "⛰️ Topográfico": topo },
    null, { position: "topright", collapsed: false }
  ).addTo(map);
}

function baseStyle() {
  return { color: "#334155", weight: 1, fillColor: "#ffffff", fillOpacity: 0.9 };
}

// ---------- colores ----------
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function mix(c1, c2, t) {
  return `rgb(${lerp(c1[0],c2[0],t)},${lerp(c1[1],c2[1],t)},${lerp(c1[2],c2[2],t)})`;
}
function colorPorDistancia(km) {
  if (km < 0.5) return VERDE;
  if (km <= CERCA_KM) {
    const t = 1 - km / CERCA_KM;
    return mix([254,202,202], [185,28,28], 0.15 + 0.85 * t);
  }
  const t = Math.min(1, (km - CERCA_KM) / (MAX_AZUL_KM - CERCA_KM));
  return mix([219,234,254], [30,64,175], 0.15 + 0.85 * t);
}
function etiquetaCercania(km) {
  if (km < 0.5) return "¡Correcto! 🎉";
  if (km < 10) return "🥵 ¡Muy caliente! Muy cerca";
  if (km < 25) return "🟥 Cerca";
  if (km < 60) return "🟦 Lejos";
  return "🧊 ¡Muy frío! Muy lejos";
}
function havKm(a, b) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180,
    dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 +
    Math.cos(a.lat*Math.PI/180) * Math.cos(b.lat*Math.PI/180) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function direccion(desde, hacia) {
  const dLat = hacia.lat - desde.lat, dLng = hacia.lng - desde.lng;
  const ang = Math.atan2(dLng, dLat) * 180 / Math.PI;
  const dirs = [["N",-22.5,22.5],["NE",22.5,67.5],["E",67.5,112.5],["SE",112.5,157.5],["S",157.5,180],["S",-180,-157.5],["SO",-157.5,-112.5],["O",-112.5,-67.5],["NO",-67.5,-22.5]];
  let a = ((ang + 540) % 360) - 180;
  for (const [n, lo, hi] of dirs) if (a >= lo && a < hi) return n;
  return "N";
}
function getPropNombre(p) {
  return p.NAME || p.name || p.municipio || p.MUNICIPIO || p.NOMBRE || null;
}

// ---------- carga ----------
function initDatalist(names) {
  const dl = $("municipios-list");
  dl.innerHTML = "";
  [...names].sort((a,b)=>a.localeCompare(b,"es")).forEach(n => {
    const o = document.createElement("option");
    o.value = n;
    dl.appendChild(o);
  });
}

async function cargarGeoJSON() {
  let data = null, lastErr = null;
  for (const url of [GEOJSON_URL, FALLBACK_URL]) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error("No se pudo cargar el GeoJSON");

  geoLayer = L.geoJSON(data, {
    style: baseStyle,
    onEachFeature: (feat, layer) => {
      const rawName = getPropNombre(feat.properties || {});
      if (!rawName) return;
      layer._muniKey = norm(rawName);
      layer._muniName = String(rawName).trim();
      layer.bindTooltip(`${String(rawName).trim()} — 👆 ¡clic para jugar!`, { sticky: true, opacity: 0.9 });
      // 🖱️ clic en el municipio = jugarlo directamente
      layer.on("click", () => jugarMunicipio(layer._muniKey));
    }
  }).addTo(map);

  featuresByNorm = {};
  geoLayer.eachLayer(layer => {
    if (!layer._muniKey) return;
    const c = layer.getBounds().getCenter();
    if (!featuresByNorm[layer._muniKey]) {
      featuresByNorm[layer._muniKey] = {
        name: layer._muniName, center: { lat: c.lat, lng: c.lng }, layer
      };
    }
  });
  try { map.fitBounds(geoLayer.getBounds().pad(0.05)); } catch {}
  return Object.values(featuresByNorm).map(f => f.name);
}

function elegirSecreto() {
  const keys = Object.keys(featuresByNorm);
  const k = keys[Math.floor(Math.random() * keys.length)];
  targetNorm = k;
  targetName = featuresByNorm[k].name;
}

function pintar(key, color) {
  const f = featuresByNorm[key];
  if (!f) return;
  f.layer.setStyle({ fillColor: color, fillOpacity: 0.85, color: "#0f172a", weight: 1.5 });
  f.layer.bringToFront();
}

function setMessage(html, win=false) {
  const m = $("message");
  m.innerHTML = html;
  m.classList.toggle("win", win);
}

function actualizarContador() {
  $("attempts").textContent = attempts;
  const m = maxIntentos();
  $("attempts-max").textContent = m > 0 ? ` / ${m}` : "";
  const fill = $("attempts-bar-fill");
  if (fill) fill.style.width = m > 0 ? Math.min(100, (attempts / m) * 100) + "%" : Math.min(100, attempts * 4) + "%";
}

function addHistory(nombre, texto, color) {
  const li = document.createElement("li");
  const sw = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = color;
  const txt = document.createElement("span");
  txt.innerHTML = `<b>${nombre}</b> — ${texto}`;
  li.appendChild(sw); li.appendChild(txt);
  $("history").prepend(li);
}

function terminarVictoria(f) {
  gameOver = true;
  $("secret-label").textContent = targetName;
  registrarVictoria();
  const m = maxIntentos();
  const limite = m > 0 ? ` con límite de ${m}` : "";
  setMessage(`🎉 ¡Correcto! Era <b>${targetName}</b> en <b>${attempts}</b> intento(s)${limite} (modo ${modo()==="ciego"?"a ciegas 🙈":"con pistas 🎨"}). ¡Dale a “↻ Nuevo juego”! 🏆 Victorias: ${stats.wins}`, true);
  f.layer.bindTooltip(`⭐ ${f.name}`, { permanent: true, direction: "center", className: "muni-label" }).openTooltip();
  lanzarConfeti();
}

// 🎊 lluvia de confeti con los colores de la bandera
function lanzarConfeti() {
  const colores = ["#ef4444", "#ffffff", "#1d4ed8", "#ffd700", "#22c55e"];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement("div");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colores[i % colores.length];
    c.style.animationDelay = (Math.random() * 0.9) + "s";
    c.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4500);
  }
}

// 🌴 slideshow de postales: rota solo + clic para jugar ese municipio
function initSlideshow() {
  const slides = [...document.querySelectorAll("#slideshow .slide")];
  const dotsBox = $("dots");
  if (!slides.length) return;
  slides.forEach((_, i) => {
    const d = document.createElement("button");
    d.setAttribute("aria-label", "foto " + (i + 1));
    if (i === 0) d.classList.add("on");
    d.addEventListener("click", () => mostrarSlide(i, true));
    dotsBox.appendChild(d);
  });
  let idx = 0, timer = null;
  const dots = [...dotsBox.children];
  function mostrarSlide(i, manual) {
    idx = (i + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle("active", k === idx));
    dots.forEach((d, k) => d.classList.toggle("on", k === idx));
    if (manual) reiniciarTimer();
  }
  function reiniciarTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => mostrarSlide(idx + 1), 4500);
  }
  reiniciarTimer();
  // 👆 tocar la postal escribe ese municipio en el juego
  document.querySelectorAll("#slideshow .caption").forEach(btn => {
    btn.addEventListener("click", () => {
      $("guess-input").value = btn.dataset.muni;
      $("guess-input").focus();
      setMessage(`📸 ¡Buena elección! Probando con <b>${btn.dataset.muni}</b>… pulsa “🎯 ¡Adivinar!”.`);
      document.querySelector(".panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
  window.mostrarSlide = mostrarSlide;
}

function terminarDerrota(motivo) {
  gameOver = true;
  pintar(targetNorm, VERDE);
  $("secret-label").textContent = targetName;
  registrarDerrota();
  setMessage(`${motivo} Era <b>${targetName}</b>. 🔥 Racha reiniciada. ¡Dale a “↻ Nuevo juego”!`);
}

function adivinar() {
  if (gameOver || !targetNorm) return;
  const input = $("guess-input");
  const key = norm(input.value);
  if (!key) { setMessage("⚠️ Escribe un municipio o haz <b>clic en el mapa</b>."); return; }
  const f = featuresByNorm[key];
  if (!f) { setMessage(`⚠️ “${input.value}” no es válido. Usa la lista… ¡o haz clic en el mapa!`); input.value = ""; return; }
  jugarMunicipio(key);
}

// 🖱️ jugar un municipio (desde el input o desde un clic en el mapa)
function jugarMunicipio(key) {
  if (gameOver || !targetNorm) return;
  const input = $("guess-input");
  const f = featuresByNorm[key];
  if (!f) return;
  if (guessed.has(key)) { setMessage(`ℹ️ Ya intentaste <b>${f.name}</b>. Prueba otro (escribe o haz clic).`); return; }

  guessed.add(key);
  attempts++;
  actualizarContador();

  // Acierto (ambos modos)
  if (key === targetNorm) {
    pintar(key, VERDE);
    addHistory(f.name, "<b>¡Correcto!</b>", VERDE);
    terminarVictoria(f);
    input.value = "";
    return;
  }

  // Fallo según modo
  if (modo() === "ciego") {
    pintar(key, GRIS_FALLO);
    addHistory(f.name, "❌ No es. Sigue intentando.", GRIS_FALLO);
    const m = maxIntentos();
    const restan = m > 0 ? m - attempts : null;
    if (m > 0 && restan <= 0) { terminarDerrota("😞 Te quedaste sin intentos (modo a ciegas)."); }
    else {
      setMessage(`🙈 <b>${f.name}</b> no es. ${m>0?`Te quedan <b>${restan}</b> intento(s).`:"Sigue intentando, sin pistas."}`);
    }
  } else {
    const t = featuresByNorm[targetNorm];
    const km = havKm(f.center, t.center);
    const color = colorPorDistancia(km);
    pintar(key, color);
    const dir = direccion(f.center, t.center);
    addHistory(f.name, `${km.toFixed(1)} km · ${etiquetaCercania(km)} · al ${dir}`, color);
    const m = maxIntentos();
    const restan = m > 0 ? m - attempts : null;
    if (m > 0 && restan <= 0) { terminarDerrota(`😞 Te quedaste sin intentos. <b>${f.name}</b> estaba a <b>${km.toFixed(1)} km</b>.`); }
    else {
      setMessage(`<b>${f.name}</b>: ${etiquetaCercania(km)} — a <b>${km.toFixed(1)} km</b>. El objetivo está al <b>${dir}</b>. ${m>0?`Te quedan <b>${restan}</b>.`:""}`);
    }
  }
  input.value = "";
  input.focus();
}

function rendirse() {
  if (!targetNorm || gameOver) return;
  terminarDerrota("😅 Te rendiste.");
}

function refrescarLeyenda() {
  const ciego = modo() === "ciego";
  $("legend").style.display = ciego ? "none" : "flex";
  $("hint").textContent = ciego
    ? "🙈 Modo a ciegas: escribe o haz clic en el mapa. Sin colores de cercanía, sin distancia ni dirección. Gris = fallado, verde = acierto."
    : "💡 Escribe un municipio… ¡o haz clic directo en el mapa! 🖱️ Después de cada intento te digo distancia y dirección. Arriba a la derecha puedes cambiar entre Calles, Satélite, Mar y Topográfico. 🌊🛰️";
}

function reiniciar() {
  if (geoLayer) geoLayer.eachLayer(l => geoLayer.resetStyle(l));
  guessed.clear();
  attempts = 0; gameOver = false;
  actualizarContador();
  $("history").innerHTML = "";
  $("guess-input").value = "";
  $("secret-label").textContent = "???";
  elegirSecreto();
  refrescarLeyenda();
  const m = maxIntentos();
  setMessage(m > 0
    ? `🗺️ Nuevo juego (${modo()==="ciego"?"a ciegas 🙈":"con pistas 🎨"}) con <b>${m} intentos</b>. ¡Suerte!`
    : `🗺️ Nuevo juego (${modo()==="ciego"?"a ciegas 🙈":"con pistas 🎨"}), intentos ilimitados. ¡Suerte!`);
  $("guess-input").focus();
}

async function main() {
  initDatalist(MUNICIPIOS);
  initMap();
  initSlideshow();
  initPortalBits();
  saveStats();
  refrescarLeyenda();
  actualizarContador();
  $("guess-btn").addEventListener("click", adivinar);
  $("guess-input").addEventListener("keydown", e => { if (e.key === "Enter") adivinar(); });
  $("surrender-btn").addEventListener("click", rendirse);
  $("restart-btn").addEventListener("click", reiniciar);
  $("mode-select").addEventListener("change", reiniciar);
  $("max-select").addEventListener("change", reiniciar);
  $("reset-stats").addEventListener("click", () => {
    stats = { wins: 0, games: 0, streak: 0, best: 0 };
    saveStats();
  });

  try {
    const nombres = await cargarGeoJSON();
    if (nombres.length >= 70) initDatalist(nombres);
    elegirSecreto();
    setMessage(`✅ Mapa listo con <b>${nombres.length}</b> municipios. ¡Haz tu primer intento!`);
  } catch (e) {
    console.error(e);
    setMessage("❌ No se pudo cargar el mapa (revisa tu internet). Recarga la página.");
  }
}

// bits del portal retro: reloj, contador de visitas y datos curiosos
const FACTS = [
  "🇵🇷 Puerto Rico tiene 78 municipios. El más poblado es San Juan y el menos poblado es Culebra.",
  "🦪 Ponce es conocida como “La Perla del Sur”.",
  "🌿 El Yunque es la única selva tropical del sistema forestal nacional de EE. UU.",
  "🏖️ Playa Flamenco, en Culebra, ha sido elegida entre las mejores playas del mundo.",
  "🌅 Mayagüez es conocida como “La Sultana del Oeste”.",
  "📡 Arecibo fue hogar de uno de los radiotelescopios más grandes del mundo.",
  "⛴️ Vieques y Culebra son islas-municipios al este de la isla grande. ¡No las olvides en el mapa!"
];
function initPortalBits() {
  // reloj de la barra de tareas
  const clock = $("clock");
  const tick = () => {
    if (!clock) return;
    const d = new Date();
    clock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, "0")).join(":");
  };
  tick();
  setInterval(tick, 1000);
  // contador de visitas (local, con base retro)
  try {
    let v = parseInt(localStorage.getItem("bori95-visits") || "0", 10) || 0;
    v++;
    localStorage.setItem("bori95-visits", String(v));
    const el = $("counter");
    if (el) el.textContent = String(100000 + v).padStart(7, "0");
  } catch {}
  // personitas en línea (decorativo)
  const on = $("online");
  if (on) on.textContent = String(1 + Math.floor(Math.random() * 12));
  // datos curiosos
  const ft = $("fact-text");
  const fb = $("fact-btn");
  const otroDato = () => {
    if (!ft) return;
    ft.textContent = FACTS[Math.floor(Math.random() * FACTS.length)];
  };
  if (fb) fb.addEventListener("click", otroDato);
  otroDato();
}

document.addEventListener("DOMContentLoaded", main);
