import { LearningCapture } from './learning';
import type { LearningKind, WorkflowLearningEvent } from '@/types';

/** 跟踪已发出的安全事件；结束学习前必须等后台确认落盘，不能 fire-and-forget。 */
export function createLearningRecorder(
  kind: LearningKind,
  send: (event: WorkflowLearningEvent) => Promise<{ ok: boolean; error?: string }>,
  personalTexts?: readonly string[],
) {
  const pending = new Set<Promise<void>>();
  let failure: string | undefined;
  const capture = new LearningCapture({
    kind,
    personalTexts,
    onEvent(event) {
      const sent = send(event).then((result) => {
        if (!result.ok) failure ??= result.error ?? '学习事件未保存';
      }, (error: unknown) => {
        failure ??= error instanceof Error ? error.message : String(error);
      });
      pending.add(sent);
      void sent.then(() => pending.delete(sent));
    },
  });
  return {
    start: () => capture.attach(),
    stop: () => capture.detach(),
    async flush(): Promise<{ challengeSeen: boolean; unlearnedNotes: readonly string[] }> {
      capture.flushPending();
      while (pending.size) await Promise.all([...pending]);
      if (failure) throw new Error(failure);
      // 只回传布尔与固定文案：验证码字段出现过、哪些动作有意没学；
      // 字段名/选择器/值/页面正文一律不带回。
      return { challengeSeen: capture.sawChallengeField, unlearnedNotes: capture.unlearnedNotes };
    },
  };
}
