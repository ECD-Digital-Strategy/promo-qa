import { isAthenaUser } from "./comment-agent.ts";
import type {
  AsanaTask,
  IncomingComment,
  PromoDesignComment,
  PromoDesignContext,
  PromoDesignSubtask,
  ShopifyEditorTarget,
  TaskContext,
} from "./types.ts";

const ASANA_API = "https://app.asana.com/api/1.0";
// Emil, the account Promo QA works as (overridable with ASANA_ASSIGNEE_GID).
const DEFAULT_ASSIGNEE_GID = "1206406200377321";
const TASK_FIELDS = [
  "name",
  "notes",
  "html_notes",
  "completed",
  "modified_at",
  "due_on",
  "due_at",
  "assignee.gid",
  "assignee.name",
  "projects.gid",
  "projects.name",
  "parent.gid",
  "parent.name",
  "created_by.gid",
  "created_by.name",
].join(",");

interface AsanaEnvelope<T> {
  data: T;
  next_page?: { offset: string } | null;
  errors?: Array<{ message: string }>;
}

export class AsanaApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "AsanaApiError";
    this.status = status;
    this.details = details;
  }
}

export class AsanaClient {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<AsanaEnvelope<T>> {
    const response = await fetch(`${ASANA_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => null) as
      | AsanaEnvelope<T>
      | null;

    if (!response.ok || !payload) {
      throw new AsanaApiError(
        payload?.errors?.[0]?.message ??
          `Asana request failed (${response.status})`,
        response.status,
        payload,
      );
    }

    return payload;
  }

  async listIncompleteTasks(
    assigneeGid: string,
    workspaceGid: string,
  ): Promise<AsanaTask[]> {
    const tasks: AsanaTask[] = [];
    let offset: string | undefined;

    do {
      const query = new URLSearchParams({
        assignee: assigneeGid,
        workspace: workspaceGid,
        completed_since: "now",
        limit: "100",
        opt_fields: TASK_FIELDS,
      });
      if (offset) query.set("offset", offset);

      const page = await this.request<AsanaTask[]>(`/tasks?${query}`);
      tasks.push(...page.data.filter((task) => !task.completed));
      offset = page.next_page?.offset;
    } while (offset);

    return tasks;
  }

  async getTask(taskGid: string): Promise<AsanaTask> {
    const query = new URLSearchParams({ opt_fields: TASK_FIELDS });
    return (await this.request<AsanaTask>(`/tasks/${taskGid}?${query}`)).data;
  }

  async getCommentRecipient(
    task: AsanaTask,
    parent: AsanaTask | null,
    automationAssigneeGid?: string,
  ): Promise<{ gid: string; name: string } | null> {
    const automationGid = automationAssigneeGid ?? null;
    // A person: not the account Promo QA runs as, and not the promo
    // calendar's own account, which creates these tasks and reads nothing.
    const isPerson = (u?: { gid: string; name?: string } | null): u is { gid: string; name: string } =>
      !!u?.gid && u.gid !== automationGid && !isAthenaUser(u.gid);

    // The web person first (Emil, 2026-10-20: "it should tag whoever is the
    // web person"): the parent is the work being checked (the Promo Banner),
    // and whoever has it is who adds the link and fixes what QA finds.
    if (isPerson(parent?.assignee)) return { gid: parent!.assignee!.gid, name: parent!.assignee!.name ?? "" };
    if (isPerson(task.created_by)) return task.created_by;
    if (isPerson(parent?.created_by)) return parent!.created_by!;
    const fallback = await this.getCreator(task);
    return isPerson(fallback) ? fallback : null;
  }

  /**
   * Every story on a task, oldest first. Asana pages at 100 and returns the
   * oldest first, so reading one page hides the newest comments on busy tasks.
   */
  private async listStories<T>(
    taskGid: string,
    optFields: string,
  ): Promise<T[]> {
    const stories: T[] = [];
    let offset: string | undefined;
    do {
      const query = new URLSearchParams({ opt_fields: optFields, limit: "100" });
      if (offset) query.set("offset", offset);
      const page = await this.request<T[]>(`/tasks/${taskGid}/stories?${query}`);
      stories.push(...page.data);
      offset = page.next_page?.offset;
    } while (offset);
    return stories;
  }

  async getCreator(
    task: AsanaTask,
  ): Promise<{ gid: string; name: string } | null> {
    if (task.created_by?.gid) return task.created_by;

    const stories = await this.listStories<{
      created_at: string;
      created_by?: { gid: string; name: string };
    }>(task.gid, "created_at,created_by.gid,created_by.name,type");

    return stories
      .filter((story) => story.created_by?.gid)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
      ?.created_by ?? null;
  }

  async addQaComment(
    taskGid: string,
    creator: { gid: string; name: string } | null,
    message: string,
    dedup?: string | (() => Promise<boolean>),
  ): Promise<boolean> {
    const alreadyPosted = async () =>
      typeof dedup === "function"
        ? await dedup()
        : dedup
        ? await this.hasCommentContaining(taskGid, dedup)
        : false;

    if (await alreadyPosted()) return false;

    if (creator) {
      await this.request(`/tasks/${taskGid}/addFollowers`, {
        method: "POST",
        body: JSON.stringify({ data: { followers: [creator.gid] } }),
      });
      // Asana recommends a short delay so a newly added follower receives the mention.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (await alreadyPosted()) return false;

    const htmlText = buildAsanaCommentHtml(creator, message);

    await this.request(`/tasks/${taskGid}/stories`, {
      method: "POST",
      body: JSON.stringify({ data: { html_text: htmlText } }),
    });
    return true;
  }

  async hasCommentContaining(taskGid: string, needle: string): Promise<boolean> {
    return (await this.getLatestCommentContaining(taskGid, needle)) !== null;
  }

  async getLatestCommentContaining(
    taskGid: string,
    needle: string,
  ): Promise<{ created_at: string; text: string } | null> {
    const normalizedNeedle = needle.trim().toLowerCase();
    if (!normalizedNeedle) return null;

    const stories = await this.listStories<{
      type?: string;
      text?: string;
      html_text?: string;
      created_at?: string;
    }>(taskGid, "type,text,html_text,created_at");

    let latest: { created_at: string; text: string } | null = null;
    for (const story of stories) {
      if (story.type !== "comment" || !story.created_at) continue;
      const text = stripHtml(story.text ?? story.html_text ?? "");
      if (!text.toLowerCase().includes(normalizedNeedle)) continue;
      if (
        !latest ||
        story.created_at.localeCompare(latest.created_at) > 0
      ) {
        latest = { created_at: story.created_at, text };
      }
    }
    return latest;
  }

  async getStory(storyGid: string): Promise<IncomingComment | null> {
    const query = new URLSearchParams({
      opt_fields:
        "gid,type,text,html_text,created_at,created_by.gid,created_by.name,target.gid",
    });
    const story = (await this.request<{
      gid: string;
      type?: string;
      text?: string;
      html_text?: string;
      created_at?: string;
      created_by?: { gid?: string; name?: string };
      target?: { gid?: string };
    }>(`/stories/${storyGid}?${query}`)).data;
    if (story.type !== "comment" || !story.created_at || !story.target?.gid) {
      return null;
    }
    return {
      gid: story.gid,
      taskGid: story.target.gid,
      text: stripHtml(story.text ?? story.html_text ?? ""),
      htmlText: story.html_text,
      createdAt: story.created_at,
      authorGid: story.created_by?.gid,
      authorName: story.created_by?.name,
    };
  }

  async listTaskComments(taskGid: string): Promise<IncomingComment[]> {
    const stories = await this.listStories<{
      gid: string;
      type?: string;
      text?: string;
      html_text?: string;
      created_at?: string;
      created_by?: { gid?: string; name?: string };
    }>(
      taskGid,
      "gid,type,text,html_text,created_at,created_by.gid,created_by.name",
    );

    return stories
      .filter((story) => story.type === "comment" && story.created_at)
      .map((story) => ({
        gid: story.gid,
        taskGid,
        text: stripHtml(story.text ?? story.html_text ?? ""),
        htmlText: story.html_text,
        createdAt: story.created_at!,
        authorGid: story.created_by?.gid,
        authorName: story.created_by?.name,
      }))
      .filter((comment) => comment.text.trim().length > 0)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async completeTask(taskGid: string): Promise<void> {
    await this.request(`/tasks/${taskGid}`, {
      method: "PUT",
      body: JSON.stringify({ data: { completed: true } }),
    });
  }

  async getPromoDesignContext(parent: AsanaTask | null): Promise<PromoDesignContext> {
    if (!parent?.gid) {
      return { parentTask: null, subtasks: [], comments: [] };
    }

    const subtaskQuery = new URLSearchParams({
      opt_fields: "name,completed,notes,assignee.gid,assignee.name",
      limit: "100",
    });
    const subtasks = (await this.request<
      Array<{
        name: string;
        completed?: boolean;
        notes?: string;
        assignee?: { gid?: string; name?: string };
      }>
    >(`/tasks/${parent.gid}/subtasks?${subtaskQuery}`)).data.map(
      (subtask): PromoDesignSubtask => ({
        name: subtask.name,
        completed: Boolean(subtask.completed),
        notes: stripHtml(subtask.notes ?? ""),
        assignee: subtask.assignee?.name,
        assignee_gid: subtask.assignee?.gid,
        assignee_name: subtask.assignee?.name,
      }),
    );

    const comments = (await this.listStories<{
      type?: string;
      text?: string;
      html_text?: string;
      created_at?: string;
      created_by?: { name?: string };
    }>(parent.gid, "type,text,html_text,created_at,created_by.name"))
      .filter((story) => story.type === "comment")
      .map((story): PromoDesignComment => ({
        author: story.created_by?.name,
        text: stripHtml(story.text ?? story.html_text ?? ""),
        created_at: story.created_at,
      }))
      .filter((comment) => comment.text.trim().length > 0)
      // The latest discussion is what says whether design is done.
      .slice(-50);

    return { parentTask: parent, subtasks, comments };
  }

  async listPromoQaSubtasksForParent(
    parentGid: string,
    assigneeGid: string,
  ): Promise<AsanaTask[]> {
    const query = new URLSearchParams({
      opt_fields: TASK_FIELDS,
      limit: "100",
    });
    const subtasks = (await this.request<AsanaTask[]>(
      `/tasks/${parentGid}/subtasks?${query}`,
    )).data;

    return subtasks.filter((task) =>
      !task.completed &&
      isPromoQaTask(task) &&
      task.assignee?.gid === assigneeGid
    );
  }

  async createProjectWebhook(
    projectGid: string,
    targetUrl: string,
  ): Promise<{ gid: string; secret: string | null; active: boolean }> {
    return this.createResourceWebhook(projectGid, targetUrl);
  }

  async createResourceWebhook(
    resourceGid: string,
    targetUrl: string,
  ): Promise<{ gid: string; secret: string | null; active: boolean }> {
    const response = await fetch(`${ASANA_API}/webhooks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
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
    const payload = await response.json().catch(() => null) as
      | AsanaEnvelope<{ gid: string; active: boolean }>
      | null;
    if (!response.ok || !payload) {
      throw new AsanaApiError(
        payload?.errors?.[0]?.message ??
          `Asana webhook create failed (${response.status})`,
        response.status,
        payload,
      );
    }

    const secret = response.headers.get("X-Hook-Secret") ??
      (payload as AsanaEnvelope<{ gid: string; active: boolean }> & {
        "X-Hook-Secret"?: string;
      })["X-Hook-Secret"] ??
      null;

    return {
      gid: payload.data.gid,
      secret,
      active: payload.data.active,
    };
  }

  async findResourceWebhook(
    workspaceGid: string,
    resourceGid: string,
    targetUrl: string,
  ): Promise<{ gid: string; active: boolean } | null> {
    const query = new URLSearchParams({
      workspace: workspaceGid,
      resource: resourceGid,
      opt_fields: "gid,active,target",
    });
    const webhooks = (await this.request<
      Array<{ gid: string; active: boolean; target?: string }>
    >(`/webhooks?${query}`)).data;
    return webhooks.find((webhook) => webhook.target === targetUrl) ?? null;
  }

  /** Task-level webhooks in the workspace that deliver to targetUrl. */
  async listTaskWebhooks(
    workspaceGid: string,
    targetUrl: string,
  ): Promise<Array<{ gid: string; active: boolean; taskGid: string }>> {
    const webhooks: Array<{ gid: string; active: boolean; taskGid: string }> = [];
    let offset: string | undefined;
    do {
      const query = new URLSearchParams({
        workspace: workspaceGid,
        limit: "100",
        opt_fields: "gid,active,target,resource.gid,resource.resource_type",
      });
      if (offset) query.set("offset", offset);
      const page = await this.request<Array<{
        gid: string;
        active: boolean;
        target?: string;
        resource?: { gid?: string; resource_type?: string };
      }>>(`/webhooks?${query}`);
      for (const webhook of page.data) {
        // Project webhooks share the target; only task webhooks are ours to manage.
        if (webhook.target !== targetUrl) continue;
        if (webhook.resource?.resource_type !== "task" || !webhook.resource.gid) continue;
        webhooks.push({
          gid: webhook.gid,
          active: webhook.active,
          taskGid: webhook.resource.gid,
        });
      }
      offset = page.next_page?.offset;
    } while (offset);
    return webhooks;
  }

  async deleteWebhook(webhookGid: string): Promise<void> {
    await this.request(`/webhooks/${webhookGid}`, { method: "DELETE" });
  }

  async getTaskContext(taskGid: string): Promise<TaskContext> {
    const task = await this.getTask(taskGid);
    const parent = task.parent?.gid
      ? await this.getTask(task.parent.gid)
      : null;
    const editorTarget = parseShopifyEditorUrl(
      [task.notes, task.html_notes, parent?.notes, parent?.html_notes]
        .filter(Boolean)
        .join("\n"),
    );

    return {
      task,
      parent,
      creator: await this.getCommentRecipient(
        task,
        parent,
        Deno.env.get("ASANA_ASSIGNEE_GID") || DEFAULT_ASSIGNEE_GID,
      ),
      editorTarget,
    };
  }
}

export function daysUntilDue(task: Pick<AsanaTask, "due_on" | "due_at">): number | null {
  const dueValue = task.due_on ?? task.due_at?.slice(0, 10);
  if (!dueValue) return null;

  const dueDate = new Date(`${dueValue}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dueDate.getTime() - today.getTime()) / 86_400_000);
}

export function isDueWithinDays(
  task: Pick<AsanaTask, "due_on" | "due_at">,
  days: number,
): boolean {
  const untilDue = daysUntilDue(task);
  if (untilDue === null) return false;
  return untilDue <= days;
}

export function getMissingLinkRecipient(
  designContext: PromoDesignContext,
  fallback: { gid: string; name: string } | null,
  excludeGid?: string,
): { gid: string; name: string } | null {
  const isUploadTask = (name: string) =>
    /\bbanner uploads?\b/i.test(name) && !/\bqa\b/i.test(name);
  const usable = (gid?: string, name?: string) =>
    gid && name && gid !== excludeGid ? { gid, name } : null;

  // QA card nested directly under the Banner Upload task.
  const parent = designContext.parentTask;
  if (parent && isUploadTask(parent.name)) {
    const recipient = usable(parent.assignee?.gid, parent.assignee?.name);
    if (recipient) return recipient;
  }

  // QA card sitting next to a Banner Upload sibling.
  for (const subtask of designContext.subtasks) {
    if (!isUploadTask(subtask.name)) continue;
    const recipient = usable(subtask.assignee_gid, subtask.assignee_name);
    if (recipient) return recipient;
  }
  return usable(fallback?.gid, fallback?.name);
}

export function isPromoQaTask(task: Pick<AsanaTask, "name">): boolean {
  return /\bbanners?\b/i.test(task.name) && /\bqa\b/i.test(task.name);
}

export function parseShopifyEditorUrl(
  text: string,
): ShopifyEditorTarget | null {
  const normalized = text.replaceAll("&amp;", "&");
  const match = normalized.match(
    /https:\/\/admin\.shopify\.com\/store\/([a-z0-9-]+)\/themes\/(\d+)\/editor[^\s<"]*/i,
  );
  if (!match) return null;

  const url = new URL(match[0]);
  const storeSlug = match[1].toLowerCase();
  return {
    url: url.toString(),
    storeSlug,
    shopDomain: `${storeSlug}.myshopify.com`,
    themeId: match[2],
    sectionHint: url.searchParams.get("section") ?? undefined,
    blockHint: url.searchParams.get("block") ?? undefined,
  };
}

export function extractStoreSlugFromText(text: string): string | null {
  const fromEditor = parseShopifyEditorUrl(text)?.storeSlug;
  if (fromEditor) return fromEditor;

  const normalized = text.replaceAll("&amp;", "&");
  const match = normalized.match(
    /admin\.shopify\.com\/store\/([a-z0-9-]+)/i,
  );
  return match ? match[1].toLowerCase() : null;
}

export function buildAsanaCommentHtml(
  creator: { gid: string; name: string } | null,
  message: string,
): string {
  const chunks: string[] = [];
  if (creator) {
    chunks.push(
      `<a data-asana-gid="${escapeHtml(creator.gid)}" data-asana-type="user"></a>`,
    );
  }

  const lines = message.trim().split("\n");
  let intro = "";
  const listItems: string[] = [];
  let currentBanner: { title: string; issues: string[] } | null = null;

  const flushBanner = () => {
    if (!currentBanner) return;
    let item =
      `<li><strong>${escapeAsanaCommentText(currentBanner.title)}</strong>`;
    if (currentBanner.issues.length) {
      item += `<ul>${
        currentBanner.issues.map((issue) =>
          `<li>${escapeAsanaCommentText(issue)}</li>`
        ).join("")
      }</ul>`;
    }
    item += "</li>";
    listItems.push(item);
    currentBanner = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("• ")) {
      flushBanner();
      currentBanner = { title: trimmed.slice(2), issues: [] };
      continue;
    }

    if (trimmed.startsWith("- ") && currentBanner) {
      currentBanner.issues.push(trimmed.slice(2));
      continue;
    }

    if (trimmed.startsWith("Warning:")) {
      flushBanner();
      listItems.push(`<li>${escapeAsanaCommentText(trimmed)}</li>`);
      continue;
    }

    if (currentBanner || listItems.length) {
      flushBanner();
      listItems.push(`<li>${escapeAsanaCommentText(trimmed)}</li>`);
      continue;
    }
    intro = intro
      ? `${intro} ${escapeAsanaCommentText(trimmed)}`
      : escapeAsanaCommentText(trimmed);
  }

  flushBanner();

  if (intro) chunks.push(intro);
  if (listItems.length) chunks.push(`<ul>${listItems.join("")}</ul>`);

  return `<body>${chunks.join("")}</body>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAsanaCommentText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function stripHtml(value: string): string {
  let text = value;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, String.fromCharCode(34));
  text = text.replace(/&#39;/g, String.fromCharCode(39));
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export async function verifyAsanaWebhookSignature(
  secret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!secret || !signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualHex(expected, signature.trim().toLowerCase());
}

export async function verifyAsanaWebhookSignatureAgainstSecrets(
  secrets: string[],
  body: string,
  signature: string | null,
): Promise<boolean> {
  return await findMatchingWebhookSecret(secrets, body, signature) >= 0;
}

/** Index of the secret that signed the body, or -1. */
export async function findMatchingWebhookSecret(
  secrets: string[],
  body: string,
  signature: string | null,
): Promise<number> {
  for (let index = 0; index < secrets.length; index++) {
    if (await verifyAsanaWebhookSignature(secrets[index], body, signature)) {
      return index;
    }
  }
  return -1;
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
