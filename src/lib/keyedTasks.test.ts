import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyedDebouncer, KeyedSerialTaskQueue } from "./keyedTasks";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("KeyedSerialTaskQueue", () => {
  it("runs same-key tasks in call order and continues after a rejection", async () => {
    const queue = new KeyedSerialTaskQueue<string>();
    const first = deferred<void>();
    const second = deferred<void>();
    const events: string[] = [];
    const failure = new Error("save failed");

    const firstRun = queue.run("note", async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
    });
    const secondRun = queue.run("note", async () => {
      events.push("second:start");
      await second.promise;
      events.push("second:end");
    });

    expect(queue.isBusy("note")).toBe(true);
    await flushPromises();
    expect(events).toEqual(["first:start"]);

    first.reject(failure);
    await expect(firstRun).rejects.toBe(failure);
    await flushPromises();

    expect(events).toEqual(["first:start", "second:start"]);
    expect(queue.isBusy("note")).toBe(true);

    second.resolve(undefined);
    await secondRun;
    await flushPromises();

    expect(events).toEqual(["first:start", "second:start", "second:end"]);
    expect(queue.isBusy("note")).toBe(false);
  });

  it("allows different keys to run independently", async () => {
    const queue = new KeyedSerialTaskQueue<string>();
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];

    const firstRun = queue.run("first", async () => {
      started.push("first");
      await first.promise;
    });
    const secondRun = queue.run("second", async () => {
      started.push("second");
      await second.promise;
    });

    await flushPromises();
    expect(started).toEqual(["first", "second"]);
    expect(queue.isBusy("first")).toBe(true);
    expect(queue.isBusy("second")).toBe(true);

    first.resolve(undefined);
    await firstRun;
    await flushPromises();
    expect(queue.isBusy("first")).toBe(false);
    expect(queue.isBusy("second")).toBe(true);

    second.resolve(undefined);
    await secondRun;
    await flushPromises();
    expect(queue.isBusy("second")).toBe(false);
  });
});

describe("KeyedDebouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces each key independently and replaces only the same key", () => {
    const debouncer = new KeyedDebouncer<string>();
    const original = vi.fn();
    const replacement = vi.fn();
    const other = vi.fn();

    debouncer.schedule("note", 50, original);
    debouncer.schedule("other", 25, other);
    vi.advanceTimersByTime(10);
    debouncer.schedule("note", 50, replacement);

    vi.advanceTimersByTime(15);
    expect(other).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();

    vi.advanceTimersByTime(35);
    expect(original).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("cancels one key without affecting another", () => {
    const debouncer = new KeyedDebouncer<string>();
    const cancelled = vi.fn();
    const remaining = vi.fn();

    debouncer.schedule("cancelled", 10, cancelled);
    debouncer.schedule("remaining", 10, remaining);
    debouncer.cancel("cancelled");
    vi.runAllTimers();

    expect(cancelled).not.toHaveBeenCalled();
    expect(remaining).toHaveBeenCalledOnce();
  });

  it("takes all pending keys and cancels their timers", () => {
    const debouncer = new KeyedDebouncer<string>();
    const first = vi.fn();
    const second = vi.fn();

    debouncer.schedule("first", 10, first);
    debouncer.schedule("second", 20, second);

    expect(debouncer.takePendingKeys()).toEqual(["first", "second"]);
    expect(debouncer.takePendingKeys()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    vi.runAllTimers();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("cancels every pending key", () => {
    const debouncer = new KeyedDebouncer<string>();
    const callback = vi.fn();

    debouncer.schedule("first", 10, callback);
    debouncer.schedule("second", 20, callback);
    debouncer.cancelAll();
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
