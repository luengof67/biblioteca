// Biblioteca · app de escritorio para Windows
// Abre la web publicada (biblioteca-cocina.web.app) en su propia ventana.
// Así se actualiza sola con cada deploy y no hay que recompilar el .exe.
const { app, BrowserWindow, shell, Menu } = require("electron");
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
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
    if (k === "f5" || (i.control && k === "r")) { ev.preventDefault(); win.loadURL(APP_URL); }
    else if (i.control && i.shift && k === "i") { ev.preventDefault(); win.webContents.toggleDevTools(); }
    else if (i.control && (k === "+" || k === "=")) { ev.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); }
    else if (i.control && k === "-") { ev.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); }
    else if (i.control && k === "0") { ev.preventDefault(); win.webContents.setZoomLevel(0); }
  });

  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  crearVentana();
});
app.on("window-all-closed", () => app.quit());
