import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { readdirSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IpcRouter } from './ipc';
import { loadNativeSafeFs, nativeSafeFsAddonLocation, type NativeSafeFs } from './native-safe-fs';
import { SqliteEditSagaLeaseGuard, SqlitePersistenceClient } from './persistence';
import { EditSagaExecutor, PersistenceEditSagaStore } from './edit-saga';
import { reconcileUserFileSaves } from './user-file-save-saga';
import { EditArtifactStore } from './edit-artifact-store';
import { NativeSafeFsEditEffectBoundary } from './native-safe-fs-edit-boundary';
import { reconcileStartupNativeMutations } from './native-mutation-recovery';
import { MutationLeaseStaleError } from './mutation-lease';
import type { MutationLeaseToken } from './mutation-lease';
import { FileRevisionRegistry } from './file-revision';
import { executeWorkspaceCreateDirectory, type WorkspacePatchDeps } from './workspace-patch-tool';
import type { NativeSafeFsSession } from './native-safe-fs';
import {
  evaluateNativeMutationPlatformGate,
  type NativeMutationPackagedLoadEvidence,
} from './native-mutation-platform-gate';
import {
  loadBundledManagedLocalSidecar,
  ManagedLocalSidecarError,
} from './managed-local-sidecar-bundle';
import { secureLogger, writeSecureLogEntry } from './secure-logger';
import { combineLogSinks, createPersistentLog, resolveDiagnosticLogRoot } from './persistent-log';
import {
  installUpdateWithFallback,
  startAutoUpdate,
  type AutoUpdateController,
} from './auto-update';
import {
  IPC_CHANNELS,
  updateCheckResultSchema,
  updateHealthSchema,
  type UpdateHealth,
} from '@sprint-coder/contracts';
import {
  applyWindowControl,
  isWindowControlAction,
  presentWindow,
  restoreWindow,
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
ipcMain.handle(IPC_CHANNELS.updateCheckNow, async (event) => {
  if (trustedMainWindowTarget(event) === null || autoUpdateController === null)
    return updateCheckResultSchema.parse({ status: 'unsupported' });
  return updateCheckResultSchema.parse(await autoUpdateController.checkNow());
});
ipcMain.on(IPC_CHANNELS.updateOpenManual, (event) => {
  if (trustedMainWindowTarget(event) === null) return;
  void shell
    .openExternal('https://github.com/Robbits-CO-LTD/sprint-coder/releases/latest')
    .catch((error) => secureLogger.warn('Manual update page could not be opened', error));
});
ipcMain.on(IPC_CHANNELS.updateOpenLog, (event) => {
  if (trustedMainWindowTarget(event) === null) return;
  const logPath =
    process.platform === 'win32'
      ? join(dirname(dirname(process.execPath)), 'Squirrel-Update.log')
      : join(app.getPath('userData'), 'logs');
  shell.showItemInFolder(logPath);
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
  initializePersistentDiagnostics();

  app.on('second-instance', () => {
    showMainWindow();
  });

  app.on('activate', () => showMainWindow());

  void app
    .whenReady()
    .then(async () => {
      if (!isDevelopment) registerProductionProtocol();
      await initializeManagedLocalSidecarCapability();
      nativeSafeFs = loadNativeSafeFs({
        lockDirectoryPath: join(app.getPath('userData'), 'native-safe-fs-locks'),
      });
      persistence = new SqlitePersistenceClient(
        join(app.getPath('userData'), 'sprint-coder.sqlite3'),
        (binding) => nativeSafeFs!.assertSession(binding),
        (workspaceKey, minimumFence) =>
          nativeSafeFs!.invalidateWorkspace(workspaceKey, minimumFence),
      );
      const startupQuarantines = persistence.initializeMutationRecovery(
        randomUUID(),
        new Date().toISOString(),
      );
      const workspaceEdit = await wireEditSagaRecovery(
        persistence,
        nativeSafeFs,
        startupQuarantines,
      );
      await reconcileUserFileSaves(persistence, (taskId, requestedRootId) => {
        const workspace = persistence!.getEffectiveWorkspaceSet(taskId);
        const rootId =
          requestedRootId === 'legacy-primary' ? workspace.primaryRootId : requestedRootId;
        if (rootId === null) return null;
        return workspace.roots.find((root) => root.rootId === rootId) ?? null;
      });
      mainWindow = createWindow();
      const trustedOrigin =
        MAIN_WINDOW_VITE_DEV_SERVER_URL === undefined
          ? 'app://bundle'
          : new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
      router = new IpcRouter(mainWindow, persistence, trustedOrigin, workspaceEdit);
      await router.initialize();
      router.register();
      await loadRenderer(mainWindow);
      publishUpdateHealth(persistence.getUpdateHealth());
      autoUpdateController = startAutoUpdate({
        updater: autoUpdater,
        dialog,
        fetch: (url, init) => net.fetch(url, init),
        logger: secureLogger,
        restartToInstall: restartToInstallUpdate,
        getActiveTurns: async () => router?.getActiveTurnsForUpdate() ?? [],
        stopActiveTurns: async (turns) => router?.stopActiveTurnsForUpdate(turns),
        currentVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        architecture: process.arch,
        executablePath: process.execPath,
        macAutoUpdateEligible: __SPRINT_CODER_MAC_AUTO_UPDATE_ELIGIBLE__,
        recordSuccess: () =>
          publishUpdateHealth(persistence!.recordUpdateCheckSuccess(new Date().toISOString())),
        recordFailure: (category) =>
          publishUpdateHealth(
            persistence!.recordUpdateCheckFailure(new Date().toISOString(), category),
          ),
      });
    })
    .catch((error: unknown) => {
      // Fatal initialization failure must be visible, never silently swallowed (Slice 1.1).
      secureLogger.error(
        'Sprint Coder initialization failed',
        { process: 'main', error },
        { event: 'system.initialization.failed', status: 'failed' },
      );
      dialog.showErrorBox(
        'Sprint Coder の起動に失敗しました',
        error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error),
      );
      app.exit(1);
    });
}

async function initializeManagedLocalSidecarCapability(): Promise<void> {
  try {
    const bundle = await loadBundledManagedLocalSidecar();
    secureLogger.info('Managed Local sidecar bundle verified', {
      process: 'main',
      target: bundle.target,
      runtimeVersion: bundle.manifest.runtimeVersion,
      candidateBackends: bundle.manifest.candidateBackends,
    });
  } catch (error) {
    secureLogger.warn('Managed Local sidecar is unavailable', {
      process: 'main',
      code: error instanceof ManagedLocalSidecarError ? error.code : 'unknown',
    });
  }
}

function initializePersistentDiagnostics(): void {
  try {
    const persistentLog = createPersistentLog(
      resolveDiagnosticLogRoot({
        homeDirectory: homedir(),
        userDataOverride,
        platform: process.platform,
      }),
    );
    secureLogger.setSink(combineLogSinks(persistentLog.sink, writeSecureLogEntry));
    secureLogger.info(
      'Persistent diagnostic logging initialized',
      {
        process: 'main',
        version: app.getVersion(),
        platform: process.platform,
        architecture: process.arch,
        packaged: app.isPackaged,
      },
      { event: 'system.logging.initialized', status: 'completed' },
    );
  } catch (error) {
    secureLogger.error('Persistent diagnostic logging could not be initialized', error, {
      event: 'system.logging.initialization_failed',
      status: 'failed',
    });
  }

  process.on('uncaughtException', (error) => {
    secureLogger.error(
      'Uncaught exception in Main process',
      { process: 'main', error },
      { event: 'system.process.uncaught_exception', status: 'failed' },
    );
    app.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    secureLogger.error(
      'Unhandled promise rejection in Main process',
      {
        process: 'main',
        reason,
      },
      { event: 'system.process.unhandled_rejection', status: 'failed' },
    );
  });

  app.on('render-process-gone', (_event, _webContents, details) => {
    if (details.reason === 'clean-exit') return;
    secureLogger.error(
      'Renderer process exited unexpectedly',
      {
        process: 'renderer',
        reason: details.reason,
        exitCode: details.exitCode,
      },
      { event: 'system.renderer.exited', status: 'failed', result: details.reason },
    );
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    secureLogger.error(
      'Electron child process exited unexpectedly',
      {
        process: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName,
        name: details.name,
      },
      { event: 'system.child_process.exited', status: 'failed', result: details.reason },
    );
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
    secureLogger.info('Sprint Coder shutdown started', undefined, {
      event: 'system.shutdown.started',
      status: 'running',
    });
    try {
      await disposeApplicationResources();
    } finally {
      secureLogger.info('Sprint Coder shutdown completed', undefined, {
        event: 'system.shutdown.completed',
        status: 'completed',
      });
      shutdownCommitted = true;
      // The original quit event was canceled while async Runtime/MCP cleanup drained. Calling
      // app.quit() again from that canceled lifecycle can leave a headless Electron main process
      // alive on macOS. Cleanup is complete here, so exit deterministically.
      app.exit(0);
    }
  })();
});

async function restartToInstallUpdate(): Promise<'started' | 'busy' | 'shutdown_in_progress'> {
  if (shutdownCommitted || shutdownInFlight) return 'shutdown_in_progress';
  if (router !== null && !(await router.prepareUpdateInstall())) return 'busy';
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
  return 'started';
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
  window.once('ready-to-show', () => presentWindow(window));
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

function trustedMainWindowTarget(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  const window = mainWindow;
  if (
    window === null ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return null;
  return window;
}

function publishUpdateHealth(health: UpdateHealth): void {
  const safe = updateHealthSchema.parse(health);
  const window = mainWindow;
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(IPC_CHANNELS.updateHealthEvent, safe);
}

function showMainWindow(): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return;
  restoreWindow(window);
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
  startupQuarantines: ReturnType<SqlitePersistenceClient['initializeMutationRecovery']>,
): Promise<WorkspacePatchDeps | undefined> {
  // Slice 4.7d/4.7e: connect the NativeSafeFs edit boundary to the Edit Saga executor and
  // its restart recovery. The workspace mutation path stays fail-closed — no write
  // ToolDefinition is published and the session resolver refuses to open a native
  // mutation session — until the platform gate (native-mutation-platform-gate.ts)
  // allows it, which requires a supported native boundary, a proven packaged+unpacked addon load, a true
  // mutation probe capability, and persistence mutation authority all at once. This
  // dormant wiring must never break startup.
  try {
    const artifacts = await EditArtifactStore.open({
      rootPath: join(app.getPath('userData'), 'edit-artifacts'),
      quotaBytes: 256 * 1024 * 1024,
    });
    const probe = await nativeSafeFs.probe();
    const location = nativeSafeFsAddonLocation();
    // Packaged evidence remains bound to app.asar.unpacked. Development evidence is narrower:
    // it exists only for an unpackaged app served from the Vite URL, and the pure gate below
    // additionally accepts only loopback HTTP origins. This keeps remote renderer URLs and
    // packaged builds from using the development path while making the real editing boundary
    // testable in the development app.
    const packagedLoadEvidence: NativeMutationPackagedLoadEvidence | null =
      app.isPackaged && location.loadedFromUnpacked && probe.available
        ? { source: 'packaged-app', addonPath: location.addonPath, loadedFromUnpacked: true }
        : null;
    const developmentLoadEvidence =
      !app.isPackaged &&
      !location.loadedFromUnpacked &&
      MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined
        ? {
            source: 'vite-dev-server' as const,
            addonPath: location.addonPath,
            loadedFromUnpacked: false as const,
            appPackaged: false as const,
            rendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
          }
        : null;
    const gate = evaluateNativeMutationPlatformGate({
      platform: process.platform,
      packagedLoadEvidence,
      developmentLoadEvidence,
      probe: {
        available: probe.available,
        capabilities: { mutation: probe.capabilities.mutation },
      },
      persistenceAuthorityAvailable: persistence.isNativeMutationAuthorityAvailable(),
    });
    if (!gate.allowed) {
      secureLogger.info('Native mutation platform gate denied reconciliation', {
        reasons: gate.reasons,
      });
      return undefined;
    }
    const lockDirectoryPath = join(app.getPath('userData'), 'native-safe-fs-locks');
    await mkdir(lockDirectoryPath, { recursive: true, mode: 0o700 });
    const sessions = new Map<string, NativeSafeFsSession>();
    const resolveSession = async (lease: MutationLeaseToken): Promise<NativeSafeFsSession> => {
      const existing = sessions.get(lease.leaseId);
      if (existing !== undefined) return existing;
      const workspacePath = persistence.getMutationWorkspacePath(
        lease.taskId,
        lease.turnId,
        lease.rootId,
      );
      if (workspacePath === null) throw new MutationLeaseStaleError();
      const root = await lstat(workspacePath, { bigint: true });
      if (!root.isDirectory()) throw new MutationLeaseStaleError();
      const session = await nativeSafeFs.openSession({
        rootId: lease.rootId ?? 'legacy-primary',
        workspacePath,
        rootDev: root.dev.toString(),
        rootIno: root.ino.toString(),
        workspaceKey: lease.workspaceKey,
        lockDirectoryPath,
        fence: String(lease.fence),
      });
      sessions.set(lease.leaseId, session);
      return session;
    };
    const closeLeaseSession = async (lease: MutationLeaseToken): Promise<void> => {
      const active = sessions.get(lease.leaseId);
      if (active === undefined) return;
      try {
        await nativeSafeFs.closeSession(active);
      } finally {
        sessions.delete(lease.leaseId);
      }
    };
    const releasedRecoveryFences = new Map<string, number>();
    const leaseGuard = new SqliteEditSagaLeaseGuard(
      persistence,
      randomUUID(),
      undefined,
      undefined,
      async (lease) => {
        await closeLeaseSession(lease);
        if (lease.purpose === 'recovery')
          releasedRecoveryFences.set(lease.workspaceKey, lease.fence);
      },
    );
    const executor = new EditSagaExecutor(
      new PersistenceEditSagaStore(persistence),
      new NativeSafeFsEditEffectBoundary({
        native: nativeSafeFs,
        journal: persistence,
        artifacts,
        resolveSession,
      }),
      artifacts,
      undefined,
      leaseGuard,
    );
    await reconcileStartupNativeMutations({
      journal: persistence,
      recoverSaga: (sagaId) => executor.recover(sagaId),
      reconcileEditSagas: () => executor.reconcileAll(),
      startupQuarantines,
      releasedFences: releasedRecoveryFences,
      now: () => new Date().toISOString(),
    });
    return {
      turnWorkspaceSetFor: (taskId, turnId) =>
        persistence.readTurnWorkspaceSetForTask(taskId, turnId),
      turnRootMutationBindingsFor: (turnId) => persistence.getTurnWorkspaceMutationBindings(turnId),
      revisions: new FileRevisionRegistry(),
      apply: (request) => executor.apply(request),
      createDirectory: ({ taskId, turnId, rootId, path, guard, boundary }) =>
        executeWorkspaceCreateDirectory(
          { rootId, path },
          { taskId, turnId },
          {
            turnWorkspaceSetFor: (candidateTaskId, candidateTurnId) =>
              persistence.readTurnWorkspaceSetForTask(candidateTaskId, candidateTurnId),
            turnRootMutationBindingsFor: (candidateTurnId) =>
              persistence.getTurnWorkspaceMutationBindings(candidateTurnId),
            revisions: new FileRevisionRegistry(),
            apply: (request) => executor.apply(request),
            policyEpochFor: (candidateTaskId) =>
              persistence.getPermissionPolicy(candidateTaskId).policyEpoch,
          },
          guard,
          boundary,
        ),
      policyEpochFor: (taskId) => persistence.getPermissionPolicy(taskId).policyEpoch,
    };
  } catch (error) {
    // Fail-closed dormant wiring: a recovery-wiring failure must neither enable
    // mutation nor block the read-only application from starting.
    secureLogger.error('Edit Saga recovery wiring did not initialize', error);
    return undefined;
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
