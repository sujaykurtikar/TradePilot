// @ts-check
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

/**
 * Bridge quarantine (§5.2/§5.3 of IMPLEMENTATION_PLAN.md):
 * "nothing outside src/bridge/** may reference TradingViewApi or tvWidget."
 * All reverse-engineered, undocumented vendor internals must stay inside
 * src/bridge/** so a vendor deploy that breaks them is a one-file fix.
 */
const RESTRICTED_GLOBALS = [
  {
    name: 'TradingViewApi',
    message:
      'TradingViewApi is a reverse-engineered vendor internal. It may only be referenced inside src/bridge/** (see IMPLEMENTATION_PLAN.md §5.1/§5.3).',
  },
  {
    name: 'tvWidget',
    message:
      'tvWidget is a reverse-engineered vendor internal. It may only be referenced inside src/bridge/** (see IMPLEMENTATION_PLAN.md §5.1/§5.3).',
  },
  {
    name: 'tradingViewApi',
    message:
      'tradingViewApi (Kotak Neo global, §4.2) is a reverse-engineered vendor internal. It may only be referenced inside src/bridge/** (see IMPLEMENTATION_PLAN.md §5.1/§5.3).',
  },
];

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.mjs'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      ...tsPlugin.configs['recommended-requiring-type-checking']?.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-globals': ['error', ...RESTRICTED_GLOBALS],
      // .catch(() => {}) is banned project-wide — §7.2 "No silent failures".
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The bridge is the ONE place allowed to touch these globals.
    files: ['src/bridge/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettierConfig,
];
