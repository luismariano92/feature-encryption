// Browser UI. Compiled by tsconfig.client.json to public/main.js (no bundler, no dependencies).

interface DirEntry {
  name: string;
  path: string;
}
interface BrowseResult {
  path: string | null;
  parent: string | null;
  dirs: DirEntry[];
}
interface Status {
  configured: boolean;
  webdavUrl: string;
  remoteRoot: string;
  activeJobId: string | null;
}
interface Job {
  id: string;
  status: "running" | "done" | "failed";
  current?: string;
  totalFiles: number;
  changedFiles: number;
  uploadedFiles: number;
  uploadedBytes: number;
  failed: { path: string; error: string }[];
  error?: string;
}
interface NtfyStatus {
  enabled: boolean;
  server: string;
  topic: string;
  hasToken: boolean;
}
interface ScheduledJob {
  id: string;
  name: string;
  paths: string[];
  time: string;
  recurrence: "once" | "daily" | "weekly";
  daysOfWeek?: number[];
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: "done" | "failed";
  nextRunAt?: string;
}
const STORAGE_KEY = "backup-tool:selected";
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  status: el("server-status"),
  checkBtn: el<HTMLButtonElement>("check-btn"),
  error: el("error"),
  upBtn: el<HTMLButtonElement>("up-btn"),
  currentPath: el("current-path"),
  dirList: el<HTMLUListElement>("dir-list"),
  selectedList: el<HTMLUListElement>("selected-list"),
  selectedEmpty: el("selected-empty"),
  backupBtn: el<HTMLButtonElement>("backup-btn"),
  job: el("job"),
  progressBar: el("progress-bar"),
  jobSummary: el("job-summary"),
  jobFailures: el<HTMLUListElement>("job-failures"),
  addFolderBtn: el<HTMLButtonElement>("add-folder-btn"),
  newScheduleBtn: el<HTMLButtonElement>("new-schedule-btn"),
  scheduleList: el("schedule-list"),
  scheduleForm: el("schedule-form"),
  schedFormTitle: el("schedule-form-title"),
  schedName: el<HTMLInputElement>("sched-name"),
  schedTime: el<HTMLInputElement>("sched-time"),
  schedRecurrence: el<HTMLSelectElement>("sched-recurrence"),
  schedDaysGroup: el("sched-days-group"),
  schedPathList: el<HTMLUListElement>("sched-path-list"),
  schedAddPathBtn: el<HTMLButtonElement>("sched-add-path-btn"),
  schedSaveBtn: el<HTMLButtonElement>("sched-save-btn"),
  schedCancelBtn: el<HTMLButtonElement>("sched-cancel-btn"),
  ntfyStatus: el("ntfy-status"),
  ntfyDetails: el("ntfy-details"),
  ntfyTestBtn: el<HTMLButtonElement>("ntfy-test-btn"),
  ntfyResult: el("ntfy-result"),
};

let parentPath: string | null = null;
let currentBrowsePath: string | null = null;
let configured = false;
let jobRunning = false;
const selected = new Set<string>(loadSelection());

function loadSelection(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function saveSelection(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...selected]));
  } catch {
    // Storage unavailable (private mode etc.): selection just won't persist.
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

function showError(err: unknown): void {
  ui.error.textContent = err instanceof Error ? err.message : String(err);
  ui.error.hidden = false;
}

function clearError(): void {
  ui.error.hidden = true;
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function li(...children: Node[]): HTMLLIElement {
  const item = document.createElement("li");
  item.append(...children);
  return item;
}

function updateAddBtn(): void {
  ui.addFolderBtn.disabled = currentBrowsePath === null || selected.has(currentBrowsePath);
}

function addCurrentFolder(): void {
  if (!currentBrowsePath || selected.has(currentBrowsePath)) return;
  selected.add(currentBrowsePath);
  saveSelection();
  renderSelected();
  updateAddBtn();
}

async function browse(path: string | null): Promise<void> {
  try {
    const result = await api<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    clearError();
    parentPath = result.parent;
    currentBrowsePath = result.path;
    ui.currentPath.textContent = result.path ?? "Drives";
    ui.upBtn.disabled = result.path === null;
    updateAddBtn();
    ui.dirList.replaceChildren(
      ...result.dirs.map((dir) => {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "link name";
        open.textContent = dir.name;
        open.addEventListener("click", () => void browse(dir.path));
        return li(open);
      }),
    );
    if (result.dirs.length === 0) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "No subfolders";
      ui.dirList.append(li(empty));
    }
  } catch (err) {
    showError(err);
  }
}

function renderSelected(): void {
  ui.selectedList.replaceChildren(
    ...[...selected].sort().map((p) => {
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        selected.delete(p);
        saveSelection();
        renderSelected();
        updateAddBtn();
      });
      return li(name, remove);
    }),
  );
  ui.selectedEmpty.hidden = selected.size > 0;
  ui.backupBtn.disabled = !configured || jobRunning || selected.size === 0;
}

function renderJob(job: Job): void {
  ui.job.hidden = false;
  const pct = job.changedFiles > 0 ? (job.uploadedFiles / job.changedFiles) * 100 : job.status === "running" ? 0 : 100;
  ui.progressBar.style.width = `${pct}%`;
  ui.progressBar.classList.toggle("done", job.status === "done");

  if (job.status === "running") {
    ui.jobSummary.textContent =
      `Uploading ${job.uploadedFiles} of ${job.changedFiles} changed files` +
      (job.current ? ` from ${job.current}` : "") +
      ` (${formatBytes(job.uploadedBytes)})…`;
  } else if (job.status === "failed") {
    ui.jobSummary.textContent = `Backup failed: ${job.error ?? "unknown error"}`;
  } else if (job.changedFiles === 0) {
    ui.jobSummary.textContent = `Everything is up to date (${job.totalFiles} files checked).`;
  } else {
    ui.jobSummary.textContent =
      `Done: uploaded ${job.uploadedFiles} of ${job.changedFiles} changed files ` +
      `(${formatBytes(job.uploadedBytes)}); ${job.totalFiles} files checked.`;
  }

  ui.jobFailures.replaceChildren(
    ...job.failed.map((f) => {
      const text = document.createTextNode(`${f.path}: ${f.error}`);
      return li(text);
    }),
  );
}

async function followJob(id: string): Promise<void> {
  jobRunning = true;
  renderSelected();
  try {
    for (;;) {
      const job = await api<Job>(`/api/jobs/${id}`);
      renderJob(job);
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    showError(err);
  } finally {
    jobRunning = false;
    renderSelected();
  }
}

async function startBackup(): Promise<void> {
  try {
    clearError();
    const { jobId } = await api<{ jobId: string }>("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [...selected] }),
    });
    await followJob(jobId);
  } catch (err) {
    showError(err);
  }
}

async function checkConnection(): Promise<void> {
  ui.checkBtn.disabled = true;
  try {
    const result = await api<{ ok: boolean; status?: number; error?: string }>("/api/check");
    ui.status.classList.toggle("ok", result.ok);
    ui.status.classList.toggle("bad", !result.ok);
    if (!result.ok) showError(`WebDAV check failed: ${result.error ?? `HTTP ${result.status}`}`);
    else clearError();
  } catch (err) {
    showError(err);
  } finally {
    ui.checkBtn.disabled = !configured;
  }
}

let schedules: ScheduledJob[] = [];
let editingScheduleId: string | null = null;
const schedulePaths = new Set<string>();

async function loadSchedules(): Promise<void> {
  try {
    schedules = await api<ScheduledJob[]>("/api/schedules");
    renderSchedules();
  } catch (err) {
    showError(err);
  }
}

function formatNextRun(iso?: string): string {
  if (!iso) return "Not scheduled";
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff < 0) return "Overdue";
  if (diff < 60_000) return "Less than a minute";
  if (diff < 3_600_000) return `In ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `Today at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderSchedules(): void {
  if (schedules.length === 0) {
    ui.scheduleList.textContent = "";
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No scheduled backups yet.";
    ui.scheduleList.appendChild(empty);
    return;
  }
  ui.scheduleList.textContent = "";
  for (const s of schedules) {
    const card = document.createElement("div");
    card.className = "schedule-card";

    const name = document.createElement("span");
    name.className = "sched-name";
    name.textContent = s.name;

    const meta = document.createElement("span");
    meta.className = "sched-meta";
    let recText = s.recurrence === "once" ? "Once" : s.recurrence === "weekly" ? "Weekly" : "Daily";
    if (s.recurrence === "daily" && s.daysOfWeek) {
      recText += " (" + s.daysOfWeek.map((d) => DAY_NAMES[d]).join(", ") + ")";
    }
    recText += " at " + s.time;
    meta.textContent = recText;

    const nextRun = document.createElement("span");
    nextRun.className = "schedule-status" + (s.lastRunStatus ? ` ${s.lastRunStatus}` : "");
    nextRun.textContent = s.enabled ? formatNextRun(s.nextRunAt) : "Disabled";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "toggle-switch";
    toggle.checked = s.enabled;
    toggle.addEventListener("change", () => void toggleSchedule(s.id, toggle.checked));

    const actions = document.createElement("span");
    actions.className = "sched-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => showScheduleForm(s));

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.textContent = "Run Now";
    runBtn.addEventListener("click", () => void runScheduleNow(s.id));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => void deleteSchedule(s.id));

    actions.append(editBtn, runBtn, delBtn);
    card.append(name, meta, nextRun, toggle, actions);
    ui.scheduleList.appendChild(card);
  }
}

function showScheduleForm(schedule?: ScheduledJob): void {
  editingScheduleId = schedule?.id ?? null;
  ui.schedFormTitle.textContent = schedule ? "Edit Schedule" : "New Schedule";
  ui.schedName.value = schedule?.name ?? "";
  ui.schedTime.value = schedule?.time ?? "";
  ui.schedRecurrence.value = schedule?.recurrence ?? "daily";
  schedulePaths.clear();
  if (schedule) schedule.paths.forEach((p) => schedulePaths.add(p));
  renderSchedulePaths();
  updateDaysVisibility();
  if (schedule?.daysOfWeek) {
    const checks = ui.schedDaysGroup.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    checks.forEach((cb) => { cb.checked = schedule.daysOfWeek!.includes(Number(cb.value)); });
  } else {
    ui.schedDaysGroup.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  }
  ui.scheduleForm.hidden = false;
}

function hideScheduleForm(): void {
  ui.scheduleForm.hidden = true;
  editingScheduleId = null;
  schedulePaths.clear();
}

function updateDaysVisibility(): void {
  ui.schedDaysGroup.hidden = ui.schedRecurrence.value !== "daily";
}

function renderSchedulePaths(): void {
  ui.schedPathList.replaceChildren(
    ...[...schedulePaths].sort().map((p) => {
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        schedulePaths.delete(p);
        renderSchedulePaths();
      });
      return li(name, remove);
    }),
  );
}

function addSchedulePath(): void {
  if (!currentBrowsePath || schedulePaths.has(currentBrowsePath)) return;
  schedulePaths.add(currentBrowsePath);
  renderSchedulePaths();
}

async function saveSchedule(): Promise<void> {
  const name = ui.schedName.value.trim();
  const time = ui.schedTime.value;
  const recurrence = ui.schedRecurrence.value as "once" | "daily" | "weekly";
  const paths = [...schedulePaths];

  let daysOfWeek: number[] | undefined;
  if (recurrence === "daily") {
    daysOfWeek = [...ui.schedDaysGroup.querySelectorAll<HTMLInputElement>("input:checked")].map((cb) => Number(cb.value));
  }

  const payload = { name, time, recurrence, paths, daysOfWeek, enabled: true };
  try {
    clearError();
    if (editingScheduleId) {
      await api(`/api/schedules/${editingScheduleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await api("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    hideScheduleForm();
    await loadSchedules();
  } catch (err) {
    showError(err);
  }
}

async function deleteSchedule(id: string): Promise<void> {
  try {
    clearError();
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    await loadSchedules();
  } catch (err) {
    showError(err);
  }
}

async function toggleSchedule(id: string, enabled: boolean): Promise<void> {
  const s = schedules.find((s) => s.id === id);
  if (!s) return;
  try {
    await api(`/api/schedules/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...s, enabled }),
    });
    await loadSchedules();
  } catch (err) {
    showError(err);
  }
}

async function runScheduleNow(id: string): Promise<void> {
  try {
    clearError();
    const { jobId } = await api<{ jobId: string }>(`/api/schedules/${id}/run`, { method: "POST" });
    await followJob(jobId);
  } catch (err) {
    showError(err);
  }
}

async function loadNtfyStatus(): Promise<void> {
  try {
    const status = await api<NtfyStatus>("/api/ntfy");
    if (status.enabled && status.topic) {
      ui.ntfyStatus.textContent = "Enabled";
      ui.ntfyStatus.className = "badge ok";
      ui.ntfyDetails.textContent = `${status.server} / ${status.topic}`;
      ui.ntfyTestBtn.disabled = false;
    } else {
      ui.ntfyStatus.textContent = "Not configured";
      ui.ntfyStatus.className = "badge";
      ui.ntfyDetails.textContent = status.enabled ? "No topic set" : "";
      ui.ntfyTestBtn.disabled = true;
    }
  } catch {
    ui.ntfyStatus.textContent = "Error";
    ui.ntfyStatus.className = "badge bad";
    ui.ntfyTestBtn.disabled = true;
  }
}

async function sendTestNtfy(): Promise<void> {
  ui.ntfyTestBtn.disabled = true;
  ui.ntfyResult.hidden = true;
  try {
    const result = await api<{ ok: boolean; error?: string }>("/api/ntfy/test", { method: "POST" });
    ui.ntfyResult.hidden = false;
    if (result.ok) {
      ui.ntfyResult.textContent = "Test notification sent successfully.";
      ui.ntfyResult.className = "ntfy-result ok";
    } else {
      ui.ntfyResult.textContent = `Failed: ${result.error ?? "unknown error"}`;
      ui.ntfyResult.className = "ntfy-result fail";
    }
  } catch (err) {
    ui.ntfyResult.hidden = false;
    ui.ntfyResult.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    ui.ntfyResult.className = "ntfy-result fail";
  } finally {
    ui.ntfyTestBtn.disabled = false;
  }
}

async function init(): Promise<void> {
  ui.upBtn.addEventListener("click", () => void browse(parentPath));
  ui.backupBtn.addEventListener("click", () => void startBackup());
  ui.checkBtn.addEventListener("click", () => void checkConnection());
  ui.addFolderBtn.addEventListener("click", addCurrentFolder);
  ui.newScheduleBtn.addEventListener("click", () => showScheduleForm());
  ui.schedCancelBtn.addEventListener("click", hideScheduleForm);
  ui.schedSaveBtn.addEventListener("click", () => void saveSchedule());
  ui.schedAddPathBtn.addEventListener("click", addSchedulePath);
  ui.schedRecurrence.addEventListener("change", updateDaysVisibility);
  ui.ntfyTestBtn.addEventListener("click", () => void sendTestNtfy());

  try {
    const status = await api<Status>("/api/status");
    configured = status.configured;
    if (configured) {
      ui.status.textContent = `${status.webdavUrl.replace(/\/$/, "")}/${status.remoteRoot}`;
    } else {
      ui.status.textContent = "No server";
    }
    ui.checkBtn.disabled = !configured;
    if (status.activeJobId) void followJob(status.activeJobId);
  } catch (err) {
    showError(err);
  }
  renderSelected();
  await browse(null);
  await loadSchedules();
  await loadNtfyStatus();
}

void init();
