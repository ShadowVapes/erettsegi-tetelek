import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GITHUB_CONTENT_PATH = 'data/content.json';
const BACKUP_COOLDOWN_MS = 120000;
const SYNC_COOLDOWN_MS = 1200;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const githubToken = Deno.env.get('GITHUB_TOKEN') || '';
    const githubOwner = Deno.env.get('GITHUB_OWNER') || '';
    const githubRepo = Deno.env.get('GITHUB_REPO') || '';
    const githubBranch = Deno.env.get('GITHUB_BRANCH') || 'main';

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('Hiányzik a SUPABASE_URL vagy SUPABASE_SERVICE_ROLE_KEY secret.');
    }

    if (body?.dryRun) {
      return jsonResponse({
        status: 'ok',
        githubReady: Boolean(githubToken && githubOwner && githubRepo),
        branch: githubBranch,
      });
    }

    if (!githubToken || !githubOwner || !githubRepo) {
      throw new Error('Hiányzik a GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO secret.');
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [{ data: appRow, error: appError }, { data: syncStateRow, error: syncError }] = await Promise.all([
      supabase
        .from('app_state')
        .select('id, data, revision, updated_at, editor_id')
        .eq('id', 1)
        .maybeSingle(),
      supabase
        .from('github_sync_state')
        .select('id, last_synced_hash, last_synced_at, last_backup_at, last_requested_at, last_error')
        .eq('id', 1)
        .maybeSingle(),
    ]);

    if (appError) throw appError;
    if (syncError) throw syncError;
    if (!appRow) {
      return jsonResponse({ status: 'noop', reason: 'no_app_state' });
    }

    const contentText = JSON.stringify(appRow.data ?? {}, null, 2);
    const contentHash = await sha256(contentText);
    const now = new Date();
    const nowIso = now.toISOString();

    if (syncStateRow?.last_synced_hash === contentHash) {
      return jsonResponse({ status: 'noop', reason: 'already_synced' });
    }

    const lastRequestedAt = syncStateRow?.last_requested_at ? new Date(syncStateRow.last_requested_at).getTime() : 0;
    if (!body?.force && lastRequestedAt && (Date.now() - lastRequestedAt) < SYNC_COOLDOWN_MS) {
      await supabase.from('github_sync_state').upsert({
        id: 1,
        last_requested_at: nowIso,
        last_error: null,
      }, { onConflict: 'id' });
      return jsonResponse({ status: 'cooldown' });
    }

    await supabase.from('github_sync_state').upsert({
      id: 1,
      last_requested_at: nowIso,
      last_error: null,
    }, { onConflict: 'id' });

    const commitMessage = `${body?.reason || 'Supabase sync'} · ${new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}`;
    const putResult = await putGithubFile({
      owner: githubOwner,
      repo: githubRepo,
      branch: githubBranch,
      token: githubToken,
      path: GITHUB_CONTENT_PATH,
      contentText,
      message: commitMessage,
    });

    let backupCreated = false;
    const lastBackupAt = syncStateRow?.last_backup_at ? new Date(syncStateRow.last_backup_at).getTime() : 0;
    if (body?.forceBackup || !lastBackupAt || (Date.now() - lastBackupAt) >= BACKUP_COOLDOWN_MS) {
      const backupText = JSON.stringify({
        savedAt: nowIso,
        source: 'supabase-edge-function',
        revision: appRow.revision,
        data: appRow.data ?? {},
      }, null, 2);

      await putGithubFile({
        owner: githubOwner,
        repo: githubRepo,
        branch: githubBranch,
        token: githubToken,
        path: `backup/content-${nowIso.replace(/[:.]/g, '-')}.json`,
        contentText: backupText,
        message: `Backup · ${new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}`,
      });
      backupCreated = true;
    }

    await supabase.from('github_sync_state').upsert({
      id: 1,
      last_synced_hash: contentHash,
      last_synced_at: nowIso,
      last_backup_at: backupCreated ? nowIso : (syncStateRow?.last_backup_at || null),
      last_requested_at: nowIso,
      last_error: null,
    }, { onConflict: 'id' });

    return jsonResponse({
      status: 'ok',
      sha: putResult?.content?.sha || null,
      backupCreated,
    });
  } catch (error) {
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if (supabaseUrl && serviceRoleKey) {
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        await supabase.from('github_sync_state').upsert({
          id: 1,
          last_error: error?.message || String(error),
          last_requested_at: new Date().toISOString(),
        }, { onConflict: 'id' });
      }
    } catch {
      // ignore follow-up logging errors
    }

    return jsonResponse({
      status: 'error',
      message: error?.message || String(error),
    }, 500);
  }
});

async function putGithubFile({ owner, repo, branch, token, path, contentText, message }: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  path: string;
  contentText: string;
  message: string;
}) {
  let latestSha: string | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentFile = await githubGetFile({ owner, repo, branch, token, path });
    latestSha = currentFile.sha;

    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        content: utf8ToBase64(contentText),
        branch,
        ...(latestSha ? { sha: latestSha } : {}),
      }),
    });

    const text = await response.text();
    const data = safeJsonParse(text, text);

    if (response.ok) {
      return data;
    }

    if (response.status === 409) {
      await sleep(250 * (attempt + 1));
      continue;
    }

    throw new Error(`GitHub hiba ${response.status}: ${typeof data === 'object' ? data?.message || 'ismeretlen' : text}`);
  }

  throw new Error('GitHub 409 konfliktus miatt a mentés nem ment át több újrapróbálás után sem.');
}

async function githubGetFile({ owner, repo, branch, token, path }: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  path: string;
}) {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 404) {
    return { sha: null };
  }

  const text = await response.text();
  const data = safeJsonParse(text, text);
  if (!response.ok) {
    throw new Error(`GitHub olvasási hiba ${response.status}: ${typeof data === 'object' ? data?.message || 'ismeretlen' : text}`);
  }

  return { sha: data?.sha || null };
}

function utf8ToBase64(text: string) {
  return btoa(unescape(encodeURIComponent(text)));
}

function safeJsonParse(text: string, fallback: unknown) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

async function sha256(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
