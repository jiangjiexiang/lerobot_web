<template>
  <main class="training-workspace">
    <header class="training-head">
      <div><p class="eyebrow">MODEL TRAINING</p><h2>训练管理</h2></div>
      <div class="head-actions"><div class="workspace-tabs" role="tablist"><button :class="{ active: workspaceMode === 'training' }" @click="workspaceMode = 'training'">训练实验</button><button :class="{ active: workspaceMode === 'evaluation' }" @click="workspaceMode = 'evaluation'">模型评估</button><button :class="{ active: workspaceMode === 'deployment' }" @click="workspaceMode = 'deployment'">模型部署</button></div><button class="refresh" title="刷新主机与任务状态" :disabled="loading" @click="refreshAll">↻</button></div>
    </header>

    <div v-if="error" class="training-error">{{ error }}<button @click="error = null">×</button></div>

    <section class="host-strip" aria-label="主机性能">
      <div><small>GPU</small><strong>{{ host?.gpu?.name || "未检测到" }}</strong><span>{{ host?.gpu?.available ? `${host.gpu.memoryGb || "共享"} GB · CUDA 可用` : host?.gpu?.hardwareDetected ? "硬件已识别 · 当前 PyTorch 无 CUDA" : "仅 CPU" }}</span></div>
      <div><small>内存</small><strong>{{ host?.memory?.freeGb ?? "-" }} GB</strong><span>可用 / {{ host?.memory?.totalGb ?? "-" }} GB</span></div>
      <div><small>磁盘</small><strong>{{ host?.disk?.freeGb ?? "-" }} GB</strong><span>可用 / {{ host?.disk?.totalGb ?? "-" }} GB</span></div>
      <div><small>CPU</small><strong>{{ host?.cpu?.cores ?? "-" }} 核</strong><span :title="host?.cpu?.model">负载 {{ host?.cpu?.load?.toFixed(2) ?? "-" }}</span></div>
      <div class="recommendation"><small>建议配置</small><strong>{{ host?.recommendation?.cameraResolution || "640x360" }}</strong><span>ACT batch ≤ {{ host?.recommendation?.actBatchSize || 8 }}</span></div>
    </section>
    <section class="live-resources" aria-label="实时资源占用">
      <div><span>CPU {{ resources?.cpuLoadPercent ?? 0 }}%</span><i><b :style="{ width: `${resources?.cpuLoadPercent || 0}%` }"></b></i></div>
      <div><span>内存 {{ resources?.memoryPercent ?? 0 }}%</span><i><b :style="{ width: `${resources?.memoryPercent || 0}%` }"></b></i></div>
      <div><span>GPU {{ resources?.gpuLoadPercent ?? "-" }}{{ resources?.gpuLoadPercent == null ? "" : "%" }}</span><i><b :style="{ width: `${resources?.gpuLoadPercent || 0}%` }"></b></i></div>
      <div><span>温度 {{ resources?.temperatureC ?? "-" }}°C</span><small>磁盘可用 {{ resources?.diskFreeGb ?? "-" }} GB</small></div>
    </section>

    <div v-if="workspaceMode === 'training'" class="training-layout">
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
        <details class="advanced">
          <summary>高级参数</summary>
          <div class="advanced-grid">
            <label>日志间隔<input v-model.number="form.logFreq" type="number" min="1" :max="form.steps" /></label>
            <label>Checkpoint 间隔<input v-model.number="form.saveFreq" type="number" min="1" :max="form.steps" /></label>
            <label>DataLoader 进程<input v-model.number="form.numWorkers" type="number" min="0" max="64" /></label>
            <label>随机种子<input v-model.number="form.seed" type="number" min="0" /></label>
          </div>
        </details>
        <div v-if="configurationWarning" class="config-warning">{{ configurationWarning }}</div>
        <section v-if="datasetQuality" class="quality-summary" :class="{ warning: datasetQuality.summary.warnings > 0, fail: datasetQuality.summary.errors > 0 }"><div><strong>数据质量扫描</strong><button :disabled="qualityLoading" @click="loadDatasetQuality">{{ qualityLoading ? "扫描中…" : "重新扫描" }}</button></div><p>{{ datasetQuality.summary.episodes }} Episodes · {{ datasetQuality.summary.errors }} 错误 · {{ datasetQuality.summary.warnings }} 警告 · {{ datasetQuality.summary.passed ? "可进入预检" : "存在阻断风险" }}</p></section>
        <section v-if="resourceEstimate" class="resource-estimate" :class="{ fail: !resourceEstimate.ready }"><div><strong>资源预估</strong><span>{{ resourceEstimate.ready ? "容量可满足" : "容量不足" }}</span></div><p>{{ form.device === "cuda" ? `预计显存 ${resourceEstimate.estimate.gpuMemoryGb} GB` : `预计系统内存 ${resourceEstimate.estimate.systemMemoryGb} GB` }} · {{ resourceEstimate.estimate.basis }}</p></section>
        <div class="training-flags"><span>不上传 Hugging Face</span><span>WandB 关闭</span><span>保存 Checkpoint</span></div>
        <button class="create-job" :disabled="creating || !formValid" @click="createJob">{{ creating ? "创建中…" : "创建训练任务" }}</button>
      </section>

      <section class="jobs-pane" aria-label="训练任务列表">
        <div class="pane-heading"><div><p class="eyebrow">JOB QUEUE</p><h3>任务队列</h3></div><label class="archive-toggle"><input v-model="showArchived" type="checkbox" @change="refreshJobs" /> 含归档</label></div>
        <div class="compare-status"><span>已选 {{ compareIds.length }} / 4</span><button v-if="compareIds.length" @click="compareIds = []">清空对比</button></div>
        <div v-if="jobs.length" class="job-list">
          <div v-for="job in jobs" :key="job.id" class="job-row">
            <label title="加入 Run 对比"><input type="checkbox" :checked="compareIds.includes(job.id)" @change="toggleCompare(job.id, $event)" /></label>
            <button :class="{ active: selectedJob?.id === job.id }" @click="selectedJobId = job.id">
              <i :class="job.state"></i>
              <span><strong>{{ job.bestAt ? "★ " : "" }}{{ job.name }}</strong><small>{{ job.policy.toUpperCase() }} · {{ job.dataset }} / {{ job.collection }}</small></span>
              <em :class="job.state">{{ jobState(job.state) }}</em>
            </button>
          </div>
        </div>
        <div v-else class="empty">尚无训练任务</div>
      </section>

      <section class="job-detail" aria-label="训练任务详情">
        <template v-if="comparisonJobs.length >= 2">
          <div class="job-title"><div><p class="eyebrow">RUN COMPARISON</p><h3>实验对比</h3></div><button class="close-compare" @click="compareIds = []">退出对比</button></div>
          <div class="compare-table-wrap"><table class="compare-table"><thead><tr><th>字段</th><th v-for="job in comparisonJobs" :key="job.id"><span>{{ job.bestAt ? "★ " : "" }}{{ job.name }}</span><small>{{ job.id }}</small></th></tr></thead><tbody>
            <tr><th>状态</th><td v-for="job in comparisonJobs" :key="job.id">{{ jobState(job.state) }}</td></tr>
            <tr><th>数据版本</th><td v-for="job in comparisonJobs" :key="job.id">{{ job.dataset }} / {{ job.collection }}</td></tr>
            <tr><th>策略 / 设备</th><td v-for="job in comparisonJobs" :key="job.id">{{ job.policy.toUpperCase() }} / {{ job.device.toUpperCase() }}</td></tr>
            <tr><th>Batch / Steps</th><td v-for="job in comparisonJobs" :key="job.id">{{ job.batchSize }} / {{ job.steps.toLocaleString() }}</td></tr>
            <tr><th>Workers / Seed</th><td v-for="job in comparisonJobs" :key="job.id">{{ job.numWorkers ?? 4 }} / {{ job.seed ?? 1000 }}</td></tr>
            <tr><th>Episodes</th><td v-for="job in comparisonJobs" :key="job.id">{{ job.episodes.length }}</td></tr>
            <tr><th>最终 Loss</th><td v-for="job in comparisonJobs" :key="job.id">{{ formatMetric(finalLoss(job)) }}</td></tr>
            <tr><th>最低 Loss</th><td v-for="job in comparisonJobs" :key="job.id">{{ formatMetric(minLoss(job)) }}</td></tr>
            <tr><th>耗时</th><td v-for="job in comparisonJobs" :key="job.id">{{ formatDuration(job) }}</td></tr>
            <tr><th>Checkpoints</th><td v-for="job in comparisonJobs" :key="job.id">{{ job.checkpoints.length }}</td></tr>
            <tr><th>最佳 Run</th><td v-for="job in comparisonJobs" :key="job.id"><button class="best-button" :disabled="job.state !== 'completed'" @click="markBest(job.id, !job.bestAt)">{{ job.bestAt ? "取消最佳" : "标记最佳" }}</button></td></tr>
          </tbody></table></div>
          <section class="comparison-chart"><div><strong>Loss 曲线</strong><span>按真实 Step 对齐</span></div><svg viewBox="0 0 700 220" preserveAspectRatio="none"><line v-for="y in [40,110,180]" :key="y" x1="0" :y1="y" x2="700" :y2="y"></line><polyline v-for="series in comparisonSeries" :key="series.id" :points="series.points" :style="{ stroke: series.color }"></polyline></svg><div class="chart-legend"><span v-for="series in comparisonSeries" :key="series.id"><i :style="{ background: series.color }"></i>{{ series.name }}</span></div><p v-if="!comparisonSeries.length">所选任务尚无可比较的 Loss 指标</p></section>
        </template>
        <template v-else-if="selectedJob">
          <div class="job-title"><div><p class="eyebrow">{{ selectedJob.id }}</p><h3>{{ selectedJob.name }}</h3></div><span :class="['job-state', selectedJob.state]">{{ jobState(selectedJob.state) }}</span></div>
          <div class="job-facts"><span>{{ selectedJob.policy.toUpperCase() }}</span><span>{{ selectedJob.device.toUpperCase() }}</span><span>Batch {{ selectedJob.batchSize }}</span><span>{{ selectedJob.steps.toLocaleString() }} steps</span><span>{{ selectedJob.episodes.length }} Episodes</span></div>
          <div class="progress"><span><b>训练进度</b><em>{{ selectedJob.progress || 0 }}%</em></span><i><b :style="{ width: `${selectedJob.progress || 0}%` }"></b></i></div>
          <dl><div><dt>训练选集</dt><dd>{{ selectedJob.dataset }} / {{ selectedJob.collection }}</dd></div><div><dt>输出目录</dt><dd>{{ selectedJob.outputDir }}</dd></div><div><dt>创建时间</dt><dd>{{ formatDate(selectedJob.createdAt) }}</dd></div></dl>
          <section class="dataset-snapshot"><div><strong>数据快照</strong><button :disabled="snapshotLoading" @click="downloadSnapshot">{{ snapshotLoading ? "校验中…" : "下载 manifest" }}</button></div><p v-if="snapshot">{{ snapshot.sourceFiles.length }} 个原始文件 · {{ formatBytes(snapshotBytes(snapshot)) }} · SHA-256 {{ snapshot.fingerprint.slice(0, 12) }}…</p><p v-else>正在读取训练选集及原始文件校验摘要</p></section>
          <div class="job-actions"><button v-if="selectedJob.state === 'completed'" :class="['secondary', { best: selectedJob.bestAt }]" @click="markBest(selectedJob.id, !selectedJob.bestAt)">{{ selectedJob.bestAt ? "★ 最佳 Run" : "标记最佳" }}</button><button class="secondary" title="复制为新的草稿任务" @click="cloneJob(selectedJob.id)">复制任务</button><button v-if="!selectedJob.archivedAt && !['running','stopping'].includes(selectedJob.state)" class="secondary" title="从默认任务列表隐藏" @click="archiveJob(selectedJob.id, true)">归档</button><button v-if="selectedJob.archivedAt" class="secondary" @click="archiveJob(selectedJob.id, false)">恢复</button><button v-if="selectedJob.state === 'draft'" :disabled="runningJobs > 0 || checking" @click="startJob(selectedJob.id)">▶ 启动训练</button><button v-if="['failed','cancelled'].includes(selectedJob.state) && selectedJob.checkpoints.length" :disabled="runningJobs > 0" @click="resumeJob(selectedJob.id)">↻ 从 Checkpoint 续训</button><button v-if="selectedJob.state === 'running'" class="stop" @click="stopJob(selectedJob.id)">■ 停止</button></div>
          <section class="preflight-panel">
            <div><strong>启动前检查</strong><button :disabled="checking" @click="checkPreflight(selectedJob.id)">{{ checking ? "检查中…" : "重新检查" }}</button></div>
            <ul v-if="preflight?.checks.length"><li v-for="check in preflight.checks" :key="check.id"><i :class="check.status"></i><span><strong>{{ check.label }}</strong><small>{{ check.detail }}</small></span></li></ul>
            <p v-else>启动训练时会自动检查数据、依赖、设备和主机资源</p>
          </section>
          <section v-if="selectedJob.metrics.length" class="metrics-panel">
            <div class="metric-summary"><span><small>Step</small><strong>{{ latestMetric?.step.toLocaleString() }}</strong></span><span><small>Loss</small><strong>{{ formatMetric(latestMetric?.loss) }}</strong></span><span><small>Grad norm</small><strong>{{ formatMetric(latestMetric?.gradNorm) }}</strong></span><span><small>Learning rate</small><strong>{{ formatMetric(latestMetric?.learningRate) }}</strong></span></div>
            <div class="chart-head"><strong>指标趋势</strong><select v-model="metricMode"><option value="loss">Loss</option><option value="gradNorm">Grad norm</option></select></div>
            <svg class="metric-chart" viewBox="0 0 600 150" preserveAspectRatio="none" aria-label="训练指标曲线"><line v-for="y in [25,75,125]" :key="y" x1="0" :y1="y" x2="600" :y2="y"></line><polyline :points="chartPoints"></polyline></svg>
          </section>
          <section class="checkpoint-panel">
            <div><strong>Checkpoints</strong><span>{{ selectedJob.checkpoints.length }}</span></div>
            <ul v-if="selectedJob.checkpoints.length"><li v-for="checkpoint in selectedJob.checkpoints" :key="checkpoint.name"><span>Step {{ checkpoint.step.toLocaleString() }} · {{ formatBytes(checkpoint.sizeBytes) }}</span><small>{{ formatDate(checkpoint.modifiedAt) }}</small><button :disabled="hashingCheckpoint === checkpoint.name" title="计算 model.safetensors 的 SHA-256" @click="checkIntegrity(selectedJob.id, checkpoint.name)">{{ hashingCheckpoint === checkpoint.name ? "计算中…" : "校验" }}</button><button :disabled="registeringCheckpoint === checkpoint.name || Boolean(modelForCheckpoint(selectedJob.id, checkpoint.name))" @click="registerModel(selectedJob.id, checkpoint.name)">{{ modelForCheckpoint(selectedJob.id, checkpoint.name) ? "已登记" : registeringCheckpoint === checkpoint.name ? "登记中…" : "登记模型" }}</button><code v-if="checkpointHashes[checkpoint.name]" :title="checkpointHashes[checkpoint.name]">{{ checkpointHashes[checkpoint.name].slice(0, 12) }}…</code></li></ul>
            <p v-else>尚无 Checkpoint</p>
          </section>
          <section class="model-panel">
            <div><strong>模型登记</strong><span>{{ currentModels.length }} 个版本</span></div>
            <ul v-if="currentModels.length"><li v-for="model in currentModels" :key="model.id"><span><strong>{{ model.name }} v{{ model.version }}</strong><small>Step {{ model.step.toLocaleString() }} · {{ formatBytes(model.sizeBytes) }}{{ model.evaluation?.successRate == null ? "" : ` · 评估 ${formatPercent(model.evaluation.successRate)} (${model.evaluation.success}/${model.evaluation.success + model.evaluation.failure})` }}</small></span><code :title="model.sha256">{{ model.sha256.slice(0, 12) }}…</code><em :class="model.stage">{{ modelStage(model.stage) }}</em><button v-if="model.stage !== 'production'" @click="updateModelStage(model.id, 'production')">设为生产</button><button v-else @click="updateModelStage(model.id, 'candidate')">撤回</button></li></ul>
            <p v-else>从 Checkpoint 登记模型后，可用于后续评估和部署</p>
          </section>
          <div class="command"><div><strong>执行命令</strong><button title="复制命令" @click="copyCommand">复制</button></div><code>{{ commandText }}</code></div>
          <div class="logs"><div><strong>训练日志</strong><span>{{ selectedJob.logs.length }} 行</span></div><pre>{{ selectedJob.logs.join("\n") || "任务尚未启动" }}</pre></div>
          <p v-if="selectedJob.error" class="job-error">{{ selectedJob.error }}</p>
        </template>
        <div v-else class="empty">选择一个任务查看配置和日志</div>
      </section>
    </div>
    <EvaluationWorkspace v-else-if="workspaceMode === 'evaluation'" @error="error = $event" />
    <DeploymentWorkspace v-else @error="error = $event" />
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import DeploymentWorkspace from "./DeploymentWorkspace.vue";
import EvaluationWorkspace from "./EvaluationWorkspace.vue";

interface DatasetSummary { name: string; reviews: { approved: number } }
interface Collection { id: string; name: string; episodes: { episode: number }[] }
interface HostProfile { gpu: { available: boolean; hardwareDetected?: boolean; name: string | null; memoryGb: number | null }; memory: { totalGb: number; freeGb: number }; disk: { totalGb: number; freeGb: number }; cpu: { model: string; cores: number; load: number }; recommendation: { device: string; cameraResolution: string; actBatchSize: number } }
interface ResourceSample { cpuLoadPercent: number; memoryPercent: number; memoryUsedGb: number; diskFreeGb: number; gpuLoadPercent: number | null; temperatureC: number | null }
interface TrainingMetric { step: number; samples: number | null; epochs: number | null; loss: number | null; gradNorm: number | null; learningRate: number | null; updateSeconds: number | null; dataSeconds: number | null }
interface Checkpoint { step: number; name: string; path: string; configPath: string; modelPath: string | null; sizeBytes: number; modifiedAt: string }
interface DatasetSnapshot { schemaVersion: number; generatedAt: string; dataset: string; collection: Collection; sourceFiles: { relativePath: string; sizeBytes: number; modifiedAt: string; sha256: string }[]; fingerprint: string }
interface DatasetQuality { summary: { episodes: number; errors: number; warnings: number; duplicateGroups: number; passed: boolean }; episodes: Array<{ episode: number; score: number; flags: Array<{ code: string; level: string; label: string }> }> }
interface ResourceEstimate { ready: boolean; estimate: { gpuMemoryGb: number; systemMemoryGb: number; basis: string }; host: { gpuAvailable: boolean; gpuMemoryGb: number | null; memoryFreeGb: number | null } }
interface PreflightCheck { id: string; label: string; status: "pass" | "warning" | "fail"; detail: string }
interface Preflight { ready: boolean; checks: PreflightCheck[]; checkedAt: string }
type ModelStage = "candidate" | "production" | "archived";
interface RegisteredModel { id: string; name: string; version: number; jobId: string; checkpoint: string; step: number; policy: string; dataset: string; collection: string; modelPath: string; sizeBytes: number; sha256: string; stage: ModelStage; notes: string; createdAt: string; updatedAt: string; evaluation?: { jobs: number; episodes: number; success: number; failure: number; successRate: number | null } }
type JobState = "draft" | "running" | "stopping" | "completed" | "failed" | "cancelled";
interface TrainingJob { id: string; name: string; dataset: string; collection: string; episodes: number[]; policy: string; device: string; batchSize: number; steps: number; logFreq?: number; saveFreq?: number; numWorkers?: number; seed?: number; state: JobState; createdAt: string; startedAt?: string | null; finishedAt?: string | null; outputDir: string; command: string[]; error: string | null; logs: string[]; metrics: TrainingMetric[]; checkpoints: Checkpoint[]; progress: number; archivedAt?: string | null; bestAt?: string | null }

const host = ref<HostProfile | null>(null);
const resources = ref<ResourceSample | null>(null);
const datasets = ref<DatasetSummary[]>([]);
const collections = ref<Collection[]>([]);
const jobs = ref<TrainingJob[]>([]);
const models = ref<RegisteredModel[]>([]);
const selectedJobId = ref("");
const loading = ref(false);
const creating = ref(false);
const error = ref<string | null>(null);
const metricMode = ref<"loss" | "gradNorm">("loss");
const workspaceMode = ref<"training" | "evaluation" | "deployment">("training");
const showArchived = ref(false);
const checking = ref(false);
const preflight = ref<Preflight | null>(null);
const hashingCheckpoint = ref("");
const checkpointHashes = reactive<Record<string, string>>({});
const registeringCheckpoint = ref("");
const snapshot = ref<DatasetSnapshot | null>(null);
const snapshotLoading = ref(false);
const datasetQuality = ref<DatasetQuality | null>(null);
const qualityLoading = ref(false);
const resourceEstimate = ref<ResourceEstimate | null>(null);
const compareIds = ref<string[]>([]);
let pollTimer: number | null = null;

const policies = [
  { value: "act", label: "ACT（新手推荐）" }, { value: "diffusion", label: "Diffusion Policy" },
  { value: "tdmpc", label: "TDMPC" }, { value: "vqbet", label: "VQ-BeT" },
  { value: "smolvla", label: "SmolVLA" }, { value: "pi0", label: "Pi0" },
  { value: "pi0-fast", label: "Pi0 Fast" }, { value: "sac", label: "SAC" },
  { value: "reward_classifier", label: "Reward Classifier" },
];
const form = reactive({ name: "", dataset: "", collection: "", policy: "act", device: "cuda", batchSize: 8, steps: 20000, logFreq: 200, saveFreq: 5000, numWorkers: 4, seed: 1000 });
const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedJobId.value) || jobs.value[0] || null);
const comparisonJobs = computed(() => compareIds.value.map((id) => jobs.value.find((job) => job.id === id)).filter((job): job is TrainingJob => Boolean(job)));
const currentModels = computed(() => models.value.filter((model) => model.jobId === selectedJob.value?.id));
const runningJobs = computed(() => jobs.value.filter((job) => ["running", "stopping"].includes(job.state)).length);
const selectedCollection = computed(() => collections.value.find((item) => item.id === form.collection) || null);
const formValid = computed(() => Boolean(form.name && form.dataset && form.collection && form.batchSize > 0 && form.steps > 0 && form.logFreq > 0 && form.logFreq <= form.steps && form.saveFreq > 0 && form.saveFreq <= form.steps && form.numWorkers >= 0 && form.seed >= 0));
const commandText = computed(() => selectedJob.value ? ["python", ...selectedJob.value.command].map(shellQuote).join(" ") : "");
const latestMetric = computed(() => selectedJob.value?.metrics[selectedJob.value.metrics.length - 1] || null);
const chartPoints = computed(() => {
  const values = (selectedJob.value?.metrics || []).map((metric) => ({ step: metric.step, value: metric[metricMode.value] })).filter((item): item is { step: number; value: number } => item.value !== null);
  if (!values.length) return "";
  const minStep = values[0].step; const maxStep = values[values.length - 1].step;
  const minValue = Math.min(...values.map((item) => item.value)); const maxValue = Math.max(...values.map((item) => item.value));
  return values.map((item) => `${((item.step - minStep) / Math.max(1, maxStep - minStep) * 590 + 5).toFixed(1)},${(140 - (item.value - minValue) / Math.max(1e-9, maxValue - minValue) * 130).toFixed(1)}`).join(" ");
});
const comparisonSeries = computed(() => {
  const palette = ["#64c9e8", "#54c994", "#e1bf76", "#e8798a"];
  const series = comparisonJobs.value.map((job, index) => ({ id: job.id, name: job.name, color: palette[index], values: job.metrics.filter((metric): metric is TrainingMetric & { loss: number } => metric.loss !== null).map((metric) => ({ step: metric.step, value: metric.loss })) })).filter((item) => item.values.length);
  if (!series.length) return [];
  const values = series.flatMap((item) => item.values);
  const minStep = Math.min(...values.map((item) => item.step)); const maxStep = Math.max(...values.map((item) => item.step));
  const minValue = Math.min(...values.map((item) => item.value)); const maxValue = Math.max(...values.map((item) => item.value));
  return series.map((item) => ({ ...item, points: item.values.map((point) => `${((point.step - minStep) / Math.max(1, maxStep - minStep) * 680 + 10).toFixed(1)},${(205 - (point.value - minValue) / Math.max(1e-9, maxValue - minValue) * 190).toFixed(1)}`).join(" ") }));
});
const configurationWarning = computed(() => {
  if (["pi0", "pi0-fast"].includes(form.policy)) return "Pi0 需要先安装 lerobot[pi] 依赖。";
  if (form.policy === "smolvla" && form.batchSize > 28 && Number(host.value?.gpu?.memoryGb || 0) <= 8) return "8GB 显存运行 SmolVLA 时，建议 batch size 不超过 28。";
  if (form.device === "cuda" && !host.value?.gpu?.available) return "当前未检测到 CUDA，需改用 CPU 或修复 PyTorch CUDA 环境。";
  if (selectedCollection.value && selectedCollection.value.episodes.length < 10) return `当前训练选集只有 ${selectedCollection.value.episodes.length} 个 Episode，适合流程验证；正式训练建议至少 10 组，并逐步扩充到 50 组以上。`;
  return "";
});

async function requestJson(url: string, init?: RequestInit) { const response = await fetch(url, init); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
async function refreshHost() { const data = await requestJson("/api/training/host") as HostProfile; host.value = data; if (!data.gpu.available) form.device = "cpu"; if (!form.batchSize) form.batchSize = data.recommendation.actBatchSize; }
async function refreshResources() { resources.value = await requestJson("/api/training/resources") as ResourceSample; }
async function refreshModels() { const data = await requestJson("/api/training/models"); models.value = data.models || []; }
async function refreshJobs() { const data = await requestJson(`/api/training/jobs?archived=${showArchived.value}`); jobs.value = data.jobs || []; if (!jobs.value.some((job) => job.id === selectedJobId.value)) selectedJobId.value = jobs.value[0]?.id || ""; }
async function refreshAll() { loading.value = true; error.value = null; try { const data = await requestJson("/api/datasets"); datasets.value = data.datasets || []; await Promise.all([refreshHost(), refreshResources(), refreshJobs(), refreshModels()]); if (!form.dataset && datasets.value.length) { form.dataset = datasets.value[0].name; await loadCollections(); } } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { loading.value = false; } }
async function loadCollections() { form.collection = ""; datasetQuality.value = null; if (!form.dataset) return; try { const data = await requestJson(`/api/datasets/${encodeURIComponent(form.dataset)}/collections`); collections.value = data.collections || []; if (collections.value.length) form.collection = collections.value[0].id; await loadDatasetQuality(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function loadDatasetQuality() { if (!form.dataset || qualityLoading.value) return; qualityLoading.value = true; try { datasetQuality.value = await requestJson(`/api/datasets/${encodeURIComponent(form.dataset)}/quality`) as DatasetQuality; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { qualityLoading.value = false; } }
async function loadResourceEstimate() { try { resourceEstimate.value = await requestJson("/api/training/resources/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: form.policy, device: form.device, batchSize: form.batchSize, numWorkers: form.numWorkers }) }) as ResourceEstimate; } catch (cause) { resourceEstimate.value = null; }
}
async function createJob() { if (!formValid.value || creating.value) return; creating.value = true; error.value = null; try { const data = await requestJson("/api/training/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }); selectedJobId.value = data.job.id; await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { creating.value = false; } }
async function startJob(id: string) { error.value = null; const ready = await checkPreflight(id); if (!ready) { error.value = "启动前检查未通过，请处理失败项后重试"; return; } try { await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/start`, { method: "POST" }); await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function stopJob(id: string) { try { await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/stop`, { method: "POST" }); await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function resumeJob(id: string) { try { await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" }); await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function checkPreflight(id: string) { checking.value = true; try { preflight.value = await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/preflight`) as Preflight; return preflight.value.ready; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return false; } finally { checking.value = false; } }
async function cloneJob(id: string) { try { const data = await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/clone`, { method: "POST" }); selectedJobId.value = data.job.id; preflight.value = null; await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function archiveJob(id: string, archived: boolean) { try { await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }) }); preflight.value = null; await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function loadDatasetSnapshot() { const job = selectedJob.value; snapshot.value = null; if (!job) return; snapshotLoading.value = true; try { const data = await requestJson(`/api/datasets/${encodeURIComponent(job.dataset)}/collections/${encodeURIComponent(job.collection)}/snapshot`); if (selectedJob.value?.id === job.id) snapshot.value = data.snapshot as DatasetSnapshot; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { snapshotLoading.value = false; } }
async function downloadSnapshot() { if (!snapshot.value) await loadDatasetSnapshot(); if (!snapshot.value) return; const blob = new Blob([JSON.stringify(snapshot.value, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${snapshot.value.dataset}-${snapshot.value.collection.id}-snapshot.json`; anchor.click(); URL.revokeObjectURL(url); }
async function checkIntegrity(jobId: string, checkpoint: string) { hashingCheckpoint.value = checkpoint; try { const data = await requestJson(`/api/training/jobs/${encodeURIComponent(jobId)}/checkpoints/${encodeURIComponent(checkpoint)}/integrity`); checkpointHashes[checkpoint] = data.hash; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { hashingCheckpoint.value = ""; } }
async function markBest(id: string, best: boolean) { try { await requestJson(`/api/training/jobs/${encodeURIComponent(id)}/best`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ best }) }); await refreshJobs(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function registerModel(jobId: string, checkpoint: string) { registeringCheckpoint.value = checkpoint; try { await requestJson(`/api/training/jobs/${encodeURIComponent(jobId)}/checkpoints/${encodeURIComponent(checkpoint)}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); await refreshModels(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { registeringCheckpoint.value = ""; } }
async function updateModelStage(id: string, stage: ModelStage) { try { await requestJson(`/api/training/models/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage }) }); await refreshModels(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
function toggleCompare(id: string, event: Event) { const checked = (event.target as HTMLInputElement).checked; if (checked && compareIds.value.length >= 4) { (event.target as HTMLInputElement).checked = false; error.value = "最多同时比较 4 个训练任务"; return; } compareIds.value = checked ? [...compareIds.value, id] : compareIds.value.filter((item) => item !== id); }
function modelForCheckpoint(jobId: string, checkpoint: string) { return models.value.find((model) => model.jobId === jobId && model.checkpoint === checkpoint); }
function finalLoss(job: TrainingJob) { return [...job.metrics].reverse().find((metric) => metric.loss !== null)?.loss ?? null; }
function minLoss(job: TrainingJob) { const values = job.metrics.map((metric) => metric.loss).filter((value): value is number => value !== null); return values.length ? Math.min(...values) : null; }
function formatDuration(job: TrainingJob) { if (!job.startedAt) return "-"; const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now(); const seconds = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000)); if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`; return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; }
async function copyCommand() { if (commandText.value) await navigator.clipboard.writeText(commandText.value).catch(() => undefined); }
function shellQuote(value: string) { return /^[A-Za-z0-9_./:=,\[\]-]+$/.test(value) ? value : `'${value.split("'").join("'\\''")}'`; }
function jobState(state: JobState) { return ({ draft: "待启动", running: "训练中", stopping: "停止中", completed: "已完成", failed: "失败", cancelled: "已停止" })[state]; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatMetric(value: number | null | undefined) { if (value == null) return "-"; return Math.abs(value) < .001 && value !== 0 ? value.toExponential(2) : value.toFixed(3); }
function formatBytes(value: number) { if (!value) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`; }
function snapshotBytes(value: DatasetSnapshot) { return value.sourceFiles.reduce((sum, file) => sum + file.sizeBytes, 0); }
function formatPercent(value: number) { return `${(value * 100).toFixed(1)}%`; }
function modelStage(stage: ModelStage) { return ({ candidate: "候选", production: "生产", archived: "归档" })[stage]; }

watch(selectedJobId, () => { preflight.value = null; snapshot.value = null; Object.keys(checkpointHashes).forEach((key) => delete checkpointHashes[key]); void loadDatasetSnapshot(); });
watch(() => [form.policy, form.device, form.batchSize, form.numWorkers], () => { void loadResourceEstimate(); }, { immediate: true });
onMounted(() => { void refreshAll(); pollTimer = window.setInterval(() => { void refreshResources(); if (runningJobs.value) void refreshJobs(); }, 2000); });
onUnmounted(() => { if (pollTimer) window.clearInterval(pollTimer); });
</script>

<style scoped>
.training-workspace { container-type: inline-size; max-width: 1900px; margin: 0 auto; padding: 18px 24px 28px; }.training-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }.training-head h2 { margin-top: 2px; font-size: 20px; }.eyebrow { color: #78a9c6; font-size: 9px; font-weight: 700; letter-spacing: 1px; }.head-actions { display: flex; align-items: center; gap: 8px; }.workspace-tabs { display: flex; padding: 2px; border: 1px solid #29435f; border-radius: 5px; background: #091522; }.workspace-tabs button { min-width: 72px; padding: 6px 9px; border: 0; border-radius: 3px; cursor: pointer; background: transparent; color: #70899c; font-size: 9px; }.workspace-tabs button.active { background: #1a344b; color: #b8d8e8; }.refresh { width: 32px; height: 32px; border: 1px solid #315574; border-radius: 5px; background: #102941; color: #8dd4f4; cursor: pointer; font-size: 18px; }
.training-error { display: flex; justify-content: space-between; margin-bottom: 8px; padding: 8px 11px; border-left: 3px solid #ff7384; background: #25141b; color: #ffadb7; font-size: 10px; }.training-error button { border: 0; background: transparent; color: inherit; cursor: pointer; }
.host-strip { display: grid; grid-template-columns: 1.35fr repeat(4,1fr); border: 1px solid rgba(151,188,222,.15); background: #0b1724; }.host-strip > div { display: grid; gap: 4px; min-width: 0; padding: 11px 13px; border-right: 1px solid rgba(151,188,222,.12); }.host-strip > div:last-child { border-right: 0; }.host-strip small { color: #7890a3; font-size: 8px; }.host-strip strong { overflow: hidden; color: #e7f1f7; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }.host-strip span { overflow: hidden; color: #587185; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }.host-strip .recommendation { background: #10251f; }.host-strip .recommendation strong { color: #72d2a5; }
.live-resources { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; padding: 7px 12px; border: 1px solid rgba(151,188,222,.15); border-top: 0; background: #091522; }.live-resources > div { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 7px; min-width: 0; }.live-resources span,.live-resources small { color: #71899b; font-size: 8px; white-space: nowrap; }.live-resources i,.progress > i { display: block; height: 3px; overflow: hidden; background: #243646; }.live-resources i b,.progress > i b { display: block; height: 100%; background: #61bfdc; transition: width .3s ease; }.live-resources > div:last-child { display: flex; justify-content: space-between; }
.training-layout { display: grid; grid-template-columns: 310px 280px minmax(400px,1fr); min-height: calc(100vh - 225px); border: 1px solid rgba(151,188,222,.15); border-top: 0; background: #0d1928; }.config-pane,.jobs-pane,.job-detail { min-width: 0; padding: 14px; }.config-pane,.jobs-pane { border-right: 1px solid rgba(151,188,222,.13); }.pane-heading,.job-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 14px; }.pane-heading h3,.job-title h3 { margin-top: 2px; font-size: 13px; }.pane-heading > span { color: #70899c; font-size: 8px; }
.form-grid { display: grid; gap: 9px; }.form-grid label { display: grid; gap: 4px; color: #8ca2b3; font-size: 9px; }.form-grid input,.form-grid select { width: 100%; min-width: 0; padding: 8px; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #091522; color: #e7edf8; font-size: 10px; }.form-grid input:focus,.form-grid select:focus { border-color: #5a8bad; }.config-warning { margin-top: 9px; padding: 7px 8px; border-left: 2px solid #e4b85d; background: #282218; color: #d8b970; font-size: 8px; line-height: 1.5; }.quality-summary { margin-top: 9px; border: 1px solid rgba(84,201,148,.25); background: #10251f; }.quality-summary.warning { border-color: rgba(225,191,118,.35); background: #282218; }.quality-summary.fail { border-color: rgba(232,121,138,.45); background: #25141b; }.quality-summary > div { display: flex; justify-content: space-between; padding: 7px 8px; border-bottom: 1px solid rgba(151,188,222,.1); color: #83a498; font-size: 8px; }.quality-summary.fail > div { color: #f39aa7; }.quality-summary button { border: 0; cursor: pointer; background: transparent; color: #76cdec; font-size: 8px; }.quality-summary p { margin: 0; padding: 7px 8px; color: #6f9b8a; font-size: 8px; }.quality-summary.warning p { color: #d0b56f; }.quality-summary.fail p { color: #f39aa7; }.resource-estimate { margin-top: 9px; border: 1px solid rgba(84,201,148,.25); background: #10251f; }.resource-estimate.fail { border-color: rgba(232,121,138,.45); background: #25141b; }.resource-estimate > div { display: flex; justify-content: space-between; padding: 7px 8px; border-bottom: 1px solid rgba(151,188,222,.1); color: #83a498; font-size: 8px; }.resource-estimate.fail > div { color: #f39aa7; }.resource-estimate p { margin: 0; padding: 7px 8px; color: #6f9b8a; font-size: 8px; line-height: 1.5; }.resource-estimate.fail p { color: #f39aa7; }.training-flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }.training-flags span { padding: 3px 5px; border-radius: 3px; background: #142638; color: #6f899c; font-size: 8px; }.create-job { width: 100%; margin-top: 12px; padding: 9px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.create-job:disabled { cursor: not-allowed; opacity: .45; }
.advanced { margin-top: 10px; border-top: 1px solid rgba(151,188,222,.12); border-bottom: 1px solid rgba(151,188,222,.12); }.advanced summary { padding: 8px 2px; cursor: pointer; color: #829aad; font-size: 9px; }.advanced-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; padding-bottom: 9px; }.advanced-grid label { display: grid; gap: 4px; color: #7f96a8; font-size: 8px; }.advanced-grid input { width: 100%; min-width: 0; padding: 7px; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #091522; color: #e7edf8; font-size: 9px; }
.archive-toggle { display: flex; align-items: center; gap: 4px; color: #70899c; font-size: 8px; white-space: nowrap; }.archive-toggle input { width: 12px; height: 12px; accent-color: #64c9e8; }
.compare-status { display: flex; align-items: center; justify-content: space-between; margin: -7px 0 9px; color: #60798d; font-size: 8px; }.compare-status button,.close-compare { border: 0; cursor: pointer; background: transparent; color: #76cdec; font-size: 8px; }.job-list { margin: 0 -14px; border-top: 1px solid rgba(151,188,222,.1); }.job-row { display: grid; grid-template-columns: 28px 1fr; border-bottom: 1px solid rgba(151,188,222,.08); }.job-row > label { display: grid; place-items: center; border-right: 1px solid rgba(151,188,222,.07); cursor: pointer; }.job-row > label input { width: 12px; height: 12px; accent-color: #64c9e8; }.job-list .job-row > button { display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: 8px; width: 100%; padding: 11px 9px; border: 0; cursor: pointer; text-align: left; background: transparent; color: #dce8f2; }.job-list button:hover,.job-list button.active { background: #14283b; }.job-list i { width: 7px; height: 7px; border-radius: 50%; background: #718494; }.job-list i.running { background: #64c9e8; box-shadow: 0 0 8px #64c9e8; }.job-list i.completed { background: #54c994; }.job-list i.failed { background: #e86676; }.job-list span { display: grid; min-width: 0; gap: 3px; }.job-list strong,.job-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.job-list strong { font-size: 9px; }.job-list small { color: #6f879a; font-size: 8px; }.job-list em,.job-state { padding: 3px 5px; border-radius: 3px; color: #879baa; background: #253443; font-size: 8px; font-style: normal; }.job-list em.running,.job-state.running { color: #8bdcf4; background: #17384a; }.job-list em.completed,.job-state.completed { color: #65daa4; background: #173a31; }.job-list em.failed,.job-state.failed { color: #ff91a0; background: #3a2028; }
.job-list em.cancelled,.job-state.cancelled { color: #e1bf76; background: #3b321e; }
.job-facts { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }.job-facts span { padding: 4px 6px; border-radius: 3px; background: #152638; color: #89a1b4; font: 8px ui-monospace,monospace; }.job-detail dl { display: grid; gap: 5px; padding: 9px; background: #0a1622; }.job-detail dl div { display: grid; grid-template-columns: 80px 1fr; gap: 8px; }.job-detail dt { color: #647d90; font-size: 8px; }.job-detail dd { overflow-wrap: anywhere; color: #a5b7c4; font-size: 8px; }.job-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; margin: 9px 0; }.job-actions button { padding: 7px 11px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.job-actions button.secondary { border: 1px solid #29435f; background: #101f2e; color: #8ea6b8; }.job-actions button.secondary.best { border-color: #8b7133; color: #e1bf76; background: #2c2719; }.job-actions button.stop { background: #793746; color: #ffe8ec; }.job-actions button:disabled { opacity: .4; }
.dataset-snapshot { margin-top: 9px; border: 1px solid rgba(151,188,222,.13); background: #091522; }.dataset-snapshot > div { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; border-bottom: 1px solid rgba(151,188,222,.1); color: #8399aa; font-size: 8px; }.dataset-snapshot button { border: 0; cursor: pointer; background: transparent; color: #76cdec; font-size: 8px; }.dataset-snapshot button:disabled { cursor: wait; opacity: .5; }.dataset-snapshot p { margin: 0; padding: 8px 9px; color: #698296; font-size: 8px; line-height: 1.5; }
.compare-table-wrap { overflow-x: auto; border: 1px solid rgba(151,188,222,.13); }.compare-table { width: 100%; min-width: 620px; border-collapse: collapse; table-layout: fixed; font-size: 8px; }.compare-table th,.compare-table td { padding: 8px; border-right: 1px solid rgba(151,188,222,.08); border-bottom: 1px solid rgba(151,188,222,.08); text-align: left; overflow-wrap: anywhere; }.compare-table th { width: 92px; color: #71899b; background: #091522; }.compare-table thead th:not(:first-child) { width: auto; color: #d5e2eb; background: #102337; }.compare-table thead span,.compare-table thead small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.compare-table thead small { margin-top: 3px; color: #60798d; font-weight: 400; }.compare-table td { color: #a7bac6; }.best-button { padding: 4px 6px; border: 1px solid #38536a; border-radius: 3px; cursor: pointer; background: #101f2e; color: #8fc8dc; font-size: 8px; }.best-button:disabled { cursor: not-allowed; opacity: .35; }.comparison-chart { margin-top: 10px; border: 1px solid rgba(151,188,222,.13); background: #07111b; }.comparison-chart > div:first-child { display: flex; justify-content: space-between; padding: 7px 9px; color: #8399aa; font-size: 8px; }.comparison-chart svg { display: block; width: 100%; height: 180px; }.comparison-chart line { stroke: #1c3040; stroke-width: 1; vector-effect: non-scaling-stroke; }.comparison-chart polyline { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }.chart-legend { display: flex; flex-wrap: wrap; gap: 12px; padding: 7px 9px; border-top: 1px solid rgba(151,188,222,.08); color: #748da0; font-size: 8px; }.chart-legend span { display: flex; align-items: center; gap: 4px; }.chart-legend i { width: 12px; height: 2px; }.comparison-chart p { margin: 0; padding: 30px; text-align: center; color: #60798d; font-size: 8px; }
.preflight-panel { margin: 9px 0; border: 1px solid rgba(151,188,222,.13); background: #091522; }.preflight-panel > div { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; border-bottom: 1px solid rgba(151,188,222,.1); color: #8399aa; font-size: 8px; }.preflight-panel button,.checkpoint-panel button { border: 0; cursor: pointer; background: transparent; color: #76cdec; font-size: 8px; }.preflight-panel ul { margin: 0; padding: 0; list-style: none; }.preflight-panel li { display: grid; grid-template-columns: 7px 1fr; align-items: center; gap: 8px; padding: 7px 9px; border-top: 1px solid rgba(151,188,222,.07); }.preflight-panel li i { width: 6px; height: 6px; border-radius: 50%; background: #54c994; }.preflight-panel li i.warning { background: #e1bf76; }.preflight-panel li i.fail { background: #e86676; }.preflight-panel li span { display: grid; gap: 2px; }.preflight-panel li strong { color: #a7bac6; font-size: 8px; }.preflight-panel li small,.preflight-panel p { color: #667f92; font-size: 8px; }.preflight-panel p { margin: 0; padding: 10px 9px; }
.progress { display: grid; gap: 5px; margin-bottom: 9px; }.progress > span { display: flex; justify-content: space-between; color: #71899b; font-size: 8px; }.progress em { font-style: normal; }.progress > i { height: 4px; }.progress > i b { background: #54c994; }
.metrics-panel,.checkpoint-panel,.model-panel { margin-top: 10px; border: 1px solid rgba(151,188,222,.13); background: #091522; }.metric-summary { display: grid; grid-template-columns: repeat(4,1fr); border-bottom: 1px solid rgba(151,188,222,.1); }.metric-summary span { display: grid; gap: 3px; padding: 8px; border-right: 1px solid rgba(151,188,222,.08); }.metric-summary span:last-child { border-right: 0; }.metric-summary small { color: #668095; font-size: 7px; }.metric-summary strong { color: #c8d8e2; font: 10px ui-monospace,monospace; }.chart-head,.checkpoint-panel > div,.model-panel > div { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; color: #8399aa; font-size: 8px; }.chart-head select { padding: 3px 5px; border: 1px solid #29435f; border-radius: 3px; background: #101f2e; color: #9cb0bf; font-size: 8px; }.metric-chart { display: block; width: 100%; height: 125px; background: #07111b; }.metric-chart line { stroke: #1c3040; stroke-width: 1; vector-effect: non-scaling-stroke; }.metric-chart polyline { fill: none; stroke: #64c9e8; stroke-width: 2; vector-effect: non-scaling-stroke; }.checkpoint-panel ul { max-height: 180px; overflow: auto; margin: 0; padding: 0; list-style: none; }.checkpoint-panel li { display: grid; grid-template-columns: minmax(120px,1fr) auto auto auto; align-items: center; gap: 8px; padding: 7px 9px; border-top: 1px solid rgba(151,188,222,.08); color: #a7bac6; font-size: 8px; }.checkpoint-panel li small,.checkpoint-panel li code { overflow: hidden; color: #6d8799; font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }.checkpoint-panel li code { grid-column: 1/-1; }.checkpoint-panel p,.model-panel > p { margin: 0; padding: 12px 9px; border-top: 1px solid rgba(151,188,222,.08); color: #61798b; font-size: 8px; }.model-panel ul { margin: 0; padding: 0; list-style: none; }.model-panel li { display: grid; grid-template-columns: minmax(130px,1fr) auto auto auto; align-items: center; gap: 8px; padding: 8px 9px; border-top: 1px solid rgba(151,188,222,.08); }.model-panel li > span { display: grid; gap: 3px; min-width: 0; }.model-panel li strong { color: #afc3d0; font-size: 8px; }.model-panel li small,.model-panel li code { overflow: hidden; color: #658095; font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }.model-panel li em { padding: 3px 5px; border-radius: 3px; color: #e1bf76; background: #352e1d; font-size: 7px; font-style: normal; }.model-panel li em.production { color: #65daa4; background: #173a31; }.model-panel li em.archived { color: #8a9ba8; background: #26323b; }.model-panel li button { border: 0; cursor: pointer; background: transparent; color: #76cdec; font-size: 8px; }
.command,.logs { margin-top: 10px; border: 1px solid rgba(151,188,222,.13); background: #07111b; }.command > div,.logs > div { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; border-bottom: 1px solid rgba(151,188,222,.1); color: #8399aa; font-size: 8px; }.command button { border: 0; cursor: pointer; background: transparent; color: #76cdec; font-size: 8px; }.command code { display: block; max-height: 100px; overflow: auto; padding: 9px; color: #9fbdce; font: 8px/1.6 ui-monospace,monospace; white-space: pre-wrap; overflow-wrap: anywhere; }.logs pre { min-height: 160px; max-height: 310px; overflow: auto; margin: 0; padding: 9px; color: #91aa98; font: 8px/1.55 ui-monospace,monospace; white-space: pre-wrap; }.job-error { margin-top: 8px; color: #ff91a0; font-size: 9px; }.empty { display: grid; place-items: center; min-height: 180px; color: #667f92; font-size: 9px; }
@container (max-width: 1100px) { .host-strip { grid-template-columns: repeat(3,1fr); }.host-strip > div:nth-child(3) { border-right: 0; }.training-layout { grid-template-columns: 300px 1fr; }.config-pane { grid-row: 1/span 2; }.jobs-pane { border-right: 0; border-bottom: 1px solid rgba(151,188,222,.13); }.job-detail { grid-column: 2; } }
@container (max-width: 720px) { .training-workspace { padding: 10px; }.training-head { align-items: flex-start; }.head-actions { align-items: flex-end; flex-direction: column-reverse; }.workspace-tabs button { min-width: 62px; padding-inline: 6px; }.host-strip { grid-template-columns: 1fr 1fr; }.host-strip > div { border-bottom: 1px solid rgba(151,188,222,.12); }.live-resources { grid-template-columns: 1fr 1fr; }.training-layout { display: block; }.config-pane,.jobs-pane { border-right: 0; border-bottom: 1px solid rgba(151,188,222,.13); }.job-detail { min-height: 360px; }.metric-summary { grid-template-columns: 1fr 1fr; } }
</style>
