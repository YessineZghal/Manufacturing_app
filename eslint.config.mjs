import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // vinext 1.0.0-beta.5: client navigation through next/link throws ("e is not a function")
    // and its prefetch logs errors, so internal links are plain <a> elements (full page loads).
    // Re-enable together with <Link> once vinext fixes it; tests/browser checks every link.
    rules: { '@next/next/no-html-link-for-pages': 'off' },
  },
  globalIgnores([
    'dist/**',
    '.vinext/**',
    '.wrangler/**',
    'playwright-report/**',
    'test-results/**',
  ]),
]);

export default eslintConfig;
