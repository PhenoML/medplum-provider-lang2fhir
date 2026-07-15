// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Badge, Card, Group, Menu, Stack, Text } from '@mantine/core';
import { IconDotsVertical, IconEdit, IconTrash } from '@tabler/icons-react';
import type { JSX } from 'react';
import type { ReviewCodeItem } from '../../../utils/citations';

export interface CodeEvidencePanelProps {
  items: ReviewCodeItem[];
  activeKey?: string;
  onActivate?: (key: string) => void;
  onRemove: (item: ReviewCodeItem) => void | Promise<void>;
  onEdit?: (item: ReviewCodeItem) => void;
  showQuotes?: boolean;
}

export function CodeEvidencePanel(props: CodeEvidencePanelProps): JSX.Element {
  const { items, activeKey, onActivate, onRemove, onEdit, showQuotes = false } = props;
  return (
    <Stack gap="xs">
      {items.map((item) => (
        <Card
          key={item.key}
          withBorder
          padding="sm"
          bg={activeKey === item.key ? 'blue.0' : undefined}
          onMouseEnter={() => onActivate?.(item.key)}
          onClick={() => onActivate?.(item.key)}
          style={{ cursor: onActivate ? 'pointer' : undefined }}
        >
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={3} style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Badge size="sm" variant="light">
                  {item.kind === 'diagnosis' ? 'ICD-10-CM' : 'CPT'}
                </Badge>
                <Text fw={700}>{item.code}</Text>
                {item.display && <Text size="sm">{item.display}</Text>}
              </Group>
              {item.rationale && (
                <Text size="xs" c="dimmed">
                  {item.rationale}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {item.citations.length} citation{item.citations.length === 1 ? '' : 's'}
              </Text>
              {showQuotes &&
                item.citations.map((citation, index) => (
                  <Text key={`${citation.beginOffset}-${index}`} size="xs" fs="italic">
                    “{citation.text}”
                  </Text>
                ))}
            </Stack>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" aria-label={`Actions for ${item.code}`} onClick={(event) => event.stopPropagation()}>
                  <IconDotsVertical size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
                {onEdit && (
                  <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => onEdit(item)}>
                    Edit
                  </Menu.Item>
                )}
                <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => onRemove(item)}>
                  Remove
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
