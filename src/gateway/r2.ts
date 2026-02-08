/**
 * R2 storage mounting
 */

import { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

/**
 * Mount R2 storage for Moltbot
 */
export async function mountR2Storage(
  sandbox: Sandbox,
  env: MoltbotEnv,
): Promise<void> {
  if (!env.MOLTBOT_BUCKET || !env.R2_BUCKET_NAME) {
    console.log('[R2] No R2 storage configured, skipping mount');
    return;
  }

  try {
    console.log('[R2] Mounting R2 storage...');
    
    // Create directory with proper permissions
    await sandbox.exec('mkdir -p /data/moltbot && chmod 777 /data/moltbot');
    
    // Mount the bucket
    await sandbox.mountBucket(env.MOLTBOT_BUCKET, '/data/moltbot', {
      readOnly: false,
    });
    
    console.log('[R2] R2 storage mounted at /data/moltbot');
  } catch (error) {
    console.error('[R2] R2 mount failed (continuing without):', error);
    throw error; // Re-throw so caller knows mount failed
  }
}
