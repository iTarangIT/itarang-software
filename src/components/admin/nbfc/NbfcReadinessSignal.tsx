"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Ctx = {
  version: number;
  bump: () => void;
};

const NbfcReadinessSignalContext = createContext<Ctx>({
  version: 0,
  bump: () => {},
});

export function NbfcReadinessSignalProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ version, bump }), [version, bump]);
  return (
    <NbfcReadinessSignalContext.Provider value={value}>
      {children}
    </NbfcReadinessSignalContext.Provider>
  );
}

export function useNbfcReadinessSignal(): Ctx {
  return useContext(NbfcReadinessSignalContext);
}
