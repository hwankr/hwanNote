type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export class KeyedSerialTaskQueue<K> {
  private readonly tails = new Map<K, Promise<void>>();

  isBusy(key: K): boolean {
    return this.tails.has(key);
  }

  run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }
}

export class KeyedDebouncer<K> {
  private readonly timers = new Map<K, TimerHandle>();

  schedule(key: K, delayMs: number, callback: () => void): void {
    this.cancel(key);

    const timer = globalThis.setTimeout(() => {
      if (this.timers.get(key) !== timer) {
        return;
      }

      this.timers.delete(key);
      callback();
    }, delayMs);

    this.timers.set(key, timer);
  }

  cancel(key: K): void {
    const timer = this.timers.get(key);
    if (timer === undefined) {
      return;
    }

    globalThis.clearTimeout(timer);
    this.timers.delete(key);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.timers.clear();
  }

  takePendingKeys(): K[] {
    const keys = [...this.timers.keys()];
    this.cancelAll();
    return keys;
  }
}
