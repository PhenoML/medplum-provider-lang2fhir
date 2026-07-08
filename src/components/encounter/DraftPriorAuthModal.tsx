// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Center, Checkbox, Group, Loader, Modal, Stack, Text, Textarea } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { Bundle, BundleEntry, Communication, Coverage, DocumentReference, Encounter, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconAlertTriangle, IconRefresh, IconWriting } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { showErrorNotification, showSuccessNotification } from '../../utils/notifications';

/** Shape returned by the `prior-auth-draft` bot (see src/bots/prior-auth-draft.ts). */
interface PriorAuthDraftResult {
  success: boolean;
  message: string;
  narrative?: string;
  warnings?: string[];
  templateId?: string;
}

export interface DraftPriorAuthModalProps {
  opened: boolean;
  onClose: () => void;
  patient: WithId<Patient>;
  encounter: WithId<Encounter>;
  /** The payer coverage to reference; its payor is used as the Communication recipient. */
  coverage?: WithId<Coverage>;
  /** Called after a prior authorization document is successfully saved to the chart. */
  onSaved?: () => void;
}

// UTF-8 safe base64 encode for the inline attachment payload (narratives can contain non-ASCII
// characters such as accented names). Mirrors decodeBase64Utf8 in src/utils/referral.ts. We inline
// the narrative as base64 data rather than uploading a Binary: a separate Binary download fails with
// a cross-origin "Failed to fetch" in the browser (see src/bots/referral-intake.ts), whereas inline
// data is decoded locally with no network call.
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export const DraftPriorAuthModal = (props: DraftPriorAuthModalProps): JSX.Element => {
  const { opened, onClose, patient, encounter, coverage, onSaved } = props;
  const medplum = useMedplum();
  const author = useMedplumProfile();

  const [generating, setGenerating] = useState(false);
  const [generatedOnce, setGeneratedOnce] = useState(false);
  const [narrative, setNarrative] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sendToPayer, setSendToPayer] = useState(false);
  const [saving, setSaving] = useState(false);

  const payerRecipients = (coverage?.payor ?? []).filter((ref) => ref.reference?.startsWith('Organization/'));
  const canSendToPayer = payerRecipients.length > 0;

  const generate = useCallback(async (): Promise<void> => {
    setGenerating(true);
    setWarnings([]);
    try {
      const bot = await medplum.searchOne('Bot', { name: 'prior-auth-draft' });
      if (!bot?.id) {
        throw new Error('Bot "prior-auth-draft" not found. Deploy bots first.');
      }
      const result = (await medplum.executeBot(bot.id, {
        patientId: patient.id,
        encounterId: encounter.id,
      })) as PriorAuthDraftResult;

      if (!result.success && !result.narrative) {
        throw new Error(result.message || 'Prior authorization draft generation failed');
      }
      setNarrative(result.narrative ?? '');
      setWarnings(result.warnings ?? []);
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setGenerating(false);
      setGeneratedOnce(true);
    }
  }, [medplum, patient.id, encounter.id]);

  // Auto-generate the first time the modal opens. Kicking off the async bot call (which flips the
  // loading state) is the intended side effect here.
  useEffect(() => {
    if (opened && !generatedOnce && !generating) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      generate().catch(showErrorNotification);
    }
  }, [opened, generatedOnce, generating, generate]);

  const handleClose = useCallback((): void => {
    // Reset so the next open produces a fresh draft rather than showing stale edits.
    setNarrative('');
    setWarnings([]);
    setGeneratedOnce(false);
    setSendToPayer(false);
    onClose();
  }, [onClose]);

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      const authorReference = author ? createReference(author) : undefined;
      const docrefFullUrl = `urn:uuid:${crypto.randomUUID()}`;

      const docref: DocumentReference = {
        resourceType: 'DocumentReference',
        status: 'current',
        type: {
          coding: [{ system: 'http://loinc.org', code: '68609-7', display: 'Prior authorization' }],
          text: 'Prior authorization request',
        },
        category: [{ text: 'Prior Authorization' }],
        subject: createReference(patient),
        author: authorReference ? [authorReference] : undefined,
        context: { encounter: [{ reference: `Encounter/${encounter.id}` }] },
        date: new Date().toISOString(),
        content: [
          {
            attachment: {
              contentType: 'text/plain',
              data: toBase64Utf8(narrative),
              title: 'Prior Authorization Request',
            },
          },
        ],
      };

      const entries: BundleEntry[] = [
        { fullUrl: docrefFullUrl, request: { method: 'POST', url: 'DocumentReference' }, resource: docref },
      ];

      if (sendToPayer && canSendToPayer) {
        const communication: Communication = {
          resourceType: 'Communication',
          status: 'preparation',
          category: [{ text: 'prior-authorization' }],
          subject: createReference(patient),
          recipient: payerRecipients,
          sender: authorReference,
          encounter: { reference: `Encounter/${encounter.id}` },
          sent: new Date().toISOString(),
          payload: [{ contentReference: { reference: docrefFullUrl } }, { contentString: narrative }],
        };
        entries.push({ request: { method: 'POST', url: 'Communication' }, resource: communication });
      }

      const txBundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: entries };
      await medplum.executeBatch(txBundle);

      showSuccessNotification({
        title: 'Prior authorization saved',
        message:
          sendToPayer && canSendToPayer
            ? 'Saved to the chart and queued to the payer.'
            : 'Saved to the patient chart.',
      });
      onSaved?.();
      handleClose();
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setSaving(false);
    }
  }, [author, patient, encounter.id, narrative, sendToPayer, canSendToPayer, payerRecipients, medplum, onSaved, handleClose]);

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      centered
      size="xl"
      padding="xl"
      title="Draft prior authorization"
    >
      {generating ? (
        <Center py="xl">
          <Stack align="center" gap="sm">
            <Loader />
            <Text size="sm" c="dimmed">
              Generating prior authorization from payer rules…
            </Text>
          </Stack>
        </Center>
      ) : (
        <Stack gap="md">
          {warnings.length > 0 && (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Unresolved details">
              <Stack gap={2}>
                {warnings.map((warning, index) => (
                  <Text key={index} size="sm">
                    {warning}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}

          <Text size="sm" c="dimmed">
            Review and edit the generated narrative before saving. It is drafted from the payer's prior-auth
            policy and the patient's chart data.
          </Text>

          <Textarea
            value={narrative}
            onChange={(e) => setNarrative(e.currentTarget.value)}
            autosize
            minRows={15}
            maxRows={28}
            placeholder={generatedOnce ? 'No narrative was generated.' : 'Generating…'}
          />

          <Checkbox
            label="Also send to payer"
            checked={sendToPayer}
            disabled={!canSendToPayer}
            description={canSendToPayer ? undefined : 'No payer organization on the selected coverage.'}
            onChange={(e) => setSendToPayer(e.currentTarget.checked)}
          />

          <Group justify="space-between">
            <Button
              variant="subtle"
              leftSection={<IconRefresh size={16} />}
              onClick={() => generate().catch(showErrorNotification)}
              disabled={saving}
            >
              Regenerate
            </Button>
            <Group>
              <Button variant="default" onClick={handleClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                leftSection={<IconWriting size={16} />}
                onClick={handleSave}
                loading={saving}
                disabled={!narrative.trim()}
              >
                Save to chart
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};
