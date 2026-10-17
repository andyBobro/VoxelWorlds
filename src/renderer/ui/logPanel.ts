import { $ } from './dom';

export type LogLevel = 'info' | 'warn' | 'err';

export class LogPanel {
  private el = $('log');

  add(text: string, level: LogLevel = 'info'): void {
    const line = document.createElement('div');
    line.className = `l-${level}`;
    line.textContent = text;
    this.el.appendChild(line);
    while (this.el.childElementCount > 500) this.el.firstElementChild?.remove();
    this.el.scrollTop = this.el.scrollHeight;
  }
}
