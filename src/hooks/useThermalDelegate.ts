import { useEffect, useState } from "react";
import { getThermalDelegateInfo, type ThermalDelegateInfo } from "../lib/ipc";

export function useThermalDelegate() {
  const [info, setInfo] = useState<ThermalDelegateInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getThermalDelegateInfo()
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { info, loading };
}
