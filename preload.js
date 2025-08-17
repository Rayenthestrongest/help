

console.log('preload.js loaded');
const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe API exposed to the renderer. All file operations are
// performed in the main process via ipc handlers.
contextBridge.exposeInMainWorld('electronAPI', {
  // Create a new save file with reset data and set as current
  createNewSaveFile: () => ipcRenderer.invoke('create-new-save-file'),

  // Import a file and set it as current save file, returns {ok, data, file}
  importAndSetCurrent: async () => {
    const result = await ipcRenderer.invoke('import-and-set-current');
    // Attach the file name if available
    if (result && result.ok && result.data && result.file === undefined && result.selectedFile) {
      result.file = result.selectedFile;
    }
    return result;
  },
  // Ask the main process to open a folder picker and persist the choice
  pickDir: () => ipcRenderer.invoke('pick-dir'),

  // Get current status (saveDir, lastSaveISO)
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Export given raw JSON string to the configured save folder (main handles picking folder if needed)
  exportNow: (raw, fileName) => ipcRenderer.invoke('export-now', raw, fileName),

  // Import: return { ok, data } where data is the file content or empty string
  importNow: () => ipcRenderer.invoke('import-now'),

  // Reset persistent file to empty object
  resetAll: () => ipcRenderer.invoke('reset-all'),

  // Create a timestamped backup copy in the backups folder
  backupNow: () => ipcRenderer.invoke('backup-now'),

  // List backups in the backups folder
  listBackups: () => ipcRenderer.invoke('list-backups'),

  // Restore a specific backup file (name only)
  restoreBackup: (name) => ipcRenderer.invoke('restore-backup', name),

  // Open the backups folder in the OS file explorer
  openBackupFolder: () => ipcRenderer.invoke('open-backup-folder'),

  // Open the configured save folder in the OS file explorer
  openSaveFolder: () => ipcRenderer.invoke('open-save-folder'),

  // Unblock save if user wants to re-activer la sauvegarde
  unblockSave: () => ipcRenderer.invoke('unblock-save'),

  // Register a status-update listener. Returns an unsubscribe function.
  onStatusUpdate: (cb) => {
    const listener = (event, status) => { try { cb(status); } catch(e) { /* swallow */ } };
    ipcRenderer.on('status-update', listener);
    return () => ipcRenderer.removeListener('status-update', listener);
  }
});
