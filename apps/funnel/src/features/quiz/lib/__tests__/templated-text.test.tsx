import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  genderOf,
  resolveGenderTokens,
  resolveToPlainText,
  renderTemplated,
} from '../templated-text';

describe('genderOf', () => {
  it('defaults to masculine when gender is unset', () => {
    expect(genderOf({})).toBe('male');
    expect(genderOf({ gender: undefined })).toBe('male');
    expect(genderOf({ gender: 'whatever' })).toBe('male');
  });

  it('returns feminine only when gender === "female"', () => {
    expect(genderOf({ gender: 'female' })).toBe('female');
    expect(genderOf({ gender: 'male' })).toBe('male');
  });
});

describe('resolveGenderTokens', () => {
  it('picks the masculine form for male', () => {
    expect(resolveGenderTokens('Jaučiuosi <g>įstrigęs|įstrigusi</g>', 'male')).toBe(
      'Jaučiuosi įstrigęs',
    );
  });

  it('picks the feminine form for female', () => {
    expect(resolveGenderTokens('Jaučiuosi <g>įstrigęs|įstrigusi</g>', 'female')).toBe(
      'Jaučiuosi įstrigusi',
    );
  });

  it('resolves multiple tokens in one string', () => {
    expect(
      resolveGenderTokens('Esu <g>vienas|viena</g> ir <g>pasiruošęs|pasiruošusi</g>', 'female'),
    ).toBe('Esu viena ir pasiruošusi');
  });

  it('uses a single invariant form (no pipe) for both genders', () => {
    expect(resolveGenderTokens('labas <g>žmogus</g>', 'female')).toBe('labas žmogus');
    expect(resolveGenderTokens('labas <g>žmogus</g>', 'male')).toBe('labas žmogus');
  });

  it('leaves text without tokens untouched', () => {
    expect(resolveGenderTokens('Sveiki atvykę', 'female')).toBe('Sveiki atvykę');
  });
});

describe('resolveToPlainText', () => {
  it('resolves gender + interpolates {{fullName}} (title-cased) + strips markers', () => {
    const out = resolveToPlainText(
      '{{fullName}}, jautiesi <hl><g>pavargęs|pavargusi</g></hl>',
      { gender: 'female', fullName: 'aušra žemaitė' },
    );
    expect(out).toBe('Aušra Žemaitė, jautiesi pavargusi');
  });

  it('defaults to masculine when gender missing', () => {
    expect(resolveToPlainText('Esu <g>tikras|tikra</g>', {})).toBe('Esu tikras');
  });
});

describe('renderTemplated (gender)', () => {
  it('renders the feminine form in the DOM', () => {
    const { container } = render(
      <div>{renderTemplated('Jaučiuosi <g>įstrigęs|įstrigusi</g>', { gender: 'female' })}</div>,
    );
    expect(container.textContent).toBe('Jaučiuosi įstrigusi');
  });

  it('renders the masculine form by default', () => {
    const { container } = render(
      <div>{renderTemplated('Jaučiuosi <g>įstrigęs|įstrigusi</g>', {})}</div>,
    );
    expect(container.textContent).toBe('Jaučiuosi įstrigęs');
  });

  it('resolves a gender token nested inside an <hl> highlight span', () => {
    const { container } = render(
      <div>{renderTemplated('Esu <hl><g>laisvas|laisva</g></hl>', { gender: 'female' })}</div>,
    );
    expect(container.textContent).toBe('Esu laisva');
    expect(container.querySelector('.text-accent')?.textContent).toBe('laisva');
  });

  it('still interpolates {{fullName}} alongside a gender token', () => {
    const { container } = render(
      <div>{renderTemplated('{{fullName}}, esi <g>pasiruošęs|pasiruošusi</g>', {
        gender: 'female',
        fullName: 'jonas',
      })}</div>,
    );
    expect(container.textContent).toBe('Jonas, esi pasiruošusi');
  });
});
