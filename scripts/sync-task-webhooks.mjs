function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const asanaToken = required("ASANA_ACCESS_TOKEN");
const workspaceGid = process.env.ASANA_WORKSPACE_GID ?? "1201007545370748";
const assigneeGid = process.env.ASANA_ASSIGNEE_GID ?? "1206406200377321";
const targetUrl = process.env.ASANA_WEBHOOK_TARGET_URL ??
  `${supabaseUrl}/functions/v1/asana-webhook`;

const asanaHeaders = {
  Authorization: `Bearer ${asanaToken}`,
  "Content-Type": "application/json",
};

// Must match isPromoQaTask in supabase/functions/_shared/asana.ts.
function isBannerQaTask(name) {
  return /\bbanners?\b/i.test(name) && /\bqa\b/i.test(name);
}

// asana-webhook only accepts a hook-secret handshake while this is open.
async function openHandshakeWindow(minutes) {
  const response = await fetch(`${supabaseUrl}/rest/v1/promo_qa_settings?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      key: "asana_webhook_handshake",
      value: { open_until: new Date(Date.now() + minutes * 60_000).toISOString() },
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function asanaRequest(path, init = {}) {
  const response = await fetch(`https://app.asana.com/api/1.0${path}`, {
    ...init,
    headers: { ...asanaHeaders, ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.errors?.[0]?.message ?? `Asana ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function listIncompleteBannerQaTasks() {
  const tasks = [];
  let offset;
  do {
    const query = new URLSearchParams({
      assignee: assigneeGid,
      workspace: workspaceGid,
      completed_since: "now",
      limit: "100",
      opt_fields: "gid,name,completed,parent.gid",
    });
    if (offset) query.set("offset", offset);
    const page = await asanaRequest(`/tasks?${query}`);
    tasks.push(
      ...page.data.filter((task) => !task.completed && isBannerQaTask(task.name)),
    );
    offset = page.next_page?.offset;
  } while (offset);
  return tasks;
}

async function createWebhook(resourceGid) {
  const response = await fetch("https://app.asana.com/api/1.0/webhooks", {
    method: "POST",
    headers: asanaHeaders,
    body: JSON.stringify({
      data: {
        resource: resourceGid,
        target: targetUrl,
        filters: [
          { resource_type: "task", action: "changed" },
          { resource_type: "task", action: "added" },
          { resource_type: "story", action: "added" },
        ],
      },
    }),
  });
  const payload = await response.json().catch(() => null);
  if (
    response.status === 403 &&
    payload?.errors?.[0]?.message?.includes("Duplicated webhook")
  ) {
    return { status: "skipped", gid: null };
  }
  if (!response.ok) {
    throw new Error(payload?.errors?.[0]?.message ?? `Webhook create failed (${response.status})`);
  }
  return { status: "created", gid: payload.data.gid, active: payload.data.active };
}

// Asana is the source of truth: list the task-level webhooks that already point
// at our endpoint. Project webhooks share the target, so only tasks count here.
async function listExistingTaskWebhooks() {
  const byTask = new Map();
  let offset;
  do {
    const query = new URLSearchParams({
      workspace: workspaceGid,
      limit: "100",
      opt_fields: "gid,active,target,resource.gid,resource.resource_type",
    });
    if (offset) query.set("offset", offset);
    const page = await asanaRequest(`/webhooks?${query}`);
    for (const webhook of page.data) {
      if (webhook.target !== targetUrl) continue;
      if (webhook.resource?.resource_type !== "task") continue;
      byTask.set(webhook.resource.gid, webhook);
    }
    offset = page.next_page?.offset;
  } while (offset);
  return byTask;
}

const dryRun = process.argv.includes("--dry-run");

const tasks = await listIncompleteBannerQaTasks();
const resourceGids = new Set();
for (const task of tasks) {
  resourceGids.add(task.gid);
  if (task.parent?.gid) resourceGids.add(task.parent.gid);
}

const existing = await listExistingTaskWebhooks();
const webhooks = [];
let created = 0;
let skipped = 0;
let removed = 0;
let handshakeOpen = false;
for (const resourceGid of resourceGids) {
  const current = existing.get(resourceGid);
  if (current?.active) {
    skipped += 1;
    webhooks.push({ gid: current.gid, task_gid: resourceGid, active: true });
    continue;
  }
  if (dryRun) {
    console.log(current
      ? `Would replace inactive webhook on ${resourceGid}`
      : `Would register ${resourceGid}`);
    continue;
  }
  if (current) {
    // Asana stopped delivering to it; replace it with a fresh one.
    await asanaRequest(`/webhooks/${current.gid}`, { method: "DELETE" });
    existing.delete(resourceGid);
  }
  if (!handshakeOpen) {
    await openHandshakeWindow(10);
    handshakeOpen = true;
  }
  const result = await createWebhook(resourceGid);
  if (result.status === "created") {
    created += 1;
    webhooks.push({
      gid: result.gid,
      task_gid: resourceGid,
      active: result.active ?? true,
    });
    console.log(`Registered ${resourceGid}`);
  } else {
    skipped += 1;
    webhooks.push({ gid: "existing", task_gid: resourceGid, active: true });
  }
}

// Webhooks on tasks whose banner QA is finished just add noise.
for (const [taskGid, webhook] of existing) {
  if (resourceGids.has(taskGid)) continue;
  if (dryRun) {
    console.log(`Would remove webhook ${webhook.gid} on ${taskGid}`);
    continue;
  }
  await asanaRequest(`/webhooks/${webhook.gid}`, { method: "DELETE" });
  removed += 1;
  console.log(`Removed webhook on ${taskGid}`);
}

if (dryRun) {
  console.log(`Dry run: ${resourceGids.size} tasks need webhooks, ${existing.size} exist.`);
  process.exit(0);
}

const upsert = await fetch(`${supabaseUrl}/rest/v1/promo_qa_settings?on_conflict=key`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  },
  body: JSON.stringify({
    key: "asana_task_webhooks",
    value: {
      target: targetUrl,
      webhooks,
      updated_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }),
});
if (!upsert.ok) throw new Error(await upsert.text());

console.log(
  `Task webhooks synced. created=${created} skipped=${skipped} removed=${removed} total=${resourceGids.size}`,
);
