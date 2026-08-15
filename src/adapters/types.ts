export interface AdapterInput {
  prompt: string;
  cwd: string;
  maxTurns?: number;
  /** Model id passed straight to the CLI. Undefined leaves the CLI's own resolution alone. */
  model?: string;
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
