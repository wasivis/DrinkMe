const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // File picker
  openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),

  // Encoding control
  startEncoding: (filePath) => ipcRenderer.send("start-encoding", filePath),
  cancelEncoding: () => ipcRenderer.send("cancel-encoding"),

  // Analysis
  analyzeFile: (filePath) => ipcRenderer.invoke("analyze-file", filePath),

  // Show in Folder
  showInFolder: (filePath) => {
    console.log("[preload] → sending show-in-folder with:", filePath);
    ipcRenderer.send("show-in-folder", filePath);
  },

  // Progress/event listeners
  onEncodingProgress: (callback) =>
    ipcRenderer.on("encoding-progress", (_, data) => callback(data)),

  onEncodingComplete: (callback) =>
    ipcRenderer.on("encoding-complete", (_, data) => callback(data)),

  onEncodingCancelled: (callback) =>
    ipcRenderer.on("encoding-cancelled", callback),

  onEncodingError: (callback) =>
    ipcRenderer.on("encoding-error", (_, error) => callback(error)),
});
