import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AsanaClient,
  findMatchingWebhookSecret,
  isPromoQaTask,
} from "../_shared/asana.ts";
import { invokeQaRunner } from "../_shared/runner.ts";
import type { AsanaWebhookEvent, AsanaWebhookPayload } from "../_shared/types.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const requiredEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const supabase = createClient(
  supabaseUrl,
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const asana = new AsanaClient(requiredEnv("ASANA_ACCESS_TOKEN"));
const runnerSecret = requiredEnv("QA_RUNNER_SECRET");
const assigneeGid = Deno.env.get("ASANA_ASSIGNEE_GID") ?? "1206406200377321";
const debounceMs = Number(Deno.env.get("WEBHOOK_DEBOUNCE_MS") ?? "60000");

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const hookSecretHeader = request.headers.get("X-Hook-Secret");

  if (hookSecretHeader) {
    // Only while qa-runner or a setup script is creating a webhook; otherwise
    // anyone could register a secret and then send us signed events.
    if (!await isHandshakeWindowOpen()) {
      console.error("Rejected an unexpected Asana webhook handshake");
      return new Response("No webhook registration in progress", { status: 403 });
    }
    await storeWebhookSecret(hookSecretHeader);
    return new Response(null, {
      status: 200,
      headers: { "X-Hook-Secret": hookSecretHeader },
    });
  }

  try {
    const secrets = await getWebhookSecrets();
    if (!secrets.length) {
      console.error("Asana webhook received before a hook secret was stored");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const signature = request.headers.get("X-Hook-Signature");
    if (await findMatchingWebhookSecret(secrets, rawBody, signature) < 0) {
      return new Response("Invalid signature", { status: 401 });
    }

    if (!await isAutomationEnabled()) {
      return new Response(null, { status: 204 });
    }

    const payload = JSON.parse(rawBody || "{}") as AsanaWebhookPayload;
    const events = payload.events ?? [];
    if (!events.length) {
      return new Response(null, { status: 204 });
    }

    // Answer Asana right away: it retries slow deliveries, which used to start
    // duplicate QA runs. The runs continue in the background.
    EdgeRuntime.waitUntil(
      dispatchQaRuns(events).catch((error) =>
        console.error("Asana webhook dispatch failed:", error)
      ),
    );
    return Response.json({ ok: true, events: events.length });
  } catch (error) {
    console.error("Asana webhook handler failed:", error);
    return new Response(null, { status: 204 });
  }
});

async function dispatchQaRuns(events: AsanaWebhookEvent[]): Promise<void> {
  const targets = await resolvePromoQaTargets(events);
  for (const target of targets) {
    if (target.storyGid) {
      // A QA task in a project gets each comment twice: from the project
      // webhook and from its own task webhook. Run once per comment.
      if (!await claimStory(target.storyGid, target.taskGid)) continue;
    } else if (await isDebounced(target.taskGid)) {
      continue;
    }
    await markDebounced(target.taskGid);
    await invokeQaRunner({
      supabaseUrl,
      runnerSecret,
      trigger: "webhook",
      requestedBy: "asana-webhook",
      taskGid: target.taskGid,
      storyGid: target.storyGid,
    }).catch((error) =>
      console.error(`QA run failed for ${target.taskGid}:`, error)
    );
  }
}

async function claimStory(storyGid: string, taskGid: string): Promise<boolean> {
  const { error } = await supabase.from("webhook_task_debounce").insert({
    task_gid: `story:${storyGid}:${taskGid}`,
    last_enqueued_at: new Date().toISOString(),
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  // Can't tell; better a duplicate run than a missed comment.
  console.error("Could not claim story:", error.message);
  return true;
}

async function isHandshakeWindowOpen(): Promise<boolean> {
  const { data, error } = await supabase
    .from("promo_qa_settings")
    .select("value")
    .eq("key", "asana_webhook_handshake")
    .maybeSingle();
  if (error) throw error;
  const openUntil = (data?.value as { open_until?: string } | null)?.open_until;
  return Boolean(openUntil) && new Date(openUntil!).getTime() > Date.now();
}

async function resolvePromoQaTargets(
  events: AsanaWebhookEvent[],
): Promise<Array<{ taskGid: string; storyGid?: string }>> {
  const byTask = new Map<string, string | undefined>();

  for (const event of events) {
    // Some events carry no resource; skip them instead of dropping the batch.
    if (!event?.resource?.gid) continue;
    const taskGid = await resolveTaskGidFromEvent(event);
    if (!taskGid) continue;
    const storyGid = event.resource.resource_type === "story"
      ? event.resource.gid
      : undefined;

    try {
      const task = await asana.getTask(taskGid);
      const qaGids: string[] = [];
      if (!task.completed && isPromoQaTask(task) && task.assignee?.gid === assigneeGid) {
        qaGids.push(task.gid);
      }

      const subtasks = await asana.listPromoQaSubtasksForParent(
        task.gid,
        assigneeGid,
      );
      for (const subtask of subtasks) {
        qaGids.push(subtask.gid);
      }

      for (const qaGid of qaGids) {
        if (storyGid || !byTask.has(qaGid)) {
          byTask.set(qaGid, storyGid ?? byTask.get(qaGid));
        }
      }
    } catch (error) {
      console.error(`Failed to resolve promo QA tasks for ${taskGid}:`, error);
    }
  }

  return [...byTask.entries()].map(([taskGid, storyGid]) => ({
    taskGid,
    storyGid,
  }));
}

async function resolveTaskGidFromEvent(
  event: AsanaWebhookEvent,
): Promise<string | null> {
  if (event.resource.resource_type === "task") {
    return event.resource.gid;
  }
  if (
    event.resource.resource_type === "story" &&
    event.parent?.resource_type === "task"
  ) {
    return event.parent.gid;
  }
  return null;
}

async function getWebhookSecrets(): Promise<string[]> {
  const envSecret = Deno.env.get("ASANA_WEBHOOK_SECRET");
  if (envSecret) return [envSecret];

  const { data, error } = await supabase
    .from("promo_qa_settings")
    .select("value")
    .eq("key", "asana_webhook_secret")
    .maybeSingle();
  if (error) throw error;
  return parseWebhookSecrets(data?.value);
}

async function storeWebhookSecret(secret: string): Promise<void> {
  // One statement in Postgres, so two handshakes at once can't drop a secret.
  const { error } = await supabase.rpc("add_asana_webhook_secret", {
    p_secret: secret,
  });
  if (error) throw error;
}

function parseWebhookSecrets(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];

  const record = value as { secret?: unknown; secrets?: unknown };
  const secrets: string[] = [];

  if (typeof record.secret === "string" && record.secret.length > 0) {
    secrets.push(record.secret);
  }
  if (Array.isArray(record.secrets)) {
    for (const entry of record.secrets) {
      if (typeof entry === "string" && entry.length > 0 && !secrets.includes(entry)) {
        secrets.push(entry);
      }
    }
  }

  return secrets;
}

async function isAutomationEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc("get_promo_qa_automation_enabled");
  if (error) throw error;
  return Boolean(data);
}

async function isDebounced(taskGid: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("webhook_task_debounce")
    .select("last_enqueued_at")
    .eq("task_gid", taskGid)
    .maybeSingle();
  if (error) throw error;
  if (!data?.last_enqueued_at) return false;
  return Date.now() - new Date(data.last_enqueued_at).getTime() < debounceMs;
}

async function markDebounced(taskGid: string): Promise<void> {
  const { error } = await supabase.from("webhook_task_debounce").upsert({
    task_gid: taskGid,
    last_enqueued_at: new Date().toISOString(),
  }, { onConflict: "task_gid" });
  if (error) throw error;
}
