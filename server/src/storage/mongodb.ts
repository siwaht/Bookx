import { Readable } from 'stream';
import type { StorageProvider } from './provider.js';

// Dynamic imports — mongodb is an optional dependency
let MongoClient: any;
let GridFSBucket: any;

async function loadMongo() {
  if (MongoClient) return;
  try {
    // Use variable to prevent TypeScript from resolving the module at compile time
    const moduleName = 'mongodb';
    const mongo = await import(/* webpackIgnore: true */ moduleName);
    MongoClient = mongo.MongoClient;
    GridFSBucket = mongo.GridFSBucket;
  } catch {
    throw new Error('mongodb package is not installed. Run: npm install mongodb');
  }
}

export class MongoDBStorageProvider implements StorageProvider {
  name = 'mongodb';
  private client: any = null;
  private db: any = null;
  private bucket: any = null;
  private connectionString: string;
  private dbName: string;

  constructor(connectionString: string, dbName = 'audiobookstudio') {
    this.connectionString = connectionString;
    this.dbName = dbName;
  }

  private async ensureConnected() {
    if (this.client && this.db) return;
    await loadMongo();
    this.client = new MongoClient(this.connectionString);
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.bucket = new GridFSBucket(this.db, { bucketName: 'files' });
  }

  async write(key: string, data: Buffer, metadata?: Record<string, string>): Promise<string> {
    await this.ensureConnected();
    // Delete existing file with same key if any
    try { await this.delete(key); } catch {}

    return new Promise((resolve, reject) => {
      const uploadStream = this.bucket.openUploadStream(key, {
        metadata: { ...metadata, uploadedAt: new Date().toISOString() },
      });
      const readable = Readable.from(data);
      readable.pipe(uploadStream)
        .on('finish', () => resolve(`gridfs://${key}`))
        .on('error', reject);
    });
  }

  async read(key: string): Promise<Buffer> {
    await this.ensureConnected();
    const chunks: Buffer[] = [];
    const stream = this.bucket.openDownloadStreamByName(key);
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async delete(key: string): Promise<void> {
    await this.ensureConnected();
    const files = await this.db.collection('files.files').find({ filename: key }).toArray();
    for (const file of files) {
      await this.bucket.delete(file._id);
    }
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureConnected();
    const file = await this.db.collection('files.files').findOne({ filename: key });
    return !!file;
  }

  async size(key: string): Promise<number> {
    await this.ensureConnected();
    const file = await this.db.collection('files.files').findOne({ filename: key });
    return file?.length || 0;
  }

  async createReadStream(key: string): Promise<NodeJS.ReadableStream> {
    await this.ensureConnected();
    return this.bucket.openDownloadStreamByName(key);
  }

  async testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }> {
    try {
      await loadMongo();
      const testClient = new MongoClient(this.connectionString);
      await testClient.connect();
      const admin = testClient.db().admin();
      const info = await admin.serverInfo();
      const dbList = await admin.listDatabases();
      await testClient.close();
      return {
        connected: true,
        details: {
          version: info.version,
          databases: dbList.databases.length,
          targetDb: this.dbName,
        },
      };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.bucket = null;
    }
  }
}
