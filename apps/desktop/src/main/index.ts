import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IpcRouter } from './ipc';
import { loadNativeSafeFs, nativeSafeFsAddonLocation, type NativeSafeFs } from './native-safe-fs';
import { SqliteEditSagaLeaseGuard, SqlitePersistenceClient } from './persistence';
import { EditSagaExecutor, PersistenceEditSagaStore } from './edit-saga';
import { EditArtifactStore } from './edit-artifact-store';
import { NativeSafeFsEditEffectBoundary } from './native-safe-fs-edit-boundary';
import { MutationLeaseStaleError } from './mutation-lease';
import {
  evaluateNativeMutationPlatformGate,
  type NativeMutationPackagedLoadEvidence,
} from './native-mutation-platform-gate';
import { secureLogger } from './secure-logger';
import {
  installUpdateWithFallback,
  startAutoUpdate,
  type AutoUpdateController,
} from './auto-update';
import {
  applyWindowControl,
  isWindowControlAction,
  WINDOW_CONTROL_CHANNELS,
  windowChromeOptions,
} from '../window-controls';

const isDevelopment = !app.isPackaged;
app.setName('Sprint Coder');
let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceClient | null = null;
let nativeSafeFs: NativeSafeFs | null = null;
let router: IpcRouter | null = null;
let autoUpdateController: AutoUpdateController | null = null;
let shutdownCommitted = false;
let shutdownInFlight = false;

if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.SprintCoder.SprintCoder');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);
app.enableSandbox();

ipcMain.on(WINDOW_CONTROL_CHANNELS.action, (event, action: unknown) => {
  const window = trustedWindowControlTarget(event);
  if (window === null || !isWindowControlAction(action)) return;
  applyWindowControl(window, action);
});
ipcMain.handle(WINDOW_CONTROL_CHANNELS.getMaximized, (event) => {
  const window = trustedWindowControlTarget(event);
  return window?.isMaximized() ?? false;
});

const userDataOverride = process.env['SPRINT_CODER_USER_DATA_DIR'];
if (userDataOverride !== undefined && userDataOverride.length > 0) {
  // E2E and diagnostics isolate their state (and the single-instance lock) per directory.
  app.setPath('userData', resolve(userDataOverride));
} else if (isDevelopment) {
  app.setPath('userData', resolve(process.cwd(), '.vite-user-data'));
}

const hasLock = !squirrelStartup && app.requestSingleInstanceLock();
if (squirrelStartup || !hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.on('activate', () => showMainWindow());

  void app
    .whenReady()
    .then(async () => {
      if (!isDevelopment) registerProductionProtocol();
      nativeSafeFs = loadNativeSafeFs({
        lockDirectoryPath: join(app.getPath('userData'), 'native-safe-fs-locks'),
      });
      persistence = new SqlitePersistenceClient(
        join(app.getPath('userData'), 'sprint-coder.sqlite3'),
        (binding) => nativeSafeFs!.assertSession(binding),
        (workspaceKey, minimumFence) =>
          nativeSafeFs!.invalidateWorkspace(workspaceKey, minimumFence),
      );
      persistence.initializeMutationRecovery(randomUUID(), new Date().toISOString());
      await wireEditSagaRecovery(persistence, nativeSafeFs);
      mainWindow = createWindow();
      const trustedOrigin =
        MAIN_WINDOW_VITE_DEV_SERVER_URL === undefined
          ? 'app://bundle'
          : new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
      router = new IpcRouter(mainWindow, persistence, trustedOrigin);
      await router.initialize();
      router.register();
      await loadRenderer(mainWindow);
      autoUpdateController = startAutoUpdate({
        updater: autoUpdater,
        dialog,
        fetch: (url, init) => net.fetch(url, init),
        logger: secureLogger,
        restartToInstall: restartToInstallUpdate,
        currentVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        architecture: process.arch,
        executablePath: process.execPath,
        macAutoUpdateEligible: __SPRINT_CODER_MAC_AUTO_UPDATE_ELIGIBLE__,
      });
    })
    .catch((error: unknown) => {
      // Fatal initialization failure must be visible, never silently swallowed (Slice 1.1).
      dialog.showErrorBox(
        'Sprint Coder の起動に失敗しました',
        error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error),
      );
      app.exit(1);
    });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (shutdownCommitted) return;
  event.preventDefault();
  if (shutdownInFlight) return;
  shutdownInFlight = true;
  void (async () => {
    try {
      await disposeApplicationResources();
    } finally {
      shutdownCommitted = true;
      // The original quit event was canceled while async Runtime/MCP cleanup drained. Calling
      // app.quit() again from that canceled lifecycle can leave a headless Electron main process
      // alive on macOS. Cleanup is complete here, so exit deterministically.
      app.exit(0);
    }
  })();
});

async function restartToInstallUpdate(): Promise<void> {
  if (shutdownCommitted || shutdownInFlight) return;
  shutdownInFlight = true;
  try {
    await disposeApplicationResources();
  } finally {
    // quitAndInstall must own the final quit event. `shutdownCommitted` keeps our normal
    // before-quit handler from canceling the updater's relaunch/install sequence.
    shutdownCommitted = true;
    installUpdateWithFallback({
      quitAndInstall: () => autoUpdater.quitAndInstall(),
      exit: (code) => app.exit(code),
      reportFailure: (error) => {
        secureLogger.error('Automatic update installer failed to start', error);
        dialog.showErrorBox(
          'Sprint Coder の更新に失敗しました',
          'アプリを終了します。次回の起動時に更新をもう一度確認します。',
        );
      },
    });
  }
}

async function disposeApplicationResources(): Promise<void> {
  autoUpdateController?.stop();
  try {
    await router?.dispose();
  } catch (error) {
    secureLogger.error('CommandRunner shutdown did not fully drain', error);
  }
  try {
    persistence?.close();
  } catch (error) {
    secureLogger.error('Persistence shutdown did not complete cleanly', error);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: '#12110f',
    ...windowChromeOptions(process.platform),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform !== 'darwin') window.setMenu(null);
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (process.platform === 'darwin') {
    // Keep the BrowserWindow (and the window-bound IPC router) alive when the user clicks the
    // macOS close button. A later Dock activation or second launch can then restore the same
    // session instead of touching a destroyed BrowserWindow.
    window.on('close', (event) => {
      if (shutdownInFlight || shutdownCommitted) return;
      event.preventDefault();
      window.hide();
    });
  }
  const publishMaximizedState = (): void => {
    if (!window.webContents.isDestroyed())
      window.webContents.send(WINDOW_CONTROL_CHANNELS.maximizedChanged, window.isMaximized());
  };
  window.on('maximize', publishMaximizedState);
  window.on('unmaximize', publishMaximizedState);
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.once('ready-to-show', () => window.show());
  return window;
}

function trustedWindowControlTarget(
  event: IpcMainEvent | IpcMainInvokeEvent,
): BrowserWindow | null {
  const window = mainWindow;
  if (
    process.platform !== 'win32' ||
    window === null ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return null;
  return window;
}

function showMainWindow(): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadURL('app://bundle/index.html');
  }
}

async function wireEditSagaRecovery(
  persistence: SqlitePersistenceClient,
  nativeSafeFs: NativeSafeFs,
): Promise<void> {
  // Slice 4.7d/4.7e: connect the NativeSafeFs edit boundary to the Edit Saga executor and
  // its restart recovery. The workspace mutation path stays fail-closed — no write
  // ToolDefinition is published and the session resolver refuses to open a native
  // mutation session — until the platform gate (native-mutation-platform-gate.ts)
  // allows it, which requires darwin, a proven packaged+unpacked addon load, a true
  // mutation probe capability, and persistence mutation authority all at once. This
  // dormant wiring must never break startup.
  try {
    const artifacts = await EditArtifactStore.open({
      rootPath: join(app.getPath('userData'), 'edit-artifacts'),
      quotaBytes: 256 * 1024 * 1024,
    });
    const executor = new EditSagaExecutor(
      new PersistenceEditSagaStore(persistence),
      new NativeSafeFsEditEffectBoundary({
        native: nativeSafeFs,
        journal: persistence,
        artifacts,
        resolveSession: async () => {
          throw new MutationLeaseStaleError();
        },
      }),
      artifacts,
      undefined,
      new SqliteEditSagaLeaseGuard(persistence, randomUUID()),
    );
    const probe = await nativeSafeFs.probe();
    const location = nativeSafeFsAddonLocation();
    // Evidence only exists once the app is actually packaged AND the addon was actually
    // loaded from the app.asar.unpacked sibling AND the probe confirms it is available.
    // In every environment this codebase currently runs in (dev, CI, unit tests), at
    // least one of these is false, so packagedLoadEvidence is null and the gate denies.
    const packagedLoadEvidence: NativeMutationPackagedLoadEvidence | null =
      app.isPackaged && location.loadedFromUnpacked && probe.available
        ? { source: 'packaged-app', addonPath: location.addonPath, loadedFromUnpacked: true }
        : null;
    const gate = evaluateNativeMutationPlatformGate({
      platform: process.platform,
      packagedLoadEvidence,
      probe: {
        available: probe.available,
        capabilities: { mutation: probe.capabilities.mutation },
      },
      persistenceAuthorityAvailable: persistence.isNativeMutationAuthorityAvailable(),
    });
    if (gate.allowed) {
      await executor.reconcileAll();
    } else {
      secureLogger.info('Native mutation platform gate denied reconciliation', {
        reasons: gate.reasons,
      });
    }
  } catch (error) {
    // Fail-closed dormant wiring: a recovery-wiring failure must neither enable
    // mutation nor block the read-only application from starting.
    secureLogger.error('Edit Saga recovery wiring did not initialize', error);
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
