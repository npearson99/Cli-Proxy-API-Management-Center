import { describe, expect, test } from 'bun:test';
import { createFetchQueue } from '@/features/quota/fetchQueue';

/** Virtual clock: sleeps advance time instead of spending it. */
const harness = () => {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

/**
 * Virtual timers: a sleep wakes only when the test advances the clock, so slots
 * that overlap in time can be modelled — which the shared-advance harness above
 * cannot do.
 */
const timeline = () => {
  let clock = 0;
  let pending: { at: number; resolve: () => void }[] = [];
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };
  return {
    now: () => clock,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: clock + ms, resolve });
      }),
    settle,
    advanceTo: async (ms: number) => {
      clock = ms;
      for (;;) {
        const due = pending.filter((timer) => timer.at <= clock);
        if (due.length === 0) break;
        pending = pending.filter((timer) => timer.at > clock);
        due.forEach((timer) => timer.resolve());
        await settle();
      }
      await settle();
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('quota fetch queue', () => {
  test('never runs more than the concurrency at once', async () => {
    const clock = harness();
    const queue = createFetchQueue({ concurrency: 2, minGapMs: 0, ...clock });
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred<void>());

    const runs = gates.map((gate) =>
      queue.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      })
    );

    await Promise.resolve();
    expect(peak).toBe(2);

    gates.forEach((gate) => gate.resolve());
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  test('spaces starts by the minimum gap', async () => {
    // Concurrency 1, so no two waits overlap and the virtual clock stays a
    // faithful model: with several slots open the sleeps run concurrently in real
    // time, which a clock that advances on each sleep cannot represent.
    const clock = harness();
    const queue = createFetchQueue({ concurrency: 1, minGapMs: 400, ...clock });
    const starts: number[] = [];

    await Promise.all(
      Array.from({ length: 4 }, () =>
        queue.run(async () => {
          starts.push(clock.now());
        })
      )
    );

    expect(starts).toEqual([1_000_000, 1_000_400, 1_000_800, 1_001_200]);
  });

  test('measures the gap from the previous start, not from its completion', async () => {
    const clock = harness();
    const queue = createFetchQueue({ concurrency: 1, minGapMs: 400, ...clock });

    const first = await queue.run(async () => {
      const startedAt = clock.now();
      clock.advance(1_000); // a slow request, already longer than the gap
      return startedAt;
    });
    const second = await queue.run(async () => clock.now());

    expect(first).toBe(1_000_000);
    expect(second).toBe(1_001_000);
  });

  test('does not stall a start that is already past the gap', async () => {
    const clock = harness();
    const queue = createFetchQueue({ concurrency: 1, minGapMs: 400, ...clock });

    await queue.run(async () => {});
    clock.advance(5_000);
    const at = await queue.run(async () => clock.now());

    expect(at).toBe(1_005_000);
  });

  test('frees the slot when a task throws', async () => {
    const clock = harness();
    const queue = createFetchQueue({ concurrency: 1, minGapMs: 0, ...clock });

    await expect(queue.run(async () => Promise.reject(new Error('HTTP 429')))).rejects.toThrow(
      'HTTP 429'
    );
    expect(await queue.run(async () => 'served')).toBe('served');
  });

  test('hands a released slot to exactly one waiter', async () => {
    // A slot that is freed and re-taken rather than handed over can be claimed
    // twice: once by the waiter's microtask and once by a run() that lands first.
    const clock = harness();
    const queue = createFetchQueue({ concurrency: 1, minGapMs: 0, ...clock });
    let active = 0;
    let peak = 0;
    const gate = deferred<void>();

    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    };

    const first = queue.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    });
    const queued = queue.run(task);
    gate.resolve();
    const latecomer = queue.run(task);

    await Promise.all([first, queued, latecomer]);
    expect(peak).toBe(1);
  });

  test('spaces the starts of two slots, not just of one', async () => {
    // The gap is measured from the instant a start was *reserved*, not from the
    // last one to actually begin. Otherwise a slot released while another task
    // is waiting out the gap hands its successor that same wake-up instant, and
    // the two go on the wire together — the burst the gap exists to prevent.
    const tl = timeline();
    const queue = createFetchQueue({
      concurrency: 2,
      minGapMs: 400,
      now: tl.now,
      sleep: tl.sleep,
    });
    const starts: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const runs = gates.map((gate) =>
      queue.run(async () => {
        starts.push(tl.now());
        await gate.promise;
      })
    );

    await tl.settle();
    expect(starts).toEqual([0]);

    // The first task finishes inside the gap, so the third takes its slot early.
    await tl.advanceTo(50);
    gates[0].resolve();
    await tl.settle();

    await tl.advanceTo(400);
    expect(starts).toEqual([0, 400]);

    await tl.advanceTo(800);
    expect(starts).toEqual([0, 400, 800]);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
  });

  test('returns each task its own result, in the face of queueing', async () => {
    const clock = harness();
    const queue = createFetchQueue({ concurrency: 2, minGapMs: 10, ...clock });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => queue.run(async () => n * 2))
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});
