// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/* global console */
/* global process */
/* eslint no-process-exit: "off" */

import botLayer from '@medplum/bot-layer/package.json' with { type: 'json' };
import esbuild from 'esbuild';
import fastGlob from 'fast-glob';

// Find all TypeScript files in the bots directory (excluding test files)
const entryPoints = fastGlob.sync('./src/bots/**/*.ts').filter((file) => !file.endsWith('test.ts'));

// Dependencies from bot-layer are available in the Medplum Lambda runtime, so mark them as external.
// Everything else (including the phenoml SDK) is bundled into each bot's output file.
const botLayerDeps = [...Object.keys(botLayer.dependencies), '@aws-sdk/client-*'];

// Define the esbuild options
const esbuildOptions = {
  entryPoints: entryPoints,
  bundle: true, // Bundle imported functions (including the phenoml SDK)
  outdir: './dist', // Output directory for compiled files
  platform: 'node', // Target Node.js platform (for Lambda)
  loader: {
    '.ts': 'ts', // Load TypeScript files
  },
  resolveExtensions: ['.ts', '.js'],
  external: botLayerDeps, // Only exclude bot-layer deps (phenoml will be bundled)
  format: 'cjs', // CommonJS format for Lambda compatibility
  target: 'es2020', // Target ECMAScript version
  tsconfig: 'tsconfig-bots.json',
  footer: { js: 'Object.assign(exports, module.exports);' }, // Required for VM Context Bots
};

// Build using esbuild
esbuild
  .build(esbuildOptions)
  .then(() => {
    console.log('Bot build completed successfully!');
  })
  .catch((error) => {
    console.error('Bot build failed:', JSON.stringify(error, null, 2));
    process.exit(1);
  });
