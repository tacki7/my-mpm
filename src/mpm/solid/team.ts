// A team of workers stepping one Sim3 together on a machine's cores (the CPU's 「コア数」 on the 3 次元 tab).
//
// The state lives on SharedArrayBuffers (Sim3Options.shared). The coordinator is the thread that owns the Sim3
// and reads it (the app's solid.worker, or tools/solid.mjs); it steps its own share as rank 0. The others are
// workers (browser Workers or node worker_threads) that attach a Sim3 of their own to the same arrays
// (Sim3Options.attach) and run the stages of a step over their columns of the grid (sim3.ts runPhase; the
// columns from the coordinator's partition, by the points' base cell column). Between the stages the team waits
// at a barrier on an Int32Array: the coordinator bumps the generation and the workers wake (Atomics.wait), run
// the stage, and count themselves done (Atomics.notify). Nothing is posted during a step; messages carry only the
// buffers when a Sim3 is attached (a new stand of a tandem). While attaching, the workers are out of the barrier
// loop (they must be at their event loop to receive the message), so the coordinator asks them out first.
//
// The runtime's Worker is behind a small port (postMessage, onmessage, terminate): src/app/solid.helper.worker.ts
// and tools/lib/solid-helper.mjs are the two entries, both calling runWorker() with the runtime's port.
import { Sim3, type Sim3Buffers, type Solid3Params, type TeamSums } from './sim3.ts';
import { makeGrid3, grid3Buffers, f64, PHASES, PT_COUNT, PT_FIRST } from './grid3.ts';

/** the barrier block: the generation the workers wait on, the phase to run (or LEAVE), and how many are done */
const B_GEN = 0;
const B_PHASE = 1;
const B_DONE = 2;
/** set by a worker whose stage threw (the coordinator's wait then throws instead of going on with a half step) */
const B_ERR = 3;
/** the phase that sends the workers back to their event loop (an attach follows) */
const PH_LEAVE = -1;


export interface TeamPort {
  postMessage(msg: unknown): void;
  onmessage: ((msg: unknown) => void) | null;
  terminate(): void;
}

export type TeamMessage =
  | { type: 'attach'; params: Solid3Params; buffers: Sim3Buffers; rank: number; size: number; barrier: SharedArrayBuffer }
  | { type: 'ready' }
  | { type: 'error'; message: string };

/** the coordinator's side */
export interface TeamOptions {
  /**
   * debug: the workers' shares run in the coordinator's thread, one rank after another, on Sim3s attached to the
   * same buffers (the workers idle). Deterministic: a stage that depends on another worker's work in the same stage
   * (a race when threaded) then shows as a fixed difference from the thread alone
   */
  serial?: boolean;
}

export class Team {
  readonly size: number;
  readonly serial: boolean;
  private readonly ports: TeamPort[];
  private readonly barrier: Int32Array;
  private sim: Sim3 | null = null;
  private sums: TeamSums[] = [];
  private inThread: Sim3[] = [];
  /** the workers are in the barrier loop (else at their event loop, waiting for an attach) */
  private inLoop = false;
  private closed = false;

  /** `spawn(rank)` makes the runtime's worker for a rank of 1 .. size − 1 */
  constructor(size: number, spawn: (rank: number) => TeamPort, opts: TeamOptions = {}) {
    if (!(Number.isInteger(size) && size >= 2)) throw new Error('a team has at least two workers');
    if (typeof SharedArrayBuffer === 'undefined') throw new Error('SharedArrayBuffer is not available here');
    this.size = size;
    this.serial = opts.serial === true;
    this.barrier = new Int32Array(new SharedArrayBuffer(32));
    this.ports = [];
    for (let r = 1; r < size; r++) this.ports.push(spawn(r));
  }

  /**
   * The Sim3 the team steps from now on (made with `{ shared: true, size }`): its buffers, a copy of the grid and
   * blocks of sums for every worker, sent to them; resolves when they have attached. The one before is let go.
   */
  async attach(sim: Sim3): Promise<void> {
    if (this.closed) throw new Error('the team is closed');
    if (sim.size !== this.size || sim.rank !== 0) throw new Error(`the Sim3 was not made for a team of ${this.size}`);
    if (this.inLoop) this.leave();
    this.sim = sim;
    const base = sim.shareBuffers();
    const NN = sim.nodeCount;
    const nz = sim.nzN;
    const nMap = sim.nBinsX * sim.nzN;
    let left = sim.ownGridBuffers();
    this.sums = [];
    this.inThread = [];
    const waits: Promise<void>[] = [];
    for (let r = 1; r < this.size; r++) {
      const own = makeGrid3(NN, true);
      const part = f64(PT_COUNT, true);
      part[PT_FIRST] = -1;
      const accFz = f64(nz, true);
      const accMap = f64(nMap, true);
      const stepFz = f64(nz, true);
      this.sums.push({ part, accFz, accMap, stepFz });
      const buffers: Sim3Buffers = { ...base, own: grid3Buffers(own), left, part: part.buffer, accFz: accFz.buffer, accMap: accMap.buffer, stepFz: stepFz.buffer };
      left = grid3Buffers(own);
      const port = this.ports[r - 1];
      waits.push(
        new Promise<void>((resolve, reject) => {
          port.onmessage = (m) => {
            const msg = m as TeamMessage;
            if (msg.type === 'ready') resolve();
            else if (msg.type === 'error') reject(new Error(msg.message));
          };
        }),
      );
      const msg: TeamMessage = { type: 'attach', params: sim.params, buffers, rank: r, size: this.size, barrier: this.barrier.buffer as SharedArrayBuffer };
      port.postMessage(msg);
      if (this.serial) this.inThread.push(new Sim3(sim.params, { attach: buffers, rank: r, size: this.size }));
    }
    await Promise.all(waits);
    for (const port of this.ports) port.onmessage = null;
    this.inLoop = true;
  }

  /** one step of the attached Sim3 by the whole team (Sim3.advance alone) */
  step(): void {
    const sim = this.sim;
    if (!sim || !this.inLoop) throw new Error('no Sim3 is attached to the team');
    sim.beginStep();
    const parts = this.sums.map((s) => s.part);
    for (let ph = 0; ph < PHASES; ph++) {
      if (this.serial) {
        sim.runPhase(ph);
        for (const w of this.inThread) w.runPhase(ph);
      } else {
        this.launch(ph);
        sim.runPhase(ph);
        this.waitAll();
      }
      sim.afterPhase(ph, parts);
    }
    sim.finishStep(this.sums);
  }

  private launch(ph: number): void {
    const b = this.barrier;
    Atomics.store(b, B_DONE, 0);
    Atomics.store(b, B_PHASE, ph);
    Atomics.add(b, B_GEN, 1);
    Atomics.notify(b, B_GEN);
  }

  private waitAll(): void {
    const b = this.barrier;
    const want = this.size - 1;
    for (;;) {
      const done = Atomics.load(b, B_DONE);
      if (Atomics.load(b, B_ERR)) {
        this.inLoop = false;
        throw new Error(`a worker of the team failed in stage ${Atomics.load(b, B_PHASE)}`);
      }
      if (done >= want) return;
      Atomics.wait(b, B_DONE, done);
    }
  }

  /** the workers out of the barrier loop, back at their event loop */
  private leave(): void {
    this.launch(PH_LEAVE);
    this.waitAll();
    this.inLoop = false;
  }

  /** the workers ended; the Sim3 is left as it is */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const port of this.ports) port.terminate();
    this.sim = null;
  }
}

/**
 * A worker's side, on the runtime's port to the coordinator: attaches a Sim3 to the buffers of each 'attach'
 * message, says it is ready, and runs the stages the barrier asks for until asked to leave.
 */
export function runWorker(port: TeamPort): void {
  port.onmessage = (m) => {
    const msg = m as TeamMessage;
    if (msg.type !== 'attach') return;
    try {
      const sim = new Sim3(msg.params, { attach: msg.buffers, rank: msg.rank, size: msg.size });
      const b = new Int32Array(msg.barrier);
      port.postMessage({ type: 'ready' } satisfies TeamMessage);
      let seen = Atomics.load(b, B_GEN);
      for (;;) {
        Atomics.wait(b, B_GEN, seen);
        seen = Atomics.load(b, B_GEN);
        const ph = Atomics.load(b, B_PHASE);
        if (ph === PH_LEAVE) {
          Atomics.add(b, B_DONE, 1);
          Atomics.notify(b, B_DONE);
          return;
        }
        sim.runPhase(ph);
        Atomics.add(b, B_DONE, 1);
        Atomics.notify(b, B_DONE);
      }
    } catch (err) {
      const b = new Int32Array(msg.barrier);
      Atomics.store(b, B_ERR, 1);
      Atomics.add(b, B_DONE, 1);
      Atomics.notify(b, B_DONE);
      port.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) } satisfies TeamMessage);
    }
  };
}
