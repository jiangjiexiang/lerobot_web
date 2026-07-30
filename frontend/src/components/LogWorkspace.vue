<template>
  <main class="log-workspace">
    <section class="log-toolbar">
      <div>
        <h2>日志管理</h2>
        <p>每次启动生成独立日志，保存在机器人本地：{{ archiveRoot || "正在读取…" }}</p>
      </div>
      <div class="actions">
        <button :disabled="!filteredLogs.length" @click="exportLogs">导出 TXT</button>
        <button @click="loadArchive">刷新</button>
        <button class="danger" :disabled="!logs.length" @click="$emit('clear')">清空当前会话</button>
      </div>
    </section>

    <section class="log-body">
      <aside class="date-list">
        <header>启动会话 <span>{{ files.length }}</span></header>
        <button class="session" :class="{ active: selectedDate === 'session' }" @click="selectedDate = 'session'">
          <strong>当前会话</strong><small>{{ logs.length }} 条</small>
        </button>
        <button v-for="file in files" :key="file.id" :class="{ active: selectedDate === file.id }" @click="selectDate(file.id)">
          <strong>{{ file.current ? "本次启动" : formatSession(file) }}</strong>
          <small>{{ file.legacy ? "旧版每日归档 · " : "" }}{{ file.lines }} 条 · {{ formatBytes(file.bytes) }}</small>
        </button>
        <p v-if="!files.length && !loading" class="date-empty">还没有本地日志文件</p>
      </aside>

      <div class="log-content">
        <section class="log-filters">
          <input v-model.trim="query" type="search" placeholder="搜索日志内容…" />
          <select v-model="level">
            <option value="all">全部级别</option><option value="error">错误</option>
            <option value="warn">警告</option><option value="info">信息</option>
          </select>
          <select v-model="source">
            <option value="all">全部来源</option><option value="teleop">遥操作</option>
            <option value="recorder">录制</option><option value="system">系统</option>
          </select>
          <span>{{ selectedDate === "session" ? "当前会话" : selectedDate }} · {{ filteredLogs.length }} 条</span>
        </section>

        <section class="log-list" aria-live="polite">
          <p v-if="loading" class="empty">正在读取本地日志…</p>
          <p v-else-if="loadError" class="empty error-text">{{ loadError }}</p>
          <p v-else-if="!filteredLogs.length" class="empty">没有符合条件的日志</p>
          <article v-for="(item, index) in filteredLogs" :key="`${item.timestamp}-${index}`" :class="item.level">
            <span class="level-dot"></span>
            <time>{{ formatTime(item.timestamp) }}</time>
            <code>[{{ sourceName(item.source) }}/{{ levelName(item.level) }}] {{ item.message }}</code>
          </article>
        </section>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

type Level = "info" | "warn" | "error";
type Source = "teleop" | "recorder" | "system";
interface LogEntry { timestamp: string; source: Source; level: Level; message: string }
interface LogFile { id: string; date: string; startedAt: string; current: boolean; legacy: boolean; lines: number; bytes: number }

const props = defineProps<{ logs: string[] }>();
defineEmits<{ clear: [] }>();
const query = ref("");
const level = ref<"all" | Level>("all");
const source = ref<"all" | Source>("all");
const files = ref<LogFile[]>([]);
const archivedEntries = ref<LogEntry[]>([]);
const selectedDate = ref("session");
const archiveRoot = ref("");
const loading = ref(false);
const loadError = ref("");

function parseSessionLine(line: string): LogEntry {
  const match = line.match(/^\[([^\]]+)\]\s*(?:\[([^/]+)\/([^\]]+)\]\s*)?(.*)$/);
  const levelText = match?.[3] || "";
  return {
    timestamp: `${new Date().toISOString().slice(0, 10)}T${match?.[1] || "00:00:00"}`,
    source: match?.[2] === "录制" ? "recorder" : match?.[2] === "遥操作" ? "teleop" : "system",
    level: levelText === "错误" ? "error" : levelText === "警告" ? "warn" : "info",
    message: match?.[4] || line,
  };
}

const visibleEntries = computed(() => selectedDate.value === "session"
  ? props.logs.map(parseSessionLine)
  : archivedEntries.value);
const filteredLogs = computed(() => visibleEntries.value.filter((item) => {
  if (query.value && !item.message.toLowerCase().includes(query.value.toLowerCase())) return false;
  if (level.value !== "all" && item.level !== level.value) return false;
  if (source.value !== "all" && item.source !== source.value) return false;
  return true;
}));

async function loadArchive() {
  loading.value = true; loadError.value = "";
  try {
    const response = await fetch("/api/logs");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取日志目录失败");
    files.value = data.files || [];
    archiveRoot.value = data.root || "";
    if (selectedDate.value !== "session") await selectDate(selectedDate.value);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally { loading.value = false; }
}

async function selectDate(date: string) {
  selectedDate.value = date; loading.value = true; loadError.value = "";
  try {
    const response = await fetch(`/api/logs/${encodeURIComponent(date)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取日志文件失败");
    archivedEntries.value = data.entries || [];
  } catch (error) {
    archivedEntries.value = [];
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally { loading.value = false; }
}

function sourceName(value: Source) { return value === "recorder" ? "录制" : value === "teleop" ? "遥操作" : "系统"; }
function levelName(value: Level) { return value === "error" ? "错误" : value === "warn" ? "警告" : "信息"; }
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false });
}
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function formatSession(file: LogFile) {
  if (file.legacy) return file.date;
  const date = new Date(file.startedAt);
  return Number.isNaN(date.getTime())
    ? file.id
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function exportLogs() {
  const content = [...filteredLogs.value].reverse().map((item) =>
    `[${formatTime(item.timestamp)}] [${sourceName(item.source)}/${levelName(item.level)}] ${item.message}`).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `lerobot-log-${selectedDate.value}.txt`; link.click();
  URL.revokeObjectURL(url);
}

watch(selectedDate, (date) => { if (date === "session") { loadError.value = ""; archivedEntries.value = []; } });
onMounted(loadArchive);
</script>

<style scoped>
.log-workspace { max-width: 1500px; margin: 0 auto; padding: 24px 28px; }
.log-toolbar,.log-body { border: 1px solid rgba(151,188,222,.15); background: rgba(15,30,50,.86); }
.log-toolbar { display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px;border-radius:14px 14px 0 0; }
.log-toolbar h2 { font-size:17px; }.log-toolbar p { margin-top:5px;color:#708ca2;font-size:11px; }
.actions { display:flex;gap:8px; } button,input,select { border:1px solid rgba(139,196,221,.22);border-radius:7px;color:#a9c6d8;background:#0b1c2d; }
button { padding:8px 12px;cursor:pointer; } button.danger { color:#ff9aaa;border-color:rgba(255,122,143,.25); } button:disabled { opacity:.4;cursor:default; }
.log-body { display:grid;grid-template-columns:210px minmax(0,1fr);min-height:500px;border-top:0;border-radius:0 0 14px 14px;overflow:hidden; }
.date-list { border-right:1px solid rgba(151,188,222,.13);background:#091522; }
.date-list header { display:flex;justify-content:space-between;padding:14px;color:#7995a9;font-size:10px; }
.date-list button { display:grid;width:100%;gap:4px;padding:11px 14px;border:0;border-radius:0;border-top:1px solid rgba(83,112,139,.1);text-align:left; }
.date-list button.active { background:#102b40;box-shadow:inset 3px 0 #61c5e6; }.date-list strong { font-size:11px; }.date-list small { color:#607c91;font-size:9px; }
.date-empty { padding:18px 14px;color:#58758b;font-size:10px; }.log-content { min-width:0; }
.log-filters { display:grid;grid-template-columns:minmax(180px,1fr) 120px 120px auto;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(151,188,222,.13); }
.log-filters input,.log-filters select { min-height:36px;padding:7px 10px;outline:none; }.log-filters span { color:#67849a;font-size:10px;text-align:right; }
.log-list { height:calc(100vh - 220px);min-height:440px;overflow:auto;background:rgba(5,14,24,.94); }
.log-list article { display:grid;grid-template-columns:7px 68px minmax(0,1fr);align-items:start;gap:9px;padding:9px 14px;border-bottom:1px solid rgba(83,112,139,.09); }
.log-list time { color:#58758b;font:10px/1.6 ui-monospace,monospace; }.log-list code { color:#9eb5c7;font:11px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere; }
.level-dot { width:6px;height:6px;margin-top:6px;border-radius:50%;background:#62c995; }.log-list article.warn .level-dot { background:#e6bd67; }
.log-list article.error .level-dot { background:#ef7185; }.log-list article.error code,.error-text { color:#e8a1ad; }
.empty { padding:80px 20px;color:#58758b;text-align:center;font-size:12px; }
@media (max-width:760px) { .log-workspace{padding:12px}.log-toolbar{align-items:flex-start;flex-direction:column}.log-body{grid-template-columns:1fr}.date-list{display:flex;overflow:auto;border-right:0}.date-list header,.date-empty{display:none}.date-list button{min-width:130px}.log-filters{grid-template-columns:1fr 1fr}.log-filters input{grid-column:1/-1} }
</style>
