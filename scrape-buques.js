// ============================================================
// scrape-buques.js
// Combina tres fuentes oficiales, una por terminal:
//  - TRP: API propia de www.trp.com.ar
//  - Terminal 4: API propia de apps.apmterminals.com.ar
//  - Exolgan: API pública de NTL (ntlweb.com), agregador que publica
//    los datos oficiales de Exolgan sin necesitar login
// y sube el resultado combinado a Firebase Realtime Database
// (mismo lugar que usa el panel del TV).
// ============================================================

const admin = require("firebase-admin");

// ---------- Firebase ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://panel-del-embarque-default-rtdb.firebaseio.com",
});
const db = admin.database();

// Convierte "dd/mm/aaaa HH:mm" (formato de TRP y APM) a "M/D/AAAA HH:mm" (formato interno del panel)
function deFechaConHora(str) {
  const [fecha, hora] = str.trim().split(" ");
  const [dd, mm, yyyy] = fecha.split("/").map(Number);
  return `${mm}/${dd}/${yyyy} ${hora || "00:00"}`;
}

// Convierte "d/m/aaaa" (formato de NTL, sin hora) a "M/D/AAAA HH:mm"
function deFechaSinHora(str) {
  const [dd, mm, yyyy] = str.trim().split("/").map(Number);
  return `${mm}/${dd}/${yyyy} 00:00`;
}

// Convierte "d/m/aaaa" o "dd/mm/aaaa" (sin hora) a "M/D/AAAA" (sin hora, formato interno)
function soloFecha(str) {
  if (!str) return "";
  const [dd, mm, yyyy] = str.trim().split("/").map(Number);
  if (!dd || !mm || !yyyy) return "";
  return `${mm}/${dd}/${yyyy}`;
}

// ---------- TRP ----------
// Clave para cruzar buque+fecha entre los dos feeds de TRP, ignorando la hora exacta
// (puede haber pequeñas diferencias de minutos entre el cronograma y el free storage)
function claveBuqueFecha(nombre, fechaHora){
  const soloFechaStr = (fechaHora || "").trim().split(" ")[0]; // "dd/mm/aaaa"
  return `${(nombre || "").trim().toUpperCase()}|${soloFechaStr}`;
}

async function fetchTRPForzosoMap() {
  const res = await fetch("https://www.trp.com.ar/api/public/vessels/freeday", {
    headers: {
      "accept": "*/*",
      "accept-language": "es-419,es;q=0.9",
      "referer": "https://www.trp.com.ar/cronogramas/importacion",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`La API de TRP (freeday) respondió con estado ${res.status}`);
  }
  const json = await res.json();
  const filas = json?.payload?.data || [];
  const mapa = new Map();
  filas.forEach((f) => {
    if (f.vencForzoso) mapa.set(claveBuqueFecha(f.shipName, f.eta), f.vencForzoso);
  });
  return mapa;
}

async function fetchTRP() {
  const res = await fetch("https://www.trp.com.ar/api/public/vessels/schedule", {
    headers: {
      "accept": "*/*",
      "accept-language": "es-419,es;q=0.9",
      "referer": "https://www.trp.com.ar/cronogramas/buques",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`La API de TRP respondió con estado ${res.status}`);
  }
  const json = await res.json();
  const filas = json?.payload?.data || [];
  const mapaForzoso = await fetchTRPForzosoMap();
  let matcheados = 0;
  const resultado = filas.map((f) => {
    const forzosoRaw = mapaForzoso.get(claveBuqueFecha(f.shipName, f.eta)) || "";
    if (forzosoRaw) matcheados++;
    return {
      buque: f.shipName || "",
      terminal: "TRP",
      naviera: f.lineOperator || "",
      procedencia: "",
      eta: deFechaConHora(f.eta),
      forzoso: forzosoRaw ? deFechaConHora(forzosoRaw) : "",
      aperturaStacking: "", // TRP no publica este dato en su API
    };
  });
  console.log(`  (TRP forzoso: ${matcheados} de ${filas.length} buques cruzados, ${mapaForzoso.size} disponibles en el feed de free storage)`);
  return resultado;
}

// ---------- Terminal 4 (APM) ----------
async function fetchAPM() {
  const res = await fetch("https://apps.apmterminals.com.ar/GestionClientes/vesselServices/getVessels", {
    headers: {
      "Accept": "*/*",
      "Accept-Language": "es-419,es;q=0.9",
      "Content-Type": "application/json",
      "Referer": "https://apps.apmterminals.com.ar/GestionClientes/arribos",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`La API de APM Terminal 4 respondió con estado ${res.status}`);
  }
  const lista = await res.json();
  return lista
    .filter((v) => v.vesselStatus !== "FINALIZADO" && v.vesselETA)
    .map((v) => ({
      buque: v.vesselName?.trim() || "",
      terminal: "Terminal 4",
      naviera: "",
      procedencia: "",
      eta: deFechaConHora(v.vesselETA),
      forzoso: soloFecha(v.vesselDueDateT1), // "Venc. T1" = forzoso en Terminal 4
      aperturaStacking: soloFecha(v.vesselStartReceptionDry), // fecha de inicio de recepción = apertura de stacking
    }));
}

// ---------- Exolgan (vía NTL) ----------
async function fetchExolgan() {
  const res = await fetch("http://ntlweb.com/WebServices/ServicioControles.asmx/ListarArribos", {
    method: "POST",
    headers: {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "es-419,es;q=0.9",
      "Content-Type": "application/json; charset=UTF-8",
      "Origin": "http://ntlweb.com",
      "Referer": "http://ntlweb.com/arribos.html",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({ terminal: "1" }), // 1 = Exolgan en el sistema de NTL
  });
  if (!res.ok) {
    throw new Error(`La API de NTL (Exolgan) respondió con estado ${res.status}`);
  }
  const json = await res.json();
  const lista = json?.d || [];
  return lista
    .filter((v) => v.estado !== "Finalizado" && v.estado !== "Cancelado" && v.fechaETA)
    .map((v) => ({
      buque: (v.barco || "").trim(),
      terminal: "Exolgan",
      naviera: "",
      procedencia: "",
      eta: deFechaSinHora(v.fechaETA),
      forzoso: soloFecha(v.fechaForzoso),
      aperturaStacking: "", // NTL no publica este dato para Exolgan
    }));
}

async function main() {
  const filasTRP = await fetchTRP();
  console.log(`TRP: ${filasTRP.length} arribos`);

  const filasAPM = await fetchAPM();
  console.log(`Terminal 4 (APM): ${filasAPM.length} arribos`);

  const filasExolgan = await fetchExolgan();
  console.log(`Exolgan (NTL): ${filasExolgan.length} arribos`);

  const filas = [...filasTRP, ...filasAPM, ...filasExolgan];

  console.log(`Total combinado: ${filas.length} arribos en TRP / Terminal 4 / Exolgan`);
  await db.ref("datosBuques").set(filas);
  console.log("Firebase actualizado correctamente.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error actualizando buques:", err);
  process.exit(1);
});
