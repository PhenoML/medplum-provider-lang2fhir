// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Card, Group, Modal, SegmentedControl, Stack, Textarea, Title } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import type { ChargeItem, ClinicalImpression, Condition, Encounter, Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconSparkles } from '@tabler/icons-react';
import type { ChangeEvent, JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getChargeItemsForEncounter } from '../../../utils/chargeitems';
import { buildReviewItems } from '../../../utils/citations';
import type { ReviewCodeItem } from '../../../utils/citations';
import { fetchEncounterConditions, removeEncounterDiagnosis } from '../../../utils/conditions';
import { showErrorNotification } from '../../../utils/notifications';
import ConditionModal from '../../Conditions/ConditionModal';
import { CodeEvidencePanel } from './CodeEvidencePanel';
import { HighlightedNote } from './HighlightedNote';

interface BillingAcuityResult {
  createdConditions?: unknown[];
  createdChargeItems?: unknown[];
  skippedDuplicateDiagnoses?: string[];
  skippedDuplicateCharges?: string[];
}

export interface ChartNoteReviewCardProps {
  encounter: WithId<Encounter>;
  patient: WithId<Patient>;
  clinicalImpression: ClinicalImpression;
  chartNote?: string;
  onChartNoteChange: (event: ChangeEvent<HTMLTextAreaElement>) => void | Promise<void>;
  flushChartNote: () => Promise<void>;
  disabled: boolean;
  setEncounter: (encounter: WithId<Encounter>) => void;
  onNavigateToDetails: () => void;
}

export function ChartNoteReviewCard(props: ChartNoteReviewCardProps): JSX.Element {
  const {
    encounter,
    patient,
    clinicalImpression,
    chartNote,
    onChartNoteChange,
    flushChartNote,
    disabled,
    setEncounter,
    onNavigateToDetails,
  } = props;
  const medplum = useMedplum();
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [chargeItems, setChargeItems] = useState<WithId<ChargeItem>[]>([]);
  const [mode, setMode] = useState<'edit' | 'review'>('edit');
  const [activeKey, setActiveKey] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const [editingCondition, setEditingCondition] = useState<Condition>();
  const items = useMemo(() => buildReviewItems(conditions, chargeItems), [conditions, chargeItems]);

  const loadReviewItems = useCallback(
    async (currentEncounter: WithId<Encounter>): Promise<void> => {
      const [nextConditions, nextChargeItems] = await Promise.all([
        fetchEncounterConditions(medplum, currentEncounter),
        getChargeItemsForEncounter(medplum, currentEncounter),
      ]);
      setConditions(nextConditions);
      setChargeItems(nextChargeItems);
    },
    [medplum]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load persisted review resources after encounter changes
    loadReviewItems(encounter).catch((err) => showErrorNotification(err));
  }, [encounter, loadReviewItems]);

  const handleReviewChart = async (): Promise<void> => {
    setReviewing(true);
    try {
      await flushChartNote();
      const bot = await medplum.searchOne('Bot', { name: 'billing-acuity' });
      if (!bot?.id) {
        showNotification({
          title: 'Deploy bots first',
          message: 'Bot "billing-acuity" was not found',
          color: 'red',
        });
        return;
      }
      const result = (await medplum.executeBot(
        bot.id,
        { encounterId: encounter.id },
        'application/json'
      )) as BillingAcuityResult;
      const refreshedEncounter = await medplum.readResource('Encounter', encounter.id, { cache: 'no-cache' });
      setEncounter(refreshedEncounter);
      await loadReviewItems(refreshedEncounter);
      setMode('review');
      const created = (result.createdConditions?.length ?? 0) + (result.createdChargeItems?.length ?? 0);
      const skipped =
        (result.skippedDuplicateDiagnoses?.length ?? 0) + (result.skippedDuplicateCharges?.length ?? 0);
      showNotification({
        title: 'Chart reviewed',
        message: `${created} code${created === 1 ? '' : 's'} created, ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped`,
        color: 'green',
      });
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setReviewing(false);
    }
  };

  const handleRemove = async (item: ReviewCodeItem): Promise<void> => {
    try {
      if (item.kind === 'diagnosis') {
        const condition = item.resource as Condition;
        const diagnosis = await removeEncounterDiagnosis(medplum, encounter, condition);
        const updatedEncounter = await medplum.updateResource({ ...encounter, diagnosis });
        setEncounter(updatedEncounter);
        setConditions((current) => current.filter((candidate) => candidate.id !== condition.id));
      } else if (item.resource.id) {
        await medplum.deleteResource('ChargeItem', item.resource.id);
        setChargeItems((current) => current.filter((candidate) => candidate.id !== item.resource.id));
      }
      setActiveKey(undefined);
    } catch (err) {
      showErrorNotification(err);
    }
  };

  const handleEdit = (item: ReviewCodeItem): void => {
    if (item.kind === 'diagnosis') {
      setEditingCondition(item.resource as Condition);
    } else {
      onNavigateToDetails();
    }
  };

  const handleConditionEdit = async (condition: Condition): Promise<void> => {
    try {
      const saved = await medplum.updateResource(condition as WithId<Condition>);
      setConditions((current) => current.map((candidate) => (candidate.id === saved.id ? saved : candidate)));
      setEditingCondition(undefined);
    } catch (err) {
      showErrorNotification(err);
    }
  };

  return (
    <Card withBorder shadow="sm" mt="md">
      <Group justify="space-between" align="center" mb="md">
        <Title>Fill chart note</Title>
        <Group>
          {items.length > 0 && (
            <SegmentedControl
              value={mode}
              onChange={(value) => setMode(value as 'edit' | 'review')}
              data={[
                { label: 'Edit', value: 'edit' },
                { label: 'Review', value: 'review' },
              ]}
            />
          )}
          <Button
            leftSection={<IconSparkles size={16} />}
            loading={reviewing}
            disabled={disabled || !chartNote?.trim()}
            onClick={handleReviewChart}
          >
            Review Chart
          </Button>
        </Group>
      </Group>

      {mode === 'edit' || items.length === 0 ? (
        <Textarea
          defaultValue={clinicalImpression.note?.[0]?.text}
          value={chartNote}
          onChange={onChartNoteChange}
          autosize
          minRows={4}
          maxRows={8}
          disabled={disabled}
        />
      ) : (
        <Stack gap="md">
          <HighlightedNote noteText={chartNote ?? ''} items={items} activeKey={activeKey} onSpanClick={setActiveKey} />
          <CodeEvidencePanel
            items={items}
            activeKey={activeKey}
            onActivate={setActiveKey}
            onRemove={handleRemove}
            onEdit={handleEdit}
          />
        </Stack>
      )}

      <Modal opened={Boolean(editingCondition)} onClose={() => setEditingCondition(undefined)} title="Edit Diagnosis">
        {editingCondition && (
          <ConditionModal
            patient={patient}
            encounter={encounter}
            condition={editingCondition}
            onSubmit={handleConditionEdit}
          />
        )}
      </Modal>
    </Card>
  );
}
