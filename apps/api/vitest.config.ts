import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Vitest's default transform (esbuild) drops decorator metadata, which Nest's dependency injection
// needs. SWC keeps it.
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
