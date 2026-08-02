import { Fragment, type ReactNode } from 'react';
import { NAME_KEYS, titleCase } from './name';

// Matches `{{key}}` interpolations, `<g>masc|fem</g>` gender forms,
// `<hw>…</hw>` (handwritten cursive + underline), and `<hl>…</hl>`
// (warm-gold accent colour) markers used in locale strings to style or
// inflect specific words.
const TOKEN =
  /\{\{(\w+)\}\}|<g>([\s\S]*?)<\/g>|<hw>([\s\S]*?)<\/hw>|<hl>([\s\S]*?)<\/hl>/g;

// Matches a single `<g>masculine|feminine</g>` gender form (used by the
// plain-string resolvers below).
const GENDER_TOKEN = /<g>([\s\S]*?)<\/g>/g;

export type Gender = 'male' | 'female';

/**
 * Reads the user's selected gender (captured at the `gender_select` step and
 * persisted in the quiz store as `answers.gender`). Defaults to masculine when
 * unset, which matches legacy source strings that only carried the masculine
 * form.
 */
export function genderOf(answers: Record<string, unknown>): Gender {
  return answers.gender === 'female' ? 'female' : 'male';
}

/**
 * Picks one side of a `masculine|feminine` body. A body without a `|`
 * separator (single invariant form) is used for both genders.
 */
function pickGenderForm(body: string, gender: Gender): string {
  const sep = body.indexOf('|');
  if (sep === -1) return body;
  return gender === 'female' ? body.slice(sep + 1) : body.slice(0, sep);
}

/**
 * Resolves every `<g>masc|fem</g>` marker in a string to the gendered form,
 * leaving all other text untouched. String-level (no React nodes) so it can be
 * composed into the plain-copy resolvers.
 */
export function resolveGenderTokens(template: string, gender: Gender): string {
  GENDER_TOKEN.lastIndex = 0;
  return template.replace(GENDER_TOKEN, (_, body: string) =>
    pickGenderForm(body, gender),
  );
}

/**
 * Resolves a template to PLAIN TEXT: gender forms + `{{key}}` interpolations,
 * with `<hw>`/`<hl>` style markers stripped (their inner text is kept). Used
 * when an option label is stored as an answer label and later re-displayed in
 * answer summaries / copy interpolation, where a raw `<g>…</g>` token would
 * otherwise leak through literally.
 */
export function resolveToPlainText(
  template: string,
  answers: Record<string, unknown>,
): string {
  const gender = genderOf(answers);
  return resolveGenderTokens(template, gender)
    .replace(/<\/?hw>/g, '')
    .replace(/<\/?hl>/g, '')
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const v = answers[key];
      const raw = Array.isArray(v) ? v.join(', ') : v != null ? String(v) : '';
      return NAME_KEYS.has(key) ? titleCase(raw) : raw;
    });
}

/**
 * Renders a localised template, replacing `{{key}}` interpolations from
 * `answers`, resolving `<g>masc|fem</g>` gender forms against the selected
 * gender, and wrapping `<hw>…</hw>` / `<hl>…</hl>` markers in styled spans
 * (gender forms nested inside those markers are resolved too).
 */
export function renderTemplated(
  template: string,
  answers: Record<string, unknown>,
): ReactNode {
  const gender = genderOf(answers);
  const parts: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(template)) !== null) {
    if (match.index > last) parts.push(template.slice(last, match.index));

    if (match[1] !== undefined) {
      // {{key}} interpolation — names are title-cased but rendered as plain
      // text. To highlight a word in the handwritten/underlined style, wrap it
      // in <hw>…</hw> in the source string instead.
      const key = match[1];
      const v = answers[key];
      const raw = Array.isArray(v) ? v.join(', ') : v != null ? String(v) : '';
      parts.push(NAME_KEYS.has(key) ? titleCase(raw) : raw);
    } else if (match[2] !== undefined) {
      // <g>masc|fem</g> — render the form matching the selected gender.
      parts.push(pickGenderForm(match[2], gender));
    } else if (match[3] !== undefined) {
      // <hw>…</hw> static highlight — handwritten cursive + underline
      parts.push(
        <span key={`hw-${match.index}`} className="handwritten-name">
          {resolveGenderTokens(match[3], gender)}
        </span>,
      );
    } else if (match[4] !== undefined) {
      // <hl>…</hl> static highlight — warm gold accent colour
      parts.push(
        <span key={`hl-${match.index}`} className="text-accent">
          {resolveGenderTokens(match[4], gender)}
        </span>,
      );
    }

    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return <Fragment>{parts}</Fragment>;
}
