// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group, Stack } from '@mantine/core';
import { addProfileToResource, createReference, HTTP_HL7_ORG, HTTP_TERMINOLOGY_HL7_ORG } from '@medplum/core';
import type { CodeableConcept, Condition, Encounter, Patient } from '@medplum/fhirtypes';
import { CodeableConceptInput, Form, SubmitButton } from '@medplum/react';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { showErrorNotification } from '../../utils/notifications';

export interface ConditionDialogProps {
  readonly patient: Patient;
  readonly encounter: Encounter;
  readonly condition?: Condition;
  readonly onSubmit: (condition: Condition) => void;
}

export default function ConditionModal(props: ConditionDialogProps): JSX.Element {
  const { patient, encounter, condition, onSubmit } = props;
  const [diagnosis, setDiagnosis] = useState<CodeableConcept | undefined>(condition?.code);
  const [clinicalStatus, setClinicalStatus] = useState<CodeableConcept | undefined>(condition?.clinicalStatus);

  const handleSubmit = useCallback(() => {
    if (!diagnosis) {
      showErrorNotification('Please select a diagnosis');
      return;
    }

    const updatedCondition: Condition = addProfileToResource(
      {
        ...condition,
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
  }, [patient, encounter, condition, diagnosis, clinicalStatus, onSubmit]);

  return (
    <Form onSubmit={handleSubmit}>
      <Stack>
        <CodeableConceptInput
          binding="http://hl7.org/fhir/sid/icd-10-cm/vs/billable"
          label="ICD-10 Code"
          name="diagnosis"
          path="Condition.code"
          required
          maxValues={1}
          defaultValue={condition?.code}
          onChange={(diagnosis) => setDiagnosis(diagnosis)}
        />

        <CodeableConceptInput
          name="clinicalStatus"
          label="Status"
          path="Condition.clinicalStatus"
          maxValues={1}
          binding={HTTP_HL7_ORG + '/fhir/ValueSet/condition-clinical'}
          defaultValue={condition?.clinicalStatus}
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
