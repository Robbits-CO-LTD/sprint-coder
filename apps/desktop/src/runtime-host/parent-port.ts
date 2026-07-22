type UtilityProcessGlobal = {
  parentPort?: Electron.ParentPort | null;
};

export function requireParentPort(runtimeProcess: UtilityProcessGlobal): Electron.ParentPort {
  const port = runtimeProcess.parentPort;
  if (port === undefined || port === null)
    throw new Error('Runtime Host must run inside an Electron UtilityProcess');
  return port;
}
