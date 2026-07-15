// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Stack } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference, getReferenceString } from '@medplum/core';
import type { ClinicalImpression, Encounter, Practitioner, Provenance, Reference, Task } from '@medplum/fhirtypes';
import { Loading, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { SAVE_TIMEOUT_MS } from '../../config/constants';
import { useDebouncedUpdateResource } from '../../hooks/useDebouncedUpdateResource';
import { useEncounterChart } from '../../hooks/useEncounterChart';
import { ChartNoteStatus } from '../../types/encounter';
import { updateEncounterStatus } from '../../utils/encounter';
import { showErrorNotification } from '../../utils/notifications';
import { TaskPanel } from '../tasks/encounter/TaskPanel';
import { BillingTab } from './BillingTab';
import { EncounterHeader } from './EncounterHeader';
import { ChartNoteReviewCard } from './review/ChartNoteReviewCard';
import { SignAddendum } from './SignAddendum';

const FHIR_ACT_REASON_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActReason';
const FHIR_PROVENANCE_PARTICIPANT_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/provenance-participant-type';
const FHIR_DOCUMENT_COMPLETION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-DocumentCompletion';

const TASK_COMPLETED_STATUSES = new Set<Task['status']>([
  'completed',
  'cancelled',
  'failed',
  'rejected',
  'entered-in-error',
]);

export interface EncounterChartProps {
  encounter: WithId<Encounter> | Reference<Encounter>;
}

export const EncounterChart = (props: EncounterChartProps): JSX.Element => {
  const { encounter: encounterProp } = props;
  const medplum = useMedplum();

  const [activeTab, setActiveTab] = useState('notes');
  const {
    encounter,
    patient: patientResource,
    practitioner,
    tasks,
    clinicalImpression,
    appointment,
    setEncounter,
    setPractitioner,
    setTasks,
    setClinicalImpression,
  } = useEncounterChart(encounterProp);

  const [chartNote, setChartNote] = useState(clinicalImpression?.note?.[0]?.text);
  const debouncedUpdateResource = useDebouncedUpdateResource(medplum, SAVE_TIMEOUT_MS);
  const [provenances, setProvenances] = useState<Provenance[]>([]);
  const [chartNoteStatus, setChartNoteStatus] = useState(ChartNoteStatus.Unsigned);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initialize from the asynchronously loaded resource
    setChartNote(clinicalImpression?.note?.[0]?.text);
  }, [clinicalImpression]);

  useEffect(() => {
    if (!encounter) {
      return;
    }

    const fetchProvenance = async (): Promise<void> => {
      const provenance = await medplum.searchResources('Provenance', `target=${getReferenceString(encounter)}`);
      setProvenances(provenance);
      if (provenance.length > 0 && clinicalImpression?.status === 'completed') {
        setChartNoteStatus(ChartNoteStatus.SignedAndLocked);
      } else if (provenance.length > 0) {
        setChartNoteStatus(ChartNoteStatus.Signed);
      } else {
        setChartNoteStatus(ChartNoteStatus.Unsigned);
      }
    };

    fetchProvenance().catch((err) => showErrorNotification(err));
  }, [clinicalImpression, encounter, medplum]);

  const updateTaskList = useCallback(
    (updatedTask: WithId<Task>): void => {
      setTasks((prevTasks) => prevTasks.map((task) => (task.id === updatedTask.id ? updatedTask : task)));
    },
    [setTasks]
  );

  const handleEncounterStatusChange = useCallback(
    async (newStatus: Encounter['status']): Promise<void> => {
      if (!encounter) {
        return;
      }

      try {
        const updatedEncounter = await updateEncounterStatus(medplum, encounter, appointment, newStatus);
        setEncounter(updatedEncounter);
      } catch (err) {
        showErrorNotification(err);
      }
    },
    [encounter, medplum, setEncounter, appointment]
  );

  const handleTabChange = (tab: string): void => {
    setActiveTab(tab);
  };

  const handleChartNoteChange = async (e: React.ChangeEvent<HTMLTextAreaElement>): Promise<void> => {
    setChartNote(e.target.value);

    if (!clinicalImpression) {
      return;
    }

    try {
      if (!e.target.value || e.target.value === '') {
        const { note: _, ...restOfClinicalImpression } = clinicalImpression;
        const updatedClinicalImpression: ClinicalImpression = restOfClinicalImpression;
        await debouncedUpdateResource(updatedClinicalImpression);
      } else {
        const updatedClinicalImpression: ClinicalImpression = {
          ...clinicalImpression,
          note: [{ text: e.target.value }],
        };
        await debouncedUpdateResource(updatedClinicalImpression);
      }
    } catch (err) {
      showErrorNotification(err);
    }
  };

  const flushChartNote = useCallback(async (): Promise<void> => {
    if (!clinicalImpression) {
      return;
    }
    debouncedUpdateResource.cancel();
    const updatedClinicalImpression: ClinicalImpression = chartNote?.trim()
      ? { ...clinicalImpression, note: [{ text: chartNote }] }
      : (() => {
          const { note: _, ...withoutNote } = clinicalImpression;
          return withoutNote;
        })();
    const saved = await medplum.updateResource(updatedClinicalImpression);
    setClinicalImpression(saved);
  }, [chartNote, clinicalImpression, debouncedUpdateResource, medplum, setClinicalImpression]);

  const handleSign = async (practitioner: Reference<Practitioner>, lock: boolean): Promise<void> => {
    if (!encounter) {
      return;
    }

    if (lock) {
      // Complete all incomplete tasks
      const tasksToUpdate = tasks.filter((task) => !TASK_COMPLETED_STATUSES.has(task.status));
      const updatedTasks = await Promise.all(
        tasksToUpdate.map((task) =>
          medplum.updateResource({
            ...task,
            status: 'completed',
          })
        )
      );

      setTasks(
        tasks.map((task) => {
          const updated = updatedTasks.find((t) => t.id === task.id);
          return updated || task;
        })
      );

      // Mark clinical impression as completed
      if (clinicalImpression) {
        const updatedImpression = await medplum.updateResource({ ...clinicalImpression, status: 'completed' });
        setClinicalImpression(updatedImpression);
      }
    }

    // Create provenance record with signature
    const newProvenance = await medplum.createResource<Provenance>({
      resourceType: 'Provenance',
      target: [createReference(encounter)],
      recorded: new Date().toISOString(),
      reason: [
        {
          coding: [
            {
              system: FHIR_ACT_REASON_SYSTEM,
              code: 'SIGN',
              display: 'Signed',
            },
          ],
        },
      ],
      agent: [
        {
          type: {
            coding: [
              {
                system: FHIR_PROVENANCE_PARTICIPANT_TYPE_SYSTEM,
                code: 'author',
              },
            ],
          },
          who: practitioner,
        },
      ],
      signature: [
        {
          type: [
            {
              system: FHIR_DOCUMENT_COMPLETION_SYSTEM,
              code: 'LA',
              display: 'legally authenticated',
            },
          ],
          when: new Date().toISOString(),
          who: practitioner,
        },
      ],
    });

    setProvenances([...provenances, newProvenance]);

    if (lock) {
      setChartNoteStatus(ChartNoteStatus.SignedAndLocked);
    } else {
      setChartNoteStatus(ChartNoteStatus.Signed);
    }
  };

  if (!patientResource || !encounter) {
    return <Loading />;
  }

  return (
    <>
      <Stack justify="space-between" gap={0}>
        <EncounterHeader
          encounter={encounter}
          chartNoteStatus={chartNoteStatus}
          practitioner={practitioner}
          onStatusChange={handleEncounterStatusChange}
          onTabChange={handleTabChange}
          activeTab={activeTab}
          onSign={handleSign}
        />
        <Box p="md">
          {activeTab === 'notes' && (
            <Stack gap="md">
              <SignAddendum encounter={encounter} provenances={provenances} chartNoteStatus={chartNoteStatus} />

              {clinicalImpression && (
                <ChartNoteReviewCard
                  encounter={encounter}
                  patient={patientResource}
                  clinicalImpression={clinicalImpression}
                  chartNote={chartNote}
                  onChartNoteChange={handleChartNoteChange}
                  flushChartNote={flushChartNote}
                  disabled={chartNoteStatus === ChartNoteStatus.SignedAndLocked}
                  setEncounter={setEncounter}
                  onNavigateToDetails={() => setActiveTab('details')}
                />
              )}
              {tasks.map((task) => (
                <TaskPanel
                  key={task.id}
                  task={task}
                  onUpdateTask={updateTaskList}
                  enabled={chartNoteStatus !== ChartNoteStatus.SignedAndLocked}
                />
              ))}
            </Stack>
          )}
          {activeTab === 'details' && (
            <BillingTab
              encounter={encounter}
              setEncounter={setEncounter}
              patient={patientResource}
              practitioner={practitioner}
              setPractitioner={setPractitioner}
              chartNoteStatus={chartNoteStatus}
            />
          )}
        </Box>
      </Stack>
    </>
  );
};
