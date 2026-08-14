export interface AdapterInput {
  prompt: string;
  cwd: string;
  maxTurns?: number;
  timeoutSec: number;
}

export interface AdapterOutput {
  ok: boolean;
  text: string;
  costUsd: number;
  raw: unknown;
  error: string | null;
}

export interface Adapter {
  name: string;
  run(input: AdapterInput): Promise<AdapterOutput>;
}
