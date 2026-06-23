export class JsonLineBuffer {
  private buffer = '';

  constructor(private readonly onEntry: (entry: any) => void) {}

  public push(text: string): void {
    this.buffer += text;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.onEntry(JSON.parse(line));
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }
}
