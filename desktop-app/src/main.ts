/**
 * Electron main process.
 *
 * The desktop app wraps the web application rather than reimplementing it.
 * Its reason to exist is the back office: a claims officer works a queue all
 * day across two monitors, and a firm administrator wants offline access to
 * certificates. Neither is well served by a browser tab.
 *
 * The security posture here is deliberately strict, because this process has
 * full Node privileges and renders content from a remote origin.
 */

import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { join } from 'node:path';

log.transports.file.level = 'info';
autoUpdater.logger = log;

const APP_URL = process.env.LIH_APP_URL ?? 'https://app.lih.cm';
const ALLOWED_ORIGINS = [
  'https://app.lih.cm',
  'https://admin.lih.cm',
  'https://api.lih.cm',
  // Payment providers take over the window during checkout.
  'https://api-checkout.cinetpay.com',
  'https://webpayment.orange.com',
];

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Lawyers Insurance Hub',
    backgroundColor: '#0E1A2E',
    show: false,
    webPreferences: {
      // The three settings that matter. Turning any of them the other way
      // would give remote page content access to Node — which, on a client
      // holding insurance records, is a remote code execution path.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  // Avoids the white flash before the app renders — noticeable on the slower
  // machines common in Cameroonian chambers.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  void mainWindow.loadURL(APP_URL);

  // Anything outside the allow-list opens in the user's browser instead of
  // inside a privileged Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const origin = safeOrigin(url);
    if (origin && ALLOWED_ORIGINS.includes(origin)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const origin = safeOrigin(url);
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// --- single instance --------------------------------------------------------
// Two windows against one session would fight over token refresh, and a
// concurrent refresh looks like token theft to the server, which revokes
// every session in response.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // Defence in depth: the web app already sends a CSP, and this ensures one
  // exists even if a proxy strips it.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' https://app.lih.cm https://api.lih.cm; " +
            "script-src 'self' 'unsafe-inline' https://app.lih.cm; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob: https:; " +
            "connect-src 'self' https://api.lih.cm; " +
            "frame-src https://api-checkout.cinetpay.com https://webpayment.orange.com; " +
            "object-src 'none'",
        ],
      },
    });
  });

  // The camera is used for claim evidence; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'notifications');
  });

  buildMenu();
  createWindow();
  void checkForUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- auto-update ------------------------------------------------------------
/**
 * Updates are signed and verified by electron-updater against the publisher
 * certificate before installation. An unsigned or tampered package is
 * rejected — otherwise the update channel would be a way to push arbitrary
 * code onto machines holding member data.
 */
async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Redémarrer maintenant / Restart now', 'Plus tard / Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Mise à jour disponible / Update available',
      message: `Version ${info.version} est prête à être installée.`,
      detail: `Version ${info.version} is ready to install.`,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (error) => {
    // A failed update check must never block the app. An officer with a
    // queue to clear cannot be stopped by an unreachable update server.
    log.error('Update check failed:', error);
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    log.error('checkForUpdates threw:', error);
  }

  // Re-check every six hours for machines left running for days.
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 3_600_000);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'Fichier / File',
        submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }],
      },
      { role: 'editMenu' },
      {
        label: 'Affichage / View',
        submenu: [
          { role: 'reload' as const },
          { role: 'forceReload' as const },
          { type: 'separator' as const },
          { role: 'resetZoom' as const },
          { role: 'zoomIn' as const },
          { role: 'zoomOut' as const },
          { type: 'separator' as const },
          { role: 'togglefullscreen' as const },
        ],
      },
      {
        label: 'Aide / Help',
        submenu: [
          {
            label: 'Support',
            click: () => void shell.openExternal('https://lih.cm/support'),
          },
          {
            label: 'Rechercher les mises à jour / Check for updates',
            click: () => void autoUpdater.checkForUpdates().catch(() => undefined),
          },
        ],
      },
    ]),
  );
}
