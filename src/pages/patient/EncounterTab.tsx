// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group } from '@mantine/core';
import { JSX } from 'react';
import { SoapNote } from '../../components/soapnote/SoapNote';
import { TaskList } from '../../components/tasks/TaskList';

export function EncounterTab(): JSX.Element {
  return (
    <Group gap="xs" justify="center" align="flex-start" w="100%" grow>
      <TaskList />
      <SoapNote />
    </Group>
  );
}
