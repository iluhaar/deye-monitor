import { useCallback, useEffect, useRef, useState } from "react";
import { configurationIssue, refreshTelemetry } from "./api";
import type { Telemetry } from "./api";

type Operation = "loading" | "refreshing" | null;

export function useTelemetry() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [operation, setOperation] = useState<Operation>(() =>
    configurationIssue(true) ? null : "loading",
  );
  const [error, setError] = useState<string | null>(() => configurationIssue(true));
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const refreshIssue = configurationIssue(true);

  const refresh = useCallback(async (alongside?: () => Promise<void>) => {
    if (busy.current) {
      return;
    }
    setNotice(null);
    const issue = configurationIssue(true);
    if (issue) {
      setError(issue);
      return;
    }

    busy.current = true;
    setOperation("refreshing");
    setError(null);
    const alongsidePromise = alongside?.() ?? Promise.resolve();

    try {
      const result = await refreshTelemetry();
      setTelemetry(result.telemetry);
      setNotice(result.warning);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "Unable to refresh inverter data.");
    } finally {
      await alongsidePromise;
      setOperation(null);
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (configurationIssue(true)) {
      return;
    }
    let active = true;
    busy.current = true;

    void refreshTelemetry()
      .then(
        (result) => {
          if (active) {
            setTelemetry(result.telemetry);
            setNotice(result.warning);
            setError(null);
          }
        },
        (error_: unknown) => {
          if (active) {
            setError(error_ instanceof Error ? error_.message : "Unable to read inverter data.");
          }
        },
      )
      .finally(() => {
        if (active) {
          setOperation(null);
          busy.current = false;
        }
      });

    return () => {
      active = false;
      busy.current = false;
    };
  }, []);

  return { telemetry, operation, error, notice, refreshIssue, refresh };
}
