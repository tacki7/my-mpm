// How busy a machine is, for the meters at the top of the page (src/app/machineStats.ts): the CPU's use over the
// last interval (from os.cpus' tick counts), the memory in use, and each GPU's use and memory. Read every
// `every` ms in the background, so a request gets the latest reading at once.
//   Windows: GPUs from nvidia-smi (an NVIDIA card; other GPUs are not listed)
//   macOS:   the memory in use as Activity Monitor counts it (vm_stat: active + wired + compressed; os.freemem
//            counts the file cache as used), the GPU's use from the IOAccelerator's statistics (ioreg)
//   Linux:   nvidia-smi where there is one
import os from 'node:os';
import { execFile } from 'node:child_process';

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? null : String(out))));

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

async function nvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return [];
  return out
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [name, util, used, total] = line.split(',').map((s) => s.trim());
      return { name, util: Number(util), memUsed: Number(used) * 2 ** 20, memTotal: Number(total) * 2 ** 20 };
    })
    .filter((g) => g.name);
}

async function macGpu() {
  const out = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
  if (!out) return [];
  const util = /"Device Utilization %"=(\d+)/.exec(out);
  const mem = /"In use system memory"=(\d+)/.exec(out);
  const model = /"model"\s*=\s*"([^"]+)"/.exec(out) ?? /"IOGLBundleName"\s*=\s*"([^"]+)"/.exec(out);
  if (!util) return [];
  // Apple silicon: the GPU's memory is the machine's (unified), so it has no total of its own
  return [{ name: model ? model[1] : 'GPU', util: Number(util[1]), memUsed: mem ? Number(mem[1]) : null, memTotal: null }];
}

async function macMemUsed() {
  const out = await run('vm_stat', []);
  if (!out) return null;
  const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384);
  const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  return (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
}

/** a reader of this machine's use: `latest()` the last reading (null before the first), `stop()` */
export function machineStats(every = 1000) {
  let prev = cpuTimes();
  let latest = null;
  let busy = false;
  const read = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = cpuTimes();
      const dt = now.total - prev.total;
      const cpu = dt > 0 ? 100 * (1 - (now.idle - prev.idle) / dt) : 0;
      prev = now;
      const mac = process.platform === 'darwin';
      const [gpus, macUsed] = await Promise.all([mac ? macGpu() : nvidia(), mac ? macMemUsed() : null]);
      const total = os.totalmem();
      latest = {
        host: os.hostname(),
        platform: process.platform,
        cores: os.cpus().length,
        cpu: Math.max(0, Math.min(100, cpu)),
        memUsed: macUsed ?? total - os.freemem(),
        memTotal: total,
        gpus,
        at: Date.now(),
      };
    } finally {
      busy = false;
    }
  };
  void read();
  const timer = setInterval(read, every);
  timer.unref?.();
  return { latest: () => latest, stop: () => clearInterval(timer) };
}
