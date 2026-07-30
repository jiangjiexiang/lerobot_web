<template>
  <main class="workspace">
    <header class="workspace-head">
      <div><p class="eyebrow">DATA LIBRARY</p><h2>数据资产</h2><span>浏览、审核并管理机器人采集数据</span></div>
      <button class="icon-button" title="刷新数据目录" :disabled="loading" @click="loadDatasets(true)">刷新</button>
    </header>

    <section class="kpis" aria-label="数据概览">
      <div><small>数据集</small><strong>{{ datasets.length }}</strong><span>{{ totalFrames.toLocaleString() }} 帧</span></div>
      <div><small>Episodes</small><strong>{{ totalEpisodes }}</strong><span>{{ totalDuration }}</span></div>
      <div><small>审核进度</small><strong>{{ reviewRate }}%</strong><span>{{ reviewedEpisodes }} 已完成</span></div>
      <div><small>待审核</small><strong :class="{ alert: pendingReviewCount > 0 }">{{ pendingReviewCount }}</strong><span>{{ reviewRate }}% 审核完成</span></div>
    </section>

    <div v-if="error" class="workspace-error">{{ error }}<button @click="loadDatasets(true)">重试</button></div>
    <div v-if="loading && datasets.length === 0" class="catalog-skeleton"><i v-for="item in 3" :key="item"></i></div>
    <div v-else-if="!loading && datasets.length === 0" class="empty">尚无已保存的数据集</div>

    <template v-else>
      <section v-if="!selectedDataset" class="catalog-view">
        <header class="catalog-heading">
          <div><strong>数据资产</strong><small :title="root">{{ root || "本地目录" }}</small></div>
          <label><span>⌕</span><input v-model="datasetQuery" placeholder="搜索数据集…" /></label>
        </header>
        <div class="dataset-grid">
          <article v-for="item in filteredDatasets" :key="item.name" class="dataset-card">
            <button class="card-open" @click="selectDataset(item)">
              <span class="card-icon">D</span>
              <span class="card-title">{{ item.name }}</span>
              <span class="card-type">{{ item.robotType || "LeRobot Dataset" }}</span>
              <span class="card-stats"><b>{{ item.totalEpisodes }}</b> Episodes <i></i><b>{{ item.totalFrames.toLocaleString() }}</b> 帧</span>
              <span class="card-tags"><em>{{ item.fps }} FPS</em><em>{{ item.cameras.length }} 路相机</em></span>
              <span class="review-meter"><i class="approved" :style="{ width: reviewWidth(item, 'approved') }"></i><i class="rejected" :style="{ width: reviewWidth(item, 'rejected') }"></i></span>
              <span class="card-foot"><small>更新于 {{ formatDate(item.modifiedAt) }}</small><b>查看详情 →</b></span>
            </button>
            <button class="card-delete" :aria-label="`删除数据集 ${item.name}`" title="删除数据集" @click="openDeleteDataset(item)">•••</button>
          </article>
          <div v-if="filteredDatasets.length === 0" class="no-results">没有匹配的数据集</div>
        </div>
      </section>

      <template v-else>
      <div class="dataset-context">
        <button @click="closeDataset">← 返回数据资产</button>
        <div><strong>{{ selectedDataset.name }}</strong><small>{{ selectedDataset.robotType || "LeRobot Dataset" }} · {{ selectedDataset.totalEpisodes }} Episodes · {{ selectedDataset.cameras.length }} 路相机</small></div>
        <div class="context-actions"><span :class="{ loading: detailLoading }">{{ detailLoading ? "正在加载索引…" : "索引已就绪" }}</span><button class="danger-button" @click="openDeleteDataset(selectedDataset)">删除数据集</button></div>
      </div>
      <div class="data-layout">

      <section class="episode-list" aria-label="Episode 列表">
        <div class="pane-title episode-title"><strong>Episodes</strong><small>{{ filteredEpisodes.length }} / {{ episodes.length }}</small></div>
        <div class="episode-tools">
          <label class="search"><span>⌕</span><input v-model="query" aria-label="搜索 Episode" placeholder="搜索编号、任务、标签" /></label>
          <div class="tool-row">
            <select v-model="filter" aria-label="审核状态">
              <option v-for="item in filters" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
            <select v-model="qualityFilter" aria-label="质量状态"><option value="all">全部质量</option><option value="issues">有问题</option><option value="clean">规则通过</option></select>
            <select v-model="sort" aria-label="排序"><option value="episode-asc">编号升序</option><option value="episode-desc">编号降序</option><option value="quality-asc">质量较差优先</option><option value="updated-desc">最近审核</option></select>
          </div>
          <label class="select-all"><input type="checkbox" :checked="allFilteredSelected" @change="toggleAllFiltered" /> 选择当前结果</label>
        </div>

        <div v-if="selectedIds.size" class="batch-bar">
          <span>已选 {{ selectedIds.size }} 项</span>
          <select v-model="batch.status" aria-label="批量审核状态"><option value="approved">通过</option><option value="rejected">拒绝</option><option value="unreviewed">待审核</option></select>
          <input v-model="batch.tags" aria-label="批量标签" placeholder="追加标签" />
          <button :disabled="saving" @click="saveBatch">应用</button>
          <button class="clear" title="清除选择" @click="selectedIds.clear()">×</button>
        </div>

        <div v-if="detailLoading" class="episode-loading">正在读取 Episodes…</div>
        <div v-else class="episode-scroll">
          <div v-for="item in filteredEpisodes" :key="item.episode" class="episode-row" :class="{ active: selectedEpisode?.episode === item.episode }">
            <input type="checkbox" :checked="selectedIds.has(item.episode)" :aria-label="`选择 Episode ${item.episode}`" @change="toggleSelected(item.episode)" />
            <button @click="selectEpisode(item)">
              <span class="episode-index">#{{ String(item.episode).padStart(3, "0") }}</span>
              <span class="episode-duration">{{ formatDuration(item.duration) }}</span>
              <span class="episode-task">{{ item.tasks.join(" / ") || "未命名任务" }}</span>
              <span class="review-state" :class="item.review.status">{{ statusText(item.review.status) }}</span>
              <span v-if="item.quality.flags.length" class="quality-state issue">{{ item.quality.flags.length }} 项问题</span>
              <span v-else class="quality-state">质量 {{ item.quality.score }}</span>
            </button>
          </div>
          <div v-if="filteredEpisodes.length === 0" class="no-results">没有符合条件的 Episode</div>
        </div>
      </section>

      <section v-if="selectedDataset" class="review-pane" aria-label="数据详情">
        <div v-if="detailLoading" class="detail-skeleton">
          <i class="wide"></i><i></i><i></i><i class="video"></i><i class="video"></i>
        </div>
        <template v-else>
        <div class="detail-tabs" role="tablist">
          <button :class="{ active: detailView === 'episode' }" @click="detailView = 'episode'">回放审核</button>
          <button :class="{ active: detailView === 'collections' }" @click="detailView = 'collections'">训练选集 <span>{{ collections.length }}</span></button>
          <button :class="{ active: detailView === 'audit' }" @click="detailView = 'audit'">操作记录</button>
        </div>
        <template v-if="detailView === 'episode' && selectedEpisode">
        <div class="review-head">
          <div><p class="eyebrow">片段 {{ String(selectedEpisode.episode).padStart(3, "0") }}</p><h3>{{ selectedEpisode.tasks.join(" / ") || "未命名任务" }}</h3></div>
          <div class="episode-facts"><span>{{ selectedEpisode.frames }} 帧</span><span>{{ selectedDataset?.fps }} FPS</span><span>{{ formatDuration(selectedEpisode.duration) }}</span></div>
        </div>

        <div class="quality-panel" :class="{ warning: selectedEpisode.quality.flags.length }">
          <div><small>自动质量检查</small><strong>{{ selectedEpisode.quality.score }} / 100</strong></div>
          <span>{{ selectedEpisode.quality.cameraCoverage }} / {{ selectedEpisode.quality.expectedCameras }} 路视频</span>
          <ul v-if="selectedEpisode.quality.flags.length"><li v-for="flag in selectedEpisode.quality.flags" :key="flag.code">{{ flag.label }}</li></ul>
          <p v-else>帧数与视频通道检查通过</p>
        </div>

        <div class="videos" :class="{ single: videoEntries.length < 2 }">
          <div v-for="([camera, url], index) in videoEntries" :key="camera" class="video-channel">
            <video :ref="(element) => setVideoRef(element, index)" :src="url" controls muted playsinline preload="metadata" @play="syncPlay(index)" @pause="syncPause(index)" @seeking="syncSeek(index)" @timeupdate="syncTime(index)" @error="videoErrors.add(camera)"></video>
            <span>{{ cameraLabel(camera, index) }}</span>
            <small v-if="videoErrors.has(camera)">视频加载失败，请检查 Robot Server</small>
          </div>
          <div v-if="videoEntries.length === 0" class="video-missing">该 Episode 没有可回放的视频</div>
        </div>

        <div class="review-editor">
          <div class="editor-heading"><strong>审核与标注</strong><label><input v-model="syncEnabled" type="checkbox" /> 双路同步</label></div>
          <div class="status-control" role="group" aria-label="审核状态">
            <button v-for="item in reviewStates" :key="item.value" :class="[item.value, { active: edit.status === item.value }]" @click="edit.status = item.value">{{ item.label }}</button>
          </div>
          <div class="people-fields"><label>负责人<input v-model="edit.assignee" placeholder="未分配" /></label><label>审核人<input v-model="edit.reviewer" placeholder="本地用户" /></label></div>
          <label>标签<input v-model="edit.tags" placeholder="成功, 遮挡, 需复查" /></label>
          <label>审核备注<textarea v-model="edit.notes" rows="3" placeholder="记录动作质量、画面问题或可用范围"></textarea></label>
          <div class="review-meta"><span v-if="selectedEpisode.review.updatedAt">上次更新 {{ formatDate(selectedEpisode.review.updatedAt) }}</span></div>
          <div class="save-row"><span>{{ savedMessage }}</span><button :disabled="saving" @click="saveReview">{{ saving ? "保存中…" : "保存审核" }}</button></div>
        </div>
        </template>

        <section v-else-if="detailView === 'collections'" class="collections-pane">
          <header><div><h3>训练选集</h3></div><span>{{ approvedCount }} 个 Episode 已通过</span></header>
          <div class="publish-box">
            <label>版本名称<input v-model="collectionName" placeholder="例如：抓取任务基线集" /></label>
            <button :disabled="saving || approvedCount === 0" @click="publishCollection">发布已通过数据</button>
            <p>发布后生成不可变 manifest；原始视频和 Parquet 保持在当前 Dataset。</p>
          </div>
          <div v-if="collections.length" class="collection-list">
            <article v-for="item in collections" :key="item.id">
              <div><strong>{{ item.id }} · {{ item.name }}</strong><small>{{ formatDate(item.createdAt) }} · {{ item.episodes.length }} Episodes</small></div>
              <span class="published">已发布</span>
              <a :href="`/api/datasets/${encodeURIComponent(selectedDataset.name)}/collections/${item.id}/manifest`" title="下载训练选集 manifest">下载 manifest</a>
              <button class="collection-delete" title="删除训练选集" @click="deleteCollection(item)">删除</button>
              <p>片段 {{ item.episodes.map((episode) => episode.episode).join(", ") }}</p>
            </article>
          </div>
          <div v-else class="no-results">尚未发布训练选集</div>
        </section>

        <section v-else class="audit-pane">
          <header><div><h3>操作记录</h3></div><span>最近 {{ auditEntries.length }} 条</span></header>
          <div v-if="auditEntries.length" class="audit-list">
            <article v-for="(entry, index) in auditEntries" :key="`${entry.at}-${index}`">
              <span class="audit-action">{{ auditAction(entry.action) }}</span>
              <strong>{{ entry.actor || "本地用户" }}</strong>
              <time>{{ formatDate(entry.at) }}</time>
              <p>{{ auditSummary(entry) }}</p>
            </article>
          </div>
          <div v-else class="no-results">尚无操作记录</div>
        </section>
        </template>
      </section>
      <section v-else class="review-pane empty">选择一个数据集查看详情</section>
      </div>
      </template>
    </template>

    <div v-if="deleteTarget" class="confirm-backdrop" @click.self="closeDeleteDialog">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <span class="danger-mark">!</span>
        <div><p class="eyebrow">DANGER ZONE</p><h3 id="delete-title">删除数据集</h3></div>
        <p>数据集 <strong>{{ deleteTarget.name }}</strong> 将从资产库移出。文件会保留在本地回收目录，可由管理员手动恢复。</p>
        <label>输入数据集名称确认<input v-model="deleteConfirmation" autofocus :placeholder="deleteTarget.name" /></label>
        <div class="confirm-actions">
          <button @click="closeDeleteDialog">取消</button>
          <button class="confirm-delete" :disabled="deleting || deleteConfirmation !== deleteTarget.name" @click="deleteDataset">{{ deleting ? "正在删除…" : "确认删除" }}</button>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";

type ReviewStatus = "unreviewed" | "approved" | "rejected";
interface Review { status: ReviewStatus; tags: string[]; notes: string; assignee?: string; reviewer?: string; qualityFlags?: string[]; createdAt?: string; updatedAt?: string }
interface QualityFlag { code: string; level: "warning" | "error"; label: string }
interface Quality { score: number; flags: QualityFlag[]; cameraCoverage: number; expectedCameras: number }
interface DatasetSummary { name: string; robotType: string | null; fps: number; totalEpisodes: number; totalFrames: number; cameras: string[]; modifiedAt: string; reviews: Record<ReviewStatus, number> }
interface Episode { episode: number; frames: number; duration: number; tasks: string[]; videos: Record<string, string>; quality: Quality; review: Review }
interface TrainingCollection { id: string; name: string; createdAt: string; episodes: Array<{ episode: number; tags: string[]; reviewUpdatedAt: string }> }
interface AuditEntry { at: string; action: string; actor?: string; episodes?: number[]; status?: ReviewStatus; collection?: string; tags?: string[] }

const datasets = ref<DatasetSummary[]>([]);
const episodes = ref<Episode[]>([]);
const selectedDataset = ref<DatasetSummary | null>(null);
const selectedEpisode = ref<Episode | null>(null);
const selectedIds = reactive(new Set<number>());
const root = ref("");
const loading = ref(false);
const detailLoading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const savedMessage = ref("");
const filter = ref<"all" | ReviewStatus>("all");
const qualityFilter = ref<"all" | "issues" | "clean">("all");
const sort = ref("episode-asc");
const query = ref("");
const datasetQuery = ref("");
const syncEnabled = ref(true);
const videos = ref<HTMLVideoElement[]>([]);
const videoErrors = reactive(new Set<string>());
const collections = ref<TrainingCollection[]>([]);
const auditEntries = ref<AuditEntry[]>([]);
const detailView = ref<"episode" | "collections" | "audit">("episode");
const collectionName = ref("");
const deleteTarget = ref<DatasetSummary | null>(null);
const deleteConfirmation = ref("");
const deleting = ref(false);
let syncing = false;
let detailRequest = 0;

const edit = reactive({ status: "unreviewed" as ReviewStatus, tags: "", notes: "", assignee: "", reviewer: "" });
const batch = reactive({ status: "approved" as ReviewStatus, tags: "" });
const filters = [{ value: "all", label: "全部状态" }, { value: "unreviewed", label: "待审核" }, { value: "approved", label: "通过" }, { value: "rejected", label: "拒绝" }] as const;
const reviewStates: { value: ReviewStatus; label: string }[] = [
  { value: "unreviewed", label: "待审核" },
  { value: "approved", label: "通过" },
  { value: "rejected", label: "拒绝" },
];
const totalEpisodes = computed(() => datasets.value.reduce((sum, item) => sum + item.totalEpisodes, 0));
const totalFrames = computed(() => datasets.value.reduce((sum, item) => sum + item.totalFrames, 0));
const reviewedEpisodes = computed(() => datasets.value.reduce((sum, item) => sum + item.reviews.approved + item.reviews.rejected, 0));
const reviewRate = computed(() => totalEpisodes.value ? Math.round(reviewedEpisodes.value / totalEpisodes.value * 100) : 0);
const totalDuration = computed(() => `${Math.round(totalFrames.value / Math.max(1, selectedDataset.value?.fps || 30) / 60)} 分钟`);
const qualityIssueCount = computed(() => episodes.value.filter((item) => item.quality.flags.length).length);
const qualityPassRate = computed(() => episodes.value.length ? Math.round((episodes.value.length - qualityIssueCount.value) / episodes.value.length * 100) : 100);
const pendingReviewCount = computed(() => Math.max(0, totalEpisodes.value - reviewedEpisodes.value));
const filteredDatasets = computed(() => {
  const needle = datasetQuery.value.trim().toLocaleLowerCase();
  return needle ? datasets.value.filter((item) => `${item.name} ${item.robotType || ""}`.toLocaleLowerCase().includes(needle)) : datasets.value;
});
const approvedCount = computed(() => episodes.value.filter((item) => item.review.status === "approved").length);
const filteredEpisodes = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return episodes.value.filter((item) => {
    if (filter.value !== "all" && item.review.status !== filter.value) return false;
    if (qualityFilter.value === "issues" && item.quality.flags.length === 0) return false;
    if (qualityFilter.value === "clean" && item.quality.flags.length > 0) return false;
    return !needle || `#${item.episode} ${item.episode} ${item.tasks.join(" ")} ${item.review.tags.join(" ")}`.toLocaleLowerCase().includes(needle);
  }).sort((a, b) => sort.value === "episode-desc" ? b.episode - a.episode : sort.value === "quality-asc" ? a.quality.score - b.quality.score || a.episode - b.episode : sort.value === "updated-desc" ? (b.review.updatedAt || "").localeCompare(a.review.updatedAt || "") : a.episode - b.episode);
});
const allFilteredSelected = computed(() => filteredEpisodes.value.length > 0 && filteredEpisodes.value.every((item) => selectedIds.has(item.episode)));
const videoEntries = computed(() => Object.entries(selectedEpisode.value?.videos || {}));

function statusText(status: ReviewStatus) { return ({ unreviewed: "待审核", approved: "通过", rejected: "拒绝" })[status]; }
function formatDuration(seconds: number) { const total = Math.max(0, Math.round(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function formatDate(value?: string) { if (!value) return "-"; return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function cameraLabel(camera: string, index: number) { return camera.split(".").pop()?.replace("camera", "摄像头 ") || `摄像头 ${index + 1}`; }
function reviewWidth(item: DatasetSummary, status: ReviewStatus) { return item.totalEpisodes ? `${(item.reviews[status] || 0) / item.totalEpisodes * 100}%` : "0%"; }
function tagsFrom(value: string) { return value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean); }
function auditAction(action: string) { return ({ "review.update": "更新审核", "review.batch": "批量审核", "collection.publish": "发布训练选集", "collection.delete": "删除训练选集" } as Record<string, string>)[action] || action; }
function auditSummary(entry: AuditEntry) {
  const episodesText = entry.episodes?.length ? `Episode ${entry.episodes.join(", ")}` : "";
  const statusTextValue = entry.status ? `设为${statusText(entry.status)}` : "";
  const collectionText = entry.collection ? `生成 ${entry.collection}` : "";
  return [episodesText, statusTextValue, collectionText].filter(Boolean).join(" · ") || "数据集操作";
}

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("Robot Server 无响应，请确认 start_robot.sh 正在运行");
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function loadDatasets(refresh = false) {
  loading.value = true; error.value = null;
  try {
    const data = await requestJson(`/api/datasets${refresh ? "?refresh=1" : ""}`);
    datasets.value = data.datasets || []; root.value = data.root || "";
    if (selectedDataset.value) {
      selectedDataset.value = datasets.value.find((item) => item.name === selectedDataset.value?.name) || null;
    }
    if (!datasets.value.length) { selectedDataset.value = null; selectedEpisode.value = null; episodes.value = []; }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}

async function selectDataset(item: DatasetSummary) {
  const requestId = ++detailRequest;
  selectedDataset.value = item; selectedEpisode.value = null; selectedIds.clear(); error.value = null; detailLoading.value = true;
  try {
    const data = await requestJson(`/api/datasets/${encodeURIComponent(item.name)}`);
    if (requestId !== detailRequest) return;
    episodes.value = data.episodes || [];
    if (episodes.value.length) selectEpisode(episodes.value[0]);
    void loadDatasetOperations(item.name);
  } catch (cause) { if (requestId === detailRequest) { episodes.value = []; error.value = cause instanceof Error ? cause.message : String(cause); } }
  finally { if (requestId === detailRequest) detailLoading.value = false; }
}

function closeDataset() {
  detailRequest += 1;
  selectedDataset.value = null; selectedEpisode.value = null; episodes.value = [];
  collections.value = []; auditEntries.value = []; selectedIds.clear(); detailLoading.value = false;
}

async function loadDatasetOperations(dataset: string) {
  try {
    const [collectionData, auditData] = await Promise.all([
      requestJson(`/api/datasets/${encodeURIComponent(dataset)}/collections`),
      requestJson(`/api/datasets/${encodeURIComponent(dataset)}/audit`),
    ]);
    collections.value = collectionData.collections || [];
    auditEntries.value = auditData.entries || [];
  } catch (cause) {
    collections.value = []; auditEntries.value = [];
    if (selectedDataset.value?.name === dataset) {
      error.value = `数据集操作记录加载失败: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
}

function selectEpisode(item: Episode) {
  videos.value = []; videoErrors.clear(); selectedEpisode.value = item;
  edit.status = item.review.status || "unreviewed"; edit.tags = (item.review.tags || []).join(", "); edit.notes = item.review.notes || "";
  edit.assignee = item.review.assignee || ""; edit.reviewer = item.review.reviewer || ""; savedMessage.value = "";
}
function toggleSelected(episode: number) { selectedIds.has(episode) ? selectedIds.delete(episode) : selectedIds.add(episode); }
function toggleAllFiltered() { if (allFilteredSelected.value) filteredEpisodes.value.forEach((item) => selectedIds.delete(item.episode)); else filteredEpisodes.value.forEach((item) => selectedIds.add(item.episode)); }
function setVideoRef(element: unknown, index: number) { if (element instanceof HTMLVideoElement) videos.value[index] = element; }
function peers(index: number) { return videos.value.filter((_, peer) => peer !== index); }
async function syncPlay(index: number) { if (!syncEnabled.value || syncing) return; syncing = true; for (const video of peers(index)) { video.currentTime = videos.value[index].currentTime; await video.play().catch(() => undefined); } syncing = false; }
function syncPause(index: number) { if (syncEnabled.value && !syncing) peers(index).forEach((video) => video.pause()); }
function syncSeek(index: number) { if (syncEnabled.value && !syncing) peers(index).forEach((video) => { video.currentTime = videos.value[index].currentTime; }); }
function syncTime(index: number) { if (!syncEnabled.value || syncing || !videos.value[index] || videos.value[index].paused) return; for (const video of peers(index)) if (Math.abs(video.currentTime - videos.value[index].currentTime) > .12) video.currentTime = videos.value[index].currentTime; }

function updateReview(episode: number, review: Review) {
  const target = episodes.value.find((item) => item.episode === episode);
  if (!target || !selectedDataset.value) return;
  const previous = target.review.status;
  target.review = review;
  if (previous !== review.status) {
    selectedDataset.value.reviews[previous] = Math.max(0, selectedDataset.value.reviews[previous] - 1);
    selectedDataset.value.reviews[review.status] += 1;
  }
}

async function saveReview() {
  if (!selectedDataset.value || !selectedEpisode.value || saving.value) return;
  saving.value = true; savedMessage.value = "";
  try {
    const episode = selectedEpisode.value.episode;
    const data = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/episodes/${episode}/review`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: edit.status, tags: tagsFrom(edit.tags), notes: edit.notes, assignee: edit.assignee, reviewer: edit.reviewer, qualityFlags: selectedEpisode.value.review.qualityFlags || [] }) });
    updateReview(episode, data.review); selectedEpisode.value.review = data.review; savedMessage.value = "已保存并记录审计";
  } catch (cause) { savedMessage.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

async function saveBatch() {
  if (!selectedDataset.value || !selectedIds.size || saving.value) return;
  saving.value = true; savedMessage.value = "";
  try {
    const data = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/reviews/batch`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodes: [...selectedIds], status: batch.status, tags: tagsFrom(batch.tags), appendTags: true, keepExisting: true, reviewer: edit.reviewer }) });
    Object.entries(data.reviews as Record<string, Review>).forEach(([episode, review]) => updateReview(Number(episode), review));
    if (selectedEpisode.value && data.reviews[String(selectedEpisode.value.episode)]) selectEpisode(selectedEpisode.value);
    selectedIds.clear(); batch.tags = ""; savedMessage.value = `已批量更新 ${data.count} 项`;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

async function publishCollection() {
  if (!selectedDataset.value || !collectionName.value.trim() || saving.value) return;
  saving.value = true; error.value = null;
  try {
    const data = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/collections`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: collectionName.value, episodes: episodes.value.filter((item) => item.review.status === "approved").map((item) => item.episode), actor: edit.reviewer }),
    });
    collections.value.unshift(data.collection); collectionName.value = "";
    const auditData = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/audit`);
    auditEntries.value = auditData.entries || [];
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

function openDeleteDataset(item: DatasetSummary) {
  deleteTarget.value = item;
  deleteConfirmation.value = "";
}
function closeDeleteDialog() {
  if (deleting.value) return;
  deleteTarget.value = null;
  deleteConfirmation.value = "";
}
async function deleteDataset() {
  if (!deleteTarget.value || deleteConfirmation.value !== deleteTarget.value.name || deleting.value) return;
  deleting.value = true; error.value = null;
  const name = deleteTarget.value.name;
  try {
    await requestJson(`/api/datasets/${encodeURIComponent(name)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: deleteConfirmation.value }),
    });
    if (selectedDataset.value?.name === name) closeDataset();
    closeDeleteDialog();
    await loadDatasets(true);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { deleting.value = false; if (deleteTarget.value?.name === name) closeDeleteDialog(); }
}
async function deleteCollection(item: TrainingCollection) {
  if (!selectedDataset.value || saving.value || !window.confirm(`删除训练选集 ${item.id} · ${item.name}？原始数据不会被删除。`)) return;
  saving.value = true; error.value = null;
  try {
    await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/collections/${encodeURIComponent(item.id)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: edit.reviewer }),
    });
    await loadDatasetOperations(selectedDataset.value.name);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

onMounted(loadDatasets);
</script>

<style scoped>
.workspace { container-type: inline-size; max-width: 1900px; margin: 0 auto; padding: 18px 24px 28px; }
.workspace-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }.workspace-head h2 { margin-top: 2px; font-size: 20px; }.eyebrow { color: #78a9c6; font-size: 9px; font-weight: 700; letter-spacing: 1px; }
.icon-button { width: 32px; height: 32px; border: 1px solid #315574; border-radius: 5px; background: #102941; color: #8dd4f4; cursor: pointer; font-size: 18px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid rgba(151,188,222,.15); border-bottom: 0; background: #0b1724; }.kpis div { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 3px 10px; min-width: 0; padding: 11px 14px; border-right: 1px solid rgba(151,188,222,.12); }.kpis div:last-child { border-right: 0; }.kpis small { color: #7890a3; font-size: 9px; }.kpis strong { grid-row: 1 / span 2; grid-column: 2; color: #e7f1f7; font: 22px ui-monospace, monospace; }.kpis strong.alert { color: #ff9aa7; }.kpis span { color: #587185; font-size: 9px; }
.workspace-error { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; padding: 8px 11px; border-left: 3px solid #ff7384; background: #25141b; color: #ffadb7; font-size: 11px; }.workspace-error button { border: 0; border-radius: 4px; padding: 5px 9px; background: #713040; color: white; cursor: pointer; }
.catalog-skeleton,.dataset-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; }.catalog-skeleton { padding-top: 14px; }.catalog-skeleton i { min-height: 190px; border: 1px solid rgba(151,188,222,.1); border-radius: 10px; background: linear-gradient(100deg,#0d1a28 30%,#142a3c 48%,#0d1a28 66%); background-size: 220% 100%; animation: catalog-shimmer 1.25s linear infinite; }
@keyframes catalog-shimmer { to { background-position-x: -220%; } }
.catalog-view { min-height: calc(100vh - 190px); border: 1px solid rgba(151,188,222,.15); border-radius: 10px; background: rgba(10,22,35,.72); }.catalog-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 17px; border-bottom: 1px solid rgba(151,188,222,.12); }.catalog-heading > div { display: grid; gap: 3px; }.catalog-heading strong { font-size: 13px; }.catalog-heading small { max-width: 600px; overflow: hidden; color: #607b90; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.catalog-heading label { display: flex; align-items: center; gap: 7px; width: min(310px,40vw); padding: 0 10px; border: 1px solid #29435f; border-radius: 6px; background: #091522; color: #688195; }.catalog-heading input { width: 100%; padding: 9px 0; border: 0; outline: 0; background: transparent; color: #e7edf8; font-size: 10px; }
.dataset-grid { padding: 16px; }.dataset-card { display: grid; grid-template-columns: auto 1fr; gap: 5px 10px; min-height: 190px; padding: 16px; border: 1px solid rgba(151,188,222,.14); border-radius: 9px; text-align: left; cursor: pointer; background: linear-gradient(145deg,rgba(18,39,57,.95),rgba(10,22,34,.95)); color: #dce8f2; transition: border-color .16s,transform .16s,box-shadow .16s; }.dataset-card:hover { transform: translateY(-2px); border-color: rgba(100,201,232,.5); box-shadow: 0 12px 28px rgba(0,0,0,.2); }.card-icon { grid-row: 1/span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 7px; background: #173d55; color: #77cce9; font-size: 17px; }.card-title { overflow: hidden; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }.card-type { color: #6f899c; font-size: 9px; }.card-stats { grid-column: 1/-1; display: flex; align-items: baseline; gap: 5px; margin-top: 10px; color: #718b9e; font-size: 9px; }.card-stats b { color: #d8e8f2; font: 16px ui-monospace,monospace; }.card-stats i { width: 1px; height: 13px; margin: 0 5px; background: #2a4153; }.card-tags { grid-column: 1/-1; display: flex; gap: 5px; }.card-tags em { padding: 3px 6px; border-radius: 4px; background: #122b3d; color: #7fa4b9; font-size: 8px; font-style: normal; }.dataset-card .review-meter { grid-column: 1/-1; align-self: end; }.card-foot { grid-column: 1/-1; display: flex; align-items: center; justify-content: space-between; margin-top: 3px; }.card-foot small { color: #607b90; font-size: 8px; }.card-foot b { color: #72cbe9; font-size: 9px; }
.dataset-context { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 13px; padding: 11px 14px; border: 1px solid rgba(151,188,222,.15); border-bottom: 0; background: #0b1724; }.dataset-context button { padding: 7px 9px; border: 1px solid #29435f; border-radius: 5px; cursor: pointer; background: #10263a; color: #8dbbd2; font-size: 9px; }.dataset-context div { display: grid; gap: 2px; }.dataset-context strong { font-size: 12px; }.dataset-context small { color: #668196; font-size: 8px; }.dataset-context > span { color: #62c995; font-size: 9px; }.dataset-context > span.loading { color: #e6bd67; }
.data-layout { display: grid; grid-template-columns: 335px minmax(500px, 1fr); min-height: calc(100vh - 245px); border: 1px solid rgba(151,188,222,.15); background: #0d1928; }.episode-list { min-width: 0; border-right: 1px solid rgba(151,188,222,.13); }
.pane-title { display: flex; flex-direction: column; justify-content: center; min-height: 54px; padding: 9px 12px; border-bottom: 1px solid rgba(151,188,222,.13); }.pane-title strong { font-size: 11px; }.pane-title small { overflow: hidden; margin-top: 3px; color: #647f94; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.episode-title { flex-direction: row; align-items: center; justify-content: space-between; }
.dataset-row { position: relative; display: grid; gap: 5px; width: 100%; padding: 12px; border: 0; border-bottom: 1px solid rgba(151,188,222,.08); text-align: left; cursor: pointer; background: transparent; color: #dce8f2; }.dataset-row:hover,.dataset-row.selected { background: #14283b; }.dataset-row.selected::before,.episode-row.active::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: #66c8e8; }.dataset-name { overflow: hidden; font-size: 11px; font-weight: 650; text-overflow: ellipsis; }.dataset-meta,.dataset-time { color: #738da1; font-size: 8px; }.review-meter { display: flex; height: 3px; overflow: hidden; background: #263545; }.review-meter i.approved { background: #54c994; }.review-meter i.rejected { background: #e86676; }
.episode-tools { display: grid; gap: 6px; padding: 8px; border-bottom: 1px solid rgba(151,188,222,.1); }.search { display: flex; align-items: center; gap: 5px; padding: 0 7px; border: 1px solid #29435f; border-radius: 4px; background: #091522; color: #688195; }.search input { min-width: 0; width: 100%; padding: 7px 0; border: 0; outline: 0; background: transparent; color: #e7edf8; font-size: 10px; }.tool-row { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 4px; } select,.batch-bar input { min-width: 0; padding: 6px; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #101f2e; color: #a8bdcc; font-size: 9px; }.select-all { display: flex; align-items: center; gap: 6px; color: #7890a3; font-size: 9px; }
.batch-bar { display: grid; grid-template-columns: auto 75px minmax(70px,1fr) auto 25px; align-items: center; gap: 5px; padding: 7px 8px; border-bottom: 1px solid #315574; background: #142c40; color: #b8d3e5; font-size: 9px; }.batch-bar button { padding: 6px 9px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.batch-bar .clear { padding: 3px; background: transparent; color: #91a9bb; font-size: 16px; }
.episode-scroll { max-height: calc(100vh - 365px); overflow: auto; }.episode-loading,.no-results { display: grid; place-items: center; min-height: 140px; color: #71899c; font-size: 10px; }.episode-row { position: relative; display: grid; grid-template-columns: 28px 1fr; align-items: center; border-bottom: 1px solid rgba(151,188,222,.08); }.episode-row:hover,.episode-row.active { background: #14283b; }.episode-row > input { justify-self: center; }.episode-row > button { display: grid; grid-template-columns: 1fr auto; gap: 5px; min-width: 0; padding: 10px 10px 10px 0; border: 0; text-align: left; cursor: pointer; background: transparent; color: #dce8f2; }.episode-index { font: 10px ui-monospace, monospace; }.episode-duration { color: #8197aa; font: 9px ui-monospace, monospace; }.episode-task { grid-column: 1/-1; overflow: hidden; color: #9fb1c0; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.review-state,.quality-state { width: fit-content; padding: 2px 5px; border-radius: 3px; color: #8ba0b0; background: #253443; font-size: 8px; }.quality-state { grid-column: 2; grid-row: 3; }.review-state.approved { color: #65daa4; background: #173a31; }.review-state.rejected,.quality-state.issue { color: #ff91a0; background: #3a2028; }
.review-pane { min-width: 0; padding: 14px; overflow: hidden; }.review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 10px; }.review-head h3 { max-width: 650px; margin-top: 3px; overflow-wrap: anywhere; font-size: 14px; }.episode-facts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }.episode-facts span { padding: 4px 6px; border-radius: 4px; background: #152638; color: #89a1b4; font: 9px ui-monospace, monospace; }
.detail-skeleton { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }.detail-skeleton i { height: 34px; border-radius: 5px; background: linear-gradient(100deg,#102030 30%,#1a3347 48%,#102030 66%); background-size: 220% 100%; animation: catalog-shimmer 1.25s linear infinite; }.detail-skeleton .wide { grid-column: 1/-1; }.detail-skeleton .video { height: auto; aspect-ratio: 16/9; }
.detail-tabs { display: flex; gap: 3px; margin: -4px 0 12px; border-bottom: 1px solid rgba(151,188,222,.13); }.detail-tabs button { position: relative; padding: 8px 10px; border: 0; cursor: pointer; background: transparent; color: #71899c; font-size: 9px; }.detail-tabs button.active { color: #dff5ff; }.detail-tabs button.active::after { content: ""; position: absolute; right: 8px; bottom: -1px; left: 8px; height: 2px; background: #64c9e8; }.detail-tabs span { margin-left: 3px; color: #5e849b; }
.quality-panel { display: grid; grid-template-columns: auto auto 1fr; align-items: center; gap: 5px 14px; margin-bottom: 10px; padding: 8px 10px; border-left: 3px solid #4fbd8b; background: #10251f; }.quality-panel.warning { border-color: #e66d7c; background: #27181e; }.quality-panel div { display: flex; align-items: baseline; gap: 7px; }.quality-panel small,.quality-panel span,.quality-panel p,.quality-panel li { color: #8199a9; font-size: 9px; }.quality-panel strong { font: 13px ui-monospace,monospace; }.quality-panel ul { display: flex; gap: 12px; margin: 0; padding: 0; list-style: none; }.quality-panel p { margin: 0; }
.videos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.videos.single { grid-template-columns: minmax(280px,720px); }.video-channel { min-width: 0; background: #05090e; }.video-channel video { display: block; width: 100%; aspect-ratio: 16/9; background: #000; }.video-channel span,.video-channel small { display: block; padding: 5px 7px; color: #7892a6; font-size: 9px; }.video-channel small { color: #ff91a0; }.video-missing { grid-column: 1/-1; display: grid; place-items: center; min-height: 220px; color: #61798c; background: #080f18; font-size: 11px; }
.review-editor { display: grid; gap: 8px; margin-top: 11px; padding-top: 11px; border-top: 1px solid rgba(151,188,222,.13); }.editor-heading { display: flex; align-items: center; justify-content: space-between; }.editor-heading strong { font-size: 11px; }.editor-heading label { display: flex; align-items: center; gap: 5px; color: #8197aa; font-size: 9px; }.status-control { display: grid; grid-template-columns: repeat(3,1fr); gap: 4px; }.status-control button { padding: 7px; border: 1px solid #29435f; border-radius: 4px; cursor: pointer; background: transparent; color: #8095a6; font-size: 9px; }.status-control button.active { background: #294050; color: white; }.status-control button.approved.active { background: #24684f; }.status-control button.rejected.active { background: #793746; }.review-editor > label,.people-fields label { display: grid; gap: 4px; color: #8ca2b3; font-size: 9px; }.people-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.review-editor input,.review-editor textarea { width: 100%; padding: 7px; resize: vertical; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #091522; color: #e7edf8; font: 10px/1.5 inherit; }.review-meta { color: #647d90; font-size: 8px; }.save-row { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-height: 31px; color: #69d7a3; font-size: 9px; }.save-row button { padding: 7px 13px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-weight: 650; }.empty { display: grid; place-items: center; min-height: 240px; color: #667f92; }
.collections-pane > header,.audit-pane > header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }.collections-pane h3,.audit-pane h3 { margin-top: 3px; font-size: 15px; }.collections-pane > header > span,.audit-pane > header > span { color: #7890a3; font-size: 9px; }.publish-box { display: grid; grid-template-columns: minmax(180px,1fr) auto; align-items: end; gap: 8px; padding: 12px; border: 1px solid #28425a; background: #0a1622; }.publish-box label { display: grid; gap: 5px; color: #8ca2b3; font-size: 9px; }.publish-box input { min-width: 0; padding: 8px; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #101f2e; color: #e7edf8; font-size: 10px; }.publish-box button { height: 33px; padding: 0 12px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.publish-box button:disabled { cursor: not-allowed; opacity: .45; }.publish-box p { grid-column: 1/-1; margin: 0; color: #60798c; font-size: 8px; }.collection-list,.audit-list { margin-top: 10px; border-top: 1px solid rgba(151,188,222,.12); }.collection-list article { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 7px 12px; padding: 11px 5px; border-bottom: 1px solid rgba(151,188,222,.1); }.collection-list article div { display: grid; gap: 3px; }.collection-list strong { font-size: 10px; }.collection-list small,.collection-list p { color: #6f879a; font-size: 8px; }.collection-list p { grid-column: 1/-1; margin: 0; }.collection-list a { color: #77cce9; font-size: 9px; text-decoration: none; }.published { padding: 2px 5px; border-radius: 3px; background: #173a31; color: #65daa4; font-size: 8px; }.audit-list article { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 5px 9px; padding: 10px 5px; border-bottom: 1px solid rgba(151,188,222,.1); }.audit-list strong,.audit-list time { color: #8299aa; font-size: 8px; }.audit-list time { font-family: ui-monospace,monospace; }.audit-list p { grid-column: 2/-1; margin: 0; color: #b3c5d1; font-size: 9px; }.audit-action { padding: 3px 5px; border-radius: 3px; background: #173148; color: #8acfea; font-size: 8px; }
@container (max-width: 1150px) { .catalog-skeleton,.dataset-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.data-layout { grid-template-columns: 300px minmax(300px,1fr); }.episode-scroll { max-height: 360px; } }
@container (max-width: 720px) { .workspace { padding: 10px; }.kpis { grid-template-columns: 1fr 1fr; }.kpis div:nth-child(2) { border-right: 0; }.kpis div:nth-child(-n+2) { border-bottom: 1px solid rgba(151,188,222,.12); }.catalog-heading { align-items: stretch; flex-direction: column; }.catalog-heading label { width: 100%; }.catalog-skeleton,.dataset-grid { grid-template-columns: 1fr; }.dataset-context { grid-template-columns: auto 1fr; }.dataset-context > span { grid-column: 2; }.data-layout { display: block; }.episode-list { max-height: none; border-right: 0; border-bottom: 1px solid rgba(151,188,222,.13); }.episode-scroll { max-height: 300px; }.review-pane { padding: 10px; }.review-head { flex-direction: column; }.episode-facts { justify-content: flex-start; }.videos { grid-template-columns: 1fr; }.quality-panel { grid-template-columns: 1fr auto; }.quality-panel ul,.quality-panel p { grid-column: 1/-1; }.batch-bar { grid-template-columns: auto 75px 1fr auto 25px; }.publish-box { grid-template-columns: 1fr; }.publish-box p { grid-column: 1; } }
@container (max-width: 440px) { .kpis strong { font-size: 18px; }.tool-row { grid-template-columns: 1fr 1fr; }.tool-row select:last-child { grid-column: 1/-1; }.batch-bar { grid-template-columns: 1fr 1fr; }.batch-bar input { grid-column: 1/-1; }.batch-bar .clear { position: absolute; right: 15px; }.people-fields { grid-template-columns: 1fr; } }

/* Black data studio theme */
.workspace-head { margin-bottom:16px; }.workspace-head h2 { margin-top:3px;font-size:24px;letter-spacing:-.5px; }.workspace-head > div > span { display:block;margin-top:5px;color:#71717a;font-size:10px; }.eyebrow { color:#9b87f5;letter-spacing:1.4px; }
.icon-button { width:auto;height:34px;padding:0 13px;border-color:#303030;border-radius:7px;background:#121212;color:#d4d4d8;font-size:10px; }
.kpis,.dataset-context { border-color:#242424;background:#0d0d0d; }.kpis div { border-color:#222; }.catalog-view { border-color:#222;background:#0a0a0a; }
.catalog-heading,.episode-list,.pane-title,.detail-tabs { border-color:#242424; }.catalog-heading label,.search { border-color:#303030;background:#0d0d0d; }
.dataset-card { position:relative;display:block;min-height:190px;padding:0;border-color:#262626;border-radius:11px;background:linear-gradient(145deg,#121212,#0c0c0c);color:#f4f4f5;overflow:hidden; }
.dataset-card:hover { border-color:#51458d;box-shadow:0 16px 36px rgba(0,0,0,.38); }.card-open { display:grid;grid-template-columns:auto 1fr;gap:5px 10px;width:100%;min-height:190px;padding:16px;border:0;text-align:left;cursor:pointer;background:transparent;color:inherit; }
.card-delete { position:absolute;top:10px;right:9px;width:30px;height:25px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:#71717a;cursor:pointer;letter-spacing:1px; }.card-delete:hover { border-color:#3f2026;background:#231216;color:#ff8492; }
.card-icon { background:#211d35;color:#ae9cff;font:700 13px ui-monospace,monospace; }.card-tags em { border:1px solid #292929;background:#171717;color:#a1a1aa; }
.context-actions { display:flex!important;align-items:center;gap:10px!important; }.context-actions span { color:#62c995;font-size:9px; }.context-actions span.loading { color:#e6bd67; }.danger-button { border-color:#3c2428!important;background:#1b1013!important;color:#ff8492!important; }
.data-layout { border-color:#242424;background:#0b0b0b; }.episode-row:hover,.episode-row.active { background:#16141c; }.review-pane,.publish-box { background:#0b0b0b; }.review-editor input,.review-editor textarea,select,.batch-bar input,.publish-box input { border-color:#303030;background:#111;color:#e4e4e7; }
.collection-list article { grid-template-columns:1fr auto auto auto; }.collection-delete { padding:4px 7px;border:1px solid #3c2428;border-radius:4px;background:#1b1013;color:#ff8492;cursor:pointer;font-size:8px; }
.confirm-backdrop { position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.82);backdrop-filter:blur(9px); }
.confirm-dialog { display:grid;grid-template-columns:38px 1fr;gap:15px;width:min(480px,100%);padding:22px;border:1px solid #3a2428;border-radius:14px;background:#0d0d0d;box-shadow:0 28px 90px #000; }
.danger-mark { display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:#291217;color:#ff7585;font-weight:800; }.confirm-dialog h3 { margin-top:3px;font-size:18px; }.confirm-dialog > p,.confirm-dialog > label,.confirm-actions { grid-column:1/-1; }.confirm-dialog > p { color:#a1a1aa;font-size:11px;line-height:1.6; }.confirm-dialog > p strong { color:#fff; }.confirm-dialog label { display:grid;gap:7px;color:#a1a1aa;font-size:10px; }.confirm-dialog input { padding:10px;border:1px solid #363636;border-radius:7px;outline:0;background:#050505;color:#fff; }.confirm-dialog input:focus { border-color:#7c3f49; }
.confirm-actions { display:flex;justify-content:flex-end;gap:8px;margin-top:3px; }.confirm-actions button { padding:8px 13px;border:1px solid #303030;border-radius:7px;background:#171717;color:#d4d4d8;cursor:pointer; }.confirm-actions .confirm-delete { border-color:#71303a;background:#c23e50;color:#fff; }.confirm-actions button:disabled { opacity:.35;cursor:not-allowed; }
</style>
