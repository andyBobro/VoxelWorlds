import type { ExportFormat } from '../../shared/contract';
import { $, errorText } from './dom';

const FORMATS: ExportFormat[] = ['vox', 'schem', 'json'];

export class ExportPanel {
  private buttons = new Map<ExportFormat, HTMLButtonElement>();
  private status = $('export-status');
  private enabled = false;
  private busy = false;

  constructor(private run: (format: ExportFormat) => Promise<{ outputPath: string } | null>) {
    for (const f of FORMATS) {
      const b = $<HTMLButtonElement>(`export-${f}`);
      b.addEventListener('click', () => void this.export(f));
      this.buttons.set(f, b);
    }
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.sync();
  }

  private sync(): void {
    for (const b of this.buttons.values()) {
      b.disabled = !this.enabled || this.busy;
      b.title = b.disabled ? (this.busy ? 'An export is running' : 'Generate or open a world first') : '';
    }
  }

  private async export(f: ExportFormat): Promise<void> {
    this.busy = true;
    this.sync();
    this.status.textContent = `Exporting .${f}...`;
    try {
      const res = await this.run(f);
      this.status.textContent = res ? `Saved ${res.outputPath}` : 'Export cancelled.';
    } catch (e) {
      this.status.textContent = `Export failed: ${errorText(e)}`;
    } finally {
      this.busy = false;
      this.sync();
    }
  }
}
