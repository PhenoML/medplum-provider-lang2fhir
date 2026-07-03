// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Group, Loader, Paper, Text } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconCircleCheck, IconCircleX, IconX } from '@tabler/icons-react';
import type { JSX } from 'react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { getReferralStatus } from '../../utils/referral';
import type { ReferralStatus } from '../../utils/referral';
import { cleanFaxText } from './fax.utils';

type JobStatus = 'processing' | 'complete' | 'error';

interface ReferralJob {
  communicationId: string;
  label: string;
  status: JobStatus;
}

interface ReferralProcessingContextValue {
  /** Begin tracking a fax Communication that is being processed by the referral-intake bot. */
  track: (communicationId: string, label?: string) => void;
  jobs: ReferralJob[];
  dismiss: (communicationId: string) => void;
}

const ReferralProcessingContext = createContext<ReferralProcessingContextValue>({
  track: () => undefined,
  jobs: [],
  dismiss: () => undefined,
});

export function useReferralProcessing(): ReferralProcessingContextValue {
  return useContext(ReferralProcessingContext);
}

const DISCOVERY_INTERVAL_MS = 5000;
// A fax stuck in 'processing' longer than this is treated as stale and not auto-surfaced, so a
// failed/abandoned run doesn't pin the indicator open forever.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// App-level provider that tracks referral fax processing jobs so a status indicator can follow the
// user across screens. Processing runs server-side (fire-and-forget bot) and status is durable on
// the Communication, so this just polls the tracked Communications until they leave 'processing'.
export function ReferralProcessingProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const medplum = useMedplum();
  const [jobs, setJobs] = useState<ReferralJob[]>([]);

  const track = useCallback((communicationId: string, label?: string) => {
    setJobs((prev) => [
      ...prev.filter((j) => j.communicationId !== communicationId),
      { communicationId, label: label ?? 'Referral fax', status: 'processing' },
    ]);
  }, []);

  const dismiss = useCallback((communicationId: string) => {
    setJobs((prev) => prev.filter((j) => j.communicationId !== communicationId));
  }, []);

  // Discover in-flight processing faxes from the server and reconcile tracked jobs. This makes the
  // indicator appear and follow the user even when processing was started elsewhere or before a
  // reload — not only when Process was clicked in this session (which calls track() for instant
  // feedback). Completed/errored jobs stay until dismissed.
  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      medplum
        .searchResources('Communication', 'category=inbound&_count=25&_sort=-_lastUpdated')
        .then((results) => {
          if (cancelled) {
            return undefined;
          }
          const serverStatus = new Map<string, ReferralStatus | undefined>();
          const recentlyProcessing: { id: string; label: string }[] = [];
          for (const comm of results) {
            if (!comm.id) {
              continue;
            }
            const status = getReferralStatus(comm);
            serverStatus.set(comm.id, status);
            const updatedAt = comm.meta?.lastUpdated ? Date.parse(comm.meta.lastUpdated) : 0;
            if (status === 'processing' && Date.now() - updatedAt < STALE_PROCESSING_MS) {
              recentlyProcessing.push({ id: comm.id, label: cleanFaxText(comm.topic?.text) || 'Referral fax' });
            }
          }
          setJobs((prev) => {
            const reconciled: ReferralJob[] = prev.map((job) => {
              if (job.status !== 'processing') {
                return job;
              }
              const status = serverStatus.get(job.communicationId);
              if (status && status !== 'processing') {
                return { ...job, status: status === 'error' ? 'error' : 'complete' };
              }
              return job;
            });
            const additions: ReferralJob[] = recentlyProcessing
              .filter((rp) => !reconciled.some((j) => j.communicationId === rp.id))
              .map((rp) => ({ communicationId: rp.id, label: rp.label, status: 'processing' }));
            return [...reconciled, ...additions];
          });
          return undefined;
        })
        .catch(() => undefined);
    };
    poll();
    const interval = setInterval(poll, DISCOVERY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [medplum]);

  return (
    <ReferralProcessingContext.Provider value={{ track, jobs, dismiss }}>
      {children}
    </ReferralProcessingContext.Provider>
  );
}

// Floating indicator, fixed to the viewport so it follows the user across route changes.
// Shows "Processing Faxes" while any job runs, then "Fax Processing Complete" (clickable to the
// processed fax) or a failure state.
export function ReferralProcessingIndicator(): JSX.Element | null {
  const { jobs, dismiss } = useReferralProcessing();
  const navigate = useNavigate();

  if (jobs.length === 0) {
    return null;
  }

  const processing = jobs.filter((j) => j.status === 'processing');
  const complete = jobs.filter((j) => j.status === 'complete');
  const errored = jobs.filter((j) => j.status === 'error');

  const wrapperStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 20,
    left: 20,
    zIndex: 300,
  };

  if (processing.length > 0) {
    return (
      <Paper shadow="md" radius="xl" p="sm" px="md" withBorder style={wrapperStyle}>
        <Group gap="xs" wrap="nowrap">
          <Loader size={16} />
          <Text size="sm" fw={600}>
            Processing {processing.length > 1 ? `${processing.length} Faxes` : 'Faxes'}…
          </Text>
        </Group>
      </Paper>
    );
  }

  if (complete.length > 0) {
    const target = complete[complete.length - 1].communicationId;
    const clearAll = (): void => complete.forEach((j) => dismiss(j.communicationId));
    return (
      <Paper
        shadow="md"
        radius="xl"
        p="sm"
        px="md"
        withBorder
        style={{ ...wrapperStyle, cursor: 'pointer' }}
        onClick={() => {
          navigate(`/Fax/Communication/${target}`)?.catch(console.error);
          clearAll();
        }}
      >
        <Group gap="xs" wrap="nowrap">
          <IconCircleCheck size={18} color="var(--mantine-color-green-6)" />
          <Text size="sm" fw={600}>
            Fax Processing Complete
          </Text>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            radius="xl"
            onClick={(e) => {
              e.stopPropagation();
              clearAll();
            }}
          >
            <IconX size={14} />
          </ActionIcon>
        </Group>
      </Paper>
    );
  }

  // Only errors remain.
  const clearErrors = (): void => errored.forEach((j) => dismiss(j.communicationId));
  return (
    <Paper shadow="md" radius="xl" p="sm" px="md" withBorder style={wrapperStyle}>
      <Group gap="xs" wrap="nowrap">
        <IconCircleX size={18} color="var(--mantine-color-red-6)" />
        <Text size="sm" fw={600}>
          Fax Processing Failed
        </Text>
        <ActionIcon variant="subtle" color="gray" size="sm" radius="xl" onClick={clearErrors}>
          <IconX size={14} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}
