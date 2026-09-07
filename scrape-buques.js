// ============================================================
// scrape-buques.js
// Consulta la API pública de AGP (Administración General de Puertos),
// filtra los arribos de TRP, Terminal 4 (APM) y Exolgan, y los sube
// a Firebase Realtime Database (mismo lugar que usa el panel del TV).
// ============================================================

const admin = require("firebase-admin");

// ---------- Firebase ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://panel-del-embarque-default-rtdb.firebaseio.com",
});
const db = admin.database();

// ---------- Rango de fechas: desde ayer hasta dentro de 14 días ----------
function formatFecha(d, horaFinal) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${horaFinal ? "23:59:59" : "00:00:00"}`;
}
const hoy = new Date();
const desde = new Date(hoy); desde.setDate(desde.getDate() - 1);
const hasta = new Date(hoy); hasta.setDate(hasta.getDate() + 14);
const desdeStr = formatFecha(desde, false);
const hastaStr = formatFecha(hasta, true);

const BASE_URL = "https://api.agp-ports.gob.ar/api/giros/escalas";

async function fetchPagina(skip, take) {
  const url = `${BASE_URL}?fechaIngresoDesde=${encodeURIComponent(desdeStr)}&fechaIngresoHasta=${encodeURIComponent(hastaStr)}&skip=${skip}&take=${take}&idPuerto=3`;
  const res = await fetch(url, {
    headers: {
      "accept": "application/json, text/plain, */*",
      "accept-language": "es-419,es;q=0.9",
      "origin": "https://agp-ports.gob.ar",
      "referer": "https://agp-ports.gob.ar/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`La API de AGP respondió con estado ${res.status}`);
  }
  return res.json();
}

// Determina si un movimiento pertenece a TRP, Terminal 4 (APM) o Exolgan
function terminalDestino(mov) {
  const sigla = (mov.terminal?.sigla || "").toUpperCase();
  const nombre = (mov.terminal?.nombre || "").toLowerCase();
  if (sigla === "TRP") return "TRP";
  if (sigla === "APM") return "Terminal 4";
  if (nombre.includes("exolgan") || sigla === "EXO") return "Exolgan";
  return null;
}

// Convierte una fecha ISO en UTC a hora de Buenos Aires (UTC-3),
// en formato M/D/AAAA HH:mm (el mismo que usa el panel del TV)
function aFechaLocal(isoUtc) {
  const d = new Date(isoUtc);
  const local = new Date(d.getTime() - 3 * 3600 * 1000);
  const m = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  const y = local.getUTCFullYear();
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  return `${m}/${day}/${y} ${hh}:${mm}`;
}

async function main() {
  const take = 100;
  let skip = 0;
  let total = Infinity;
  const filas = [];

  while (skip < total) {
    const json = await fetchPagina(skip, take);
    const bloque = json.data;
    total = bloque.totalCount;

    for (const registro of bloque.data) {
      const nombreBuque = registro.buque?.nombre?.trim() || "";
      const procedencia = registro.puertos?.[0]?.ciudad?.nombre || "";
      const naviera = registro.agencia?.nombre || "";

      for (const mov of registro.movimientos || []) {
        const terminal = terminalDestino(mov);
        if (!terminal) continue;
        if (!mov.fechaETA) continue;

        filas.push({
          buque: nombreBuque,
          terminal,
          naviera,
          procedencia,
          eta: aFechaLocal(mov.fechaETA),
        });
      }
    }
    skip += take;
  }

  console.log(`Encontrados ${filas.length} arribos en TRP / Terminal 4 / Exolgan`);
  await db.ref("datosBuques").set(filas);
  console.log("Firebase actualizado correctamente.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error actualizando buques:", err);
  process.exit(1);
});
