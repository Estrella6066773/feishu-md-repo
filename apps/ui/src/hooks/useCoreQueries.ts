import { useQuery } from '@tanstack/react-query';
import { fetchBindings, fetchHealth, fetchSettings } from '@/lib/queries';
import { queryKeys } from './queryKeys';

export function useHealthQuery(refetchInterval = 15_000) {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: fetchHealth,
    retry: 1,
    refetchInterval,
  });
}

export function useSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: fetchSettings,
  });
}

export function useBindingsQuery() {
  return useQuery({
    queryKey: queryKeys.bindings,
    queryFn: fetchBindings,
  });
}

export function useServiceOnline(health: ReturnType<typeof useHealthQuery>) {
  return !health.isError && health.data?.ok === true;
}
