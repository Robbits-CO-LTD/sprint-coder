import { createContext } from 'react';

/** The Task whose transcript is being rendered; inline graph anchors open that Task's graph panel. */
export const GraphTaskContext = createContext<string | null>(null);
