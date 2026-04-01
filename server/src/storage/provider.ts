// Storage provider abstraction — local filesystem vs external (MongoDB GridFS, etc.)

export interface StorageProvider {
  name: string;
  /** Write file data, return the storage path/key */
  write(key: string, data: Buffer, metadata?: Record<string, string>): Promise<string>;
  /** Read file data by key */
  read(key: string): Promise<Buffer>;
  /** Delete file by key */
  delete(key: string): Promise<void>;
  /** Check if a file exists */
  exists(key: string): Promise<boolean>;
  /** Get file size in bytes */
  size(key: string): Promise<number>;
  /** Create a readable stream for the file */
  createReadStream(key: string): Promise<NodeJS.ReadableStream>;
  /** Test the connection (for external providers) */
  testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }>;
  /** Disconnect / cleanup */
  disconnect(): Promise<void>;
}
