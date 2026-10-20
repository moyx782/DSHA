'use strict';

// 纯路由决策：不运行命令、不把未验证的配置冒充为节点探测结果。
const TASK_KINDS = new Set(['cpu', 'gpu', 'android', 'general']);
const ROLES = new Set(['mac', 'workstation', 'android', 'server', 'other']);
const GPU_BACKENDS = new Set(['none', 'cuda', 'metal', 'rocm', 'vulkan']);
const MAX_NODES = 64;
const HEARTBEAT_TTL_MS = 60000;
const MAX_FUTURE_SKEW_MS = 5000;

function ident(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}
function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function nonNegativeOrDefault(value, fallback) {
  return value === undefined ? fallback : value;
}
function validateTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
      !TASK_KINDS.has(task.kind)) throw Error('INVALID_TASK_KIND');
  const keys = new Set(['id','kind','minCpuCores','minMemoryMb','minVramMb','requiresCuda',
    'requiredCapabilities','preferredNodeId','sourceNodeId','sourceRegion',
    'dataPolicy','maxLatencyMs']);
  if (Object.keys(task).some(key => !keys.has(key))) throw Error('UNKNOWN_TASK_FIELD');
  if (task.id !== undefined && !ident(task.id)) throw Error('INVALID_TASK_ID');
  for (const key of ['minCpuCores','minMemoryMb','minVramMb','maxLatencyMs']) {
    if (task[key] !== undefined && !nonNegative(task[key])) throw Error('INVALID_' + key);
  }
  if (task.requiresCuda !== undefined && typeof task.requiresCuda !== 'boolean')
    throw Error('INVALID_CUDA_REQUIREMENT');
  if (task.preferredNodeId !== undefined && !ident(task.preferredNodeId))
    throw Error('INVALID_PREFERRED_NODE');
  if (task.sourceNodeId !== undefined && !ident(task.sourceNodeId))
    throw Error('INVALID_SOURCE_NODE');
  if (task.sourceRegion !== undefined && !ident(task.sourceRegion))
    throw Error('INVALID_SOURCE_REGION');
  if (task.dataPolicy !== undefined &&
      !['paired-only','local-only'].includes(task.dataPolicy)) throw Error('INVALID_DATA_POLICY');
  if (task.dataPolicy === 'local-only' && !task.sourceNodeId)
    throw Error('LOCAL_ONLY_REQUIRES_SOURCE');
  if (task.requiredCapabilities !== undefined &&
      (!Array.isArray(task.requiredCapabilities) || task.requiredCapabilities.length > 16 ||
       task.requiredCapabilities.some(cap => !ident(cap))))
    throw Error('INVALID_REQUIRED_CAPABILITIES');
  return {
    id: task.id || '',
    kind: task.kind,
    minCpuCores: nonNegativeOrDefault(task.minCpuCores, 1),
    minMemoryMb: nonNegativeOrDefault(task.minMemoryMb, 0),
    minVramMb: nonNegativeOrDefault(task.minVramMb, 0),
    requiresCuda: task.requiresCuda === true,
    requiredCapabilities: task.requiredCapabilities || [],
    preferredNodeId: task.preferredNodeId || '',
    sourceNodeId: task.sourceNodeId || '',
    sourceRegion: task.sourceRegion || '',
    dataPolicy: task.dataPolicy || 'paired-only',
    maxLatencyMs: nonNegativeOrDefault(task.maxLatencyMs, null)
  };
}
function validateInventory(nodes) {
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw Error('INVALID_NODE_COUNT');
  const ids = new Set();
  return nodes.map(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node) ||
        !ident(node.id) || !ROLES.has(node.role) || ids.has(node.id))
      throw Error('INVALID_NODE_ID_OR_ROLE');
    ids.add(node.id);
    const numeric = ['observedAt','availableCpuCores','availableMemoryMb',
      'availableVramMb','activeJobs','maxJobs','latencyMs'];
    if (numeric.some(key => !nonNegative(node[key]))) throw Error('INVALID_NODE_METRICS');
    if (!GPU_BACKENDS.has(node.gpuBackend) ||
        typeof node.online !== 'boolean' || typeof node.paired !== 'boolean' ||
        !Array.isArray(node.capabilities) || node.capabilities.length > 32 ||
        node.capabilities.some(cap => !ident(cap)))
      throw Error('INVALID_NODE_CAPABILITIES');
    if (node.region !== undefined && !ident(node.region)) throw Error('INVALID_NODE_REGION');
    // 丢弃配置文件里与调度无关的字段，包括地址、凭据及命令。
    return {
      id: node.id, role: node.role, region: node.region || '',
      paired: node.paired, online: node.online, observedAt: node.observedAt,
      availableCpuCores: node.availableCpuCores, availableMemoryMb: node.availableMemoryMb,
      gpuBackend: node.gpuBackend, availableVramMb: node.availableVramMb,
      activeJobs: node.activeJobs, maxJobs: node.maxJobs, latencyMs: node.latencyMs,
      capabilities: [...new Set(node.capabilities)]
    };
  });
}
function fresh(node, now) {
  return node.observedAt > 0 && node.observedAt <= now + MAX_FUTURE_SKEW_MS &&
    now - node.observedAt <= HEARTBEAT_TTL_MS;
}
function rejectReason(task, node, now) {
  if (!node.paired) return 'NOT_PAIRED';
  if (!node.online) return 'OFFLINE';
  if (!fresh(node, now)) return 'HEARTBEAT_STALE_OR_UNVERIFIED';
  if (node.activeJobs >= node.maxJobs) return 'NO_FREE_JOB_SLOT';
  if (task.dataPolicy === 'local-only' && task.sourceNodeId !== node.id)
    return 'LOCAL_ONLY';
  if (node.availableCpuCores < task.minCpuCores) return 'INSUFFICIENT_CPU';
  if (node.availableMemoryMb < task.minMemoryMb) return 'INSUFFICIENT_MEMORY';
  if (task.kind === 'android' && node.role !== 'android') return 'NOT_ANDROID';
  if (task.kind === 'gpu' && (node.gpuBackend === 'none' || node.availableVramMb === 0))
    return 'NO_GPU';
  if (node.availableVramMb < task.minVramMb) return 'INSUFFICIENT_VRAM';
  if (task.requiresCuda && node.gpuBackend !== 'cuda') return 'CUDA_REQUIRED';
  if (task.maxLatencyMs !== null && node.latencyMs > task.maxLatencyMs) return 'LATENCY_EXCEEDED';
  if (task.requiredCapabilities.some(cap => !node.capabilities.includes(cap)))
    return 'CAPABILITY_MISSING';
  return '';
}
function score(task, node) {
  let value = Math.min(32, node.availableCpuCores) * 2 +
    Math.min(24, Math.floor(node.availableMemoryMb / 4096)) +
    Math.min(16, Math.floor(node.availableVramMb / 2048));
  if (task.kind === 'cpu' && node.role === 'mac') value += 65;
  if (task.kind === 'gpu' && node.role === 'workstation') value += 65;
  if (task.kind === 'android' && node.role === 'android') value += 65;
  if (task.kind === 'gpu' && node.gpuBackend === 'cuda') value += 12;
  if (task.preferredNodeId && task.preferredNodeId === node.id) value += 18;
  if (task.sourceNodeId && task.sourceNodeId === node.id) value += 12;
  if (task.sourceRegion && task.sourceRegion === node.region) value += 6;
  value -= Math.ceil(node.latencyMs / 20);
  value -= Math.round(15 * node.activeJobs / Math.max(1, node.maxJobs));
  return value;
}
function plan(input, inventory, now = Date.now()) {
  const task = validateTask(input);
  if (!nonNegative(now)) throw Error('INVALID_NOW');
  const nodes = validateInventory(inventory);
  const eligible = [], excluded = [];
  for (const node of nodes) {
    const reason = rejectReason(task, node, now);
    if (reason) excluded.push({nodeId: node.id, reason});
    else eligible.push({nodeId: node.id, role: node.role, score: score(task, node)});
  }
  eligible.sort((a,b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  if (!eligible.length) {
    return {ok:false, status:'no-eligible-node', executionStarted:false,
      taskId:task.id, exclusions:excluded, inventoryVerified:false};
  }
  const selected = eligible[0];
  return {
    ok:true, status:'planned', executionStarted:false, taskId:task.id,
    nodeId:selected.nodeId, role:selected.role, reason:'capability-and-load-match',
    candidates:eligible, exclusions:excluded, inventoryVerified:false
  };
}
function listNodes(inventory, now = Date.now()) {
  return validateInventory(inventory).map(node => ({
    ...node, heartbeatFresh:fresh(node, now), verification:'configured-not-attested'
  }));
}
module.exports = {plan, listNodes, validateTask, validateInventory, HEARTBEAT_TTL_MS};
