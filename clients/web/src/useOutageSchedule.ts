import { useCallback, useEffect, useState } from "react";
import { readTodayOutageSchedule } from "./outage-schedule";
import type { TodayOutageSchedule } from "./outage-schedule";

function unavailableMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Today's outage schedule is unavailable.";
}

export function useOutageSchedule() {
  const [schedule, setSchedule] = useState<TodayOutageSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setSchedule(await readTodayOutageSchedule());
      setError(null);
    } catch (error_) {
      setError(unavailableMessage(error_));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void readTodayOutageSchedule()
      .then(
        (result) => {
          if (active) {
            setSchedule(result);
            setError(null);
          }
        },
        (error_: unknown) => {
          if (active) {
            setError(unavailableMessage(error_));
          }
        },
      )
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return { schedule, error, loading, reload };
}
