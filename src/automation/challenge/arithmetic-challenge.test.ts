import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectChallenge, waitForChallenge } from '@/automation/challenge/challenge';
import {
  findArithmeticChallenge,
  parseArithmeticExpression,
  solveArithmeticChallenge,
} from '@/automation/challenge/arithmetic-challenge';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('parseArithmeticExpression', () => {
  it.each([
    ['13 + 8 = ?', 21],
    ['27 - 9 = ?', 18],
    ['6 * 7 = ?', 42],
    ['6 x 7 = ?', 42],
    ['6 X 7 = ?', 42],
    ['6 × 7 = ?', 42],
    ['20 / 4 = ?', 5],
    ['20 ÷ 4 = ?', 5],
    ['１２ ＋ ３ ＝ ？', 15],
    ['９ － ４ ＝ ？', 5],
    ['８ ＊ ７ ＝ ？', 56],
    ['１８ ／ ３ ＝ ？', 6],
  ])('calculates %s', (expression, expected) => {
    expect(parseArithmeticExpression(expression)?.result).toBe(expected);
  });

  it('rejects division by zero and non-finite numeric input', () => {
    expect(parseArithmeticExpression('10 / 0 = ?')).toBeNull();
    expect(parseArithmeticExpression(`${'9'.repeat(400)} + 1 = ?`)).toBeNull();
  });

  it('rejects executable or trailing text instead of evaluating it', () => {
    expect(parseArithmeticExpression('1 + 2 = ?; globalThis.pwned = true')).toBeNull();
    expect(parseArithmeticExpression('Math.max(1, 2)')).toBeNull();
    expect(parseArithmeticExpression('1 + alert(2)')).toBeNull();
  });
});

describe('dynamic arithmetic form challenge', () => {
  it('recognizes an answer field by placeholder and prefers it over the username field', () => {
    document.body.innerHTML = `
      <form>
        <input name="username" type="text">
        <div>计算验证：13 + 8 = ?</div>
        <input name="captcha" placeholder="答案" type="text">
      </form>
    `;

    const challenge = findArithmeticChallenge();
    expect(challenge?.input).toBe(document.querySelector('input[name="captcha"]'));
    expect(challenge?.answer).toBe('21');
  });

  it('does not overwrite an ordinary login field when the form has no answer-field hint', () => {
    document.body.innerHTML = `
      <form>
        <div>13 + 8 = ?</div>
        <input name="username" type="text">
        <input name="password" type="password">
      </form>
    `;

    expect(findArithmeticChallenge()).toBeNull();
    expect(solveArithmeticChallenge()).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[name="username"]')!.value).toBe('');
  });

  it('reads and calculates the current equation again after the page changes it', () => {
    document.body.innerHTML = `
      <form>
        <span id="equation">13 + 8 = ?</span>
        <input name="captcha_answer" placeholder="请输入计算结果">
      </form>
    `;
    const input = document.querySelector<HTMLInputElement>('input')!;

    expect(solveArithmeticChallenge()?.answer).toBe('21');
    expect(input.value).toBe('21');

    document.querySelector('#equation')!.textContent = '9 × 7 = ?';
    expect(solveArithmeticChallenge()?.answer).toBe('63');
    expect(input.value).toBe('63');
  });

  it('dispatches input and change events through the native value helper', () => {
    document.body.innerHTML = `
      <form>
        <span>20 ÷ 4 = ?</span>
        <input name="answer" placeholder="答案">
      </form>
    `;
    const input = document.querySelector<HTMLInputElement>('input')!;
    const onInput = vi.fn();
    const onChange = vi.fn();
    input.addEventListener('input', onInput);
    input.addEventListener('change', onChange);

    solveArithmeticChallenge();

    expect(input.value).toBe('5');
    expect(onInput).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('is detected before generic CAPTCHA and waitForChallenge resolves it automatically', async () => {
    document.body.innerHTML = `
      <form>
        <div>人机验证：31 - 12 = ?</div>
        <input name="captcha" placeholder="计算结果">
      </form>
    `;
    const log = { push: vi.fn() };
    const onNeedsUser = vi.fn(async () => {});

    expect(detectChallenge()).toBe('Arithmetic');
    await expect(waitForChallenge(log, onNeedsUser)).resolves.toEqual({
      detected: true,
      resolved: true,
      kind: 'Arithmetic',
    });
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('19');
    expect(onNeedsUser).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith('已识别动态算式 31 - 12，并填写计算结果 19');
  });

  it('does not fall back to generic CAPTCHA if the equation disappears after being solved', async () => {
    document.body.innerHTML = `
      <form>
        <span id="equation">7 + 5 = ?</span>
        <input name="captcha" placeholder="答案">
      </form>
    `;
    await waitForChallenge({ push: vi.fn() }, vi.fn(async () => {}));
    document.querySelector('#equation')!.remove();

    expect(detectChallenge()).toBeNull();
  });
});
