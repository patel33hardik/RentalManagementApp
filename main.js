const { app, BrowserWindow } = require('electron');
const path = require('path');
const { initializeDatabase } = require('./backend/common');

const backendApp = require('./backend/backend');
const PORT = 3000;
let server;
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'common/images/icon.png'),
    title: 'Rental Manager',
    show: false, // don't show until ready
    backgroundColor: '#0f172a',
  });

  // Load the app from Express
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Show window when ready to avoid white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await initializeDatabase();
    server = backendApp.listen(PORT, '127.0.0.1', () => {
      console.log(`Server running at http://localhost:${PORT}`);
      createWindow();
    });
  } catch (err) {
    console.error('Failed to initialise database:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
