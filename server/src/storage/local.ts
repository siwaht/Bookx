import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import type { StorageProvider } from './provider.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export class LocalStorageProvider implements StorageProvider {
  name = 'local';

  async write(key: string, data: Buffer): Promise<string> {
    const filePath = this.resolvePath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
    return filePath;
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFileSync(this.resolvePath(key));
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolvePath(key));
  }

  async size(key: string): Promise<number> {
    return fs.statSync(this.resolvePath(key)).size;
  }

  async createReadStream(key: string): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(this.resolvePath(key));
  }

  async testConnection(): Promise<{ connected: boolean; details?: Record<string, any> }> {
    const audioDir = path.join(DATA_DIR, 'audio');
    const writable = fs.existsSync(audioDir);
    return { connected: writable, details: { path: DATA_DIR } };
  }

  async disconnect(): Promise<void> {
    // no-op for local
  }

  private resolvePath(key: string): string {
    // If key is already an absolute path, use it directly
    if (path.isAbsolute(key)) return key;
    return path.join(DATA_DIR, key);
  }
}
