// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  ElementDefinition,
  Questionnaire,
  QuestionnaireItem,
  StructureDefinition,
} from '@medplum/fhirtypes';
import { createHash } from 'crypto';

/**
 * Deterministic Questionnaire -> QuestionnaireResponse profile builder.
 *
 * Given a FHIR Questionnaire, this synthesizes a StructureDefinition that profiles
 * QuestionnaireResponse so that lang2fhir can conform its output to the exact shape of the source
 * form. It is pure, server-only code — no LLM, no network — so the same Questionnaire always yields
 * the same profile (idempotent uploads, cacheable in Medplum).
 *
 * Walking the Questionnaire's item tree, for every answerable leaf it emits a slice of
 * QuestionnaireResponse.item discriminated by linkId, with a fixed linkId/text and a constrained
 * answer.value[x] type. min:0 everywhere — the model is never forced to fabricate an answer for a
 * question the transcript does not mention.
 *
 * NOTE: this lives under src/bots (not src/utils) because the scribe-fill bot cannot import from
 * src/utils (its tsconfig rootDir is src/bots).
 */

// Implementation Guide under which screening-form QR profiles are grouped in PhenoML. Cannot be
// "us_core" (reserved). Grouping keeps custom profiles discoverable during resource detection.
export const IMPLEMENTATION_GUIDE = 'medplum_questionnaires';

// Canonical URL namespace for the generated StructureDefinitions.
export const PROFILE_URL_BASE = 'https://www.medplum.com/fhir/StructureDefinition';

// Base FHIR resource these profiles constrain.
const QR_BASE_DEFINITION = 'http://hl7.org/fhir/StructureDefinition/QuestionnaireResponse';

// Item types that do not produce an answer (structural / presentational only).
const NON_ANSWERABLE_TYPES = new Set(['group', 'display']);

// Maps a Questionnaire item type to the allowed FHIR QuestionnaireResponse.answer.value[x] type
// code(s). Choice items are Coding only when their answerOptions carry codings; otherwise string.
export function valueTypesFor(item: QuestionnaireItem): string[] {
  switch (item.type) {
    case 'boolean':
      return ['boolean'];
    case 'decimal':
      return ['decimal'];
    case 'integer':
      return ['integer'];
    case 'date':
      return ['date'];
    case 'dateTime':
      return ['dateTime'];
    case 'time':
      return ['time'];
    case 'quantity':
      return ['Quantity'];
    case 'url':
      return ['uri'];
    case 'reference':
      return ['Reference'];
    case 'attachment':
      return ['Attachment'];
    case 'choice':
    case 'open-choice':
      return item.answerOption?.some((opt) => opt.valueCoding) ? ['Coding'] : ['string'];
    case 'string':
    case 'text':
    default:
      return ['string'];
  }
}

// True when an item expects a Coding answer (has coded answerOptions).
function isCoded(item: QuestionnaireItem): boolean {
  return valueTypesFor(item).includes('Coding');
}

// Depth-first list of answerable leaf items (skips groups/display), in document order.
export function getAnswerableItems(questionnaire: Questionnaire): QuestionnaireItem[] {
  const result: QuestionnaireItem[] = [];
  const walk = (items: QuestionnaireItem[] | undefined): void => {
    for (const item of items ?? []) {
      if (item.linkId && item.type && !NON_ANSWERABLE_TYPES.has(item.type)) {
        result.push(item);
      }
      walk(item.item);
    }
  };
  walk(questionnaire.item);
  return result;
}

// Human-readable list of the allowed codes for a coded item; used as the binding description.
export function codesDescription(item: QuestionnaireItem): string {
  const codes = (item.answerOption ?? [])
    .map((opt) => opt.valueCoding)
    .filter((coding): coding is NonNullable<typeof coding> => Boolean(coding?.code))
    .map((coding) => `${coding.code}${coding.display ? ` (${coding.display})` : ''}`);
  return codes.length ? `Allowed codes: ${codes.join('; ')}` : '';
}

// Reduces a string to a URL/id-safe slug.
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'form'
  );
}

// Builds a valid FHIR StructureDefinition.name (PascalCase, alphanumeric only) from a title + hash.
function pascalName(title: string, hash: string): string {
  const pascal = title
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  const base = /^[A-Za-z]/.test(pascal) ? pascal : `Qr${pascal}`;
  return `${base || 'Questionnaire'}Response${hash.slice(0, 6).toUpperCase()}`;
}

// A stable representation of the answerable items, so the content hash only changes when the
// question set (linkIds, types, allowed codes, text) changes.
function canonicalItems(items: QuestionnaireItem[]): string {
  return JSON.stringify(
    items.map((item) => ({
      linkId: item.linkId,
      type: item.type,
      text: item.text,
      codes: (item.answerOption ?? []).map((opt) => opt.valueCoding?.code).filter(Boolean),
    }))
  );
}

// Content-derived profile id: `qr-<title-slug>-<sha256(items)[:8]>`. Re-building the same form yields
// the same id, so uploads are idempotent and the profile can be looked up/cached deterministically.
export function profileIdFor(questionnaire: Questionnaire): string {
  const title = questionnaire.title ?? questionnaire.name ?? 'questionnaire';
  const hash = createHash('sha256').update(canonicalItems(getAnswerableItems(questionnaire))).digest('hex').slice(0, 8);
  return `qr-${slugify(title)}-${hash}`;
}

// FHIR sliceName tokens must be [A-Za-z0-9\-.]{1,64}. Sanitize the linkId (usually already safe).
function sliceNameFor(linkId: string): string {
  const clean = linkId.replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, 64);
  return clean || 'item';
}

// Emits the constrained snapshot elements: the item slicing root, then one slice per answerable leaf
// (fixed linkId/text + constrained answer.value[x] + required binding carrying the allowed codes).
function buildElements(questionnaire: Questionnaire): ElementDefinition[] {
  const elements: ElementDefinition[] = [
    { id: 'QuestionnaireResponse', path: 'QuestionnaireResponse', min: 0, max: '*' },
    {
      id: 'QuestionnaireResponse.item',
      path: 'QuestionnaireResponse.item',
      slicing: {
        discriminator: [{ type: 'pattern', path: 'linkId' }],
        rules: 'open',
      },
      min: 0,
      max: '*',
    },
  ];

  for (const item of getAnswerableItems(questionnaire)) {
    const sliceName = sliceNameFor(item.linkId);
    const base = `QuestionnaireResponse.item:${sliceName}`;

    elements.push({ id: base, path: 'QuestionnaireResponse.item', sliceName, min: 0, max: '1' });
    elements.push({
      id: `${base}.linkId`,
      path: 'QuestionnaireResponse.item.linkId',
      min: 1,
      max: '1',
      fixedString: item.linkId,
    });
    if (item.text) {
      elements.push({
        id: `${base}.text`,
        path: 'QuestionnaireResponse.item.text',
        min: 0,
        max: '1',
        fixedString: item.text,
      });
    }
    elements.push({
      id: `${base}.answer`,
      path: 'QuestionnaireResponse.item.answer',
      min: 0,
      max: item.repeats ? '*' : '1',
    });

    const valueElement: ElementDefinition = {
      id: `${base}.answer.value[x]`,
      path: 'QuestionnaireResponse.item.answer.value[x]',
      min: 0,
      max: '1',
      type: valueTypesFor(item).map((code) => ({ code })),
    };
    if (isCoded(item)) {
      const description = codesDescription(item);
      if (description) {
        valueElement.binding = { strength: 'required', description };
      }
    }
    elements.push(valueElement);
  }

  return elements;
}

// Builds the QuestionnaireResponse StructureDefinition (profile) for a given Questionnaire.
// Deterministic: same Questionnaire content -> identical StructureDefinition (same id/url).
export function buildQuestionnaireResponseProfile(questionnaire: Questionnaire): StructureDefinition {
  const id = profileIdFor(questionnaire);
  const title = questionnaire.title ?? questionnaire.name ?? 'Questionnaire';
  const hash = id.slice(id.lastIndexOf('-') + 1);
  const elements = buildElements(questionnaire);

  return {
    resourceType: 'StructureDefinition',
    id,
    url: `${PROFILE_URL_BASE}/${id}`,
    name: pascalName(title, hash),
    title: `${title} — QuestionnaireResponse`,
    status: 'active',
    fhirVersion: '4.0.1',
    kind: 'resource',
    abstract: false,
    type: 'QuestionnaireResponse',
    baseDefinition: QR_BASE_DEFINITION,
    derivation: 'constraint',
    snapshot: { element: elements },
    differential: { element: elements },
  };
}

// Natural-language context stored at the IG level to help the LLM pick this profile during resource
// detection. Regenerated per-questionnaire; PhenoML applies "last write wins" for the IG.
export function profileContextFor(questionnaire: Questionnaire): string {
  const title = questionnaire.title ?? questionnaire.name ?? 'a screening questionnaire';
  return `When the text is a clinical visit transcript to be captured as answers to "${title}", use this QuestionnaireResponse profile and emit one item per question using the exact linkId and an allowed code.`;
}

// Builds the "question key" + transcript text sent to lang2fhir/create. Because create only receives
// text (never the Questionnaire), the compact key — one line per answerable leaf with its linkId,
// text, type, and allowed codes — is what steers correct slot-filling.
export function composeExtractionText(transcript: string, questionnaire: Questionnaire): string {
  const title = questionnaire.title ?? questionnaire.name ?? 'screening';
  const lines = getAnswerableItems(questionnaire).map((item) => {
    const codes = (item.answerOption ?? [])
      .map((opt) => {
        const coding = opt.valueCoding;
        if (coding?.code) {
          return `${coding.code}=${coding.display ?? ''}`.trim();
        }
        return opt.valueString ?? '';
      })
      .filter(Boolean)
      .join(', ');
    const codePart = codes ? `; allowed codes: ${codes}` : '';
    return `- [${item.linkId}] ${item.text ?? ''} (${item.type ?? 'string'}${codePart})`;
  });

  return [
    `Fill the "${title}" questionnaire from the clinical transcript below.`,
    `Emit one QuestionnaireResponse.item per question, using the exact linkId shown in [brackets]. For coded questions, the answer must use one of the allowed codes for that question. If the transcript gives no evidence for a question, omit that item — do not guess.`,
    ``,
    `Questions:`,
    ...lines,
    ``,
    `Transcript:`,
    transcript,
  ].join('\n');
}
