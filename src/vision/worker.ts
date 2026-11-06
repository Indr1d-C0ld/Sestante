import { analyzePlate, type AnalysisInput, type AnalysisResult } from "./analyze.ts";

self.onmessage = (event: MessageEvent<{ id: number; input: AnalysisInput }>) => {
  const { id, input } = event.data;
  try {
    const result = analyzePlate(input);
    (self as unknown as Worker).postMessage({ id, result }, [result.classMap.buffer, result.gainMap.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: String(error) });
  }
};

export type WorkerReply = { id: number; result?: AnalysisResult; error?: string };
