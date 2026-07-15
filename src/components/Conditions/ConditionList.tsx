// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Card, Flex, Modal, Stack, Text } from '@mantine/core';
import { getReferenceString } from '@medplum/core';
import type { Condition, Encounter, EncounterDiagnosis, Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { fetchEncounterConditions, removeEncounterDiagnosis } from '../../utils/conditions';
import { showErrorNotification } from '../../utils/notifications';
import ConditionItem from './ConditionItem';
import ConditionModal from './ConditionModal';

interface ConditionListProps {
  patient: Patient;
  encounter: Encounter;
  conditions: Condition[] | undefined;
  setConditions: (conditions: Condition[]) => void;
  onDiagnosisChange: (diagnosis: EncounterDiagnosis[]) => void;
}

export const ConditionList = (props: ConditionListProps): JSX.Element => {
  const { patient, encounter, conditions, setConditions, onDiagnosisChange } = props;
  const medplum = useMedplum();
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const fetchConditions = async (): Promise<void> => {
      if (!encounter) {
        return;
      }

      setConditions(await fetchEncounterConditions(medplum, encounter));
    };

    fetchConditions().catch((err) => showErrorNotification(err));
  }, [encounter, medplum, setConditions]);

  /*
   * Re-orders the conditions in the conditions array and updates the encounter diagnosis.
   */
  const handleUpdateDiagnosis = async (condition: Condition, value: string): Promise<void> => {
    if (!conditions || conditions.length === 0 || !encounter) {
      return;
    }

    const newRank = Number(value);
    const maxAllowedRank = conditions.length;
    const validRank = Math.max(1, Math.min(newRank, maxAllowedRank));

    const updatedConditions = [...conditions];
    const conditionIndex = updatedConditions.findIndex((c) => getReferenceString(c) === getReferenceString(condition));

    if (conditionIndex === -1) {
      return;
    }

    const conditionToMove = updatedConditions.splice(conditionIndex, 1)[0];
    updatedConditions.splice(validRank - 1, 0, conditionToMove);
    setConditions(updatedConditions);
    onDiagnosisChange(
      updatedConditions.map((c, index) => ({
        condition: { reference: `Condition/${c.id}` },
        rank: index + 1,
      }))
    );
  };

  const handleRemoveDiagnosis = async (condition: Condition): Promise<void> => {
    if (!conditions) {
      return;
    }

    try {
      const diagnosis = await removeEncounterDiagnosis(medplum, encounter, condition);
      setConditions(conditions.filter((c) => c.id !== condition.id));
      onDiagnosisChange(diagnosis);
    } catch (err) {
      showErrorNotification(err);
    }
  };

  const handleConditionSubmit = async (condition: Condition): Promise<void> => {
    try {
      const newCondition = await medplum.createResource(condition);
      if (encounter) {
        const updatedDiagnosis = [
          ...(encounter.diagnosis || []),
          {
            condition: { reference: `Condition/${newCondition.id}` },
            rank: encounter.diagnosis?.length ? encounter.diagnosis.length + 1 : 1,
          },
        ];
        setConditions([...(conditions || []), newCondition]);
        onDiagnosisChange(updatedDiagnosis);
      }
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setOpened(false);
    }
  };

  return (
    <>
      <Stack gap={0}>
        <Text fw={600} size="lg" mb="md">
          Diagnosis
        </Text>

        <Card withBorder shadow="sm">
          <Stack gap="md">
            {conditions &&
              conditions.length > 0 &&
              conditions.map((condition, idx) => (
                <ConditionItem
                  key={condition.id ?? idx}
                  condition={condition}
                  rank={idx + 1}
                  total={conditions.length}
                  onChange={handleUpdateDiagnosis}
                  onRemove={handleRemoveDiagnosis}
                />
              ))}

            <Flex>
              <Button onClick={() => setOpened(true)}>Add Diagnosis</Button>
            </Flex>
          </Stack>
        </Card>
      </Stack>
      <Modal opened={opened} onClose={() => setOpened(false)} title={'Add Diagnosis'}>
        <ConditionModal patient={patient} encounter={encounter} onSubmit={handleConditionSubmit} />
      </Modal>
    </>
  );
};
