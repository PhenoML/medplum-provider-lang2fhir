// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Stack, Text } from '@mantine/core';
import { addProfileToResource, ContentType, createReference, HTTP_HL7_ORG, HTTP_TERMINOLOGY_HL7_ORG } from '@medplum/core';
import type { CodeableConcept, Coding, Condition, Encounter, Patient } from '@medplum/fhirtypes';
import { AsyncAutocomplete, CodeableConceptInput, Form, SubmitButton, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { showErrorNotification } from '../../utils/notifications';

export interface ConditionDialogProps {
  readonly patient: Patient;
  readonly encounter: Encounter;
  readonly onSubmit: (condition: Condition) => void;
}

/** Shape returned by the `phenoml-code-search` bot (see src/bots/phenoml-code-search.ts). */
interface CodeSearchBotOutput {
  success: boolean;
  message: string;
  results?: { code: string; description: string }[];
}

// ICD-10-CM coding system. There is no @medplum/core constant for the CM variant; the claims
// transform (utils/claims.ts) keys off this exact system, so keep them in sync.
const ICD10CM = HTTP_HL7_ORG + '/fhir/sid/icd-10-cm';

// Minimum characters before hitting the code-search bot, to avoid a round-trip per keystroke.
const MIN_CODE_QUERY_LENGTH = 2;

export default function ConditionModal(props: ConditionDialogProps): JSX.Element {
  const { patient, encounter, onSubmit } = props;
  const medplum = useMedplum();
  const [diagnosis, setDiagnosis] = useState<CodeableConcept | undefined>();
  const [clinicalStatus, setClinicalStatus] = useState<CodeableConcept | undefined>();

  // Search ICD-10 codes through PhenoML's Construe full-text search (via the phenoml-code-search bot).
  const loadDiagnosisCodes = useCallback(
    async (input: string, signal: AbortSignal): Promise<Coding[]> => {
      if (input.trim().length < MIN_CODE_QUERY_LENGTH) {
        return [];
      }
      try {
        const bot = await medplum.searchOne('Bot', { name: 'phenoml-code-search' }, { signal });
        if (!bot?.id) {
          throw new Error('Bot "phenoml-code-search" not found. Deploy bots first.');
        }
        const output = (await medplum.executeBot(
          bot.id,
          { query: input, system: 'ICD-10-CM', limit: 20 },
          ContentType.JSON,
          { signal }
        )) as CodeSearchBotOutput;

        if (signal.aborted) {
          return [];
        }
        return (output.results ?? []).map((result) => ({
          system: ICD10CM,
          code: result.code,
          display: result.description,
        }));
      } catch (error) {
        if (!signal.aborted) {
          console.error('Error searching ICD-10 codes:', error);
        }
        return [];
      }
    },
    [medplum]
  );

  const handleSelectDiagnosis = useCallback((items: Coding[]) => {
    const coding = items[0];
    setDiagnosis(coding ? { coding: [coding], text: coding.display } : undefined);
  }, []);

  const handleSubmit = useCallback(() => {
    if (!diagnosis) {
      showErrorNotification('Please select a diagnosis');
      return;
    }

    const updatedCondition: Condition = addProfileToResource(
      {
        resourceType: 'Condition',
        category: [
          {
            coding: [
              {
                system: HTTP_TERMINOLOGY_HL7_ORG + '/CodeSystem/condition-category',
                code: 'problem-list-item',
                display: 'Problem List Item',
              },
            ],
            text: 'Problem List Item',
          },
        ],
        subject: createReference(patient),
        encounter: encounter && createReference(encounter),
        code: {
          coding: diagnosis.coding ? [...diagnosis.coding] : [],
        },
        clinicalStatus,
      },
      HTTP_HL7_ORG + '/fhir/us/core/StructureDefinition/us-core-condition-problems-health-concerns'
    );

    onSubmit(updatedCondition);
  }, [patient, encounter, diagnosis, clinicalStatus, onSubmit]);

  return (
    <Form onSubmit={handleSubmit}>
      <Stack>
        <Box>
          <Text size="sm" fw={500} mb={5}>
            ICD-10 Code{' '}
            <Text span c="red">
              *
            </Text>
          </Text>
          <AsyncAutocomplete<Coding>
            placeholder="Search ICD-10 codes (powered by PhenoML)..."
            onChange={handleSelectDiagnosis}
            toOption={(coding: Coding) => ({
              value: coding.code ?? '',
              label: coding.display ? `${coding.code} – ${coding.display}` : (coding.code ?? ''),
              resource: coding,
            })}
            maxValues={1}
            loadOptions={loadDiagnosisCodes}
          />
        </Box>

        <CodeableConceptInput
          name="clinicalStatus"
          label="Status"
          path="Condition.clinicalStatus"
          maxValues={1}
          binding={HTTP_HL7_ORG + '/fhir/ValueSet/condition-clinical'}
          onChange={(clinicalStatus) => setClinicalStatus(clinicalStatus)}
          required
        />
        <Group justify="flex-end" gap={4} mt="md">
          <SubmitButton>Save</SubmitButton>
        </Group>
      </Stack>
    </Form>
  );
}
