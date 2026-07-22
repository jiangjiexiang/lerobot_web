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
import type { JointData } from "../composables/useWebSocket";

const jointNames: (keyof JointData)[] = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
];

defineProps<{
  leader: JointData | null;
  follower: JointData | null;
}>();

function formatVal(v: number | undefined): string {
  if (v === undefined || v === null) return "-";
  return v.toFixed(1);
}
</script>

<style scoped>
h2 {
  font-size: 13px;
  color: #888;
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  padding: 5px 8px;
  border-bottom: 1px solid #222;
  text-align: right;
}
th {
  color: #888;
  text-align: center;
}
td:first-child,
th:first-child {
  text-align: left;
  color: #aaa;
}
</style>
