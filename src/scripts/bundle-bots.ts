// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';

const botFiles = [
  'src/bots/lang2fhir-document.ts',
  'src/bots/lang2fhir-create.ts',
  'src/bots/phenoml-cohort.ts',
  'src/bots/clinical-trials-bot.ts',
  'src/bots/phenoml-workflow.ts',
];

async function bundleBots(): Promise<void> {
  // Ensure dist directory exists
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
  }

  for (const botFile of botFiles) {
    const botName = path.parse(botFile).name;
    const outfile = `dist/${botName}.js`;

    console.log(`Bundling ${botName}...`);

    await esbuild.build({
      entryPoints: [botFile],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile,
      // Don't bundle Medplum packages - they're provided by the runtime
      external: ['@medplum/core', '@medplum/fhirtypes'],
      // Minify for smaller bundle size
      minify: true,
      // Keep names for debugging
      keepNames: true,
    });

    console.log(`  → ${outfile}`);
  }

  console.log('\nAll bots bundled successfully!');
}

bundleBots().catch((err) => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
