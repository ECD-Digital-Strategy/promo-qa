function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const asanaToken = required("ASANA_ACCESS_TOKEN");
const workspaceGid = process.env.ASANA_WORKSPACE_GID ?? "1201007545370748";
const targetUrl = process.env.ASANA_WEBHOOK_TARGET_URL ??
  `${supabaseUrl}/functions/v1/asana-webhook`;

const asanaHeaders = {
  Authorization: `Bearer ${asanaToken}`,
  "Content-Type": "application/json",
};

const webhookFilters = [
  { resource_type: "task", action: "changed" },
  { resource_type: "task", action: "added" },
  { resource_type: "story", action: "added" },
];

async function upsertSetting(key, value) {
  const response = await fetch(`${supabaseUrl}/rest/v1/promo_qa_settings?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      key,
      value,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function asanaRequest(path, init = {}) {
  const response = await fetch(`https://app.asana.com/api/1.0${path}`, {
    ...init,
    headers: {
      ...asanaHeaders,
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.errors?.[0]?.message ??
      `Asana request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function listWorkspaceProjects() {
  const projects = [];
  let offset;

  do {
    const query = new URLSearchParams({
      workspace: workspaceGid,
      archived: "false",
      limit: "100",
      opt_fields: "gid,name",
    });
    if (offset) query.set("offset", offset);

    const payload = await asanaRequest(`/projects?${query}`);
    projects.push(...payload.data);
    offset = payload.next_page?.offset;
  } while (offset);

  return projects;
}

function extractHookSecret(response, payload) {
  return response.headers.get("X-Hook-Secret") ?? payload?.["X-Hook-Secret"] ?? null;
}

// Atomic append (never rewrite the whole list: handshakes store secrets too).
async function addSecret(secret) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/add_asana_webhook_secret`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_secret: secret }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function openHandshakeWindow(minutes) {
  await upsertSetting("asana_webhook_handshake", {
    open_until: new Date(Date.now() + minutes * 60_000).toISOString(),
  });
}

async function registerProjectWebhook(project) {
  const response = await fetch("https://app.asana.com/api/1.0/webhooks", {
    method: "POST",
    headers: asanaHeaders,
    body: JSON.stringify({
      data: {
        resource: project.gid,
        target: targetUrl,
        filters: webhookFilters,
      },
    }),
  });
  const payload = await response.json().catch(() => null);

  if (response.status === 403 &&
    payload?.errors?.[0]?.message?.includes("Duplicated webhook")) {
    return { status: "skipped", project, webhook: null, secret: null };
  }

  if (!response.ok) {
    const message = payload?.errors?.[0]?.message ??
      `Webhook create failed (${response.status})`;
    return { status: "error", project, error: message };
  }

  return {
    status: "created",
    project,
    webhook: payload.data,
    secret: extractHookSecret(response, payload),
  };
}

const projects = await listWorkspaceProjects();
console.log(`Found ${projects.length} active projects in workspace ${workspaceGid}.`);

const results = {
  created: [],
  skipped: [],
  errors: [],
};

// asana-webhook only accepts handshakes while this window is open, and stores
// each hook secret itself during the handshake.
await openHandshakeWindow(30);

for (const project of projects) {
  const result = await registerProjectWebhook(project);
  if (result.status === "created") {
    results.created.push({
      gid: result.webhook.gid,
      project_gid: project.gid,
      project_name: project.name,
      active: result.webhook.active,
    });
    if (result.secret) await addSecret(result.secret);
    console.log(`Registered ${project.name}`);
  } else if (result.status === "skipped") {
    results.skipped.push({
      project_gid: project.gid,
      project_name: project.name,
    });
  } else {
    results.errors.push({
      project_gid: project.gid,
      project_name: project.name,
      error: result.error,
    });
    console.error(`Failed ${project.name}: ${result.error}`);
  }
}

await upsertSetting("asana_webhook_meta", {
  target: targetUrl,
  workspace_gid: workspaceGid,
  project_count: projects.length,
  created: results.created.length,
  skipped: results.skipped.length,
  errors: results.errors.length,
  webhooks: results.created,
  updated_at: new Date().toISOString(),
});

console.log("");
console.log("Asana project webhooks registered.");
console.log(`Target URL: ${targetUrl}`);
console.log(`Created: ${results.created.length}`);
console.log(`Skipped (already existed): ${results.skipped.length}`);
console.log(`Errors: ${results.errors.length}`);
console.log(`Stored hook secrets: ${secrets.length}`);

if (results.errors.length) {
  process.exitCode = 1;
}
