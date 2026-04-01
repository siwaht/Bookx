import type { StorageProvider } from './provider.js';
import { LocalStorageProvider } from './local.js';
import { MongoDBStorageProvider } from './mongodb.js';

let activeProvider: StorageProvider = new LocalStorageProvider();

export function getStorageProvider(): StorageProvider {
  return activeProvider;
}

export function setStorageProvider(provider: StorageProvider): void {
  activeProvider = provider;
}

/**
 * Initialize storage from settings. Called at server startup and when
 * the user changes storage config in Settings.
 */
export async function initStorageFromSettings(
  getSettingFn: (key: string) => string | null
): Promise<{ provider: string; connected: boolean; error?: string }> {
  const storageType = getSettingFn('storage_provider') || 'local';

  if (storageType === 'mongodb') {
    const connString = getSettingFn('mongodb_connection_string');
    const dbName = getSettingFn('mongodb_database_name') || 'audiobookstudio';

    if (!connString) {
      // Fall back to local
      activeProvider = new LocalStorageProvider();
      return { provider: 'local', connected: true, error: 'MongoDB connection string not configured' };
    }

    const mongoProvider = new MongoDBStorageProvider(connString, dbName);
    const test = await mongoProvider.testConnection();

    if (test.connected) {
      // Disconnect old provider if it was mongo
      if (activeProvider.name === 'mongodb') {
        await activeProvider.disconnect();
      }
      activeProvider = mongoProvider;
      return { provider: 'mongodb', connected: true };
    } else {
      // Fall back to local on connection failure
      activeProvider = new LocalStorageProvider();
      return { provider: 'local', connected: false, error: test.error };
    }
  }

  // Default: local
  activeProvider = new LocalStorageProvider();
  return { provider: 'local', connected: true };
}

export type { StorageProvider } from './provider.js';
