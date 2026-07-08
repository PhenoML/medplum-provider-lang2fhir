// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Anchor, Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { formatDateTime, normalizeErrorString } from '@medplum/core';
import type { Attachment, DocumentReference } from '@medplum/fhirtypes';
import { MedplumLink, useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconFileText } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { usePatient } from '../../hooks/usePatient';
import { decodeBase64Utf8 } from '../../utils/referral';

// LOINC code the prior-auth draft flow stamps onto its DocumentReference (see DraftPriorAuthModal).
const PRIOR_AUTH_LOINC = 'http://loinc.org|68609-7';

/**
 * Patient-level billing page. Lists the prior-authorization documents drafted for the patient and
 * renders their narrative so it can be read without opening the encounter's Details & Billing tab.
 * @returns The billing page component.
 */
export function BillingPage(): JSX.Element {
  const medplum = useMedplum();
  const patient = usePatient();
  const [docs, setDocs] = useState<WithId<DocumentReference>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const patientId = patient?.id;

  useEffect(() => {
    if (!patientId) {
      return undefined;
    }
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    medplum
      .searchResources(
        'DocumentReference',
        `subject=Patient/${patientId}&type=${PRIOR_AUTH_LOINC}&_sort=-date`,
        { cache: 'no-cache' }
      )
      .then((results) => {
        if (!cancelled) {
          setDocs(results);
          setError(undefined);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(normalizeErrorString(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [medplum, patientId]);

  const renderBody = (): JSX.Element | JSX.Element[] => {
    if (loading) {
      return (
        <Center py="xl">
          <Loader />
        </Center>
      );
    }
    if (error) {
      return (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Could not load prior authorizations">
          {error}
        </Alert>
      );
    }
    if (docs.length === 0) {
      return (
        <Text c="dimmed">No prior authorizations yet. Draft one from an encounter's Details &amp; Billing tab.</Text>
      );
    }
    return docs.map((doc) => <PriorAuthCard key={doc.id} doc={doc} patientId={patientId as string} />);
  };

  return (
    <Stack p="md" gap="md">
      <div>
        <Title order={3}>Billing</Title>
        <Text size="sm" c="dimmed">
          Prior-authorization requests drafted for this patient.
        </Text>
      </div>
      {renderBody()}
    </Stack>
  );
}

function encounterId(doc: DocumentReference): string | undefined {
  const ref = doc.context?.encounter?.[0]?.reference;
  return ref?.startsWith('Encounter/') ? ref.slice('Encounter/'.length) : undefined;
}

function PriorAuthCard(props: { doc: WithId<DocumentReference>; patientId: string }): JSX.Element {
  const { doc, patientId } = props;
  const attachment = doc.content?.[0]?.attachment;
  const encId = encounterId(doc);

  return (
    <Card withBorder shadow="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Group gap="xs" wrap="nowrap">
            <IconFileText size={18} />
            <MedplumLink to={`/Patient/${patientId}/DocumentReference/${doc.id}`} fw={600}>
              {attachment?.title ?? 'Prior Authorization Request'}
            </MedplumLink>
          </Group>
          {doc.date && (
            <Text size="sm" c="dimmed">
              {formatDateTime(doc.date)}
            </Text>
          )}
        </Group>

        {encId && (
          <Text size="sm">
            <Anchor component={MedplumLink} to={`/Patient/${patientId}/Encounter/${encId}`}>
              View source encounter
            </Anchor>
          </Text>
        )}

        <PriorAuthNarrative attachment={attachment} />
      </Stack>
    </Card>
  );
}

function PriorAuthNarrative(props: { attachment?: Attachment }): JSX.Element {
  const { attachment } = props;

  // Narratives are stored inline as base64 text/plain data, decoded locally with no network call.
  let text = '';
  let error: string | undefined;
  if (attachment?.data) {
    try {
      text = decodeBase64Utf8(attachment.data);
    } catch (err) {
      error = normalizeErrorString(err);
    }
  }

  if (error) {
    return (
      <Text size="sm" c="red">
        Could not load document content: {error}
      </Text>
    );
  }

  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
      {text || 'No content.'}
    </Text>
  );
}
