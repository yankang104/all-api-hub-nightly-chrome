/** ChatAI 领取理由：随机十字母、不能与本地历史重复。 */
import { describe, expect, it } from 'vitest';
import { pickUnusedClaimText } from '@/automation/checkin/claim-text';

const LETTERS = /^[a-z]{10}$/;

describe('pickUnusedClaimText', () => {
  it('生成 10 个小写英文字母，且同一条里不重复', () => {
    const picked = pickUnusedClaimText(undefined, 10);
    expect(picked.exhausted).toBe(false);
    expect(picked.text).toMatch(LETTERS);
    expect(new Set(picked.text).size).toBe(10);
  });

  it('跳过历史里已提交过的理由，连续多轮不重复', () => {
    const used: string[] = [];
    for (let round = 0; round < 12; round += 1) {
      const picked = pickUnusedClaimText(used, 10);
      expect(picked.exhausted).toBe(false);
      expect(used).not.toContain(picked.text);
      used.push(picked.text);
    }
    expect(new Set(used).size).toBe(12);
  });

  it('忽略历史理由的首尾空白', () => {
    const first = pickUnusedClaimText([], 10).text;
    const picked = pickUnusedClaimText([`  ${first}  `], 10);
    expect(picked.text).not.toBe(first);
  });

  it('站点要求超过 10 字时如实标记无法满足', () => {
    const picked = pickUnusedClaimText([], 11);
    expect(picked.text).toMatch(LETTERS);
    expect(picked.exhausted).toBe(true);
  });
});
