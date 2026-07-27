<template>
  <main class="training-workspace">
    <header class="training-head">
      <div><p class="eyebrow">MODEL TRAINING</p><h2>训练管理</h2></div>
      <button class="refresh" title="刷新主机与任务状态" :disabled="loading" @click="refreshAll">↻</button>
    </header>

    <div v-if="error" class="training-error">{{ error }}<button @click="error = null">×</button></div>

    <section class="host-strip" aria-label="主机性能">
      <div><small>GPU</small><strong>{{ host?.gpu?.name || "未检测到" }}</strong><span>{{ host?.gpu?.available ? `${host.gpu.memoryGb || "共享"} GB · CUDA 可用` : host?.gpu?.hardwareDetected ? "硬件已识别 · 当前 PyTorch 无 CUDA" : "仅 CPU" }}</span></div>
      <div><small>内存</small><strong>{{ host?.memory?.freeGb ?? "-" }} GB</strong><span>可用 / {{ host?.memory?.totalGb ?? "-" }} GB</span></div>
      <div><small>磁盘</small><strong>{{ host?.disk?.freeGb ?? "-" }} GB</strong><span>可用 / {{ host?.disk?.totalGb ?? "-" }} GB</span></div>
      <div><small>CPU</small><strong>{{ host?.cpu?.cores ?? "-" }} 核</strong><span :title="host?.cpu?.model">负载 {{ host?.cpu?.load?.toFixed(2) ?? "-" }}</span></div>
      <div class="recommendation"><small>建议配置</small><strong>{{ host?.recommendation?.cameraResolution || "640x360" }}</strong><span>ACT batch ≤ {{ host?.recommendation?.actBatchSize || 8 }}</span></div>
    </section>

    <div class="training-layout">
      <section class="config-pane" aria-label="新建训练任务">
        <div class="pane-heading"><div><p class="eyebrow">NEW JOB</p><h3>新建任务</h3></div><span>本地训练</span></div>
        <div class="form-grid">
          <label>任务名称<input v-model.trim="form.name" maxlength="80" placeholder="act_pick_cube_v1" /></label>
          <label>数据集<select v-model="form.dataset" @change="loadCollections"><option value="" disabled>选择数据集</option><option v-for="item in datasets" :key="item.name" :value="item.name">{{ item.name }} · {{ item.reviews.approved }} 已通过</option></select></label>
          <label>训练选集<select v-model="form.collection"><option value="" disabled>选择已发布版本</option><option v-for="item in collections" :key="item.id" :value="item.id">{{ item.id }} · {{ item.name }} · {{ item.episodes.length }} Episodes</option></select></label>
          <label>策略<select v-model="form.policy"><option v-for="item in policies" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
          <label>设备<select v-model="form.device"><option value="cuda" :disabled="!host?.gpu?.available">CUDA</option><option value="cpu">CPU</option></select></label>
          <label>Batch size<input v-model.number="form.batchSize" type="number" min="1" max="1024" /></label>
          <label>训练步数<input v-model.number="form.steps" type="number" min="1" max="10000000" step="1000" /></label>
        </div>
        <div v-if="configurationWarning" class="config-warning">{{ configurationWarning }}</div>
        <div class="training-flags"><span>不上传 Hugging Face</span><span>WandB 关闭</span><span>保存 Checkpoint</span></div>
        <button class="create-job" :disabled="creating || !formValid" @click="createJob">{{ creating ? "创建中…" : "创建训练任务" }}</button>
      </section>

      <section class="jobs-pane" aria-label="训练任务列表">
        <div class="pane-heading"><div><p class="eyebrow">JOB QUEUE</p><h3>任务队列</h3></div><span>{{ runningJobs }} 运行中 / {{ jobs.length }} 总计</span></div>
        <div v-if="jobs.length" class="job-list">
          <button v-for="job in jobs" :key="job.id" :class="{ active: selectedJob?.id === job.id }" @click="selectedJobId = job.id">
            <i :class="job.state"></i>
            <span><strong>{{ job.name }}</strong><small>{{ job.policy.toUpperCase() }} · {{ job.dataset }} / {{ job.collection }}</small></span>
            <em :class="job.state">{{ jobState(job.state) }}</em>
          </button>
        </div>
        <div v-else class="empty">尚无训练任务</div>
      </section>

      <section class="job-detail" aria-label="训练任务详情">
        <template v-if="selectedJob">
          <div class="job-title"><div><p class="eyebrow">{{ selectedJob.id }}</p><h3>{{ selectedJob.name }}</h3></div><span :class="['job-state', selectedJob.state]">{{ jobState(selectedJob.state) }}</span></div>
          <div class="job-facts"><span>{{ selectedJob.policy.toUpperCase() }}</span><span>{{ selectedJob.device.toUpperCase() }}</span><span>Batch {{ selectedJob.batchSize }}</span><span>{{ selectedJob.steps.toLocaleString() }} steps</span><span>{{ selectedJob.episodes.length }} Episodes</span></div>
          <dl><div><dt>训练选集</dt><dd>{{ selectedJob.dataset }} / {{ selectedJob.collection }}</dd></div><div><dt>输出目录</dt><dd>{{ selectedJob.outputDir }}</dd></div><div><dt>创建时间</dt><dd>{{ formatDate(selectedJob.createdAt) }}</dd></div></dl>
          <div class="job-actions"><button v-if="['draft','failed'].includes(selectedJob.state)" :disabled="runningJobs > 0" @click="startJob(selectedJob.id)">▶ 启动训练</button><button v-if="selectedJob.state === 'running'" class="stop" @click="stopJob(selectedJob.id)">■ 停止</button></div>
          <div class="command"><div><strong>执行命令</strong><button title="复制命令" @click="copyCommand">复制</button></div><code>{{ commandText }}</code></div>
          <div class="logs"><div><strong>训练日志</strong><span>{{ selectedJob.logs.length }} 行</span></div><pre>{{ selectedJob.logs.join("\n") || "任务尚未启动" }}</pre></div>
          <p v-if="selectedJob.error" class="job-error">{{ selectedJob.error }}</p>
        </template>
        <div v-else class="empty">选择一个任务查看配置和日志</div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

interface DatasetSummary { name: string; reviews: { approved: number } }
interface Collection { id: string; name: string; episodes: { episode: number }[] }
interface HostProfile { gpu: { available: boolean; hardwareDetected?: boolean; name: string | null; memoryGb: number | null }; memory: { totalGb: number; freeGb: number }; disk: { totalGb: number; freeGb: number }; cpu: { model: string; cores: number; load: number }; recommendation: { device: string; cameraResolution: string; actBatchSize: number } }
type JobState = "draft" | "running" | "stopping" | "completed" | "failed";
interface TrainingJob { id: string; name: string; dataset: string; collection: string; episodes: number[]; policy: string; device: string; batchSize: number; steps: number; state: JobState; createdAt: string; outputDir: string; command: string[]; error: string | null; logs: string[] }

const host = ref<HostProfile | null>(null);
const datasets = ref<DatasetSummary[]>([]);
const collections = ref<Collection[]>([]);
const jobs = ref<TrainingJob[]>([]);
const selectedJobId = ref("");
const loading = ref(false);
const creating = ref(false);
const error = ref<string | null>(null);
let pollTimer: number | null = null;

const policies = [
  { value: "act", label: "ACT（新手推荐）" }, { value: "diffusion", label: "Diffusion Policy" },
  { value: "tdmpc", label: "TDMPC" }, { value: "vqbet", label: "VQ-BeT" },
  { value: "smolvla", label: "SmolVLA" }, { value: "pi0", label: "Pi0" },
  { value: "pi0-fast", label: "Pi0 Fast" }, { value: "sac", label: "SAC" },
  { value: "reward_classifier", label: "Reward Classifier" },
];
const form = reactive({ name: "", dataset: "", collection: "", policy: "act", device: "cuda", batchSize: 8, steps: 20000 });
const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedJobId.value) || jobs.value[0] || null);
const runningJobs = computed(() => jobs.value.filter((job) => ["running", "stopping"].includes(job.state)).length);
const formValid = computed(() => Boolean(form.name && form.dataset && form.collection && form.batchSize > 0 && form.steps > 0));
const commandText = computed(() => selectedJob.value ? ["python", ...selectedJob.value.command].map(shellQuote).join(" ") : "");
const configurationWarning = computed(() => {
  if (["pi0", "pi0-fast"].includes(form.policy)) return "Pi0 需要先安装 lerobot[pi] 依赖。";
  if (form.policy === "smolvla" && form.batchSize > 28 && Number(host.value?.gpu?.memoryGb || 0) <= 8) return "8GB 显存运行 SmolVLA 时，建议 batch size 不超过 28。";
  if (form.device === "cuda" && !host.value?.gpu?.available) return "当前未检测到 CUDA，需改用 CPU 或修复 PyTorch CUDA 环境。";
  return "";
});

async function requestJson(url: string, init?: RequestInit) { const response = await fetch(url, init); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
async function refreshHost() { const data = await requestJson("/api/training/host") as HostProfile; host.value = data; if (!data.gpu.available) form.device = "cpu"; if (!form.batchSize) form.batchSize = data.recommendation.actBatchSize; }
async function refreshJobs() { const data = await requestJson("/api/training/jobs"); jobs.value = data.jobs || []; if (!selectedJobId.value && jobs.value.length) selectedJobId.value = jobs.value[0].id; }
async function refreshAll() { loading.value = true; error.value = null; try { const data = await requestJson("/api/datasets"); datasets.value = data.datasets || []; await Promise.all([refreshHost(), refreshJobs()]); if (!form.dataset && datasets.value.length) { form.dataset = datasets.value[0].name; await loadCollections(); } } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { loading.value = false; } }
async function loadCollections() { form.collection = ""; if (!form.dataset) return; try { const data = await requestJson(`/api/datasets/${encodeURIComponent(form.dataset)}/collections`); collections.value = data.collections || []; if (collections.value.length) form.collection = collections.value[0].id; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function createJob() { if (!formValid.value || creating.value) return; creating.value = true; error.value = null; try { const data = await requestJson("/api/training/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }); jobs.value.unshift(data.job); selectedJobId.value = data.job.id; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { creating.value = false; } }
async function startJob(id: string) { try { await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/start`, { method: "POST" }); await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function stopJob(id: string) { try { await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/stop`, { method: "POST" }); await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function copyCommand() { if (commandText.value) await navigator.clipboard.writeText(commandText.value).catch(() => undefined); }
function shellQuote(value: string) { return /^[A-Za-z0-9_./:=,\[\]-]+$/.test(value) ? value : `'${value.split("'").join("'\\''")}'`; }
function jobState(state: JobState) { return ({ draft: "待启动", running: "训练中", stopping: "停止中", completed: "已完成", failed: "失败" })[state]; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

onMounted(() => { void refreshAll(); pollTimer = window.setInterval(() => { if (runningJobs.value) void refreshJobs(); }, 2000); });
onUnmounted(() => { if (pollTimer) window.clearInterval(pollTimer); });
</script>

<style scoped>
.training-workspace { container-type: inline-size; max-width: 1900px; margin: 0 auto; padding: 18px 24px 28px; }.training-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }.training-head h2 { margin-top: 2px; font-size: 20px; }.eyebrow { color: #78a9c6; font-size: 9px; font-weight: 700; letter-spacing: 1px; }.refresh { width: 32px; height: 32px; border: 1px solid #315574; border-radius: 5px; background: #102941; color: #8dd4f4; cursor: pointer; font-size: 18px; }
.training-error { display: flex; justify-content: space-between; margin-bottom: 8px; padding: 8px 11px; border-left: 3px solid #ff7384; background: #25141b; color: #ffadb7; font-size: 10px; }.training-error button { border: 0; background: transparent; color: inherit; cursor: pointer; }
.host-strip { display: grid; grid-template-columns: 1.35fr repeat(4,1fr); border: 1px solid rgba(151,188,222,.15); background: #0b1724; }.host-strip > div { display: grid; gap: 4px; min-width: 0; padding: 11px 13px; border-right: 1px solid rgba(151,188,222,.12); }.host-strip > div:last-child { border-right: 0; }.host-strip small { color: #7890a3; font-size: 8px; }.host-strip strong { overflow: hidden; color: #e7f1f7; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }.host-strip span { overflow: hidden; color: #587185; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }.host-strip .recommendation { background: #10251f; }.host-strip .recommendation strong { color: #72d2a5; }
.training-layout { display: grid; grid-template-columns: 310px 280px minmax(400px,1fr); min-height: calc(100vh - 190px); border: 1px solid rgba(151,188,222,.15); border-top: 0; background: #0d1928; }.config-pane,.jobs-pane,.job-detail { min-width: 0; padding: 14px; }.config-pane,.jobs-pane { border-right: 1px solid rgba(151,188,222,.13); }.pane-heading,.job-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 14px; }.pane-heading h3,.job-title h3 { margin-top: 2px; font-size: 13px; }.pane-heading > span { color: #70899c; font-size: 8px; }
.form-grid { display: grid; gap: 9px; }.form-grid label { display: grid; gap: 4px; color: #8ca2b3; font-size: 9px; }.form-grid input,.form-grid select { width: 100%; min-width: 0; padding: 8px; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #091522; color: #e7edf8; font-size: 10px; }.form-grid input:focus,.form-grid select:focus { border-color: #5a8bad; }.config-warning { margin-top: 9px; padding: 7px 8px; border-left: 2px solid #e4b85d; background: #282218; color: #d8b970; font-size: 8px; line-height: 1.5; }.training-flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }.training-flags span { padding: 3px 5px; border-radius: 3px; background: #142638; color: #6f899c; font-size: 8px; }.create-job { width: 100%; margin-top: 12px; padding: 9px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.create-job:disabled { cursor: not-allowed; opacity: .45; }
.job-list { margin: 0 -14px; border-top: 1px solid rgba(151,188,222,.1); }.job-list button { display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: 8px; width: 100%; padding: 11px 12px; border: 0; border-bottom: 1px solid rgba(151,188,222,.08); cursor: pointer; text-align: left; background: transparent; color: #dce8f2; }.job-list button:hover,.job-list button.active { background: #14283b; }.job-list i { width: 7px; height: 7px; border-radius: 50%; background: #718494; }.job-list i.running { background: #64c9e8; box-shadow: 0 0 8px #64c9e8; }.job-list i.completed { background: #54c994; }.job-list i.failed { background: #e86676; }.job-list span { display: grid; min-width: 0; gap: 3px; }.job-list strong,.job-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.job-list strong { font-size: 9px; }.job-list small { color: #6f879a; font-size: 8px; }.job-list em,.job-state { padding: 3px 5px; border-radius: 3px; color: #879baa; background: #253443; font-size: 8px; font-style: normal; }.job-list em.running,.job-state.running { color: #8bdcf4; background: #17384a; }.job-list em.completed,.job-state.completed { color: #65daa4; background: #173a31; }.job-list em.failed,.job-state.failed { color: #ff91a0; background: #3a2028; }
.job-facts { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }.job-facts span { padding: 4px 6px; border-radius: 3px; background: #152638; color: #89a1b4; font: 8px ui-monospace,monospace; }.job-detail dl { display: grid; gap: 5px; padding: 9px; background: #0a1622; }.job-detail dl div { display: grid; grid-template-columns: 80px 1fr; gap: 8px; }.job-detail dt { color: #647d90; font-size: 8px; }.job-detail dd { overflow-wrap: anywhere; color: #a5b7c4; font-size: 8px; }.job-actions { display: flex; justify-content: flex-end; margin: 9px 0; }.job-actions button { padding: 7px 11px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.job-actions button.stop { background: #793746; color: #ffe8ec; }.job-actions button:disabled { opacity: .4; }
.command,.logs { margin-top: 10px; border: 1px solid rgba(151,188,222,.13); background: #07111b; }.command > div,.logs > div { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; border-bottom: 1px solid rgba(151,188,222,.1); color: #8399aa; font-size: 8px; }.command button { border: 0; cursor: pointer; background: transparent; color: #76cdec; font-size: 8px; }.command code { display: block; max-height: 100px; overflow: auto; padding: 9px; color: #9fbdce; font: 8px/1.6 ui-monospace,monospace; white-space: pre-wrap; overflow-wrap: anywhere; }.logs pre { min-height: 160px; max-height: 310px; overflow: auto; margin: 0; padding: 9px; color: #91aa98; font: 8px/1.55 ui-monospace,monospace; white-space: pre-wrap; }.job-error { margin-top: 8px; color: #ff91a0; font-size: 9px; }.empty { display: grid; place-items: center; min-height: 180px; color: #667f92; font-size: 9px; }
@container (max-width: 1100px) { .host-strip { grid-template-columns: repeat(3,1fr); }.host-strip > div:nth-child(3) { border-right: 0; }.training-layout { grid-template-columns: 300px 1fr; }.config-pane { grid-row: 1/span 2; }.jobs-pane { border-right: 0; border-bottom: 1px solid rgba(151,188,222,.13); }.job-detail { grid-column: 2; } }
@container (max-width: 720px) { .training-workspace { padding: 10px; }.host-strip { grid-template-columns: 1fr 1fr; }.host-strip > div { border-bottom: 1px solid rgba(151,188,222,.12); }.training-layout { display: block; }.config-pane,.jobs-pane { border-right: 0; border-bottom: 1px solid rgba(151,188,222,.13); }.job-detail { min-height: 360px; } }
</style>
