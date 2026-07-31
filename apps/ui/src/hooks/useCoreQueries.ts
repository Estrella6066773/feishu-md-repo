import { useQuery } from '@tanstack/react-query';
import { fetchBindings, fetchHealth, fetchSettings } from '@/lib/queries';
import { queryKeys } from './queryKeys';

const DEFAULT_REFRESH_INTERVAL = 3_000;

export function useHealthQuery(refetchInterval = DEFAULT_REFRESH_INTERVAL) {
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
    refetchInterval: DEFAULT_REFRESH_INTERVAL,
  });
}

export function useBindingsQuery() {
  return useQuery({
    queryKey: queryKeys.bindings,
    queryFn: fetchBindings,
    refetchInterval: DEFAULT_REFRESH_INTERVAL,
  });
}

export function useServiceOnline(health: ReturnType<typeof useHealthQuery>) {
  return !health.isError && health.data?.ok === true;
}
