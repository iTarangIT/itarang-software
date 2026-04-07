import { useEffect, useState } from 'react';

/**
 * Small client-side debounce hook.
 * Example: const debounced = useDebounce(value, 250)
 */
export function useDebounce<T>(value: T, delayMs: number = 250): T {
    const [debounced, setDebounced] = useState<T>(value);

    useEffect(() => {
        const handle = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(handle);
    }, [value, delayMs]);

    return debounced;
}