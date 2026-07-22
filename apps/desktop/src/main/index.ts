import { app, BrowserWindow, dialog, net, protocol, session } from 'electron';
import { readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IpcRouter } from './ipc';
import { SqlitePersistenceClient } from './persistence';

const isDevelopment = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceClient | null = null;
let router: IpcRouter | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);
app.enableSandbox();

if (isDevelopment) app.setPath('userData', resolve(process.cwd(), '.vite-user-data'));

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app
    .whenReady()
    .then(async () => {
      if (!isDevelopment) registerProductionProtocol();
      persistence = new SqlitePersistenceClient(
        join(app.getPath('userData'), 'vibe-editor3.sqlite3'),
      );
      persistence.interruptActiveTurns();
      mainWindow = createWindow();
      const trustedOrigin =
        MAIN_WINDOW_VITE_DEV_SERVER_URL === undefined
          ? 'app://bundle'
          : new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
      router = new IpcRouter(mainWindow, persistence, trustedOrigin);
      router.register();
      await loadRenderer(mainWindow);
    })
    .catch((error: unknown) => {
      // Fatal initialization failure must be visible, never silently swallowed (Slice 1.1).
      dialog.showErrorBox(
        'vibe-editor3 の起動に失敗しました',
        error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error),
      );
      app.exit(1);
    });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  router?.dispose();
  persistence?.close();
});

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  window.once('ready-to-show', () => window.show());
  return window;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadURL('app://bundle/index.html');
  }
}

function registerProductionProtocol(): void {
  const rendererRoot = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  const resources = buildResourceManifest(rendererRoot);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = resources.get(key);
    if (url.host !== 'bundle' || filePath === undefined)
      return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    headers.set('Content-Type', mimeType(filePath));
    return new Response(response.body, { status: response.status, headers });
  });
}

function buildResourceManifest(root: string): Map<string, string> {
  const manifest = new Map<string, string>();
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) manifest.set(relative, absolute);
    }
  };
  visit(root, '');
  return manifest;
}

function mimeType(filePath: string): string {
  return (
    (
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.woff2': 'font/woff2',
      } as Record<string, string>
    )[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  );
}
