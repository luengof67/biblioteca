// Biblioteca · puente entre la web y la app de escritorio
// La web solo puede pedir dos cosas: «enséñame esto en PDF para imprimirlo» y
// «guarda este archivo para compartirlo».
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("escritorio", {
  imprimir: () => ipcRenderer.invoke("imprimir-pdf"),
  // Compartir: guarda el archivo en Descargas\Biblioteca y lo enseña en el Explorador.
  guardarCompartir: (nombre, datos) => ipcRenderer.invoke("guardar-compartir", nombre, datos),
});
