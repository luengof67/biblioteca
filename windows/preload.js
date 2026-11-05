// Biblioteca · puente entre la web y la app de escritorio
// La web solo puede pedir una cosa: «enséñame esto en PDF para imprimirlo».
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("escritorio", {
  imprimir: () => ipcRenderer.invoke("imprimir-pdf"),
});
