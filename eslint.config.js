'use strict';

/**
 * ESLint flat config (required by ESLint v9+).
 * Declares the browser + Node globals used by this project so that `App`
 * (defined in public/js/main.js) and the DOM APIs resolve correctly.
 */

module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'data/**', '*.bak_*'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Node
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        // Browser
        window: 'readonly',
        document: 'readonly',
        CustomEvent: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        getComputedStyle: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
        localStorage: 'readonly',
        IntersectionObserver: 'readonly',
        MutationObserver: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Standard built-ins
        Promise: 'readonly',
        JSON: 'readonly',
        Date: 'readonly',
        Math: 'readonly',
        Number: 'readonly',
        String: 'readonly',
        Object: 'readonly',
        Array: 'readonly',
        Error: 'readonly',
        isNaN: 'readonly',
        parseInt: 'readonly',
        parseFloat: 'readonly',
        encodeURIComponent: 'readonly',
        decodeURIComponent: 'readonly',
        // App global exposed by public/js/main.js
        App: 'writable'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^(App|_)', caughtErrors: 'none' }],
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-cond-assign': ['error', 'except-parens'],
      'no-func-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error'
    }
  }
];
