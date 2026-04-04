export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private writeIndex = 0;
  private count = 0;

  constructor(public readonly capacity: number = 60) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.writeIndex;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  get length(): number {
    return this.count;
  }

  get latest(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.writeIndex - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.writeIndex = 0;
    this.count = 0;
  }
}
