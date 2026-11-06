import {
  graphWorkerDiagnosticCodeSchema,
  type GraphWorkerDiagnosticCode,
} from '@sprint-coder/contracts';

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

export function rendererDiagnosticCodes(error: unknown): GraphWorkerDiagnosticCode[] {
  const diagnostics = field(error, 'archifyDiagnostics');
  if (!Array.isArray(diagnostics)) return [];
  return safeCodes(diagnostics.slice(0, 16).map((item: unknown) => field(item, 'code')));
}

export function checkDiagnosticCodes(output: string): GraphWorkerDiagnosticCode[] {
  try {
    const report: unknown = JSON.parse(output);
    const checks = field(report, 'checks');
    if (!Array.isArray(checks)) return [];
    return safeCodes(
      checks.slice(0, 32).flatMap((check: unknown) => {
        const name = field(check, 'name');
        return field(check, 'ok') === false && typeof name === 'string' ? [`check/${name}`] : [];
      }),
    );
  } catch {
    return [];
  }
}

function safeCodes(values: unknown[]): GraphWorkerDiagnosticCode[] {
  const codes = new Set<GraphWorkerDiagnosticCode>();
  for (const value of values) {
    const parsed = graphWorkerDiagnosticCodeSchema.safeParse(value);
    if (parsed.success) codes.add(parsed.data);
    if (codes.size === 16) break;
  }
  return [...codes];
}
