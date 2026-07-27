# 机器人数据采集与管理平台产品方案

## 目标

平台覆盖从设备采集、数据入库、质量检查、审核标注、检索回放，到版本化导出训练集的完整闭环。原始 LeRobot 数据保持只读；审核、标注、版本和审计信息先写入 `.lerobot-web/` sidecar，只有导出时才生成新的训练版本。

## 竞品能力矩阵

| 能力 | Roboto | Foxglove | FiftyOne | 当前平台 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| Dataset / Recording 目录 | Dataset、Collection | Recording、Session | Dataset、Sample | 已有 Dataset / Episode | 增加设备、操作者、场景元数据 |
| 检索与保存视图 | RoboQL | 条件搜索、保存查询 | Dataset View | 搜索、筛选、排序 | 保存筛选视图 |
| 多模态回放 | Interactive Visualizer | Timeline + Panels | Video / 3D Visualizer | 双路视频同步 | 加入关节曲线和统一时间轴 |
| 时间区间标注 | Events | Events / Event Types | Temporal labels | 尚无 | Episode 时间区间事件标注 |
| 审核工作流 | Agent / Annotation | Event 协作 | QA / Approval | 单条、批量审核 | 分配人、审核人、审核队列 |
| 数据质量 | 自动处理 Actions | Problems / Playback stats | Mistakes、Duplicates、Uniqueness | 缺视频、短片段自动检查 | 黑屏、冻结、轨迹异常、重复检测 |
| 版本与导出 | Versioned Collection | 时间段 / Topic 导出 | Dataset Versioning / Export | 尚无 | Snapshot、选集导出、manifest |
| 设备与采集运维 | Device、Action | Device、Edge Agent | 非核心 | 摄像头与遥操作状态 | 设备资产、采集任务和健康记录 |
| 权限与审计 | 可审计结果 | 团队共享 | Roles / Permissions | 本地审计日志 | 用户、角色、操作历史界面 |

参考资料：

- Roboto: <https://docs.roboto.ai/learn/concepts.html>
- Roboto user guides: <https://docs.roboto.ai/user-guides/index.html>
- Foxglove data: <https://docs.foxglove.dev/docs/data>
- Foxglove search and events: <https://docs.foxglove.dev/docs/data/search>, <https://docs.foxglove.dev/docs/data/events>
- FiftyOne App: <https://docs.voxel51.com/user_guide/app.html>

## 数据模型

### Dataset

- 原始字段：名称、LeRobot 版本、机器人类型、FPS、帧数、Episode 数、相机通道。
- 业务字段：设备、操作者、场景、采集时间、描述、生命周期状态。
- 版本字段：父版本、筛选条件、Episode 清单、生成时间、导出格式。

### Episode Review

- `status`: `unreviewed | approved | rejected`
- `tags`, `notes`
- `assignee`, `reviewer`
- `qualityFlags`: 人工确认的数据质量问题
- `createdAt`, `updatedAt`

### Event / Annotation

- Dataset、Episode、起止时间、类型、结构化字段、标签、备注。
- 创建人、修改人、创建时间、修改时间。
- Event Type 支持文本、数字、布尔、单选和多选字段。

### Audit Log

- 时间、操作者、动作、Dataset、Episode 清单、变更摘要。
- 审核、批量操作、标注、版本和导出都必须记录。

## 分阶段路线图

### 第一阶段：可运营的数据目录

- 总览 KPI、搜索、状态筛选、排序。
- Episode 多选、批量审核与批量标签。
- 自动质量检查、结构化 Episode 详情。
- 审核 sidecar 与审计日志。

### 第二阶段：标注与同步分析

- 视频、关节状态、动作曲线共用时间轴。
- 时间区间 Event 标注与结构化 Event Type。
- 审核队列、负责人、保存视图。
- 按 Episode 或时间段导出。

### 第三阶段：版本与协作

- Dataset snapshot、差异比较、训练版本 manifest。
- 用户、角色、权限和团队工作区。
- 数据质量任务：黑屏、冻结、轨迹越界、重复片段。
- Device、采集任务、数据上传和边缘节点健康管理。

## 实现原则

1. 原始 LeRobot Parquet 和视频默认只读。
2. 所有人工操作可审计，批量操作也保留 Episode 清单。
3. 自动质量规则给出原因，不直接删除数据。
4. 筛选结果可复现，训练数据由明确的版本 manifest 生成。
5. UI 优先服务高频扫描、比较、审核和批量处理流程。

## 已对齐的数据采集流程

- 双摄像头必须连接到不同 USB HUB，避免总线带宽不足。
- 摄像头使用 MJPG。6GB 以下显存默认 `640x360@30fps`；`1280x720` 直接训练建议 12GB 以上显存。
- 插拔或重启后摄像头序号可能变化，采集前必须确认手眼相机和固定相机的物理映射。
- 录制参数包含 Dataset 名称、单任务描述、计划 Episode 数、单轮时长、复位时间、FPS 和显式续录。
- 单轮到时自动保存，也支持提前保存；丢弃对应重录当前轮次。
- 建议先采集约 10 组跑通流程，效果不足时扩充到 50 组以上。
- 本地数据默认存于 `/home/nvidia/lerobot_datasets/<dataset>`，不上传 Hugging Face。

## 已对齐的数据训练流程

- 默认 ACT；可选 Diffusion、TDMPC、VQ-BeT、SmolVLA、Pi0、Pi0 Fast、SAC 和 Reward Classifier。
- 训练任务必须绑定一个已发布的训练选集，只读取审核通过的 Episode。
- 默认 `policy.push_to_hub=false`、`wandb.enable=false`，输出保存到 `.lerobot-web/training/outputs/<job-id>`。
- 主机检测展示 CPU、内存、磁盘、CUDA、GPU 型号和显存，并给出分辨率与 batch size 建议。
- SmolVLA 在 8GB 显存设备上建议 batch size 不超过 28；Pi0 提示额外安装 `lerobot[pi]`。
- 任务状态包括待启动、训练中、停止中、已完成和失败；保存命令、日志、退出码、输出目录和 Checkpoint。
- 中断续训使用 `checkpoints/last/pretrained_model/train_config.json` 与 `--resume=true`。

## 后续训练闭环

- 从日志解析 step、loss、gradient norm、learning rate 和吞吐率曲线。
- Checkpoint 浏览、指标比较、模型版本登记。
- 实时推理评估任务与评估 Dataset 隔离，避免覆盖训练数据。
- 模型部署、回滚和推理异常记录。
