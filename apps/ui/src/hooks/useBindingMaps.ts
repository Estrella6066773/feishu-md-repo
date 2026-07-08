import { useMemo } from 'react';
import type { Binding, SyncLogEntry } from '@feishu-md/shared';

export function useBindingNameMap(bindings: Binding[] | undefined) {
  return useMemo(
    () => new Map((bindings ?? []).map((binding) => [binding.id, binding.name])),
    [bindings],
  );
}

export function useLatestLogByBinding(logs: SyncLogEntry[] | undefined) {
  return useMemo(() => {
    const map = new Map<string, SyncLogEntry>();
    const sorted = [...(logs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const log of sorted) {
      if (!map.has(log.bindingId)) {
        map.set(log.bindingId, log);
      }
    }
    return map;
  }, [logs]);
}
