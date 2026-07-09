// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ContentType } from '@medplum/core';
import type { Bundle, BundleEntry } from '@medplum/fhirtypes';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

interface BotDescription {
  src: string;
  dist: string;
  criteria?: string;
}
const Bots: BotDescription[] = [
  {
    src: 'src/bots/lang2fhir-document.ts',
    dist: 'dist/lang2fhir-document.js',
  },
  {
    src: 'src/bots/lang2fhir-create.ts',
    dist: 'dist/lang2fhir-create.js',
  },
  {
    src: 'src/bots/phenoml-cohort.ts',
    dist: 'dist/phenoml-cohort.js',
  }, 
  {
    src: 'src/bots/clinical-trials-bot.ts',
    dist: 'dist/clinical-trials-bot.js',
  },
  {
    src: 'src/bots/phenoml-workflow.ts',
    dist: 'dist/phenoml-workflow.js',
  },
  {
    src: 'src/bots/phenoml-ips-summary.ts',
    dist: 'dist/phenoml-ips-summary.js',
  },
  {
    src: 'src/bots/referral-intake.ts',
    dist: 'dist/referral-intake.js',
  },
  {
    src: 'src/bots/scribe-soap-note.ts',
    dist: 'dist/scribe-soap-note.js',
  },
  {
    src: 'src/bots/voice-transcribe.ts',
    dist: 'dist/voice-transcribe.js',
  }
];

async function main(): Promise<void> {
  const bundle: Bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: Bots.flatMap((botDescription): BundleEntry[] => {
      const botName = path.parse(botDescription.src).name;
      const botUrlPlaceholder = `$bot-${botName}-reference`;
      const botIdPlaceholder = `$bot-${botName}-id`;
      const results: BundleEntry[] = [];
      const { srcEntry, distEntry } = readBotFiles(botDescription);
      results.push(srcEntry, distEntry);

      results.push({
        request: {
          url: botUrlPlaceholder,
          method: 'PUT',
        },
        resource: {
          resourceType: 'Bot',
          id: botIdPlaceholder,
          name: botName,
          runtimeVersion: 'awslambda',//IMPORTANT: USE awslambda for production as per: https://www.medplum.com/docs/bots/running-bots-locally. Use vmcontext to run locally.
          timeout: 120,
          sourceCode: {
            contentType: ContentType.TYPESCRIPT,
            url: srcEntry.fullUrl,
          },
          executableCode: {
            contentType: ContentType.JAVASCRIPT,
            url: distEntry.fullUrl,
          },
        },
      });

      if (botDescription.criteria) {
        results.push({
          request: {
            url: 'Subscription',
            method: 'POST',
            ifNoneExist: `url=${botUrlPlaceholder}`,
          },
          resource: {
            resourceType: 'Subscription',
            status: 'active',
            reason: botName,
            channel: { endpoint: botUrlPlaceholder, type: 'rest-hook' },
            criteria: botDescription.criteria,
          },
        });
      }

      return results;
    }),
  };

  fs.writeFileSync('data/example/example-bots.json', JSON.stringify(bundle, null, 2));
}

function readBotFiles(description: BotDescription): Record<string, BundleEntry> {
  const sourceFile = fs.readFileSync(description.src);
  const distFile = fs.readFileSync(description.dist);

  const srcEntry: BundleEntry = {
    fullUrl: 'urn:uuid:' + randomUUID(),
    request: {
      method: 'POST',
      url: 'Binary',
    },
    resource: {
      resourceType: 'Binary',
      contentType: ContentType.TYPESCRIPT,
      data: sourceFile.toString('base64'),
    },
  };
  const distEntry: BundleEntry = {
    fullUrl: 'urn:uuid:' + randomUUID(),
    request: {
      method: 'POST',
      url: 'Binary',
    },
    resource: {
      resourceType: 'Binary',
      contentType: ContentType.JAVASCRIPT,
      data: distFile.toString('base64'),
    },
  };
  return { srcEntry, distEntry };
}


main().catch(console.error);
