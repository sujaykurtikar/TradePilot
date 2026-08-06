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
      // 'smart' still bans loose == everywhere EXCEPT `x == null`, the
      // conventional idiom for "null or undefined" — used throughout for
      // optional bridge/API values.
      eqeqeq: ['error', 'smart'],
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
    // src/bridge/adapters/** talks to undocumented, minified, unversioned
    // vendor objects (§4.1: "the widget class came back as `Hp`") — there
    // is no real type to give them. `any` + unsafe-* access is the
    // intentional, quarantined shape of this one directory (§5.1's whole
    // point: contain the untyped surface to one replaceable place), not a
    // lapse in rigor. Every access is still wrapped in `guarded()` so a
    // shape mismatch is a caught, logged null — runtime safety comes from
    // that, not from the type checker.
    files: ['src/bridge/adapters/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // The logger's whole job is to be the one console wrapper; everything
    // else must go through it (§7.8).
    files: ['src/utils/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  prettierConfig,
];
