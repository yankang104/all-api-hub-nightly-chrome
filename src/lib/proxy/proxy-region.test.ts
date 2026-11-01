import { describe, expect, it } from 'vitest';
import { detectRegion, groupByRegion, UNKNOWN_REGION } from '@/lib/proxy/proxy-region';

describe('detectRegion', () => {
  /** 用户订阅里的真实节点名形态 */
  it('认出中文国家名，忽略后缀标记', () => {
    const cases: [string, string][] = [
      ['香港HKT-A', '香港'],
      ['香港HK-HY2', '香港'],
      ['香港-优化3-Gemini', '香港'],
      ['日本JP-HY2', '日本'],
      ['日本-优化2', '日本'],
      ['新加坡SG-A-Gemini', '新加坡'],
      ['新加坡01aws', '新加坡'],
      ['美国USLA-A', '美国'],
      ['美国LA-优化-GPT', '美国'],
      ['台湾-优化2-GPT', '台湾'],
      ['韩国KR-HY2', '韩国'],
      ['印度-优化', '印度'],
      ['加拿大-优化3', '加拿大'],
      ['法国FR-A', '法国'],
      ['德国-优化2', '德国'],
      ['英国-优化-GPT', '英国'],
      ['越南VN-A', '越南'],
      ['俄罗斯RU-A', '俄罗斯'],
      ['乌克兰UA-A', '乌克兰'],
      ['土耳其TR-A', '土耳其'],
      ['尼日利亚NG-A', '尼日利亚'],
    ];

    for (const [name, label] of cases) {
      expect(detectRegion(name).label, name).toBe(label);
    }
  });

  it('认出繁体写法', () => {
    expect(detectRegion('台灣-優化').label).toBe('台湾');
    expect(detectRegion('韓國KR').label).toBe('韩国');
  });

  it('没有中文名时回落国家代码', () => {
    expect(detectRegion('JP-Premium-01').label).toBe('日本');
    expect(detectRegion('HK-IEPL-02').label).toBe('香港');
  });

  it('认不出的归入未识别，而不是硬塞进某个国家', () => {
    expect(detectRegion('套餐到期: 长期有效').key).toBe(UNKNOWN_REGION.key);
    expect(detectRegion('').key).toBe(UNKNOWN_REGION.key);
    expect(detectRegion('自动选择').key).toBe(UNKNOWN_REGION.key);
  });

  /**
   * 中文名必须赢过代码：'美国LA-优化' 同时能被美国的中文规则和 LA 代码命中，
   * 而某些名字里的两字母组合是巧合，先跑中文能避免整组被归错。
   */
  it('中文名优先于国家代码', () => {
    expect(detectRegion('日本-中转-US线路').label).toBe('日本');
  });
});

describe('groupByRegion', () => {
  const names = [
    '香港HKT-A', '日本JP-HY2', '香港HK-HY2', '套餐到期: 长期有效',
    '日本-优化', '日本-优化2', '美国USLA-A',
  ];

  it('按地区归组，节点多的地区排前面，未识别垫底', () => {
    const groups = groupByRegion(names, (name) => name);

    expect(groups.map((group) => `${group.label}:${group.items.length}`)).toEqual([
      '日本:3', '香港:2', '美国:1', '未识别:1',
    ]);
  });

  it('组内保持传入顺序，避免每次渲染对应关系漂移', () => {
    const groups = groupByRegion(names, (name) => name);
    const japan = groups.find((group) => group.label === '日本');

    expect(japan?.items).toEqual(['日本JP-HY2', '日本-优化', '日本-优化2']);
  });

  it('空列表返回空分组', () => {
    expect(groupByRegion([], (name: string) => name)).toEqual([]);
  });
});
