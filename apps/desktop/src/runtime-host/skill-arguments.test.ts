import { describe, expect, it } from 'vitest';
import { expandSkillArguments } from './skill-arguments';

describe('Skill argument expansion', () => {
  it('expands full and positional arguments without evaluating shell syntax', () => {
    const content = 'all=$ARGUMENTS; zero=$0; one=$ARGUMENTS[1]';
    expect(expandSkillArguments(content, 'alpha "two words" $(touch /tmp/nope)')).toBe(
      'all=alpha "two words" $(touch /tmp/nope); zero=alpha; one=two words',
    );
  });

  it('leaves a Skill unchanged when no arguments were bound', () => {
    expect(expandSkillArguments('Use $ARGUMENTS', undefined)).toBe('Use $ARGUMENTS');
  });
});
