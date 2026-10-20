# DSHA Mesh：AI 资源调度接口（第一阶段）

本模块作为 DSHA 内置可选插件，使用锁定的 dsh MCP Client 暴露**资源查询与路由规划**。远端身份认证、执行器、回执与取消/恢复尚未接入，本阶段**不会执行任何跨设备任务**，也不会把计划成功报告成执行成功。

## AI 可调用工具

- `mesh_list_nodes({})`：列出已配置节点的资源、状态与心跳新鲜度。配置文件不是远端真实性证明。
- `mesh_plan_task({kind,...requirements})`：返回目标节点、候选排序、排除原因；固定返回 `executionStarted:false`。
- 后续才实现 `mesh_submit_task`、`mesh_task_status`、`mesh_cancel_task`，这些并非当前已注册工具。

任务 `kind` 支持 `cpu`、`gpu`、`android`、`general`；可指定 `minCpuCores`、`minMemoryMb`、`minVramMb`、`requiresCuda`、`requiredCapabilities`、`maxLatencyMs`、`preferredNodeId`、`sourceNodeId`、`sourceRegion` 和 `dataPolicy`。`dataPolicy=local-only` 必须指定 `sourceNodeId`，绝不派到其他节点。

路由先排除未配对、离线、心跳超出 60 秒、CPU / 内存 / 显存不足、队列槽位已满或缺少必需能力的节点，再考虑本地性、角色、负载、延迟。`cpu` 倾向 Mac，`gpu` 倾向工作站，`android` 倾向 Android；偏好不覆盖硬约束。`requiresCuda=true` 不会退化为 Metal。无候选则返回 `no-eligible-node`。

## 节点资源文件

默认从 `/root/.dsh/mesh-nodes.json` 读取 JSON；可由管理员设置 `DSHA_MESH_NODES_FILE` 指向受控文件。不要写入 API Key、SSH 密钥和设备桥 token。以下是**离线占位示例**，并非实际检测结果：

```json
{
  "schema": 1,
  "nodes": [
    {"id":"mac","role":"mac","region":"home","paired":false,"online":false,
     "observedAt":0,"availableCpuCores":0,"availableMemoryMb":0,
     "gpuBackend":"metal","availableVramMb":0,"activeJobs":0,"maxJobs":1,
     "latencyMs":0,"capabilities":["cpu-inference"]},
    {"id":"desktop","role":"workstation","region":"home","paired":false,"online":false,
     "observedAt":0,"availableCpuCores":0,"availableMemoryMb":0,
     "gpuBackend":"cuda","availableVramMb":0,"activeJobs":0,"maxJobs":1,
     "latencyMs":0,"capabilities":["pytorch","cuda-inference"]}
  ]
}
```

调用例子：`mesh_plan_task({"kind":"gpu","requiresCuda":true,"minVramMb":8192,"requiredCapabilities":["pytorch"]})`。只有真实上报且已信任的节点满足资源条件时，才返回 `status=planned`；这仍**不是任务已执行**的证据。

## 区域组网与执行层（待接入）

局域网以 mDNS 发现候选节点，发现本身不构成信任；跨区域可使用 Tailscale/WireGuard 加密虚拟网络。配对身份、机器资源与心跳以后由节点代理认证上报。原本 3090 Android 设备桥仍保持 loopback，不直接对公网开放；现有 LAN HTTP 不具备所需传输安全。

实际派发走 ACP 双向 DSH 子代理；MCP 负责给 AI 暴露受控工具。未来必须加入节点证书、任务 ID 和幂等键、超时后的未知结果、并发配额、取消/恢复与事件流。不得用失败回执后的自动重试重复执行可能产生副作用的任务。

## 测试

```sh
node --test tests/mesh-scheduler.test.cjs
```

仅表示纯 JS 调度逻辑测试；不代表 Android APK 构建、MCP 真正加载、设备组网或跨机执行验收。
