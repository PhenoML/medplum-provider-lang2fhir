// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Badge, Box, Button, Divider, Flex, Group, Loader, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { formatDateTime, getDisplayString, normalizeErrorString } from '@medplum/core';
import type { Communication, Organization, Patient, Reference } from '@medplum/fhirtypes';
import { MedplumLink, useMedplum, useResource } from '@medplum/react';
import { useCachedBinaryUrl } from '@medplum/react-hooks';
import { IconCircleOff, IconClipboardCheck, IconDownload, IconRobot, IconSend, IconUserPlus } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { getReferralStatus, isInboundFax, withReferralStatus } from '../../utils/referral';
import { AssignPatientModal } from './AssignPatientModal';
import { formatFaxNumber } from './fax.utils';
import classes from './FaxBoard.module.css';
import { FaxDocumentPreview } from './FaxDocumentPreview';
import { SendFaxModal } from './SendFaxModal';

interface FaxDetailPanelProps {
  fax: Communication;
  onFaxChange: () => void;
}

export function FaxDetailPanel({ fax, onFaxChange }: FaxDetailPanelProps): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const patient = useResource(fax.subject);
  const [assignModalOpened, setAssignModalOpened] = useState(false);
  const [forwardModalOpened, setForwardModalOpened] = useState(false);
  const [isStartingProcess, setIsStartingProcess] = useState(false);

  // The document preview should show the original PDF, not the stashed extracted-Bundle JSON.
  const attachment = fax.payload?.find(
    (p) => p.contentAttachment && p.contentAttachment.contentType !== 'application/fhir+json'
  )?.contentAttachment;
  const rawAttachmentUrl = useCachedBinaryUrl(attachment?.url);
  const attachmentUrl = isValidUrl(rawAttachmentUrl) ? rawAttachmentUrl : undefined;
  const isInbound = isInboundFax(fax);
  const referralStatus = getReferralStatus(fax);
  const originatingFaxNumber = fax.extension?.find(
    (ext) => ext.url === 'https://efax.com/originating-fax-number'
  )?.valueString;

  const faxName = isInbound
    ? formatFaxNumber(fax.sender?.display || originatingFaxNumber || 'Unknown Sender')
    : formatFaxNumber(fax.recipient?.[0]?.display || 'Unknown recipient');

  // While the (slow) bot is running server-side, poll the Communication until its durable status
  // changes, then refresh the panel. Self-cleaning on unmount or when no longer processing.
  useEffect(() => {
    if (referralStatus !== 'processing' || !fax.id) {
      return undefined;
    }
    const interval = setInterval(() => {
      medplum
        .readResource('Communication', fax.id as string)
        .then((latest) => {
          if (getReferralStatus(latest) !== 'processing') {
            onFaxChange();
          }
          return undefined;
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(interval);
  }, [referralStatus, fax.id, medplum, onFaxChange]);

  const handleDownload = (): void => {
    if (!attachmentUrl) {
      return;
    }
    window.open(attachmentUrl, '_blank', 'noopener,noreferrer');
  };

  const openReview = (): void => {
    navigate(`/Fax/Communication/${fax.id}/review`)?.catch(console.error);
  };

  const handleProcess = async (): Promise<void> => {
    if (!fax.id) {
      return;
    }
    setIsStartingProcess(true);
    try {
      const bot = await medplum.searchOne('Bot', { name: 'referral-intake' });
      if (!bot?.id) {
        throw new Error('Bot "referral-intake" not found. Deploy bots first.');
      }
      // Durably mark processing so the state survives navigation immediately.
      await medplum.updateResource(withReferralStatus(fax, 'processing'));
      // Fire-and-forget: the bot is slow and writes its result back onto the Communication.
      medplum
        .executeBot(bot.id, { communicationId: fax.id })
        .catch((err) => console.error('referral-intake bot error', err));
      notifications.show({
        color: 'blue',
        icon: <IconRobot />,
        title: 'Processing referral…',
        message: 'This runs in the background — you can navigate away and come back.',
      });
      onFaxChange();
    } catch (error) {
      notifications.show({
        color: 'red',
        icon: <IconCircleOff />,
        title: 'Error',
        message: normalizeErrorString(error),
      });
    } finally {
      setIsStartingProcess(false);
    }
  };

  return (
    <>
      <Box h="100%" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} className={classes.borderRight}>
        <Paper h="100%">
          <Flex direction="column" h="100%">
            <Box p="md">
              <Group justify="space-between" align="center">
                <Text fw={700} size="lg">
                  {faxName}
                </Text>

                <Group gap="xs">
                  {isInbound && referralStatus === 'processing' && (
                    <Badge color="blue" variant="light" size="lg" leftSection={<Loader size={10} color="blue" />}>
                      Processing…
                    </Badge>
                  )}
                  {isInbound && referralStatus === 'ready-for-review' && (
                    <Button
                      size="xs"
                      radius="xl"
                      variant="filled"
                      leftSection={<IconClipboardCheck size={14} />}
                      onClick={openReview}
                    >
                      Ready to review
                    </Button>
                  )}
                  {isInbound && referralStatus === 'signed' && (
                    <Badge color="green" variant="light" size="lg">
                      Signed
                    </Badge>
                  )}
                  {isInbound && (referralStatus === undefined || referralStatus === 'error') && (
                    <Tooltip
                      label={referralStatus === 'error' ? 'Retry processing' : 'Process referral'}
                      position="bottom"
                      openDelay={500}
                    >
                      <ActionIcon
                        variant="transparent"
                        radius="xl"
                        size={32}
                        className="outline-icon-button"
                        loading={isStartingProcess}
                        onClick={handleProcess}
                      >
                        <IconRobot size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  {attachment?.url && (
                    <Tooltip label="Download" position="bottom" openDelay={500}>
                      <ActionIcon
                        variant="transparent"
                        radius="xl"
                        size={32}
                        className="outline-icon-button"
                        onClick={handleDownload}
                      >
                        <IconDownload size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <Tooltip label="Assign Patient" position="bottom" openDelay={500}>
                    <ActionIcon
                      variant="transparent"
                      radius="xl"
                      size={32}
                      className="outline-icon-button"
                      onClick={() => setAssignModalOpened(true)}
                    >
                      <IconUserPlus size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Forward / Re-Fax" position="bottom" openDelay={500}>
                    <ActionIcon
                      variant="transparent"
                      radius="xl"
                      size={32}
                      className="outline-icon-button"
                      onClick={() => setForwardModalOpened(true)}
                    >
                      <IconSend size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            </Box>

            <Divider />

            <FaxDocumentPreview attachment={attachment} />

            <Box px="md">
              <Divider color="gray.1" />
            </Box>

            <Box p="md">
              <FaxMetadata
                fax={fax}
                isInbound={isInbound}
                originatingFaxNumber={originatingFaxNumber}
                patient={patient as Patient | undefined}
              />
            </Box>
          </Flex>
        </Paper>
      </Box>

      <AssignPatientModal
        opened={assignModalOpened}
        onClose={() => setAssignModalOpened(false)}
        resourceType="Communication"
        resourceId={fax.id ?? ''}
        onAssigned={onFaxChange}
        defaultPatient={patient ? { reference: `Patient/${patient.id}` } : undefined}
      />

      <SendFaxModal
        opened={forwardModalOpened}
        onClose={() => setForwardModalOpened(false)}
        onFaxSent={onFaxChange}
        defaultAttachment={attachment}
        defaultPatient={fax.subject as Reference<Patient> | undefined}
      />
    </>
  );
}

interface FaxMetadataProps {
  fax: Communication;
  isInbound: boolean;
  originatingFaxNumber: string | undefined;
  patient: Patient | undefined;
}

const METADATA_LABEL_WIDTH = 150;

function FaxMetadata({ fax, isInbound, originatingFaxNumber, patient }: FaxMetadataProps): JSX.Element {
  const recipient = useResource(fax.recipient?.[0]) as Organization | undefined;

  const recipientName = recipient?.name !== 'Fax Recipient' ? recipient?.name : undefined;
  const recipientFaxNumber =
    recipient?.telecom?.find((t) => t.system === 'fax')?.value ??
    recipient?.contact?.flatMap((c) => c.telecom ?? []).find((t) => t.system === 'fax')?.value;

  const attnNote = fax.note?.find((n) => n.text?.startsWith('Attn:'))?.text;
  const coverNote = fax.note?.find((n) => !n.text?.startsWith('Attn:'))?.text;

  return (
    <Stack
      gap="sm"
      style={{
        display: 'grid',
        gridTemplateColumns: `${METADATA_LABEL_WIDTH}px 1fr`,
        alignItems: 'start',
        columnGap: 'var(--mantine-spacing-lg)',
        rowGap: 'var(--mantine-spacing-sm)',
      }}
    >
      <Text fw={500} size="sm" c="dimmed">
        Direction
      </Text>
      <Text size="sm">{isInbound ? 'Inbound' : 'Outbound'}</Text>

      {(recipientFaxNumber || recipientName || attnNote) && (
        <>
          <Text fw={500} size="sm" c="dimmed">
            Recipient
          </Text>
          <Stack gap={0}>
            {recipientFaxNumber && <Text size="sm">{formatFaxNumber(recipientFaxNumber)}</Text>}
            {recipientName && <Text size="sm">{recipientName}</Text>}
            {attnNote && <Text size="sm">Attn: {attnNote.replace(/^Attn:\s*/, '')}</Text>}
          </Stack>
        </>
      )}
      {fax.sent && (
        <>
          <Text fw={500} size="sm" c="dimmed">
            {isInbound ? 'Received' : 'Sent'}
          </Text>
          <Text size="sm">{formatDateTime(fax.sent).replace(', ', ' · ')}</Text>
        </>
      )}
      {originatingFaxNumber && (
        <>
          <Text fw={500} size="sm" c="dimmed">
            Sender
          </Text>
          <Text size="sm">{formatFaxNumber(originatingFaxNumber)}</Text>
        </>
      )}
      <Text fw={500} size="sm" c="dimmed">
        Patient
      </Text>
      <Text size="sm">
        {patient ? (
          <MedplumLink to={`/Patient/${patient.id}/DocumentReference`}>{getDisplayString(patient)}</MedplumLink>
        ) : (
          'Unassigned'
        )}
      </Text>
      {coverNote && (
        <>
          <Text fw={500} size="sm" c="dimmed">
            Cover Page Note
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', minWidth: 0 }}>
            {coverNote}
          </Text>
        </>
      )}
    </Stack>
  );
}

function isValidUrl(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.href.length > 0;
  } catch {
    return false;
  }
}
