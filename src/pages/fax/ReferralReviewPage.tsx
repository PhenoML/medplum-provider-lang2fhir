// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { getDisplayString, normalizeErrorString } from '@medplum/core';
import type {
  Bundle,
  BundleEntry,
  Communication,
  Condition,
  Extension,
  HumanName,
  MedicationRequest,
  Observation,
  Patient,
  Resource,
} from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import {
  IconActivity,
  IconArrowLeft,
  IconCircleCheck,
  IconCircleOff,
  IconClipboardList,
  IconPill,
  IconStethoscope,
  IconUser,
  IconWriting,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FaxDocumentPreview } from '../../components/fax/FaxDocumentPreview';
import {
  decodeBase64Utf8,
  findExtractedBundleAttachment,
  findSourceAttachment,
  getReferralStatus,
  SOURCE_DOCUMENT_EXTENSION_URL,
  withReferralStatus,
} from '../../utils/referral';
import classes from './ReferralReviewPage.module.css';

// LOINC codes the stock chart tends to bury but which matter for behavioral-health intake.
const SCREENING_LOINC: Record<string, string> = {
  '44261-6': 'PHQ-9',
  '70274-9': 'GAD-7',
};
const VITAL_LOINC = new Set(['8480-6', '8462-4', '85354-9', '8867-4', '9279-1', '8310-5', '29463-7', '39156-5', '8302-2']);

interface WorkingEntry {
  entry: BundleEntry;
  index: number;
}

export function ReferralReviewPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { faxId } = useParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [communication, setCommunication] = useState<Communication>();
  const [entries, setEntries] = useState<BundleEntry[]>([]);
  const [signing, setSigning] = useState(false);
  const [signedPatientId, setSignedPatientId] = useState<string>();

  const sourceAttachment = communication ? findSourceAttachment(communication) : undefined;

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!faxId) {
        return;
      }
      setLoading(true);
      setLoadError(undefined);
      try {
        const comm = await medplum.readResource('Communication', faxId);
        if (cancelled) {
          return;
        }
        setCommunication(comm);
        const extracted = findExtractedBundleAttachment(comm);
        let bundle: Bundle;
        if (extracted?.data) {
          bundle = JSON.parse(decodeBase64Utf8(extracted.data)) as Bundle;
        } else if (extracted?.url) {
          // Backward compat: older faxes stashed the bundle as a separate Binary.
          const blob = await medplum.download(extracted.url);
          bundle = JSON.parse(await blob.text()) as Bundle;
        } else {
          throw new Error('No extracted data found on this fax. Run "Process" first.');
        }
        if (!cancelled) {
          setEntries(bundle.entry ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(normalizeErrorString(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [medplum, faxId]);

  const updateResource = useCallback((index: number, resource: Resource) => {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, resource } : e)));
  }, []);

  const groups = useMemo(() => groupEntries(entries), [entries]);

  const patientEntry = groups.patients[0]?.entry;
  const patientName = patientEntry?.resource ? getDisplayString(patientEntry.resource) : 'Unknown patient';

  const handleSign = async (): Promise<void> => {
    if (!faxId) {
      return;
    }
    setSigning(true);
    try {
      const docrefFullUrl = `urn:uuid:${crypto.randomUUID()}`;
      const patientFullUrl = groups.patients[0]?.entry.fullUrl;

      // Link every extracted resource back to the source document (created in the same transaction).
      const linkedEntries: BundleEntry[] = entries.map((e) => {
        const resource = e.resource;
        if (!resource) {
          return e;
        }
        const extension: Extension[] = ((resource as { extension?: Extension[] }).extension ?? []).filter(
          (x) => x.url !== SOURCE_DOCUMENT_EXTENSION_URL
        );
        extension.push({
          url: SOURCE_DOCUMENT_EXTENSION_URL,
          valueReference: { reference: docrefFullUrl, display: 'Source Document' },
        });
        return {
          ...e,
          resource: { ...resource, extension } as Resource,
          request: e.request ?? { method: 'POST', url: resource.resourceType },
        };
      });

      // Retain the referral PDF as a DocumentReference on the patient's chart.
      const docrefEntry: BundleEntry = {
        fullUrl: docrefFullUrl,
        resource: {
          resourceType: 'DocumentReference',
          status: 'current',
          type: { text: 'Behavioral health referral' },
          subject: patientFullUrl ? { reference: patientFullUrl } : undefined,
          date: new Date().toISOString(),
          description: 'Behavioral health referral (source document)',
          content: sourceAttachment ? [{ attachment: sourceAttachment }] : [],
        },
        request: { method: 'POST', url: 'DocumentReference' },
      };

      const txBundle: Bundle = {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [...linkedEntries, docrefEntry],
      };

      const result = await medplum.executeBatch(txBundle);
      const patientLocation = result.entry
        ?.map((e) => e.response?.location)
        .find((loc) => loc?.startsWith('Patient/'));
      const patientId = patientLocation?.split('/')[1];

      // Assign the fax to the new patient and mark the workflow signed.
      const fresh = await medplum.readResource('Communication', faxId);
      const updated = withReferralStatus(fresh, 'signed');
      if (patientId) {
        updated.subject = { reference: `Patient/${patientId}` };
      }
      await medplum.updateResource(updated);
      setCommunication(updated);

      setSignedPatientId(patientId);
      notifications.show({
        color: 'green',
        icon: <IconCircleCheck />,
        title: 'Signed & written to chart',
        message: 'The referral resources were saved to the patient chart.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        icon: <IconCircleOff />,
        title: 'Sign-off failed',
        message: normalizeErrorString(err),
      });
    } finally {
      setSigning(false);
    }
  };

  const goBack = (): void => {
    navigate(`/Fax/Communication/${faxId}`)?.catch(console.error);
  };

  if (loading) {
    return (
      <Flex h="100%" align="center" justify="center">
        <Loader />
      </Flex>
    );
  }

  if (loadError) {
    return (
      <Flex h="100%" direction="column" align="center" justify="center" gap="md">
        <Text c="red">{loadError}</Text>
        <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={goBack}>
          Back to fax
        </Button>
      </Flex>
    );
  }

  const alreadySigned = getReferralStatus(communication) === 'signed' || Boolean(signedPatientId);

  return (
    <div className={classes.container}>
      {/* Header */}
      <Paper>
        <Group justify="space-between" align="center" p="md" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Button variant="subtle" size="compact-sm" leftSection={<IconArrowLeft size={16} />} onClick={goBack}>
              Fax
            </Button>
            <Box style={{ minWidth: 0 }}>
              <Title order={4} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Review referral
              </Title>
              <Text size="sm" c="dimmed">
                {patientName}
              </Text>
            </Box>
          </Group>
          {signedPatientId ? (
            <Button
              color="green"
              leftSection={<IconCircleCheck size={16} />}
              onClick={() => navigate(`/Patient/${signedPatientId}`)?.catch(console.error)}
            >
              View chart
            </Button>
          ) : (
            <Button
              leftSection={<IconWriting size={16} />}
              loading={signing}
              disabled={alreadySigned}
              onClick={handleSign}
            >
              Sign &amp; write to chart
            </Button>
          )}
        </Group>
      </Paper>
      <Divider />

      <div className={classes.body}>
        {/* Left: original document */}
        <div className={classes.leftPane}>
          <FaxDocumentPreview attachment={sourceAttachment} />
        </div>

        {/* Right: extracted, editable data */}
        <div className={classes.rightPane}>
          <ScrollArea style={{ flex: 1 }}>
            <Stack gap="lg" p="md">
              {groups.patients.length > 0 && (
                <Section icon={<IconUser size={18} />} title="Demographics">
                  {groups.patients.map((g) => (
                    <PatientEditor
                      key={g.index}
                      patient={g.entry.resource as Patient}
                      disabled={alreadySigned}
                      onChange={(r) => updateResource(g.index, r)}
                    />
                  ))}
                </Section>
              )}

              {groups.conditions.length > 0 && (
                <Section icon={<IconStethoscope size={18} />} title={`Conditions (${groups.conditions.length})`}>
                  {groups.conditions.map((g) => (
                    <ConditionEditor
                      key={g.index}
                      condition={g.entry.resource as Condition}
                      disabled={alreadySigned}
                      onChange={(r) => updateResource(g.index, r)}
                    />
                  ))}
                </Section>
              )}

              {groups.observations.length > 0 && (
                <Section icon={<IconActivity size={18} />} title={`Observations (${groups.observations.length})`}>
                  {groups.observations.map((g) => (
                    <ObservationEditor
                      key={g.index}
                      observation={g.entry.resource as Observation}
                      disabled={alreadySigned}
                      onChange={(r) => updateResource(g.index, r)}
                    />
                  ))}
                </Section>
              )}

              {groups.medications.length > 0 && (
                <Section icon={<IconPill size={18} />} title={`Medications (${groups.medications.length})`}>
                  {groups.medications.map((g) => (
                    <MedicationEditor
                      key={g.index}
                      medication={g.entry.resource as MedicationRequest}
                      disabled={alreadySigned}
                      onChange={(r) => updateResource(g.index, r)}
                    />
                  ))}
                </Section>
              )}

              {groups.others.length > 0 && (
                <Section icon={<IconClipboardList size={18} />} title="Other resources">
                  {groups.others.map((g) => (
                    <Group key={g.index} justify="space-between" wrap="nowrap">
                      <Text size="sm">{getDisplayString(g.entry.resource as Resource)}</Text>
                      <Badge variant="light" color="gray">
                        {g.entry.resource?.resourceType}
                      </Badge>
                    </Group>
                  ))}
                </Section>
              )}

              {entries.length === 0 && <Text c="dimmed">No resources were extracted from this referral.</Text>}
            </Stack>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

// ---- Layout helpers ----

function Section({ icon, title, children }: { icon: JSX.Element; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group gap="xs">
          {icon}
          <Text fw={700}>{title}</Text>
        </Group>
        <Divider />
        {children}
      </Stack>
    </Paper>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <Group align="flex-start" gap="lg" wrap="nowrap">
      <Text fw={500} size="sm" w={140} c="dimmed" style={{ flexShrink: 0, paddingTop: 6 }}>
        {label}
      </Text>
      <Box style={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Group>
  );
}

// ---- Editors ----

function PatientEditor({
  patient,
  disabled,
  onChange,
}: {
  patient: Patient;
  disabled: boolean;
  onChange: (p: Patient) => void;
}): JSX.Element {
  const name: HumanName = patient.name?.[0] ?? {};
  const given = name.given?.join(' ') ?? '';
  const family = name.family ?? '';
  const mrn = patient.identifier?.[0]?.value ?? '';

  const setName = (next: Partial<{ given: string; family: string }>): void => {
    const newName: HumanName = {
      ...name,
      given: next.given !== undefined ? next.given.split(' ').filter(Boolean) : name.given,
      family: next.family !== undefined ? next.family : name.family,
    };
    onChange({ ...patient, name: [newName, ...(patient.name?.slice(1) ?? [])] });
  };

  return (
    <Stack gap="sm">
      <DetailRow label="First name">
        <TextInput value={given} disabled={disabled} onChange={(e) => setName({ given: e.currentTarget.value })} />
      </DetailRow>
      <DetailRow label="Last name">
        <TextInput value={family} disabled={disabled} onChange={(e) => setName({ family: e.currentTarget.value })} />
      </DetailRow>
      <DetailRow label="Date of birth">
        <TextInput
          value={patient.birthDate ?? ''}
          placeholder="YYYY-MM-DD"
          disabled={disabled}
          onChange={(e) => onChange({ ...patient, birthDate: e.currentTarget.value || undefined })}
        />
      </DetailRow>
      <DetailRow label="Sex">
        <Select
          value={patient.gender ?? null}
          disabled={disabled}
          data={['male', 'female', 'other', 'unknown']}
          onChange={(v) => onChange({ ...patient, gender: (v as Patient['gender']) ?? undefined })}
        />
      </DetailRow>
      <DetailRow label="MRN">
        <TextInput
          value={mrn}
          disabled={disabled}
          onChange={(e) => {
            const identifier = [{ ...(patient.identifier?.[0] ?? {}), value: e.currentTarget.value }];
            onChange({ ...patient, identifier });
          }}
        />
      </DetailRow>
    </Stack>
  );
}

function ConditionEditor({
  condition,
  disabled,
  onChange,
}: {
  condition: Condition;
  disabled: boolean;
  onChange: (c: Condition) => void;
}): JSX.Element {
  const codeText = condition.code?.text ?? condition.code?.coding?.[0]?.display ?? '';
  const status = condition.clinicalStatus?.coding?.[0]?.code ?? null;

  return (
    <Stack gap="xs" mb="xs">
      <DetailRow label="Diagnosis">
        <TextInput
          value={codeText}
          disabled={disabled}
          onChange={(e) => onChange({ ...condition, code: { ...condition.code, text: e.currentTarget.value } })}
        />
      </DetailRow>
      <DetailRow label="Status">
        <Select
          value={status}
          disabled={disabled}
          data={['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved']}
          onChange={(v) =>
            onChange({
              ...condition,
              clinicalStatus: v
                ? {
                    coding: [
                      { system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: v },
                    ],
                  }
                : undefined,
            })
          }
        />
      </DetailRow>
      <Divider variant="dashed" />
    </Stack>
  );
}

function ObservationEditor({
  observation,
  disabled,
  onChange,
}: {
  observation: Observation;
  disabled: boolean;
  onChange: (o: Observation) => void;
}): JSX.Element {
  const loinc = observation.code?.coding?.find((c) => c.system === 'http://loinc.org')?.code;
  const codeText = observation.code?.text ?? observation.code?.coding?.[0]?.display ?? loinc ?? 'Observation';
  const screening = loinc ? SCREENING_LOINC[loinc] : undefined;
  const isVital = observation.category?.some((c) => c.coding?.some((cd) => cd.code === 'vital-signs')) || (loinc ? VITAL_LOINC.has(loinc) : false);

  return (
    <Stack gap="xs" mb="xs">
      <Group gap="xs">
        <Text size="sm" fw={600}>
          {codeText}
        </Text>
        {screening && (
          <Badge size="sm" color="violet" variant="light">
            {screening} screening
          </Badge>
        )}
        {isVital && !screening && (
          <Badge size="sm" color="teal" variant="light">
            Vital
          </Badge>
        )}
      </Group>
      <DetailRow label="Value">
        <ObservationValueInput observation={observation} disabled={disabled} onChange={onChange} />
      </DetailRow>
      <Divider variant="dashed" />
    </Stack>
  );
}

function ObservationValueInput({
  observation,
  disabled,
  onChange,
}: {
  observation: Observation;
  disabled: boolean;
  onChange: (o: Observation) => void;
}): JSX.Element {
  if (observation.valueQuantity) {
    const unit = observation.valueQuantity.unit ?? observation.valueQuantity.code ?? '';
    return (
      <Group gap="xs" wrap="nowrap">
        <TextInput
          type="number"
          value={observation.valueQuantity.value ?? ''}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...observation,
              valueQuantity: {
                ...observation.valueQuantity,
                value: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
              },
            })
          }
        />
        {unit && (
          <Text size="sm" c="dimmed">
            {unit}
          </Text>
        )}
      </Group>
    );
  }
  if (observation.valueInteger !== undefined) {
    return (
      <TextInput
        type="number"
        value={observation.valueInteger}
        disabled={disabled}
        onChange={(e) =>
          onChange({
            ...observation,
            valueInteger: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
          })
        }
      />
    );
  }
  if (observation.valueString !== undefined) {
    return (
      <TextInput
        value={observation.valueString}
        disabled={disabled}
        onChange={(e) => onChange({ ...observation, valueString: e.currentTarget.value })}
      />
    );
  }
  if (observation.component?.length) {
    // Compound observation (e.g. blood pressure) — show read-only summary.
    const summary = observation.component
      .map((c) => {
        const label = c.code?.text ?? c.code?.coding?.[0]?.display ?? '';
        const v = c.valueQuantity ? `${c.valueQuantity.value ?? ''} ${c.valueQuantity.unit ?? ''}`.trim() : '';
        return `${label}: ${v}`.trim();
      })
      .join('  ·  ');
    return (
      <Text size="sm" c="dimmed">
        {summary || '—'}
      </Text>
    );
  }
  const cc = observation.valueCodeableConcept?.text ?? observation.valueCodeableConcept?.coding?.[0]?.display;
  if (cc !== undefined) {
    return (
      <TextInput
        value={cc}
        disabled={disabled}
        onChange={(e) =>
          onChange({
            ...observation,
            valueCodeableConcept: { ...observation.valueCodeableConcept, text: e.currentTarget.value },
          })
        }
      />
    );
  }
  return (
    <Text size="sm" c="dimmed">
      —
    </Text>
  );
}

function MedicationEditor({
  medication,
  disabled,
  onChange,
}: {
  medication: MedicationRequest;
  disabled: boolean;
  onChange: (m: MedicationRequest) => void;
}): JSX.Element {
  const medText =
    medication.medicationCodeableConcept?.text ?? medication.medicationCodeableConcept?.coding?.[0]?.display ?? '';
  const dosage = medication.dosageInstruction?.[0]?.text ?? '';

  return (
    <Stack gap="xs" mb="xs">
      <DetailRow label="Medication">
        <TextInput
          value={medText}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...medication,
              medicationCodeableConcept: { ...medication.medicationCodeableConcept, text: e.currentTarget.value },
            })
          }
        />
      </DetailRow>
      <DetailRow label="Dosage">
        <TextInput
          value={dosage}
          disabled={disabled}
          onChange={(e) => {
            const first = { ...(medication.dosageInstruction?.[0] ?? {}), text: e.currentTarget.value };
            onChange({ ...medication, dosageInstruction: [first, ...(medication.dosageInstruction?.slice(1) ?? [])] });
          }}
        />
      </DetailRow>
      <Divider variant="dashed" />
    </Stack>
  );
}

// ---- Grouping ----

interface GroupedEntries {
  patients: WorkingEntry[];
  conditions: WorkingEntry[];
  observations: WorkingEntry[];
  medications: WorkingEntry[];
  others: WorkingEntry[];
}

function groupEntries(entries: BundleEntry[]): GroupedEntries {
  const groups: GroupedEntries = {
    patients: [],
    conditions: [],
    observations: [],
    medications: [],
    others: [],
  };
  entries.forEach((entry, index) => {
    const type = entry.resource?.resourceType;
    const w = { entry, index };
    switch (type) {
      case 'Patient':
        groups.patients.push(w);
        break;
      case 'Condition':
        groups.conditions.push(w);
        break;
      case 'Observation':
        groups.observations.push(w);
        break;
      case 'MedicationRequest':
      case 'MedicationStatement':
      case 'Medication':
        groups.medications.push(w);
        break;
      default:
        if (type) {
          groups.others.push(w);
        }
    }
  });
  // Surface screening scores and vitals first within Observations.
  groups.observations.sort((a, b) => observationRank(a.entry.resource as Observation) - observationRank(b.entry.resource as Observation));
  return groups;
}

function observationRank(obs: Observation): number {
  const loinc = obs.code?.coding?.find((c) => c.system === 'http://loinc.org')?.code;
  if (loinc && SCREENING_LOINC[loinc]) {
    return 0;
  }
  const isVital = obs.category?.some((c) => c.coding?.some((cd) => cd.code === 'vital-signs')) || (loinc ? VITAL_LOINC.has(loinc) : false);
  return isVital ? 1 : 2;
}
