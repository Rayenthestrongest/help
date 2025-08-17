
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
// Default folder for automatic backups (no prompt)
const DEFAULT_SAVE_DIR = path.join(app.getPath('desktop'), 'backup');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}
function writeJSON(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) { console.error('writeJSON error:', e); }
}

let config = readJSON(CONFIG_PATH, {
  saveDir: '',
  lastSaveISO: '',
  activeFile: 'pass_j_data.json'
});

// If no saveDir configured, force the default backup folder on desktop
if (!config.saveDir) {
  config.saveDir = DEFAULT_SAVE_DIR;
  config.backupDir = path.join(config.saveDir || app.getPath('documents'), 'backups');
  config.activeFile = 'pass_j_data.json';
  try { fs.mkdirSync(config.saveDir, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(config.backupDir, { recursive: true }); } catch (e) { /* ignore */ }
  writeJSON(CONFIG_PATH, config);
}

function ensureSaveDirs() {
  if (config.saveDir) { try { fs.mkdirSync(config.saveDir, { recursive: true }); } catch {} }
  if (!config.backupDir) config.backupDir = path.join(config.saveDir || app.getPath('documents'), 'backups');
  try { fs.mkdirSync(config.backupDir, { recursive: true }); } catch {}
  writeJSON(CONFIG_PATH, config);
}

async function chooseSaveDirIfNeeded(win) {
  // No interactive prompt: ensure the configured folder exists (we default to DEFAULT_SAVE_DIR)
  if (!config.saveDir) config.saveDir = DEFAULT_SAVE_DIR;
  if (!fs.existsSync(config.saveDir)) {
    try { fs.mkdirSync(config.saveDir, { recursive: true }); }
    catch (e) { /* ignore */ }
  }
  if (!config.backupDir) config.backupDir = path.join(config.saveDir, 'backups');
  if (!fs.existsSync(config.backupDir)) {
    try { fs.mkdirSync(config.backupDir, { recursive: true }); }
    catch (e) { /* ignore */ }
  }
  writeJSON(CONFIG_PATH, config);
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

let lastSavedRaw = '';
// (système de blocage supprimé)
// immutable "securite_*" backup system intentionally removed.

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return win;
}

function broadcastStatus() {
  const windows = BrowserWindow.getAllWindows();
  const status = {
    saveDir: config.saveDir,
    lastSaveISO: config.lastSaveISO || '',
    activeFile: config.activeFile || 'pass_j_data.json'
  };
  windows.forEach(w => {
    if (w && w.webContents) {
      w.webContents.send('status-update', status);
    }
  });
}

ipcMain.handle('pick-dir', async (e) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) throw new Error('Fenêtre non trouvée');
    
    const res = await dialog.showOpenDialog(win, {
      title: 'Choisir un dossier de sauvegarde',
      properties: ['openDirectory', 'createDirectory']
    });

    if (!res.canceled && res.filePaths?.[0]) {
      config.saveDir = res.filePaths[0];
      config.backupDir = path.join(config.saveDir, 'backups');
      ensureSaveDirs();
      writeJSON(CONFIG_PATH, config);
      broadcastStatus();
      return { ok: true, dir: config.saveDir };
    }
    return { ok: false, error: 'Sélection annulée' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('get-status', async () => {
  return {
    saveDir: config.saveDir,
    lastSaveISO: config.lastSaveISO || ''
  };
});

ipcMain.handle('export-now', async (e, raw, fileName) => {
  try {
    ensureSaveDirs();
    // Utilise le nom du fichier actif
    const file = path.join(config.saveDir, config.activeFile || 'pass_j_data.json');
    atomicWrite(file, raw || '{}');
    config.lastSaveISO = new Date().toISOString();
    writeJSON(CONFIG_PATH, config);
    broadcastStatus();
    return { ok: true, file };
  } catch (e2) {
    console.error('Export error:', e2);
    return { ok: false, error: String(e2) };
  }
});
// Permet de débloquer la sauvegarde si besoin
ipcMain.handle('unblock-save', async () => {
  // (handler supprimé)
});

// Create a timestamped backup in the backups folder
ipcMain.handle('backup-now', async (e) => {
  try {
    ensureSaveDirs();
    const src = path.join(config.saveDir, 'pass_j_data.json');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(config.backupDir, `backup-${stamp}.json`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      return { ok: true, file: dest };
    }
    // If main file doesn't exist yet, create an empty backup
    atomicWrite(dest, '{}');
    return { ok: true, file: dest };
  } catch (err) {
    console.error('backup-now error', err);
    return { ok: false, error: String(err) };
  }
});

// List backups
ipcMain.handle('list-backups', async () => {
  try {
    ensureSaveDirs();
    const files = fs.readdirSync(config.backupDir || path.join(config.saveDir, 'backups')).filter(f => f.match(/backup-.*\.json$/)).sort().reverse();
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Restore a backup by copying it to pass_j_data.json
ipcMain.handle('restore-backup', async (e, name) => {
  try {
    ensureSaveDirs();
    const src = path.join(config.backupDir, name);
    if (!fs.existsSync(src)) return { ok: false, error: 'Fichier introuvable' };
    const dest = path.join(config.saveDir, 'pass_j_data.json');
    fs.copyFileSync(src, dest);
    config.lastSaveISO = new Date().toISOString();
    writeJSON(CONFIG_PATH, config);
    broadcastStatus();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('open-backup-folder', async () => {
  try { ensureSaveDirs(); shell.openPath(config.backupDir); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('open-save-folder', async () => {
  try { ensureSaveDirs(); shell.openPath(config.saveDir); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('import-now', async (e) => {
  try {
    // Prefer letting the user pick a JSON file to import.
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choisir un fichier JSON à importer',
      properties: ['openFile'],
      filters: [ { name: 'JSON', extensions: ['json'] } ]
    });

    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      // User cancelled file selection
      return { ok: false, error: 'Sélection annulée' };
    }

    const selectedFile = res.filePaths[0];
    try {
      const content = fs.readFileSync(selectedFile, 'utf-8');
      return { ok: true, data: content };
    } catch (readErr) {
      console.error('Import read error:', readErr);
      return { ok: false, error: String(readErr) };
    }
  } catch (err) {
    console.error('Import error:', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('reset-all', async () => {
  try {
    if (config.saveDir) {
      const file = path.join(config.saveDir, 'pass_j_data.json');
      // Write a safe default dataset instead of an empty object so the UI
      // that may read the file directly doesn't break after a reset.
      const defaultData = {
        subjects: [ { id: 's_' + Date.now().toString(36), name: 'Maths', color: '#22d3ee' }, { id: 's2_' + Date.now().toString(36), name: 'Physique', color: '#a78bfa' } ],
        presets: [ { id: 'p_' + Date.now().toString(36), name: 'Classique 1-2-5-7-30-40', days: [1,2,5,7,30,40] } ],
        courses: [],
        events: [],
        sessions: [],
        timer: { active:false, evId:null, courseId:null, subjectId:null, start:0, elapsed:0, running:false, minimized:false, title:'', color:'#22c55e' },
        ui: { timerWin:null, pill:{ side:'right', offset:22 } },
        version: 1,
        backup: { enabled:false, everyMin:60, nextIndex:1, lastAt:0 },
        lastSave: 0
      };
      atomicWrite(file, JSON.stringify(defaultData, null, 2)); // Write safe default JSON
      config.lastSaveISO = new Date().toISOString();
      writeJSON(CONFIG_PATH, config);
      broadcastStatus();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});


// Create a new save file, apply reset data, and set it as current (does NOT touch previous file)
ipcMain.handle('create-new-save-file', async () => {
  try {
    ensureSaveDirs();
    // Find a new filename that does not exist yet
    let idx = 2;
    let file;
    do {
      file = path.join(config.saveDir, `pass_j_data_${idx}.json`);
      idx++;
    } while (fs.existsSync(file));
    // Write default reset data
    const defaultData = {
      subjects: [ { id: 's_' + Date.now().toString(36), name: 'Maths', color: '#22d3ee' }, { id: 's2_' + Date.now().toString(36), name: 'Physique', color: '#a78bfa' } ],
      presets: [ { id: 'p_' + Date.now().toString(36), name: 'Classique 1-2-5-7-30-40', days: [1,2,5,7,30,40] } ],
      courses: [],
      events: [],
      sessions: [],
      timer: { active:false, evId:null, courseId:null, subjectId:null, start:0, elapsed:0, running:false, minimized:false, title:'', color:'#22c55e' },
      ui: { timerWin:null, pill:{ side:'right', offset:22 } },
      version: 1,
      backup: { enabled:false, everyMin:60, nextIndex:1, lastAt:0 },
      lastSave: 0
    };
    atomicWrite(file, JSON.stringify(defaultData, null, 2));
  // Set as current save file
  config.saveDir = path.dirname(file);
  config.activeFile = path.basename(file);
  config.lastSaveISO = new Date().toISOString();
  writeJSON(CONFIG_PATH, config);
  broadcastStatus();
  return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Import a file: charge les données dans l'app, mais NE CHANGE PAS le fichier courant ni le dossier de sauvegarde
ipcMain.handle('import-and-set-current', async (e) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choisir un fichier JSON à importer',
      properties: ['openFile'],
      filters: [ { name: 'JSON', extensions: ['json'] } ]
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      return { ok: false, error: 'Sélection annulée' };
    }
    const selectedFile = res.filePaths[0];
    // Met à jour le fichier actif
    config.activeFile = path.basename(selectedFile);
    writeJSON(CONFIG_PATH, config);
    broadcastStatus();
    try {
      let content = fs.readFileSync(selectedFile, 'utf-8');
      // Si le fichier est vide, accepte comme un objet vide
      if (!content.trim()) content = '{}';
      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (jsonErr) {
        // Tente une réparation simple
        let fixed = content.trim();
        if (fixed.startsWith('{') && !fixed.endsWith('}')) fixed += '}';
        if (fixed.startsWith('[') && !fixed.endsWith(']')) fixed += ']';
        try {
          parsed = JSON.parse(fixed);
          content = fixed;
        } catch (e2) {
          return { ok: false, error: 'Données JSON invalides.' };
        }
      }
      return { ok: true, data: content, file: selectedFile };
    } catch (readErr) {
      return { ok: false, error: String(readErr) };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Export automatique à chaque ouverture, rotation sur 10 fichiers
function autoExportRotation() {
  try {
    ensureSaveDirs();
    const saveFile = path.join(config.saveDir, config.activeFile || 'pass_j_data.json');
    if (!fs.existsSync(saveFile)) return;
    // Cherche les exports existants
    const files = fs.readdirSync(config.saveDir).filter(f => f.match(/^autoexport-\d+\.json$/));
    // Récupère les index existants
    const idxs = files.map(f => parseInt(f.match(/^autoexport-(\d+)\.json$/)[1], 10)).filter(n => !isNaN(n));
    let nextIdx = 1;
    if (idxs.length < 10) {
      // Cherche le premier index libre
      for (let i = 1; i <= 10; i++) {
        if (!idxs.includes(i)) { nextIdx = i; break; }
      }
    } else {
      // Rotation circulaire : écrase le plus ancien
      // Trie par date de modification
      const fullFiles = files.map(f => ({
        name: f,
        mtime: fs.statSync(path.join(config.saveDir, f)).mtimeMs
      }));
      fullFiles.sort((a, b) => a.mtime - b.mtime);
      const oldest = fullFiles[0].name;
      nextIdx = parseInt(oldest.match(/^autoexport-(\d+)\.json$/)[1], 10);
    }
    const exportFile = path.join(config.saveDir, `autoexport-${nextIdx}.json`);
    fs.copyFileSync(saveFile, exportFile);
  } catch (e) {
    console.error('autoExportRotation error:', e);
  }
}

app.whenReady().then(async () => {
  const win = createWindow();
  await chooseSaveDirIfNeeded(win);
  ensureSaveDirs();
  autoExportRotation();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
