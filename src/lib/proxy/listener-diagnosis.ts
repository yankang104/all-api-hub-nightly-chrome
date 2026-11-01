/**
 * 把「端口测活失败」翻译成用户能直接照做的结论。
 *
 * 为什么需要:多出口模式下粘错了 Script(或压根没粘)时,44 个端口会一起失败,
 * 而失败信息只有「超时」或「无法连接」—— 用户看到的是「节点全坏了」,
 * 完全想不到真实原因是「Clash Verge 当前激活的不是飞鸟云」或「脚本没生效」。
 *
 * 真机实测的三种形态(见实现注释里的探针结果):
 *  - 端口**没有监听**   → fetch 直接失败,几乎瞬间返回(ECONNREFUSED)
 *  - 端口有监听但节点名对不上 → TCP 能连上,HTTP 层会给出响应(哪怕 400)
 *  - 端口有监听且节点正常 → 正常连通
 *
 * 所以「能不能连上端口」这一个信号就足以把三类原因分开,不需要读内核配置
 * (扩展对 Clash Verge 保持零写入、也不读它的文件)。
 */

export type ListenerProbe = 'listening' | 'closed' | 'unknown';

export interface ProxyTestOutcome {
  ok: boolean;
  message: string;
}

export type ListenerDiagnosisKind =
  /** 全部正常 */
  | 'ok'
  /** 端口没人监听:脚本没粘/没重载/被订阅更新冲掉 */
  | 'listener-missing'
  /** 端口在监听但全部失败:极可能是当前激活的订阅与脚本里的节点名对不上 */
  | 'node-mismatch'
  /** 部分通:订阅里确实有坏节点,或者部分节点名对不上 */
  | 'partial'
  /** 池子里没有本机端口条目(压根没走 listeners 模式) */
  | 'no-local-ports';

export interface ListenerDiagnosis {
  kind: ListenerDiagnosisKind;
  /** 一句话结论 */
  title: string;
  /** 该怎么办(可空) */
  hint?: string;
  /** 通过的端口数 */
  passed: number;
  /** 总数 */
  total: number;
}

/**
 * 汇总一次「测活 + 端口监听探测」的结果。
 *
 * @param results 每个池内本机端口的一组 { probe, test }
 */
export function diagnoseListenerFailures(
  results: readonly { port: number; probe: ListenerProbe; test: ProxyTestOutcome }[],
): ListenerDiagnosis {
  const total = results.length;
  if (!total) {
    return {
      kind: 'no-local-ports',
      title: '代理池里没有本机端口条目',
      hint: '先在导入页粘贴订阅并生成 listeners 配置。',
      passed: 0,
      total: 0,
    };
  }

  const passed = results.filter((item) => item.test.ok).length;
  if (passed === total) {
    return { kind: 'ok', title: `${total} 个端口全部连通`, passed, total };
  }

  const closed = results.filter((item) => item.probe === 'closed');
  const failedListening = results.filter((item) => item.probe === 'listening' && !item.test.ok);

  /*
   * 判据必须要求**全军覆没**,不能只看「失败的那批」。
   *
   * 反例(测试抓到的真实 bug):5 个端口里通了 1 个、另外 4 个没人监听。
   * 若只看失败项,会得出「端口没有任何程序监听 → 脚本没生效」—— 但既然有
   * 一个通了,脚本显然是在工作的。所以先看 passed:
   *   1) 一个都没通 且 全部确认无监听 → 脚本这一层的问题(最外层、最常见)
   *   2) 一个都没通 且 全都在监听   → 端口通了,是节点名/节点本身的问题
   *   3) 其余(部分通过 / 探测不可用)→ 如实说,不硬套结论
   */
  if (passed === 0 && closed.length === total) {
    return {
      kind: 'listener-missing',
      title: `${total} 个端口没有一个在监听`,
      hint: '说明 Clash Verge 还没用上这份配置:确认已「复制自动更新脚本」并且粘进了对应订阅的扩展配置 → Script,然后重载内核。若刚重载过,再等几秒。',
      passed,
      total,
    };
  }

  if (passed === 0 && failedListening.length === total) {
    return {
      kind: 'node-mismatch',
      title: `${total} 个端口都在监听,但全部连不通`,
      hint: '端口本身是好的,失败在节点这一层。最常见的原因是 Clash Verge 当前激活的订阅不是生成脚本时用的那一份(节点名对不上会被内核拒绝),或这些节点确实已失效。先在「全部节点」逐个测活,并确认 Verge 里激活的是飞鸟云订阅。',
      passed,
      total,
    };
  }

  const missingPart = closed.length ? `${closed.length} 个端口没人监听` : '';
  const deadPart = failedListening.length ? `${failedListening.length} 个端口在监听但连不通` : '';
  const unknownPart = total - passed - closed.length - failedListening.length;
  return {
    kind: 'partial',
    title: `${passed}/${total} 个端口连通`,
    hint: [
      missingPart && `${missingPart}(脚本可能只生效了一部分,重载一次内核试试)`,
      deadPart && `${deadPart}(节点失效或名字对不上)`,
      unknownPart > 0 && `${unknownPart} 个非本机端口无法用这种方式判断`,
    ].filter(Boolean).join(';') || '对失败项逐个排查。',
    passed,
    total,
  };
}
