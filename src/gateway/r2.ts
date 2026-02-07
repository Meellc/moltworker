/**
 * Gateway management and R2 persistence for Moltbot
 */

import { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';

const MOLTBOT_PORT = 18789;

/**
 * Find an existing Moltbot gateway process
 */
export async function findExistingMoltbotProcess(
  sandbox: Sandbox,
): Promise<{ pid: number; status: string } | null> {
  try {
    const processes = await sandbox.listProcesses();
    const moltbotProcess = processes.find((p) =>
      p.command?.includes('start-openclaw.sh') ||
      p.command?.includes('openclaw') ||
      p.args?.some(arg => arg.includes('openclaw'))
    );

    if (moltbotProcess) {
      return {
        pid: moltbotProcess.pid,
        status: moltbotProcess.status,
      };
    }
    return null;
  } catch (error) {
    console.error('[GATEWAY] Error listing processes:', error);
    return null;
  }
}

/**
 * Mount R2 bucket for persistent storage
 */
async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  if (!env.R2_BUCKET_NAME || !env.MOLTBOT_BUCKET) {
    console.log('[R2] R2 configuration missing, using ephemeral storage');
    return false;
  }

  try {
    console.log('[R2] Setting up R2 persistent storage...');
    
    // Create mount directory with proper permissions
    await sandbox.exec('mkdir -p /data/moltbot');
    await sandbox.exec('chmod 777 /data/moltbot');
    
    // Mount R2 bucket
    await sandbox.mountBucket(env.MOLTBOT_BUCKET, '/data/moltbot', {
      readOnly: false,
    });
    
    console.log('[R2] R2 bucket mounted successfully at /data/moltbot');
    
    // Create compatibility symlinks for OpenClaw
    await sandbox.exec('mkdir -p /data/moltbot/openclaw');
    await sandbox.exec('ln -sf /data/moltbot/openclaw /root/.openclaw');
    await sandbox.exec('ln -sf /data/moltbot/openclaw /root/clawd/data');
    
    return true;
  } catch (error) {
    console.error('[R2] Failed to mount R2 storage:', error);
    return false;
  }
}

/**
 * Ensure Moltbot gateway is running
 */
export async function ensureMoltbotGateway(
  sandbox: Sandbox,
  env: MoltbotEnv,
): Promise<void> {
  // Check if already running
  const existing = await findExistingMoltbotProcess(sandbox);
  if (existing && existing.status === 'running') {
    console.log('[GATEWAY] Moltbot already running with PID:', existing.pid);
    return;
  }

  try {
    // Mount R2 storage first
    const r2Mounted = await mountR2Storage(sandbox, env);
    
    if (!r2Mounted) {
      console.log('[GATEWAY] Using ephemeral storage (R2 not available)');
    }

    console.log('[GATEWAY] Starting Moltbot gateway...');
    
    // Build environment variables for OpenClaw
    const openclawEnv: Record<string, string> = {
      NODE_ENV: 'production',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/root',
    };

    // Add AI provider keys
    if (env.ANTHROPIC_API_KEY) {
      openclawEnv.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    }
    if (env.OPENAI_API_KEY) {
      openclawEnv.OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    
    // Add gateway token if set
    if (env.MOLTBOT_GATEWAY_TOKEN) {
      openclawEnv.OPENCLAW_GATEWAY_TOKEN = env.MOLTBOT_GATEWAY_TOKEN;
    }

    // Start the gateway process
    const proc = await sandbox.startProcess({
      command: ['/usr/local/bin/start-openclaw.sh'],
      env: openclawEnv,
      workingDirectory: '/root/clawd',
    });

    console.log('[GATEWAY] Moltbot gateway started with PID:', proc.pid);
    
    // Wait a moment for gateway to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verify it's running
    const verify = await findExistingMoltbotProcess(sandbox);
    if (!verify || verify.status !== 'running') {
      throw new Error('Gateway failed to start');
    }
    
    console.log('[GATEWAY] Gateway successfully started and verified');
    
  } catch (error) {
    console.error('[GATEWAY] Failed to start Moltbot:', error);
    throw error;
  }
}

/**
 * Sync Moltbot data to R2 for persistence
 */
export async function syncToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
): Promise<{ success: boolean; error?: string; details?: string; lastSync?: string }> {
  try {
    console.log('[SYNC] Starting R2 backup sync...');
    
    // Check if R2 is configured
    if (!env.R2_BUCKET_NAME) {
      return {
        success: false,
        error: 'R2 storage is not configured',
        details: 'Missing R2_BUCKET_NAME environment variable',
      };
    }

    // Check if R2 is mounted
    const { stdout: mountCheck } = await sandbox.exec('mount | grep /data/moltbot || echo "not mounted"');
    if (mountCheck.includes('not mounted')) {
      // Try to mount it
      const mounted = await mountR2Storage(sandbox, env);
      if (!mounted) {
        return {
          success: false,
          error: 'R2 storage not mounted',
          details: 'Failed to mount R2 bucket',
        };
      }
    }

    // Create backup directories
    await sandbox.exec('mkdir -p /root/.openclaw');
    await sandbox.exec('mkdir -p /data/moltbot/openclaw');
    
    // Sync from container to R2
    const syncResult = await sandbox.exec(
      'rsync -av --delete /root/.openclaw/ /data/moltbot/openclaw/ 2>&1'
    );

    if (syncResult.stderr && !syncResult.stderr.includes('sending incremental file list')) {
      console.error('[SYNC] Rsync error:', syncResult.stderr);
      return {
        success: false,
        error: 'Sync failed',
        details: syncResult.stderr,
      };
    }

    console.log('[SYNC] R2 backup completed successfully');
    console.log('[SYNC] Output:', syncResult.stdout);
    
    return {
      success: true,
      lastSync: new Date().toISOString(),
    };
    
  } catch (error) {
    console.error('[SYNC] Backup sync failed:', error);
    return {
      success: false,
      error: 'Sync failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
