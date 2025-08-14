// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Card, Grid, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, formatHumanName, getReferenceString, normalizeErrorString } from '@medplum/core';
import { HumanName, Practitioner, Reference, Task } from '@medplum/fhirtypes';
import { CodeInput, DateTimeInput, Loading, ResourceInput, useMedplum, useMedplumProfile } from '@medplum/react';
import { IconCircleCheck, IconCircleOff } from '@tabler/icons-react';
import { JSX, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { usePatient } from '../../hooks/usePatient';
import classes from './TaskDetails.module.css';

export const TaskDetails = (): JSX.Element => {
  const { patientId, encounterId, taskId } = useParams();
  const patient = usePatient();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const author = useMedplumProfile();
  const [task, setTask] = useState<Task | undefined>(undefined);
  const [isOpened, setIsOpened] = useState(true);
  const [practitioner, setPractitioner] = useState<Practitioner | undefined>();
  const [dueDate, setDueDate] = useState<string | undefined>();
  const [status, setStatus] = useState<Task['status'] | undefined>();
  const [note, setNote] = useState<string>('');

  useEffect(() => {
    setTask(contextTask);
  }, [contextTask]);

  const handleTabChange = (value: string): void => {
    setActiveTab(value);
  };

  if (!task) {
    return <TaskSelectEmpty notFound />;
  }

  return (
    <Flex direction="row" w="100%" h="100%">
      <Flex
        direction="column"
        w={showRight ? '60%' : '100%'}
        h="100%"
        className={showRight ? classes.borderRight : undefined}
      >
        <TasksInputNote task={task} onTaskChange={onTaskChange} onDeleteTask={onDeleteTask} />
      </Flex>

      {showRight && (
        <Flex direction="column" w="40%" h="100%">
          <Paper h="100%">
            <Box px="md" pb="md" pt="md">
              <SegmentedControl
                value={activeTab}
                onChange={(value: string) => handleTabChange(value)}
                data={[
                  { label: 'Properties', value: 'properties' },
                  { label: 'Activity Log', value: 'activity-log' },
                  { label: 'Patient Summary', value: 'patient-summary' },
                ]}
                fullWidth
                radius="md"
                color="gray"
                size="md"
                className={classes.segmentedControl}
              />
            </Box>

            {task && selectedPatient?.resourceType === 'Patient' && (
              <>
                {activeTab === 'properties' && (
                  <TaskProperties key={task.id} p="md" task={task} onTaskChange={onTaskChange} />
                )}
                {activeTab === 'activity-log' && (
                  <ScrollArea h="calc(100% - 50px)">
                    <ResourceTimeline
                      value={task}
                      loadTimelineResources={async (
                        medplum: MedplumClient,
                        _resourceType: ResourceType,
                        id: string
                      ) => {
                        return Promise.allSettled([medplum.readHistory('Task', id)]);
                      }}
                    />
                  </ScrollArea>
                )}
                {activeTab === 'patient-summary' && selectedPatient && <PatientSummary patient={selectedPatient} />}
              </>
            )}
          </Paper>
        </Flex>
      )}
    </Flex>
  );
}
