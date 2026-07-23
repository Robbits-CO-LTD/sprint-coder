import { app, BrowserWindow, dialog, net, protocol, session } from 'electron';
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

const isDevelopment = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceClient | null = null;
let nativeSafeFs: NativeSafeFs | null = null;
let router: IpcRouter | null = null;
let shutdownCommitted = false;
let shutdownInFlight = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);
app.enableSandbox();

const userDataOverride = process.env['VIBE_USER_DATA_DIR'];
if (userDataOverride !== undefined && userDataOverride.length > 0) {
  // E2E and diagnostics isolate their state (and the single-instance lock) per directory.
  app.setPath('userData', resolve(userDataOverride));
} else if (isDevelopment) {
  app.setPath('userData', resolve(process.cwd(), '.vite-user-data'));
}

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
      nativeSafeFs = loadNativeSafeFs({
        lockDirectoryPath: join(app.getPath('userData'), 'native-safe-fs-locks'),
      });
      persistence = new SqlitePersistenceClient(
        join(app.getPath('userData'), 'vibe-editor3.sqlite3'),
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
app.on('before-quit', (event) => {
  if (shutdownCommitted) return;
  event.preventDefault();
  if (shutdownInFlight) return;
  shutdownInFlight = true;
  void (async () => {
    try {
      await router?.dispose();
    } catch (error) {
      console.error('CommandRunner shutdown did not fully drain', error);
    } finally {
      try {
        persistence?.close();
      } finally {
        shutdownCommitted = true;
        app.quit();
      }
    }
  })();
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
      console.log(
        `Native mutation platform gate denied reconciliation: ${gate.reasons.join(', ')}`,
      );
    }
  } catch (error) {
    // Fail-closed dormant wiring: a recovery-wiring failure must neither enable
    // mutation nor block the read-only application from starting.
    console.error('Edit Saga recovery wiring did not initialize', error);
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
