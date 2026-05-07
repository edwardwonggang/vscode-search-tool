import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: [
    'vscode',
    'cpu-features',
    './crypto/build/Release/sshcrypto.node'
  ],
  logLevel: 'info'
});
