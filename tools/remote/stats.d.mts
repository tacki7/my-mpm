// The types of stats.mjs, for vite.config.ts
export interface MachineReading {
  host: string;
  platform: string;
  cores: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  gpus: { name: string; util: number; memUsed: number | null; memTotal: number | null }[];
  at: number;
}
export function machineStats(every?: number): { latest: () => MachineReading | null; stop: () => void };
