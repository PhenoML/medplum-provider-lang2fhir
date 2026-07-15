// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import type { Condition } from '@medplum/fhirtypes';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { buildReviewItems } from '../../../utils/citations';
import { CodeEvidencePanel } from './CodeEvidencePanel';
import { HighlightedNote } from './HighlightedNote';

const condition: Condition = {
  resourceType: 'Condition',
  id: 'condition-1',
  subject: { reference: 'Patient/patient-1' },
  code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I10', display: 'Hypertension' }] },
  extension: [
    {
      url: 'https://example.org/fhir/StructureDefinition/billing-acuity-source',
      valueString: 'billing-acuity',
    },
    {
      url: 'https://example.org/fhir/StructureDefinition/billing-citation',
      extension: [
        { url: 'text', valueString: 'hypertension' },
        { url: 'beginOffset', valueInteger: 4 },
        { url: 'endOffset', valueInteger: 16 },
      ],
    },
  ],
};

test('highlight click activates its code', async () => {
  const onSpanClick = vi.fn();
  render(
    <MantineProvider>
      <HighlightedNote noteText="has hypertension" items={buildReviewItems([condition], [])} onSpanClick={onSpanClick} />
    </MantineProvider>
  );
  await userEvent.click(screen.getByText('hypertension'));
  expect(onSpanClick).toHaveBeenCalledWith('Condition/condition-1');
});

test('evidence panel shows quotes and invokes remove', async () => {
  const user = userEvent.setup();
  const onRemove = vi.fn();
  render(
    <MantineProvider>
      <CodeEvidencePanel items={buildReviewItems([condition], [])} onRemove={onRemove} showQuotes />
    </MantineProvider>
  );
  expect(screen.getByText('“hypertension”')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Actions for I10' }));
  await user.click(await screen.findByText('Remove'));
  expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ key: 'Condition/condition-1' }));
});
