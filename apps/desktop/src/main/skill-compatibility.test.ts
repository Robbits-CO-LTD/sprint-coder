import { describe, expect, it } from 'vitest';
import { analyzeSkillPackage } from './skill-compatibility';

const skill = (frontmatter: string, body = 'Follow the workflow.') =>
  Buffer.from(`---\n${frontmatter}\n---\n${body}\n`, 'utf8');

describe('Skill compatibility analysis', () => {
  it('accepts the portable Agent Skills metadata without granting requested tools', () => {
    const result = analyzeSkillPackage(
      skill(
        [
          'name: reviewer',
          'description: Review changes safely',
          'license: MIT',
          'compatibility: Requires git',
          'metadata:',
          '  owner: platform',
          'allowed-tools:',
          '  - Read',
          '  - Bash(git diff *)',
        ].join('\n'),
      ),
    );

    expect(result.compatibility).toMatchObject({
      profile: 'portable',
      runtimeSupport: { codex: 'full', claude: 'full', provider: 'full' },
      requestedTools: ['Bash(git diff *)', 'Read'],
      requiresConversion: false,
    });
    expect(result.compatibility.warnings[0]).toContain('権限を付与せず');
  });

  it('classifies Codex UI metadata without making it a provider requirement', () => {
    const result = analyzeSkillPackage(skill('name: docs\ndescription: Read docs'), [
      {
        path: 'agents/openai.yaml',
        content: 'interface:\n  display_name: Docs\npolicy:\n  allow_implicit_invocation: false\n',
      },
    ]);
    expect(result.compatibility).toMatchObject({
      profile: 'codex-native',
      runtimeSupport: { codex: 'full', claude: 'portable', provider: 'portable' },
    });
  });

  it('does not claim full Claude or API support when a Portable Skill needs package resources', () => {
    const result = analyzeSkillPackage(skill('name: docs\ndescription: Read references'), [
      { path: 'references/guide.md', content: '# Guide' },
      { path: 'scripts/check.sh', content: '#!/bin/sh' },
    ]);
    expect(result.compatibility).toMatchObject({
      profile: 'portable',
      runtimeSupport: { codex: 'full', claude: 'portable', provider: 'portable' },
      requiresConversion: false,
    });
    expect(result.compatibility.features).toContain('package:resources');
  });

  it('detects Claude-native arguments and blocks dynamic shell injection', () => {
    const result = analyzeSkillPackage(
      skill(
        'name: deploy\ndescription: Deploy safely\ncontext: fork\ndisable-model-invocation: true',
        'Deploy $ARGUMENTS.\n!`git status`',
      ),
    );
    expect(result.compatibility.profile).toBe('claude-native');
    expect(result.compatibility.features).toContain('claude:dynamic-command');
    expect(result.compatibility.runtimeSupport).toEqual({
      codex: 'blocked',
      claude: 'blocked',
      provider: 'blocked',
    });
    expect(result.compatibility.requiresConversion).toBe(true);
  });

  it('rejects duplicate keys, aliases, custom tags, and excessive nesting', () => {
    expect(() =>
      analyzeSkillPackage(skill('name: one\nname: two\ndescription: duplicate')),
    ).toThrow(/frontmatter/u);
    expect(() =>
      analyzeSkillPackage(
        skill('name: aliased\ndescription: &shared text\nmetadata:\n  copy: *shared'),
      ),
    ).toThrow(/alias/u);
    expect(() => analyzeSkillPackage(skill('name: tagged\ndescription: !unsafe value'))).toThrow(
      /frontmatter|unsafe|tag/u,
    );
    const nested = Array.from({ length: 18 }, (_, index) => `${'  '.repeat(index)}k${index}:`).join(
      '\n',
    );
    expect(() =>
      analyzeSkillPackage(skill(`name: nested\ndescription: deep\nmetadata:\n${nested} value`)),
    ).toThrow(/deep/u);
  });
});
