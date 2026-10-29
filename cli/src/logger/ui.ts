import type { ErrorMessage } from '../../../shared/protocol.js';
import type { RequestLog } from '../tunnel/LocalForwarder.js';
import { formatBytes, formatDuration, truncate } from '../utils/format.js';
import { c } from './colors.js';

type Out = { write(text: string): unknown; columns?: number };

const RULE_WIDTH = 46;

/** Everything the CLI prints goes through here. */
export class Ui {
  private printedHeader = false;

  constructor(
    private readonly out: Out = process.stdout,
    private readonly debugMode = false,
  ) {}

  private line(text = ''): void {
    this.out.write(text + '\n');
  }

  private rule(): void {
    this.line('  ' + c.gray('─'.repeat(RULE_WIDTH)));
  }

  banner(): void {
    const inner = RULE_WIDTH - 2;
    const center = (text: string) => {
      const left = Math.floor((inner - text.length) / 2);
      return ' '.repeat(left) + text + ' '.repeat(inner - text.length - left);
    };
    this.line();
    this.line('  ' + c.gray('╭' + '─'.repeat(inner) + '╮'));
    this.line('  ' + c.gray('│') + c.bold(center('Tunnelly')) + c.gray('│'));
    this.line('  ' + c.gray('│') + c.dim(center('Simple localhost tunneling')) + c.gray('│'));
    this.line('  ' + c.gray('╰' + '─'.repeat(inner) + '╯'));
    this.line();
  }

  connecting(serverUrl: string, version: string): void {
    this.line(c.dim(`  Connecting to ${serverUrl} …  (v${version})`));
  }

  connected(info: { localUrl: string; publicUrl: string; firstConnect: boolean; resumed: boolean; urlChanged: boolean }): void {
    if (info.firstConnect) {
      this.line();
      this.line(`  ${c.green('✓')} Connected to Tunnelly`);
      this.line();
      this.line(`  ${c.dim('Local:')}   ${info.localUrl}`);
      this.line(`  ${c.dim('Public:')}  ${c.bold(c.cyan(info.publicUrl))}`);
      this.line();
      this.line(`  ${c.dim('Status:')}  ${c.green('●')} Connected`);
      this.line();
      this.line(c.dim('  Press Ctrl+C to stop'));
      this.line();
      this.rule();
      this.line();
      this.printedHeader = true;
      return;
    }
    this.line();
    if (info.urlChanged) {
      this.line(`  ${c.green('✓')} Reconnected ${c.yellow('with a new public URL')}`);
      this.line(`  ${c.dim('Public:')}  ${c.bold(c.cyan(info.publicUrl))}`);
    } else {
      this.line(`  ${c.green('●')} Reconnected  ${c.dim(info.publicUrl)}`);
    }
    this.line();
  }

  disconnected(reason: string): void {
    this.line();
    this.line(`  ${c.yellow('●')} Disconnected ${c.dim(`(${reason})`)}`);
  }

  reconnecting(info: { delayMs: number; everConnected: boolean; reason: string }): void {
    const seconds = Math.max(1, Math.round(info.delayMs / 1000));
    const unit = seconds === 1 ? 'second' : 'seconds';
    if (!info.everConnected) {
      this.line();
      this.line(`  ${c.red('✗')} Unable to connect to Tunnelly server.`);
      this.line(c.dim(`    ${info.reason}`));
      this.line(c.dim(`    Retrying in ${seconds} ${unit}...`));
      return;
    }
    this.line(`  ${c.yellow('●')} Reconnecting in ${seconds} ${unit}...${this.debugMode ? c.dim(` (${info.reason})`) : ''}`);
  }

  fatal(error: ErrorMessage): void {
    this.line();
    if (error.code === 'TUNNEL_ACTIVE') {
      this.line(`  ${c.red('✗')} ${error.message}`);
      if (error.publicUrl) {
        this.line();
        this.line(c.dim('  Public URL:'));
        this.line(`  ${error.publicUrl}`);
      }
      this.line();
      this.line('  Stop the existing tunnel before starting another one.');
    } else {
      this.line(`  ${c.red('✗')} ${error.message}`);
    }
    this.line();
  }

  error(title: string, ...details: string[]): void {
    this.line();
    this.line(`  ${c.red('✗')} ${title}`);
    if (details.length) this.line();
    for (const detail of details) this.line(`  ${detail}`);
    this.line();
  }

  debug(text: string): void {
    if (this.debugMode) this.line(c.dim(`  [debug] ${text}`));
  }

  /**  14:02:11  GET     /api/users                200    42ms    1.2 KB */
  request(log: RequestLog): void {
    if (!this.printedHeader) return;
    const time = new Date().toTimeString().slice(0, 8);
    const columns = this.out.columns ?? 100;
    const pathWidth = Math.max(16, Math.min(60, columns - 50));
    const status = String(log.status);
    const statusColor =
      log.status >= 500 ? c.red : log.status >= 400 ? c.yellow : log.status >= 300 ? c.cyan : c.green;

    let text =
      `  ${c.gray(time)}  ${c.bold(log.method.padEnd(7))} ${truncate(log.path, pathWidth).padEnd(pathWidth)} ` +
      `${statusColor(status.padStart(3))}  ${formatDuration(log.durationMs).padStart(6)}  ${c.dim(formatBytes(log.responseBytes).padStart(8))}`;
    if (log.error) text += '  ' + c.red(log.error);
    this.line(text);
  }

  stopping(): void {
    this.line();
    this.line(c.dim('  Stopping tunnel…'));
  }

  stopped(): void {
    this.line(`  ${c.green('✓')} Tunnel closed`);
    this.line();
  }
}
