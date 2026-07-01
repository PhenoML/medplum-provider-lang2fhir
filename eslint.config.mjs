// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// eslint-disable-next-line import/no-unresolved -- Node resolves this ESLint subpath export; eslint-plugin-import does not.
import { defineConfig, globalIgnores } from 'eslint/config';
import { medplumEslintConfig } from '@medplum/eslint-config';

export default defineConfig([globalIgnores(['dist', 'coverage', 'data', 'public']), ...medplumEslintConfig]);
