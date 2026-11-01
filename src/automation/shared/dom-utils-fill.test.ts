import { describe, expect, it, afterEach } from 'vitest';
import { fillEditable, isContentEditableHost, isFillable } from '@/automation/shared/dom-utils';

/**
 * P0-2：workflow 的 fill 步骤要能填 `contenteditable` 富文本框，不再只认 input/textarea。
 * 这里跑真实 jsdom 元素（vitest 环境为 jsdom），验证判定与写值都覆盖三类可填控件。
 */
describe('dom-utils 可填充控件（含 contenteditable）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('isContentEditableHost 只认 "" / "true"，拒绝 "false" / "inherit" / 无属性', () => {
    document.body.innerHTML = [
      '<div id="a" contenteditable></div>',
      '<div id="b" contenteditable="true"></div>',
      '<div id="c" contenteditable="TRUE"></div>',
      '<div id="d" contenteditable="false"></div>',
      '<div id="e" contenteditable="inherit"></div>',
      '<div id="f"></div>',
    ].join('');
    expect(isContentEditableHost(document.getElementById('a')!)).toBe(true);
    expect(isContentEditableHost(document.getElementById('b')!)).toBe(true);
    expect(isContentEditableHost(document.getElementById('c')!)).toBe(true);
    expect(isContentEditableHost(document.getElementById('d')!)).toBe(false);
    expect(isContentEditableHost(document.getElementById('e')!)).toBe(false);
    expect(isContentEditableHost(document.getElementById('f')!)).toBe(false);
  });

  it('isFillable 覆盖 input / textarea / contenteditable，拒绝普通 div', () => {
    document.body.innerHTML = [
      '<input id="i">',
      '<textarea id="t"></textarea>',
      '<div id="ce" contenteditable="true"></div>',
      '<div id="plain"></div>',
    ].join('');
    expect(isFillable(document.getElementById('i')!)).toBe(true);
    expect(isFillable(document.getElementById('t')!)).toBe(true);
    expect(isFillable(document.getElementById('ce')!)).toBe(true);
    expect(isFillable(document.getElementById('plain')!)).toBe(false);
  });

  it('fillEditable 给 input 写值并派发 input/change 事件', () => {
    document.body.innerHTML = '<input id="i">';
    const input = document.getElementById('i') as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push('input'));
    input.addEventListener('change', () => seen.push('change'));
    fillEditable(input, '感谢站长');
    expect(input.value).toBe('感谢站长');
    expect(seen).toEqual(['input', 'change']);
  });

  it('fillEditable 给 contenteditable 写 textContent 并派发事件', () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true"></div>';
    const editor = document.getElementById('ce')!;
    const seen: string[] = [];
    editor.addEventListener('input', () => seen.push('input'));
    editor.addEventListener('change', () => seen.push('change'));
    fillEditable(editor, '每日签到理由');
    expect(editor.textContent).toBe('每日签到理由');
    expect(seen).toEqual(['input', 'change']);
  });
});
