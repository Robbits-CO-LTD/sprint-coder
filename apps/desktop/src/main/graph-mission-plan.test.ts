import { describe, expect, it } from 'vitest';
import type { GraphMissionPlan } from '@sprint-coder/contracts';
import { nextGraphDocument, parseStoredGraphDocument } from './graph-document';
import { compareGraphDocuments } from './graph-diff';
import { validateGraphMissionPlan } from './graph-mission-plan';
import { graphDocumentForModel } from './graph-sources';

const diagram = {
  schema_version: 2,
  diagram_type: 'workflow',
  meta: { title: 'Plan' },
  lanes: [{ id: 'work', label: 'Work' }],
  nodes: ['a', 'b', 'c'].map((id, col) => ({ id, type: 'backend', label: id, lane: 'work', col })),
  edges: [],
};
const plan: GraphMissionPlan = {
  mode: 'graph',
  objective: 'Implement and verify',
  doneCriteria: ['Integration passes'],
  steps: ['a', 'b', 'c'].map((key, index) => ({
    key,
    nodeId: key,
    workerId: `worker-${key}`,
    objective: `Work ${key}`,
    doneCriteria: ['Pass'],
    access: index === 2 ? 'read-only' : 'workspace-write',
    dependsOn: index === 2 ? ['a', 'b'] : [],
    writeClaims:
      index === 2 ? [] : [{ rootId: 'root', path: `src/${key}.ts`, semanticKeys: ['shared-api'] }],
    resourceClaims: index === 2 ? [{ scope: 'machine', key: 'db', rootId: null }] : [],
  })),
};

describe('graph Mission draft binding and semantics', () => {
  it('bounds the encoded plan independently of its character-count limits', () => {
    const keys = Array.from({ length: 12 }, (_, index) => `step${index}`);
    const large = {
      ...plan,
      steps: keys.map((key) => ({
        ...plan.steps[0]!,
        key,
        nodeId: key,
        objective: '界'.repeat(10_000),
      })),
    };
    expect(() => validateGraphMissionPlan(large, 'workflow', keys)).toThrow('too large');
  });
  it('persists declarations without interpreting diagram connections as execution dependencies', () => {
    const saved = nextGraphDocument('task', diagram, null, [], [], plan);
    expect(parseStoredGraphDocument(JSON.parse(JSON.stringify(saved))).missionPlan).toEqual(plan);
    expect(graphDocumentForModel(saved)).toMatchObject({ missionPlan: plan });
    expect(saved.diagram['edges']).toEqual([]);
    const reordered = structuredClone(plan);
    reordered.steps[2]!.dependsOn.reverse();
    const second = nextGraphDocument('task', diagram, saved, [], [], reordered);
    expect(second.semanticRevision).toBe(saved.semanticRevision);
    expect(compareGraphDocuments(saved, second).changes).toEqual([]);
    const legacy = nextGraphDocument('task', diagram, null);
    const { missionPlan: _missionPlan, ...oldRow } = legacy;
    expect(parseStoredGraphDocument(oldRow)).toEqual(legacy);
  });

  it('revises and compares purpose, completion, access, dependency, write and resource declarations', () => {
    const first = nextGraphDocument('task', diagram, null, [], [], plan);
    const changed = structuredClone(plan);
    changed.objective = 'New objective';
    changed.steps[1]!.dependsOn = ['a'];
    changed.steps[1]!.doneCriteria = ['Compatibility passes'];
    changed.steps[1]!.access = 'read-only';
    changed.steps[1]!.writeClaims = [];
    changed.steps[2]!.resourceClaims = [{ scope: 'workspace', key: 'db', rootId: 'root' }];
    const second = nextGraphDocument('task', diagram, first, [], [], changed);
    expect(second.semanticRevision).toBe(first.semanticRevision + 1);
    const diff = compareGraphDocuments(first, second);
    expect(diff.changes.find((change) => change.kind === 'mission')?.fields).toContainEqual({
      name: 'objective',
      before: plan.objective,
      after: changed.objective,
    });
    expect(
      diff.changes.find((change) => change.id === 'b')?.fields.map((field) => field.name),
    ).toEqual(['access', 'dependsOn', 'doneCriteria', 'writeClaims']);
    expect(
      diff.changes.find((change) => change.id === 'c')?.fields.map((field) => field.name),
    ).toEqual(['resourceClaims']);
    expect(() =>
      parseStoredGraphDocument({ ...second, semanticDigest: first.semanticDigest }),
    ).toThrow('content mismatch');
    const cleared = nextGraphDocument('task', diagram, second);
    expect(cleared.missionPlan).toBeNull();
    expect(
      compareGraphDocuments(second, cleared).changes.filter(
        (change) => change.kind === 'step' && change.action === 'removed',
      ),
    ).toHaveLength(3);
  });

  it('rejects invalid graph bindings and claims while allowing explicit whole-root/new-file declarations', () => {
    expect(() => validateGraphMissionPlan(plan, 'architecture', ['a', 'b', 'c'])).toThrow(
      'Workflow',
    );
    expect(() => validateGraphMissionPlan(plan, 'workflow', ['a', 'b'])).toThrow('mapping');
    const mutate = (step: Record<string, unknown>) => ({
      ...plan,
      steps: [step, ...plan.steps.slice(1)],
    });
    for (const path of [
      '/absolute',
      '../escape',
      'a/../b',
      'C:\\code',
      'src/*.ts',
      'src//file',
      'file\0.ts',
    ]) {
      expect(() =>
        validateGraphMissionPlan(
          mutate({ ...plan.steps[0], writeClaims: [{ rootId: 'root', path, semanticKeys: [] }] }),
          'workflow',
          ['a', 'b', 'c'],
        ),
      ).toThrow();
    }
    for (const path of [null, 'new/subdir/file.ts']) {
      expect(
        validateGraphMissionPlan(
          mutate({ ...plan.steps[0], writeClaims: [{ rootId: 'root', path, semanticKeys: [] }] }),
          'workflow',
          ['a', 'b', 'c'],
        ),
      ).not.toBeNull();
    }
    for (const step of [
      { ...plan.steps[0], access: 'read-only' },
      {
        ...plan.steps[0],
        writeClaims: [plan.steps[0]!.writeClaims[0], plan.steps[0]!.writeClaims[0]],
      },
      {
        ...plan.steps[0],
        resourceClaims: [{ scope: 'machine', key: 'db', rootId: 'forged-scope' }],
      },
      { ...plan.steps[0], resourceClaims: [{ scope: 'workspace', key: 'db', rootId: null }] },
      {
        ...plan.steps[0],
        resourceClaims: [{ scope: 'machine', key: 'https://user:pass@host', rootId: null }],
      },
    ])
      expect(() => validateGraphMissionPlan(mutate(step), 'workflow', ['a', 'b', 'c'])).toThrow();
  });
});
