// Biblioteca · app de escritorio para Windows
// Abre la web publicada (biblioteca-cocina.web.app) en su propia ventana.
// Así se actualiza sola con cada deploy y no hay que recompilar el .exe.
const { app, BrowserWindow, shell, Menu, ipcMain } = require("electron");
const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");

const APP_URL = "https://biblioteca-cocina.web.app/";
const APP_ORIGIN = new URL(APP_URL).origin;
// Dominios que necesita el inicio de sesión de Firebase dentro de la ventana
const PERMITIDOS = [APP_ORIGIN, "https://biblioteca-cocina.firebaseapp.com"];

let win = null;

// Una sola ventana: si ya está abierta, la trae al frente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

// Recordar tamaño y posición de la ventana
const estadoPath = () => path.join(app.getPath("userData"), "ventana.json");
function leerEstado() {
  try { return JSON.parse(fs.readFileSync(estadoPath(), "utf8")); } catch { return { width: 1200, height: 850 }; }
}
function guardarEstado() {
  if (!win) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(estadoPath(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {}
}

const esInterna = url => PERMITIDOS.some(o => url.startsWith(o)) || url.startsWith("file://") || url.startsWith("blob:");

function crearVentana() {
  const e = leerEstado();
  win = new BrowserWindow({
    x: e.x, y: e.y, width: e.width || 1200, height: e.height || 850,
    minWidth: 380, minHeight: 500,
    title: "Biblioteca",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#FAF8F3",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true, preload: path.join(__dirname, "preload.js") },
  });
  if (e.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("close", guardarEstado);
  win.on("closed", () => { win = null; });

  // Enlaces externos (WhatsApp, Drive, correo, teléfono…) se abren fuera de la app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (esInterna(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (ev, url) => {
    if (!esInterna(url)) { ev.preventDefault(); shell.openExternal(url); }
  });

  // Sin conexión la primera vez: página local con botón de reintentar
  win.webContents.on("did-fail-load", (ev, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadFile(path.join(__dirname, "offline.html"));
  });

  // Atajos: F5 / Ctrl+R recargar, Ctrl+Shift+I herramientas, Ctrl +/- zoom
  win.webContents.on("before-input-event", (ev, i) => {
    if (i.type !== "keyDown") return;
    const k = i.key.toLowerCase();
    if (k === "f5" || (i.control && k === "r")) {
      // Recargar siempre la última versión publicada (sin usar la copia guardada)
      ev.preventDefault();
      win.webContents.session.clearCache().finally(() => win.loadURL(APP_URL, { extraHeaders: "pragma: no-cache\n" }));
    }
    else if (i.control && i.shift && k === "i") { ev.preventDefault(); win.webContents.toggleDevTools(); }
    else if (i.control && (k === "+" || k === "=")) { ev.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); }
    else if (i.control && k === "-") { ev.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); }
    else if (i.control && k === "0") { ev.preventDefault(); win.webContents.setZoomLevel(0); }
  });

  // Al abrir, la página se pide al servidor de nuevo para que cada deploy se vea sin más
  win.webContents.session.clearCache().finally(() => win.loadURL(APP_URL, { extraHeaders: "pragma: no-cache\n" }));
}

// Imprimir: se genera un PDF y se abre con el programa de PDF de Windows (Acrobat, Edge…).
// Así el cuadro de imprimir enseña la vista previa y todas las opciones de la impresora.
// Si no hay ningún programa para PDF, se enseña en una ventana de la propia app.
function archivoTemporal(nombre) {
  const carpeta = path.join(app.getPath("temp"), "biblioteca-impresion");
  fs.mkdirSync(carpeta, { recursive: true });
  // Borrar PDFs de impresiones anteriores (los que sigan abiertos en otro programa se quedan)
  for (const f of fs.readdirSync(carpeta)) { try { fs.unlinkSync(path.join(carpeta, f)); } catch {} }
  const limpio = String(nombre || "impresion").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "impresion";
  return path.join(carpeta, `${limpio.replace(/\.pdf$/i, "")} ${Date.now()}.pdf`);
}
async function abrirPdf(archivo) {
  const error = await shell.openPath(archivo);   // "" si se abrió bien
  if (!error) return "programa";
  const vista = new BrowserWindow({
    width: 900, height: 1000, parent: win, title: "Vista previa · Biblioteca",
    icon: path.join(__dirname, "icon.ico"), autoHideMenuBar: true, backgroundColor: "#525659",
    webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false },
  });
  vista.loadURL(pathToFileURL(archivo).href);
  return "ventana";
}
// Lo que se ve para imprimir (listados, fichas, pedidos…), pasado a PDF
ipcMain.handle("imprimir-pdf", async (ev) => {
  const pdf = await ev.sender.printToPDF({ printBackground: false, pageSize: "A4", preferCSSPageSize: true });
  const archivo = archivoTemporal("Biblioteca impresion");
  fs.writeFileSync(archivo, pdf);
  return abrirPdf(archivo);
});
// Un PDF guardado (menú, catálogo…): se abre tal cual, sin convertirlo
ipcMain.handle("abrir-pdf", async (ev, nombre, datos) => {
  const archivo = archivoTemporal(nombre);
  fs.writeFileSync(archivo, Buffer.from(datos));
  return abrirPdf(archivo);
});

// Compartir: Windows no tiene una hoja de compartir para apps de escritorio como esta, así que
// el archivo se guarda en Descargas\Biblioteca y se abre el Explorador con él marcado,
// listo para arrastrarlo a WhatsApp, Telegram o al correo.
ipcMain.handle("guardar-compartir", async (ev, nombre, datos) => {
  const carpeta = path.join(app.getPath("downloads"), "Biblioteca");
  fs.mkdirSync(carpeta, { recursive: true });
  const limpio = String(nombre || "documento").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").replace(/\s+\./g, ".").trim().slice(0, 150) || "documento";
  const ext = path.extname(limpio), base = limpio.slice(0, limpio.length - ext.length);
  let archivo = path.join(carpeta, limpio);
  for (let i = 2; fs.existsSync(archivo); i++) archivo = path.join(carpeta, `${base} (${i})${ext}`);
  fs.writeFileSync(archivo, Buffer.from(datos));
  shell.showItemInFolder(archivo);
  return archivo;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  crearVentana();
});
app.on("window-all-closed", () => app.quit());
