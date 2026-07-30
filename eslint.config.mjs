// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/.vite/**',
      '**/.vite-user-data/**',
      '**/out/**',
      '**/node_modules/**',
      'demo/**',
      '.reference-repos/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting is intentionally not enabled here to keep CI fast
        // and to avoid requiring a single shared tsconfig across workspaces.
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
    },
  },
  {
    files: [
      'apps/desktop/src/main/**/*.{ts,tsx}',
      'apps/desktop/src/preload/**/*.{ts,tsx}',
      'apps/desktop/src/runtime-host/**/*.{ts,tsx}',
    ],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: [
      'apps/desktop/src/main/team-coordinator.ts',
      'apps/desktop/src/main/team-execution-scheduler.ts',
      'apps/desktop/src/main/team-tools.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                './openai-*',
                './anthropic-*',
                './gemini-*',
                './openrouter-*',
                './xai-*',
                'openai',
                '@anthropic-ai/*',
                '@google/generative-ai',
              ],
              message:
                'Team Core may depend only on provider-neutral runtime/registry contracts, never a Provider client, Adapter, or SDK.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
