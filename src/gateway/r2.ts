/**
 * Gateway management for Moltbot
 */

import { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';

const MOLTBOT_PORT = 18789;

/**
 * Find existing Moltbot process
 */
export async function findExistingMoltbotProcess(
  sandbox: Sandbox,
): Promise<{ pid: number; status: string } | null> {
  try {
    const processes = await sandbox.listProcesses();
    const moltbotProcess = processes.find((p) =>
      p.command?.includes('openclaw')
    );
    return moltbotProcess ? { pid: moltbotProcess.pid, status: moltbotProcess.status } : null;
  } catch (error) {
    console.error('[GATEWAY] Error listing processes:', error);
    return null;
  }
}

/**
 * Ensure Moltbot gateway is running
 */
export async function ensureMoltbotGateway(
  sandbox: Sandbox,
  env: MoltbotEnv,
): Promise<void> {
  // MOUNT R2 STORAGE (SIMPLE FIX)
  if (env.MOLTBOT_BUCKET && env.R2_BUCKET_NAME) {
    try {
      console.log('[GATEWAY] Mounting R2 storage...');
      await sandbox.exec('mkdir -p /data/moltbot && chmod 777 /data/moltbot');
      await sandbox.mountBucket(env.MOLTBOT_BUCKET, '/data/moltbot', {
        readOnly: false,
      });
      console.log('[GATEWAY] R2 storage mounted at /data/moltbot');
    } catch (error) {
      console.error('[GATEWAY] R2 mount failed (continuing without):', error);
    }
  }

  const existing = await findExistingMoltbotProcess(sandbox);
  if (existing && existing.status === 'running') {
    return;
  }

  console.log('[GATEWAY] Starting Moltbot gateway...');
  
  await sandbox.startProcess({
    command: ['/usr/local/bin/start-openclaw.sh'],
    env: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
      NODE_ENV: 'production',
    },
  });

  console.log('[GATEWAY] Moltbot gateway started');
}

/**
 * Sync data to R2
 */
export async function syncToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!env.R2_BUCKET_NAME) {
      return { success: false, error: 'R2_BUCKET_NAME not set' };
    }

    const result = await sandbox.exec(
      'rsync -av /root/.openclaw/ /data/moltbot/openclaw/ 2>&1'
    );
    
    console.log('[SYNC] R2 sync completed:', result.stdout);
    return { success: true };
  } catch (error) {
    console.error('[SYNC] R2 sync failed:', error);
    return { success: false, error: String(error) };
  }
}
