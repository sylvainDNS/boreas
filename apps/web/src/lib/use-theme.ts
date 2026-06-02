import { useCallback, useState } from "react";
import {
  getStoredPreference,
  setPreference,
  type ThemePreference,
} from "./theme";

/** Expose la préférence de thème et un setter qui persiste + applique. */
export function useTheme() {
  const [preference, setPref] = useState<ThemePreference>(getStoredPreference);

  const set = useCallback((pref: ThemePreference) => {
    setPreference(pref);
    setPref(pref);
  }, []);

  return { preference, setPreference: set };
}
