import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    name: 'devmate/ignores',
    ignores: ['dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: 'devmate/custom-rules',
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // 原生 Web UI（src/ui/web/*.js）在浏览器跑，不是 node：声明浏览器全局，不与 TS 规则互扰。
  {
    name: 'devmate/ui-web-browser-globals',
    files: ['src/ui/web/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        requestAnimationFrame: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
        ReadableStream: 'readonly',
        Node: 'readonly',
        Element: 'readonly',
      },
    },
  },
  // 构建脚本（node 运行）：声明 node 全局（console/process 等，修复原有 no-undef）。
  {
    name: 'devmate/scripts-node-globals',
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  // ui/web 的单测：mock Response/流类型（不含浏览器 DOM），并用 any 做最小 mock 注入。
  {
    name: 'devmate/ui-web-tests',
    files: ['test/ui-web/**/*.ts'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        ReadableStream: 'readonly',
        DOMException: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Must come last: turns off stylistic rules that conflict with Prettier.
  prettier,
);
