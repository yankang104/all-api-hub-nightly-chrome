import { setNativeValue } from '@/automation/shared/dom-utils';

export type ArithmeticOperator = '+' | '-' | '*' | '/';

export interface ParsedArithmeticExpression {
  expression: string;
  left: number;
  operator: ArithmeticOperator;
  right: number;
  result: number;
  answer: string;
}

export interface ArithmeticChallenge extends ParsedArithmeticExpression {
  input: HTMLInputElement | HTMLTextAreaElement;
}

const ANSWER_FIELD_HINT = /(?:答案|计算结果|计算答案|运算结果|运算答案|算术验证|数学验证|人机验证|验证码|answer|result|arithmetic|calculation|math|captcha)/i;
const NUMBER_SOURCE = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const STRICT_EXPRESSION = new RegExp(
  `^\\s*(${NUMBER_SOURCE})\\s*([+\\-*/])\\s*(${NUMBER_SOURCE})\\s*(?:=\\s*(?:\\?)?)?\\s*$`,
);
const EMBEDDED_EXPRESSION = new RegExp(
  `(${NUMBER_SOURCE}\\s*[+\\-*/]\\s*${NUMBER_SOURCE}\\s*=\\s*(?:\\?)?)`,
);
const SUSPICIOUS_EXPRESSION_TEXT = /[;{}[\]`]|=>|\b(?:alert|eval|function|globalThis|window|document)\b/i;
const UNSUPPORTED_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'hidden',
  'image',
  'month',
  'password',
  'radio',
  'range',
  'reset',
  'submit',
  'time',
  'url',
  'week',
]);

/** Solved fields are remembered only to keep a removed equation from falling through as generic CAPTCHA. */
const solvedAnswerFields = new WeakMap<Element, string>();

function normalizeArithmeticText(source: string): string {
  let normalized = '';

  for (const character of source) {
    const code = character.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) {
      normalized += String(code - 0xff10);
      continue;
    }

    switch (character) {
      case '\u00a0':
        normalized += ' ';
        break;
      case '\uff0b':
      case '\ufe62':
        normalized += '+';
        break;
      case '\u2212':
      case '\ufe63':
      case '\uff0d':
      case '\u2010':
      case '\u2011':
      case '\u2012':
      case '\u2013':
      case '\u2014':
        normalized += '-';
        break;
      case '\uff0a':
      case '\u2217':
      case '\u00d7':
      case '\uff58':
      case '\uff38':
      case 'x':
      case 'X':
        normalized += '*';
        break;
      case '\uff0f':
      case '\u2044':
      case '\u2215':
      case '\u00f7':
        normalized += '/';
        break;
      case '\uff0e':
        normalized += '.';
        break;
      case '\uff1d':
        normalized += '=';
        break;
      case '\uff1f':
        normalized += '?';
        break;
      default:
        normalized += character;
    }
  }

  return normalized;
}

function formatAnswer(result: number): string {
  return Object.is(result, -0) ? '0' : String(result);
}

/**
 * Parse one binary arithmetic expression. The anchored grammar deliberately
 * rejects functions, parentheses, exponent notation and trailing text.
 */
export function parseArithmeticExpression(source: string): ParsedArithmeticExpression | null {
  const normalized = normalizeArithmeticText(source);
  if (normalized.length > 128) return null;

  const match = normalized.match(STRICT_EXPRESSION);
  if (!match) return null;

  const left = Number(match[1]);
  const operator = match[2] as ArithmeticOperator;
  const right = Number(match[3]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  if (operator === '/' && right === 0) return null;

  let result: number;
  switch (operator) {
    case '+':
      result = left + right;
      break;
    case '-':
      result = left - right;
      break;
    case '*':
      result = left * right;
      break;
    case '/':
      result = left / right;
      break;
  }

  if (!Number.isFinite(result)) return null;
  return {
    expression: `${match[1]} ${operator} ${match[3]}`,
    left,
    operator,
    right,
    result,
    answer: formatAnswer(result),
  };
}

function extractArithmeticExpression(source: string): ParsedArithmeticExpression | null {
  const normalized = normalizeArithmeticText(source).trim();
  const exact = parseArithmeticExpression(normalized);
  if (exact) return exact;
  if (SUSPICIOUS_EXPRESSION_TEXT.test(normalized)) return null;

  // In ordinary form text, require an explicit "=" marker. This prevents a
  // date such as 2026-08 from being mistaken for a subtraction challenge.
  const embedded = normalized.match(EMBEDDED_EXPRESSION)?.[1];
  return embedded ? parseArithmeticExpression(embedded) : null;
}

function isUsableAnswerField(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
  if (element.disabled || element.readOnly || element.hidden) return false;
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;

  let current: Element | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    current = current.parentElement;
  }

  if (element instanceof HTMLInputElement) {
    if (UNSUPPORTED_INPUT_TYPES.has(element.type.toLowerCase())) return false;
  }

  return true;
}

function labelledText(input: HTMLInputElement | HTMLTextAreaElement): string[] {
  const texts: string[] = [];
  for (const label of Array.from(input.labels ?? [])) {
    if (label.textContent) texts.push(label.textContent);
  }

  const labelledBy = input.getAttribute('aria-labelledby')?.trim().split(/\s+/) ?? [];
  for (const id of labelledBy) {
    const element = input.ownerDocument.getElementById(id);
    if (element?.textContent) texts.push(element.textContent);
  }

  const describedBy = input.getAttribute('aria-describedby')?.trim().split(/\s+/) ?? [];
  for (const id of describedBy) {
    const element = input.ownerDocument.getElementById(id);
    if (element?.textContent) texts.push(element.textContent);
  }

  return texts;
}

function fieldHintText(input: HTMLInputElement | HTMLTextAreaElement): string {
  return [
    input.name,
    input.id,
    input.className,
    input.getAttribute('placeholder'),
    input.getAttribute('aria-label'),
    input.getAttribute('title'),
    ...labelledText(input),
  ].filter(Boolean).join(' ');
}

function expressionSources(input: HTMLInputElement | HTMLTextAreaElement): string[] {
  const sources = [
    input.getAttribute('placeholder') ?? '',
    input.getAttribute('aria-label') ?? '',
    input.getAttribute('title') ?? '',
    ...labelledText(input),
  ];

  let current = input.parentElement;
  for (let depth = 0; current && depth < 4; depth += 1) {
    sources.push(current.textContent ?? '');
    if (current instanceof HTMLFormElement) break;
    current = current.parentElement;
  }

  const form = input.closest('form');
  if (form && current !== form) sources.push(form.textContent ?? '');
  return [...new Set(sources.map((text) => text.trim()).filter(Boolean))];
}

/**
 * Locate the current equation and its answer field. No expression or result
 * is cached: every invocation reads the current DOM again.
 */
export function findArithmeticChallenge(root: ParentNode = document): ArithmeticChallenge | null {
  const candidates = [...root.querySelectorAll('input, textarea')]
    .filter(isUsableAnswerField)
    .map((input) => {
      const sources = expressionSources(input);
      let parsed: ParsedArithmeticExpression | null = null;
      let sourceIndex = -1;

      for (let index = 0; index < sources.length; index += 1) {
        parsed = extractArithmeticExpression(sources[index]!);
        if (parsed) {
          sourceIndex = index;
          break;
        }
      }

      if (!parsed) return null;
      const hasAnswerHint = ANSWER_FIELD_HINT.test(fieldHintText(input));
      if (!hasAnswerHint) return null;
      return {
        input,
        parsed,
        score: 1_000 + Math.max(0, 100 - sourceIndex),
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  return best ? { ...best.parsed, input: best.input } : null;
}

/** Read the current equation, calculate it and overwrite the current answer. */
export function solveArithmeticChallenge(root: ParentNode = document): ArithmeticChallenge | null {
  const challenge = findArithmeticChallenge(root);
  if (!challenge) return null;

  // Mark before dispatching input/change because a controlled form can rerender
  // synchronously while setNativeValue is notifying its framework.
  solvedAnswerFields.set(challenge.input, challenge.answer);
  setNativeValue(challenge.input, challenge.answer);
  return challenge;
}

export function isSolvedArithmeticAnswer(element: Element): boolean {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
  const expected = solvedAnswerFields.get(element);
  return expected !== undefined && element.value.trim() === expected;
}
