/** Serialize companion speech behind any active chat speech. */
export class CompanionSpeechQueue {
  private readonly pending: string[] = [];
  private cloneBusy = false;
  private localBusy = false;
  private scheduled = false;
  private disposed = false;

  constructor(private readonly speak: (text: string) => boolean, private readonly unavailable: () => void) {}

  enqueue(text: string): void {
    if (this.disposed || !text.trim()) return;
    this.pending.push(text);
    this.schedule();
  }

  setState(source: 'clone' | 'local', state: 'preparing' | 'speaking' | 'idle' | 'error'): void {
    const busy = state === 'preparing' || state === 'speaking';
    if (source === 'clone') this.cloneBusy = busy;
    else this.localBusy = busy;
    if (!busy) this.schedule();
  }

  clear(): void { this.pending.length = 0; }
  dispose(): void { this.disposed = true; this.clear(); }

  private schedule(): void {
    if (this.disposed || this.scheduled || !this.pending.length) return;
    this.scheduled = true;
    // speak() emits idle synchronously before preparing. Defer to avoid re-entry.
    setImmediate(() => {
      this.scheduled = false;
      if (this.disposed || this.cloneBusy || this.localBusy) return;
      const text = this.pending.shift();
      if (!text) return;
      try {
        if (!this.speak(text)) {
          this.unavailable();
          this.schedule();
        }
      } catch (error) {
        console.warn('[companion] clone speech failed:', (error as Error).message);
        this.unavailable();
        this.schedule();
      }
    });
  }
}
