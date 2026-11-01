/**
 * 「领取理由不能与历史重复」的文本选取。
 *
 * ChatAI 只要求不少于 10 个字符、且不与历史原因重复。使用 a-z 中无重复
 * 随机抽出的 10 个字母，避免旧固定中文理由池已被站点历史记录命中的问题。
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const RANDOM_REASON_LENGTH = 10;
const MAX_ATTEMPTS = 128;

/** Fisher–Yates 洗牌后截取 10 个字母；同一文本内不会有重复字母。 */
function randomTenLetters(): string {
  const letters = [...LETTERS];
  for (let index = letters.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [letters[index], letters[swap]] = [letters[swap]!, letters[index]!];
  }
  return letters.slice(0, RANDOM_REASON_LENGTH).join('');
}

/**
 * 生成一个未在本地历史中出现过的十字母理由。
 *
 * 总组合数远大于实际签到次数；最多尝试 128 次只是防御性上限。若极端碰撞，
 * 返回最后一条并标记 exhausted，让调用方如实报告而不是把它当成功。
 */
export function pickUnusedClaimText(
  used: string[] | undefined,
  minLength: number,
): { text: string; exhausted: boolean } {
  if (minLength > RANDOM_REASON_LENGTH) {
    return { text: randomTenLetters(), exhausted: true };
  }
  const usedSet = new Set((used ?? []).map((item) => item.trim()));
  let last = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    last = randomTenLetters();
    if (!usedSet.has(last)) return { text: last, exhausted: false };
  }
  return { text: last || randomTenLetters(), exhausted: true };
}
