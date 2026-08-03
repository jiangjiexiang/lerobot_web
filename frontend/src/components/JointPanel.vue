<template>
  <div class="joint-panel">
    <h2>关节数据</h2>
    <table>
      <thead>
        <tr>
          <th>关节</th>
          <th>Leader</th>
          <th>Follower</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="name in jointNames" :key="name">
          <td>{{ name }}</td>
          <td>{{ leader ? formatVal(leader[name]) : "-" }}</td>
          <td>{{ follower ? formatVal(follower[name]) : "-" }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { JointData } from "../composables/useWebSocket";

const defaultJointNames = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
];

const props = defineProps<{
  leader: JointData | null;
  follower: JointData | null;
}>();

const jointNames = computed(() => {
  const names = new Set([
    ...Object.keys(props.leader || {}),
    ...Object.keys(props.follower || {}),
  ]);
  return names.size > 0 ? [...names] : defaultJointNames;
});

function formatVal(v: number | undefined): string {
  if (v === undefined || v === null) return "-";
  return v.toFixed(1);
}
</script>

<style scoped>
h2 {
  font-size: 13px;
  color: #3b3e41;
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  padding: 5px 8px;
  border-bottom: 1px solid #e7e8e8;
  text-align: right;
}
th {
  color: #8a8e91;
  text-align: center;
}
td:first-child,
th:first-child {
  text-align: left;
  color: #5f6366;
}
</style>
